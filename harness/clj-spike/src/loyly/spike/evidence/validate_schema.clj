(ns loyly.spike.evidence.validate-schema
  "Ajv stand-in for the spike: structural validators matching the JSON Schema
  contracts used by pi-durable. Full Ajv compile stays optional via inject."
  )

(defn- fail! [msg]
  (throw (ex-info msg {})))

(defn validate-allure-lifecycle
  "Structural stand-in for compileAllureSchema(allure-lifecycle-result)."
  [result]
  (when-not (and (map? result)
                 (string? (get result "uuid"))
                 (re-matches #"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
                             (str (get result "uuid")))
                 (#{"passed" "failed" "broken" "skipped" "unknown"} (get result "status"))
                 (#{"scheduled" "running" "finished" "pending" "interrupted"} (get result "stage"))
                 (map? (get result "statusDetails"))
                 (string? (get-in result ["statusDetails" "message"]))
                 (vector? (get result "labels"))
                 (vector? (get result "attachments"))
                 (vector? (get result "steps")))
    (fail! "Allure lifecycle result failed structural schema check"))
  result)

(defn compile-allure-schema
  "Return a validator fn. Ignores schema bytes — structural stand-in.
  Pass `:validate` to inject a real Ajv-compiled predicate."
  [_schema & {:keys [validate]}]
  (or validate
      (fn [result & _]
        (validate-allure-lifecycle result)
        true)))

(defn validate-panel-plan
  "Structural stand-in for panel-plan.schema.json."
  [plan]
  (when-not (and (map? plan)
                 (string? (get plan "schema"))
                 (vector? (get plan "checks"))
                 (seq (get plan "checks")))
    (fail! "panel plan failed structural schema check"))
  plan)

(defn validate-panel-summary
  "Structural stand-in for panel-summary.schema.json."
  [summary]
  (when-not (and (map? summary)
                 (string? (get summary "schema"))
                 (string? (get summary "panel_outcome"))
                 (re-matches #"[0-9a-f]{64}" (str (get summary "candidate_sha256"))))
    (fail! "panel summary failed structural schema check"))
  summary)

(defn validate-live-run
  "Structural stand-in for live-run.schema.json."
  [config]
  (when-not (and (map? config)
                 (string? (get config "schema"))
                 (map? (get config "source"))
                 (re-matches #"[0-9a-f]{64}"
                             (str (get-in config ["source" "checklist_sha256"]))))
    (fail! "live-run config failed structural schema check"))
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
            (fail! (str "unknown schema kind " kind)))
          true))))
