(ns loyly.spike.tasks.grade
  "Thin wrapper matching harness/pi-durable/tasks/grade.ts."
  (:require [loyly.spike.grader-shards :as shards]))

(defn create-grade-task
  [deps]
  {:name "loyly.proto.grade"
   :version 1
   :prepare-shards shards/prepare-shards
   :combine-shards shards/combine-shards
   :deps deps})