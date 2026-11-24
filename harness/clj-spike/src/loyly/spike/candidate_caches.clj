(ns loyly.spike.candidate-caches
  "PoC port of Codex/Cursor checkCandidateCaches — sealed package-cache guard."
  (:require [babashka.fs :as fs]
            [clojure.string :as str]))

(def DISPOSABLE-CACHE-DIRS
  #{".npm-cache" ".npm" ".m2" ".uv-cache" ".cache" ".gradle" "node_modules"})

(defn check-candidate-caches
  "Walk room/impl; throw if disposable caches found (unless post-gate node_modules)."
  [room & {:keys [mode] :or {mode "sealed"}}]
  (when-not (#{"sealed" "post-gate"} mode)
    (throw (ex-info (str "invalid candidate cache mode: " mode) {:mode mode})))
  (let [room (str (fs/absolutize room))
        candidate (fs/path room "impl")]
    (when-not (fs/directory? candidate)
      (throw (ex-info (str "candidate impl directory missing: " candidate) {})))
    (letfn [(walk [dir relative]
              (doseq [child (fs/list-dir dir)]
                (let [name (fs/file-name child)
                      path (if (str/blank? relative) name (str relative "/" name))]
                  (cond
                    (and (fs/directory? child)
                         (= name "node_modules")
                         (= mode "post-gate"))
                    (walk child path)

                    (and (fs/directory? child) (contains? DISPOSABLE-CACHE-DIRS name))
                    (throw (ex-info
                            (str "candidate contains disposable package cache impl/" path)
                            {:path path}))

                    (fs/directory? child)
                    (walk child path)

                    (not (fs/regular-file? child))
                    (throw (ex-info
                            (str "candidate contains special file impl/" path)
                            {:path path}))))))]
      (walk candidate ""))
    {"room" room "mode" mode "cacheFree" true}))
