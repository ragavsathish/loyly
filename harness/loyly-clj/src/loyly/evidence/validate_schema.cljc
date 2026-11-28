(ns loyly.evidence.validate-schema
  "Schema validators for pi-durable contracts (.cljc).
  On :clj defaults to the formal Malli module (loyly.formal.models);
  on :cljs provides matching structural predicates; Ajv is injectable via :validate."
  #?(:clj (:require [loyly.formal.models :as models])))

(defn- fail! [msg explain]
  (throw (ex-info msg {:explain explain})))

#?(:cljs
   (defn- structural-allure? [v]
     (and (map? v)
          (string? (get v "uuid"))
          (string? (get v "name"))
          (string? (get v "status"))
          (string? (get v "stage"))
          (map? (get v "statusDetails"))
          (vector? (get v "labels"))
          (vector? (get v "attachments"))
          (vector? (get v "steps")))))

#?(:cljs
   (defn- structural-panel-plan? [v]
     (and (map? v)
          (string? (get v "schema"))
          (vector? (get v "checks"))
          (seq (get v "checks")))))

#?(:cljs
   (defn- structural-panel-summary? [v]
     (and (map? v)
          (string? (get v "schema"))
          (string? (get v "panel_outcome")))))

#?(:cljs
   (defn- structural-live-run? [v]
     (and (map? v)
          (string? (get v "schema"))
          (map? (get v "source"))
          (map? (get v "builder"))
          (map? (get v "grader")))))

(defn validate-allure-lifecycle
  "Validate Allure lifecycle result (Malli on :clj, structural on :cljs)."
  [result]
  #?(:clj (when-not (models/valid? :allure-lifecycle result)
            (fail! "Allure lifecycle result failed formal model check"
                   (models/explain :allure-lifecycle result)))
     :cljs (when-not (structural-allure? result)
             (fail! "Allure lifecycle result failed structural schema check"
                    {:value result})))
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
  #?(:clj (when-not (models/valid? :panel-plan plan)
            (fail! "panel plan failed formal model check"
                   (models/explain :panel-plan plan)))
     :cljs (when-not (structural-panel-plan? plan)
             (fail! "panel plan failed structural schema check"
                    {:value plan})))
  plan)

(defn validate-panel-summary
  [summary]
  #?(:clj (when-not (models/valid? :panel-summary summary)
            (fail! "panel summary failed formal model check"
                   (models/explain :panel-summary summary)))
     :cljs (when-not (structural-panel-summary? summary)
             (fail! "panel summary failed structural schema check"
                    {:value summary})))
  summary)

(defn validate-live-run
  [config]
  #?(:clj (when-not (models/valid? :live-run config)
            (fail! "live-run config failed formal model check"
                   (models/explain :live-run config)))
     :cljs (when-not (structural-live-run? config)
             (fail! "live-run config failed structural schema check"
                    {:value config})))
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
