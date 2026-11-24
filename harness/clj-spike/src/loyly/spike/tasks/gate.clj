(ns loyly.spike.tasks.gate
  "Thin wrapper matching harness/pi-durable/tasks/gate.ts."
  (:require [loyly.spike.gate-adapter :as gate]))

(defn create-gate-task
  "Return a gate task descriptor bound to clj-spike adapters."
  [deps]
  {:name "loyly.proto.gate"
   :version 1
   :initial {:phase "verify"}
   :run (fn [{:keys [room out candidate-sha256] :as req}]
          (gate/run-gate (merge req {:room room :out out
                                     :candidate-sha256 candidate-sha256
                                     :spawn-fn (:spawn-fn deps)})))
   :deps deps})