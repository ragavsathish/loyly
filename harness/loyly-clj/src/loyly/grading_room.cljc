(ns loyly.grading-room
  "PoC port of harness/pi-durable/grading-room.ts (digests + prepare/verify)."
  (:require [loyly.digest :as d]
            [loyly.hjson :as hjson]
            [loyly.platform :as plat]
            [loyly.project.loyly :as loyly]))

(defn candidate-digest [room]
  (d/tree-digest (plat/path room "impl") "impl"))

(defn plan-digest [room]
  (d/tree-digest (plat/path room "plan") "plan"))

(defn selected-plans
  "Insertion-ordered unique plan slugs from checklist item sources (TS Set order)."
  [checklist-file]
  (let [checklist (hjson/read-json (plat/read-text (plat/path checklist-file)))
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
  (plat/absolute? (plat/path path)))

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
    (when (or (not= (plat/file-name checklist-file) "checklist.json")
              (not= (plat/file-name schema-file) "allure-lifecycle-result.schema.json")
              (not= (d/file-sha256 checklist-file) checklist-sha256)
              (not= (d/file-sha256 schema-file) schema-sha256)
              (not= (candidate-digest candidate-room) candidate-sha256))
      (throw (ex-info "grading inputs differ from the gated candidate, checklist or schema" {})))
    (when (plat/exists? out)
      (throw (ex-info "grading room already exists; reconcile its receipt or inspect it" {})))
    (let [plans (selected-plans checklist-file)]
      (plat/create-dirs (plat/path out "plan"))
      (doseq [plan plans]
        (let [from (plat/path source-room "docs" "plan" plan)]
          (when-not (plat/regular-file? (plat/path from "spec.feature"))
            (throw (ex-info (str "selected plan missing: " plan) {:plan plan})))
          (plat/copy-tree from (plat/path out "plan" plan))))
      (plat/copy-tree (plat/path candidate-room "impl") (plat/path out "impl"))
      (plat/copy checklist-file (plat/path out "checklist.json"))
      (plat/copy schema-file (plat/path out "allure-lifecycle-result.schema.json"))
      (plat/create-dirs (plat/path out "work"))
      (when (or (not= (candidate-digest out) candidate-sha256)
                (not= (d/file-sha256 (plat/path out "checklist.json")) checklist-sha256)
                (not= (d/file-sha256 (plat/path out "allure-lifecycle-result.schema.json"))
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
        (hjson/spit-utf8 (plat/path out ".grading-room.json")
                         (hjson/compact-json receipt))
        receipt))))

(defn verify-grading-room
  [{:keys [out candidate-sha256 checklist-sha256 schema-sha256 project blind-review]
    :or {project loyly/PROJECT_ID}}]
  (let [blind-review (if (nil? blind-review)
                       (loyly/defaults-blind-review project)
                       blind-review)
        receipt (hjson/read-json (plat/read-text (plat/path out ".grading-room.json")))
        expected-plans (mapv #(str "plan/" %) (selected-plans (plat/path out "checklist.json")))
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
              (not= (d/file-sha256 (plat/path out "checklist.json")) checklist-sha256)
              (not= (d/file-sha256 (plat/path out "allure-lifecycle-result.schema.json"))
                    schema-sha256))
      (throw (ex-info "grading room receipt or inputs changed" {})))
    (doseq [p (plat/list-dir out)]
      (let [name (plat/file-name p)]
        (when-not (#{"plan" "impl" "checklist.json"
                     "allure-lifecycle-result.schema.json" "work"
                     ".grading-room.json"} name)
          (throw (ex-info (str "unexpected grading-room entry: " name) {:name name})))))
    receipt))
