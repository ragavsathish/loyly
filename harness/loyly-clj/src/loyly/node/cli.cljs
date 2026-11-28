(ns loyly.node.cli
  "Unified Node ClojureScript CLI (nbb -m loyly.node.cli ...).

  Executes shared .cljc core modules directly inside Node and bridges into the
  minimal @earendil-works/pi-durable TypeScript extension when running live Pi
  durable cycles or reading Pi SQLite audit stores."
  (:require [clojure.string :as str]
            [loyly.adapters :as adapters]
            [loyly.blind-agent :as blind-agent]
            [loyly.blind-review :as blind]
            [loyly.builder-host :as bh]
            [loyly.contracts :as contracts]
            [loyly.cycle-core :as life]
            [loyly.digest :as d]
            [loyly.gen-checklist :as checklist]
            [loyly.grader-shards :as shards]
            [loyly.grading-room :as room]
            [loyly.hjson :as hjson]
            [loyly.launch-config :as launch]
            [loyly.live-contract :as live]
            [loyly.node.adapters :as node-ad]
            [loyly.node.builder-host :as node-bh]
            [loyly.node.pi-backend :as pi]
            [loyly.node.pi-worker :as pi-worker]
            [loyly.node.runtime :as rt]
            [loyly.panel-selection :as panel]
            [loyly.panel-vm :as panel-vm]
            [loyly.platform :as plat]
            [loyly.project.loyly :as loyly]
            [loyly.reassess-panel :as reassess-panel]
            [loyly.render-allure :as render-allure]
            [loyly.replay-export :as replay-export]
            [loyly.score :as score]
            [loyly.score-receipt :as receipt]
            [loyly.scoreboard :as board]
            [loyly.validate-verdicts :as vv]
            [loyly.worker-config :as worker]
            [promesa.core :as p]))

