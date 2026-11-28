(ns loyly.formal.main
  "CLI entry for the formal-verification module (prove / print theory)."
  (:require [babashka.fs :as fs]
            [loyly.formal.cycle :as cycle]
            [loyly.formal.models :as models]
            [loyly.formal.props :as props]
            [loyly.formal.theory :as theory]
            [loyly.formal.trace :as trace]
            [loyly.hjson :as hjson]))

(defn- default-repo
  "Resolve git repo root from loyly-clj cwd (bb runs with cwd = harness/loyly-clj)."
  []
  (let [cwd (str (fs/cwd))
        candidate (fs/path cwd ".." "..")]
    (if (fs/directory? (fs/path candidate "harness"))
      (str (fs/absolutize candidate))
      (str (fs/absolutize (fs/path cwd ".." ".." ".."))))))

(defn- out! [m]
  (println (hjson/compact-json m)))

(defn -main [& args]
  (let [args (vec args)
        mode (if (some #{"--theory"} args) :theory :prove)
        repo (or (second (drop-while #(not= "--root" %) args))
                 (default-repo))
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
                         (mapv #(update % :proved-by str) inv)))
               (update-in [:cycle :proof] identity)))
          (println (str "theory OK (" (count (:sorts 𝒜)) " sorts, "
                        (count (:invariants 𝒜)) " model invariants, "
                        (count (get-in 𝒜 [:cycle :Q])) " cycle phases)"))
          :ok)

      :prove
      (let [cert (trace/certificate repo)
            suite (props/run-all! :num-tests 40)
            cyc (cycle/prove-cycle!)
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
          :cycle {:schema "loyly.formal-cycle.v1"
                  :q0 (:q0 cyc)
                  :path (:path cyc)
                  :invariants (:invariants cyc)}
          :registry-digest (:registry-digest cert)
          :json-schema-pins (mapv :file (:json-schema-pins cert))
          :panel-file (get-in cert [:panel :file])
          :panel-ok (get-in cert [:panel :ok])
          :properties (count (:results suite))
          :sample-blind-item (get sample "item")})
        (println "formal OK")
        :ok))))
