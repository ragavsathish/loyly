(ns loyly.blind-agent
  "Fresh Pi process adapter for the refusal blind review (.cljc).

  Port of harness/pi-durable/blind-agent-adapter.mjs. Only the two blind text
  files (question.txt, refusal.txt) are placed in the room; the builder host's
  launch receipt supplies process provenance."
  (:require [clojure.string :as str]
            [loyly.blind-review :as blind]
            [loyly.builder-adapter :as builder]
            [loyly.digest :as d]
            [loyly.hjson :as hjson]
            [loyly.platform :as plat]
            [loyly.project.loyly :as loyly]
            [loyly.receipt-fields :as fields]))

(def ^:private ROOM-FILES ["question.txt" "refusal.txt"])

(defn prepare-blind-agent-room
  "Create (if absent) and verify a sealed blind agent room containing only
   question.txt and refusal.txt matching packet-dir."
  [{:keys [packet-dir out]}]
  (when-not (plat/exists? out)
    (plat/create-dirs out)
    (doseq [n ROOM-FILES]
      (plat/copy (plat/path packet-dir n) (plat/path out n))))
  (let [present (sort (map plat/file-name (plat/list-dir out)))]
    (when (or (not= present ROOM-FILES)
              (some (fn [n]
                      (let [p (plat/path out n)]
                        (or (not= :file (plat/lstat-kind p))
                            (not (plat/bytes-equal?
                                  (plat/read-bytes p)
                                  (plat/read-bytes (plat/path packet-dir n)))))))
                    ROOM-FILES))
      (throw (ex-info "blind agent room contains more than the exact refusal and question"
                      {:out out}))))
  {:room-sha256 (d/sha256-string
                 (str/join "\u0000"
                           (map #(str % "\u0000" (d/file-sha256 (plat/path out %)))
                                ROOM-FILES)))})

(defn run-blind-agent
  "Verify pinned inputs and settings, run the blind review agent via :launch-fn
   (defaults to loyly.builder-adapter/run-builder), check room immutability and
   launch receipt, and parse the one-line refusal answer."
  [{:keys [packet-dir grading-room room instruction command image settings model
           evidence-dir state-root session-id instruction-sha256 command-sha256
           image-sha256 settings-sha256 launch-fn spawn-fn]}]
  (let [{:keys [packet packet-sha256]}
        (blind/verify-blind-review-packet {:packet-dir packet-dir :grading-room grading-room})
        _ (doseq [[p expected] [[instruction instruction-sha256]
                                [command command-sha256]
                                [(plat/path image "manifest.json") image-sha256]
                                [settings settings-sha256]]]
            (when-not (= (d/file-sha256 p) expected)
              (throw (ex-info (str "blind agent input digest differs: " p) {:path p}))))
        selected-tools (get (hjson/read-json (plat/read-text settings)) "defaultTools")
        _ (when-not (= ["read"] selected-tools)
            (throw (ex-info "blind agent may receive only the read tool"
                            {:defaultTools selected-tools})))
        {:keys [room-sha256]} (prepare-blind-agent-room {:packet-dir packet-dir :out room})
        launcher (or launch-fn builder/run-builder)
        result (launcher {:command command
                          :room room
                          :instruction instruction
                          :image image
                          :evidence-dir evidence-dir
                          :session-id session-id
                          :model model
                          :state-root state-root
                          :pi-settings settings
                          :room-label "the blind refusal review room"
                          :prompt "Read the two room files and answer in the required one-line format."
                          :spawn-fn spawn-fn})]
    (when-not (zero? (:exit result))
      (throw (ex-info (str "blind agent process exited " (:exit result)) result)))
    (let [receipt (fields/parse-fields (plat/read-text (:receipt result)))]
      (when (or (not= (get receipt "session_id") session-id)
                (not= (get receipt "model") model)
                (not= (get receipt "room") room)
                (not= (get receipt "instruction_sha256") instruction-sha256)
                (not= (get receipt "pi_settings_sha256") settings-sha256)
                (not= (get receipt "image_manifest_sha256") image-sha256))
        (throw (ex-info "blind agent launch receipt differs from pinned inputs"
                        {:receipt receipt})))
      (when-not (= (:room-sha256 (prepare-blind-agent-room {:packet-dir packet-dir :out room}))
                   room-sha256)
        (throw (ex-info "blind agent room changed during review" {:room room})))
      (let [stdout-path (plat/path (plat/parent (:receipt result)) "pi.stdout")
            answer (str/trim (plat/read-text stdout-path))
            refusal (plat/read-text (plat/path packet-dir "refusal.txt"))
            parsed (loyly/parse-blind-agent-answer answer refusal)]
        {:review (array-map
                  "schema" loyly/BLIND_RESPONSE
                  "packet_sha256" packet-sha256
                  "reviewer_kind" "agent"
                  "reviewer" (str "Pi " model " session " session-id)
                  "had_not_read_configuration" true
                  "saw_only_refusal" true
                  "answer" answer
                  "verdict" (:verdict parsed)
                  "reason" (:reason parsed)
                  "reviewed_at" (plat/now-ms)
                  "launch_receipt_sha256" (d/file-sha256 (:receipt result))
                  "agent_output_sha256" (d/file-sha256 stdout-path)
                  "blind_room_sha256" room-sha256)
         :request (:request parsed)
         :reconciled (:reconciled result)
         :launch-receipt (:receipt result)
         :candidate-sha256 (get packet "candidate_sha256")}))))
