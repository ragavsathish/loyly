(ns loyly.spike.continuation
  "PoC port of pure helpers from harness/pi-durable/continuation.ts"
  (:require [babashka.fs :as fs]
            [clojure.string :as str]
            [loyly.spike.evidence.validate-verdicts :as ev]
            [loyly.spike.hjson :as hjson]))

(def MAX_CONTINUATIONS 3)

(defn extract-uncarried
  "Parse UNCARRIED.md bullet lines for selected @item-NN-SSS ids."
  [checklist text]
  (let [selected (set (map #(get % "id") (get checklist "items")))
        ids (into (sorted-set)
                  (keep (fn [[_ id]] (when (contains? selected id) id))
                        (re-seq #"(?m)^\s*[-*]\s*`?@item-(\d{2}-\d{3})\b" text)))]
    (vec ids)))

(defn selected-uncarried
  "Synchronous port of selectedUncarried(room, checklistFile)."
  [room checklist-file]
  (let [file (fs/file room "impl" "UNCARRIED.md")]
    (if-not (fs/regular-file? file)
      []
      (let [checklist (hjson/read-json (slurp (fs/file checklist-file) :encoding "UTF-8"))]
        (when-not (ev/selected-checklist? checklist)
          (throw (ex-info "invalid selected checklist" {:path (str checklist-file)})))
        (extract-uncarried checklist (slurp file :encoding "UTF-8"))))))

(defn continuation-prompt [ids]
  (when (or (empty? ids)
            (some #(nil? (re-matches #"\d{2}-\d{3}" %)) ids))
    (throw (ex-info "continuation needs selected product item IDs" {:ids ids})))
  (str "Your turn ended with these selected product items still listed in impl/UNCARRIED.md: "
       (str/join ", " (map #(str "@item-" %) ids))
       ". Carry them now. For each, write a failing test that drives it through the public HTTP surface and names its id, make it pass with the smallest real change, keep the whole suite green, and remove its line from impl/UNCARRIED.md. Leave a line only for an item you truly cannot carry, with the reason. Then rerun impl/test.sh, start impl/start.sh on a free port, confirm the page and harness/probe.sh over HTTP, and stop the server. The clean-room boundary and write scope from the first turn still apply. Done is decided by the gate and the score, not by you.\n"))
