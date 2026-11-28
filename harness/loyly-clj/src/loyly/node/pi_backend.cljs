(ns loyly.node.pi-backend
  "Thin ClojureScript Node adapter over .cljc core and the minimal Pi durable
   @earendil-works/pi-durable TypeScript extension (harness/pi-durable/pi-extension.ts)."
  (:require [clojure.string :as str]
            [loyly.audit-rows :as audit]
            [loyly.blind-review :as blind]
            [loyly.hjson :as hjson]
            [loyly.launch-config :as launch]
            [loyly.live-contract :as live]
            [loyly.node.pi-worker :as pi-worker]
            [loyly.node.runtime :as rt]
            [loyly.platform :as plat]
            [loyly.reassess-panel :as reassess]
            [loyly.render-allure :as render-allure]
            [loyly.replay-export :as replay-export]
            [promesa.core :as p]))

(def PI-ACTIONS ["--check" "--run"])

(defn- load-contract-json [contract-path]
  (when-not (plat/regular-file? contract-path)
    (rt/die! (str "missing contract file: " contract-path)))
  (hjson/read-json (plat/read-text (plat/absolutize contract-path))))

(defn read-audit-rows-async
  "Read Pi audit rows from audit-rows.json (.cljc) or from Pi SQLite via
   harness/pi-durable/pi-extension.ts (readAuditRows)."
  [repo scratch]
  (if (plat/regular-file? (plat/path scratch "audit-rows.json"))
    (p/resolved (audit/read-audit-rows scratch))
    (p/let [mod (rt/import-esm (plat/path repo "harness" "pi-durable" "pi-extension.ts"))
            rows ((.-readAuditRows mod) (plat/absolutize scratch))]
      (js->clj rows))))

(defn check-live-run
  "Validate a pinned Pi live-run contract via shared .cljc loyly.live-contract."
  [{:keys [repo contract]}]
  (p/resolved
   (try
     (live/check-live-run
      (load-contract-json contract)
      :root repo
      :pi-durable (plat/path repo "harness" "pi-durable"))
     (println "pinned cycle contract verified")
     0
     (catch :default e
       (plat/err (str (or (ex-message e) (str e)) "\n"))
       1))))

(defn run-live-cycle
  "Validate a pinned live-run contract via .cljc, compute worker environment via
   loyly.launch-config, and run the ClojureScript Pi durable worker."
  [{:keys [repo contract]}]
  (let [pi-dir (plat/path repo "harness" "pi-durable")]
    (try
      (let [validated (live/check-live-run
                       (load-contract-json contract)
                       :root repo
                       :pi-durable pi-dir)
            _ (println "pinned cycle contract verified")
            env (launch/worker-environment validated (plat/getenv))]
        (-> (pi-worker/run-worker! {:repo repo
                                    :scratch (:scratch validated)
                                    :mode "live"
                                    :env env})
            (p/catch (fn [e]
                       (plat/err (str (or (ex-message e) (str e)) "\n"))
                       1))))
      (catch :default e
        (plat/err (str (or (ex-message e) (str e)) "\n"))
        (p/resolved 1)))))

(defn invoke-pi!
  "Dispatch Pi --check or --run asynchronously. Returns a Promise of exit code."
  [{:keys [action] :as opts}]
  (case action
    "--check" (check-live-run opts)
    "--run" (run-live-cycle opts)
    (rt/die! (str "pi actions: " (str/join "|" PI-ACTIONS)))))

