(ns loyly.supplemental-grade
  "Merge independent capability-specific probes for an already scored candidate (.cljc).

  Port of harness/pi-durable/supplemental-grade.mjs. Never rewrites the Pi audit
  or legacy score."
  (:require [clojure.string :as str]
            [loyly.digest :as d]
            [loyly.evidence.validate-schema :as schema]
            [loyly.grading-room :as room]
            [loyly.hjson :as hjson]
            [loyly.platform :as plat]))

(def PRODUCERS
  [{:id "browser" :tool "Playwright"}
   {:id "protocol" :tool "Node.js"}
   {:id "telemetry" :tool "OpenTelemetry"}])

(def ^:private uuid-result-re #"^[0-9a-f-]{36}-result\.json$")
(def ^:private item-tag-re #"^@item-01-0\d\d$")
(def ^:private image-digest-re #"^sha256:[0-9a-f]{64}$")
(def ^:private safe-name-re #"^[A-Za-z0-9._-]+$")

(defn- load-producer-result [dir producer validate]
  (let [result-files (filterv #(re-matches uuid-result-re %)
                              (sort (map plat/file-name (plat/list-dir dir))))]
    (when-not (= 1 (count result-files))
      (throw (ex-info (str (:id producer) ": need one Allure result") {:producer (:id producer)})))
    (let [file (first result-files)
          result (hjson/read-json (plat/read-text (plat/path dir file)))]
      (validate result (str (:id producer) "/" file))
      {:file file :result result})))

(defn- assert-producer-shape! [producer result file candidate-sha256]
  (let [labels (get result "labels")
        params (get result "parameters")
        atts (get result "attachments")
        has-tool? (some #(and (= "tool" (get % "name")) (= (:tool producer) (get % "value"))) labels)
        has-item? (some #(and (= "tag" (get % "name")) (re-matches item-tag-re (str (or (get % "value") "")))) labels)
        has-cand? (some #(and (= "candidate_sha256" (get % "name")) (= candidate-sha256 (get % "value"))) params)
        has-rcpt? (some #(and (re-find (plat/re-flags "i" "execution receipt") (str (or (get % "name") "")))
                              (= "application/json" (get % "type")))
                        atts)
        start-ms (get result "start")
        stop-ms (get result "stop")]
    (when (or (not= file (str (get result "uuid") "-result.json"))
              (not (#{"passed" "failed" "skipped" "broken"} (get result "status")))
              (not= "finished" (get result "stage"))
              (not (integer? start-ms))
              (not (integer? stop-ms))
              (< stop-ms start-ms)
              (not has-tool?)
              (not has-item?)
              (not has-cand?)
              (empty? (get-in result ["statusDetails" "message"]))
              (empty? (get result "steps"))
              (empty? atts)
              (not has-rcpt?))
      (throw (ex-info (str (:id producer) ": result lacks bound identity, observation or evidence")
                      {:producer (:id producer)})))))

(defn- assert-producer-receipt! [producer result dir candidate-sha256]
  (let [rcpt-att (first (filter #(and (re-find (plat/re-flags "i" "execution receipt") (str (or (get % "name") "")))
                                      (= "application/json" (get % "type")))
                                (get result "attachments")))
        rcpt (hjson/read-json (plat/read-text (plat/path dir (get rcpt-att "source"))))
        rcpt-cand (or (get rcpt "candidate_sha256")
                      (get rcpt "candidateSha")
                      (get-in rcpt ["result" "candidateSha256"]))
        image-digest (or (get rcpt "imageDigest") (get rcpt "image_oci_digest"))]
    (when (or (not= rcpt-cand candidate-sha256)
              (not (re-matches image-digest-re (str (or image-digest "")))))
      (throw (ex-info (str (:id producer) ": VM receipt is not bound to the candidate and image")
                      {:producer (:id producer)})))
    (case (:id producer)
      "browser"
      (when (or (not= 0 (get rcpt "exitCode"))
                (not= false (get-in rcpt ["candidateMount" "RW"]))
                (not= true (get rcpt "readOnlyRootFilesystem"))
                (not= "none" (get rcpt "networkMode")))
        (throw (ex-info "browser VM receipt lacks read-only, no-network execution proof" {})))

      "protocol"
      (when-not (= 0 (get rcpt "vm_exit_code"))
        (throw (ex-info "protocol Gondolin VM did not exit successfully" {})))

      "telemetry"
      (when (or (not (get rcpt "containerId"))
                (not (str/includes? (str (get rcpt "isolation")) "Docker Desktop Linux VM")))
        (throw (ex-info "telemetry Linux VM receipt is incomplete" {})))

      nil)
    {:receipt-attachment rcpt-att :image-digest image-digest}))

(defn- copy-producer-evidence! [producer result file dir results-dir seen-names]
  (let [files (into [file] (map #(get % "source") (get result "attachments")))]
    (when-not (= (count (set files)) (count files))
      (throw (ex-info (str (:id producer) ": duplicate attachment name") {})))
    (reduce (fn [hashes n]
              (when (or (not (re-matches safe-name-re (str n)))
                        (contains? @seen-names n)
                        (not= :file (plat/lstat-kind (plat/path dir n))))
                (throw (ex-info (str (:id producer) ": missing, unsafe or colliding evidence file " n) {})))
              (swap! seen-names conj n)
              (plat/copy (plat/path dir n) (plat/path results-dir n))
              (assoc hashes n (d/file-sha256 (plat/path dir n))))
            (array-map)
            files)))

(defn- default-render-supplemental! [{:keys [pi-durable out results]}]
  (let [cli (plat/path pi-durable "node_modules" ".bin" "allure")
        report (plat/path out "allure-report")
        res (plat/exec-sync [cli "generate" results
                             "--config" (plat/path pi-durable "allurerc.mjs")
                             "--output" report "--clean"]
                            {:dir pi-durable})]
    (when-not (zero? (:exit res))
      (throw (ex-info (str "Allure render failed: " (:err res)) res)))
    report))

(defn collect-supplemental-grade
  "Collect, verify, and merge supplemental probe results into probes/combined."
  [original probes {:keys [pi-durable allure-cli-fn]}]
  (let [original (plat/absolutize original)
        probes (plat/absolutize probes)
        here (plat/absolutize (or pi-durable (plat/path (plat/cwd) "harness" "pi-durable")))
        score-file (plat/path original "instrument" "harness" "cycles" "02" "scores.json")
        score-before (d/file-sha256 score-file)
        candidate-sha256 (room/candidate-digest (plat/path original "fenced-room"))
        score-input (hjson/read-json (plat/read-text (plat/path original "score-input.json")))]
    (when-not (= candidate-sha256 (get score-input "candidate_sha256"))
      (throw (ex-info "frozen candidate differs from the original scored candidate" {})))
    (let [schema-file (plat/path here "allure-lifecycle-result.schema.json")
          schema-sha256 (d/file-sha256 schema-file)
          validate (schema/compile-allure-schema (hjson/read-json (plat/read-text schema-file)))
          out (plat/path probes "combined")]
      (when (plat/exists? out)
        (throw (ex-info "supplemental combined output already exists" {:out out})))
      (let [results (plat/path out "allure-results")
            _ (plat/create-dirs results)
            seen (atom #{})
            producers
            (mapv (fn [producer]
                    (let [dir (plat/path probes (:id producer))
                          {:keys [file result]} (load-producer-result dir producer validate)
                          _ (assert-producer-shape! producer result file candidate-sha256)
                          {:keys [receipt-attachment image-digest]}
                          (assert-producer-receipt! producer result dir candidate-sha256)
                          hashes (copy-producer-evidence! producer result file dir results seen)
                          item-tag (some #(when (= "tag" (get % "name")) (get % "value"))
                                         (get result "labels"))]
                      (array-map
                       "id" (:id producer)
                       "tool" (:tool producer)
                       "result" file
                       "item" item-tag
                       "status" (get result "status")
                       "start" (get result "start")
                       "stop" (get result "stop")
                       "image_digest" image-digest
                       "execution_receipt_sha256" (get hashes (get receipt-attachment "source"))
                       "files" hashes)))
                  PRODUCERS)
            overlap (- (apply min (map #(get % "stop") producers))
                       (apply max (map #(get % "start") producers)))]
        (when (<= overlap 0)
          (throw (ex-info "specialist VM probes did not overlap in time" {:overlap overlap})))
        (let [report ((or allure-cli-fn default-render-supplemental!)
                      {:pi-durable here :out out :results results})
              summary (hjson/read-json (plat/read-text (plat/path report "summary.json")))
              stats (get summary "stats")]
          (when-not (= (count PRODUCERS) (get stats "total"))
            (throw (ex-info "Allure report omitted a specialist probe" {:stats stats})))
          (let [unchanged? (= (d/file-sha256 score-file) score-before)]
            (when-not unchanged?
              (throw (ex-info "original score changed during supplemental grading" {})))
            (let [manifest (array-map
                            "schema" "loyly.supplemental-grade.v1"
                            "evidence_kind" "grading-only; no new Pi cycle"
                            "source_commit" (get score-input "source_commit")
                            "candidate_sha256" candidate-sha256
                            "original_score_sha256" score-before
                            "allure_schema_sha256" schema-sha256
                            "producers" producers
                            "parallel_overlap_ms" overlap
                            "report_html_sha256" (d/file-sha256 (plat/path report "index.html"))
                            "original_score_unchanged" unchanged?)]
              (hjson/spit-utf8 (plat/path out "manifest.json")
                               (str (hjson/write manifest) "\n"))
              {:out out :manifest manifest :stats stats})))))))
