(ns loyly.spike.drivers
  "Unified cycle CLI for Pi / Codex / Cursor.

  Codex & Cursor adapter actions (decide|candidate|evidence|panel) run through
  CLJ spike modules by default. Pass --ts to spawn the Node CLIs instead.

  Pi durable --check/--run still spawns Node (no CLJ Pi worker yet).
  Codex/Cursor preflight still needs --ts (contract checker not ported).

  Spike only: TypeScript remains authoritative for scored production runs."
  (:require [babashka.fs :as fs]
            [babashka.process :as p]
            [clojure.string :as str]
            [loyly.spike.adapters :as adapters]
            [loyly.spike.hjson :as hjson]))

(def ADAPTER-ACTIONS
  ["preflight" "candidate" "decide" "evidence" "panel"])

(def CLJ-ADAPTER-ACTIONS
  #{"candidate" "decide" "evidence" "panel"})

(def PI-ACTIONS
  ["--check" "--run"])

(defn catalog
  "Closed description of the three drivers."
  []
  {:schema "loyly.cycle-drivers.v1"
   :backend "clj-spike"
   :drivers
   [{:id "pi"
     :kind "durable-live"
     :backend "node"
     :script "harness/pi-durable/run-live.mjs"
     :actions PI-ACTIONS
     :usage "cycle pi --check|--run <live-run.json>"}
    {:id "codex"
     :kind "orchestrator-adapter"
     :backend "clj-spike"
     :script "harness/codex-cycle/cli.ts"
     :clj-actions (vec CLJ-ADAPTER-ACTIONS)
     :reassess "harness/codex-cycle/reassessment-cli.ts"
     :actions ADAPTER-ACTIONS
     :usage "cycle codex decide|candidate|evidence|panel <input.json>
  cycle codex preflight <contract.json> --ts
  cycle codex reassess <contract.json>"}
    {:id "cursor"
     :kind "orchestrator-adapter"
     :backend "clj-spike"
     :script "harness/cursor-cycle/cli.ts"
     :clj-actions (vec CLJ-ADAPTER-ACTIONS)
     :actions ADAPTER-ACTIONS
     :usage "cycle cursor decide|candidate|evidence|panel <input.json>
  cycle cursor preflight <contract.json> --ts"}]})

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

(defn- script-path
  [repo rel]
  (let [path (fs/path repo rel)]
    (when-not (fs/regular-file? path)
      (die! (str "driver script missing: " rel)))
    (str path)))

(defn- run-node!
  [{:keys [node cwd args]
    :or {node "node"}}]
  (let [result @(p/process (into [node] args)
                           {:dir cwd
                            :env (into {} (System/getenv))
                            :in :inherit
                            :out :inherit
                            :err :inherit})]
    (:exit result)))

(defn- invoke-pi!
  [{:keys [repo action contract node]}]
  (when-not (some #{action} PI-ACTIONS)
    (die! (str "pi actions: " (str/join "|" PI-ACTIONS))))
  (when-not (fs/regular-file? contract)
    (die! (str "missing live-run contract: " contract)))
  (let [script (script-path repo "harness/pi-durable/run-live.mjs")
        cwd (str (fs/path repo "harness" "pi-durable"))]
    (run-node! {:node node
                :cwd cwd
                :args [script action (str (fs/absolutize contract))]})))

(defn- invoke-adapter-ts!
  [{:keys [repo driver action input node]}]
  (let [rel (case driver
              :codex "harness/codex-cycle/cli.ts"
              :cursor "harness/cursor-cycle/cli.ts"
              (die! (str "unknown adapter: " driver)))
        dir (str (fs/parent (script-path repo rel)))]
    (when-not (some #{action} ADAPTER-ACTIONS)
      (die! (str (name driver) " actions: " (str/join "|" ADAPTER-ACTIONS))))
    (when-not (fs/regular-file? input)
      (die! (str "missing input JSON: " input)))
    (run-node! {:node node
                :cwd dir
                :args [(script-path repo rel) action
                       (str (fs/absolutize input))]})))

(defn- invoke-adapter-clj!
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

(defn- invoke-codex-reassess!
  [{:keys [repo contract node]}]
  (when-not (fs/regular-file? contract)
    (die! (str "missing reassessment contract: " contract)))
  (let [rel "harness/codex-cycle/reassessment-cli.ts"
        dir (str (fs/parent (script-path repo rel)))]
    (run-node! {:node node
                :cwd dir
                :args [(script-path repo rel)
                       (str (fs/absolutize contract))]})))

(defn invoke!
  "Dispatch to one driver. Returns process exit code."
  [{:keys [driver action args root node ts?]
    :or {node "node"}
    :as opts}]
  (let [repo (resolve-repo root)
        opts (assoc opts :repo repo :node node)]
    (case (keyword driver)
      :pi
      (let [[contract] args]
        (when-not contract
          (die! "usage: cycle pi --check|--run <live-run.json>"))
        (invoke-pi! (assoc opts :action action :contract contract)))

      :codex
      (cond
        (= action "reassess")
        (let [[contract] args]
          (when-not contract
            (die! "usage: cycle codex reassess <contract.json>"))
          (invoke-codex-reassess! (assoc opts :contract contract)))

        (and (not ts?) (contains? CLJ-ADAPTER-ACTIONS action))
        (let [[input] args]
          (when-not input
            (die! "usage: cycle codex <action> <input.json>"))
          (invoke-adapter-clj! {:driver :codex :action action :input input}))

        :else
        (let [[input] args]
          (when-not input
            (die! "usage: cycle codex <action> <input.json> [--ts]"))
          (invoke-adapter-ts! (assoc opts :driver :codex :action action :input input))))

      :cursor
      (let [[input] args]
        (when-not input
          (die! "usage: cycle cursor <action> <input.json> [--ts]"))
        (if (and (not ts?) (contains? CLJ-ADAPTER-ACTIONS action))
          (invoke-adapter-clj! {:driver :cursor :action action :input input})
          (invoke-adapter-ts! (assoc opts :driver :cursor :action action :input input))))

      (die! (str "unknown driver: " driver " (expected pi|codex|cursor)")))))

(defn- print-help []
  (binding [*out* *err*]
    (println "usage:")
    (println "  spike cycle list")
    (println "  spike cycle pi --check|--run <live-run.json>")
    (println "  spike cycle cursor|codex decide|candidate|evidence|panel <input.json>")
    (println "  spike cycle cursor|codex preflight <contract.json> --ts")
    (println "  spike cycle codex reassess <contract.json>")
    (println)
    (println "Default: Codex/Cursor decide|candidate|evidence|panel use CLJ spike modules.")
    (println "         Pass --ts to spawn the Node adapter CLIs instead.")
    (println "Options: --root <repo>  --node <bin>")))

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
