(ns loyly.spike.cycle-effects
  "PoC port of harness/pi-durable/cycle-effects.ts"
  (:require [babashka.fs :as fs]
            [babashka.process :as p]
            [clojure.string :as str]
            [loyly.spike.digest :as d]
            [loyly.spike.hjson :as hjson]))

(defn hash-value
  "SHA-256 of a string (TS cycle-effects hash)."
  [value]
  (d/sha256-string (str value)))

(defn- write-log [scratch name output]
  (let [path (fs/file scratch (str name ".log"))]
    (hjson/spit-utf8 path output)
    (str path)))

(defn run-command
  "Spawn a command, write scratch/<name>.log, return {:code :output :sha256 :log}."
  [{:keys [scratch source-root environment]} name program args
   & {:keys [cwd env timeout]
      :or {timeout 900000}}]
  (let [{:keys [exit out err]}
        @(p/process (into [program] args)
                    {:dir (or cwd source-root)
                     :env (merge (or environment {}) (or env {}))
                     :out :string :err :string
                     :timeout timeout})
        output (str out err)
        log (write-log scratch name output)]
    {:code (or exit 124)
     :output output
     :sha256 (hash-value output)
     :log log}))

(defn proof-of-fence
  "True when room is a single-commit fence without impl/cycles."
  [room]
  (and (fs/exists? room)
       (let [{:keys [exit out]}
             @(p/process ["git" "-C" (str room) "rev-list" "--count" "--all"]
                         {:out :string :err :string})]
         (and (zero? exit)
              (= "1" (str/trim out))
              (not (fs/exists? (fs/path room "impl")))
              (not (fs/exists? (fs/path room "harness" "cycles")))))))

(defn git-at
  [path & args]
  (let [{:keys [exit out]}
        @(p/process (into ["git" "-C" (str path)] args) {:out :string :err :string})]
    (when (zero? exit)
      (str/trim out))))

(defn prove-cut
  [{:keys [approved-commit cut source-root approved-source-repo]}]
  (if-not approved-commit
    true
    (let [receipt (fs/file cut "cut.json")]
      (and (fs/regular-file? receipt)
           (fs/exists? source-root)
           (let [recorded (hjson/read-json (slurp receipt :encoding "UTF-8"))]
             (and (= (get recorded "commit") approved-commit)
                  (= (get recorded "project") (str source-root))
                  (= (get recorded "source_repo") approved-source-repo)
                  (= (git-at source-root "rev-parse" "HEAD") approved-commit)
                  (= (git-at source-root "status" "--porcelain") "")))))))

(defn measure-log
  "Port of cycle-phases measureLog: run thunk, capture log + digest."
  [scratch name run-fn]
  (try
    (let [result (run-fn)
          output (str (or (:stdout result) (:out result) "")
                      (or (:stderr result) (:err result) ""))]
      (write-log scratch name output)
      {:code 0 :output output :sha256 (hash-value output)})
    (catch Exception e
      (let [output (str (.getMessage e) "\n")]
        (write-log scratch name output)
        {:code 1 :output output :sha256 (hash-value output)}))))

(defn create-cycle-effects
  "Return a map of effect helpers mirroring createCycleEffects(paths)."
  [{:keys [root scratch room cut source-root approved-source-repo approved-commit
           digest-candidate environment]
    :or {environment {}}}]
  {:hash hash-value
   :command (fn [name program args & opts]
              (apply run-command
                     {:scratch scratch :source-root source-root :environment environment}
                     name program args opts))
   :proof-of-fence (fn [] (proof-of-fence room))
   :git-at git-at
   :prove-cut (fn [] (prove-cut {:approved-commit approved-commit
                                 :cut cut
                                 :source-root source-root
                                 :approved-source-repo approved-source-repo}))
   :candidate-digest digest-candidate
   :measure-log (fn [name run-fn] (measure-log scratch name run-fn))
   :root root
   :scratch scratch})
