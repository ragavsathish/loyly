(ns loyly.demo
  "Smoke loyly-clj (.cljc + formal): measure + loyly + receipt + verdicts + grading-room digests."
  (:require [babashka.fs :as fs]
            [babashka.process :as p]
            [clojure.string :as str]
            [loyly.allure-results :as allure]
            [loyly.blind-review :as blind]
            [loyly.builder-adapter :as builder]
            [loyly.continuation :as cont]
            [loyly.contracts :as contracts]
            [loyly.cycle-core :as life]
            [loyly.cycle-effects :as effects]
            [loyly.digest :as d]
            [loyly.drivers :as drivers]
            [loyly.evidence.validate-identity :as ident]
            [loyly.formal.models :as formal]
            [loyly.formal.trace :as ftrace]
            [loyly.gate-adapter :as gate]
            [loyly.gen-checklist :as checklist]
            [loyly.grader-shards :as shards]
            [loyly.grading-room :as room]
            [loyly.hjson :as hjson]
            [loyly.launch-config :as launch]
            [loyly.live-contract :as live]
            [loyly.panel-adapter :as panel-ad]
            [loyly.panel-compile :as compile]
            [loyly.panel-policy :as panel-pol]
            [loyly.panel-selection :as panel]
            [loyly.panel-vm :as panel-vm]
            [loyly.project.loyly :as loyly]
            [loyly.receipt-fields :as fields]
            [loyly.replay-evidence :as replay]
            [loyly.score :as score]
            [loyly.score-receipt :as receipt]
            [loyly.scoreboard :as board]
            [loyly.validate-verdicts :as vv]
            [loyly.worker-config :as worker]))

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
                         (str "loyly-clj-" (System/currentTimeMillis)))]
    (fs/create-dirs (fs/path scratch "harness" "cycles" "02"))
    (let [instrument (fs/file scratch "instrument")
          checklist-file (fs/file scratch "checklist.json")]
      (sh! "git" "clone" "-q" "--depth" "1" (str "file://" repo) (str instrument))
      (fs/create-dirs (fs/path instrument "harness" "cycles" "02"))
      (checklist/generate {:root (str instrument) :out (str checklist-file)})
      (fs/copy checklist-file (fs/path instrument "harness" "cycles" "02" "checklist.json"))
      (let [checklist (hjson/read-json (slurp checklist-file :encoding "UTF-8"))
            items (get checklist "items")
            _ (when-not (loyly/requires-blind-handoff loyly/PROJECT_ID items)
                (die "expected booking-core checklist to require blind handoff"))
            _ (let [parsed (loyly/parse-blind-agent-answer
                            "REQUEST: pukuhuone 9 | Thursday | 17:00"
                            "pukuhuone 9 is closed Monday; try Thursday 17:00 instead.")]
                (when-not (= "pass" (:verdict parsed))
                  (die "blind answer parse failed")))
            _ (blind/validate-blind-response-shape
               (array-map "schema" loyly/BLIND_RESPONSE
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
                                        loyly/DEFAULT_PANEL_PLAN)
                               :encoding "UTF-8"))
            panel-sel (panel/validate-panel-selection panel-plan checklist)
            pi-durable (fs/file instrument "harness" "pi-durable")
            workers (panel-vm/specialist-workers panel-plan pi-durable)
            _ (when-not (= 3 (count workers))
                (die "expected three legacy specialist workers"))
            _ (when-not (seq (:specialists panel-sel))
                (die "expected specialist checks on booking-core panel plan"))
            _ (when-not (contracts/selected-checklist? checklist)
                (die "contracts selected-checklist? rejected booking-core"))
            _ (let [cert (ftrace/certificate (str repo))]
                (when-not (and (:registry-digest cert)
                               (get-in cert [:panel :ok]))
                  (die "formal certificate failed"))
                (formal/assert! :sha256 (:registry-digest cert)))
            _ (let [cat (drivers/catalog)]
                (when-not (= 3 (count (:drivers cat)))
                  (die "drivers catalog drifted (expected pi/codex/cursor)"))
                (doseq [d (:drivers cat)]
                  (when-let [ext (:extension d)]
                    (when-not (fs/regular-file? (fs/path repo ext))
                      (die (str "driver extension missing: " ext))))))
            _ (when-not (fn? allure/read-allure-results)
                (die "allure-results read-allure-results missing"))
            ;; Gate / builder receipt helpers against scratch fixtures.
            _ (let [gate-out (fs/file scratch "gate-out")
                    cand-sha (apply str (repeat 64 "a"))
                    room-path (str (fs/absolutize instrument))]
                (fs/create-dirs gate-out)
                (hjson/spit-utf8 (fs/file gate-out "gate.log") "gate ok\n")
                (let [log-sha (d/file-sha256 (fs/file gate-out "gate.log"))]
                  (hjson/spit-utf8 (fs/file gate-out "receipt.txt")
                                   (str "room=" room-path "\n"
                                        "candidate_sha256=" cand-sha "\n"
                                        "exit=0\n"
                                        "log_sha256=" log-sha "\n"))
                  (when-not (= 0 (:exit (gate/read-gate-receipt
                                         (str (fs/absolutize gate-out))
                                         room-path cand-sha)))
                    (die "gate receipt parse failed")))
                (let [ev (fs/file scratch "builder-evidence" "launch-1")
                      instr (fs/file scratch "builder-instr.txt")
                      img (fs/file scratch "builder-image")
                      instr-abs (str (fs/absolutize instr))
                      img-abs (str (fs/absolutize img))]
                  (fs/create-dirs ev)
                  (hjson/spit-utf8 instr "build\n")
                  (fs/create-dirs img)
                  (hjson/spit-utf8 (fs/file img "manifest.json")
                                   (hjson/compact-json {"assets" {} "checksums" {}}))
                  (hjson/spit-utf8 (fs/file ev "launch.txt")
                                   (str "session_id=s1\nrequest_id=s1\n"
                                        "instruction_sha256=" (apply str (repeat 64 "b")) "\n"
                                        "model=test\nroom=" room-path "\n"
                                        "builder_image=" img-abs "\n"))
                  (when-not (builder/has-builder-launch?
                             (str (fs/absolutize (fs/parent ev))) "s1" "s1")
                    (die "builder launch lookup failed"))
                  (when-not (= "s1" (get (fields/parse-fields (fs/file ev "launch.txt"))
                                         "session_id"))
                    (die "receipt fields parse failed"))
                  (let [reconciled
                        (builder/reconcile-builder-launch
                         {:command instr-abs
                          :room room-path
                          :instruction instr-abs
                          :image img-abs
                          :evidence-dir (str (fs/absolutize (fs/parent ev)))
                          :state-root (str (fs/absolutize scratch))
                          :session-id "s1"
                          :request-id "s1"
                          :instruction-sha256 (apply str (repeat 64 "b"))
                          :model "test"
                          :readonly-inputs false})]
                    (when-not (:reconciled reconciled)
                      (die "reconcile-builder-launch failed")))))
            _ (let [cfg (worker/parse-worker-config
                         (str repo) (str scratch) "repair" {})
                    env (launch/worker-environment
                         {:config (array-map
                                   "schema" "loyly.pi-live-run.v1"
                                   "run_id" "spike"
                                   "score_cycle" "02"
                                   "source" (array-map "commit" (apply str (repeat 40 "0"))
                                                       "checklist_sha256" (apply str (repeat 64 "c")))
                                   "builder" (array-map "command" "/c" "command_sha256" (apply str (repeat 64 "1"))
                                                        "image" "/i" "image_sha256" (apply str (repeat 64 "2"))
                                                        "model" "m" "instruction_sha256" (apply str (repeat 64 "3")))
                                   "grader" (array-map "command" "/c" "command_sha256" (apply str (repeat 64 "1"))
                                                       "image" "/i" "image_sha256" (apply str (repeat 64 "2"))
                                                       "model" "g" "settings" "/s"
                                                       "settings_sha256" (apply str (repeat 64 "4"))
                                                       "instruction_sha256" (apply str (repeat 64 "5"))
                                                       "schema_sha256" (apply str (repeat 64 "6"))
                                                       "shards" 3))
                          :source "/src"}
                         {"PATH" "/bin" "LOYLY_IGNORED" "x"})]
                (when-not (and (= "repair" (:mode cfg)) (false? (:live cfg)))
                  (die "worker-config repair mode failed"))
                (when (or (not= "spike" (get env "LOYLY_RUN_ID"))
                          (contains? env "LOYLY_IGNORED"))
                  (die "launch-config env mapping failed")))
            shard-parts (shards/partition-by-rule items 2)
            _ (when-not (= 2 (count shard-parts))
                (die "expected two grader shards for booking-core rules"))
            _ (let [src (get (first items) "source")
                    {:keys [plan-dir slice-key]} (ident/parse-plan-source src)
                    full (ident/allure-full-name
                          {:project loyly/PROJECT_ID :slice-key slice-key
                           :item-id (get (first items) "id")})]
                (when (or (empty? plan-dir) (empty? full))
                  (die "allure identity helpers failed")))
            _ (let [prompt (cont/continuation-prompt ["01-001" "01-002"])]
                (when-not (str/includes? prompt "@item-01-001")
                  (die "continuation prompt missing item")))
            _ (when-not (= 3 cont/MAX_CONTINUATIONS)
                (die "continuation MAX_CONTINUATIONS drifted"))
            _ (let [uncarried (cont/selected-uncarried (str instrument) (str checklist-file))]
                (when-not (vector? uncarried)
                  (die "selected-uncarried should return a vector")))
            _ (let [runtime (compile/specialist-runtime
                             {"id" "protocol"}
                             {"vm_exit_code" 0}
                             {"schema" loyly/PANEL_VM_RUN})]
                (when-not (= "gondolin-qemu-vm" runtime)
                  (die "panel-compile specialist-runtime failed")))
            _ (let [summary (compile/build-panel-summary-shape
                             {:candidate-sha256 (apply str (repeat 64 "a"))
                              :plan-sha256 (apply str (repeat 64 "b"))
                              :original-score-sha256 (apply str (repeat 64 "c"))
                              :evaluation {:panel-outcome "ready-for-review"
                                           :gaps [] :checks [] :items []}})
                    manifest (array-map
                              "schema" loyly/PANEL_VM_RUN
                              "source_commit" (apply str (repeat 40 "0"))
                              "candidate_sha256" (apply str (repeat 64 "a"))
                              "allure_schema_sha256" (apply str (repeat 64 "s"))
                              "score_state" "pre-score"
                              "plan_sha256" (apply str (repeat 64 "b"))
                              "parallel_overlap_ms" 7
                              "producers" [{"started" 1 "stopped" 10}
                                           {"started" 2 "stopped" 9}])
                    _ (compile/verify-specialist-bindings
                       {:plan panel-plan
                        :plan-sha256 (apply str (repeat 64 "b"))
                        :manifest manifest
                        :candidate-sha256 (apply str (repeat 64 "a"))
                        :schema-sha256 (apply str (repeat 64 "s"))
                        :score-sha256 nil
                        :source-commit (apply str (repeat 40 "0"))
                        :specs [1 2]}
                       [])]
                (when-not (= loyly/PANEL_SUMMARY (get summary "schema"))
                  (die "panel-compile summary shape failed")))
            _ (let [html (str "<form method=\"post\" action=\"/book\">"
                              "<input name=\"household\"/>"
                              "<select name=\"resource\">"
                              "<option value=\"r9\">pukuhuone 9</option>"
                              "</select>"
                              "<input name=\"weekday\"/><input name=\"start\"/>"
                              "</form>")
                    action (loyly/booking-form-action html)
                    resolved (loyly/resolve-room-in-public-form
                              html "household=12&resource=%40room%3A9&weekday=Thursday&start=17%3A00"
                              "REQUEST: pukuhuone 9 | Thursday | 17:00")]
                (when-not (= "/book" action)
                  (die "blind-probe booking-form-action failed"))
                (when-not (str/includes? resolved "resource=r9")
                  (die "blind-probe resolve-room failed")))
            _ (let [fx (effects/create-cycle-effects
                        {:root (str repo) :scratch (str scratch)
                         :room (str instrument) :cut (str (fs/path scratch "cut"))
                         :source-root (str instrument)
                         :approved-source-repo (str repo)
                         :digest-candidate #(room/candidate-digest %)})
                    logged ((:measure-log fx) "spike-measure"
                            (fn [] {:stdout "ok\n"}))]
                (when-not (and (zero? (:code logged))
                               (= (effects/hash-value "ok\n") (:sha256 logged)))
                  (die "cycle-effects measure-log failed")))
            _ (let [panel-root (fs/file scratch "panel-attempts")
                    selected
                    (panel-ad/select-panel-attempt
                     {:root (str panel-root)
                      :launch (fn [out]
                                (fs/create-dirs out)
                                (hjson/spit-utf8 (fs/file out "manifest.json") "{}\n")
                                {:ok true})
                      :verify (fn [_] {:ok true})})]
                (when-not (and (= 1 (:attempt selected)) (false? (:reconciled selected)))
                  (die "panel-adapter select-panel-attempt failed")))
            _ (let [ev (replay/summary
                        {"name" "n" "status" "passed" "stage" "finished"
                         "statusDetails" {"message" "ok"} "steps" [] "attachments" []}
                        "01-001" 1 "grade" (apply str (repeat 64 "d"))
                        (str scratch))]
                (when-not (= "loyly.replay-evidence.v1" (get ev "schema"))
                  (die "replay-evidence summary failed")))
            _ (when-not (nil? (replay/project-grade-row
                               [{"stage" "grade" "outcome" "failed"}]))
                (die "project-grade-row should skip incomplete grade rows"))
            _ (when-not (= "score" (nth life/PHASES 6))
                (die "cycle-core PHASES map drifted"))
            _ (when-not (pos? (count life/ALL-PHASES))
                (die "cycle-core ALL-PHASES missing"))
            _ (when-not (fn? replay/project-replay-evidence)
                (die "project-replay-evidence missing"))
            _ (when-not (fn? live/check-live-run)
                (die "check-live-run missing"))
            _ (when-not (fn? live/verify-pinned-agents)
                (die "verify-pinned-agents missing"))
            _ (when-not (fn? gate/live-pid?)
                (die "gate live-pid? missing"))
            _ (when-not (fn? gate/run-gate)
                (die "gate run-gate missing"))
            _ (when-not (fn? builder/run-builder)
                (die "builder run-builder missing"))
            _ (when-not (fn? builder/live-pid?)
                (die "builder live-pid? missing"))
            _ (when-not (fn? panel-ad/run-durable-panel)
                (die "run-durable-panel missing"))
            _ (when-not (fn? panel-ad/run-durable-panel-report)
                (die "run-durable-panel-report missing"))
            _ (when-not (fn? shards/combine-shards)
                (die "combine-shards missing"))
            _ (when-not (fn? loyly/match-public-json-booking)
                (die "match-public-json-booking missing"))
            _ (when-not (fn? blind/prepare-blind-review)
                (die "prepare-blind-review missing"))
            _ (when-not (fn? blind/probe-blind-answer)
                (die "probe-blind-answer missing"))
            _ (when-not (fn? blind/write-blind-agent-allure)
                (die "write-blind-agent-allure missing"))
            _ (when-not (fn? blind/final-verdicts-from-blind-review)
                (die "final-verdicts-from-blind-review missing"))
            _ (let [fx (effects/create-cycle-effects
                        {:root (str repo) :scratch (str scratch)
                         :room (str instrument) :cut (str (fs/path scratch "cut2"))
                         :source-root (str instrument)
                         :approved-source-repo (str repo)
                         :digest-candidate #(room/candidate-digest %)})]
                (when-not ((:prove-cut fx))
                  (die "prove-cut with no commit should return true")))
            _ (when-not (fn? panel-pol/evaluate-panel)
                (die "panel-policy evaluate-panel missing"))
            _ (let [parsed (blind/parse-review-answer
                            {"answer" "REQUEST: pukuhuone 9 | Thursday | 17:00"}
                            "pukuhuone 9 is closed Monday; try Thursday 17:00 instead.")]
                (when-not (= "pass" (:verdict parsed))
                  (die "blind parse-review-answer failed")))
            _ (let [packet-dir (fs/file scratch "blind-packet")
                    refusal "pukuhuone 9 closed Monday; try Thursday 17:00\n"
                    spec-sha (apply str (repeat 64 "e"))
                    _ (fs/create-dirs packet-dir)
                    _ (hjson/spit-utf8 (fs/file packet-dir "refusal.txt") refusal)
                    _ (hjson/spit-utf8 (fs/file packet-dir "question.txt") loyly/BLIND_QUESTION)
                    _ (hjson/spit-utf8
                       (fs/file packet-dir "packet.json")
                       (hjson/compact-json
                        (array-map "schema" loyly/BLIND_PACKET
                                   "item" loyly/BLIND_ITEM_ID
                                   "candidate_sha256" (apply str (repeat 64 "a"))
                                   "checklist_sha256" (apply str (repeat 64 "b"))
                                   "spec_sha256" spec-sha
                                   "allure_results_sha256" (apply str (repeat 64 "d"))
                                   "refusal_sha256" (d/sha256-string refusal))))
                    verified (blind/verify-packet-files (str packet-dir))]
                (when-not (re-matches #"[0-9a-f]{64}" (:packet-sha256 verified))
                  (die "verify-packet-files failed")))
            verdicts (mapv (fn [item]
                             (if (= (get item "id") loyly/BLIND_ITEM_ID)
                               (array-map "id" loyly/BLIND_ITEM_ID
                                          "verdict" "fail"
                                          "evidence" (str loyly/PENDING_SUBAGENT " (spike)"))
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
                  (hjson/spit-utf8 (fs/file room-dir loyly/BLIND_REFUSAL_FILE)
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
            board (board/report {:root (str instrument) :cycle "02"})
            _ (let [ctx (panel-vm/panel-score-context (str scratch))]
                (when-not (map? (:binding ctx))
                  (die "panel-score-context binding missing")))
            _ (let [shards (shards/prepare-shards
                            {:grading-room (str (fs/absolutize grade-out))
                             :source-room (str instrument)
                             :scratch (str scratch)
                             :schema-file (str (fs/absolutize schema-file))
                             :candidate-sha256 cand-sha
                             :schema-sha256 schema-sha
                             :shard-count 2})]
                (when-not (= 2 (count shards))
                  (die "prepare-shards expected two shards")))
            _ (let [plan-path (fs/file pi-durable loyly/DEFAULT_PANEL_PLAN)
                    plan-sha (d/file-sha256 plan-path)
                    here (fs/file scratch "panel-plans")
                    _ (fs/create-dirs here)
                    _ (fs/copy plan-path (fs/path here loyly/DEFAULT_PANEL_PLAN))
                    found (replay/panel-plan-for-manifest
                           (str here) {"plan_sha256" plan-sha})]
                (when-not (.endsWith ^String found loyly/DEFAULT_PANEL_PLAN)
                  (die "panel-plan-for-manifest failed")))
            _ (let [img (fs/file scratch "pinned-image")
                    _ (fs/create-dirs img)
                    manifest {"assets" {"rootfs" "rootfs.tar"}
                              "checksums" {"rootfs" (d/sha256-string "root")}}
                    _ (hjson/spit-utf8 (fs/file img "manifest.json")
                                       (hjson/compact-json manifest))
                    _ (hjson/spit-utf8 (fs/file img "rootfs.tar") "root")
                    man-sha (d/file-sha256 (fs/file img "manifest.json"))]
                (live/verify-pinned-image (str img) man-sha))
            _ (let [approved (live/derive-approved-checklist
                              {:config (array-map
                                        "schema" "loyly.pi-live-run.v1"
                                        "source" (array-map
                                                  "checklist_sha256" checklist-sha
                                                  "specs" specs))
                               :source (str instrument)
                               :scratch (str (fs/file scratch "approved"))})]
                (when-not (pos? (count (get approved "items")))
                  (die "derive-approved-checklist failed")))]
        (hjson/out
         (str "loyly-clj demo OK: " (:score verified)
              " pass=" (:pass judged)
              " plans=" (count (get receipt-map "sourcePlans"))
              " panel-specialists=" (count workers)
              " shards=" (count shard-parts)
              " blind-item=" loyly/BLIND_ITEM_ID "\n"
              (str/trim-newline (:text board)) "\n"
              "scratch=" scratch "\n")))))
  nil)
