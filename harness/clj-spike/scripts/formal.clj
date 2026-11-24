#!/usr/bin/env bb
;; Formal verification gate for clj-spike (models + traceability + properties).
(ns loyly.spike.scripts.formal
  (:require [babashka.fs :as fs]
            [clojure.string :as str]
            [loyly.spike.formal.models :as models]
            [loyly.spike.formal.props :as props]
            [loyly.spike.formal.theory :as theory]
            [loyly.spike.formal.trace :as trace]
            [loyly.spike.hjson :as hjson]))

(def root (-> *file* fs/parent fs/parent))
(def repo (-> root fs/parent fs/parent))

(defn- out! [m]
  (println (hjson/compact-json m)))

(defn -main [& args]
  (let [args (vec args)
        mode (if (some #{"--theory"} args) :theory :prove)
        repo (or (second (drop-while #(not= "--root" %) args))
                 (str repo))
        𝒜 (theory/theory)]
    (case mode
      :theory
      (do (out!
           (-> 𝒜
               (update :functions
                       (fn [fs]
                         (into {}
                               (map (fn [[k v]]
                                      [k (cond-> v
                                           (:impl v) (update :impl str)
                                           (:proved-by v) (update :proved-by str))])
                                    fs))))
               (update :invariants
                       (fn [inv]
                         (mapv #(update % :proved-by str) inv)))))
          (println (str "theory OK (" (count (:sorts 𝒜)) " sorts, "
                        (count (:invariants 𝒜)) " invariants)"))
          :ok)

      :prove
      (let [cert (trace/certificate repo)
            suite (props/run-all! :num-tests 40)
            sample (models/generate :blind-packet :seed 1)]
        (when-not (:pass? suite)
          (binding [*out* *err*]
            (println "formal properties failed"))
          (System/exit 1))
        (out!
         {:schema "loyly.formal-run.v1"
          :ok true
          :theory (:schema 𝒜)
          :sorts (count (:sorts 𝒜))
          :invariants (mapv :id (:invariants 𝒜))
          :registry-digest (:registry-digest cert)
          :json-schema-pins (mapv :file (:json-schema-pins cert))
          :panel-file (get-in cert [:panel :file])
          :panel-ok (get-in cert [:panel :ok])
          :properties (count (:results suite))
          :sample-blind-item (get sample "item")})
        (println "formal OK")
        :ok))))

(when (= *file* (System/getProperty "babashka.file"))
  (apply -main *command-line-args*))
