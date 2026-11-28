(ns loyly.formal.theory
  "Explicit mathematical theory for loyly-clj.

  We treat the spike as a many-sorted structure:

    𝒜 = (Sorts, Predicates, Functions, Invariants)

  - Sorts      — carrier sets (Malli schemas in formal.models)
  - Predicates — Validₛ : S → 𝔹  (models/valid?)
  - Functions  — H : String → Sha256, etc. (digest + registry digests)
  - Invariants — statements proved by formal.props / formal.trace

  This is the formal-verification road: models define the system;
  properties and pins prove instances and artifacts obey them."
  (:require [loyly.formal.cycle :as cycle]
            [loyly.formal.models :as models]
            [loyly.formal.trace :as trace]
            [loyly.project.loyly :as loyly]))

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
       :impl 'loyly.digest/sha256-string
       :law "∀ s. Valid_sha256(H(s)) ∧ |H(s)| = 64"}
   :registry-digest
   {:notation "Δ : 1 → Sha256"
    :impl 'loyly.formal.trace/registry-digest
    :law "Δ pins the closed theory (all sort forms)"}
   :model-digest
   {:notation "δ : SortName → Sha256"
    :impl 'loyly.formal.trace/model-digest
    :law "δ(s) = H(pr-str(form(s)))"}
   :blind-item
   {:notation "ι : 1 → ItemId"
    :value loyly/BLIND_ITEM_ID
    :law "∀ p ∈ BlindPacket. p.item = ι"}})

(def Invariants
  "Statements we treat as theorems (checked by props + trace)."
  [{:id :I1
    :statement "∀ s ∈ String. Valid_sha256(H(s))"
    :proved-by 'loyly.formal.props/prop-sha256-hex}
   {:id :I2
    :statement "∀ s ∈ String. H(s) = H(s)"
    :proved-by 'loyly.formal.props/prop-sha256-deterministic}
   {:id :I3
    :statement "∀ s ∈ String. |H(s)| = 64"
    :proved-by 'loyly.formal.props/prop-sha256-length}
   {:id :I4
    :statement "∀ p ∈ BlindPacket. p.item = ι"
    :proved-by 'loyly.formal.props/prop-blind-packet-item-fixed}
   {:id :I5
    :statement "∀ m ∈ SortNames. ∀ x ← Gen(m). Valid_m(x)"
    :proved-by 'loyly.formal.props/prop-generated-obeys-model}
   {:id :I6
    :statement (str loyly/DEFAULT_PANEL_PLAN " ∈ PanelPlan")
    :proved-by 'loyly.formal.trace/prove-booking-panel!}
   {:id :I7
    :statement "Published JSON Schema files for panel/live/allure are present and digested"
    :proved-by 'loyly.formal.trace/pin-all-json-schemas!}
   {:id :I8
    :statement "∀ r ∈ LiveRun. schema∈{v1,v2} ∧ Valid_live-run(r)"
    :proved-by 'loyly.formal.props/prop-generated-obeys-model}
   {:id :I9
    :statement "∀ g ∈ GradingRoom. g.schema = loyly.grading-room.v1"
    :proved-by 'loyly.formal.props/prop-generated-obeys-model}
   {:id :I10
    :statement "∀ m ∈ PanelVmRun ∪ PanelReport. original_score_unchanged = true"
    :proved-by 'loyly.formal.props/prop-generated-obeys-model}
   {:id :I11
    :statement "∀ s ∈ PanelSelection. s.attempt ∈ {1,2}"
    :proved-by 'loyly.formal.props/prop-panel-selection-attempt}
   {:id :I12
    :statement "∀ shards ∈ GraderShards. 1 ≤ |shards| ≤ 16 ∧ unique ids"
    :proved-by 'loyly.formal.props/prop-grader-shards-bounded}
   {:id :I13
    :statement "MAX_CONTINUATIONS = 3"
    :proved-by 'loyly.formal.props/prop-continuation-max}])

(def Morphisms
  "Traceability arrows from formal sorts to published schemas and .cljc sources."
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
    :kind :fixture-instance}
   {:from :grading-room
    :to "harness/loyly-clj/src/loyly/grading_room.cljc"
    :kind :cljc-source}
   {:from :panel-vm-run
    :to "harness/loyly-clj/src/loyly/panel_vm.cljc"
    :kind :cljc-source}
   {:from :panel-report
    :to "harness/loyly-clj/src/loyly/panel_compile.cljc"
    :kind :cljc-source}
   {:from :score-input
    :to "harness/loyly-clj/src/loyly/score_receipt.cljc"
    :kind :cljc-source}
   {:from :panel-selection
    :to "harness/loyly-clj/src/loyly/panel_adapter.cljc"
    :kind :cljc-source}
   {:from :grader-shards
    :to "harness/loyly-clj/src/loyly/grader_shards.cljc"
    :kind :cljc-source}
   {:from :continuation-ids
    :to "harness/loyly-clj/src/loyly/continuation.cljc"
    :kind :cljc-source}
   {:from :audit-rows
    :to "harness/loyly-clj/src/loyly/audit_rows.cljc"
    :kind :cljc-source}
   {:from :worker-config
    :to "harness/loyly-clj/src/loyly/worker_config.cljc"
    :kind :cljc-source}])

(defn theory
  "Closed description of 𝒜 for export / examination, plus cycle 𝒞."
  []
  {:schema "loyly.formal-theory.v1"
   :title "Löyly loyly-clj many-sorted theory"
   :sorts (mapv (fn [[k v]] {:name k :digest (:digest v)}) Sorts)
   :predicates (mapv (fn [[k v]] (assoc v :sort k)) Predicates)
   :functions Functions
   :invariants Invariants
   :morphisms Morphisms
   :registry-digest (trace/registry-digest)
   :project loyly/PROJECT_ID
   :cycle (cycle/cycle-theory)})
