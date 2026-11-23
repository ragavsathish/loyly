(ns loyly.spike.stamp-item-ids
  "PoC port of harness/stamp_item_ids.clj (stamp parity for the TS→CLJ spike)."
  (:require [clojure.java.io :as io]
            [clojure.string :as str]
            [loyly.spike.hjson :as hjson]))

(def scenario-line #"^\s*Scenario(?: Outline)?:")
(def item-tag #"@item-\d+-(\d+)")

(defn- slice-of [f]
  (re-find #"^[^-]*" (.getName (.getParentFile f))))

(defn- next-number [lines]
  (inc (reduce max 0 (map #(Long/parseLong (second %))
                          (mapcat #(re-seq item-tag %) lines)))))

(defn- stamped? [lines i]
  (loop [j (dec i)]
    (if (and (>= j 0) (str/starts-with? (str/trim (nth lines j)) "@"))
      (if (re-find item-tag (nth lines j)) true (recur (dec j)))
      false)))

(defn- stamp-text [text slice]
  (let [lines (str/split text #"\n" -1)]
    (loop [i 0, out [], n (next-number lines), added 0]
      (if (= i (count lines))
        [(str/join "\n" out) added]
        (let [line (nth lines i)]
          (if (and (re-find scenario-line line) (not (stamped? lines i)))
            (recur (inc i)
                   (conj out (str (re-find #"^\s*" line)
                                  "@item-" slice "-" (format "%03d" n))
                         line)
                   (inc n) (inc added))
            (recur (inc i) (conj out line) n added)))))))

(defn- parse-args [args]
  (let [args (vec args)
        root (or (second (drop-while #(not= "--root" %) args)) ".")]
    {:root (.getCanonicalFile (io/file root))}))

(defn stamp
  "Stamp unstamped scenarios under root. Returns {:total n}."
  [{:keys [root]}]
  (let [root (io/file root)
        files (hjson/spec-files root)]
    (if (empty? files)
      (do (hjson/out (str "stamp: no NN-slug/spec.feature under " (hjson/plan-dir root)
                          ": nothing to stamp yet.\n"
                          "       (the spec is written first; stamping is idempotent, run it again then)\n"))
          {:total 0})
      (let [total (reduce
                   (fn [total f]
                     (let [text (slurp f :encoding "UTF-8")
                           [new-text added] (stamp-text text (slice-of f))]
                       (when (pos? added)
                         (hjson/spit-utf8 f new-text)
                         (hjson/out (str "stamped " (hjson/ralign added 3)
                                         "  " (hjson/rel root f) "\n")))
                       (+ total added)))
                   0 files)]
        (hjson/out (str "total stamped: " total "\n"))
        {:total total}))))

(defn -main [& args]
  (stamp (parse-args args))
  nil)
