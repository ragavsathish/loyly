(ns loyly.spike.gate-effects
  "PoC port of harness/pi-durable/gate-effects.ts without Effect-TS.
  `run` is injected (gate-adapter.reconcile-gate or a spawn wrapper)."
  (:require [babashka.fs :as fs]
            [loyly.spike.gate-adapter :as gate]))

(defn verify-candidate
  "Run/reconcile the gate and return a GateResult-shaped map."
  [{:keys [room out candidate-sha256 timeout-ms run]
    :or {timeout-ms 3600000}}]
  (let [run (or run
                (fn [req]
                  (or (gate/reconcile-gate req)
                      (throw (ex-info "gate spawn not implemented in clj-spike; pass :run"
                                      {})))))
        receipt (run {:room room
                      :out out
                      :candidate-sha256 candidate-sha256
                      :timeout-ms timeout-ms})]
    {:passed (zero? (:exit receipt))
     :exit (:exit receipt)
     :log (str (fs/path out "gate.log"))
     :log-sha256 (:log-sha256 receipt)
     :candidate-sha256 candidate-sha256
     :reconciled (boolean (:reconciled receipt))}))
