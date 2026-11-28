(ns loyly.candidate-caches
  "PoC port of Codex/Cursor checkCandidateCaches — sealed package-cache guard."
  (:require [clojure.string :as str]
            [loyly.platform :as plat]))

(def DISPOSABLE-CACHE-DIRS
  #{".npm-cache" ".npm" ".m2" ".uv-cache" ".cache" ".gradle" "node_modules"})

(defn check-candidate-caches
  "Walk room/impl; throw if disposable caches found (unless post-gate node_modules)."
  [room & {:keys [mode] :or {mode "sealed"}}]
  (when-not (#{"sealed" "post-gate"} mode)
    (throw (ex-info (str "invalid candidate cache mode: " mode) {:mode mode})))
  (let [room (str (plat/absolutize room))
        candidate (plat/path room "impl")]
    (when-not (plat/directory? candidate)
      (throw (ex-info (str "candidate impl directory missing: " candidate) {})))
    (letfn [(walk [dir relative]
              (doseq [child (plat/list-dir dir)]
                (let [name (plat/file-name child)
                      path (if (str/blank? relative) name (str relative "/" name))]
                  (cond
                    (and (plat/directory? child)
                         (= name "node_modules")
                         (= mode "post-gate"))
                    (walk child path)

                    (and (plat/directory? child) (contains? DISPOSABLE-CACHE-DIRS name))
                    (throw (ex-info
                            (str "candidate contains disposable package cache impl/" path)
                            {:path path}))

                    (plat/directory? child)
                    (walk child path)

                    (not (plat/regular-file? child))
                    (throw (ex-info
                            (str "candidate contains special file impl/" path)
                            {:path path}))))))]
      (walk candidate ""))
    {"room" room "mode" mode "cacheFree" true}))
