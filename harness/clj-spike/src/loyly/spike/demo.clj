(ns loyly.spike.demo
  "Smoke the TS→CLJ spike: measure + loyly + receipt + verdicts + grading-room digests."
  (:require [clojure.java.io :as io]
            [clojure.java.shell :as sh]
            [clojure.string :as str]
            [loyly.spike.blind-review :as blind]
            [loyly.spike.digest :as d]
            [loyly.spike.gen-checklist :as checklist]
            [loyly.spike.grading-room :as room]
            [loyly.spike.hjson :as hjson]
            [loyly.spike.live-contract :as live]
            [loyly.spike.panel-selection :as panel]
            [loyly.spike.project.loyly.blind-answer :as answer]
            [loyly.spike.project.loyly.blind-policy :as policy]
            [loyly.spike.project.loyly.identity :as id]
            [loyly.spike.project.loyly.schemas :as schemas]
            [loyly.spike.score :as score]
            [loyly.spike.score-receipt :as receipt]
            [loyly.spike.scoreboard :as board]
            [loyly.spike.validate-verdicts :as vv]))

(defn- die [msg]
  (hjson/err (str msg "\n"))
  (System/exit 1))

(defn- sh! [& args]
  (let [{:keys [exit out err]} (apply sh/sh args)]
    (when-not (zero? exit)
      (die (str (str/join " " args) " failed: " err out)))
    out))

