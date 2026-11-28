(ns loyly.adapters
  "Cross-platform Codex/Cursor cycle adapter actions (.cljc).

  Implements decide, candidate, evidence, panel, preflight (Codex & Cursor
  pinned cycle contracts), and reassess (Codex grader-only reassessment)
  directly via shared .cljc modules on both Babashka and Node nbb."
  (:require [loyly.candidate-caches :as caches]
            [loyly.contracts :as contracts]
            [loyly.cycle-core :as life]
            [loyly.digest :as d]
            [loyly.evidence.assess-room-panel :as panel]
            [loyly.evidence.check-room :as room]
            [loyly.evidence.panel-selection :as panel-sel]
            [loyly.gen-checklist :as checklist]
            [loyly.hjson :as hjson]
            [loyly.platform :as plat]
            [loyly.project.loyly :as loyly]))

(def CURSOR-SEALS
  {"graderTool" "Cursor black-box grader"
   "blindTool" "fresh blind subagent"
   "handoffItem" loyly/BLIND_ITEM_ID
   "project" loyly/PROJECT_ID})

(def CODEX-SEALS
  {"graderTool" "Codex black-box grader"
   "blindTool" "fresh blind subagent"
   "handoffItem" loyly/BLIND_ITEM_ID
   "project" loyly/PROJECT_ID})

