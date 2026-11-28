(ns loyly.render-allure
  "Render a scored cycle with the official Allure CLI and write loyly-report-manifest.json (.cljc).

  Port of harness/pi-durable/render-allure.mjs."
  (:require [clojure.string :as str]
            [loyly.allure-results :as allure]
            [loyly.audit-rows :as audit]
            [loyly.blind-review :as blind]
            [loyly.digest :as d]
            [loyly.grading-room :as room]
            [loyly.hjson :as hjson]
            [loyly.platform :as plat]
            [loyly.project.loyly :as loyly]
            [loyly.score-receipt :as receipt]))

(defn- project-scored-verdicts [scratch grading-room raw blind-required?]
  (if-not blind-required?
    {:projected {:verdicts (:verdicts raw) :raw-allure-sha256 (:allure-sha256 raw)}
     :supplemental nil}
    (let [review-file (plat/path scratch "blind-agent-review.json")
          review (hjson/read-json (plat/read-text review-file))
          blind-args {:packet-dir (plat/path scratch "blind-agent-packet")
                      :review-file review-file
                      :grading-room grading-room
                      :verification-dir (when (= "pass" (get review "verdict"))
                                          (plat/path scratch "blind-agent-verification"))
                      :out (plat/path scratch "blind-agent-allure")}
          projected (blind/final-verdicts-from-blind-review blind-args)
          supplemental (blind/read-blind-agent-allure blind-args)]
      (when-not (= (:allure-sha256 raw) (:raw-allure-sha256 projected))
        (throw (ex-info "raw grader Allure changed after blind review" {})))
      {:projected projected :supplemental supplemental})))

(defn- assert-scored-allure-audit [{:keys [scratch score-input projected score blind-required? rows]}]
  (let [stage (fn [stage-name outcome]
                (last (filter #(and (= stage-name (get % "stage"))
                                    (= outcome (get % "outcome")))
                              rows)))
        cut (stage "cut" "pinned")
        grade (stage "grade" "completed")
        blind-row (stage "blind-review" "completed")
        filed (stage "score" "filed")]
    (when (or (not= (get cut "approved_commit") (get score-input "source_commit"))
              (not= (get grade "allure_results_sha256") (:raw-allure-sha256 projected))
              (and blind-required?
                   (not= (get blind-row "raw_allure_sha256") (:raw-allure-sha256 projected)))
              (and blind-required?
                   (not= (get blind-row "review_sha256") (:review-sha256 projected)))
              (not= (get filed "score_file_sha256") (:score-sha256 score))
              (not= (get filed "score_input_sha256")
                    (d/file-sha256 (plat/path scratch "score-input.json")))
              (nil? (stage "cycle" "measured")))
      (throw (ex-info "scored Allure evidence differs from committed Pi audit entries" {})))
    rows))

(defn- default-allure-generate! [{:keys [pi-durable result-dirs out]}]
  (let [cli (plat/path pi-durable "node_modules" ".bin" "allure")]
    (when-not (plat/exists? cli)
      (throw (ex-info "Allure CLI missing; install dependencies in harness/pi-durable" {:cli cli})))
    (let [cmd (into [cli "generate"]
                    (concat result-dirs
                            ["--config" (plat/path pi-durable "allurerc.mjs")
                             "--output" out "--clean"]))
          res (plat/exec-sync cmd {:dir pi-durable})]
      (when-not (zero? (:exit res))
        (throw (ex-info (str "Allure render failed: " (:err res)) res))))))

