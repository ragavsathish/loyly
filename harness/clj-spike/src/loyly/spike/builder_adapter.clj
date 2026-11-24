(ns loyly.spike.builder-adapter
  "PoC port of launch-receipt helpers from harness/pi-durable/builder-adapter.ts.
  Process spawn stays on the TS side."
  (:require [babashka.fs :as fs]
            [loyly.spike.digest :as d]
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

(defn- ready-launch
  "Wait until launch receipt has binding fields, or nil."
  [evidence-dir session-id request-id & {:keys [pause-fn tries]
                                          :or {pause-fn #(Thread/sleep %)
                                               tries 100}}]
  (loop [n 0 found (latest-launch evidence-dir session-id request-id)]
    (cond
      (nil? found) nil
      (and (get-in found [:receipt "instruction_sha256"])
           (get-in found [:receipt "model"])
           (get-in found [:receipt "wrapper_pid"])) found
      (>= n tries) (throw (ex-info "builder launch receipt stayed incomplete" {}))
      :else (do (pause-fn 50)
                (recur (inc n) (latest-launch evidence-dir session-id request-id))))))

(defn live-pid?
  "Return whether pid still runs expected command (injectable `:ps-fn`)."
  [pid expected & {:keys [ps-fn]
                   :or {ps-fn (fn [p exp]
                                (try
                                  (let [cmd (slurp (str "/proc/" p "/cmdline"))]
                                    (and (string? cmd) (.contains cmd exp)))
                                  (catch Exception _ false)))}}]
  (when (re-matches #"^\d+$" (str pid))
    (ps-fn pid expected)))

(defn run-builder
  "Run or reconcile builder host. Inject `:spawn-fn`, `:pause-fn`, `:live-pid-fn`."
  [{:keys [instruction evidence-dir session-id request-id spawn-fn pause-fn readonly-inputs]
    :or {request-id nil
         pause-fn #(Thread/sleep %)
         readonly-inputs false}
    :as args}]
  (assert-builder-args args)
  (let [request-id (or request-id session-id)
        instruction-sha256 (d/file-sha256 instruction)
        ctx (assoc args :instruction-sha256 instruction-sha256
                   :request-id request-id :readonly-inputs readonly-inputs)]
    (fs/create-dirs evidence-dir)
    (or (when-let [found (latest-launch evidence-dir session-id request-id)]
        (validate-receipt found ctx)
        (when-let [exit (get-in found [:receipt "exit"])]
          {:exit (Long/parseLong exit) :reconciled true :receipt (:path found)}))
      (do
        (when-not spawn-fn
          (throw (ex-info "builder spawn not implemented in clj-spike; pass :spawn-fn" {})))
        (let [child (spawn-fn args)]
          (when (:error child)
            (throw (ex-info "builder spawn failed" child)))
          (when (:wait-ms child)
            (pause-fn (:wait-ms child)))
          (let [found (ready-launch evidence-dir session-id request-id :pause-fn pause-fn)]
            (validate-receipt found ctx)
            (when-not (and found (get-in found [:receipt "exit"]))
              (throw (ex-info "builder host exited without a completed launch receipt" {})))
            (let [exit (Long/parseLong (get-in found [:receipt "exit"]))]
              (when (and (some? (:exit child)) (not= exit (:exit child)))
                (throw (ex-info "builder process exit differs from its launch receipt" {})))
              {:exit exit :reconciled false :receipt (:path found)})))))))
