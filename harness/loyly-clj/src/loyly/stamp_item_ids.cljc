(ns loyly.stamp-item-ids
  "Port of harness/stamp_item_ids.clj (.cljc)."
  (:require [clojure.string :as str]
            [loyly.hjson :as hjson]
            [loyly.platform :as plat]))

(def scenario-line #"^\s*Scenario(?: Outline)?:")
(def item-tag #"@item-\d+-(\d+)")

(defn- slice-of [f]
  (re-find #"^[^-]*" (plat/file-name (plat/parent f))))

(defn- next-number [lines]
  (inc (reduce max 0 (map #(plat/parse-long-strict (second %))
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
                                  "@item-" slice "-" (plat/pad-left-zero n 3))
                         line)
                   (inc n) (inc added))
            (recur (inc i) (conj out line) n added)))))))

(defn- parse-args [args]
  (let [args (vec args)
        root (or (second (drop-while #(not= "--root" %) args)) ".")]
    {:root (plat/real-path (plat/absolutize root))}))

(defn stamp
  "Stamp unstamped scenarios under root. Returns {:total n}."
  [{:keys [root]}]
  (let [root (str root)
        files (hjson/spec-files root)]
    (if (empty? files)
      (do (hjson/out (str "stamp: no NN-slug/spec.feature under " (hjson/plan-dir root)
                          ": nothing to stamp yet.\n"
                          "       (the spec is written first; stamping is idempotent, run it again then)\n"))
          {:total 0})
      (let [total (reduce
                   (fn [total f]
                     (let [text (plat/read-text f)
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
