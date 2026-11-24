(ns loyly.spike.formal.trace
  "Traceability proofs between formal models, TS JSON Schema files, and
  concrete artifacts (digests / receipts / panel plans)."
  (:require [babashka.fs :as fs]
            [clojure.string :as str]
            [loyly.spike.digest :as d]
            [loyly.spike.formal.models :as models]
            [loyly.spike.hjson :as hjson]
            [loyly.spike.project.loyly :as loyly]))

(defn model-digest
  "SHA-256 of the closed Malli form — pins the mathematical model."
  [name]
  (d/sha256-string (pr-str (models/model-form name))))

(defn registry-digest
  "Combined digest of every registered model form (order-stable)."
  []
  (->> (sort (keys models/Registry))
       (map (fn [k] (str (name k) "=" (model-digest k))))
       (str/join "\n")
       d/sha256-string))

(defn- schema-path [repo rel]
  (fs/path repo "harness" "pi-durable" rel))

(defn pin-json-schema!
  "Prove a TS JSON Schema file still exists and return its content digest.
  Traceability: formal CLJ models ↔ published schema bytes on disk."
  [repo rel]
  (let [path (schema-path repo rel)]
    (when-not (fs/regular-file? path)
      (throw (ex-info (str "missing JSON Schema for traceability: " rel)
                      {:path (str path)})))
    {:file rel
     :sha256 (d/file-sha256 path)
     :bytes (fs/size path)}))

(def SchemaPins
  "TS schema files the formal road must stay bound to."
  ["panel-plan.schema.json"
   "panel-summary.schema.json"
   "live-run.schema.json"
   "allure-lifecycle-result.schema.json"])

(defn pin-all-json-schemas!
  [repo]
  (mapv #(pin-json-schema! repo %) SchemaPins))

(defn prove-fixture-obeys
  "Traceability step: concrete JSON fixture validates against named model."
  [model-name value]
  (models/assert! model-name value)
  {:model model-name
   :ok true
   :model-digest (model-digest model-name)})

(defn prove-panel-plan-file!
  "Load a .panel.json and prove it against PanelPlan."
  [path]
  (let [plan (hjson/read-json (slurp path :encoding "UTF-8"))]
    (assoc (prove-fixture-obeys :panel-plan plan)
           :file (str path)
           :file-sha256 (d/file-sha256 path)
           :schema (get plan "schema"))))

(defn prove-blind-packet!
  [packet]
  (prove-fixture-obeys :blind-packet packet))

(defn prove-score-input!
  [input]
  (prove-fixture-obeys :score-input input))

(defn prove-digest-roundtrip!
  "Property of the digest model: hex length and alphabet."
  [s]
  (let [hex (d/sha256-string s)]
    (models/assert! :sha256 hex)
    {:input-bytes (count (.getBytes ^String s "UTF-8"))
     :sha256 hex
     :ok true}))

(defn prove-booking-panel!
  "End-to-end trace for the default Löyly panel plan in a repo checkout."
  [repo]
  (let [path (fs/file repo "harness" "pi-durable" loyly/DEFAULT_PANEL_PLAN)]
    (when-not (fs/regular-file? path)
      (throw (ex-info "default panel plan missing" {:path (str path)})))
    (prove-panel-plan-file! path)))

(defn certificate
  "Independent examination summary: model registry + schema pins + panel proof."
  [repo]
  (let [schemas (pin-all-json-schemas! repo)
        panel (prove-booking-panel! repo)
        digests (mapv #(prove-digest-roundtrip! %)
                      ["" "loyly" loyly/BLIND_ITEM_ID])]
    {:schema "loyly.formal-certificate.v1"
     :registry-digest (registry-digest)
     :models (into {} (map (fn [k] [k (model-digest k)]) (sort (keys models/Registry))))
     :json-schema-pins schemas
     :panel panel
     :digest-roundtrips digests
     :project loyly/PROJECT_ID}))
