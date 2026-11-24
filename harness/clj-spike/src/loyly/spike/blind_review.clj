(ns loyly.spike.blind-review
  "PoC port of harness/pi-durable/blind-review.ts.
  Probe spawn/HTTP is injectable via `:probe-fn` / `:fetch-fn`."
  (:require [babashka.fs :as fs]
            [clojure.string :as str]
            [loyly.spike.allure-results :as allure]
            [loyly.spike.digest :as d]
            [loyly.spike.evidence.validate-schema :as schema]
            [loyly.spike.grading-room :as room]
            [loyly.spike.hjson :as hjson]
            [loyly.spike.project.loyly :as loyly])
  (:import [java.util UUID]))

(defn- refusal-basename []
  (fs/file-name loyly/BLIND_REFUSAL_FILE))

(defn- pending-blind-result [judged]
  (some (fn [result]
          (when (some #(and (= "tag" (get % "name"))
                            (= (str "@item-" loyly/BLIND_ITEM_ID) (get % "value")))
                      (get result "labels"))
            result))
        (:results judged)))

(defn- bytes-equal? [a b]
  (= (seq a) (seq b)))

(defn prepare-blind-review
  "Build a blind packet directory from a graded room with a pending refusal."
  [{:keys [grading-room out]}]
  (when (fs/exists? out)
    (throw (ex-info "blind review packet already exists" {})))
  (let [judged (allure/read-allure-results grading-room)
        pending (pending-blind-result judged)]
    (when-not (and pending
                   (= "skipped" (get pending "status"))
                   (= "pending" (get pending "stage")))
      (throw (ex-info (str "grader did not leave " loyly/BLIND_ITEM_ID " pending") {})))
    (let [shard-root (fs/path grading-room "work" "shards")
          sources (->> (when (fs/directory? shard-root) (fs/list-dir shard-root))
                       (map #(fs/file % (refusal-basename)))
                       (filter fs/regular-file?)
                       vec)]
      (when-not (= 1 (count sources))
        (throw (ex-info "need exactly one regular blind-review refusal file" {})))
      (let [refusal-bytes (fs/read-all-bytes (first sources))
            refusal (String. ^bytes refusal-bytes "UTF-8")]
        (when (or (zero? (alength ^bytes refusal-bytes))
                  (> (alength ^bytes refusal-bytes) 8192))
          (throw (ex-info "blind-review refusal is empty or too large" {})))
        (when-not (some (fn [att]
                          (bytes-equal?
                           refusal-bytes
                           (fs/read-all-bytes
                            (fs/file grading-room "work" "allure-results" (get att "source")))))
                        (or (get pending "attachments") []))
          (throw (ex-info "blind packet differs from the pending Allure refusal attachment" {})))
        (let [packet (array-map
                      "schema" loyly/BLIND_PACKET
                      "item" loyly/BLIND_ITEM_ID
                      "candidate_sha256" (room/candidate-digest grading-room)
                      "checklist_sha256" (d/file-sha256 (fs/file grading-room "checklist.json"))
                      "spec_sha256" (d/file-sha256 (fs/file grading-room loyly/BLIND_SPEC_RELATIVE))
                      "allure_results_sha256" (:allure-sha256 judged)
                      "refusal_sha256" (d/sha256-string refusal))]
          (fs/create-dirs out)
          (hjson/spit-utf8 (fs/file out "refusal.txt") refusal)
          (hjson/spit-utf8 (fs/file out "question.txt") loyly/BLIND_QUESTION)
          (hjson/spit-utf8 (fs/file out "packet.json")
                           (str (hjson/compact-json packet) "\n"))
          (hjson/spit-utf8
           (fs/file out "response-template.json")
           (str (hjson/compact-json
                 (array-map
                  "schema" loyly/BLIND_RESPONSE
                  "packet_sha256" (d/file-sha256 (fs/file out "packet.json"))
                  "reviewer_kind" "agent"
                  "reviewer" ""
                  "had_not_read_configuration" false
                  "saw_only_refusal" false
                  "answer" ""
                  "verdict" ""
                  "reason" ""
                  "reviewed_at" 0))
                "\n"))
          packet)))))

(defn validate-blind-packet-shape
  "Structural checks for a blind packet.json."
  [packet]
  (when (or (not= (get packet "schema") loyly/BLIND_PACKET)
            (not= (get packet "item") loyly/BLIND_ITEM_ID)
            (not (re-matches #"[0-9a-f]{64}" (str (get packet "candidate_sha256"))))
            (not (re-matches #"[0-9a-f]{64}" (str (get packet "checklist_sha256"))))
            (not (re-matches #"[0-9a-f]{64}" (str (get packet "spec_sha256"))))
            (not (re-matches #"[0-9a-f]{64}" (str (get packet "allure_results_sha256"))))
            (not (re-matches #"[0-9a-f]{64}" (str (get packet "refusal_sha256")))))
    (throw (ex-info "invalid blind review packet shape" {})))
  packet)

(defn verify-packet-files
  "Check packetDir question/refusal digests against packet.json fields."
  [packet-dir]
  (let [packet-file (fs/file packet-dir "packet.json")
        packet (hjson/read-json (slurp packet-file :encoding "UTF-8"))
        refusal (slurp (fs/file packet-dir "refusal.txt") :encoding "UTF-8")
        question (slurp (fs/file packet-dir "question.txt") :encoding "UTF-8")]
    (validate-blind-packet-shape packet)
    (when (or (not= (d/sha256-string refusal) (get packet "refusal_sha256"))
              (not= question loyly/BLIND_QUESTION))
      (throw (ex-info "blind packet files no longer match packet.json" {})))
    {:packet packet
     :packet-sha256 (d/file-sha256 packet-file)}))

(defn verify-blind-review-packet
  "Full bind of packet to grading room digests + pending Allure refusal."
  [{:keys [packet-dir grading-room]}]
  (let [packet-file (fs/file packet-dir "packet.json")
        packet (hjson/read-json (slurp packet-file :encoding "UTF-8"))
        judged (allure/read-allure-results grading-room)
        pending (pending-blind-result judged)
        refusal-bytes (fs/read-all-bytes (fs/file packet-dir "refusal.txt"))
        refusal (String. ^bytes refusal-bytes "UTF-8")]
    (when (or (not= (get packet "schema") loyly/BLIND_PACKET)
              (not= (get packet "item") loyly/BLIND_ITEM_ID)
              (not= (get packet "candidate_sha256") (room/candidate-digest grading-room))
              (not= (get packet "checklist_sha256")
                    (d/file-sha256 (fs/file grading-room "checklist.json")))
              (not= (get packet "spec_sha256")
                    (d/file-sha256 (fs/file grading-room loyly/BLIND_SPEC_RELATIVE)))
              (not= (get packet "allure_results_sha256") (:allure-sha256 judged))
              (not= (get packet "refusal_sha256") (d/sha256-string refusal))
              (not= (slurp (fs/file packet-dir "question.txt") :encoding "UTF-8")
                    loyly/BLIND_QUESTION)
              (not= "skipped" (get pending "status"))
              (not= "pending" (get pending "stage"))
              (not (some (fn [att]
                           (bytes-equal?
                            refusal-bytes
                            (fs/read-all-bytes
                             (fs/file grading-room "work" "allure-results" (get att "source")))))
                         (or (get pending "attachments") []))))
      (throw (ex-info
              "blind review packet no longer matches candidate, spec, checklist or grader result"
              {})))
    {:packet packet
     :packet-sha256 (d/file-sha256 packet-file)}))

(defn validate-blind-response-shape
  "Structural checks from validateBlindReview (sans packet binding)."
  [review packet-sha256]
  (when (or (not= (get review "schema") loyly/BLIND_RESPONSE)
            (not= (get review "packet_sha256") packet-sha256)
            (not= (get review "reviewer_kind") "agent")
            (not (string? (get review "reviewer")))
            (str/blank? (str/trim (str (get review "reviewer"))))
            (not= (get review "had_not_read_configuration") true)
            (not= (get review "saw_only_refusal") true)
            (not (string? (get review "answer")))
            (str/blank? (str/trim (str (get review "answer"))))
            (not (#{"pass" "fail"} (get review "verdict")))
            (not (string? (get review "reason")))
            (str/blank? (str/trim (str (get review "reason"))))
            (not (integer? (get review "reviewed_at")))
            (not (pos? (get review "reviewed_at"))))
    (throw (ex-info "invalid or unbound blind subagent review" {})))
  review)

(defn validate-blind-review
  [{:keys [packet-dir review-file grading-room]}]
  (let [{:keys [packet packet-sha256]}
        (verify-blind-review-packet {:packet-dir packet-dir :grading-room grading-room})
        review (hjson/read-json (slurp review-file :encoding "UTF-8"))]
    (validate-blind-response-shape review packet-sha256)
    {:packet packet
     :review review
     :packet-sha256 packet-sha256
     :review-sha256 (d/file-sha256 review-file)}))

(defn parse-review-answer
  "Apply Löyly blind-answer policy to a validated review answer + refusal text."
  [review refusal]
  (loyly/parse-blind-agent-answer (get review "answer") refusal))

(defn probe-blind-answer
  "HTTP acceptance probe. Pass `:probe-fn` to inject spawn+fetch
  (default throws — runtime stays injectable)."
  [{:keys [packet-dir review-file grading-room request out probe-fn] :as args}]
  (let [{:keys [packet review packet-sha256 review-sha256]}
        (validate-blind-review {:packet-dir packet-dir
                                :review-file review-file
                                :grading-room grading-room})]
    (when-not (= "pass" (get review "verdict"))
      (throw (ex-info "a failed blind review needs no acceptance probe" {})))
    (when (fs/exists? out)
      (throw (ex-info "blind review probe already exists" {})))
    (when (or (not= "POST" (get request "method" (:method request)))
              (let [path (get request "path" (:path request))]
                (and (not= "@booking-form" path)
                     (not (re-matches #"/[A-Za-z0-9/?=&%._-]*" (str path)))))
              (not (string? (get request "body" (:body request))))
              (> (count (str (get request "body" (:body request)))) 4096)
              (not= true (get request "matches_answer" (:matches_answer request))))
      (throw (ex-info
              "probe needs a POST path, bounded body and operator answer-match attestation"
              {})))
    (if-not probe-fn
      (throw (ex-info "blind probe spawn not implemented in clj-spike; pass :probe-fn" {}))
      (probe-fn (assoc args
                       :packet packet
                       :review review
                       :packet-sha256 packet-sha256
                       :review-sha256 review-sha256)))))

(defn- assert-blind-allure-identity
  [result result-file item full-name packet expected-status]
  (when (or (not= result-file (str (get result "uuid") "-result.json"))
            (not= (get result "name") (get item "name"))
            (not= (get result "fullName") full-name)
            (not= (get result "testCaseId") full-name)
            (not= (get result "historyId") full-name)
            (not= (get result "status") expected-status)
            (not= (get result "stage") "finished")
            (not= 1 (count (filter #(and (= "tag" (get % "name"))
                                         (= (str "@item-" loyly/BLIND_ITEM_ID) (get % "value")))
                                  (get result "labels"))))
            (not= (get packet "candidate_sha256")
                  (some #(when (= "candidate_sha256" (get % "name")) (get % "value"))
                        (get result "parameters")))
            (not= (get packet "allure_results_sha256")
                  (some #(when (= "grader_allure_sha256" (get % "name")) (get % "value"))
                        (get result "parameters"))))
    (throw (ex-info "blind subagent Allure result differs from the bound review" {}))))

(declare read-blind-agent-allure)

(defn write-blind-agent-allure
  [{:keys [packet-dir review-file grading-room verification-dir out]}]
  (if (fs/exists? out)
    (read-blind-agent-allure
     {:packet-dir packet-dir :review-file review-file :grading-room grading-room
      :verification-dir verification-dir :out out})
    (let [{:keys [packet review packet-sha256 review-sha256]}
          (validate-blind-review {:packet-dir packet-dir
                                  :review-file review-file
                                  :grading-room grading-room})
          verification
          (when (= "pass" (get review "verdict"))
            (when-not verification-dir
              (throw (ex-info "positive blind review needs an independent HTTP probe" {})))
            (let [v (hjson/read-json
                     (slurp (fs/file verification-dir "verification.json") :encoding "UTF-8"))]
              (when (or (not= (get v "schema") loyly/BLIND_PROBE)
                        (not= (get v "item") loyly/BLIND_ITEM_ID)
                        (not= (get v "candidate_sha256") (get packet "candidate_sha256"))
                        (not= (get v "packet_sha256") packet-sha256)
                        (not= (get v "review_sha256") review-sha256)
                        (not= true (get-in v ["request" "matches_answer"]))
                        (not= (get v "response_sha256")
                              (d/file-sha256 (fs/file verification-dir "response.txt")))
                        (not= (get v "accepted")
                              (let [s (get v "http_status")]
                                (and (>= s 200) (< s 300)))))
                (throw (ex-info "blind review HTTP probe is missing, failed or unbound" {})))
              v))
          checklist (hjson/read-json
                     (slurp (fs/file grading-room "checklist.json") :encoding "UTF-8"))
          item (first (filter #(= loyly/BLIND_ITEM_ID (get % "id")) (get checklist "items")))
          _ (when-not item
              (throw (ex-info (str loyly/BLIND_ITEM_ID " not selected") {})))
          uuid (str (UUID/randomUUID))
          attachment (str (UUID/randomUUID) "-attachment.json")
          response-attachment (when verification (str (UUID/randomUUID) "-attachment.txt"))
          full-name (loyly/blind-allure-full-name "blind-agent-review")
          status (if (and (= "pass" (get review "verdict"))
                          (= true (get verification "accepted")))
                   "passed" "failed")
          result (array-map
                  "uuid" uuid
                  "name" (get item "name")
                  "fullName" full-name
                  "testCaseId" full-name
                  "historyId" full-name
                  "status" status
                  "stage" "finished"
                  "start" (get review "reviewed_at")
                  "stop" (get review "reviewed_at")
                  "statusDetails"
                  {"message"
                   (str (get review "reason") " Answer: " (get review "answer")
                        (when (= false (get verification "accepted"))
                          (str " HTTP " (get verification "http_status")
                               " did not confirm the suggested request.")))}
                  "labels" [{"name" "lifecycle" "value" "pre-production"}
                            {"name" "technique" "value" "usability"}
                            {"name" "tool" "value" "fresh blind subagent"}
                            {"name" "feature" "value" "Booking core"}
                            {"name" "story" "value" (get item "rule")}
                            {"name" "tag" "value" (str "@item-" loyly/BLIND_ITEM_ID)}]
                  "steps" [{"name" "Given the fresh subagent had no configuration and saw only the refusal"
                            "status" "passed" "stage" "finished"}
                           {"name" "When the reviewer named an expected accepted request"
                            "status" "passed" "stage" "finished"}
                           {"name" "Then the refusal was judged usable"
                            "status" status "stage" "finished"}]
                  "attachments"
                  (cond-> [{"name" "Blind review and packet digests"
                            "source" attachment
                            "type" "application/json"}]
                    response-attachment
                    (conj {"name" "Independent HTTP confirmation"
                           "source" response-attachment
                           "type" "text/plain"}))
                  "parameters" [{"name" "candidate_sha256" "value" (get packet "candidate_sha256")}
                               {"name" "grader_allure_sha256"
                                "value" (get packet "allure_results_sha256")}])]
      ((schema/compile-allure-schema nil) result "blind-result")
      (fs/create-dirs out)
      (hjson/spit-utf8 (fs/file out attachment)
                       (hjson/compact-json
                        {"packet_sha256" packet-sha256
                         "review_sha256" review-sha256
                         "review" review
                         "verification" verification}))
      (when response-attachment
        (fs/copy (fs/file verification-dir "response.txt")
                 (fs/file out response-attachment)))
      (hjson/spit-utf8 (fs/file out (str uuid "-result.json"))
                       (hjson/compact-json result))
      {:result result :packet-sha256 packet-sha256 :review-sha256 review-sha256})))

(defn read-blind-agent-allure
  [{:keys [packet-dir review-file grading-room verification-dir out]}]
  (let [{:keys [packet review packet-sha256 review-sha256]}
        (validate-blind-review {:packet-dir packet-dir
                                :review-file review-file
                                :grading-room grading-room})
        names (sort (map fs/file-name (fs/list-dir out)))
        result-files (filterv #(re-matches
                                #"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-result\.json"
                                %)
                              names)]
    (when-not (= 1 (count result-files))
      (throw (ex-info "blind subagent Allure result is incomplete" {})))
    (let [result-file (first result-files)
          result (hjson/read-json (slurp (fs/file out result-file) :encoding "UTF-8"))
          checklist (hjson/read-json
                     (slurp (fs/file grading-room "checklist.json") :encoding "UTF-8"))
          item (first (filter #(= loyly/BLIND_ITEM_ID (get % "id")) (get checklist "items")))
          full-name (loyly/blind-allure-full-name "blind-agent-review")
          _ (when (and (= "pass" (get review "verdict")) (nil? verification-dir))
              (throw (ex-info "positive blind review needs an independent HTTP probe" {})))
          verification (when (= "pass" (get review "verdict"))
                         (hjson/read-json
                          (slurp (fs/file verification-dir "verification.json")
                                 :encoding "UTF-8")))
          expected (if (and (= "pass" (get review "verdict"))
                            (= true (get verification "accepted")))
                     "passed" "failed")]
      ((schema/compile-allure-schema nil) result result-file)
      (assert-blind-allure-identity result result-file item full-name packet expected)
      {:result result :packet-sha256 packet-sha256 :review-sha256 review-sha256})))

(defn final-verdicts-from-blind-review
  [args]
  (let [{:keys [packet-dir review-file grading-room]} args
        {:keys [packet]} (validate-blind-review
                          {:packet-dir packet-dir
                           :review-file review-file
                           :grading-room grading-room})]
    (when (loyly/historical-person-cut? (get packet "spec_sha256"))
      (throw (ex-info
              "the historical person-worded cut cannot be scored with a blind subagent"
              {})))
    (let [raw (allure/read-allure-results grading-room)
          supplemental (read-blind-agent-allure args)]
      {:verdicts
       (mapv (fn [v]
               (if (= loyly/BLIND_ITEM_ID (get v "id"))
                 (array-map
                  "id" loyly/BLIND_ITEM_ID
                  "verdict" (if (= "passed" (get-in supplemental [:result "status"]))
                              "pass" "fail")
                  "evidence" (get-in supplemental [:result "statusDetails" "message"]))
                 v))
             (:verdicts raw))
       :raw-allure-sha256 (:allure-sha256 raw)
       :review-sha256 (:review-sha256 supplemental)})))
