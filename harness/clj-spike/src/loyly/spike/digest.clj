(ns loyly.spike.digest
  "Shared SHA-256 helpers for the TS→CLJ spike."
  (:require [clojure.java.io :as io]
            [clojure.java.shell :as sh]
            [clojure.string :as str])
  (:import [java.nio.file Files LinkOption]
           [java.security MessageDigest]))

(defn hex [^bytes bs]
  (str/join (map #(format "%02x" (bit-and % 0xff)) bs)))

(defn sha256-bytes [^bytes bs]
  (hex (.digest (MessageDigest/getInstance "SHA-256") bs)))

(defn sha256-string [^String s]
  (sha256-bytes (.getBytes s "UTF-8")))

(defn file-sha256 [path]
  (sha256-bytes (.readAllBytes (io/input-stream (io/file path)))))

(defn git
  "Run git -C path args…; throw on non-zero. Return trimmed stdout."
  [path & args]
  (let [{:keys [exit out err]} (apply sh/sh "git" "-C" (str path) args)]
    (when-not (zero? exit)
      (throw (ex-info (str "git " (str/join " " args) " failed at " path)
                      {:path path :err err :exit exit})))
    (str/trim out)))

(defn- unix-mode [file]
  "Octal permission bits matching Node fs.lstatSync().mode & 0o777."
  (try
    (bit-and (int (Files/getAttribute (.toPath (io/file file)) "unix:mode"
                                      (into-array LinkOption [LinkOption/NOFOLLOW_LINKS])))
             0777)
    (catch Exception _
      0644)))

(defn tree-digest
  "Port of grading-room treeDigest: path + mode + bytes, sorted walk."
  [root prefix]
  (let [digest (MessageDigest/getInstance "SHA-256")]
    (letfn [(walk [dir current-prefix]
              (doseq [name (sort (.list (io/file dir)))]
                (let [path (str current-prefix "/" name)
                      file (io/file dir name)
                      attrs (Files/readAttributes
                             (.toPath file)
                             java.nio.file.attribute.BasicFileAttributes
                             (into-array LinkOption [LinkOption/NOFOLLOW_LINKS]))]
                  (cond
                    (.isDirectory attrs) (walk file path)
                    (.isRegularFile attrs)
                    (do
                      (.update digest (.getBytes path "UTF-8"))
                      (.update digest (byte-array [0]))
                      (.update digest (.getBytes (str (unix-mode file)) "UTF-8"))
                      (.update digest (byte-array [0]))
                      (.update digest (.readAllBytes (io/input-stream file)))
                      (.update digest (byte-array [0])))
                    :else
                    (throw (ex-info (str "candidate has a symlink or special file: " path)
                                    {:path path}))))))]
      (walk (io/file root) prefix)
      (hex (.digest digest)))))
