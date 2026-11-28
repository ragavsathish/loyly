(ns loyly.drivers
  "Unified production cycle CLI for Pi / Codex / Cursor.

  All pure/local actions (Pi --check, ALL Codex & Cursor actions including
  preflight and reassess) run via shared .cljc modules (loyly.live-contract,
  loyly.adapters). Node async & @earendil-works/pi-durable actions (Pi --run,
  panel-reassess, worker, export-replay, render-allure) delegate through the
  thin ClojureScript Node wrapper (loyly.node.cli via nbb)."
  (:require [babashka.fs :as fs]
            [babashka.process :as p]
            [clojure.string :as str]
            [loyly.adapters :as adapters]
            [loyly.hjson :as hjson]
            [loyly.live-contract :as live]))

(def ADAPTER-ACTIONS
  ["preflight" "candidate" "decide" "evidence" "panel"])

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
     :extension "harness/pi-durable/pi-extension.ts"
     :cljc-actions ["--check"]
     :cljs-node-actions ["--run" "panel-reassess" "worker" "export-replay" "render-allure" "blind-review" "supplemental-grade"]
     :actions PI-ACTIONS
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
  [{:keys [repo args]}]
  (let [nbb (resolve-nbb repo)
        pkg-dir (str (fs/path repo "harness" "loyly-clj"))
        cmd (if nbb
              (into [nbb "-m" "loyly.node.cli"] args)
              (into ["npx" "--yes" "nbb" "-m" "loyly.node.cli"] args))
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
  [{:keys [repo driver action input]}]
  (when-not (fs/regular-file? input)
    (die! (str "missing input JSON: " input)))
  (try
    (let [report (adapters/dispatch (keyword driver) action
                                    (str (fs/absolutize input))
                                    repo)]
      (println (hjson/compact-json report))
      0)
    (catch Exception e
      (binding [*out* *err*]
        (println (or (ex-message e) (str e))))
      1)))

(defn invoke!
  "Dispatch to one driver. Returns process exit code."
  [{:keys [driver action args root] :as opts}]
  (let [repo (resolve-repo root)
        opts (assoc opts :repo repo)]
    (case (keyword driver)
      :pi
      (let [[contract] args]
        (when-not contract
          (die! "usage: loyly-clj cycle pi --check|--run <live-run.json>"))
        (case action
          "--check" (invoke-pi-check-cljc! (assoc opts :contract contract))
          "--run" (run-cljs-node!
                   {:repo repo
                    :args ["cycle" "pi" "--run" (str (fs/absolutize contract)) "--root" repo]})
          (die! (str "pi actions: " (str/join "|" PI-ACTIONS)))))

      :codex
      (let [valid (conj ADAPTER-ACTIONS "reassess")
            [input] args]
        (when-not (some #{action} valid)
          (die! (str "codex actions: " (str/join "|" valid))))
        (when-not input
          (die! "usage: loyly-clj cycle codex preflight|candidate|decide|evidence|panel|reassess <input.json>"))
        (invoke-adapter-cljc! {:repo repo :driver :codex :action action :input input}))

      :cursor
      (let [[input] args]
        (when-not (some #{action} ADAPTER-ACTIONS)
          (die! (str "cursor actions: " (str/join "|" ADAPTER-ACTIONS))))
        (when-not input
          (die! "usage: loyly-clj cycle cursor preflight|candidate|decide|evidence|panel <input.json>"))
        (invoke-adapter-cljc! {:repo repo :driver :cursor :action action :input input}))

      (die! (str "unknown driver: " driver " (expected pi|codex|cursor)")))))

(defn- print-help []
  (binding [*out* *err*]
    (println "usage:")
    (println "  loyly-clj cycle list")
    (println "  loyly-clj cycle pi --check|--run <live-run.json>")
    (println "  loyly-clj cycle codex preflight|candidate|decide|evidence|panel|reassess <input.json>")
    (println "  loyly-clj cycle cursor preflight|candidate|decide|evidence|panel <input.json>")
    (println)
    (println "All core/adapter logic runs in shared .cljc; Pi --run delegates to loyly.node.cli (.cljs).")
    (println "Options: --root <repo>")))

(defn- parse-opts
  [args]
  (loop [args (vec args) acc {:args []}]
    (if-let [a (first args)]
      (cond
        (= a "--root")
        (recur (nnext args) (assoc acc :root (second args)))
        (#{"-h" "--help" "help"} a)
        (assoc acc :help true)
        :else
        (recur (next args) (update acc :args conj a)))
      acc)))

(defn -main
  [& argv]
  (let [{:keys [args root help]} (parse-opts argv)]
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
                           :root root})]
        (System/exit (or code 1))))))
