(ns loyly.platform
  "Cross-platform runtime primitives shared by Babashka (:clj) and Node nbb (:cljs).

  Keeps all domain, evidence, measure, contract, and adapter logic portable as .cljc
  while Node async workflows and JS backends live in loyly.node.* (.cljs)."
  #?(:cljs (:refer-clojure :exclude [exists?]))
  (:require [clojure.string :as str]
            #?@(:clj [[babashka.fs :as fs]
                      [babashka.process :as p]
                      [cheshire.core :as json]
                      [clj-commons.digest :as digest]]
                :cljs [["node:child_process" :as node-cp]
                       ["node:crypto" :as node-crypto]
                       ["node:fs" :as node-fs]
                       ["node:os" :as node-os]
                       ["node:path" :as node-path]
                       ["node:process" :as node-proc]]))
  #?(:clj (:import [java.io OutputStream]
                   [java.math BigDecimal RoundingMode]
                   [java.net URLDecoder URLEncoder]
                   [java.nio.file Files LinkOption]
                   [java.nio.file.attribute BasicFileAttributes]
                   [java.security MessageDigest]
                   [java.util UUID])))

;; ---------------------------------------------------------------- regex / text

(defn re-flags
  "Compile a portable regex with flags string (e.g. \"i\", \"m\", \"is\")."
  [flags pattern]
  #?(:clj (re-pattern (str "(?" flags ")" pattern))
     :cljs (js/RegExp. pattern flags)))

(defn pad-left-zero
  "Format integer `n` zero-padded on the left to `width` digits."
  [n width]
  (let [s (str n)
        pad (max 0 (- width (count s)))]
    (str (apply str (repeat pad "0")) s)))

(defn hex-4
  "Format integer char code as 4-digit lowercase hex (for JSON \\uXXXX)."
  [code]
  #?(:clj (format "%04x" (int code))
     :cljs (let [h (.toString code 16)]
             (str (apply str (repeat (max 0 (- 4 (count h))) "0")) h))))

(defn parse-long-strict
  "Parse base-10 integer string or throw ex-info."
  [s]
  (let [s (str s)]
    (when-not (re-matches #"-?\d+" s)
      (throw (ex-info (str "invalid integer: " (pr-str s)) {:value s})))
    #?(:clj (Long/parseLong s)
       :cljs (let [n (js/parseInt s 10)]
               (when (js/Number.isNaN n)
                 (throw (ex-info (str "invalid integer: " (pr-str s)) {:value s})))
               n))))

(defn parse-double-strict
  "Parse JSON/floating-point number string or throw ex-info."
  [s]
  #?(:clj (Double/parseDouble (str s))
     :cljs (let [n (js/Number s)]
             (when-not (js/Number.isFinite n)
               (throw (ex-info (str "invalid number: " (pr-str s)) {:value s})))
             n)))

(defn round-half-even-1
  "Format (100 * n / d) rounded HALF_EVEN to 1 decimal place (matches scoreboard oracle)."
  [n d]
  #?(:clj (-> (BigDecimal. (double (/ (* 100.0 n) d)))
              (.setScale 1 RoundingMode/HALF_EVEN)
              (.toPlainString))
     :cljs (let [scaled (/ (* 1000.0 n) d)
                 fl (js/Math.floor scaled)
                 frac (- scaled fl)
                 rounded (cond
                           (> frac 0.5) (inc fl)
                           (< frac 0.5) fl
                           (even? (long fl)) fl
                           :else (inc fl))]
             (.toFixed (/ rounded 10.0) 1))))

(defn url-encode [s]
  #?(:clj (URLEncoder/encode (str s) "UTF-8")
     :cljs (-> (js/encodeURIComponent (str s))
               (str/replace "%20" "+"))))

(defn url-decode [s]
  #?(:clj (URLDecoder/decode (str s) "UTF-8")
     :cljs (js/decodeURIComponent (str/replace (str s) "+" " "))))

(defn random-uuid-str []
  #?(:clj (str (UUID/randomUUID))
     :cljs (.randomUUID node-crypto)))

(defn now-ms []
  #?(:clj (System/currentTimeMillis)
     :cljs (js/Date.now)))

