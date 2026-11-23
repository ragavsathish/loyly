(ns loyly.spike.evidence.validate-verdicts
  "PoC port of harness/evidence-core/validate-verdicts.ts"
  (:require [clojure.string :as str]))

(defn selected-checklist? [value]
  (and (map? value)
       (vector? (get value "items"))
       (every? (fn [item]
                 (and (map? item) (string? (get item "id"))))
               (get value "items"))))

(defn- verdict? [value]
  (and (map? value)
       (string? (get value "id"))
       (#{"pass" "fail"} (get value "verdict"))
       (string? (get value "evidence"))))

(defn- surprise? [value]
  (and (map? value)
       (string? (get value "item"))
       (string? (get value "observation"))
       (string? (get value "evidence_file"))))

(defn validate-verdict-data
  "Return {:verdicts :surprises :pass} or throw."
  [checklist raw-verdicts raw-surprises]
  (when-not (selected-checklist? checklist)
    (throw (ex-info "invalid grading checklist" {})))
  (let [ids (mapv #(get % "id") (get checklist "items"))]
    (when (or (empty? ids) (not= (count ids) (count (set ids))))
      (throw (ex-info "invalid grading checklist" {})))
    (when (or (not (vector? raw-verdicts))
              (not= (count raw-verdicts) (count ids)))
      (throw (ex-info "grader did not return one verdict per selected item" {})))
    (when-not (every? verdict? raw-verdicts)
      (throw (ex-info "invalid grader verdict shape" {})))
    (doseq [i (range (count ids))]
      (let [v (nth raw-verdicts i)]
        (when (or (not= (get v "id") (nth ids i))
                  (str/blank? (str/trim (get v "evidence"))))
          (throw (ex-info (str "invalid verdict for " (nth ids i)) {:id (nth ids i)})))))
    (when-not (vector? raw-surprises)
      (throw (ex-info "surprises must be a JSON array" {})))
    (when-not (every? surprise? raw-surprises)
      (throw (ex-info "invalid surprise evidence" {})))
    (doseq [surprise raw-surprises]
      (let [file (get surprise "evidence_file")]
        (when (or (not (some #{(get surprise "item")} ids))
                  (not (re-matches #"work/[A-Za-z0-9._/-]+" file))
                  (str/includes? file ".."))
          (throw (ex-info "invalid surprise evidence" {})))))
    {:verdicts raw-verdicts
     :surprises raw-surprises
     :pass (count (filter #(= "pass" (get % "verdict")) raw-verdicts))}))
