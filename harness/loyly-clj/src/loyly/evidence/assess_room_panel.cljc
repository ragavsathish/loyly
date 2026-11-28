(ns loyly.evidence.assess-room-panel
  "PoC port of harness/evidence-core/assess-room-panel.ts."
  (:require [clojure.string :as str]
            [loyly.digest :as d]
            [loyly.evidence.panel-policy :as policy]
            [loyly.evidence.validate-identity :as ident]
            [loyly.evidence.validate-schema :as schema]
            [loyly.evidence.validate-verdicts :as vv]
            [loyly.hjson :as hjson]
            [loyly.platform :as plat]))

(defn- label [result name]
  (some (fn [entry]
          (when (= name (get entry "name"))
            (get entry "value")))
        (get result "labels")))

(defn- read-allure-dir [dir validate-schema]
  (when-not (plat/directory? dir)
    (throw (ex-info (str "panel Allure directory missing: " dir) {})))
  (mapv
   (fn [name]
     (let [result (hjson/read-json (plat/read-text (plat/path dir name)))]
       (validate-schema result name)
       (let [item (ident/stamped-item-id result)
             status (get result "status")]
         (when-not (#{"passed" "failed" "broken" "skipped"} status)
           (throw (ex-info (str "invalid Allure status in " name) {})))
         {"item" item
          "tool" (or (label result "tool") "")
          "technique" (or (label result "technique") "")
          "status" status
          "message" (or (get-in result ["statusDetails" "message"]) "")
          "result_sha256" (d/file-sha256 (plat/path dir name))})))
   (->> (map plat/file-name (plat/list-dir dir))
        (filter #(str/ends-with? % "-result.json")))))

(defn- match-check [plan source item tool technique check-id]
  (let [checks (filterv
                (fn [c]
                  (and (= source (get c "source"))
                       (some #{item} (get c "items"))
                       (= tool (get c "tool"))
                       (= technique (get c "technique"))
                       (or (nil? check-id) (= check-id (get c "id")))))
                (get plan "checks"))]
    (when-not (= 1 (count checks))
      (throw (ex-info (str "panel observation does not match exactly one check: "
                           item "/" tool)
                      {:item item :tool tool})))
    (first checks)))

(defn- scored-items [checklist-path verdicts-path surprises-path]
  (let [checklist (hjson/read-json (plat/read-text checklist-path))
        verdicts (hjson/read-json (plat/read-text verdicts-path))
        surprises (hjson/read-json (plat/read-text surprises-path))
        _ (vv/validate-verdict-data checklist verdicts surprises)
        by-id (into {} (map (fn [i] [(get i "id") i]) (get checklist "items")))]
    (mapv (fn [v]
            (let [item (get by-id (get v "id"))]
              (when (or (not (string? (get item "rule")))
                        (str/blank? (str/trim (get item "rule"))))
                (throw (ex-info (str "checklist item " (get v "id")
                                     " needs a rule for the panel")
                                {})))
              {"id" (get v "id")
               "rule" (get item "rule")
               "verdict" (get v "verdict")}))
          verdicts)))

(defn assess-room-panel
  "Evaluate panel plan against room Allure + filed verdicts."
  [files]
  (let [plan (hjson/read-json (plat/read-text (get files "plan")))
        _ (when (or (not (vector? (get plan "checks")))
                    (empty? (get plan "checks")))
            (throw (ex-info "panel plan has no checks" {})))
        scored (scored-items (get files "checklist")
                             (get files "verdicts")
                             (get files "surprises"))
        validate-schema (schema/compile-allure-schema nil)
        runtime (get files "runtime")
        observations
        (vec
         (concat
          (mapcat
           (fn [dir]
             (map (fn [row]
                    (let [check (match-check plan "raw-grader"
                                             (get row "item") (get row "tool")
                                             (get row "technique") nil)]
                      {"id" (get check "id")
                       "item" (get row "item")
                       "tool" (get row "tool")
                       "technique" (get row "technique")
                       "status" (get row "status")
                       "runtime" runtime
                       "result_sha256" (get row "result_sha256")
                       "message" (get row "message")}))
                  (read-allure-dir dir validate-schema)))
           (get files "rawAllureDirs"))
          (when-let [blind (get files "blindAllureDir")]
            (map (fn [row]
                   (let [check (match-check plan "blind-review"
                                            (get row "item") (get row "tool")
                                            (get row "technique") nil)]
                     {"id" (get check "id")
                      "item" (get row "item")
                      "tool" (get row "tool")
                      "technique" (get row "technique")
                      "status" (get row "status")
                      "runtime" runtime
                      "result_sha256" (get row "result_sha256")
                      "message" (get row "message")}))
                 (read-allure-dir blind validate-schema)))
          (mapcat
           (fn [[check-id dir]]
             (map (fn [row]
                    (let [check (match-check plan "specialist"
                                             (get row "item") (get row "tool")
                                             (get row "technique") check-id)]
                      {"id" (get check "id")
                       "item" (get row "item")
                       "tool" (get row "tool")
                       "technique" (get row "technique")
                       "status" (get row "status")
                       "runtime" runtime
                       "result_sha256" (get row "result_sha256")
                       "message" (get row "message")}))
                  (read-allure-dir dir validate-schema)))
           (or (get files "specialistDirs") {}))))
        assessed (policy/evaluate-panel plan scored observations)]
    {"checks" (vec (:checks assessed))
     "items" (vec (:items assessed))
     "gaps" (vec (:gaps assessed))
     "panel_outcome" (:panel-outcome assessed)}))
