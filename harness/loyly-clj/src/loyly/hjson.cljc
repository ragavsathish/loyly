(ns loyly.hjson
  "JSON + plumbing for loyly-clj (.cljc).

  Pretty write + order-preserving read stay hand-rolled: checklist/score byte
  shape (@harness-012) and key order (@harness-029) are contracts default JSON
  serializers do not honour. Compact JSON and filesystem helpers delegate to
  loyly.platform."
  (:require [clojure.string :as str]
            [loyly.platform :as plat]))

;; ---------------------------------------------------------------- char helpers

(defn- char-at [s i]
  #?(:clj (.charAt ^String s i)
     :cljs (.charAt s i)))

(defn- char-code [c]
  #?(:clj (int c)
     :cljs (.charCodeAt c 0)))

(defn- hex->char [hex]
  #?(:clj (char (Integer/parseInt hex 16))
     :cljs (js/String.fromCharCode (js/parseInt hex 16))))

(defn- ws-char? [c]
  #?(:clj (Character/isWhitespace ^Character c)
     :cljs (boolean (re-matches #"\s" c))))

;; ---------------------------------------------------------------- writing

(def ^:private escapes
  #?(:clj {\\ "\\\\", \" "\\\"", \backspace "\\b", \formfeed "\\f",
           \newline "\\n", \return "\\r", \tab "\\t"}
     :cljs {"\\" "\\\\", "\"" "\\\"", "\b" "\\b", "\f" "\\f",
            "\n" "\\n", "\r" "\\r", "\t" "\\t"}))

(defn- write-string [s]
  (let [s (str s)
        n (count s)
        out (loop [i 0 acc []]
              (if (< i n)
                (let [c (char-at s i)
                      code (char-code c)
                      part (or (escapes c)
                               (if (< code 0x20)
                                 (str "\\u" (plat/hex-4 code))
                                 (str c)))]
                  (recur (inc i) (conj acc part)))
                (str/join acc)))]
    (str "\"" out "\"")))

(defn- indent [n] (str/join (repeat n " ")))

(defn write
  "Render `v` as JSON text, one space of indent per level, no trailing newline."
  ([v] (write v 0))
  ([v level]
   (cond
     (nil? v)     "null"
     (true? v)    "true"
     (false? v)   "false"
     (string? v)  (write-string v)
     (keyword? v) (write-string (name v))
     (number? v)  (str v)
     (map? v)     (if (empty? v)
                    "{}"
                    (str "{\n"
                         (str/join ",\n"
                                   (for [[k val] v]
                                     (str (indent (inc level))
                                          (write-string (if (keyword? k) (name k) (str k)))
                                          ": "
                                          (write val (inc level)))))
                         "\n" (indent level) "}"))
     (sequential? v) (if (empty? v)
                       "[]"
                       (str "[\n"
                            (str/join ",\n"
                                      (for [x v]
                                        (str (indent (inc level)) (write x (inc level)))))
                            "\n" (indent level) "]"))
     :else (throw (ex-info (str "cannot render " (pr-str v) " as JSON") {})))))

;; ---------------------------------------------------------------- reading

(defn- fail [_s i msg]
  (throw (ex-info (str msg " at position " i) {:json/detail (str msg " at position " i)})))

(declare read-value)

(defn- skip-ws [s i]
  (let [n (count s)]
    (loop [i i]
      (if (and (< i n) (ws-char? (char-at s i)))
        (recur (inc i))
        i))))

(def ^:private quote-ch #?(:clj \" :cljs "\""))
(def ^:private slash-ch #?(:clj \\ :cljs "\\"))
(def ^:private lbrace-ch #?(:clj \{ :cljs "{"))
(def ^:private rbrace-ch #?(:clj \} :cljs "}"))
(def ^:private lbrack-ch #?(:clj \[ :cljs "["))
(def ^:private rbrack-ch #?(:clj \] :cljs "]"))
(def ^:private comma-ch #?(:clj \, :cljs ","))
(def ^:private colon-ch #?(:clj \: :cljs ":"))
(def ^:private t-ch #?(:clj \t :cljs "t"))
(def ^:private f-ch #?(:clj \f :cljs "f"))
(def ^:private n-ch #?(:clj \n :cljs "n"))

(defn- read-string-lit [s i]
  (let [n (count s)]
    (loop [i (inc i) acc []]
      (when (>= i n) (fail s i "unterminated string"))
      (let [c (char-at s i)]
        (cond
          (= c quote-ch) [(str/join acc) (inc i)]
          (= c slash-ch)
          (let [e (when (< (inc i) n) (str (char-at s (inc i))))]
            (case e
              "\"" (recur (+ i 2) (conj acc "\""))
              "\\" (recur (+ i 2) (conj acc "\\"))
              "/"  (recur (+ i 2) (conj acc "/"))
              "b"  (recur (+ i 2) (conj acc "\b"))
              "f"  (recur (+ i 2) (conj acc "\f"))
              "n"  (recur (+ i 2) (conj acc "\n"))
              "r"  (recur (+ i 2) (conj acc "\r"))
              "t"  (recur (+ i 2) (conj acc "\t"))
              "u"  (if (< (+ i 5) n)
                     (recur (+ i 6)
                            (conj acc (str (hex->char (subs s (+ i 2) (+ i 6))))))
                     (fail s i "truncated \\u escape"))
              (fail s i (str "invalid escape " (pr-str e)))))
          :else (recur (inc i) (conj acc (str c))))))))

(defn- read-number [s i]
  (let [n (count s)
        end (loop [j i]
              (if (and (< j n)
                       (re-matches #"[-+0-9.eE]" (str (char-at s j))))
                (recur (inc j))
                j))
        text (subs s i end)]
    (when (= i end) (fail s i (str "unexpected character '" (char-at s i) "'")))
    (if (re-matches #"-?\d+" text)
      [(plat/parse-long-strict text) end]
      (try [(plat/parse-double-strict text) end]
           (catch #?(:clj Exception :cljs :default) _
             (fail s i (str "invalid number " (pr-str text))))))))

(defn- read-seq
  "Shared body of array and object reading: `close` ends it, `element` reads one."
  [s i close element]
  (let [n (count s)]
    (loop [i (skip-ws s (inc i)) acc []]
      (when (>= i n) (fail s i "unexpected end of input"))
      (if (= (char-at s i) close)
        [acc (inc i)]
        (let [[parts i] (element s i)
              i (skip-ws s i)]
          (when (>= i n) (fail s i "unexpected end of input"))
          (condp = (char-at s i)
            comma-ch (recur (skip-ws s (inc i)) (into acc parts))
            close    [(into acc parts) (inc i)]
            (fail s i (str "unexpected character '" (char-at s i) "'"))))))))

(defn- read-pair [s i]
  (when-not (= (char-at s i) quote-ch) (fail s i "expected a key"))
  (let [[k i] (read-string-lit s i)
        i (skip-ws s i)]
    (when-not (and (< i (count s)) (= (char-at s i) colon-ch)) (fail s i "expected ':'"))
    (let [[v i] (read-value s (skip-ws s (inc i)))]
      [[k v] i])))

(defn- read-value [s i]
  (let [n (count s)]
    (when (>= i n) (fail s i "unexpected end of input"))
    (let [c (char-at s i)]
      (cond
        (= c lbrace-ch) (let [[kvs i] (read-seq s i rbrace-ch read-pair)]
                          [(apply array-map kvs) i])
        (= c lbrack-ch) (let [[xs i] (read-seq s i rbrack-ch
                                               (fn [s i] (let [[v i] (read-value s i)] [[v] i])))]
                          [xs i])
        (= c quote-ch)  (read-string-lit s i)
        (and (= c t-ch) (= "true" (subs s i (min n (+ i 4)))))   [true (+ i 4)]
        (and (= c f-ch) (= "false" (subs s i (min n (+ i 5)))))  [false (+ i 5)]
        (and (= c n-ch) (= "null" (subs s i (min n (+ i 4)))))   [nil (+ i 4)]
        :else (read-number s i)))))

(defn read-json
  "Parse JSON text. Throws ex-info carrying :json/detail on malformed input."
  [s]
  (let [[v i] (read-value s (skip-ws s 0))
        i (skip-ws s i)]
    (when (< i (count s))
      (fail s i (str "trailing data '" (char-at s i) "'")))
    v))

(defn compact-json
  "Compact JSON preserving map key order."
  [v]
  (plat/compact-json v))

(defn detail
  "The parser's own words about a failure, for the one message that carries them."
  [e]
  (or (:json/detail (ex-data e)) (ex-message e)))

(defn type-name
  "The Python type names, which @harness-035 fixes as contract."
  [v]
  (cond (map? v) "dict" (string? v) "str" (nil? v) "NoneType"
        (or (true? v) (false? v)) "bool" (number? v) "int" :else "list"))

;; ---------------------------------------------------------------- plumbing

(defn rel
  "`f` as a path relative to `root`, with forward slashes."
  [root f]
  (plat/relativize root f))

(defn spec-files
  "Every docs/plan/[0-9]*/spec.feature under `root`, sorted by path as text."
  [root]
  (->> (plat/list-dir (plat/path root "docs" "plan"))
       (filter plat/directory?)
       (filter #(re-find #"^[0-9]" (plat/file-name %)))
       (map #(plat/path % "spec.feature"))
       (filter plat/regular-file?)
       (sort-by #(rel root %))))

(defn plan-dir [root] (plat/path root "docs" "plan"))

(defn out [s] (plat/out s))
(defn err [s] (plat/err s))

(defn refuse
  "A refusal: the message to stderr with one trailing newline, then exit 1."
  [msg]
  (err (str msg "\n"))
  (plat/exit! 1))

(defn spit-utf8
  "Write `text` to `f`, creating missing parent directories."
  [f text]
  (plat/write-text f text))

(defn ralign [s w]
  (let [s (str s)]
    (str (str/join (repeat (max 0 (- w (count s))) " ")) s)))
