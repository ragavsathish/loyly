(ns loyly.spike.drivers
  "Thin Babashka wrapper over the three cycle drivers.

  Spawns the authoritative Node CLIs — does not replace them:

  - Pi durable   → harness/pi-durable/run-live.mjs
  - Codex cycle  → harness/codex-cycle/cli.ts (+ reassessment-cli.ts)
  - Cursor cycle → harness/cursor-cycle/cli.ts

  Spike only: TypeScript remains the scored-cycle path."
  (:require [babashka.fs :as fs]
            [babashka.process :as p]
            [clojure.string :as str]
            [loyly.spike.hjson :as hjson]))

(def ADAPTER-ACTIONS
  ["preflight" "candidate" "decide" "evidence" "panel"])

(def PI-ACTIONS
  ["--check" "--run"])

(defn catalog
  "Closed description of the three drivers (for help / formal listing)."
  []
  {:schema "loyly.cycle-drivers.v1"
   :drivers
   [{:id "pi"
     :kind "durable-live"
     :script "harness/pi-durable/run-live.mjs"
     :actions PI-ACTIONS
     :usage "cycle pi --check|--run <live-run.json>"}
    {:id "codex"
     :kind "orchestrator-adapter"
     :script "harness/codex-cycle/cli.ts"
     :reassess "harness/codex-cycle/reassessment-cli.ts"
     :actions ADAPTER-ACTIONS
     :usage "cycle codex preflight|candidate|decide|evidence|panel <input.json>
  cycle codex reassess <contract.json>"}
    {:id "cursor"
     :kind "orchestrator-adapter"
     :script "harness/cursor-cycle/cli.ts"
     :actions ADAPTER-ACTIONS
     :usage "cycle cursor preflight|candidate|decide|evidence|panel <input.json>"}]})

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
  "Spawn Node with inherit stdio; return exit code."
  [{:keys [node cwd args env]
    :or {node "node" env (into {} (System/getenv))}}]
  (let [result @(p/process (into [node] args)
                           {:dir cwd
                            :env env
                            :in :inherit
                            :out :inherit
                            :err :inherit})]
    (:exit result)))

(defn invoke-pi!
  "Pi durable: node run-live.mjs --check|--run <contract.json>."
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

(defn invoke-adapter!
  "Codex/Cursor adapter: node cli.ts <action> <input.json>."
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

(defn invoke-codex-reassess!
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
  [{:keys [driver action args root node]
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
      (if (= action "reassess")
        (let [[contract] args]
          (when-not contract
            (die! "usage: cycle codex reassess <contract.json>"))
          (invoke-codex-reassess! (assoc opts :contract contract)))
        (let [[input] args]
          (when-not input
            (die! "usage: cycle codex <action> <input.json>"))
          (invoke-adapter! (assoc opts :driver :codex :action action :input input))))

      :cursor
      (let [[input] args]
        (when-not input
          (die! "usage: cycle cursor <action> <input.json>"))
        (invoke-adapter! (assoc opts :driver :cursor :action action :input input)))

      (die! (str "unknown driver: " driver
                 " (expected pi|codex|cursor)")))))

(defn- print-help []
  (binding [*out* *err*]
    (println "usage:")
    (println "  spike cycle list")
    (println "  spike cycle pi --check|--run <live-run.json>")
    (println "  spike cycle codex preflight|candidate|decide|evidence|panel <input.json>")
    (println "  spike cycle codex reassess <contract.json>")
    (println "  spike cycle cursor preflight|candidate|decide|evidence|panel <input.json>")
    (println)
    (println "Options: --root <repo>   (default: discover from cwd)")
    (println "         --node <bin>    (default: node)")
    (println)
    (println "Spawns the authoritative TypeScript drivers; does not replace them.")))

(defn- parse-opts
  [args]
  (loop [args (vec args) acc {:args []}]
    (if-let [a (first args)]
      (cond
        (= a "--root")
        (recur (nnext args) (assoc acc :root (second args)))
        (= a "--node")
        (recur (nnext args) (assoc acc :node (second args)))
        (#{"-h" "--help" "help"} a)
        (assoc acc :help true)
        :else
        (recur (next args) (update acc :args conj a)))
      acc)))

(defn -main
  [& argv]
  (let [{:keys [args root node help]} (parse-opts argv)]
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
                           :node (or node "node")})]
        (System/exit (or code 1))))))
