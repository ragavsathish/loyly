(ns loyly.drivers
  "Unified production cycle CLI for Pi / Codex / Cursor.

  Pure/local actions (Pi --check, Codex/Cursor decide|candidate|evidence|panel)
  run via shared .cljc modules (loyly.live-contract, loyly.adapters) by default.
  Node async & backend actions (Pi --run, panel-reassess, Codex/Cursor preflight,
  Codex reassess, or --ts) delegate through the ClojureScript Node wrapper
  (loyly.node.cli via nbb)."
  (:require [babashka.fs :as fs]
            [babashka.process :as p]
            [clojure.string :as str]
            [loyly.adapters :as adapters]
            [loyly.hjson :as hjson]
            [loyly.live-contract :as live]))

(def ADAPTER-ACTIONS
  ["preflight" "candidate" "decide" "evidence" "panel"])

(def CLJC-ADAPTER-ACTIONS
  #{"candidate" "decide" "evidence" "panel"})

(def PI-ACTIONS
  ["--check" "--run"])

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
     :actions PI-ACTIONS
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

(defn- die!
  [msg]
  (binding [*out* *err*]
    (println msg))
  (System/exit 2))

(defn- resolve-repo
  [root]
  (let [root (str (fs/absolutize (or root ".")))]
    (cond
      (fs/directory? (fs/path root "harness" "pi-durable")) root
      (fs/directory? (fs/path root ".." ".." "harness" "pi-durable"))
      (str (fs/absolutize (fs/path root ".." "..")))
      :else (die! (str "not a Löyly repo root (missing harness/pi-durable): " root)))))

(defn- resolve-nbb
  [repo]
  (let [local (fs/path repo "harness" "loyly-clj" "node_modules" ".bin" "nbb")]
    (cond
      (fs/regular-file? local) (str local)
      (fs/which "nbb") (str (fs/which "nbb"))
      :else nil)))

(defn- run-cljs-node!
  "Delegate to ClojureScript Node wrapper (nbb -m loyly.node.cli ...)."
  [{:keys [repo args node]}]
  (let [nbb (resolve-nbb repo)
        pkg-dir (str (fs/path repo "harness" "loyly-clj"))
        cmd (if nbb
              (into [nbb "-m" "loyly.node.cli"] args)
              (into ["npx" "--yes" "nbb" "-m" "loyly.node.cli"] args))
        cmd (cond-> cmd
              (and node (not= node "node")) (into ["--node" node]))
        result @(p/process cmd
                           {:dir pkg-dir
                            :env (into {} (System/getenv))
                            :in :inherit
                            :out :inherit
                            :err :inherit})]
    (:exit result)))

(defn- invoke-pi-check-cljc!
  "Validate a pinned live-run via shared .cljc check-live-run."
  [{:keys [repo contract]}]
  (when-not (fs/regular-file? contract)
    (die! (str "missing live-run contract: " contract)))
  (try
    (live/check-live-run
     (hjson/read-json (slurp (str (fs/absolutize contract)) :encoding "UTF-8"))
     :root repo
     :pi-durable (str (fs/path repo "harness" "pi-durable")))
    (println "pinned cycle contract verified")
    0
    (catch Exception e
      (binding [*out* *err*]
        (println (or (ex-message e) (str e))))
      1)))

(defn- invoke-adapter-cljc!
  [{:keys [driver action input]}]
  (when-not (fs/regular-file? input)
    (die! (str "missing input JSON: " input)))
  (try
    (let [report (adapters/dispatch (keyword driver) action
                                    (str (fs/absolutize input)))]
      (println (hjson/compact-json report))
      0)
    (catch Exception e
      (binding [*out* *err*]
        (println (or (ex-message e) (str e))))
      1)))

(defn invoke!
  "Dispatch to one driver. Returns process exit code."
  [{:keys [driver action args root node ts?]
    :or {node "node"}
    :as opts}]
  (let [repo (resolve-repo root)
        opts (assoc opts :repo repo :node node)
        forward-cljs (fn [cli-args]
                       (run-cljs-node!
                        {:repo repo
                         :node node
                         :args (cond-> (into ["cycle" (name driver) action] cli-args)
                                 true (into ["--root" repo])
                                 ts? (conj "--ts"))}))]
    (case (keyword driver)
      :pi
      (let [[contract] args]
        (when-not contract
          (die! "usage: loyly-clj cycle pi --check|--run <live-run.json> [--ts]"))
        (cond
          (and (= action "--check") (not ts?))
          (invoke-pi-check-cljc! (assoc opts :contract contract))

          (some #{action} PI-ACTIONS)
          (forward-cljs [(str (fs/absolutize contract))])

          :else
          (die! (str "pi actions: " (str/join "|" PI-ACTIONS)))))

      :codex
      (cond
        (= action "reassess")
        (let [[contract] args]
          (when-not contract
            (die! "usage: loyly-clj cycle codex reassess <contract.json>"))
          (forward-cljs [(str (fs/absolutize contract))]))

        (and (not ts?) (contains? CLJC-ADAPTER-ACTIONS action))
        (let [[input] args]
          (when-not input
            (die! "usage: loyly-clj cycle codex <action> <input.json>"))
          (invoke-adapter-cljc! {:driver :codex :action action :input input}))

        (some #{action} ADAPTER-ACTIONS)
        (let [[input] args]
          (when-not input
            (die! "usage: loyly-clj cycle codex <action> <input.json> [--ts]"))
          (forward-cljs [(str (fs/absolutize input))]))

        :else
        (die! (str "codex actions: " (str/join "|" (conj ADAPTER-ACTIONS "reassess")))))

      :cursor
      (let [[input] args]
        (when-not (some #{action} ADAPTER-ACTIONS)
          (die! (str "cursor actions: " (str/join "|" ADAPTER-ACTIONS))))
        (when-not input
          (die! "usage: loyly-clj cycle cursor <action> <input.json> [--ts]"))
        (if (and (not ts?) (contains? CLJC-ADAPTER-ACTIONS action))
          (invoke-adapter-cljc! {:driver :cursor :action action :input input})
          (forward-cljs [(str (fs/absolutize input))])))

      (die! (str "unknown driver: " driver " (expected pi|codex|cursor)")))))

(defn- print-help []
  (binding [*out* *err*]
    (println "usage:")
    (println "  loyly-clj cycle list")
    (println "  loyly-clj cycle pi --check <live-run.json>")
    (println "  loyly-clj cycle pi --run <live-run.json>")
    (println "  loyly-clj cycle cursor|codex decide|candidate|evidence|panel <input.json>")
    (println "  loyly-clj cycle cursor|codex preflight <contract.json>")
    (println "  loyly-clj cycle codex reassess <contract.json>")
    (println)
    (println "Core logic runs via shared .cljc modules; Node async/backend steps")
    (println "(pi --run, preflight, reassess, --ts) delegate to loyly.node.cli (.cljs).")
    (println "Options: --root <repo>  --node <bin>  --ts")))

(defn- parse-opts
  [args]
  (loop [args (vec args) acc {:args [] :ts? false}]
    (if-let [a (first args)]
      (cond
        (= a "--root")
        (recur (nnext args) (assoc acc :root (second args)))
        (= a "--node")
        (recur (nnext args) (assoc acc :node (second args)))
        (= a "--ts")
        (recur (next args) (assoc acc :ts? true))
        (#{"-h" "--help" "help"} a)
        (assoc acc :help true)
        :else
        (recur (next args) (update acc :args conj a)))
      acc)))

(defn -main
  [& argv]
  (let [{:keys [args root node help ts?]} (parse-opts argv)]
    (when (or help (empty? args))
      (print-help)
      (System/exit (if help 0 2)))
    (let [[driver & more] args]
      (when (= driver "list")
        (println (hjson/compact-json (catalog)))
        (System/exit 0))
      (when-not (#{"pi" "codex" "cursor"} driver)
        (print-help)
        (die! (str "unknown driver: " driver)))
      (when (empty? more)
        (print-help)
        (System/exit 2))
      (let [[action & rest] more
            code (invoke! {:driver driver
                           :action action
                           :args (vec rest)
                           :root root
                           :node (or node "node")
                           :ts? ts?})]
        (System/exit (or code 1))))))
