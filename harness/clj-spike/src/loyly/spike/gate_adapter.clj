(ns loyly.spike.gate-adapter
  "PoC port of receipt reconciliation from harness/pi-durable/gate-adapter.ts.
  Process spawn / gate-host.sh stay on the TS side."
  (:require [babashka.fs :as fs]
            [loyly.spike.digest :as d]
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