(defn- parse-opts [args]
  (loop [args (vec args) acc {:args []}]
    (if-let [a (first args)]
      (cond
        (= a "--root") (recur (nnext args) (assoc acc :root (second args)))
        (= a "--out") (recur (nnext args) (assoc acc :out (second args)))
        (#{"-h" "--help" "help"} a) (assoc acc :help true)
        :else (recur (next args) (update acc :args conj a)))
      acc)))

(defn- print-help []
  (plat/err
   (str "usage:\n"
        "  loyly-clj node cycle list\n"
        "  loyly-clj node cycle pi --check|--run <live-run.json>\n"
        "  loyly-clj node cycle cursor|codex preflight|candidate|decide|evidence|panel <input.json>\n"
        "  loyly-clj node cycle codex reassess <contract.json>\n"
        "  loyly-clj node panel-reassess --check|--run <reassess.json>\n"
        "  loyly-clj node worker <scratch> [mode]\n"
        "  loyly-clj node builder-host <room> <instruction> <store> <request-id> <pi-settings>\n"
        "  loyly-clj node export-replay [scratch...] [--out <html-path>]\n"
        "  loyly-clj node render-allure <scored-cycle-scratch>\n"
        "  loyly-clj node blind-review prepare|probe|file <paths...>\n"
        "  loyly-clj node smoke [--root <repo>]\n")))

(defn- run-smoke!
  "End-to-end Node (.cljc + .cljs) smoke verification."
  [root]
  (let [repo (rt/resolve-repo root)
        scratch (plat/path (plat/temp-dir) (str "loyly-clj-node-" (plat/now-ms)))
        instrument (plat/path scratch "instrument")
        checklist-file (plat/path scratch "checklist.json")]
    (plat/create-dirs (plat/path scratch "harness" "cycles" "02"))
    (p/let [clone (rt/spawn-async ["git" "clone" "-q" "--depth" "1"
                                   (str "file://" repo) instrument])]
      (when-not (zero? (:exit clone))
        (rt/die! (str "git clone failed: " (:err clone))))
      (plat/create-dirs (plat/path instrument "harness" "cycles" "02"))
      (checklist/generate {:root instrument :out checklist-file})
      (plat/copy checklist-file (plat/path instrument "harness" "cycles" "02" "checklist.json"))
      (let [cl (hjson/read-json (plat/read-text checklist-file))
            items (get cl "items")
            _ (when-not (and (contracts/selected-checklist? cl)
                             (loyly/requires-blind-handoff loyly/PROJECT_ID items))
                (rt/die! "checklist / blind-handoff check failed in Node"))
            parsed (loyly/parse-blind-agent-answer
                    "REQUEST: pukuhuone 9 | Thursday | 17:00"
                    "pukuhuone 9 is closed Monday; try Thursday 17:00 instead.")
            _ (when-not (= "pass" (:verdict parsed))
                (rt/die! "blind answer parse failed in Node"))
            _ (blind/validate-blind-response-shape
               (array-map "schema" loyly/BLIND_RESPONSE
                          "packet_sha256" (apply str (repeat 64 "c"))
                          "reviewer_kind" "agent"
                          "reviewer" "node-agent"
                          "had_not_read_configuration" true
                          "saw_only_refusal" true
                          "answer" "REQUEST: pukuhuone 9 | Thursday | 17:00"
                          "verdict" "pass"
                          "reason" "named from refusal"
                          "reviewed_at" 1)
               (apply str (repeat 64 "c")))
            pi-durable (plat/path instrument "harness" "pi-durable")
            panel-plan (hjson/read-json (plat/read-text (plat/path pi-durable loyly/DEFAULT_PANEL_PLAN)))
            panel-sel (panel/validate-panel-selection panel-plan cl)
            workers (panel-vm/specialist-workers panel-plan pi-durable)
            _ (when-not (and (= 3 (count workers)) (seq (:specialists panel-sel)))
                (rt/die! "panel selection / workers check failed in Node"))
            shards-out (shards/partition-by-rule items 2)
            _ (when-not (= 2 (count shards-out))
                (rt/die! "grader shard partition failed in Node"))
            verdicts (mapv (fn [item]
                             (if (= (get item "id") loyly/BLIND_ITEM_ID)
                               (array-map "id" loyly/BLIND_ITEM_ID
                                          "verdict" "fail"
                                          "evidence" (str loyly/PENDING_SUBAGENT " (node)"))
                               (array-map "id" (get item "id")
                                          "verdict" "pass"
                                          "evidence" (str "observed " (get item "id")))))
                           items)
            verdicts-file (plat/path scratch "verdicts.json")
            _ (hjson/spit-utf8 verdicts-file (hjson/compact-json verdicts))
            room-dir (plat/path scratch "grading-room")
            _ (do (plat/create-dirs (plat/path room-dir "work"))
                  (plat/copy checklist-file (plat/path room-dir "checklist.json"))
                  (hjson/spit-utf8 (plat/path room-dir "work" "verdicts.json")
                                   (hjson/compact-json verdicts))
                  (hjson/spit-utf8 (plat/path room-dir "work" "surprises.json") "[]")
                  (hjson/spit-utf8 (plat/path room-dir loyly/BLIND_REFUSAL_FILE)
                                   "pukuhuone 9 closed Monday; try Thursday 17:00\n"))
            judged (vv/validate-verdicts room-dir)
            cand (plat/path scratch "candidate")
            _ (do (plat/create-dirs (plat/path cand "impl"))
                  (hjson/spit-utf8 (plat/path cand "impl" "start.sh") "#!/bin/sh\necho ok\n")
                  (plat/set-executable! (plat/path cand "impl" "start.sh")))
            cand-sha (room/candidate-digest cand)
            schema-file (plat/path repo "harness" "pi-durable" "allure-lifecycle-result.schema.json")
            checklist-sha (d/file-sha256 checklist-file)
            schema-sha (d/file-sha256 schema-file)
            grade-out (plat/path scratch "grade-out")
            _ (room/prepare-grading-room
               {:source-room instrument :candidate-room cand
                :checklist-file checklist-file :schema-file schema-file
                :out grade-out :candidate-sha256 cand-sha
                :checklist-sha256 checklist-sha :schema-sha256 schema-sha})
            _ (room/verify-grading-room
               {:out grade-out :candidate-sha256 cand-sha
                :checklist-sha256 checklist-sha :schema-sha256 schema-sha})
            blind-pkt (plat/path scratch "blind-pkt")
            _ (do (plat/create-dirs blind-pkt)
                  (hjson/spit-utf8 (plat/path blind-pkt "question.txt") "q\n")
                  (hjson/spit-utf8 (plat/path blind-pkt "refusal.txt") "r\n"))
            blind-room-res (blind-agent/prepare-blind-agent-room
                            {:packet-dir blind-pkt :out (plat/path scratch "blind-room")})
            _ (when-not (= 64 (count (:room-sha256 blind-room-res)))
                (rt/die! "blind-agent room preparation failed in Node"))
            _ (score/score-cycle {:root instrument :cycle "02" :verdicts-path verdicts-file})
            _ (receipt/bind-score-input
               {:scratch scratch :source-root repo :instrument instrument
                :candidate-sha256 cand-sha :verdicts-file verdicts-file :score-cycle "02"})
            verified (receipt/verify-scored-cycle
                      {:scratch scratch :instrument instrument
                       :verdicts-file verdicts-file :cycle "02"})
            board-out (board/report {:root instrument :cycle "02"})
            decide-in (plat/path scratch "decide.json")
            _ (hjson/spit-utf8 decide-in
                               (hjson/compact-json
                                {"attempt" 1
                                 "build" {"status" "completed"}
                                 "gate" {"status" "completed" "result" {"passed" true}}}))
            decided (adapters/dispatch :codex "decide" decide-in repo)
            _ (when-not (= "grading-room" (get-in decided ["afterGate" "phase"]))
                (rt/die! (str "cljc adapters/dispatch decide failed in Node: " (pr-str decided))))
            wcfg (worker/parse-worker-config repo scratch "repair" {})
            ci (pi-worker/build-cycle-input wcfg "smoke-1" "02" {})
            _ (when-not (= "smoke-1" (:runId ci))
                (rt/die! "pi-worker build-cycle-input failed in Node"))
            audit-file (plat/path scratch "audit-rows.json")
            _ (hjson/spit-utf8 audit-file (hjson/compact-json [{"seq" 1 "stage" "score" "outcome" "filed"}]))
            exported (replay-export/export-run scratch [{"seq" 1 "stage" "score" "outcome" "filed"}])
            html (replay-export/render-replay-html [exported])
            _ (when-not (and (str/includes? html "Pi durable cycle audit")
                             (= 300 (bh/clamp-bash-timeout nil 300 300))
                             (= 300 (bh/clamp-bash-timeout 30 300 300))
                             (= 300 (bh/clamp-bash-timeout 1800 300 300))
                             (= 1800 (bh/clamp-bash-timeout 30 1800 nil))
                             (nil? (bh/clamp-bash-timeout nil 1800 nil))
                             (str/includes? (bh/environment-text {:tools ["read" "bash"] :timeout-floor 300 :timeout-ceiling 300})
                                            "5 minutes timeout")
                             (fn? (node-ad/make-http-fetch-fn))
                             (fn? (node-ad/make-allure-cli-fn repo))
                             (fn? (node-ad/make-spawn-hook))
                             (fn? pi/read-audit-rows-async)
                             (fn? live/check-live-run)
                             (fn? launch/worker-environment)
                             (fn? reassess-panel/check-reassessment)
                             (fn? render-allure/render-scored-allure)
                             (fn? adapters/check-codex-contract)
                             (fn? adapters/check-cursor-contract)
                             (fn? adapters/check-codex-reassessment)
                             (= 3 (count (:drivers (node-ad/catalog))))
                             (map? (life/create-lifecycle)))
                (rt/die! "Node hook / API verification failed"))]
        (p/let [audit-rows (pi/read-audit-rows-async repo scratch)]
          (when-not (= 1 (count audit-rows))
            (rt/die! "read-audit-rows-async failed"))
          (plat/delete-tree scratch)
          (println (str "loyly-clj Node (.cljc + .cljs) smoke OK: "
                        (:score verified)
                        " pass=" (:pass judged)
                        " specialists=" (count workers)
                        " shards=" (count shards-out)
                        " decide=" (get-in decided ["afterGate" "phase"])
                        " lines=" (count (str/split-lines (:text board-out)))))
          0)))))

(defn -main [& argv]
  (let [{:keys [args root out help]} (parse-opts argv)]
    (when (or help (empty? args))
      (print-help)
      (plat/exit! (if help 0 2)))
    (let [[cmd & more] args
          repo (when-not (= cmd "blind-review") (rt/resolve-repo root))]
      (-> (case cmd
            "smoke" (run-smoke! root)

            "worker"
            (let [[scratch mode] more]
              (pi-worker/run-worker! {:repo repo :scratch scratch :mode mode}))

            "builder-host"
            (node-bh/run-builder-host! {:repo repo :argv more})

            "panel-reassess"
            (let [[action contract] more]
              (when-not (and action contract)
                (rt/die! "usage: panel-reassess --check|--run <reassess.json>"))
              (pi/panel-reassess! {:repo repo :action action :contract contract}))

            "export-replay"
            (pi/export-replay! {:repo repo :dirs more :out out})

            "render-allure"
            (let [[scratch] more]
              (when-not scratch
                (rt/die! "usage: render-allure <scored-cycle-scratch>"))
              (pi/render-allure! {:repo repo :scratch scratch}))

            "blind-review"
            (let [[action & paths] more]
              (when-not action
                (rt/die! "usage: blind-review prepare|probe|file <paths...>"))
              (pi/blind-review-cli! {:action action :paths paths}))

            "cycle"
            (let [[driver & rest-args] more]
              (cond
                (= driver "list")
                (p/do
                  (println (hjson/compact-json (node-ad/catalog)))
                  0)

                (and (#{"pi" "codex" "cursor"} driver) (seq rest-args))
                (node-ad/invoke-driver! {:driver driver
                                         :action (first rest-args)
                                         :args (vec (rest rest-args))
                                         :root root})

                :else
                (do (print-help) (p/resolved 2))))
            (do (print-help) (p/resolved 2)))
          (p/then (fn [code] (plat/exit! (or code 0))))
          (p/catch (fn [e]
                     (plat/err (str (or (ex-message e) (str e)) "\n"))
                     (plat/exit! 1)))))))
