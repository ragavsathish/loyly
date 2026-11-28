(ns loyly.node.adapters
  "Thin ClojureScript Node adapter dispatcher and async hook factories (.cljs).

  Routes ALL Codex/Cursor actions (preflight, candidate, decide, evidence,
  panel, reassess) directly through shared .cljc loyly.adapters, and routes
  Pi durable actions through loyly.node.pi-backend."
  (:require [loyly.adapters :as adapters]
            [loyly.hjson :as hjson]
            [loyly.node.pi-backend :as pi]
            [loyly.node.runtime :as rt]
            [loyly.platform :as plat]
            [promesa.core :as p]))

(def ADAPTER-ACTIONS
  ["preflight" "candidate" "decide" "evidence" "panel"])

(defn catalog
  "Closed description of the three production cycle drivers."
  []
  {:schema "loyly.cycle-drivers.v1"
   :backend "loyly-clj"
   :runtime "cljc+cljs-node"
   :drivers
   [{:id "pi"
     :kind "durable-live"
     :backend "loyly-clj"
     :extension "harness/pi-durable/pi-extension.ts"
     :cljc-actions ["--check"]
     :cljs-node-actions ["--run" "panel-reassess" "worker" "builder-host" "export-replay" "render-allure" "blind-review"]
     :actions pi/PI-ACTIONS
     :usage "loyly-clj cycle pi --check <live-run.json>
  loyly-clj cycle pi --run <live-run.json>
  loyly-clj panel-reassess --check|--run <reassess.json>"}
    {:id "codex"
     :kind "orchestrator-adapter"
     :backend "loyly-clj"
     :cljc-actions (conj ADAPTER-ACTIONS "reassess")
     :cljs-node-actions []
     :actions (conj ADAPTER-ACTIONS "reassess")
     :usage "loyly-clj cycle codex preflight|decide|candidate|evidence|panel|reassess <input.json>"}
    {:id "cursor"
     :kind "orchestrator-adapter"
     :backend "loyly-clj"
     :cljc-actions ADAPTER-ACTIONS
     :cljs-node-actions []
     :actions ADAPTER-ACTIONS
     :usage "loyly-clj cycle cursor preflight|decide|candidate|evidence|panel <input.json>"}]})

(defn invoke-adapter-cljc!
  "Run any Codex/Cursor adapter action directly in Node via shared .cljc loyly.adapters."
  [{:keys [repo driver action input]}]
  (when-not (plat/regular-file? input)
    (rt/die! (str "missing input JSON: " input)))
  (p/resolved
   (try
     (let [report (adapters/dispatch (keyword driver) action (plat/absolutize input) repo)]
       (println (hjson/compact-json report))
       0)
     (catch :default e
       (plat/err (str (or (ex-message e) (str e)) "\n"))
       1))))

(defn invoke-driver!
  "Dispatch to pi|codex|cursor asynchronously. Returns a Promise of exit code."
  [{:keys [driver action args root]}]
  (let [repo (rt/resolve-repo root)]
    (case (keyword driver)
      :pi
      (let [[contract] args]
        (when-not contract
          (rt/die! "usage: cycle pi --check|--run <live-run.json>"))
        (pi/invoke-pi! {:repo repo :action action :contract contract}))

      :codex
      (let [[input] args]
        (when-not input
          (rt/die! "usage: cycle codex preflight|candidate|decide|evidence|panel|reassess <input.json>"))
        (invoke-adapter-cljc! {:repo repo :driver :codex :action action :input input}))

      :cursor
      (let [[input] args]
        (when-not input
          (rt/die! "usage: cycle cursor preflight|candidate|decide|evidence|panel <input.json>"))
        (invoke-adapter-cljc! {:repo repo :driver :cursor :action action :input input}))

      (rt/die! (str "unknown driver: " driver " (expected pi|codex|cursor)")))))

;; ---------------------------------------------------------------- async Node hook factories

(defn make-http-fetch-fn
  "Async HTTP hook for blind-probe / network steps using Node 22 fetch."
  []
  (fn [req]
    (rt/fetch-json req)))

(defn make-allure-cli-fn
  "Async Allure CLI hook for loyly.panel-compile."
  [repo]
  (let [allure-bin (plat/path repo "harness" "pi-durable" "node_modules" ".bin" "allure")]
    (fn [{:keys [results-dir report-dir cwd]}]
      (rt/spawn-async [allure-bin "generate" results-dir "-o" report-dir "--clean"]
                      {:cwd (or cwd (plat/path repo "harness" "pi-durable"))}))))

(defn make-spawn-hook
  "Async subprocess hook for gate-adapter / builder-adapter / panel-vm."
  []
  (fn [{:keys [cmd cwd env stdio]}]
    (rt/spawn-async cmd {:cwd cwd :env env :stdio (or stdio :pipe)})))
