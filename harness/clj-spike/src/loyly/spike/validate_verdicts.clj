(ns loyly.spike.validate-verdicts
  "PoC port of harness/pi-durable/validate-verdicts.ts"
  (:require [babashka.fs :as fs]
            [loyly.spike.evidence.validate-verdicts :as core]
            [loyly.spike.hjson :as hjson]
            [loyly.spike.project.loyly :as loyly]))

(defn validate-verdicts
  "Validate grader room verdicts + surprises, including Löyly blind handoff."
  [room]
  (let [checklist (hjson/read-json (slurp (fs/file room "checklist.json") :encoding "UTF-8"))
        verdicts (hjson/read-json (slurp (fs/file room "work" "verdicts.json") :encoding "UTF-8"))
        surprises (hjson/read-json (slurp (fs/file room "work" "surprises.json") :encoding "UTF-8"))
        judged (core/validate-verdict-data checklist verdicts surprises)
        blind (first (filter #(= (get % "id") loyly/BLIND_ITEM_ID) (:verdicts judged)))]
    (loyly/assert-blind-verdict-handoff
     blind
     (fs/regular-file? (fs/path room loyly/BLIND_REFUSAL_FILE)))
    (doseq [surprise (:surprises judged)]
      (when-not (fs/regular-file? (fs/path room (get surprise "evidence_file")))
        (throw (ex-info "invalid surprise evidence" {:file (get surprise "evidence_file")}))))
    judged))
