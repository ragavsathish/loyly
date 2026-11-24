(ns loyly.spike.grading-room
  "PoC port of harness/pi-durable/grading-room.ts (digests + prepare/verify)."
  (:require [babashka.fs :as fs]
            [loyly.spike.digest :as d]
            [loyly.spike.hjson :as hjson]
            [loyly.spike.project.loyly :as loyly]))

(defn candidate-digest [room]
  (d/tree-digest (fs/path room "impl") "impl"))

(defn plan-digest [room]
  (d/tree-digest (fs/path room "plan") "plan"))

(defn selected-plans
  "Insertion-ordered unique plan slugs from checklist item sources (TS Set order)."
  [checklist-file]
  (let [checklist (hjson/read-json (slurp (fs/file checklist-file) :encoding "UTF-8"))
        items (get checklist "items")]
    (when (or (not (vector? items)) (empty? items))
      (throw (ex-info "grading checklist has no selected items" {})))
    (loop [items items acc [] seen #{}]
      (if-let [item (first items)]
        (let [id (get item "id")
              source (or (get item "source") "")
              match (re-matches #"docs/plan/(\d\d-[a-z][a-z0-9-]*)/spec\.feature:\d+" source)
              plan (when match (second match))]
          (when (or (nil? match)
                    (not (re-matches #"\d\d-\d\d\d" (str id)))
                    (not= (subs plan 0 2) (subs id 0 2)))
            (throw (ex-info (str "grading item has no safe matching plan source: "
                                 (or id "unknown"))
                            {:id id})))
          (if (contains? seen plan)
            (recur (rest items) acc seen)
            (recur (rest items) (conj acc plan) (conj seen plan))))
        acc))))

(defn- absolute? [path]
  (fs/absolute? (fs/path path)))

(defn- digest64? [s]
  (boolean (and (string? s) (re-matches #"[0-9a-f]{64}" s))))

(defn prepare-grading-room
  [{:keys [source-room candidate-room checklist-file schema-file out
           candidate-sha256 checklist-sha256 schema-sha256
           project blind-review]
    :or {project loyly/PROJECT_ID}}]
  (let [blind-review (if (nil? blind-review)
                       (loyly/defaults-blind-review project)
                       blind-review)]
    (when-not (re-matches #"[a-z][a-z0-9-]*" project)
      (throw (ex-info "invalid grading project" {:project project})))
    (doseq [path [source-room candidate-room checklist-file schema-file out]]
      (when-not (absolute? path)
        (throw (ex-info (str "grading path must be absolute: " path) {:path path}))))
    (when-not (every? digest64? [candidate-sha256 checklist-sha256 schema-sha256])
      (throw (ex-info "grading room needs approved digests" {})))
    (when (or (not= (fs/file-name checklist-file) "checklist.json")
              (not= (fs/file-name schema-file) "allure-lifecycle-result.schema.json")
              (not= (d/file-sha256 checklist-file) checklist-sha256)
              (not= (d/file-sha256 schema-file) schema-sha256)
              (not= (candidate-digest candidate-room) candidate-sha256))
      (throw (ex-info "grading inputs differ from the gated candidate, checklist or schema" {})))
    (when (fs/exists? out)
      (throw (ex-info "grading room already exists; reconcile its receipt or inspect it" {})))
    (let [plans (selected-plans checklist-file)]
      (fs/create-dirs (fs/path out "plan"))
      (doseq [plan plans]
        (let [from (fs/path source-room "docs" "plan" plan)]
          (when-not (fs/regular-file? (fs/path from "spec.feature"))
            (throw (ex-info (str "selected plan missing: " plan) {:plan plan})))
          (fs/copy-tree from (fs/path out "plan" plan))))
      (fs/copy-tree (fs/path candidate-room "impl") (fs/path out "impl"))
      (fs/copy checklist-file (fs/path out "checklist.json"))
      (fs/copy schema-file (fs/path out "allure-lifecycle-result.schema.json"))
      (fs/create-dirs (fs/path out "work"))
      (when (or (not= (candidate-digest out) candidate-sha256)
                (not= (d/file-sha256 (fs/path out "checklist.json")) checklist-sha256)
                (not= (d/file-sha256 (fs/path out "allure-lifecycle-result.schema.json"))
                      schema-sha256))
        (throw (ex-info "grading copy differs from the gated candidate, checklist or schema" {})))
      (let [receipt (cond-> (array-map
                             "schema" loyly/GRADING_ROOM
                             "candidateSha256" candidate-sha256
                             "checklistSha256" checklist-sha256
                             "schemaSha256" schema-sha256
                             "planSha256" (plan-digest out)
                             "sourcePlan" (when (= 1 (count plans)) (str "plan/" (first plans)))
                             "sourcePlans" (mapv #(str "plan/" %) plans))
                      (not (and (= project loyly/PROJECT_ID) blind-review))
                      (assoc "project" project "blindReview" blind-review))]
        (hjson/spit-utf8 (fs/file out ".grading-room.json")
                         (hjson/compact-json receipt))
        receipt))))

(defn verify-grading-room
  [{:keys [out candidate-sha256 checklist-sha256 schema-sha256 project blind-review]
    :or {project loyly/PROJECT_ID}}]
  (let [blind-review (if (nil? blind-review)
                       (loyly/defaults-blind-review project)
                       blind-review)
        receipt (hjson/read-json (slurp (fs/file out ".grading-room.json") :encoding "UTF-8"))
        expected-plans (mapv #(str "plan/" %) (selected-plans (fs/file out "checklist.json")))
        recorded-plans (or (get receipt "sourcePlans")
                           (when-let [p (get receipt "sourcePlan")] [p])
                           [])]
    (when (or (not= (get receipt "schema") loyly/GRADING_ROOM)
              (not= (or (get receipt "project") loyly/PROJECT_ID) project)
              (not= (if (contains? receipt "blindReview")
                      (get receipt "blindReview")
                      true)
                    blind-review)
              (not= (get receipt "candidateSha256") candidate-sha256)
              (not= (get receipt "checklistSha256") checklist-sha256)
              (not= (get receipt "schemaSha256") schema-sha256)
              (not= (hjson/compact-json recorded-plans) (hjson/compact-json expected-plans))
              (not= (get receipt "planSha256") (plan-digest out))
              (not= (candidate-digest out) candidate-sha256)
              (not= (d/file-sha256 (fs/path out "checklist.json")) checklist-sha256)
              (not= (d/file-sha256 (fs/path out "allure-lifecycle-result.schema.json"))
                    schema-sha256))
      (throw (ex-info "grading room receipt or inputs changed" {})))
    (doseq [p (fs/list-dir out)]
      (let [name (fs/file-name p)]
        (when-not (#{"plan" "impl" "checklist.json"
                     "allure-lifecycle-result.schema.json" "work"
                     ".grading-room.json"} name)
          (throw (ex-info (str "unexpected grading-room entry: " name) {:name name})))))
    receipt))
