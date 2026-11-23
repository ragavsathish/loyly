(ns loyly.spike.panel-compile
  "PoC port of pure helpers from harness/pi-durable/panel-compile.ts.
  Full Allure report compilation stays on the TS side."
  (:require [loyly.spike.project.loyly.schemas :as schemas]))

(defn label
  "Allure label value by name."
  [result name]
  (some (fn [entry]
          (when (= name (get entry "name"))
            (get entry "value")))
        (get result "labels")))

(defn assert-specialist-manifest-bound
  [{:keys [plan plan-sha256 manifest candidate-sha256 schema-sha256
           score-sha256 source-commit specs]}]
  (when (or (not (#{"loyly.supplemental-grade.v1" schemas/PANEL_VM_RUN}
                  (get manifest "schema")))
            (not= (get manifest "source_commit") source-commit)
            (not= (get manifest "candidate_sha256") candidate-sha256)
            (and (= (get plan "schema") "harness.grading-panel-plan.v2")
                 (not= (get manifest "worker_bundle_sha256")
                       (get-in plan ["bundle" "sha256"])))
            (not= (get manifest "allure_schema_sha256") schema-sha256)
            (and (= (get manifest "schema") "loyly.supplemental-grade.v1")
                 (not= (get manifest "original_score_sha256") score-sha256))
            (and (= (get manifest "schema") schemas/PANEL_VM_RUN)
                 (not (or (and (= (get manifest "score_state") "pre-score")
                               (nil? (get manifest "original_score_sha256")))
                          (and (= (or (get manifest "score_state") "filed") "filed")
                               (= (get manifest "original_score_sha256") score-sha256)))))
            (and (= (get manifest "schema") "loyly.supplemental-grade.v1")
                 (not= (get manifest "original_score_unchanged") true))
            (and (= (get manifest "schema") schemas/PANEL_VM_RUN)
                 (not= (get manifest "plan_sha256") plan-sha256))
            (not= (count (get manifest "producers")) (count specs)))
    (throw (ex-info "specialist manifest is not bound to this scored candidate and plan" {}))))

(defn specialist-runtime
  "Infer runtime label from execution receipt + manifest schema."
  [spec receipt manifest]
  (cond
    (and (= (get manifest "schema") schemas/PANEL_VM_RUN)
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

(defn assert-specialist-overlap
  [manifest observations]
  (let [intervals (if (= (get manifest "schema") schemas/PANEL_VM_RUN)
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

(defn build-panel-summary-shape
  "Minimal panel-summary object fields the TS compiler emits (sans Allure I/O)."
  [{:keys [candidate-sha256 plan-sha256 original-score-sha256 evaluation]}]
  (array-map
   "schema" schemas/PANEL_SUMMARY
   "candidate_sha256" candidate-sha256
   "plan_sha256" plan-sha256
   "original_score_sha256" original-score-sha256
   "panel_outcome" (get evaluation :panel-outcome (:panel-outcome evaluation))
   "gaps" (get evaluation :gaps (:gaps evaluation))
   "checks" (mapv #(get % "id") (get evaluation :checks (:checks evaluation)))
   "items" (get evaluation :items (:items evaluation))))
