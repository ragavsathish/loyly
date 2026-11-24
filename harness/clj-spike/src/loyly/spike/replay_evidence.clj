(ns loyly.spike.replay-evidence
  "PoC port of summary projection from harness/pi-durable/replay-evidence.ts.
  Full projectReplayEvidence (needs Allure rooms + audit rows) stays partial."
  (:require [babashka.fs :as fs]
            [loyly.spike.allure-results :as allure]
            [loyly.spike.blind-review :as blind]
            [loyly.spike.digest :as d]
            [loyly.spike.grading-room :as room]
            [loyly.spike.hjson :as hjson]
            [loyly.spike.panel-vm :as panel-vm]
            [loyly.spike.project.loyly :as loyly]))

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

(defn project-replay-evidence
  "Project committed grade/blind/panel rows into replay evidence records."
  [dir rows]
  (let [grade (project-grade-row rows)
        blind (find-last-audit rows #(and (= (get % "stage") "blind-review")
                                          (= (get % "outcome") "completed")))]
    (cond
      (and (not grade) (not blind)) []
      (and blind (not grade)) (throw (ex-info "completed blind review has no committed Allure grade" {}))
      :else
      (let [grading-room (str (fs/file dir "grading-room"))
            prepared (find-last-audit
                      rows
                      #(and (= (get % "stage") "grading-room")
                            (= (get % "outcome") "prepared")
                            (string? (get % "candidate_sha256"))))]
        (when (or (nil? prepared) (not (fs/exists? grading-room)))
          (throw (ex-info "committed grade has no bound grading room" {})))
        (let [room-receipt (hjson/read-json
                            (slurp (fs/file grading-room ".grading-room.json") :encoding "UTF-8"))]
          (room/verify-grading-room
           (array-map
            :out grading-room
            :candidate-sha256 (get prepared "candidate_sha256")
            :checklist-sha256 (get prepared "checklist_sha256")
            :schema-sha256 (get room-receipt "schemaSha256")
            :project (or (get room-receipt "project") "loyly")
            :blind-review (if (contains? room-receipt "blindReview")
                            (get room-receipt "blindReview")
                            true)))
          (let [judged (allure/read-allure-results grading-room)]
            (when-not (= (:allure-sha256 judged) (get grade "allure_results_sha256"))
              (throw (ex-info "Allure evidence differs from the committed grade digest" {})))
            (let [checklist (hjson/read-json
                             (slurp (fs/file grading-room "checklist.json") :encoding "UTF-8"))
                  projected
                  (mapv (fn [item]
                          (let [result (some (fn [value]
                                               (when (some #(and (= "tag" (get % "name"))
                                                                 (= (str "@item-" (get item "id"))
                                                                    (get % "value")))
                                                         (get value "labels"))
                                                 value))
                                             (:results judged))]
                            (when-not result
                              (throw (ex-info (str "Allure result missing for " (get item "id")) {})))
                            (summary result (get item "id") (get grade "seq") "grader-item"
                                     (:allure-sha256 judged)
                                     (str (fs/file grading-room "work" "allure-results")))))
                        (get checklist "items"))
                  with-blind
                  (cond-> projected
                    blind
                    (conj
                     (do
                       (when-not (= (get blind "raw_allure_sha256") (:allure-sha256 judged))
                         (throw (ex-info "blind review audit differs from committed grade evidence" {})))
                       (let [review-file (str (fs/file dir "blind-agent-review.json"))
                             review (hjson/read-json (slurp review-file :encoding "UTF-8"))
                             supplemental (blind/read-blind-agent-allure
                                           {:packet-dir (str (fs/file dir "blind-agent-packet"))
                                            :review-file review-file
                                            :grading-room grading-room
                                            :verification-dir (when (= "pass" (get review "verdict"))
                                                                (str (fs/file dir "blind-agent-verification")))
                                            :out (str (fs/file dir "blind-agent-allure"))})]
                         (when-not (= (:review-sha256 supplemental) (get blind "review_sha256"))
                           (throw (ex-info
                                   "blind Allure evidence differs from the committed review digest"
                                   {})))
                         (summary (:result supplemental) loyly/BLIND_ITEM_ID (get blind "seq")
                                  "blind-review" (:review-sha256 supplemental)
                                  (str (fs/file dir "blind-agent-allure")))))))]
              (if (and (not blind)
                       (if (contains? room-receipt "blindReview")
                         (get room-receipt "blindReview")
                         true))
                with-blind
                (let [panel (find-last-audit rows #(and (= (get % "stage") "panel")
                                                        (= (get % "outcome") "completed")))]
                  (if-not panel
                    with-blind
                    (let [selected (hjson/read-json
                                    (slurp (fs/file dir "panel-vm" "selected.json") :encoding "UTF-8"))
                          attempt (get selected "attempt")
                          out (str (fs/file dir "panel-vm" (format "attempt-%02d" attempt)))
                          manifest (hjson/read-json (slurp (fs/file out "manifest.json") :encoding "UTF-8"))
                          verified (panel-vm/verify-panel-vm-run
                                    {:original (str (fs/absolutize dir)) :out out
                                     :plan-file (panel-plan-for-manifest
                                                 (str (fs/file dir "panel-plans")) manifest)})
                          panel-sha (get panel "manifest_sha256")]
                      (when (or (not panel-sha)
                                (not= (get selected "manifest_sha256") panel-sha)
                                (not= (d/file-sha256 (fs/file out "manifest.json")) panel-sha))
                        (throw (ex-info "panel Allure evidence differs from committed Pi audit" {})))
                      (into with-blind
                            (map (fn [worker]
                                   (let [evidence-dir (str (fs/file out (get worker "id")))
                                         result (hjson/read-json
                                                 (slurp (fs/file evidence-dir (get worker "result"))
                                                        :encoding "UTF-8"))]
                                     (summary result (subs (get worker "item") 6) (get panel "seq")
                                              "panel-specialist" panel-sha evidence-dir)))
                                 (get-in verified [:manifest "producers"]))))))))))))))
