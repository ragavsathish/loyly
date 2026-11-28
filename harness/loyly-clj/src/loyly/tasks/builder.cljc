(ns loyly.tasks.builder
  "Thin wrapper matching harness/pi-durable/tasks/builder.ts."
  (:require [loyly.builder-adapter :as builder]))

(defn create-builder-task
  [deps]
  {:name "loyly.proto.builder"
   :version 1
   :run (fn [req] (builder/run-builder (merge req deps {:spawn-fn (:spawn-fn deps)})))
   :deps deps})