(defn render-scored-allure
  "Verify scored cycle bindings against committed Pi audit and render the Allure report."
  [scratch {:keys [pi-durable audit-rows allure-cli-fn]}]
  (let [scratch (plat/absolutize scratch)
        here (plat/absolutize (or pi-durable (plat/path (plat/cwd) "harness" "pi-durable")))
        instrument (plat/path scratch "instrument")
        grading-room (plat/path scratch "grading-room")
        receipt-doc (hjson/read-json (plat/read-text (plat/path grading-room ".grading-room.json")))
        blind-required? (if (contains? receipt-doc "blindReview")
                          (boolean (get receipt-doc "blindReview"))
                          true)
        verdicts-file (plat/path scratch (if blind-required? "final-verdicts.json" "verdicts.json"))
        score-input (hjson/read-json (plat/read-text (plat/path scratch "score-input.json")))]
    (when-not (= (room/candidate-digest (plat/path scratch "fenced-room"))
                 (get score-input "candidate_sha256"))
      (throw (ex-info "current candidate differs from the scored candidate" {})))
    (let [score (receipt/verify-scored-cycle
                 {:scratch scratch
                  :instrument instrument
                  :verdicts-file verdicts-file
                  :cycle (receipt/score-cycle-for scratch)})
          raw (allure/read-allure-results grading-room)
          {:keys [projected supplemental]}
          (project-scored-verdicts scratch grading-room raw blind-required?)]
      (when-not (= (plat/read-text verdicts-file) (hjson/compact-json (:verdicts projected)))
        (throw (ex-info "scored verdicts differ from the bound Allure projection" {})))
      (let [rows (assert-scored-allure-audit
                  {:scratch scratch
                   :score-input score-input
                   :projected projected
                   :score score
                   :blind-required? blind-required?
                   :rows (or audit-rows (audit/read-audit-rows scratch))})
            fixture? (some #(or (true? (get % "fixture")) (true? (get % "fixture_grader"))) rows)
            out (plat/path scratch "allure-report")
            result-dirs (cond-> [(plat/path grading-room "work" "allure-results")]
                          blind-required? (conj (plat/path scratch "blind-agent-allure")))
            _ ((or allure-cli-fn default-allure-generate!)
               {:pi-durable here :result-dirs result-dirs :out out})
            summary (hjson/read-json (plat/read-text (plat/path out "summary.json")))
            all-results (cond-> (vec (:results raw))
                          supplemental (conj (:result supplemental)))
            expected (reduce (fn [acc r]
                               (update acc (get r "status") (fnil inc 0)))
                             {"total" (+ (count (:items score)) (if blind-required? 1 0))}
                             all-results)
            stats (or (get summary "stats") {})]
        (doseq [k (set (concat (keys expected) (keys stats)))]
          (when-not (= (get stats k 0) (get expected k 0))
            (throw (ex-info (str "Allure report " k " count differs from scored evidence")
                            {:key k :got (get stats k 0) :expected (get expected k 0)}))))
        (let [report (plat/path out "index.html")
              manifest (cond-> (array-map
                                "schema" "loyly.allure-report.v1"
                                "evidence_kind" (if fixture? "fixture" "live measurement, not accepted")
                                "audit_entries_sha256" (d/sha256-string (str/join "\n" (map hjson/compact-json rows)))
                                "source_commit" (get score-input "source_commit")
                                "candidate_sha256" (get score-input "candidate_sha256")
                                "checklist_sha256" (get score-input "checklist_sha256")
                                "score_sha256" (:score-sha256 score)
                                "score" (:score score)
                                "raw_allure_sha256" (:raw-allure-sha256 projected))
                         blind-required? (assoc "blind_review_sha256" (:review-sha256 projected))
                         true (assoc "report_html_sha256" (d/file-sha256 report)
                                     "result_count" (get expected "total")
                                     "note" (if blind-required?
                                              (str "One raw pending " loyly/BLIND_ITEM_ID
                                                   " result plus one separate blind subagent result; the score has one final verdict per checklist item.")
                                              "One direct grader result and one filed verdict per selected checklist item.")))]
          (hjson/spit-utf8 (plat/path out "loyly-report-manifest.json")
                           (str (hjson/write manifest) "\n"))
          {:out out :report report :manifest manifest :stats stats})))))
