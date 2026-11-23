(ns loyly.spike.project.loyly.blind-policy
  "PoC port of harness/pi-durable/project/loyly/blind-policy.ts"
  (:require [clojure.string :as str]
            [loyly.spike.project.loyly.identity :as id]))

(def PERSON_SPEC_SHA256
  "b28ee83dfaada8df0ed99b90121a50f3c55885ade4db323b68e03c4d5f15005e")

(def BLIND_QUESTION
  (str "Without reading the sauna-day configuration or another project file, read only refusal.txt. "
       "Name a request you expect to be accepted using that refusal alone.\n"))

(def PENDING_HUMAN "not reached: blind human review required")
(def PENDING_SUBAGENT "not reached: blind subagent review required")

(defn requires-blind-handoff [project items]
  (and (= project id/PROJECT_ID)
       (some #(= (get % "id" (:id %)) id/BLIND_ITEM_ID) items)))

(defn pending-evidence-prefix [spec-sha256]
  (if (= spec-sha256 PERSON_SPEC_SHA256) PENDING_HUMAN PENDING_SUBAGENT))

(defn historical-person-cut? [spec-sha256]
  (= spec-sha256 PERSON_SPEC_SHA256))

(defn blind-pending-result?
  [result pending-prefix]
  (and (= (get result "status" (:status result)) "skipped")
       (= (get result "stage" (:stage result)) "pending")
       (str/starts-with?
        (or (get-in result ["statusDetails" "message"])
            (get-in result [:statusDetails :message])
            "")
        pending-prefix)))

(defn assert-blind-verdict-handoff [blind refusal-exists?]
  (when blind
    (let [verdict (get blind "verdict" (:verdict blind))
          evidence (get blind "evidence" (:evidence blind))]
      (when (or (not= verdict "fail")
                (not (str/starts-with? (str evidence) PENDING_SUBAGENT))
                (not refusal-exists?))
        (throw (ex-info (str id/BLIND_ITEM_ID " needs a separate blind subagent review")
                        {:item id/BLIND_ITEM_ID}))))))
