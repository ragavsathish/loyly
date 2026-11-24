(ns loyly.spike.formal.theory
  "Explicit mathematical theory for the clj-spike.

  We treat the spike as a many-sorted structure:

    𝒜 = (Sorts, Predicates, Functions, Invariants)

  - Sorts      — carrier sets (Malli schemas in formal.models)
  - Predicates — Validₛ : S → 𝔹  (models/valid?)
  - Functions  — H : String → Sha256, etc. (digest + registry digests)
  - Invariants — statements proved by formal.props / formal.trace

  This is the formal-verification road: models define the system;
  properties and pins prove instances and artifacts obey them."
  (:require [loyly.spike.formal.models :as models]
            [loyly.spike.formal.trace :as trace]
            [loyly.spike.project.loyly :as loyly]
            [malli.core :as m]))

(def Sorts
  "Named carrier sets. Each name maps to a Malli schema (the set's definition)."
  (into (sorted-map)
        (map (fn [[k _]]
               [k {:symbol (symbol (name k))
                   :digest (trace/model-digest k)
                   :form (models/model-form k)}])
             models/Registry)))

(def Predicates
  "Unary membership predicates Validₛ(x) ⇔ x ∈ S."
  (into (sorted-map)
        (map (fn [k]
               [k {:notation (str "Valid_" (name k) "(x)")
                   :meaning (str "models/valid? " k " x")}])
             (keys models/Registry))))

(def Functions
  "Total functions on the carriers used by the harness."
  {:H {:notation "H : String → Sha256"
       :impl 'loyly.spike.digest/sha256-string
       :law "∀ s. Valid_sha256(H(s)) ∧ |H(s)| = 64"}
   :registry-digest
   {:notation "Δ : 1 → Sha256"
    :impl 'loyly.spike.formal.trace/registry-digest
    :law "Δ pins the closed theory (all sort forms)"}
   :model-digest
   {:notation "δ : SortName → Sha256"
    :impl 'loyly.spike.formal.trace/model-digest
    :law "δ(s) = H(pr-str(form(s)))"}
   :blind-item
   {:notation "ι : 1 → ItemId"
    :value loyly/BLIND_ITEM_ID
    :law "∀ p ∈ BlindPacket. p.item = ι"}})

(def Invariants
  "Statements we treat as theorems (checked by props + trace)."
  [{:id :I1
    :statement "∀ s ∈ String. Valid_sha256(H(s))"
    :proved-by 'loyly.spike.formal.props/prop-sha256-hex}
   {:id :I2
    :statement "∀ s ∈ String. H(s) = H(s)"
    :proved-by 'loyly.spike.formal.props/prop-sha256-deterministic}
   {:id :I3
    :statement "∀ s ∈ String. |H(s)| = 64"
    :proved-by 'loyly.spike.formal.props/prop-sha256-length}
   {:id :I4
    :statement "∀ p ∈ BlindPacket. p.item = ι"
    :proved-by 'loyly.spike.formal.props/prop-blind-packet-item-fixed}
   {:id :I5
    :statement "∀ m ∈ SortNames. ∀ x ← Gen(m). Valid_m(x)"
    :proved-by 'loyly.spike.formal.props/prop-generated-obeys-model}
   {:id :I6
    :statement "booking-core.panel.json ∈ PanelPlan"
    :proved-by 'loyly.spike.formal.trace/prove-booking-panel!}
   {:id :I7
    :statement "TS JSON Schema files for panel/live/allure are present and digested"
    :proved-by 'loyly.spike.formal.trace/pin-all-json-schemas!}])

(def Morphisms
  "Traceability arrows from formal sorts to published TS artifacts."
  [{:from :panel-plan
    :to "harness/pi-durable/panel-plan.schema.json"
    :kind :json-schema-pin}
   {:from :panel-summary
    :to "harness/pi-durable/panel-summary.schema.json"
    :kind :json-schema-pin}
   {:from :live-run
    :to "harness/pi-durable/live-run.schema.json"
    :kind :json-schema-pin}
   {:from :allure-lifecycle
    :to "harness/pi-durable/allure-lifecycle-result.schema.json"
    :kind :json-schema-pin}
   {:from :panel-plan
    :to (str "harness/pi-durable/" loyly/DEFAULT_PANEL_PLAN)
    :kind :fixture-instance}])

(defn theory
  "Closed description of 𝒜 for export / examination."
  []
  {:schema "loyly.formal-theory.v1"
   :title "Löyly clj-spike many-sorted theory"
   :sorts (mapv (fn [[k v]] {:name k :digest (:digest v)}) Sorts)
   :predicates (mapv (fn [[k v]] (assoc v :sort k)) Predicates)
   :functions Functions
   :invariants Invariants
   :morphisms Morphisms
   :registry-digest (trace/registry-digest)
   :project loyly/PROJECT_ID})

(defn sort-form
  "Pretty closed form of one sort (for human inspection)."
  [name]
  (m/form (models/schema name)))

(defn explain-rejection
  "Counterexample witness when Validₛ(x) fails."
  [name value]
  (models/explain name value))
