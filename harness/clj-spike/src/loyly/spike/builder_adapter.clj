(ns loyly.spike.builder-adapter
  "PoC port of launch-receipt helpers from harness/pi-durable/builder-adapter.ts.
  Process spawn stays on the TS side."
  (:require [babashka.fs :as fs]
            [loyly.spike.receipt-fields :as fields]))

(defn latest-launch
  "Newest launch-N/launch.txt matching session/request, or pending incomplete."
  [evidence-dir session-id request-id]
  (when (fs/exists? evidence-dir)
    (let [names (->> (fs/list-dir evidence-dir)
                     (map fs/file-name)
                     (filter #(re-matches #"launch-\d+" %))
                     (sort-by #(Long/parseLong (subs % 7)) >))]
      (some (fn [name]
              (let [path (fs/file evidence-dir name "launch.txt")]
                (when (fs/regular-file? path)
                  (let [receipt (fields/parse-fields path)]
                    (when (or (nil? (get receipt "session_id"))
                              (nil? (get receipt "request_id"))
                              (and (= (get receipt "session_id") session-id)
                                   (= (get receipt "request_id") request-id)))
                      {:path (str path) :receipt receipt})))))
            names))))

(defn has-builder-launch? [evidence-dir session-id request-id]
  (some? (latest-launch evidence-dir session-id request-id)))

(defn- validate-receipt
  [found {:keys [instruction-sha256 model room image readonly-inputs
                 session-id request-id
                 bash-timeout-floor-seconds bash-timeout-ceiling-seconds
                 store-path parent-conversation-receipt]}]
  (when found
    (let [r (:receipt found)]
      (when (or (not= (get r "session_id") session-id)
                (not= (get r "request_id") request-id)
                (not= (get r "instruction_sha256") instruction-sha256)
                (not= (get r "model") model)
                (not= (get r "room") room)
                (not= (get r "builder_image") image)
                (and (some? store-path) (not= (get r "store") store-path))
                (and (some? parent-conversation-receipt)
                     (not= (get r "parent_conversation_receipt") parent-conversation-receipt))
                (and (some? bash-timeout-floor-seconds)
                     (not= (get r "bash_timeout_floor") (str bash-timeout-floor-seconds)))
                (and (some? bash-timeout-ceiling-seconds)
                     (not= (get r "bash_timeout_ceiling") (str bash-timeout-ceiling-seconds)))
                (if readonly-inputs
                  (not= (get r "room_readonly_inputs") "1")
                  (and (contains? r "room_readonly_inputs")
                       (not= (get r "room_readonly_inputs") "0"))))
        (throw (ex-info
                "builder launch receipt differs from approved room, instruction, image or model"
                {}))))))

(defn- assert-builder-args
  [{:keys [command room instruction image evidence-dir state-root session-id request-id
           bash-timeout-floor-seconds bash-timeout-ceiling-seconds
           store-path parent-conversation-receipt]}]
  (let [request-id (or request-id session-id)]
    (doseq [path [command room instruction image evidence-dir state-root]]
      (when-not (fs/absolute? (fs/path path))
        (throw (ex-info (str "builder path must be absolute: " path) {:path path}))))
    (when-not (re-matches #"[A-Za-z0-9._-]+" session-id)
      (throw (ex-info "unsafe builder session ID" {})))
    (when-not (re-matches #"[A-Za-z0-9._-]+" request-id)
      (throw (ex-info "unsafe builder request ID" {})))
    (when (and (some? bash-timeout-floor-seconds)
               (or (not (integer? bash-timeout-floor-seconds))
                   (< bash-timeout-floor-seconds 1)
                   (> bash-timeout-floor-seconds 1800)))
      (throw (ex-info "invalid bash timeout floor" {})))
    (when (and (some? bash-timeout-ceiling-seconds)
               (or (not (integer? bash-timeout-ceiling-seconds))
                   (< bash-timeout-ceiling-seconds (or bash-timeout-floor-seconds 1800))))
      (throw (ex-info "invalid bash timeout ceiling" {})))
    (when (or (not (fs/exists? room))
              (not (fs/exists? instruction))
              (not (fs/exists? image)))
      (throw (ex-info "builder room, instruction, or image missing" {})))
    (when (and store-path (not (fs/absolute? (fs/path store-path))))
      (throw (ex-info "Pi store path must be absolute" {})))
    (when (and parent-conversation-receipt
               (or (not (fs/absolute? (fs/path parent-conversation-receipt)))
                   (not (fs/exists? parent-conversation-receipt))))
      (throw (ex-info "prior Pi conversation receipt missing" {})))))

(defn reconcile-builder-launch
  "Validate args and an existing launch receipt without spawning (TS runBuilder reconcile path)."
  [{:keys [evidence-dir session-id request-id] :as args}]
  (assert-builder-args args)
  (when-let [found (latest-launch evidence-dir session-id (or request-id session-id))]
    (validate-receipt found args)
    (assoc found :reconciled true)))
