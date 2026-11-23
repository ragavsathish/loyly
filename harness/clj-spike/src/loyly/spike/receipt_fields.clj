(ns loyly.spike.receipt-fields
  "Shared key=value receipt parsing used by gate- and builder-adapters."
  (:require [babashka.fs :as fs]
            [clojure.string :as str]))

(defn parse-fields
  "Parse a receipt file of `key=value` lines into an ordered string map."
  [path]
  (let [text (str/trim (slurp (fs/file path) :encoding "UTF-8"))]
    (into (array-map)
          (map (fn [line]
                 (let [at (str/index-of line "=")]
                   (if (nil? at)
                     [line ""]
                     [(subs line 0 at) (subs line (inc at))])))
               (str/split-lines text)))))
