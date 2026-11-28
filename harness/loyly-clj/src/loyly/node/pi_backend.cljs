(ns loyly.node.pi-backend
  "ClojureScript async wrapper over the Pi durable Node backend (.cljs).

  Validates pinned live-run contracts and constructs worker environments via
  shared .cljc modules (loyly.live-contract, loyly.launch-config), then runs
  Node async workers (worker.mjs, run-live.mjs, reassess-panel.mjs, audit-rows)."
  (:require [clojure.string :as str]
            [loyly.audit-rows :as audit]
            [loyly.hjson :as hjson]
            [loyly.launch-config :as launch]
            [loyly.live-contract :as live]
            [loyly.node.runtime :as rt]
            [loyly.platform :as plat]
            [promesa.core :as p]))

(def PI-ACTIONS ["--check" "--run"])

(defn- load-contract-json [contract-path]
  (when-not (plat/regular-file? contract-path)
    (rt/die! (str "missing contract file: " contract-path)))
  (hjson/read-json (plat/read-text (plat/absolutize contract-path))))

(defn check-live-run
  "Validate a pinned Pi live-run contract.
   Uses shared .cljc loyly.live-contract/check-live-run by default; pass :ts? true
   to delegate to Node harness/pi-durable/run-live.mjs --check."
  [{:keys [repo contract node ts?]}]
  (if ts?
    (let [script (rt/script-path repo "harness/pi-durable/run-live.mjs")
          cwd (plat/path repo "harness" "pi-durable")]
      (rt/spawn-node-inherit {:node node
                              :cwd cwd
                              :args [script "--check" (plat/absolutize contract)]}))
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
         1)))))

(defn run-live-cycle
  "Validate a pinned live-run contract via .cljc and spawn Pi durable worker.mjs
   asynchronously with the computed worker environment. Pass :ts? true to spawn
   run-live.mjs --run directly."
  [{:keys [repo contract node ts?]}]
  (let [pi-dir (plat/path repo "harness" "pi-durable")]
    (if ts?
      (let [script (rt/script-path repo "harness/pi-durable/run-live.mjs")]
        (rt/spawn-node-inherit {:node node
                                :cwd pi-dir
                                :args [script "--run" (plat/absolutize contract)]}))
      (try
        (let [validated (live/check-live-run
                         (load-contract-json contract)
                         :root repo
                         :pi-durable pi-dir)
              _ (println "pinned cycle contract verified")
              worker-script (rt/script-path repo "harness/pi-durable/worker.mjs")
              env (launch/worker-environment validated (plat/getenv))]
          (rt/spawn-node-inherit {:node node
                                  :cwd pi-dir
                                  :env env
                                  :args [worker-script (:scratch validated) "live"]}))
        (catch :default e
          (plat/err (str (or (ex-message e) (str e)) "\n"))
          (p/resolved 1))))))

(defn invoke-pi!
  "Dispatch Pi --check or --run asynchronously. Returns a Promise of exit code."
  [{:keys [action] :as opts}]
  (case action
    "--check" (check-live-run opts)
    "--run" (run-live-cycle opts)
    (rt/die! (str "pi actions: " (str/join "|" PI-ACTIONS)))))

(defn panel-reassess!
  "Run Pi panel-only reassessment (--check|--run) via reassess-panel.mjs asynchronously."
  [{:keys [repo action contract node]}]
  (when-not (#{"--check" "--run"} action)
    (rt/die! "panel-reassess actions: --check|--run"))
  (when-not (plat/regular-file? contract)
    (rt/die! (str "missing panel reassessment contract: " contract)))
  (let [script (rt/script-path repo "harness/pi-durable/reassess-panel.mjs")
        cwd (plat/path repo "harness" "pi-durable")]
    (rt/spawn-node-inherit {:node node
                            :cwd cwd
                            :args [script action (plat/absolutize contract)]})))

(defn read-audit-rows-async
  "Read Pi audit rows from audit-rows.json (.cljc) or dynamically from Pi sqlite
   via harness/pi-durable/audit-rows.mjs."
  [repo scratch]
  (if (plat/regular-file? (plat/path scratch "audit-rows.json"))
    (p/resolved (audit/read-audit-rows scratch))
    (p/let [mod (rt/import-esm (plat/path repo "harness" "pi-durable" "audit-rows.mjs"))
            rows ((.-readAuditRows mod) (plat/absolutize scratch))]
      (js->clj rows))))
