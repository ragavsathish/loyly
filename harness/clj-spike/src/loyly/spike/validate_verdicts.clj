(ns loyly.spike.validate-verdicts
  "PoC port of harness/pi-durable/validate-verdicts.ts"
  (:require [clojure.java.io :as io]
            [loyly.spike.evidence.validate-verdicts :as core]
            [loyly.spike.hjson :as hjson]
            [loyly.spike.project.loyly.blind-policy :as policy]
            [loyly.spike.project.loyly.identity :as id]))

(defn validate-verdicts
  "Validate grader room verdicts + surprises, including Löyly blind handoff."
  [room]
  (let [room (io/file room)
        checklist (hjson/read-json (slurp (io/file room "checklist.json") :encoding "UTF-8"))
        verdicts (hjson/read-json (slurp (io/file room "work" "verdicts.json") :encoding "UTF-8"))
        surprises (hjson/read-json (slurp (io/file room "work" "surprises.json") :encoding "UTF-8"))
        judged (core/validate-verdict-data checklist verdicts surprises)
        blind (first (filter #(= (get % "id") id/BLIND_ITEM_ID) (:verdicts judged)))]
    (policy/assert-blind-verdict-handoff
     blind
     (.isFile (io/file room id/BLIND_REFUSAL_FILE)))
    (doseq [surprise (:surprises judged)]
      (when-not (.isFile (io/file room (get surprise "evidence_file")))
        (throw (ex-info "invalid surprise evidence" {:file (get surprise "evidence_file")}))))
    judged))
