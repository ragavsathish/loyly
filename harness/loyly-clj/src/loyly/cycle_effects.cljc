(ns loyly.cycle-effects
  "PoC port of harness/pi-durable/cycle-effects.ts"
  (:require [clojure.string :as str]
            [loyly.digest :as d]
            [loyly.hjson :as hjson]
            [loyly.platform :as plat]))

(defn hash-value
  "SHA-256 of a string (TS cycle-effects hash)."
  [value]
  (d/sha256-string (str value)))

(defn- write-log [scratch name output]
  (let [path (plat/path scratch (str name ".log"))]
    (hjson/spit-utf8 path output)
    (str path)))

(defn run-command
  "Spawn a command, write scratch/<name>.log, return {:code :output :sha256 :log}."
  [{:keys [scratch source-root environment]} name program args
   & {:keys [cwd env]}]
  (let [{:keys [exit out err]}
        (plat/exec-sync (into [program] args)
                        {:dir (or cwd source-root)
                         :env (merge (or environment {}) (or env {}))})
        output (str out err)
        log (write-log scratch name output)]
    {:code (or exit 124)
     :output output
     :sha256 (hash-value output)
     :log log}))

(defn proof-of-fence
  "True when room is a single-commit fence without impl/cycles."
  [room]
  (and (plat/exists? room)
       (let [{:keys [exit out]}
             (plat/exec-sync ["git" "-C" (str room) "rev-list" "--count" "--all"])]
         (and (zero? exit)
              (= "1" (str/trim out))
              (not (plat/exists? (plat/path room "impl")))
              (not (plat/exists? (plat/path room "harness" "cycles")))))))

(defn git-at
  [path & args]
  (let [{:keys [exit out]}
        (plat/exec-sync (into ["git" "-C" (str path)] args))]
    (when (zero? exit)
      (str/trim out))))

(defn prove-cut
  [{:keys [approved-commit cut source-root approved-source-repo]}]
  (if-not approved-commit
    true
    (let [receipt (plat/path cut "cut.json")]
      (and (plat/regular-file? receipt)
           (plat/exists? source-root)
           (let [recorded (hjson/read-json (plat/read-text receipt))]
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
    (catch #?(:clj Exception :cljs :default) e
      (let [output (str (ex-message e) "\n")]
        (write-log scratch name output)
        {:code 1 :output output :sha256 (hash-value output)}))))

(def ^:private BUILDER-CACHE-DIRS
  ["node_modules" ".tmp" ".npm-cache" ".npm" ".m2" ".cache" ".uv-cache" ".gradle"])

(defn clear-builder-test-artifacts
  "Remove transient download/build caches under room/impl before sealing the candidate."
  [room]
  (doseq [n BUILDER-CACHE-DIRS]
    (plat/delete-tree (plat/path room "impl" n))))

(defn verify-builder-scope
  "Verify builder wrote only under impl/ and .builder/ and left required entrypoints."
  ([room] (verify-builder-scope room true))
  ([room require-entrypoints?]
   (when (and require-entrypoints?
              (or (not (plat/exists? (plat/path room "impl" "start.sh")))
                  (not (plat/exists? (plat/path room "impl" "test.sh")))))
     (throw (ex-info "builder did not leave both legacy app entrypoints" {:room room})))
   (let [{:keys [exit out]}
         (plat/exec-sync ["git" "status" "--porcelain=v1" "-z" "--untracked-files=all"]
                         {:dir room})]
     (when-not (zero? exit)
       (throw (ex-info "cannot check builder write scope" {:room room})))
     (doseq [line (remove str/blank? (str/split (or out "") #"\u0000"))]
       (when-not (= "??" (subs line 0 (min 2 (count line))))
         (throw (ex-info "builder modified a tracked clean-room file" {:line line})))
       (let [p (subs line 3)]
         (when-not (or (str/starts-with? p "impl/")
                       (str/starts-with? p ".builder/"))
           (throw (ex-info (str "builder wrote outside declared scope: " p) {:path p}))))))))

(defn gate-room-for
  "Create or reconcile an immutable per-attempt gate copy of the fenced room."
  [{:keys [scratch room digest-candidate]} attempt digest]
  (let [base (plat/path scratch (str "gate-" attempt))
        gate-room (plat/path base "room")
        marker (plat/path base "copy.json")]
    (when (and (plat/exists? gate-room) (not (plat/exists? marker)))
      (throw (ex-info "gate-room copy was interrupted; inspect its scratch directory" {:base base})))
    (if-not (plat/exists? gate-room)
      (do
        (plat/create-dirs base)
        (plat/copy-tree room gate-room)
        (when-not (= (digest-candidate gate-room) digest)
          (throw (ex-info "gate copy differs from candidate" {:gate-room gate-room})))
        (hjson/spit-utf8 marker (hjson/compact-json {"candidateSha256" digest})))
      (let [recorded (hjson/read-json (plat/read-text marker))
            intent (plat/path scratch (str "gate-" attempt "-evidence") "intent.json")]
        (when (or (not= (get recorded "candidateSha256") digest)
                  (and (not (plat/exists? intent))
                       (not= (digest-candidate gate-room) digest)))
          (throw (ex-info "gate-room copy receipt differs from candidate" {:gate-room gate-room})))))
    gate-room))

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
   :candidate-digest (fn
                       ([] (digest-candidate room))
                       ([candidate-room] (digest-candidate candidate-room)))
   :clear-builder-test-artifacts (fn [] (clear-builder-test-artifacts room))
   :verify-builder-scope (fn
                           ([] (verify-builder-scope room true))
                           ([req?] (verify-builder-scope room req?)))
   :gate-room-for (fn [attempt digest]
                    (gate-room-for {:scratch scratch :room room :digest-candidate digest-candidate}
                                   attempt digest))
   :measure-log (fn [name run-fn] (measure-log scratch name run-fn))
   :root root
   :scratch scratch})