(def ^:private hex64 #"^[0-9a-f]{64}$")
(def ^:private hex40 #"^[0-9a-f]{40}$")
(def ^:private safe-id #"^[A-Za-z0-9._-]+$")
(def ^:private spec-source-re #"^((?:docs/plan/)[0-9]{2}-[a-z][a-z0-9-]*/spec\.feature):[0-9]+$")
(def ^:private reassessment-spec-re #"^docs/plan/(\d\d-[a-z][a-z0-9-]*)/spec\.feature:\d+$")

(defn- seals-for [driver]
  (case driver
    :cursor CURSOR-SEALS
    :codex CODEX-SEALS
    (throw (ex-info (str "unknown adapter driver: " driver) {:driver driver}))))

(defn- read-json [path]
  (hjson/read-json (plat/read-text path)))

(defn- require-pin!
  ([pin] (require-pin! pin "approved file differs: " false))
  ([pin prefix strict-abs?]
   (let [p (get pin "path")
         s (get pin "sha256")]
     (when (or (not (map? pin))
               (not (string? p))
               (not (string? s))
               (and strict-abs? (or (not (plat/absolute? p))
                                    (not= (plat/absolutize p) p)))
               (not (re-matches hex64 s))
               (not (plat/exists? p))
               (not= :file (plat/lstat-kind p))
               (not= (d/file-sha256 p) s))
       (throw (ex-info (str prefix (or p "missing")) {:path p}))))))

(defn- assert-clean-commit! [repo commit msg]
  (when (or (not (string? commit))
            (not (re-matches hex40 commit))
            (not= (d/git repo "rev-parse" "HEAD") commit)
            (seq (d/git repo "status" "--porcelain")))
    (throw (ex-info msg {:repo repo :commit commit}))))

(defn- derive-source-checklist! [source-repo prefix]
  (let [tmp (plat/path (plat/temp-dir) (str prefix "-" (plat/now-ms) "-" (plat/random-uuid-str)))
        out (plat/path tmp "checklist.json")]
    (plat/create-dirs tmp)
    (try
      (checklist/generate {:root source-repo :out out})
      (when-not (plat/regular-file? out)
        (throw (ex-info "pinned checklist differs from the source-derived checklist" {})))
      {:bytes (plat/read-bytes out)
       :parsed (read-json out)}
      (finally
        (plat/delete-tree tmp)))))

(defn- selected-spec-paths [source-repo items]
  (let [paths (mapv (fn [item]
                      (let [m (re-matches spec-source-re (str (or (get item "source") "")))]
                        (when-not m
                          (throw (ex-info (str "item " (get item "id") " has no source spec")
                                          {:id (get item "id")})))
                        (plat/absolutize (plat/path source-repo (second m)))))
                    items)]
    (sort (distinct paths))))

(defn- assert-specs-match! [source-repo items specs]
  (let [expected (selected-spec-paths source-repo items)
        provided (mapv #(plat/absolutize (str (get % "path"))) specs)]
    (when (or (not= (count (set provided)) (count provided))
              (not= expected (sort provided)))
      (throw (ex-info "approved specs differ from checklist sources" {})))
    (doseq [spec specs]
      (require-pin! spec))))

(defn- assert-agents-and-panel! [contract checklist ids grader-tool blind-tool driver-label]
  (let [agents (get contract "agents")
        builder-model (get-in agents ["builder" "model"])
        grader-model (get-in agents ["grader" "model"])]
    (when (= builder-model grader-model)
      (throw (ex-info "builder and grader need different models" {})))
    (when (and (some #{loyly/BLIND_ITEM_ID} ids) (nil? (get agents "blind")))
      (throw (ex-info "booking refusal needs a fresh blind subagent" {})))
    (doseq [[_ agent] agents]
      (require-pin! (get agent "instruction"))
      (require-pin! (get agent "wrapper")))
    (let [panel-path (get-in contract ["execution" "panelPlan" "path"])
          panel-doc (read-json panel-path)]
      (panel-sel/validate-panel-coverage
       panel-doc checklist
       :handoff-item (when (some #{loyly/BLIND_ITEM_ID} ids) loyly/BLIND_ITEM_ID))
      (when (or (some #(and (= "raw-grader" (get % "source"))
                            (not= grader-tool (get % "tool")))
                      (get panel-doc "checks"))
                (some #(and (= "blind-review" (get % "source"))
                            (not= blind-tool (get % "tool")))
                      (get panel-doc "checks")))
        (throw (ex-info (str "panel tool labels differ from " driver-label) {})))
      panel-doc)))

(defn check-codex-contract
  "Preflight check for a pinned Codex subagent cycle contract."
  [contract controller-root]
  (when-not (= "loyly.codex-subagent-cycle.v1" (get contract "schema"))
    (throw (ex-info "invalid cycle contract" {})))
  (let [run-id (str (or (get contract "runId") ""))
        score-cycle (str (or (get contract "scoreCycle") ""))
        scratch (str (or (get contract "scratch") ""))]
    (when (or (not (re-matches safe-id run-id))
              (not (re-matches #"^[0-9]{2}$" score-cycle))
              (not (plat/absolute? scratch))
              (not= (plat/absolutize scratch) scratch))
      (throw (ex-info "run ID, score cycle and absolute scratch path must be pinned" {}))))
  (assert-clean-commit! controller-root (get contract "controllerCommit")
                        "controller checkout is dirty or differs from approved commit")
  (let [source (get contract "source")
        source-repo (get source "repo")
        cl-pin (get source "checklist")]
    (assert-clean-commit! source-repo (get source "commit")
                          "source checkout is dirty or differs from approved commit")
    (require-pin! cl-pin)
    (let [{:keys [bytes]} (derive-source-checklist! source-repo "loyly-codex-checklist")]
      (when-not (plat/bytes-equal? bytes (plat/read-bytes (get cl-pin "path")))
        (throw (ex-info "pinned checklist differs from the source-derived checklist" {}))))
    (let [cl (read-json (get cl-pin "path"))]
      (when-not (contracts/selected-checklist? cl)
        (throw (ex-info "invalid selected checklist" {})))
      (let [items (get cl "items")
            ids (mapv #(get % "id") items)]
        (when (or (empty? ids)
                  (not= (count (set ids)) (count ids))
                  (not= ids (vec (get source "itemIds"))))
          (throw (ex-info "approved item list differs from checklist" {})))
        (assert-specs-match! source-repo items (get source "specs"))
        (let [ex (get contract "execution")]
          (when (or (not (map? ex))
                    (not= "codex-subagent" (get ex "builderEngine"))
                    (not= "host" (get ex "builderRuntime"))
                    (not= "codex-subagent" (get ex "graderEngine"))
                    (not= "gondolin-qemu-vm" (get ex "graderRuntime"))
                    (not= "codex-subagent" (get ex "blindEngine"))
                    (not= "gondolin-qemu-vm" (get ex "blindProbeRuntime")))
            (throw (ex-info "Codex agent and private Gondolin VM boundary is not pinned" {})))
          (doseq [k ["graderImageManifest" "allureSchema" "panelPlan"]]
            (require-pin! (get ex k))))
        (assert-agents-and-panel!
         contract cl ids
         (get CODEX-SEALS "graderTool")
         (get CODEX-SEALS "blindTool")
         "Codex subagents")
        (array-map
         "controllerCommit" (get contract "controllerCommit")
         "runId" (get contract "runId")
         "scoreCycle" (get contract "scoreCycle")
         "sourceCommit" (get source "commit")
         "itemIds" ids
         "checklistSha256" (get cl-pin "sha256")
         "specSha256" (mapv #(array-map "path" (get % "path") "sha256" (get % "sha256"))
                            (get source "specs")))))))

(defn- assert-cursor-probe-boundary! [execution default-dockerfile]
  (let [grader-rt (get execution "graderRuntime")
        blind-rt (get execution "blindProbeRuntime")
        builder-rt (get execution "builderRuntime")
        docker? (or (= "docker" grader-rt) (= "docker" blind-rt))
        remote? (or (= "cursor-remote-session" grader-rt)
                    (= "cursor-remote-session" blind-rt))]
    (when (and docker? remote?)
      (throw (ex-info "grader and blind probe must share one isolation mode: cursor-remote-session or docker" {})))
    (cond
      (and (= "cursor-remote-session" grader-rt) (= "cursor-remote-session" blind-rt))
      (do
        (when-not (#{"cursor-remote-session" "host"} builder-rt)
          (throw (ex-info "invalid builder runtime for Cursor remote grading" {})))
        (when (or (get execution "dockerImage") (get execution "dockerfile"))
          (throw (ex-info "Cursor remote-session grading does not pin a Docker image" {})))
        nil)

      (not (and (= "docker" grader-rt) (= "docker" blind-rt)))
      (throw (ex-info "host Cursor grading isolates candidate probes in Docker from Dockerfile.panel-multistack" {}))

      (not (#{"host" "cursor-remote-session"} builder-rt))
      (throw (ex-info "invalid builder runtime for host Docker grading" {}))

      :else
      (let [df (or (get execution "dockerfile")
                   {"path" default-dockerfile
                    "sha256" (d/file-sha256 default-dockerfile)})]
        (require-pin! df)
        (when-not (= (plat/absolutize (get df "path")) default-dockerfile)
          (throw (ex-info "host Docker grading must pin harness/pi-durable/Dockerfile.panel-multistack" {})))
        (when-not (get execution "dockerImage")
          (throw (ex-info "docker image digest is not pinned" {})))
        (require-pin! (get execution "dockerImage"))
        df))))

(defn- assert-subsequence-items! [full-items item-ids]
  (let [full-ids (mapv #(get % "id") full-items)]
    (when (or (empty? item-ids) (not= (count (set item-ids)) (count item-ids)))
      (throw (ex-info "approved item list differs from checklist" {})))
    (loop [remaining item-ids cursor 0]
      (when-let [id (first remaining)]
        (let [idx (first (keep-indexed (fn [i x] (when (and (>= i cursor) (= x id)) i)) full-ids))]
          (when-not idx
            (throw (ex-info (str "selected item " id " is absent from the derived checklist") {:id id})))
          (recur (rest remaining) (inc idx)))))
    (let [by-id (into {} (map (juxt #(get % "id") identity) full-items))]
      (mapv by-id item-ids))))

(defn check-cursor-contract
  "Preflight check for a pinned Cursor cloud-agent cycle contract."
  [contract controller-root]
  (when-not (= "loyly.cursor-subagent-cycle.v1" (get contract "schema"))
    (throw (ex-info "invalid cycle contract" {})))
  (let [run-id (str (or (get contract "runId") ""))
        score-cycle (str (or (get contract "scoreCycle") ""))
        scratch (str (or (get contract "scratch") ""))]
    (when (or (not (re-matches safe-id run-id))
              (not (re-matches #"^[0-9]{2}$" score-cycle))
              (not (plat/absolute? scratch))
              (not= (plat/absolutize scratch) scratch))
      (throw (ex-info "run ID, score cycle and absolute scratch path must be pinned" {}))))
  (assert-clean-commit! controller-root (get contract "controllerCommit")
                        "controller checkout is dirty or differs from approved commit")
  (let [source (get contract "source")
        source-repo (get source "repo")
        cl-pin (get source "checklist")
        default-dockerfile (plat/absolutize (plat/path controller-root "harness" "pi-durable" "Dockerfile.panel-multistack"))]
    (assert-clean-commit! source-repo (get source "commit")
                          "source checkout is dirty or differs from approved commit")
    (require-pin! cl-pin)
    (let [{:keys [parsed]} (derive-source-checklist! source-repo "loyly-cursor-checklist")]
      (when-not (contracts/selected-checklist? parsed)
        (throw (ex-info "source-derived checklist is invalid" {})))
      (let [selected-items (assert-subsequence-items! (get parsed "items") (vec (get source "itemIds")))
            cl (read-json (get cl-pin "path"))]
        (when-not (contracts/selected-checklist? cl)
          (throw (ex-info "invalid selected checklist" {})))
        (let [items (get cl "items")
              ids (mapv #(get % "id") items)]
          (when (or (not= ids (vec (get source "itemIds")))
                    (not= items selected-items))
            (throw (ex-info "approved item list differs from checklist" {})))
          (assert-specs-match! source-repo items (get source "specs"))
          (let [ex (get contract "execution")]
            (when (or (not (map? ex))
                      (not= "cursor-cloud-agent" (get ex "builderEngine"))
                      (not= "cursor-cloud-agent" (get ex "graderEngine"))
                      (not= "cursor-cloud-agent" (get ex "blindEngine")))
              (throw (ex-info "Cursor cloud-agent engine boundary is not pinned" {})))
            (let [dockerfile (assert-cursor-probe-boundary! ex default-dockerfile)]
              (doseq [k ["allureSchema" "panelPlan"]]
                (require-pin! (get ex k)))
              (let [panel-doc (assert-agents-and-panel!
                               contract cl ids
                               (get CURSOR-SEALS "graderTool")
                               (get CURSOR-SEALS "blindTool")
                               "Cursor cloud agents")
                    expected-rt (get ex "graderRuntime")]
                (when (some #(and (#{"raw-grader" "blind-review"} (get % "source"))
                                  (not= expected-rt (get % "target_runtime")))
                            (get panel-doc "checks"))
                  (throw (ex-info (str "panel target_runtime must match pinned probe runtime " expected-rt) {})))
                (cond-> (array-map
                         "controllerCommit" (get contract "controllerCommit")
                         "runId" (get contract "runId")
                         "scoreCycle" (get contract "scoreCycle")
                         "sourceCommit" (get source "commit")
                         "itemIds" ids
                         "checklistSha256" (get cl-pin "sha256")
                         "probeRuntime" expected-rt)
                  (= "docker" expected-rt) (assoc "dockerfile" dockerfile)
                  (get ex "dockerImage") (assoc "dockerImage" (get ex "dockerImage"))
                  true (assoc "specSha256"
                              (mapv #(array-map "path" (get % "path") "sha256" (get % "sha256"))
                                    (get source "specs"))))))))))))

(defn check-codex-reassessment
  "Read-only preflight for a separately pinned Codex grader-only reassessment."
  [contract controller-root]
  (when (or (not= "loyly.codex-grader-reassessment.v1" (get contract "schema"))
            (not (re-matches safe-id (str (or (get contract "reassessmentId") ""))))
            (not (re-matches hex40 (str (or (get contract "controllerCommit") ""))))
            (not= (d/git controller-root "rev-parse" "HEAD") (get contract "controllerCommit"))
            (seq (d/git controller-root "status" "--porcelain")))
    (throw (ex-info "reassessment controller differs from approved clean commit" {})))
  (let [output (str (or (get contract "output") ""))
        original (get contract "original")]
    (when (or (not (plat/absolute? output))
              (not= (plat/absolutize output) output)
              (plat/exists? output))
      (throw (ex-info "reassessment output must be a fresh absolute path" {})))
    (let [cycle-dir (str (or (get original "cycleDir") ""))]
      (when (or (not (map? original))
                (not (plat/absolute? cycle-dir))
                (not= (plat/absolutize cycle-dir) cycle-dir)
                (.startsWith output (str cycle-dir "/"))
                (not (re-matches hex40 (str (or (get original "sourceCommit") ""))))
                (empty? (get original "builderModel"))
                (some #(not (re-matches hex64 (str (or % ""))))
                      [(get original "candidateSha256")
                       (get original "scoreSha256")
                       (get original "checklistSha256")
                       (get original "runContractSha256")]))
        (throw (ex-info "reassessment original must be fully pinned and separate" {})))
      (let [orig-file (fn [n] (plat/path cycle-dir n))]
        (doseq [[n expected] [["scores.json" (get original "scoreSha256")]
                              ["checklist.json" (get original "checklistSha256")]
                              ["run-contract.json" (get original "runContractSha256")]]]
          (when-not (= (d/file-sha256 (orig-file n)) expected)
            (throw (ex-info (str "original " n " differs from pinned score/checklist/contract") {:file n}))))
        (when-not (= (d/tree-digest (orig-file "candidate/impl") "impl")
                     (get original "candidateSha256"))
          (throw (ex-info "original candidate differs from pinned gated digest" {})))
        (let [orig-run (read-json (orig-file "run-contract.json"))]
          (when (or (not= (get-in orig-run ["source" "commit"]) (get original "sourceCommit"))
                    (not= (get-in orig-run ["agents" "builder" "model"]) (get original "builderModel")))
            (throw (ex-info "original source or builder model differs from filed run" {}))))
        (let [full (read-json (orig-file "checklist.json"))
              scores (read-json (orig-file "scores.json"))]
          (when-not (and (contracts/selected-checklist? full)
                         (contracts/selected-checklist? scores))
            (throw (ex-info "invalid original checklist or score" {})))
          (let [scored (get scores "items")
                full-items (get full "items")
                full-ids (mapv #(get % "id") full-items)]
            (when (or (not= (mapv #(get % "id") scored) full-ids)
                      (some #(not (#{"pass" "fail"} (get % "verdict"))) scored))
              (throw (ex-info "original score differs from its full checklist" {})))
            (let [failed (mapv #(get % "id") (filter #(= "fail" (get % "verdict")) scored))
                  selected (get contract "selection")]
              (when (or (not (map? selected))
                        (empty? failed)
                        (not= (vec (get selected "itemIds")) failed))
                (throw (ex-info "reassessment must select exactly the original failed items" {})))
              (require-pin! (get selected "checklist") "reassessment pin differs: " true)
              (let [subset (read-json (get-in selected ["checklist" "path"]))]
                (when-not (contracts/selected-checklist? subset)
                  (throw (ex-info "invalid reassessment checklist" {})))
                (let [failed-set (set failed)
                      expected-items (filterv #(contains? failed-set (get % "id")) full-items)]
                  (when-not (= (get subset "items") expected-items)
                    (throw (ex-info "reassessment checklist differs from selected original items" {})))
                  (let [spec-paths (sort (distinct
                                          (mapv (fn [item]
                                                  (let [m (re-matches reassessment-spec-re
                                                                      (str (or (get item "source") "")))]
                                                    (when-not m
                                                      (throw (ex-info (str "selected item has invalid source: " (get item "id")) {})))
                                                    (orig-file (str "grading-room/plan/" (second m) "/spec.feature"))))
                                                expected-items)))
                        sel-specs (get selected "specs")
                        sel-paths (mapv #(get % "path") sel-specs)]
                    (when (or (not= (count (set sel-paths)) (count sel-paths))
                              (not= (sort sel-paths) spec-paths))
                      (throw (ex-info "reassessment specs differ from selected source slices" {})))
                    (doseq [spec sel-specs]
                      (require-pin! spec "reassessment pin differs: " true))))
                (let [grader (get contract "grader")]
                  (when (or (not (map? grader))
                            (empty? (get grader "model"))
                            (= (get grader "model") (get original "builderModel")))
                    (throw (ex-info "reassessment grader must use an independent model" {})))
                  (require-pin! (get grader "instruction") "reassessment pin differs: " true)
                  (require-pin! (get grader "wrapper") "reassessment pin differs: " true))
                (let [ex (get contract "execution")]
                  (when (or (not (map? ex))
                            (not= "codex-subagent" (get ex "engine"))
                            (not= "gondolin-qemu-vm" (get ex "runtime")))
                    (throw (ex-info "reassessment must use a Codex agent and private Gondolin VMs" {})))
                  (doseq [k ["graderImageManifest" "allureSchema" "panelPlan"]]
                    (require-pin! (get ex k) "reassessment pin differs: " true))
                  (when-not (= "manifest.json" (plat/file-name (get-in ex ["graderImageManifest" "path"])))
                    (throw (ex-info "grader VM pin must name its manifest" {})))
                  (let [panel-doc (read-json (get-in ex ["panelPlan" "path"]))]
                    (panel-sel/validate-panel-coverage panel-doc subset)
                    (when (some #(or (not= "raw-grader" (get % "source"))
                                     (not= "scored" (get % "role"))
                                     (not= (get CODEX-SEALS "graderTool") (get % "tool")))
                                (get panel-doc "checks"))
                      (throw (ex-info "reassessment panel must be a raw independent Codex grader" {}))))
                  (array-map
                   "reassessmentId" (get contract "reassessmentId")
                   "controllerCommit" (get contract "controllerCommit")
                   "sourceCommit" (get original "sourceCommit")
                   "candidateSha256" (get original "candidateSha256")
                   "originalScoreSha256" (get original "scoreSha256")
                   "originalChecklistSha256" (get original "checklistSha256")
                   "selectedItemIds" failed
                   "selectedChecklistSha256" (get-in selected ["checklist" "sha256"])
                   "graderModel" (get-in contract ["grader" "model"])
                   "graderInstructionSha256" (get-in contract ["grader" "instruction" "sha256"])
                   "graderWrapperSha256" (get-in contract ["grader" "wrapper" "sha256"])
                   "panelSha256" (get-in ex ["panelPlan" "sha256"])
                   "imageManifestSha256" (get-in ex ["graderImageManifest" "sha256"])
                   "allureSchemaSha256" (get-in ex ["allureSchema" "sha256"])
                   "output" output))))))))))

(defn decide
  [input-path]
  (let [input (read-json input-path)]
    (life/decide-attempt
     (get input "attempt")
     (get input "build")
     (get input "gate"))))

(defn candidate
  [input-path]
  (let [input (read-json input-path)]
    (caches/check-candidate-caches
     (get input "room")
     :mode (or (get input "mode") "sealed"))))

(defn evidence
  [driver input-path]
  (let [files (read-json input-path)
        report (room/check-room-evidence files (seals-for driver))
        life (life/create-lifecycle
              :assessments (get report "assessments"))]
    (assoc report "nextPhase" ((:after-grade life) {"status" "completed"}))))

(defn panel
  [input-path]
  (let [files (read-json input-path)
        assessed (panel/assess-room-panel files)
        life (life/create-lifecycle :assessments ["panel"])]
    (assoc assessed
           "nextPhase"
           ((:after-assessment life)
            "panel"
            (= "ready-for-review" (get assessed "panel_outcome"))))))

(defn preflight
  ([driver input-path] (preflight driver input-path (plat/cwd)))
  ([driver input-path controller-root]
   (let [contract (read-json input-path)]
     (case driver
       :codex (check-codex-contract contract controller-root)
       :cursor (check-cursor-contract contract controller-root)
       (throw (ex-info (str "unknown adapter driver: " driver) {:driver driver}))))))

(defn reassess
  ([input-path] (reassess input-path (plat/cwd)))
  ([input-path controller-root]
   (check-codex-reassessment (read-json input-path) controller-root)))

(defn dispatch
  "Run one adapter action; return report map (caller prints JSON)."
  ([driver action input-path] (dispatch driver action input-path (plat/cwd)))
  ([driver action input-path controller-root]
   (case action
     "decide" (decide input-path)
     "candidate" (candidate input-path)
     "evidence" (evidence driver input-path)
     "panel" (panel input-path)
     "preflight" (preflight driver input-path controller-root)
     "reassess" (if (= :codex driver)
                  (reassess input-path controller-root)
                  (throw (ex-info (str "driver does not support reassess: " driver) {:driver driver})))
     (throw (ex-info (str "unknown adapter action: " action) {:action action})))))
