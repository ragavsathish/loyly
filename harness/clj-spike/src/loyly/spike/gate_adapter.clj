(ns loyly.spike.gate-adapter
  "PoC port of receipt reconciliation from harness/pi-durable/gate-adapter.ts.
  Process spawn / gate-host.sh stay on the TS side."
  (:require [babashka.fs :as fs]
            [babashka.process :as p]
            [clojure.string :as str]
            [loyly.spike.digest :as d]
            [loyly.spike.hjson :as hjson]
            [loyly.spike.receipt-fields :as fields]))

(defn read-gate-receipt
  "Port of receipt(out, room, candidateSha256). Nil when no receipt yet."
  [out room candidate-sha256]
  (let [path (fs/file out "receipt.txt")]
    (when (fs/regular-file? path)
      (let [result (fields/parse-fields path)
            log-sha (get result "log_sha256")
            exit (get result "exit")]
        (when (or (not= (get result "room") room)
                  (not= (get result "candidate_sha256") candidate-sha256)
                  (nil? exit)
                  (not (re-matches #"\d+" exit))
                  (nil? log-sha)
                  (not (re-matches #"[0-9a-f]{64}" log-sha))
                  (not= log-sha (d/file-sha256 (fs/file out "gate.log"))))
          (throw (ex-info "gate receipt does not match room, candidate or log" {})))
        {:exit (Long/parseLong exit)
         :log-sha256 log-sha
         :receipt (str path)}))))

(defn assert-gate-args
  [{:keys [room out candidate-sha256]}]
  (when (or (not (fs/absolute? (fs/path room)))
            (not (fs/absolute? (fs/path out)))
            (not (re-matches #"[0-9a-f]{64}" (str candidate-sha256))))
    (throw (ex-info "gate needs absolute paths and a candidate SHA-256" {})))
  (when-not (fs/regular-file? (fs/path room "harness" "verify.sh"))
    (throw (ex-info "legacy gate missing" {}))))

(defn reconcile-gate
  "If a valid receipt already exists, return it with :reconciled true."
  [{:keys [room out candidate-sha256] :as args}]
  (assert-gate-args args)
  (when-let [done (read-gate-receipt out room candidate-sha256)]
    (assoc done :reconciled true)))

(defn live-pid?
  "True when pid is a live gate-host wrapper (injectable `:ps-fn` for tests)."
  [pid & {:keys [ps-fn host-marker]
          :or {host-marker "gate-host.sh"}}]
  (let [ps-fn (or ps-fn
                  (fn [id]
                    (let [{:keys [exit out]}
                          @(p/process ["ps" "-p" (str id) "-o" "command="]
                                       {:out :string :err :string})]
                      (and (zero? exit) (str/includes? out host-marker)))))]
    (when (re-matches #"^\d+$" (str pid))
      (ps-fn pid))))

(defn run-gate
  "Run or reconcile the legacy gate. Inject `:spawn-fn`, `:pause-fn`, `:live-fn`."
  [{:keys [room out candidate-sha256 timeout-ms spawn-fn pause-fn live-fn]
    :or {timeout-ms 3600000
         pause-fn (fn [ms] (Thread/sleep ms))
         live-fn live-pid?}
    :as args}]
  (assert-gate-args args)
  (fs/create-dirs out)
  (let [receipt (fn [] (read-gate-receipt out room candidate-sha256))]
    (if-let [done (receipt)]
      (assoc done :reconciled true)
      (let [intent (fs/file out "intent.json")
            running (fs/file out "running.txt")]
        (cond
          (fs/regular-file? intent)
          (let [recorded (hjson/read-json (slurp intent :encoding "UTF-8"))]
            (when (or (not= (get recorded "room") room)
                      (not= (get recorded "candidateSha256") candidate-sha256))
              (throw (ex-info "gate intent differs from candidate" {})))
            (dotimes [_ 100]
              (when-not (fs/regular-file? running)
                (pause-fn 50)))
            (when-not (fs/regular-file? running)
              (throw (ex-info "gate launch was interrupted before process receipt" {})))
            (let [started (fields/parse-fields running)]
              (when (or (not= (get started "room") room)
                        (not= (get started "candidate_sha256") candidate-sha256))
                (throw (ex-info "gate running receipt differs from candidate" {})))
              (let [began (System/currentTimeMillis)]
                (loop []
                  (if-let [done (receipt)]
                    (assoc done :reconciled true)
                    (if (live-fn (get started "pid"))
                      (do
                        (when (> (- (System/currentTimeMillis) began) timeout-ms)
                          (throw (ex-info "surviving gate exceeded deadline" {})))
                        (pause-fn 250)
                        (recur))
                      (if-let [done (receipt)]
                        (assoc done :reconciled true)
                        (throw (ex-info
                                "gate process ended without a receipt; discard its gate room and retry separately"
                                {})))))))))

          :else
          (do
            (when (fs/exists? intent)
              (throw (ex-info "gate intent already exists" {})))
            (hjson/spit-utf8 intent
                             (str (hjson/compact-json {"room" room
                                                       "candidateSha256" candidate-sha256})
                                  "\n"))
            (when-not spawn-fn
              (throw (ex-info "gate spawn not implemented in clj-spike; pass :spawn-fn" {})))
            (let [spawned (spawn-fn args)]
              (when (:error spawned)
                (throw (ex-info "gate spawn failed" spawned)))
              (when (:wait-ms spawned)
                (pause-fn (:wait-ms spawned)))
              (if-let [done (receipt)]
                (assoc done :reconciled false)
                (throw (ex-info "gate exited without a receipt" {}))))))))))