(defn -main [& args]
  (let [repo (or (second (drop-while #(not= "--root" %) (vec args))) ".")
        repo (.getCanonicalFile (io/file repo))
        scratch (io/file (System/getProperty "java.io.tmpdir")
                         (str "loyly-clj-spike-" (System/currentTimeMillis)))]
    (.mkdirs (io/file scratch "harness" "cycles" "02"))
    (let [instrument (io/file scratch "instrument")
          checklist-file (io/file scratch "checklist.json")]
      (sh! "git" "clone" "-q" "--depth" "1" (str "file://" repo) (str instrument))
      (.mkdirs (io/file instrument "harness" "cycles" "02"))
      (checklist/generate {:root (str instrument) :out (str checklist-file)})
      (sh! "cp" (str checklist-file)
           (str (io/file instrument "harness" "cycles" "02" "checklist.json")))
      (let [checklist (hjson/read-json (slurp checklist-file :encoding "UTF-8"))
            items (get checklist "items")
            _ (when-not (policy/requires-blind-handoff id/PROJECT_ID items)
                (die "expected booking-core checklist to require blind handoff"))
            _ (let [parsed (answer/parse-blind-agent-answer
                            "REQUEST: pukuhuone 9 | Thursday | 17:00"
                            "pukuhuone 9 is closed Monday; try Thursday 17:00 instead.")]
                (when-not (= "pass" (:verdict parsed))
                  (die "blind answer parse failed")))
            _ (blind/validate-blind-response-shape
               (array-map "schema" schemas/BLIND_RESPONSE
                          "packet_sha256" (apply str (repeat 64 "c"))
                          "reviewer_kind" "agent"
                          "reviewer" "spike-agent"
                          "had_not_read_configuration" true
                          "saw_only_refusal" true
                          "answer" "REQUEST: pukuhuone 9 | Thursday | 17:00"
                          "verdict" "pass"
                          "reason" "named from refusal"
                          "reviewed_at" 1)
               (apply str (repeat 64 "c")))
            sources (->> items
                         (map #(second (re-matches
                                        #"^(docs/plan/\d\d-[a-z][a-z0-9-]*/spec\.feature):\d+$"
                                        (get % "source"))))
                         set
                         sort
                         vec)
            specs (mapv (fn [file]
                          (array-map "file" file "sha256" (d/file-sha256 (io/file instrument file))))
                        sources)
            _ (live/verify-selected-specs (str instrument)
                                          (array-map "specs" specs)
                                          checklist)
            panel-plan (hjson/read-json
                        (slurp (io/file instrument "harness" "pi-durable"
                                        id/DEFAULT_PANEL_PLAN)
                               :encoding "UTF-8"))
            panel-sel (panel/validate-panel-selection panel-plan checklist)
            _ (when-not (seq (:specialists panel-sel))
                (die "expected specialist checks on booking-core panel plan"))
            verdicts (mapv (fn [item]
                             (if (= (get item "id") id/BLIND_ITEM_ID)
                               (array-map "id" id/BLIND_ITEM_ID
                                          "verdict" "fail"
                                          "evidence" (str policy/PENDING_SUBAGENT " (spike)"))
                               (array-map "id" (get item "id")
                                          "verdict" "pass"
                                          "evidence" (str "observed " (get item "id")))))
                           items)
            ;; Compact JSON like the TS score-receipt test (JSON.stringify, no pretty).
            verdicts-file (io/file scratch "verdicts.json")
            _ (hjson/spit-utf8 verdicts-file (hjson/compact-json verdicts))
            room-dir (io/file scratch "grading-room")
            _ (do (.mkdirs (io/file room-dir "work"))
                  (sh! "cp" (str checklist-file) (str (io/file room-dir "checklist.json")))
                  (hjson/spit-utf8 (io/file room-dir "work" "verdicts.json")
                                   (hjson/compact-json verdicts))
                  (hjson/spit-utf8 (io/file room-dir "work" "surprises.json") "[]")
                  (hjson/spit-utf8 (io/file room-dir id/BLIND_REFUSAL_FILE)
                                   "pukuhuone 9 closed Monday; try Thursday 17:00\n"))
            judged (vv/validate-verdicts (str room-dir))
            _ (when-not (pos? (:pass judged))
                (die "expected some passing verdicts"))
            cand (io/file scratch "candidate")
            _ (do (.mkdirs (io/file cand "impl"))
                  (hjson/spit-utf8 (io/file cand "impl" "start.sh") "#!/bin/sh\necho ok\n")
                  (.setExecutable (io/file cand "impl" "start.sh") true))
            cand-sha (room/candidate-digest (str cand))
            schema-file (io/file repo "harness" "pi-durable"
                                 "allure-lifecycle-result.schema.json")
            _ (when-not (.isFile schema-file)
                (die (str "missing schema at " schema-file)))
            checklist-sha (d/file-sha256 checklist-file)
            schema-sha (d/file-sha256 schema-file)
            grade-out (io/file scratch "grade-out")
            receipt-map (room/prepare-grading-room
                         {:source-room (str instrument)
                          :candidate-room (str cand)
                          :checklist-file (str checklist-file)
                          :schema-file (.getAbsolutePath schema-file)
                          :out (.getAbsolutePath grade-out)
                          :candidate-sha256 cand-sha
                          :checklist-sha256 checklist-sha
                          :schema-sha256 schema-sha})
            _ (room/verify-grading-room
               {:out (.getAbsolutePath grade-out)
                :candidate-sha256 cand-sha
                :checklist-sha256 checklist-sha
                :schema-sha256 schema-sha})
            _ (score/score-cycle {:root (str instrument)
                                  :cycle "02"
                                  :verdicts-path (str verdicts-file)})
            _ (receipt/bind-score-input
               {:scratch (str scratch)
                :source-root (str repo)
                :instrument (str instrument)
                :candidate-sha256 cand-sha
                :verdicts-file (str verdicts-file)
                :score-cycle "02"})
            verified (receipt/verify-scored-cycle
                      {:scratch (str scratch)
                       :instrument (str instrument)
                       :verdicts-file (str verdicts-file)
                       :cycle "02"})
            board (board/report {:root (str instrument) :cycle "02"})]
        (hjson/out
         (str "clj-spike demo OK: " (:score verified)
              " pass=" (:pass judged)
              " plans=" (count (get receipt-map "sourcePlans"))
              " panel-specialists=" (count (:specialists panel-sel))
              " blind-item=" id/BLIND_ITEM_ID "\n"
              (str/trim-newline (:text board)) "\n"
              "scratch=" scratch "\n")))))
  nil)
