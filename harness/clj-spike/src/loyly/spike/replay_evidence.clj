(ns loyly.spike.replay-evidence
  "PoC port of summary projection from harness/pi-durable/replay-evidence.ts.
  Full projectReplayEvidence (needs Allure rooms + audit rows) stays partial."
  (:require [babashka.fs :as fs]
            [loyly.spike.digest :as d]))

(defn panel-plan-for-manifest
  "Find the unique local *.panel.json matching manifest plan_sha256 under `here`."
  [here manifest]
  (let [plan-sha (get manifest "plan_sha256")]
    (when-not (re-matches #"[0-9a-f]{64}" (str plan-sha))
      (throw (ex-info "panel manifest has no plan digest" {})))
    (let [matches (->> (fs/list-dir here)
                       (map fs/file-name)
                       (filter #(and (.endsWith ^String % ".panel.json")
                                     (= (d/file-sha256 (fs/path here %)) plan-sha))))]
      (when-not (= 1 (count matches))
        (throw (ex-info "panel replay needs exactly one local plan matching the committed digest"
                        {})))
      (str (fs/path here (first matches))))))

(defn summary
  "Build a loyly.replay-evidence.v1 projection from one Allure-like result."
  [result item after-seq kind source-digest dir]
  (array-map
   "schema" "loyly.replay-evidence.v1"
   "source" "Allure evidence projection"
   "kind" kind
   "after_seq" after-seq
   "item" item
   "name" (or (get result "name") "")
   "status" (get result "status")
   "stage" (get result "stage")
   "observation" (get-in result ["statusDetails" "message"])
   "steps" (mapv (fn [step]
                   (array-map "name" (get step "name")
                              "status" (get step "status")
                              "stage" (get step "stage")))
                 (or (get result "steps") []))
   "attachments" (mapv (fn [attachment]
                         (array-map
                          "name" (get attachment "name")
                          "type" (get attachment "type")
                          "sha256" (d/file-sha256 (fs/path dir (get attachment "source")))))
                       (or (get result "attachments") []))
   "source_digest" source-digest))

(defn find-last-audit
  "Last audit row matching pred (reverse scan like Array.findLast)."
  [rows pred]
  (first (filter pred (reverse rows))))

(defn project-grade-row
  "Extract the completed grade audit row, or nil."
  [rows]
  (find-last-audit
   rows
   (fn [row]
     (and (= (get row "stage") "grade")
          (= (get row "outcome") "completed")
          (string? (get row "allure_results_sha256"))))))
