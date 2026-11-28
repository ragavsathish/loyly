(ns loyly.formal.cycle
  "Mathematical model of the Löyly Pi cycle as a labeled transition system.

  Cycle 𝒞 = (Q, q₀, →, L, F)

  - Q  — canonical phases (prepare -> build -> gate -> grade -> blind-review -> score -> panel -> done)
  - q₀ — initial phase (prepare)
  - →  — successor relation (linear cycle spine)
  - L  — labeling: phase ↦ required models / digests produced
  - F  — accepting states {done}

  Concrete orchestration lives in loyly.node.pi-worker; this ns is the closed math."
  (:require [clojure.test.check.generators :as gen]
            [loyly.cycle-core :as life]
            [loyly.formal.models :as models]
            [loyly.project.loyly :as loyly]
            [malli.core :as m]))

;;; --- Sorts -----------------------------------------------------------------

(def PhaseName
  (into [:enum] life/PHASES))

(def CycleState
  "Runtime configuration of a cycle run (abstract state vector)."
  [:map
   ["phase" PhaseName]
   ["source_commit" {:optional true} models/Commit40]
   ["candidate_sha256" {:optional true} models/Sha256]
   ["checklist_sha256" {:optional true} models/Sha256]
   ["score_cycle" {:optional true}
    [:re {:gen/gen (gen/fmap #(format "%02d" %) (gen/choose 0 99))} #"^\d{2}$"]]
   ["blind_required" {:optional true} :boolean]])

;;; --- Transition system -----------------------------------------------------

(def Q
  "State set = canonical PHASES."
  (vec life/PHASES))

(def q0
  "Initial state."
  "prepare")

(def F
  "Accepting / terminal states."
  #{"done"})

(def successors
  "Total function succ : Q ∖ F → Q  (linear cycle spine)."
  (into {} (map vec (partition 2 1 Q))))

(defn succ
  "δ(q) — unique successor, or nil at done."
  [q]
  (get successors q))

(defn transition?
  "q → q' holds."
  [q q']
  (= (succ q) q'))

(defn path
  "The unique maximal path from q₀: prepare · … · done."
  []
  Q)

;;; --- Labeling: phase ↦ models / obligations --------------------------------

(def labeling
  "L(q) = models that must be Valid at/after phase q (traceability to 𝒜 sorts)."
  {"prepare"      #{:commit :live-run :worker-config :checklist :item-id :continuation-ids}
   "build"        #{:sha256 :continuation-ids}
   "gate"         #{:gate-receipt :sha256}
   "grade"        #{:grading-room :sha256 :allure-lifecycle :verdicts :grader-shards :audit-row :audit-rows}
   "blind-review" #{:blind-packet :blind-response :blind-probe}
   "score"        #{:score-input :scores :verdicts}
   "panel"        #{:panel-plan :panel-vm-run :panel-selection :panel-summary :panel-report :replay-evidence :audit-rows}
   "done"         #{}})

(defn labels
  [q]
  (get labeling q #{}))

;;; --- Invariants on the cycle -----------------------------------------------

(defn I-path-covers-core
  "Q consists of distinct canonical phases with no duplicates."
  []
  (and (= Q (vec life/PHASES))
       (= (count Q) (count (set Q)))))

(defn I-linear-total
  "succ is defined exactly on Q ∖ F and lands in Q."
  []
  (and (every? (fn [q]
                 (if (contains? F q)
                   (nil? (succ q))
                   (contains? (set Q) (succ q))))
               Q)
       (= (count successors) (- (count Q) (count F)))))

(defn I-unique-path
  "There is exactly one path of length |Q| from q₀ ending in F."
  []
  (and (= q0 (first Q))
       (contains? F (last Q))
       (= Q (path))))

(defn I-blind-when-loyly
  "Blind review precedes score, and panel follows score so panel never alters filed verdicts."
  []
  (let [i-blind (.indexOf Q "blind-review")
        i-score (.indexOf Q "score")
        i-panel (.indexOf Q "panel")]
    (and (>= i-blind 0) (>= i-score 0) (>= i-panel 0)
         (< i-blind i-score)
         (< i-score i-panel))))

(defn I-labels-subset-registry
  "Every model mentioned in L(q) is a registered sort."
  []
  (every? (fn [m] (contains? models/Registry m))
          (mapcat labels Q)))

(defn prove-cycle!
  "Discharge cycle invariants; throw on failure."
  []
  (doseq [[id ok]
          [[:C1 (I-path-covers-core)]
           [:C2 (I-linear-total)]
           [:C3 (I-unique-path)]
           [:C4 (I-blind-when-loyly)]
           [:C5 (I-labels-subset-registry)]]]
    (when-not ok
      (throw (ex-info (str "cycle invariant failed: " id) {:id id}))))
  {:ok true
   :invariants [:C1 :C2 :C3 :C4 :C5]
   :q0 q0
   :F (vec F)
   :path Q
   :project loyly/PROJECT_ID})

;;; --- Theory export ---------------------------------------------------------

(defn cycle-theory
  "Closed description of 𝒞 for examination."
  []
  {:schema "loyly.formal-cycle.v1"
   :title "Löyly cycle transition system"
   :notation "𝒞 = (Q, q₀, →, L, F)"
   :Q Q
   :q0 q0
   :F (vec F)
   :transitions (mapv (fn [[a b]] {:from a :to b})
                      (partition 2 1 Q))
   :labeling (into (sorted-map)
                   (map (fn [[k v]] [k (vec (sort v))]) labeling))
   :core-phases life/PHASES
   :equations
   ["Q = PHASES"
    "q₀ = prepare"
    "q → q'  ⇔  succ(q) = q'"
    "F = {done}"
    "L : Q → 𝒫(SortNames)"
    "run = q₀ →* done"]
   :invariants
   [{:id :C1 :statement "Q = distinct PHASES"}
    {:id :C2 :statement "succ total on Q\\F and image ⊆ Q"}
    {:id :C3 :statement "unique path prepare ↦ … ↦ done"}
    {:id :C4 :statement "blind-review ≺ score ≺ panel on path"}
    {:id :C5 :statement "⋃_q L(q) ⊆ Registry"}]
   :proof (prove-cycle!)})

(defn valid-state? [s] (m/validate CycleState s))