(defn sleep-ms [ms]
  #?(:clj (Thread/sleep (long ms))
     :cljs (let [end (+ (js/Date.now) ms)]
             (while (< (js/Date.now) end) nil))))

;; ---------------------------------------------------------------- paths / fs

(defn path
  "Join path segments into a normalized path string."
  [& parts]
  #?(:clj (str (apply fs/path (map str parts)))
     :cljs (apply (.-join node-path) (map str parts))))

(defn absolutize [p]
  #?(:clj (str (fs/absolutize (str p)))
     :cljs (.resolve node-path (str p))))

(defn real-path [p]
  #?(:clj (str (fs/real-path (str p)))
     :cljs (.realpathSync node-fs (str p))))

(defn absolute? [p]
  #?(:clj (fs/absolute? (str p))
     :cljs (.isAbsolute node-path (str p))))

(defn parent [p]
  #?(:clj (some-> (fs/parent (str p)) str)
     :cljs (let [s (str p)
                 d (.dirname node-path s)]
             (when-not (= d s) d))))

(defn file-name [p]
  #?(:clj (fs/file-name (str p))
     :cljs (.basename node-path (str p))))

(defn relativize [base target]
  #?(:clj (-> (fs/relativize (fs/path (str base)) (fs/path (str target)))
              str
              (str/replace "\\" "/"))
     :cljs (-> (.relative node-path (str base) (str target))
               (str/replace "\\" "/"))))

(defn cwd []
  #?(:clj (str (fs/cwd))
     :cljs (.cwd node-proc)))

(defn temp-dir []
  #?(:clj (str (fs/temp-dir))
     :cljs (.tmpdir node-os)))

(defn exists? [p]
  #?(:clj (fs/exists? (str p))
     :cljs (.existsSync node-fs (str p))))

(defn regular-file? [p]
  #?(:clj (fs/regular-file? (str p))
     :cljs (try
             (.isFile (.statSync node-fs (str p)))
             (catch :default _ false))))

(defn directory? [p]
  #?(:clj (fs/directory? (str p))
     :cljs (try
             (.isDirectory (.statSync node-fs (str p)))
             (catch :default _ false))))

(defn list-dir [dir]
  #?(:clj (mapv str (fs/list-dir (str dir)))
     :cljs (mapv #(path dir %) (js->clj (.readdirSync node-fs (str dir))))))

(defn size [p]
  #?(:clj (fs/size (str p))
     :cljs (.-size (.statSync node-fs (str p)))))

(defn lstat-kind
  "Return :dir, :file, or :other without following symlinks."
  [p]
  #?(:clj (let [attrs (Files/readAttributes
                       (fs/path (str p))
                       BasicFileAttributes
                       (into-array LinkOption [LinkOption/NOFOLLOW_LINKS]))]
            (cond
              (.isDirectory attrs) :dir
              (.isRegularFile attrs) :file
              :else :other))
     :cljs (let [st (.lstatSync node-fs (str p))]
             (cond
               (.isDirectory st) :dir
               (.isFile st) :file
               :else :other))))

(defn unix-mode
  "Octal permission bits matching Node fs.lstatSync().mode & 0o777."
  [p]
  #?(:clj (try
            (bit-and (int (Files/getAttribute (fs/path (str p)) "unix:mode"
                                              (into-array LinkOption [LinkOption/NOFOLLOW_LINKS])))
                     0777)
            (catch Exception _ 0644))
     :cljs (bit-and (.-mode (.lstatSync node-fs (str p))) 0777)))