(defn panel-reassess!
  "Run Pi panel-only reassessment (--check|--run) via .cljc loyly.reassess-panel
   and the minimal Pi SQLite audit reader."
  [{:keys [repo action contract]}]
  (when-not (#{"--check" "--run"} action)
    (rt/die! "panel-reassess actions: --check|--run"))
  (let [config (load-contract-json contract)
        pi-dir (plat/path repo "harness" "pi-durable")
        original (plat/absolutize (str (or (get config "original") "")))]
    (p/let [rows (read-audit-rows-async repo original)]
      (if (= action "--check")
        (let [checked (reassess/check-reassessment
                       config {:root repo :pi-durable pi-dir :audit-rows rows})]
          (println (str "frozen " (get-in checked [:score :score]) " cycle verified"))
          0)
        (let [result (reassess/run-reassessment
                      config {:root repo :pi-durable pi-dir :audit-rows rows})]
          (println (str (get result "out") ": filed " (get result "filed_score")
                        ", " (get result "allure_cases") " Allure cases, "
                        (get result "panel_outcome")))
          0)))))

(defn export-replay!
  "Export portable audit JSONL, Allure projection, and HTML replay page."
  [{:keys [repo dirs out]}]
  (let [pi-dir (plat/path repo "harness" "pi-durable")
        targets (if (seq dirs) (mapv plat/absolutize dirs) [(plat/path pi-dir "scratch")])
        output (or out (plat/path pi-dir "replay.PROTOTYPE.html"))]
    (p/let [runs (p/all
                  (mapv (fn [d]
                          (p/let [rows (read-audit-rows-async repo d)]
                            (replay-export/export-run d rows)))
                        targets))]
      (let [{:keys [output]} (replay-export/export-replay! runs output)]
        (println (str "wrote " output))
        (doseq [r runs]
          (println (str (get r "name") ": " (count (get r "rows"))
                        " committed facts sha256:" (get r "sha256"))))
        0))))

(defn render-allure!
  "Render scored cycle Allure report via .cljc loyly.render-allure."
  [{:keys [repo scratch]}]
  (let [pi-dir (plat/path repo "harness" "pi-durable")
        abs-scratch (plat/absolutize scratch)]
    (p/let [rows (read-audit-rows-async repo abs-scratch)]
      (let [res (render-allure/render-scored-allure
                 abs-scratch {:pi-durable pi-dir :audit-rows rows})]
        (println (str (:report res) "\n"
                      (get-in res [:manifest "score"]) " scored; "
                      (get-in res [:stats "total"]) " Allure cases"))
        0))))

(defn blind-review-cli!
  "Run blind-review prepare|probe|file directly via .cljc loyly.blind-review."
  [{:keys [action paths]}]
  (p/resolved
   (case action
     "prepare"
     (let [[grading-room out] paths]
       (when-not (= 2 (count paths))
         (rt/die! "usage: blind-review prepare <grading-room> <packet-dir>"))
       (println (hjson/compact-json
                 (blind/prepare-blind-review
                  {:grading-room (plat/absolutize grading-room)
                   :out (plat/absolutize out)})))
       0)

     "probe"
     (let [[packet-dir review-file grading-room request-file probe-dir] paths]
       (when-not (= 5 (count paths))
         (rt/die! "usage: blind-review probe <packet-dir> <review.json> <grading-room> <request.json> <probe-dir>"))
       (println (hjson/compact-json
                 (blind/probe-blind-answer
                  {:packet-dir (plat/absolutize packet-dir)
                   :review-file (plat/absolutize review-file)
                   :grading-room (plat/absolutize grading-room)
                   :request (hjson/read-json (plat/read-text (plat/absolutize request-file)))
                   :out (plat/absolutize probe-dir)})))
       0)

     "file"
     (let [[packet-dir review-file grading-room probe-dir allure-dir] paths]
       (when-not (= 5 (count paths))
         (rt/die! "usage: blind-review file <packet-dir> <review.json> <grading-room> <probe-dir> <blind-agent-allure-dir>"))
       (let [res (blind/write-blind-agent-allure
                  {:packet-dir (plat/absolutize packet-dir)
                   :review-file (plat/absolutize review-file)
                   :grading-room (plat/absolutize grading-room)
                   :verification-dir (plat/absolutize probe-dir)
                   :out (plat/absolutize allure-dir)})]
         (println (hjson/compact-json
                   {"status" (get-in res [:result "status"])
                    "packetSha256" (:packet-sha256 res)
                    "reviewSha256" (:review-sha256 res)}))
         0))

     (rt/die! "blind-review actions: prepare|probe|file"))))
