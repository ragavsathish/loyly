(ns loyly.spike.formal.props
  "Property-based proofs over formal models (test.check + Malli generators)."
  (:require [clojure.test.check :as tc]
            [clojure.test.check.generators :as gen]
            [clojure.test.check.properties :as prop]
            [loyly.spike.continuation :as cont]
            [loyly.spike.digest :as d]
            [loyly.spike.formal.cycle :as cycle]
            [loyly.spike.formal.models :as models]
            [loyly.spike.project.loyly :as loyly]
            [malli.generator :as mg]))

(defn- check!
  [name property & {:keys [num-tests] :or {num-tests 50}}]
  (let [result (tc/quick-check num-tests property)]
    (when-not (:pass? result)
      (throw (ex-info (str "formal property failed: " name)
                      {:name name :result result})))
    {:name name :pass? true :num-tests (:num-tests result)}))

(defn prop-generated-obeys-model
  "∀ generated instances of model m · valid?(m, instance)."
  [model-name]
  (prop/for-all [v (mg/generator (models/schema model-name))]
    (models/valid? model-name v)))

(defn prop-sha256-hex
  "∀ utf-8 strings · sha256(s) matches Sha256 model."
  []
  (prop/for-all [s gen/string]
    (models/valid? :sha256 (d/sha256-string s))))

(defn prop-sha256-deterministic
  "∀ s · sha256(s) = sha256(s)."
  []
  (prop/for-all [s gen/string]
    (= (d/sha256-string s) (d/sha256-string s))))

(defn prop-sha256-length
  "∀ s · |sha256(s)| = 64."
  []
  (prop/for-all [s gen/string]
    (= 64 (count (d/sha256-string s)))))

(defn prop-invalid-sha-rejected
  "∀ short strings · ¬valid?(:sha256, s) when length ≠ 64 or non-hex."
  []
  (prop/for-all [s (gen/such-that #(or (not= 64 (count %))
                                       (not (re-matches #"[0-9a-f]*" %)))
                                  gen/string
                                  100)]
    (not (models/valid? :sha256 s))))

(defn prop-blind-packet-item-fixed
  "∀ BlindPacket · item = BLIND_ITEM_ID (encoded in model)."
  []
  (prop/for-all [p (mg/generator (models/schema :blind-packet))]
    (= loyly/BLIND_ITEM_ID (get p "item"))))

(defn prop-cycle-state-obeys
  "∀ generated CycleState · valid-state?."
  []
  (prop/for-all [s (mg/generator cycle/CycleState)]
    (cycle/valid-state? s)))

(defn prop-succ-on-path
  "∀ adjacent (q,q') on the unique path · transition?(q,q')."
  []
  (prop/for-all [i (gen/choose 0 (- (count cycle/Q) 2))]
    (cycle/transition? (nth cycle/Q i) (nth cycle/Q (inc i)))))

(defn prop-panel-selection-attempt
  "∀ PanelSelection · attempt ∈ {1,2}."
  []
  (prop/for-all [s (mg/generator (models/schema :panel-selection))]
    (contains? #{1 2} (get s "attempt"))))

(defn prop-grader-shards-bounded
  "∀ GraderShards · 1 ≤ |shards| ≤ 16 and ids unique."
  []
  (prop/for-all [shards (mg/generator (models/schema :grader-shards))]
    (and (<= 1 (count shards) 16)
         (= (count shards) (count (set (map #(get % "id") shards)))))))

(defn prop-continuation-max
  "MAX_CONTINUATIONS is the fixed builder retry bound (3)."
  []
  (prop/for-all [_ (gen/return true)]
    (= 3 cont/MAX_CONTINUATIONS)))

(defn run-all!
  "Execute the formal property suite; throw on first failure."
  [& {:keys [num-tests] :or {num-tests 40}}]
  (let [models-to-gen [:sha256 :commit :item-id :blind-packet :blind-response
                       :blind-probe :panel-summary :panel-plan :score-input
                       :checklist :verdict :verdicts :scores :grading-room
                       :panel-vm-run :panel-report :panel-selection
                       :grader-shard :grader-shards :continuation-ids
                       :audit-row :audit-rows :supplemental-grade
                       :worker-config :gate-receipt :replay-evidence :live-run]
        _ (cycle/prove-cycle!)
        results
        (vec
         (concat
          [(check! :sha256-hex (prop-sha256-hex) :num-tests num-tests)
           (check! :sha256-deterministic (prop-sha256-deterministic) :num-tests num-tests)
           (check! :sha256-length (prop-sha256-length) :num-tests num-tests)
           (check! :invalid-sha-rejected (prop-invalid-sha-rejected) :num-tests (min 30 num-tests))
           (check! :blind-packet-item (prop-blind-packet-item-fixed) :num-tests num-tests)
           (check! :cycle-state-obeys (prop-cycle-state-obeys) :num-tests (min 25 num-tests))
           (check! :cycle-succ-on-path (prop-succ-on-path) :num-tests num-tests)
           (check! :panel-selection-attempt (prop-panel-selection-attempt) :num-tests num-tests)
           (check! :grader-shards-bounded (prop-grader-shards-bounded) :num-tests (min 25 num-tests))
           (check! :continuation-max (prop-continuation-max) :num-tests 1)]
          (for [m models-to-gen]
            (check! (keyword (str "gen-obeys-" (name m)))
                    (prop-generated-obeys-model m)
                    :num-tests (min (if (= m :live-run) 15 25) num-tests)))))]
    {:schema "loyly.formal-props.v1"
     :pass? (every? :pass? results)
     :results results
     :cycle (cycle/prove-cycle!)}))
