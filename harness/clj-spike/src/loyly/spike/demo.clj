(ns loyly.spike.demo
  "Smoke the TS→CLJ spike: measure + loyly + receipt + verdicts + grading-room digests."
  (:require [babashka.fs :as fs]
            [babashka.process :as p]
            [clojure.string :as str]
            [loyly.spike.blind-review :as blind]
            [loyly.spike.continuation :as cont]
            [loyly.spike.digest :as d]
            [loyly.spike.evidence.validate-identity :as ident]
            [loyly.spike.gen-checklist :as checklist]
            [loyly.spike.grader-shards :as shards]
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
  (let [{:keys [exit out err]} @(p/process (vec args) {:out :string :err :string})]
    (when-not (zero? exit)
      (die (str (str/join " " args) " failed: " err out)))
    out))

(defn -main [& args]
  (let [repo (or (second (drop-while #(not= "--root" %) (vec args))) ".")
        repo (fs/file (fs/absolutize repo))
        scratch (fs/file (fs/temp-dir)
                         (str "loyly-clj-spike-" (System/currentTimeMillis)))]
    (fs/create-dirs (fs/path scratch "harness" "cycles" "02"))
    (let [instrument (fs/file scratch "instrument")
          checklist-file (fs/file scratch "checklist.json")]
      (sh! "git" "clone" "-q" "--depth" "1" (str "file://" repo) (str instrument))
      (fs/create-dirs (fs/path instrument "harness" "cycles" "02"))
      (checklist/generate {:root (str instrument) :out (str checklist-file)})
      (fs/copy checklist-file (fs/path instrument "harness" "cycles" "02" "checklist.json"))
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
                          (array-map "file" file "sha256" (d/file-sha256 (fs/path instrument file))))
                        sources)
            _ (live/verify-selected-specs (str instrument)
                                          (array-map "specs" specs)
                                          checklist)
            panel-plan (hjson/read-json
                        (slurp (fs/file instrument "harness" "pi-durable"
                                        id/DEFAULT_PANEL_PLAN)
                               :encoding "UTF-8"))
            panel-sel (panel/validate-panel-selection panel-plan checklist)
            _ (when-not (seq (:specialists panel-sel))
                (die "expected specialist checks on booking-core panel plan"))
            shard-parts (shards/partition-by-rule items 2)
            _ (when-not (= 2 (count shard-parts))
                (die "expected two grader shards for booking-core rules"))
            _ (let [src (get (first items) "source")
                    {:keys [plan-dir slice-key]} (ident/parse-plan-source src)
                    full (ident/allure-full-name
                          {:project id/PROJECT_ID :slice-key slice-key
                           :item-id (get (first items) "id")})]
                (when (or (empty? plan-dir) (empty? full))
                  (die "allure identity helpers failed")))
            _ (let [prompt (cont/continuation-prompt ["01-001" "01-002"])]
                (when-not (str/includes? prompt "@item-01-001")
                  (die "continuation prompt missing item")))
            verdicts (mapv (fn [item]
                             (if (= (get item "id") id/BLIND_ITEM_ID)
                               (array-map "id" id/BLIND_ITEM_ID
                                          "verdict" "fail"
                                          "evidence" (str policy/PENDING_SUBAGENT " (spike)"))
                               (array-map "id" (get item "id")
                                          "verdict" "pass"
                                          "evidence" (str "observed " (get item "id")))))
                           items)
            verdicts-file (fs/file scratch "verdicts.json")
            _ (hjson/spit-utf8 verdicts-file (hjson/compact-json verdicts))
            room-dir (fs/file scratch "grading-room")
            _ (do (fs/create-dirs (fs/path room-dir "work"))
                  (fs/copy checklist-file (fs/path room-dir "checklist.json"))
                  (hjson/spit-utf8 (fs/file room-dir "work" "verdicts.json")
                                   (hjson/compact-json verdicts))
                  (hjson/spit-utf8 (fs/file room-dir "work" "surprises.json") "[]")
                  (hjson/spit-utf8 (fs/file room-dir id/BLIND_REFUSAL_FILE)
                                   "pukuhuone 9 closed Monday; try Thursday 17:00\n"))
            judged (vv/validate-verdicts (str room-dir))
            _ (when-not (pos? (:pass judged))
                (die "expected some passing verdicts"))
            cand (fs/file scratch "candidate")
            _ (do (fs/create-dirs (fs/path cand "impl"))
                  (hjson/spit-utf8 (fs/file cand "impl" "start.sh") "#!/bin/sh\necho ok\n")
                  (fs/set-posix-file-permissions (fs/path cand "impl" "start.sh") "rwxr-xr-x"))
            cand-sha (room/candidate-digest (str cand))
            schema-file (fs/file repo "harness" "pi-durable"
                                 "allure-lifecycle-result.schema.json")
            _ (when-not (fs/regular-file? schema-file)
                (die (str "missing schema at " schema-file)))
            checklist-sha (d/file-sha256 checklist-file)
            schema-sha (d/file-sha256 schema-file)
            grade-out (fs/file scratch "grade-out")
            receipt-map (room/prepare-grading-room
                         {:source-room (str instrument)
                          :candidate-room (str cand)
                          :checklist-file (str (fs/absolutize checklist-file))
                          :schema-file (str (fs/absolutize schema-file))
                          :out (str (fs/absolutize grade-out))
                          :candidate-sha256 cand-sha
                          :checklist-sha256 checklist-sha
                          :schema-sha256 schema-sha})
            _ (room/verify-grading-room
               {:out (str (fs/absolutize grade-out))
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
              " shards=" (count shard-parts)
              " blind-item=" id/BLIND_ITEM_ID "\n"
              (str/trim-newline (:text board)) "\n"
              "scratch=" scratch "\n")))))
  nil)
