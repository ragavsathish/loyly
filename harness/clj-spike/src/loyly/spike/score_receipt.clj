(ns loyly.spike.score-receipt
  "PoC port of harness/pi-durable/score-receipt.ts"
  (:require [babashka.fs :as fs]
            [loyly.spike.digest :as d]
            [loyly.spike.hjson :as hjson]))

(defn score-cycle-for [scratch]
  (let [input (hjson/read-json (slurp (fs/file scratch "score-input.json") :encoding "UTF-8"))
        cycle (or (get input "score_cycle") "02")]
    (when-not (re-matches #"\d\d" cycle)
      (throw (ex-info "bound score cycle is invalid" {:cycle cycle})))
    cycle))

(defn- panel-manifest-hash [scratch]
  (let [selection (fs/file scratch "panel-vm" "selected.json")]
    (when (fs/regular-file? selection)
      (let [selected (hjson/read-json (slurp selection :encoding "UTF-8"))
            attempt (get selected "attempt")]
        (when (or (not (integer? attempt)) (< attempt 1) (> attempt 2))
          (throw (ex-info "invalid panel VM selection" {:attempt attempt})))
        (let [manifest (fs/file scratch "panel-vm"
                                (format "attempt-%02d" attempt)
                                "manifest.json")
              digest (d/file-sha256 manifest)]
          (when-not (= (get selected "manifest_sha256") digest)
            (throw (ex-info "selected panel manifest changed" {})))
          digest)))))

(defn bind-score-input
  [{:keys [scratch source-root instrument candidate-sha256 verdicts-file score-cycle]
    :or {score-cycle "02"}}]
  (when-not (= (d/git instrument "rev-parse" "HEAD")
               (d/git source-root "rev-parse" "HEAD"))
    (throw (ex-info "instrument clone is from another source cut" {})))
  (when-not (re-matches #"\d\d" score-cycle)
    (throw (ex-info "score cycle must be two digits" {:score-cycle score-cycle})))
  (let [checklist-file (fs/file scratch "checklist.json")
        panel-sha (panel-manifest-hash scratch)
        input (cond-> (array-map
                       "schema" "loyly.score-input.v1"
                       "source_commit" (d/git source-root "rev-parse" "HEAD")
                       "candidate_sha256" candidate-sha256
                       "checklist_sha256" (d/file-sha256 checklist-file)
                       "verdicts_sha256" (d/file-sha256 verdicts-file))
                (not= score-cycle "02") (assoc "score_cycle" score-cycle)
                panel-sha (assoc "panel_manifest_sha256" panel-sha))
        text (str (hjson/compact-json input) "\n")
        receipt (fs/file scratch "score-input.json")]
    (when (and (fs/regular-file? receipt) (not= (slurp receipt :encoding "UTF-8") text))
      (throw (ex-info "score input changed after its first attempt" {})))
    (when-not (fs/regular-file? receipt)
      (hjson/spit-utf8 receipt text))
    input))

(defn verify-scored-cycle
  [{:keys [scratch instrument verdicts-file cycle]
    :or {cycle "02"}}]
  (let [input (hjson/read-json (slurp (fs/file scratch "score-input.json") :encoding "UTF-8"))
        checklist-file (fs/file scratch "checklist.json")
        cycle-dir (fs/path instrument "harness" "cycles" cycle)
        instrument-checklist (fs/file cycle-dir "checklist.json")]
    (when (or (not= (get input "schema") "loyly.score-input.v1")
              (not= (d/git instrument "rev-parse" "HEAD") (get input "source_commit"))
              (not= (or (get input "score_cycle") "02") cycle)
              (not= (d/file-sha256 checklist-file) (get input "checklist_sha256"))
              (not= (d/file-sha256 instrument-checklist) (get input "checklist_sha256"))
              (not= (d/file-sha256 verdicts-file) (get input "verdicts_sha256"))
              (and (contains? input "panel_manifest_sha256")
                   (not= (panel-manifest-hash scratch) (get input "panel_manifest_sha256"))))
      (throw (ex-info "scored cycle inputs differ from the bound cut, checklist or verdicts" {})))
    (let [items (get (hjson/read-json (slurp checklist-file :encoding "UTF-8")) "items")
          verdicts (hjson/read-json (slurp (fs/file verdicts-file) :encoding "UTF-8"))]
      (when (or (not (vector? items)) (empty? items)
                (not (vector? verdicts))
                (not= (count verdicts) (count items))
                (some (fn [i]
                        (let [item (nth items i)
                              v (nth verdicts i)]
                          (or (not= (get v "id") (get item "id"))
                              (not (#{"pass" "fail"} (get v "verdict")))
                              (not (string? (get v "evidence"))))))
                      (range (count items))))
        (throw (ex-info "score input does not cover the exact checklist in order" {})))
      (let [expected (mapv (fn [item v]
                             (apply array-map
                                    (concat (mapcat identity item)
                                            ["verdict" (get v "verdict")
                                             "evidence" (get v "evidence")])))
                           items verdicts)
            score-file (fs/file cycle-dir "scores.json")
            recorded (hjson/read-json (slurp score-file :encoding "UTF-8"))
            recorded-items (get recorded "items")]
        (when (or (not (vector? recorded-items))
                  (not= (hjson/compact-json recorded-items) (hjson/compact-json expected)))
          (throw (ex-info "existing legacy score differs from bound verdicts" {})))
        (let [passes (count (filter #(= "pass" (get % "verdict")) recorded-items))]
          {:items recorded-items
           :score-sha256 (d/file-sha256 score-file)
           :score (str passes "/" (count items))})))))
