(ns loyly.spike.blind-review
  "PoC port of pure blind-review validation from harness/pi-durable/blind-review.ts.
  Packet prepare / Allure / HTTP probe stay on the TS side for now."
  (:require [babashka.fs :as fs]
            [clojure.string :as str]
            [loyly.spike.digest :as d]
            [loyly.spike.hjson :as hjson]
            [loyly.spike.project.loyly.blind-answer :as answer]
            [loyly.spike.project.loyly.blind-policy :as policy]
            [loyly.spike.project.loyly.identity :as id]
            [loyly.spike.project.loyly.schemas :as schemas]))

(defn validate-blind-response-shape
  "Structural checks from validateBlindReview (sans packet binding)."
  [review packet-sha256]
  (when (or (not= (get review "schema") schemas/BLIND_RESPONSE)
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

(defn validate-blind-packet-shape
  "Structural checks for a blind packet.json (sans Allure attachment equality)."
  [packet]
  (when (or (not= (get packet "schema") schemas/BLIND_PACKET)
            (not= (get packet "item") id/BLIND_ITEM_ID)
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
              (not= question policy/BLIND_QUESTION))
      (throw (ex-info "blind packet files no longer match packet.json" {})))
    {:packet packet
     :packet-sha256 (d/file-sha256 packet-file)}))

(defn parse-review-answer
  "Apply Löyly blind-answer policy to a validated review answer + refusal text."
  [review refusal]
  (answer/parse-blind-agent-answer (get review "answer") refusal))
