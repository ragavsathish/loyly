(ns loyly.validate-verdicts
  "PoC port of harness/pi-durable/validate-verdicts.ts"
  (:require [loyly.evidence.validate-verdicts :as core]
            [loyly.hjson :as hjson]
            [loyly.platform :as plat]
            [loyly.project.loyly :as loyly]))

(defn validate-verdicts
  "Validate grader room verdicts + surprises, including Löyly blind handoff."
  [room]
  (let [checklist (hjson/read-json (plat/read-text (plat/path room "checklist.json")))
        verdicts (hjson/read-json (plat/read-text (plat/path room "work" "verdicts.json")))
        surprises (hjson/read-json (plat/read-text (plat/path room "work" "surprises.json")))
        judged (core/validate-verdict-data checklist verdicts surprises)
        blind (first (filter #(= (get % "id") loyly/BLIND_ITEM_ID) (:verdicts judged)))]
    (loyly/assert-blind-verdict-handoff
     blind
     (plat/regular-file? (plat/path room loyly/BLIND_REFUSAL_FILE)))
    (doseq [surprise (:surprises judged)]
      (when-not (plat/regular-file? (plat/path room (get surprise "evidence_file")))
        (throw (ex-info "invalid surprise evidence" {:file (get surprise "evidence_file")}))))
    judged))
