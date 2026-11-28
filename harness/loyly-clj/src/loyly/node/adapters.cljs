(ns loyly.node.adapters
  "ClojureScript async adapters for Codex / Cursor drivers and Node hook factories (.cljs).

  Runs decide|candidate|evidence|panel directly via shared .cljc loyly.adapters,
  wraps Node-only preflight/reassess asynchronously, and supplies async HTTP /
  Allure CLI / subprocess hooks for .cljc core modules."
  (:require [clojure.string :as str]
            [loyly.adapters :as adapters]
            [loyly.hjson :as hjson]
            [loyly.node.pi-backend :as pi]
            [loyly.node.runtime :as rt]
            [loyly.platform :as plat]
            [promesa.core :as p]))

(def ADAPTER-ACTIONS
  ["preflight" "candidate" "decide" "evidence" "panel"])

(def CLJC-ADAPTER-ACTIONS
  #{"candidate" "decide" "evidence" "panel"})

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
     :script "harness/pi-durable/run-live.mjs"
     :reassess "harness/pi-durable/reassess-panel.mjs"
     :cljc-actions ["--check"]
     :cljs-node-actions ["--run" "panel-reassess"]
     :actions pi/PI-ACTIONS
     :usage "loyly-clj cycle pi --check <live-run.json>
  loyly-clj cycle pi --run <live-run.json>
  loyly-clj panel-reassess --check|--run <reassess.json>"}
    {:id "codex"
     :kind "orchestrator-adapter"
     :backend "loyly-clj"
     :script "harness/codex-cycle/cli.ts"
     :cljc-actions (vec CLJC-ADAPTER-ACTIONS)
     :cljs-node-actions ["preflight" "reassess"]
     :reassess "harness/codex-cycle/reassessment-cli.ts"
     :actions ADAPTER-ACTIONS
     :usage "loyly-clj cycle codex decide|candidate|evidence|panel <input.json>
  loyly-clj cycle codex preflight <contract.json>
  loyly-clj cycle codex reassess <contract.json>"}
    {:id "cursor"
     :kind "orchestrator-adapter"
     :backend "loyly-clj"
     :script "harness/cursor-cycle/cli.ts"
     :cljc-actions (vec CLJC-ADAPTER-ACTIONS)
     :cljs-node-actions ["preflight"]
     :actions ADAPTER-ACTIONS
     :usage "loyly-clj cycle cursor decide|candidate|evidence|panel <input.json>
  loyly-clj cycle cursor preflight <contract.json>"}]})

(defn invoke-adapter-ts!
  "Spawn the Codex or Cursor TypeScript CLI asynchronously."
  [{:keys [repo driver action input node]}]
  (let [rel (case driver
              :codex "harness/codex-cycle/cli.ts"
              :cursor "harness/cursor-cycle/cli.ts"
              (rt/die! (str "unknown adapter: " driver)))
        script (rt/script-path repo rel)
        dir (plat/parent script)]
    (when-not (some #{action} ADAPTER-ACTIONS)
      (rt/die! (str (name driver) " actions: " (str/join "|" ADAPTER-ACTIONS))))
    (when-not (plat/regular-file? input)
      (rt/die! (str "missing input JSON: " input)))
    (rt/spawn-node-inherit {:node node
                            :cwd dir
                            :args [script action (plat/absolutize input)]})))

(defn invoke-adapter-cljc!
  "Run a Codex/Cursor adapter action directly in Node via shared .cljc loyly.adapters."
  [{:keys [driver action input]}]
  (when-not (plat/regular-file? input)
    (rt/die! (str "missing input JSON: " input)))
  (p/resolved
   (try
     (let [report (adapters/dispatch (keyword driver) action (plat/absolutize input))]
       (println (hjson/compact-json report))
       0)
     (catch :default e
       (plat/err (str (or (ex-message e) (str e)) "\n"))
       1))))

(defn invoke-codex-reassess!
  "Run Codex panel reassessment asynchronously via reassessment-cli.ts."
  [{:keys [repo contract node]}]
  (when-not (plat/regular-file? contract)
    (rt/die! (str "missing reassessment contract: " contract)))
  (let [script (rt/script-path repo "harness/codex-cycle/reassessment-cli.ts")
        dir (plat/parent script)]
    (rt/spawn-node-inherit {:node node
                            :cwd dir
                            :args [script (plat/absolutize contract)]})))

(defn invoke-driver!
  "Dispatch to pi|codex|cursor asynchronously. Returns a Promise of exit code."
  [{:keys [driver action args root node ts?]}]
  (let [repo (rt/resolve-repo root)
        opts {:repo repo :node node :ts? ts?}]
    (case (keyword driver)
      :pi
      (let [[contract] args]
        (when-not contract
          (rt/die! "usage: cycle pi --check|--run <live-run.json> [--ts]"))
        (pi/invoke-pi! (assoc opts :action action :contract contract)))

      :codex
      (cond
        (= action "reassess")
        (let [[contract] args]
          (when-not contract
            (rt/die! "usage: cycle codex reassess <contract.json>"))
          (invoke-codex-reassess! (assoc opts :contract contract)))

        (and (not ts?) (contains? CLJC-ADAPTER-ACTIONS action))
        (let [[input] args]
          (when-not input
            (rt/die! "usage: cycle codex <action> <input.json>"))
          (invoke-adapter-cljc! {:driver :codex :action action :input input}))

        :else
        (let [[input] args]
          (when-not input
            (rt/die! "usage: cycle codex <action> <input.json> [--ts]"))
          (invoke-adapter-ts! (assoc opts :driver :codex :action action :input input))))

      :cursor
      (let [[input] args]
        (when-not input
          (rt/die! "usage: cycle cursor <action> <input.json> [--ts]"))
        (if (and (not ts?) (contains? CLJC-ADAPTER-ACTIONS action))
          (invoke-adapter-cljc! {:driver :cursor :action action :input input})
          (invoke-adapter-ts! (assoc opts :driver :cursor :action action :input input))))

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
