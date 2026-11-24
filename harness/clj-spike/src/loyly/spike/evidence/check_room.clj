(ns loyly.spike.evidence.check-room
  "PoC port of harness/evidence-core/check-room-evidence.ts."
  (:require [babashka.fs :as fs]
            [clojure.string :as str]
            [loyly.spike.evidence.validate-identity :as ident]
            [loyly.spike.evidence.validate-result :as evid]
            [loyly.spike.evidence.validate-schema :as schema]
            [loyly.spike.evidence.validate-verdicts :as vv]
            [loyly.spike.hjson :as hjson]))

(defn- label [result name]
  (some (fn [entry]
          (when (= name (get entry "name"))
            (get entry "value")))
        (get result "labels")))

(defn- read-room-result
  [dir name files selected project validate-schema blind?]
  (let [raw (hjson/read-json (slurp (fs/file dir name) :encoding "UTF-8"))]
    (validate-schema raw name)
    (let [item (ident/stamped-item-id raw)
          selected-item (first (filter #(= item (get % "id"))
                                       (get selected "items")))]
      (when-not selected-item
        (throw (ex-info (str "unselected Allure item " item) {:item item})))
      (when (get selected-item "source")
        (when (or (not (string? (get selected-item "name")))
                  (not (string? (get selected-item "rule"))))
          (throw (ex-info (str "checklist item " item " needs name and rule") {})))
        (let [{:keys [plan-dir slice-key]} (ident/parse-plan-source
                                            (get selected-item "source"))
              feature (ident/feature-title-from-spec
                       (slurp (fs/file (get files "room") "plan" plan-dir
                                       "spec.feature")
                              :encoding "UTF-8"))]
          (ident/assert-allure-identity
           raw
           {"itemId" item
            "name" (get selected-item "name")
            "rule" (get selected-item "rule")
            "feature" feature
            "fullName" (ident/allure-full-name
                        {:project project :slice-key slice-key
                         :item-id item :blind blind?})})))
      (evid/validate-result-evidence raw item)
      (doseq [att (or (get raw "attachments") [])]
        (let [src (get att "source")]
          (when (or (not= (fs/file-name src) src)
                    (not (fs/regular-file? (fs/path dir src))))
            (throw (ex-info (str "missing or unsafe attachment " src) {})))))
      {:row raw :item item})))

(defn- collect-raw
  [files seals selected project validate-schema]
  (let [observed (atom {})
        raw-count (atom 0)]
    (doseq [dir (get files "rawAllureDirs")
            name (->> (map fs/file-name (fs/list-dir dir))
                      (filter #(str/ends-with? % "-result.json")))]
      (let [{:keys [row item]}
            (read-room-result dir name files selected project validate-schema false)]
        (when (contains? @observed item)
          (throw (ex-info (str "duplicate raw Allure item " item) {})))
        (when-not (= (label row "tool") (get seals "graderTool"))
          (throw (ex-info (str "raw Allure tool differs from sealed grader for " item)
                          {})))
        (swap! observed assoc item (get row "status"))
        (swap! raw-count inc)))
    (when-not (= @raw-count (count (get selected "items")))
      (throw (ex-info "raw Allure coverage differs from checklist" {})))
    {:observed @observed :raw-count @raw-count}))

(defn- resolve-blind
  [files seals selected project validate-schema observed blind-selected?]
  (let [handoff (get seals "handoffItem")]
    (when (and blind-selected? handoff
               (not= (get observed handoff) "skipped"))
      (throw (ex-info (str handoff " must remain pending for the blind reviewer") {})))
    (let [blind-dir (get files "blindAllureDir")
          blind-results (if (and blind-dir (fs/directory? blind-dir))
                          (->> (map fs/file-name (fs/list-dir blind-dir))
                               (filterv #(str/ends-with? % "-result.json")))
                          [])]
      (when (> (count blind-results) 1)
        (throw (ex-info "multiple blind Allure results" {})))
      (when (and blind-selected? (not= 1 (count blind-results)))
        (throw (ex-info "blind handoff needs exactly one blind Allure result" {})))
      (if-let [name (first blind-results)]
        (let [{:keys [row item]}
              (read-room-result blind-dir name files selected project
                                validate-schema true)]
          (when (or (not handoff)
                    (not= item handoff)
                    (not= (get observed item) "skipped")
                    (not= (label row "tool") (get seals "blindTool"))
                    (not (#{"passed" "failed"} (get row "status"))))
            (throw (ex-info
                    "blind Allure result does not resolve the pending handoff"
                    {})))
          {:blind-results blind-results :blind-status (get row "status")})
        {:blind-results [] :blind-status nil}))))

(defn- assert-verdicts-match [judged observed blind-status]
  (doseq [v (:verdicts judged)]
    (let [raw (get observed (get v "id"))
          status (if (= raw "skipped") blind-status raw)]
      (when (or (nil? status)
                (not (#{"passed" "failed"} status))
                (not= (get v "verdict")
                      (if (= status "passed") "pass" "fail")))
        (throw (ex-info
                (str "filed verdict differs from independent Allure evidence: "
                     (get v "id"))
                {}))))))

(defn check-room-evidence
  "Validate grading-room evidence files against sealed grader/blind tools."
  [files seals]
  (let [project (or (get seals "project") "loyly")
        checklist (hjson/read-json (slurp (get files "checklist") :encoding "UTF-8"))
        verdicts (hjson/read-json (slurp (get files "verdicts") :encoding "UTF-8"))
        surprises (hjson/read-json (slurp (get files "surprises") :encoding "UTF-8"))
        judged (vv/validate-verdict-data checklist verdicts surprises)
        handoff (get seals "handoffItem")
        blind-selected? (boolean
                         (and handoff
                              (some #(= handoff (get % "id"))
                                    (get checklist "items"))))
        validate-schema (schema/compile-allure-schema nil)]
    (when-not (vv/selected-checklist? checklist)
      (throw (ex-info "invalid selected checklist" {})))
    (doseq [s (:surprises judged)]
      (let [f (fs/file (get files "room") (get s "evidence_file"))]
        (when-not (fs/regular-file? f)
          (throw (ex-info (str "missing surprise evidence: "
                               (get s "evidence_file"))
                          {})))))
    (let [{:keys [observed raw-count]}
          (collect-raw files seals checklist project validate-schema)
          {:keys [blind-results blind-status]}
          (resolve-blind files seals checklist project validate-schema
                         observed blind-selected?)]
      (assert-verdicts-match judged observed blind-status)
      {"items" (count (get checklist "items"))
       "passed" (:pass judged)
       "rawAllureResults" raw-count
       "blindAllureResults" (count blind-results)
       "assessments" (if (seq blind-results) ["blind-review"] [])})))
