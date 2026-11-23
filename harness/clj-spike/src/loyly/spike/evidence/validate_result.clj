(ns loyly.spike.evidence.validate-result
  "PoC port of harness/evidence-core/validate-result.ts"
  (:require [clojure.string :as str]
            [loyly.spike.evidence.validate-identity :as ident]))

(defn validate-result-evidence [result item-id]
  (let [message (get-in result ["statusDetails" "message"])
        start (get result "start")
        stop (get result "stop")
        steps (get result "steps")
        attachments (get result "attachments")]
    (when (or (not (string? message))
              (str/blank? (str/trim message))
              (not (integer? start))
              (not (integer? stop))
              (< stop start)
              (not (vector? steps))
              (empty? steps)
              (some #(or (nil? (get % "status")) (nil? (get % "stage"))) steps))
      (throw (ex-info (str "Allure observation, timing or steps missing for " item-id)
                      {:item item-id})))
    (when (or (not (vector? attachments)) (empty? attachments))
      (throw (ex-info (str "Allure evidence attachment missing for " item-id)
                      {:item item-id})))))

(defn assert-allure-result
  "Schema hook is optional (`validate-schema` fn); spike may pass identity only."
  [result {:keys [validate-schema file-hint identity]}]
  (when validate-schema
    (validate-schema result file-hint))
  (when-not (vector? (get result "labels"))
    (throw (ex-info "Allure labels missing after schema validation" {})))
  (let [item-id (ident/stamped-item-id result)]
    (when identity
      (let [expected-id (get identity "itemId" (:item-id identity))]
        (when-not (= item-id expected-id)
          (throw (ex-info (str "Allure item tag " item-id " differs from expected " expected-id)
                          {})))
        (ident/assert-allure-identity result identity)))
    (validate-result-evidence result item-id)
    {:result result :item-id item-id}))
