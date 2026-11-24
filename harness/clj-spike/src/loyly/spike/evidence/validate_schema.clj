(ns loyly.spike.evidence.validate-schema
  "Schema validators for pi-durable contracts.
  Default predicates use the formal module (loyly.formal.models); Ajv injectable."
  (:require [loyly.formal.models :as models]))

(defn- fail! [msg explain]
  (throw (ex-info msg {:explain explain})))

(defn validate-allure-lifecycle
  "Malli model for Allure lifecycle results (Ajv stand-in by default)."
  [result]
  (when-not (models/valid? :allure-lifecycle result)
    (fail! "Allure lifecycle result failed formal model check"
           (models/explain :allure-lifecycle result)))
  result)

(defn compile-allure-schema
  "Return a validator fn. Pass `:validate` to inject a real Ajv predicate."
  [_schema & {:keys [validate]}]
  (or validate
      (fn [result & _]
        (validate-allure-lifecycle result)
        true)))

(defn validate-panel-plan
  [plan]
  (when-not (models/valid? :panel-plan plan)
    (fail! "panel plan failed formal model check"
           (models/explain :panel-plan plan)))
  plan)

(defn validate-panel-summary
  [summary]
  (when-not (models/valid? :panel-summary summary)
    (fail! "panel summary failed formal model check"
           (models/explain :panel-summary summary)))
  summary)

(defn validate-live-run
  [config]
  (when-not (models/valid? :live-run config)
    (fail! "live-run config failed formal model check"
           (models/explain :live-run config)))
  config)

(defn compile-schema
  "Generic compile hook. `:kind` one of :allure :panel-plan :panel-summary :live-run."
  [kind _schema & {:keys [validate]}]
  (or validate
      (case kind
        :allure (compile-allure-schema nil)
        :panel-plan (fn [plan & _] (validate-panel-plan plan) true)
        :panel-summary (fn [s & _] (validate-panel-summary s) true)
        :live-run (fn [c & _] (validate-live-run c) true)
        (fn [value & _]
          (when-not (map? value)
            (fail! (str "unknown schema kind " kind) nil))
          true))))
