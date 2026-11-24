(ns loyly.spike.allure-results
  "PoC port of harness/pi-durable/allure-results.ts (Ajv schema compile deferred)."
  (:require [babashka.fs :as fs]
            [clojure.string :as str]
            [loyly.spike.digest :as d]
            [loyly.spike.evidence.validate-identity :as ident]
            [loyly.spike.evidence.validate-result :as evid]
            [loyly.spike.hjson :as hjson]
            [loyly.spike.project.loyly :as loyly])
  (:import [java.security MessageDigest]))

(def ^:private RESULT-RE
  #"(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-result\.json$")

(defn- structural-allure? [result]
  (and (map? result)
       (string? (get result "uuid"))
       (string? (get result "status"))
       (string? (get result "stage"))
       (map? (get result "statusDetails"))
       (vector? (get result "labels"))
       (vector? (get result "attachments"))
       (vector? (get result "steps"))))

(defn- identity-for [room item project]
  (let [{:keys [plan-dir slice-key]} (ident/parse-plan-source (or (get item "source") ""))]
    (when-not (= (subs plan-dir 0 2) (subs (get item "id") 0 2))
      (throw (ex-info (str "Allure item has no matching numbered plan source: "
                           (or (get item "id") "unknown"))
                      {})))
    (let [feature (ident/feature-title-from-spec
                   (slurp (fs/file room "plan" plan-dir "spec.feature") :encoding "UTF-8"))]
      {:full-name (ident/allure-full-name
                   {:project project :slice-key slice-key :item-id (get item "id")})
       :feature feature})))

(defn- load-allure-room [room]
  (let [checklist (hjson/read-json (slurp (fs/file room "checklist.json") :encoding "UTF-8"))
        items (get checklist "items")
        receipt (hjson/read-json (slurp (fs/file room ".grading-room.json") :encoding "UTF-8"))
        project (or (get receipt "project") loyly/PROJECT_ID)
        blind-review (if (contains? receipt "blindReview")
                       (get receipt "blindReview")
                       true)]
    (when-not (re-matches #"[a-z][a-z0-9-]*" project)
      (throw (ex-info "invalid grading project" {:project project})))
    (when (or (not (vector? items)) (empty? items)
              (not= (count items) (count (set (map #(get % "id") items)))))
      (throw (ex-info "invalid grading checklist" {})))
    {:items items :project project :blind-review blind-review}))

(defn- digest-allure-dir [dir expected-files]
  (let [digest (MessageDigest/getInstance "SHA-256")]
    (doseq [name (sort (map fs/file-name (fs/list-dir dir)))]
      (when (or (not (contains? expected-files name))
                (not (fs/regular-file? (fs/path dir name))))
        (throw (ex-info (str "unexpected Allure result entry: " name) {:name name})))
      (.update digest (.getBytes name "UTF-8"))
      (.update digest (byte-array [0]))
      (.update digest (fs/read-all-bytes (fs/path dir name)))
      (.update digest (byte-array [0])))
    (d/hex (.digest digest))))

(defn- read-surprises [room by-id]
  (let [raw (hjson/read-json (slurp (fs/file room "work" "surprises.json") :encoding "UTF-8"))]
    (when-not (vector? raw)
      (throw (ex-info "surprises must be a JSON array" {})))
    (vec
     (mapcat
      (fn [surprise]
        (let [ids (if (string? (get surprise "item"))
                    (str/split (get surprise "item") #",\s*")
                    [])
              raw-path (get surprise "evidence_file")
              evidence-file (if (and (string? raw-path) (not (str/starts-with? raw-path "work/")))
                              (str "work/" raw-path)
                              raw-path)]
          (when (or (empty? ids)
                    (some #(not (contains? by-id %)) ids)
                    (not (string? (get surprise "observation")))
                    (not (string? evidence-file))
                    (not (re-matches #"work/[A-Za-z0-9._/-]+" evidence-file))
                    (str/includes? evidence-file "..")
                    (re-find #"^work/runtime-[^/]+/" evidence-file)
                    (not (fs/regular-file? (fs/path room evidence-file))))
            (throw (ex-info "invalid surprise evidence" {})))
          (map (fn [id]
                 (array-map "item" id
                            "observation" (get surprise "observation")
                            "evidence_file" evidence-file))
               ids)))
      raw))))

(defn read-allure-results
  "Read and judge Allure lifecycle results in a grading room."
  [room]
  (let [{:keys [items project blind-review]} (load-allure-room room)
        identities (into {} (map (fn [item]
                                   [(get item "id") (identity-for room item project)])
                                 items))
        spec-sha (when (and blind-review (loyly/requires-blind-handoff project items))
                   (d/file-sha256 (fs/path room loyly/BLIND_SPEC_RELATIVE)))
        pending-prefix (loyly/pending-evidence-prefix spec-sha)
        dir (fs/path room "work" "allure-results")
        files (filterv #(re-matches RESULT-RE %) (map fs/file-name (fs/list-dir dir)))]
    (when-not (= (count files) (count items))
      (throw (ex-info "grader did not return one Allure result per selected item" {})))
    (let [expected-files (atom (set files))
          by-id
          (reduce
           (fn [by-id file]
             (let [result (hjson/read-json (slurp (fs/file dir file) :encoding "UTF-8"))]
               (when-not (structural-allure? result)
                 (throw (ex-info (str "Allure result structural check failed: " file) {})))
               (when-not (= file (str (get result "uuid") "-result.json"))
                 (throw (ex-info (str "Allure UUID differs from filename: " file) {})))
               (let [item-id (ident/stamped-item-id result)
                     item (first (filter #(= (get % "id") item-id) items))]
                 (when (or (nil? item) (contains? by-id item-id))
                   (throw (ex-info (str "unknown or duplicate Allure item " item-id) {})))
                 (let [expected (get identities item-id)]
                   (when-not expected
                     (throw (ex-info (str "Allure identity missing for " item-id) {})))
                   (evid/assert-allure-result
                    result
                    {:identity {"itemId" item-id
                                "name" (get item "name")
                                "rule" (get item "rule")
                                "feature" (:feature expected)
                                "fullName" (:full-name expected)}})
                   (doseq [attachment (get result "attachments")]
                     (let [path (fs/path dir (get attachment "source"))]
                       (when-not (fs/regular-file? path)
                         (throw (ex-info (str "Allure attachment bytes missing for " item-id
                                              ": " (get attachment "source"))
                                         {})))
                       (swap! expected-files conj (get attachment "source"))))
                   (when (and blind-review
                              (loyly/requires-blind-handoff project items)
                              (= item-id loyly/BLIND_ITEM_ID)
                              (not (loyly/blind-pending-result? result pending-prefix)))
                     (throw (ex-info (str loyly/BLIND_ITEM_ID
                                          " needs a separate blind subagent review")
                                     {})))
                   (assoc by-id item-id result)))))
           {}
           files)
          verdicts (mapv (fn [item]
                           (let [result (get by-id (get item "id"))]
                             (when-not result
                               (throw (ex-info (str "Allure result missing for " (get item "id"))
                                               {})))
                             (array-map
                              "id" (get item "id")
                              "verdict" (if (= "passed" (get result "status")) "pass" "fail")
                              "evidence" (get-in result ["statusDetails" "message"]))))
                         items)
          surprises (read-surprises room by-id)]
      {:verdicts verdicts
       :surprises surprises
       :results (vec (vals by-id))
       :pass (count (filter #(= "pass" (get % "verdict")) verdicts))
       :allure-sha256 (digest-allure-dir dir @expected-files)})))
