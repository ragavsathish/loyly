(ns loyly.digest
  "Shared digests and git helpers — portable across Babashka (:clj) and Node nbb (:cljs)."
  (:require [clojure.string :as str]
            [loyly.platform :as plat]))

(defn sha256-string [s]
  (plat/sha256-string s))

(defn file-sha256 [path]
  (plat/file-sha256 path))

(defn git
  "Run git -C path args…; throw on non-zero. Return trimmed stdout."
  [path & args]
  (let [{:keys [exit out err]}
        (plat/exec-sync (into ["git" "-C" (plat/path path)] args))]
    (when-not (zero? exit)
      (throw (ex-info (str "git " (str/join " " args) " failed at " path)
                      {:path (str path) :err err :exit exit})))
    (str/trim out)))

(defn tree-digest
  "Port of grading-room treeDigest: path + mode + bytes, sorted walk."
  [root prefix]
  (plat/tree-digest root prefix))

(defn digest-files
  "SHA-256 over sorted expected files in a directory."
  [dir expected-files]
  (plat/digest-files dir expected-files))
