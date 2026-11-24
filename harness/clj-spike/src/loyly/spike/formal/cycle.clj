(ns loyly.spike.formal.cycle
  "Mathematical model of the Löyly Pi cycle as a labeled transition system.

  Cycle 𝒞 = (Q, q₀, →, L, F)

  - Q  — phases (states)
  - q₀ — initial phase (cut)
  - →  — successor relation (linear spine + after-* sync points)
  - L  — labeling: phase ↦ required models / digests produced
  - F  — accepting states {done}

  Concrete handlers live in tasks.cycle-phases; this ns is the closed math."
  (:require [clojure.test.check.generators :as gen]
            [loyly.spike.formal.models :as models]
            [loyly.spike.project.loyly :as loyly]
            [loyly.spike.tasks.cycle-phases :as phases]
            [malli.core :as m]
            [malli.error :as me]
            [malli.generator :as mg]))

;;; --- Sorts -----------------------------------------------------------------

(def PhaseName
  (into [:enum] phases/ALL-PHASES))

(def CorePhaseName
  "Coarse spine used by PHASES (demo / scoreboard)."
  (into [:enum] phases/PHASES))

(def PhaseResult
  [:map
   ["phase" PhaseName]
   ["code" [:int {:min 0}]]
   ["sha256" models/Sha256]])

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
  "State set = ALL-PHASES."
  (vec phases/ALL-PHASES))

(def q0
  "Initial state."
  "cut")

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
  "The unique maximal path from q₀: cut · … · done."
  []
  Q)

(defn reachable?
  [q]
  (boolean (some #{q} Q)))

;;; --- Labeling: phase ↦ models / obligations --------------------------------

(def labeling
  "L(q) = models that must be Valid at/after phase q (traceability to 𝒜 sorts)."
  {"cut"           #{:commit}
   "preflight"     #{:live-run}
   "fence"         #{:commit}
   "checklist"     #{:checklist :item-id}
   "render"        #{}
   "build"         #{:sha256}
   "after-build"   #{:sha256}
   "gate"          #{:gate-receipt :sha256}
   "after-gate"    #{:gate-receipt}
   "grading-room"  #{:grading-room :sha256}
   "grade"         #{:allure-lifecycle :verdicts}
   "after-grade"   #{:allure-lifecycle}
   "blind-review"  #{:blind-packet :blind-response :blind-probe}
   "panel"         #{:panel-plan :panel-vm-run}
   "after-panel"   #{:panel-summary :panel-vm-run}
   "score"         #{:score-input :scores :verdicts}
   "panel-report"  #{:panel-report :panel-summary :replay-evidence}
   "done"          #{}})

(defn labels
  [q]
  (get labeling q #{}))

;;; --- Invariants on the cycle -----------------------------------------------

(defn I-path-covers-core
  "Every core PHASES element appears on the ALL-PHASES path."
  []
  (every? (set Q) phases/PHASES))

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
  "If project is loyly booking-core, blind-review is on the path
   (handoff phase exists before score)."
  []
  (let [i-blind (.indexOf Q "blind-review")
        i-score (.indexOf Q "score")]
    (and (>= i-blind 0) (>= i-score 0) (< i-blind i-score))))

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
   :core-phases phases/PHASES
   :equations
   ["Q = ALL-PHASES"
    "q₀ = cut"
    "q → q'  ⇔  succ(q) = q'"
    "F = {done}"
    "L : Q → 𝒫(SortNames)"
    "run = q₀ →* done"]
   :invariants
   [{:id :C1 :statement "PHASES ⊆ Q"}
    {:id :C2 :statement "succ total on Q\\F and image ⊆ Q"}
    {:id :C3 :statement "unique path cut ↦ … ↦ done"}
    {:id :C4 :statement "blind-review ≺ score on path"}
    {:id :C5 :statement "⋃_q L(q) ⊆ Registry"}]
   :proof (prove-cycle!)})

(defn valid-phase? [p] (m/validate PhaseName p))
(defn valid-state? [s] (m/validate CycleState s))
(defn explain-state [s] (some-> (m/explain CycleState s) me/humanize))

(defn generate-state [& {:keys [seed size] :or {size 8}}]
  (if seed
    (mg/generate CycleState {:seed seed :size size})
    (mg/generate CycleState {:size size})))
