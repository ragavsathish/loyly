(ns loyly.panel-compile
  "PoC port of pure helpers from harness/pi-durable/panel-compile.ts.
  Full Allure report compilation stays on the TS side."
  (:require [clojure.string :as str]
            [loyly.allure-results :as allure]
            [loyly.digest :as d]
            [loyly.evidence.validate-schema :as schema]
            [loyly.grading-room :as room]
            [loyly.hjson :as hjson]
            [loyly.panel-policy :as panel-pol]
            [loyly.platform :as plat]
            [loyly.project.loyly :as loyly]
            [loyly.score-receipt :as receipt]))

(defn label
  "Allure label value by name."
  [result name]
  (some (fn [entry]
          (when (= name (get entry "name"))
            (get entry "value")))
        (get result "labels")))

(defn- assert-specialist-manifest-bound
  [{:keys [plan plan-sha256 manifest candidate-sha256 schema-sha256
           score-sha256 source-commit specs]}]
  (when (or (not (#{"loyly.supplemental-grade.v1" loyly/PANEL_VM_RUN}
                  (get manifest "schema")))
            (not= (get manifest "source_commit") source-commit)
            (not= (get manifest "candidate_sha256") candidate-sha256)
            (and (= (get plan "schema") "harness.grading-panel-plan.v2")
                 (not= (get manifest "worker_bundle_sha256")
                       (get-in plan ["bundle" "sha256"])))
            (not= (get manifest "allure_schema_sha256") schema-sha256)
            (and (= (get manifest "schema") "loyly.supplemental-grade.v1")
                 (not= (get manifest "original_score_sha256") score-sha256))
            (and (= (get manifest "schema") loyly/PANEL_VM_RUN)
                 (not (or (and (= (get manifest "score_state") "pre-score")
                               (nil? (get manifest "original_score_sha256")))
                          (and (= (or (get manifest "score_state") "filed") "filed")
                               (= (get manifest "original_score_sha256") score-sha256)))))
            (and (= (get manifest "schema") "loyly.supplemental-grade.v1")
                 (not= (get manifest "original_score_unchanged") true))
            (and (= (get manifest "schema") loyly/PANEL_VM_RUN)
                 (not= (get manifest "plan_sha256") plan-sha256))
            (not= (count (get manifest "producers")) (count specs)))
    (throw (ex-info "specialist manifest is not bound to this scored candidate and plan" {}))))

