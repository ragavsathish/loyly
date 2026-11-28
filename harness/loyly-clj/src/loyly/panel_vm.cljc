(ns loyly.panel-vm
  "PoC port of specialist worker resolution from harness/pi-durable/panel-vm-run.ts.
  VM launch / QEMU stay on the TS side."
  (:require [loyly.digest :as d]
            [loyly.evidence.validate-schema :as schema]
            [loyly.grading-room :as room]
            [loyly.hjson :as hjson]
            [loyly.platform :as plat]
            [loyly.project.loyly :as loyly]
            [loyly.runtime-profile-evidence :as profile]
            [loyly.score-receipt :as receipt]))

(def LEGACY_WORKERS
  [{:id "browser" :script "panel-browser.mjs" :tool "Playwright" :item "01-003"}
   {:id "protocol" :script "panel-protocol.mjs" :tool "Node.js" :item "01-010"}
   {:id "telemetry" :script "panel-telemetry.mjs" :tool "OpenTelemetry" :item "01-003"}])

(defn- label [result name]
  (some (fn [entry]
          (when (= name (get entry "name"))
            (get entry "value")))
        (get result "labels")))

(defn worker-bundle
  "Resolve specialist script root. `here` is the pi-durable directory."
  [plan here]
  (cond
    (= (get plan "schema") loyly/LEGACY_PANEL_PLAN)
    {:root (str here) :sha256 nil}

    (not (and (= (get plan "schema") "harness.grading-panel-plan.v2")
              (re-matches #"[a-z][a-z0-9/-]*" (str (get-in plan ["bundle" "path"])))
              (re-matches #"[0-9a-f]{64}" (str (get-in plan ["bundle" "sha256"])))))
    (throw (ex-info "panel needs a pinned project worker bundle" {}))

    :else
    (let [root (plat/path here (get-in plan ["bundle" "path"]))
          digest (d/tree-digest root "bundle")]
      (when-not (= digest (get-in plan ["bundle" "sha256"]))
        (throw (ex-info "project worker bundle differs from the panel plan" {})))
      {:root (str root) :sha256 (get-in plan ["bundle" "sha256"])})))

(defn specialist-workers
  "Resolve specialist checks to runnable worker descriptors."
  [plan here]
  (let [{:keys [root]} (worker-bundle plan here)
        checks (filterv #(= "specialist" (get % "source")) (or (get plan "checks") []))]
    (when (or (empty? checks)
              (not= (count checks) (count (set (map #(get % "id") checks)))))
      (throw (ex-info "panel needs unique specialist checks" {})))
    (mapv
     (fn [check]
       (let [legacy (when (= (get plan "schema") loyly/LEGACY_PANEL_PLAN)
                      (first (filter #(= (:id %) (get check "id")) LEGACY_WORKERS)))
             script (or (get check "script") (:script legacy))]
         (when (or (nil? script)
                   (not (re-matches #"[a-z][a-z0-9-]*\.mjs" script))
                   (not (plat/regular-file? (plat/path root script)))
                   (not= 1 (count (get check "items")))
                   (and (nil? (get check "script"))
                        (or (nil? legacy)
                            (not= (:tool legacy) (get check "tool"))
                            (not= (:item legacy) (first (get check "items"))))))
           (throw (ex-info (str (get check "id")
                                ": specialist script or item differs from the panel plan")
                           {:id (get check "id")})))
         {:id (get check "id")
          :script script
          :tool (get check "tool")
          :item (first (get check "items"))
          :technique (get check "technique")
          :feature (or (get check "feature") (get plan "feature"))
          :probe (get check "probe")}))
     checks)))

(defn- run-binding
  "Port of runBinding(original): score-input or cut HEAD + candidate digest."
  [original]
  (let [input (plat/path original "score-input.json")]
    (if (plat/regular-file? input)
      (hjson/read-json (plat/read-text input))
      (let [cut (plat/path original "cut" "project")
            head (d/git cut "rev-parse" "HEAD")]
        (when-not (re-matches #"[0-9a-f]{40}" head)
          (throw (ex-info "panel needs a pinned source cut" {})))
        (array-map "source_commit" head
                   "candidate_sha256"
                   (room/candidate-digest (plat/path original "fenced-room")))))))

(defn- score-digest
  "SHA-256 of the bound cycle scores.json, or nil."
  [original]
  (let [input (plat/path original "score-input.json")]
    (when (plat/regular-file? input)
      (let [cycle (receipt/score-cycle-for original)
            score (plat/path original "instrument" "harness" "cycles" cycle "scores.json")]
        (when (plat/regular-file? score)
          (d/file-sha256 score))))))

(defn panel-score-context
  "Binding + optional score digest for a panel original room (pre-VM)."
  [original]
  {:binding (run-binding original)
   :score-sha256 (score-digest original)})

(defn- assert-panel-vm-manifest
  [{:keys [manifest score-input candidate-sha256 score-sha256 plan-sha256 bundle workers
           schema-file image-digest]}]
  (when (or (not= (get manifest "schema") loyly/PANEL_VM_RUN)
            (not= (get manifest "source_commit") (get score-input "source_commit"))
            (not= (get manifest "candidate_sha256") candidate-sha256)
            (and (= (or (get manifest "score_state") "filed") "filed")
                 (not= (get manifest "original_score_sha256") score-sha256))
            (and (= (get manifest "score_state") "pre-score")
                 (some? (get manifest "original_score_sha256")))
            (not= (get manifest "plan_sha256") plan-sha256)
            (and (:sha256 bundle) (not= (get manifest "worker_bundle_sha256") (:sha256 bundle)))
            (not= (get manifest "allure_schema_sha256") (d/file-sha256 schema-file))
            (not= (get manifest "original_score_unchanged") true)
            (and image-digest (not= (get manifest "image_digest") image-digest))
            (not= (count (get manifest "producers")) (count workers)))
    (throw (ex-info "panel VM manifest differs from the scored cut, plan, schema or image" {}))))

(defn- assert-panel-producer-row [worker producer manifest]
  (when (or (nil? producer)
            (not= (get producer "tool") (:tool worker))
            (not= (get producer "item") (str "@item-" (:item worker)))
            (not= (get producer "image_digest") (get manifest "image_digest"))
            (not (integer? (get producer "started")))
            (not (integer? (get producer "stopped")))
            (> (get producer "started") (get producer "stopped")))
    (throw (ex-info (str (:id worker) ": panel producer receipt differs")
                    {:id (:id worker)}))))

(defn- assert-panel-producer-allure
  [{:keys [worker producer result dir candidate-sha256 validate]}]
  (let [receipt-file (some (fn [a]
                             (when (= "Gondolin VM execution receipt" (get a "name"))
                               (get a "source")))
                           (get result "attachments"))
        files (into [(get producer "result")]
                (map #(get % "source") (get result "attachments")))]
    (validate result (get producer "result"))
    (when (or (not= (str (get result "uuid") "-result.json") (get producer "result"))
              (not= (get result "status") (get producer "status"))
              (not= (get result "stage") "finished")
              (not= (label result "tool") (:tool worker))
              (not= (label result "tag") (get producer "item"))
              (not= (label result "feature") (:feature worker))
              (not= (label result "technique") (:technique worker))
              (not= candidate-sha256
                    (some #(when (= "candidate_sha256" (get % "name")) (get % "value"))
                          (get result "parameters")))
              (nil? receipt-file)
              (not= (count (set files)) (count files))
              (not= (count files) (count (get producer "files")))
              (some (fn [name]
                      (or (not (re-matches #"[A-Za-z0-9._-]+" name))
                          (not (plat/regular-file? (plat/path dir name)))
                          (not= (get-in producer ["files" name])
                                (d/file-sha256 (plat/path dir name)))))
                    files)
              (not= (get producer "execution_receipt_sha256")
                    (d/file-sha256 (plat/path dir receipt-file))))
      (throw (ex-info (str (:id worker) ": Allure result or attachment changed")
                      {:id (:id worker)})))
    receipt-file))

(defn- assert-gondolin-receipt
  [{:keys [worker manifest receipt result candidate-sha256 bundle here]}]
  (when (or (not= (get receipt "worker") (:id worker))
            (not= (get receipt "candidate_sha256") candidate-sha256)
            (not= (get receipt "imageDigest") (get manifest "image_digest"))
            (not= (get receipt "worker_script_sha256")
                  (d/file-sha256 (plat/path (:root bundle) (:script worker))))
            (and (:sha256 bundle)
                 (not= (get receipt "worker_bundle_sha256") (:sha256 bundle)))
            (and (not (:sha256 bundle))
                 (= (:script worker) "panel-runtime.mjs")
                 (let [validator-path (let [cljc (plat/path here ".." "loyly-clj" "src" "loyly" "runtime_profile_evidence.cljc")]
                                        (if (plat/regular-file? cljc)
                                          cljc
                                          (plat/path here "runtime-profile-evidence.mjs")))]
                   (or (not= (get receipt "profile_validator_sha256")
                             (d/file-sha256 validator-path))
                       (not= (get receipt "profile_otel_schema_sha256")
                             (d/file-sha256 (plat/path here "panel-otel-metrics.schema.json"))))))
            (and (get manifest "worker_support_sha256")
                 (not= (get receipt "worker_support_sha256")
                       (get manifest "worker_support_sha256")))
            (not= (get receipt "isolation") "gondolin-qemu-vm")
            (not= (get-in receipt ["mounts" "candidate"]) "read-only")
            (not= (get-in receipt ["mounts" "worker"]) "read-only")
            (not= (= (get receipt "vm_exit_code") 0) (= (get result "status") "passed")))
    (throw (ex-info (str (:id worker) ": Gondolin execution receipt changed")
                    {:id (:id worker)}))))

(defn- verify-panel-vm-producer
  [{:keys [worker manifest out candidate-sha256 bundle validate here]}]
  (let [producer (first (filter #(= (:id worker) (get % "id")) (get manifest "producers")))
        dir (plat/path out (:id worker))]
    (assert-panel-producer-row worker producer manifest)
    (let [results (filterv #(re-matches (plat/re-flags "i" "^[0-9a-f-]{36}-result\\.json$") %)
                           (map plat/file-name (plat/list-dir dir)))]
      (when (or (not= 1 (count results)) (not= (first results) (get producer "result")))
        (throw (ex-info (str (:id worker) ": expected one result") {:id (:id worker)})))
      (let [result (hjson/read-json (plat/read-text (plat/path dir (first results))))]
        (when (= (:script worker) "panel-runtime.mjs")
          (profile/verify-runtime-profile-evidence
           {:dir (str dir) :result result :candidate-sha256 candidate-sha256 :probe (:probe worker)}))
        (let [receipt-file (assert-panel-producer-allure
                            {:worker worker :producer producer :result result
                             :dir (str dir) :candidate-sha256 candidate-sha256 :validate validate})
              receipt (hjson/read-json (plat/read-text (plat/path dir receipt-file)))]
          (assert-gondolin-receipt
           {:worker worker :manifest manifest :receipt receipt :result result
            :candidate-sha256 candidate-sha256 :bundle bundle :here here}))))))

(defn verify-panel-vm-run
  "Reconcile a completed panel VM attempt directory."
  [{:keys [original out image-digest plan-file pi-durable]
    :or {plan-file loyly/DEFAULT_PANEL_PLAN
         pi-durable "harness/pi-durable"}}]
  (let [original (str (plat/absolutize original))
        out (str (plat/absolutize out))
        here (if (plat/absolute? pi-durable)
               pi-durable
               (plat/path original pi-durable))
        manifest (hjson/read-json (plat/read-text (plat/path out "manifest.json")))
        score-input (run-binding original)
        candidate-sha256 (room/candidate-digest (plat/path original "fenced-room"))
        score-sha256 (score-digest original)
        plan-path (if (plat/absolute? (plat/path plan-file))
                    (plat/path plan-file)
                    (plat/path here plan-file))
        plan-sha256 (d/file-sha256 plan-path)
        plan (hjson/read-json (plat/read-text plan-path))
        bundle (worker-bundle plan (str here))
        workers (specialist-workers plan (str here))
        schema-file (plat/path here "allure-lifecycle-result.schema.json")
        validate (schema/compile-allure-schema nil)]
    (assert-panel-vm-manifest
     {:manifest manifest :score-input score-input :candidate-sha256 candidate-sha256
      :score-sha256 score-sha256 :plan-sha256 plan-sha256 :bundle bundle :workers workers
      :schema-file (str schema-file) :image-digest image-digest})
    (doseq [worker workers]
      (verify-panel-vm-producer
       {:worker worker :manifest manifest :out out :candidate-sha256 candidate-sha256
        :bundle bundle :validate validate :here (str here)}))
    (let [overlap (- (apply min (map #(get % "stopped") (get manifest "producers")))
                     (apply max (map #(get % "started") (get manifest "producers"))))]
      (when (or (<= overlap 0) (not= overlap (get manifest "parallel_overlap_ms")))
        (throw (ex-info "panel VM overlap receipt changed" {})))
      {:out out :manifest manifest})))

(defn run-panel-vms
  "Launch parallel panel VMs via injectable `:gondolin-fn` (default: not implemented)."
  [{:keys [original image out plan-file pi-durable gondolin-fn]
    :or {plan-file loyly/DEFAULT_PANEL_PLAN
         pi-durable "harness/pi-durable"}}]
  (let [original (str (plat/absolutize original))
        image (str (plat/absolutize image))
        out (str (plat/absolutize out))]
    (when (plat/exists? out)
      (throw (ex-info "panel VM output already exists" {:out out})))
    (if-not gondolin-fn
      (throw (ex-info "panel VM launch needs :gondolin-fn in loyly-clj" {}))
      (let [result (gondolin-fn {:original original :image image :out out
                                 :plan-file plan-file :pi-durable pi-durable})]
        (verify-panel-vm-run (assoc result :original original :out out
                                      :plan-file plan-file :pi-durable pi-durable))))))
