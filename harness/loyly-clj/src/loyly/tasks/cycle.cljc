(ns loyly.tasks.cycle
  "Thin wrapper matching harness/pi-durable/tasks/cycle.ts."
  (:require [loyly.tasks.cycle-phases :as phases]))

(defn create-cycle-task
  [deps]
  {:name "loyly.proto.cycle"
   :version 1
   :initial {:phase "cut"}
   :phases (phases/create-cycle-phases deps)
   :deps deps})