(defn specialist-runtime
  "Infer runtime label from execution receipt + manifest schema."
  [spec receipt manifest]
  (cond
    (and (= (get manifest "schema") loyly/PANEL_VM_RUN)
         (integer? (get receipt "vm_exit_code"))
         (= (get receipt "isolation") "gondolin-qemu-vm")
         (= (get-in receipt ["mounts" "candidate"]) "read-only")
         (= (get-in receipt ["mounts" "worker"]) "read-only"))
    "gondolin-qemu-vm"

    (and (= (get spec "id" (:id spec)) "protocol")
         (= (get receipt "vm_exit_code") 0))
    "gondolin-qemu-vm"

    (and (= (get spec "id" (:id spec)) "browser")
         (= (get receipt "exitCode") 0)
         (= (get-in receipt ["candidateMount" "RW"]) false)
         (= (get receipt "readOnlyRootFilesystem") true)
         (= (get receipt "networkMode") "none"))
    "docker-shared-linux-vm"

    (and (= (get spec "id" (:id spec)) "telemetry")
         (get receipt "containerId")
         (re-find #"Docker Desktop Linux VM" (str (get receipt "isolation"))))
    "docker-shared-linux-vm"

    :else nil))

(defn- assert-specialist-overlap
  [manifest observations]
  (let [intervals (if (= (get manifest "schema") loyly/PANEL_VM_RUN)
                    (mapv (fn [row]
                            {:start (get row "started") :stop (get row "stopped")})
                          (get manifest "producers"))
                    (mapv (fn [obs]
                            {:start (get obs "start" (:start obs))
                             :stop (get obs "stop" (:stop obs))})
                          observations))
        overlap (- (apply min (map :stop intervals))
                   (apply max (map :start intervals)))]
    (when (or (<= overlap 0)
              (not= overlap (get manifest "parallel_overlap_ms")))
      (throw (ex-info "the recorded specialist execution overlap is false" {})))))

(defn verify-specialist-bindings
  "Assert manifest binding + recorded overlap (TS specialistResults checks)."
  [opts observations]
  (assert-specialist-manifest-bound opts)
  (assert-specialist-overlap (:manifest opts) observations)
  true)

(defn build-panel-summary-shape
  "Minimal panel-summary object fields the TS compiler emits (sans Allure I/O)."
  [{:keys [candidate-sha256 plan-sha256 original-score-sha256 evaluation]}]
  (array-map
   "schema" loyly/PANEL_SUMMARY
   "candidate_sha256" candidate-sha256
   "plan_sha256" plan-sha256
   "original_score_sha256" original-score-sha256
   "panel_outcome" (get evaluation :panel-outcome (:panel-outcome evaluation))
   "gaps" (get evaluation :gaps (:gaps evaluation))
   "checks" (mapv #(get % "id") (get evaluation :checks (:checks evaluation)))
   "items" (get evaluation :items (:items evaluation))))

(defn- collect-specialist-observation
  [{:keys [specialists plan manifest candidate-sha256 validate spec]}]
  (let [producer (first (filter #(= (get spec "id") (get % "id")) (get manifest "producers")))]
    (when (or (nil? producer)
              (not= (get producer "tool") (get spec "tool"))
              (not= (count (get spec "items")) 1)
              (not= (get producer "item") (str "@item-" (first (get spec "items")))))
      (throw (ex-info (str (get spec "id") ": missing or incorrect specialist producer")
                      {:id (get spec "id")})))
    (let [dir (plat/path specialists (get spec "id"))
          result-files (filterv #(re-matches (plat/re-flags "i" "^[0-9a-f-]{36}-result\\.json$") %)
                               (map plat/file-name (plat/list-dir dir)))]
      (when (or (not= 1 (count result-files))
                (not= (first result-files) (get producer "result")))
        (throw (ex-info (str (get spec "id") ": expected exactly one result")
                        {:id (get spec "id")})))
      (let [result (hjson/read-json (plat/read-text (plat/path dir (first result-files))))]
        (validate result (str (get spec "id") " Allure result"))
        (when (or (not= (get producer "result") (str (get result "uuid") "-result.json"))
                  (not= (get result "status") (get producer "status"))
                  (not= (get result "stage") "finished")
                  (not= (label result "tag") (get producer "item"))
                  (not= (label result "tool") (get spec "tool"))
                  (not= (label result "technique") (get spec "technique"))
                  (not= (label result "feature") (or (get spec "feature") (get plan "feature")))
                  (not= candidate-sha256
                        (some #(when (= "candidate_sha256" (get % "name")) (get % "value"))
                              (get result "parameters")))
                  (empty? (get-in result ["statusDetails" "message"]))
                  (empty? (get result "steps")))
          (throw (ex-info (str (get spec "id") ": specialist identity or observation differs")
                          {:id (get spec "id")})))
        (let [receipt-file (some (fn [a]
                                   (when (and (re-find #"execution receipt" (str (get a "name")))
                                              (= "application/json" (get a "type")))
                                     (get a "source")))
                              (get result "attachments"))
              files (into [(get producer "result")]
                      (map #(get % "source") (get result "attachments")))]
          (when (or (nil? receipt-file)
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
            (throw (ex-info (str (get spec "id") ": result or attachment bytes differ")
                            {:id (get spec "id")})))
          (let [receipt (hjson/read-json (plat/read-text (plat/path dir receipt-file)))
                image-digest (or (get receipt "imageDigest") (get receipt "image_oci_digest"))]
            (when (or (not= (or (get receipt "candidate_sha256")
                                (get receipt "candidateSha")
                                (get-in receipt ["result" "candidateSha256"]))
                        candidate-sha256)
                      (not= image-digest (get producer "image_digest"))
                      (not (re-matches #"^sha256:[0-9a-f]{64}$" (str image-digest)))
                      (not= (get producer "execution_receipt_sha256")
                            (d/file-sha256 (plat/path dir receipt-file))))
              (throw (ex-info (str (get spec "id") ": execution receipt is not candidate bound")
                              {:id (get spec "id")})))
            (let [runtime (specialist-runtime spec receipt manifest)]
              (when-not runtime
                (throw (ex-info (str (get spec "id") ": runtime receipt is incomplete")
                                {:id (get spec "id")})))
              {:dir (str dir)
               :observation {:id (get spec "id")
                             :item (first (get spec "items"))
                             :tool (get spec "tool")
                             :technique (get spec "technique")
                             :status (get result "status")
                             :runtime runtime
                             :result_sha256 (d/file-sha256 (plat/path dir (get producer "result")))
                             :message (get-in result ["statusDetails" "message"])
                             :start (get result "start")
                             :stop (get result "stop")}})))))))

(defn specialist-results
  "Collect specialist Allure observations bound to a VM manifest."
  [{:keys [specialists plan plan-sha256 manifest candidate-sha256 schema-sha256
           score-sha256 source-commit validate]}]
  (let [specs (filterv #(= "specialist" (get % "source")) (get plan "checks"))
        overlap-rows (mapv (fn [row]
                            {:start (get row "started") :stop (get row "stopped")})
                          (get manifest "producers"))]
    (verify-specialist-bindings
     {:plan plan :plan-sha256 plan-sha256 :manifest manifest
      :candidate-sha256 candidate-sha256 :schema-sha256 schema-sha256
      :score-sha256 score-sha256 :source-commit source-commit :specs specs}
     overlap-rows)
    (let [collected (mapv #(collect-specialist-observation
                           {:specialists specialists :plan plan :manifest manifest
                            :candidate-sha256 candidate-sha256 :validate validate :spec %})
                         specs)]
      {:directories (mapv :dir collected)
       :observations (mapv :observation collected)})))

(defn compile-panel
  "Compile panel report via injectable `:allure-cli-fn` and `:audit-rows-fn`."
  [{:keys [original specialists out plan-file pi-durable allure-cli-fn audit-rows-fn]
    :or {pi-durable "harness/pi-durable"}}]
  (when (plat/exists? out)
    (throw (ex-info "panel output already exists" {:out out})))
  (when-not allure-cli-fn
    (throw (ex-info "compile-panel needs :allure-cli-fn in loyly-clj" {})))
  (let [original (str (plat/absolutize original))
        specialists (str (plat/absolutize specialists))
        out (str (plat/absolutize out))
        plan-path (if (plat/absolute? (plat/path plan-file))
                    (plat/path plan-file)
                    (plat/path original pi-durable plan-file))
        plan (hjson/read-json (plat/read-text plan-path))
        score-input (hjson/read-json (plat/read-text (plat/path original "score-input.json")))
        legacy (= (get plan "schema") loyly/LEGACY_PANEL_PLAN)
        verdicts-file (plat/path original (if legacy "final-verdicts.json" "verdicts.json"))
        candidate-sha256 (room/candidate-digest (plat/path original "fenced-room"))
        _ (when-not (= candidate-sha256 (get score-input "candidate_sha256"))
            (throw (ex-info "candidate changed after scoring" {})))
        scored (receipt/verify-scored-cycle
                {:scratch original
                 :instrument (str (plat/path original "instrument"))
                 :verdicts-file (str verdicts-file)
                 :cycle (receipt/score-cycle-for original)})
        room (str (plat/path original "grading-room"))
        _ (allure/read-allure-results room)
        rows (if audit-rows-fn (audit-rows-fn original) [])
        schema-file (plat/path original pi-durable "../evidence-core/allure-lifecycle-result.schema.json")
        schema-sha256 (d/file-sha256 schema-file)
        validate ((schema/compile-allure-schema nil))
        specialist-manifest-file (if (plat/regular-file? (plat/path specialists "manifest.json"))
                                   (plat/path specialists "manifest.json")
                                   (plat/path specialists "combined" "manifest.json"))
        specialist-manifest (hjson/read-json (plat/read-text specialist-manifest-file))
        extra (specialist-results {:specialists specialists :plan plan
                                   :plan-sha256 (d/file-sha256 plan-path)
                                   :manifest specialist-manifest
                                   :candidate-sha256 candidate-sha256
                                   :schema-sha256 schema-sha256
                                   :score-sha256 (:score-sha256 scored)
                                   :source-commit (get score-input "source_commit")
                                   :validate validate})
        observations (:observations extra)
        assessed (panel-pol/evaluate-panel plan (:items scored) observations)
        summary (build-panel-summary-shape
                 {:candidate-sha256 candidate-sha256
                  :plan-sha256 (d/file-sha256 plan-path)
                  :original-score-sha256 (:score-sha256 scored)
                  :evaluation assessed})
        directories (into [(str (plat/path room "work" "allure-results"))]
                          (:directories extra))
        stats (allure-cli-fn {:out out :directories directories :observations observations})
        manifest (array-map "schema" loyly/PANEL_REPORT
                            "panel_summary_sha256" "pending"
                            "report_html_sha256" (d/file-sha256 (plat/path out "allure-report" "index.html"))
                            "audit_entries_sha256"
                            (if (seq rows)
                              (d/sha256-string (str/join "\n" (map hjson/compact-json rows)))
                              (apply str (repeat 64 "0")))
                            "specialist_manifest_sha256" (d/file-sha256 specialist-manifest-file)
                            "result_count" (count observations)
                            "original_score_unchanged" true)]
    (plat/create-dirs out)
    (hjson/spit-utf8 (plat/path out "panel-summary.json")
                     (str (hjson/compact-json summary) "\n"))
    (let [manifest (assoc manifest "panel_summary_sha256"
                           (d/file-sha256 (plat/path out "panel-summary.json")))]
      (hjson/spit-utf8 (plat/path out "panel-manifest.json")
                       (str (hjson/compact-json manifest) "\n"))
      {:out out :summary summary :manifest manifest :stats stats})))

(defn verify-compiled-panel
  [{:keys [original out plan-file]}]
  (let [original (str (plat/absolutize original))
        out (str (plat/absolutize out))
        summary (hjson/read-json (plat/read-text (plat/path out "panel-summary.json")))
        manifest (hjson/read-json (plat/read-text (plat/path out "panel-manifest.json")))
        plan (hjson/read-json (plat/read-text (plat/path plan-file)))
        legacy (= (get plan "schema") loyly/LEGACY_PANEL_PLAN)
        score (receipt/verify-scored-cycle
               {:scratch original
                :instrument (str (plat/path original "instrument"))
                :verdicts-file (str (plat/path original (if legacy "final-verdicts.json" "verdicts.json")))
                :cycle (receipt/score-cycle-for original)})]
    ((schema/compile-schema :panel-summary nil) summary "panel summary")
    (when (or (not= (get manifest "schema") loyly/PANEL_REPORT)
              (not= (get manifest "panel_summary_sha256")
                    (d/file-sha256 (plat/path out "panel-summary.json")))
              (not= (get manifest "report_html_sha256")
                    (d/file-sha256 (plat/path out "allure-report" "index.html")))
              (not= (get manifest "result_count") (count (get summary "checks")))
              (not= (get manifest "original_score_unchanged") true)
              (not= (get summary "original_score_sha256") (:score-sha256 score))
              (not= (get summary "candidate_sha256")
                    (room/candidate-digest (plat/path original "fenced-room")))
              (not= (get summary "plan_sha256") (d/file-sha256 (plat/path plan-file))))
      (throw (ex-info "compiled panel report changed after filing" {})))
    {:out out :summary summary :manifest manifest
     :stats (hjson/read-json (plat/read-text (plat/path out "allure-report" "summary.json")))}))
