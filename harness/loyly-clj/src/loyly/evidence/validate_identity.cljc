(ns loyly.evidence.validate-identity
  "Port of harness/evidence-core/validate-identity.ts (.cljc)."
  (:require [clojure.string :as str]
            [loyly.platform :as plat]))

(def ^:private PLAN-SOURCE
  #"^docs/plan/([0-9]{2}-([a-z][a-z0-9-]*))/spec\.feature:[0-9]+$")

(def ^:private STAMPED-TAG #"^@item-\d\d-\d\d\d$")
(def ^:private FEATURE-LINE (plat/re-flags "m" "^Feature:\\s*(.+?)\\s*$"))

(defn parse-plan-source [source]
  (let [match (re-matches PLAN-SOURCE source)]
    (when-not (and match (nth match 1) (nth match 2))
      (throw (ex-info (str "invalid checklist source: " source) {:source source})))
    {:plan-dir (nth match 1) :slice-key (nth match 2)}))

(defn feature-title-from-spec [spec-text]
  (or (second (re-find FEATURE-LINE spec-text))
      (throw (ex-info "selected plan has no Feature title" {}))))

(defn allure-full-name
  [{:keys [project slice-key item-id blind]}]
  (when-not (re-matches #"[a-z][a-z0-9-]*" project)
    (throw (ex-info (str "invalid grading project: " project) {:project project})))
  (str project "." slice-key "." item-id (when blind ".blind-agent-review")))

(defn label-values [result name]
  (->> (get result "labels" (:labels result))
       (filter #(= name (get % "name" (:name %))))
       (mapv #(get % "value" (:value %)))))

(defn stamped-item-id [result]
  (let [tags (filterv #(re-matches STAMPED-TAG %) (label-values result "tag"))]
    (when (not= 1 (count tags))
      (throw (ex-info "Allure result needs one stamped item tag" {})))
    (subs (first tags) (count "@item-"))))

(defn assert-allure-identity [result expected]
  (let [name (get expected "name" (:name expected))
        full (get expected "fullName" (:full-name expected))
        feature (get expected "feature" (:feature expected))
        rule (get expected "rule" (:rule expected))
        item (get expected "itemId" (:item-id expected))]
    (when (or (not= (get result "name" (:name result)) name)
              (not= (get result "fullName" (:full-name result)) full)
              (not= (get result "testCaseId" (:test-case-id result)) full)
              (not= (get result "historyId" (:history-id result)) full)
              (not= (str/join (label-values result "feature")) feature)
              (not= (str/join (label-values result "story")) rule))
      (throw (ex-info (str "Allure identity or Gherkin labels differ for " item)
                      {:item item})))))