(defn create-dirs [dir]
  (when dir
    #?(:clj (fs/create-dirs (str dir))
       :cljs (.mkdirSync node-fs (str dir) #js {:recursive true})))
  dir)

(defn copy [src dst]
  (when-let [d (parent dst)]
    (create-dirs d))
  #?(:clj (fs/copy (str src) (str dst) {:replace-existing true})
     :cljs (.copyFileSync node-fs (str src) (str dst)))
  dst)

(defn copy-tree [src dst]
  #?(:clj (fs/copy-tree (str src) (str dst))
     :cljs (.cpSync node-fs (str src) (str dst) #js {:recursive true}))
  dst)

(defn move [src dst]
  #?(:clj (fs/move (str src) (str dst) {:replace-existing true})
     :cljs (.renameSync node-fs (str src) (str dst)))
  dst)

(defn delete-tree [p]
  #?(:clj (fs/delete-tree (str p))
     :cljs (.rmSync node-fs (str p) #js {:recursive true :force true}))
  nil)

(defn set-executable! [p]
  #?(:clj (fs/set-posix-file-permissions (str p) "rwxr-xr-x")
     :cljs (.chmodSync node-fs (str p) 0755))
  p)

(defn read-text [p]
  #?(:clj (slurp (str p) :encoding "UTF-8")
     :cljs (.readFileSync node-fs (str p) "utf8")))

(defn write-text [p text]
  (when-let [d (parent p)]
    (create-dirs d))
  #?(:clj (spit (str p) (str text) :encoding "UTF-8")
     :cljs (.writeFileSync node-fs (str p) (str text) "utf8"))
  p)

(defn read-bytes [p]
  #?(:clj (fs/read-all-bytes (str p))
     :cljs (.readFileSync node-fs (str p))))

(defn bytes->utf8 [bs]
  #?(:clj (String. ^bytes bs "UTF-8")
     :cljs (.toString bs "utf8")))

(defn byte-length [bs]
  #?(:clj (alength ^bytes bs)
     :cljs (.-length bs)))

(defn bytes-equal? [a b]
  #?(:clj (java.util.Arrays/equals ^bytes a ^bytes b)
     :cljs (.equals a b)))

;; ---------------------------------------------------------------- crypto / json

#?(:clj
   (defn- hex-bytes [^bytes bs]
     (apply str (map #(format "%02x" (bit-and % 0xff)) bs))))

(defn sha256-string [s]
  #?(:clj (digest/sha-256 (str s))
     :cljs (-> (.createHash node-crypto "sha256")
               (.update (str s) "utf8")
               (.digest "hex"))))

(defn file-sha256 [p]
  #?(:clj (digest/sha-256 (fs/file (str p)))
     :cljs (-> (.createHash node-crypto "sha256")
               (.update (.readFileSync node-fs (str p)))
               (.digest "hex"))))

(defn digest-files
  "SHA-256 over sorted regular files in `dir` matching `expected-files`."
  [dir expected-files]
  #?(:clj (let [md (MessageDigest/getInstance "SHA-256")]
            (doseq [name (sort (map file-name (list-dir dir)))]
              (when (or (not (contains? expected-files name))
                        (not (regular-file? (path dir name))))
                (throw (ex-info (str "unexpected Allure result entry: " name) {:name name})))
              (.update md (.getBytes name "UTF-8"))
              (.update md (byte-array [0]))
              (.update md ^bytes (read-bytes (path dir name)))
              (.update md (byte-array [0])))
            (hex-bytes (.digest md)))
     :cljs (let [hash (.createHash node-crypto "sha256")
                 nul (.from js/Buffer #js [0])]
             (doseq [name (sort (map file-name (list-dir dir)))]
               (when (or (not (contains? expected-files name))
                         (not (regular-file? (path dir name))))
                 (throw (ex-info (str "unexpected Allure result entry: " name) {:name name})))
               (.update hash name "utf8")
               (.update hash nul)
               (.update hash (.readFileSync node-fs (path dir name)))
               (.update hash nul))
             (.digest hash "hex"))))

(defn tree-digest
  "Port of grading-room treeDigest: path + mode + bytes, sorted walk."
  [root prefix]
  #?(:clj (let [md (MessageDigest/getInstance "SHA-256")]
            (letfn [(walk [dir current-prefix]
                      (doseq [name (sort (map file-name (list-dir dir)))]
                        (let [rel-path (str current-prefix "/" name)
                              file (path dir name)
                              kind (lstat-kind file)]
                          (case kind
                            :dir (walk file rel-path)
                            :file
                            (do
                              (.update md (.getBytes rel-path "UTF-8"))
                              (.update md (byte-array [0]))
                              (.update md (.getBytes (str (unix-mode file)) "UTF-8"))
                              (.update md (byte-array [0]))
                              (.update md ^bytes (read-bytes file))
                              (.update md (byte-array [0])))
                            (throw (ex-info (str "candidate has a symlink or special file: " rel-path)
                                            {:path rel-path}))))))]
              (walk root prefix)
              (hex-bytes (.digest md))))
     :cljs (let [hash (.createHash node-crypto "sha256")
                 nul (.from js/Buffer #js [0])]
             (letfn [(walk [dir current-prefix]
                       (doseq [name (sort (map file-name (list-dir dir)))]
                         (let [rel-path (str current-prefix "/" name)
                               file (path dir name)
                               kind (lstat-kind file)]
                           (case kind
                             :dir (walk file rel-path)
                             :file
                             (do
                               (.update hash rel-path "utf8")
                               (.update hash nul)
                               (.update hash (str (unix-mode file)) "utf8")
                               (.update hash nul)
                               (.update hash (.readFileSync node-fs file))
                               (.update hash nul))
                             (throw (ex-info (str "candidate has a symlink or special file: " rel-path)
                                             {:path rel-path}))))))]
               (walk root prefix)
               (.digest hash "hex")))))

#?(:cljs
   (defn- clj->js-ordered [v]
     (cond
       (nil? v) nil
       (or (boolean? v) (number? v) (string? v)) v
       (keyword? v) (name v)
       (map? v) (let [obj #js {}]
                  (doseq [[k val] v]
                    (aset obj (if (keyword? k) (name k) (str k))
                          (clj->js-ordered val)))
                  obj)
       (coll? v) (let [arr #js []]
                   (doseq [x v]
                     (.push arr (clj->js-ordered x)))
                   arr)
       :else v)))

(defn compact-json
  "Compact JSON preserving map key order."
  [v]
  #?(:clj (json/generate-string v)
     :cljs (js/JSON.stringify (clj->js-ordered v))))

(defn parse-json-native
  "Parse JSON string into Clojure string-keyed maps/vectors."
  [s]
  #?(:clj (json/parse-string s)
     :cljs (js->clj (js/JSON.parse s))))

