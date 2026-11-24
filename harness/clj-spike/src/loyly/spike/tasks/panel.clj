(ns loyly.spike.tasks.panel
  "Thin wrapper matching harness/pi-durable/tasks/panel.ts."
  (:require [loyly.spike.panel-adapter :as panel]))

(defn create-panel-task
  [deps]
  {:name "loyly.proto.panel"
   :version 1
   :run (fn [req] (panel/run-durable-panel (merge req deps)))
   :deps deps})