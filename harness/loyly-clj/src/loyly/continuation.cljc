(ns loyly.continuation
  "Continuation prompt and UNCARRIED.md selection helpers (.cljc)."
  (:require [clojure.string :as str]
            [loyly.evidence.validate-verdicts :as ev]
            [loyly.hjson :as hjson]
            [loyly.platform :as plat]))

(def MAX_CONTINUATIONS 3)

(defn extract-uncarried
  "Parse UNCARRIED.md bullet lines for selected @item-NN-SSS ids."
  [checklist text]
  (let [selected (set (map #(get % "id") (get checklist "items")))
        ids (into (sorted-set)
                  (keep (fn [[_ id]] (when (contains? selected id) id))
                        (re-seq (plat/re-flags "m" "^\\s*[-*]\\s*`?@item-(\\d{2}-\\d{3})\\b") text)))]
    (vec ids)))

(defn selected-uncarried
  "Return sorted selected item IDs still listed in room/impl/UNCARRIED.md."
  [room checklist-file]
  (let [file (plat/path room "impl" "UNCARRIED.md")]
    (if-not (plat/regular-file? file)
      []
      (let [checklist (hjson/read-json (plat/read-text checklist-file))]
        (when-not (ev/selected-checklist? checklist)
          (throw (ex-info "invalid selected checklist" {:path (str checklist-file)})))
        (extract-uncarried checklist (plat/read-text file))))))

(defn continuation-prompt [ids]
  (when (or (empty? ids)
            (some #(nil? (re-matches #"\d{2}-\d{3}" %)) ids))
    (throw (ex-info "continuation needs selected product item IDs" {:ids ids})))
  (str "Your turn ended with these selected product items still listed in impl/UNCARRIED.md: "
       (str/join ", " (map #(str "@item-" %) ids))
       ". Carry them now. For each, write a failing test that drives it through the public HTTP surface and names its id, make it pass with the smallest real change, keep the whole suite green, and remove its line from impl/UNCARRIED.md. Leave a line only for an item you truly cannot carry, with the reason. Then rerun impl/test.sh, start impl/start.sh on a free port, confirm the page and harness/probe.sh over HTTP, and stop the server. The clean-room boundary and write scope from the first turn still apply. Done is decided by the gate and the score, not by you.\n"))
