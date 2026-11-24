(ns loyly.spike.digest
  "Shared digests and git helpers — clj-commons.digest + babashka.process/fs."
  (:require [babashka.fs :as fs]
            [babashka.process :as p]
            [clj-commons.digest :as digest]
            [clojure.string :as str])
  (:import [java.nio.file Files LinkOption]
           [java.security MessageDigest]))

(defn hex
  "Lowercase hex for raw digest bytes (tree-digest MessageDigest path)."
  [^bytes bs]
  (apply str (map #(format "%02x" (bit-and % 0xff)) bs)))

(defn sha256-bytes [^bytes bs]
  (digest/sha-256 bs))

(defn sha256-string [^String s]
  (digest/sha-256 s))

(defn file-sha256 [path]
  (digest/sha-256 (fs/file path)))

(defn git
  "Run git -C path args…; throw on non-zero. Return trimmed stdout."
  [path & args]
  (let [{:keys [exit out err]}
        @(p/process (into ["git" "-C" (str (fs/path path))] args)
                    {:out :string :err :string})]
    (when-not (zero? exit)
      (throw (ex-info (str "git " (str/join " " args) " failed at " path)
                      {:path (str path) :err err :exit exit})))
    (str/trim out)))

(defn- unix-mode
  "Octal permission bits matching Node fs.lstatSync().mode & 0o777."
  [file]
  (try
    (bit-and (int (Files/getAttribute (fs/path file) "unix:mode"
                                      (into-array LinkOption [LinkOption/NOFOLLOW_LINKS])))
             0777)
    (catch Exception _
      0644)))

(defn tree-digest
  "Port of grading-room treeDigest: path + mode + bytes, sorted walk."
  [root prefix]
  (let [digest (MessageDigest/getInstance "SHA-256")]
    (letfn [(walk [dir current-prefix]
              (doseq [name (sort (map fs/file-name (fs/list-dir dir)))]
                (let [path (str current-prefix "/" name)
                      file (fs/path dir name)
                      attrs (Files/readAttributes
                             file
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
                      (.update digest (fs/read-all-bytes file))
                      (.update digest (byte-array [0])))
                    :else
                    (throw (ex-info (str "candidate has a symlink or special file: " path)
                                    {:path path}))))))]
      (walk (fs/path root) prefix)
      (hex (.digest digest)))))