;; ---------------------------------------------------------------- proc / stdio

(defn exec-sync
  "Run a command synchronously and return {:exit :out :err}."
  ([cmd-vec] (exec-sync cmd-vec {}))
  ([cmd-vec {:keys [dir env]}]
   #?(:clj (let [opts (cond-> {:out :string :err :string}
                        dir (assoc :dir (str dir))
                        env (assoc :env env))
                 res @(p/process (vec cmd-vec) opts)]
             {:exit (:exit res) :out (:out res) :err (:err res)})
      :cljs (let [[bin & args] (vec cmd-vec)
                  opts (cond-> #js {:encoding "utf8"}
                         dir (doto (aset "cwd" (str dir)))
                         env (doto (aset "env" (clj->js-ordered env))))
                  res (.spawnSync node-cp bin (clj->js args) opts)]
              {:exit (if (nil? (.-status res)) 1 (.-status res))
               :out (or (.-stdout res) "")
               :err (or (.-stderr res) "")}))))

(defn getenv
  "Return environment map (0-arity) or single env var string (1-arity)."
  ([]
   #?(:clj (into {} (System/getenv))
      :cljs (js->clj (.-env node-proc))))
  ([k]
   #?(:clj (System/getenv (str k))
      :cljs (aget (.-env node-proc) (str k)))))

(defn out [s]
  #?(:clj (let [b (.getBytes (str s) "UTF-8")]
            (.write ^OutputStream System/out b 0 (alength b))
            (.flush ^OutputStream System/out))
     :cljs (.write (.-stdout node-proc) (str s))))

(defn err [s]
  #?(:clj (let [b (.getBytes (str s) "UTF-8")]
            (.write ^OutputStream System/err b 0 (alength b))
            (.flush ^OutputStream System/err))
     :cljs (.write (.-stderr node-proc) (str s))))

(defn exit! [code]
  #?(:clj (System/exit (int code))
     :cljs (.exit node-proc code)))
