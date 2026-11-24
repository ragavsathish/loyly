(ns loyly.spike.tasks.cycle-phases
  "PoC map of cycle phase names from harness/pi-durable/tasks/cycle-phases.ts.
  Full Pi defineTask / Effect orchestration stays on the TS side; this module
  wires the portable helpers a CLJ driver would call per phase."
  (:require [babashka.fs :as fs]
            [loyly.spike.cycle-effects :as effects]
            [loyly.spike.gen-checklist :as checklist]
            [loyly.spike.hjson :as hjson]
            [loyly.spike.score :as score]
            [loyly.spike.score-receipt :as receipt]
            [loyly.spike.scoreboard :as board]))

(def PHASES
  ["cut" "preflight" "build" "gate" "grade" "blind-review" "score" "panel" "done"])

(def ALL-PHASES
  ["cut" "preflight" "fence" "checklist" "render" "build" "after-build"
   "gate" "after-gate" "grading-room" "grade" "after-grade" "blind-review"
   "panel" "after-panel" "score" "panel-report" "done"])

(defn- stub-phase [name]
  (fn [_deps]
    {:code 0 :phase name :sha256 (effects/hash-value (str "stub:" name))}))

(def phase-preflight (stub-phase "preflight"))
(def phase-fence (stub-phase "fence"))
(def phase-checklist (stub-phase "checklist"))
(def phase-render (stub-phase "render"))
(def phase-build (stub-phase "build"))
(def phase-after-build (stub-phase "after-build"))
(def phase-gate (stub-phase "gate"))
(def phase-after-gate (stub-phase "after-gate"))
(def phase-grading-room (stub-phase "grading-room"))
(def phase-grade (stub-phase "grade"))
(def phase-after-grade (stub-phase "after-grade"))
(def phase-blind-review (stub-phase "blind-review"))
(def phase-panel (stub-phase "panel"))
(def phase-after-panel (stub-phase "after-panel"))
(def phase-panel-report (stub-phase "panel-report"))
(def phase-done (stub-phase "done"))

(declare phase-cut phase-score)

(defn create-cycle-phases
  "Map of portable phase handlers (Pi defineTask bodies stay on TS)."
  [_deps]
  {:cut phase-cut
   :preflight phase-preflight
   :fence phase-fence
   :checklist phase-checklist
   :render phase-render
   :build phase-build
   :after-build phase-after-build
   :gate phase-gate
   :after-gate phase-after-gate
   :grading-room phase-grading-room
   :grade phase-grade
   :after-grade phase-after-grade
   :blind-review phase-blind-review
   :panel phase-panel
   :after-panel phase-after-panel
   :score phase-score
   :panel-report phase-panel-report
   :done phase-done})

(defn phase-cut
  "Pin an approved source cut when `:approved-commit` is set."
  [{:keys [fx approved-commit approved-source-repo source-root cut]}]
  (cond
    (nil? approved-commit)
    {:code 0 :sha256 (effects/hash-value "original source: no cut requested")}

    ((:prove-cut fx))
    {:code 0 :sha256 (effects/hash-value "cut already proven")}

    :else
    (let [root (or (:root fx) ".")
          r1 ((:command fx) "cut-clone" "git"
              ["clone" "-q" "--no-local" "--no-checkout"
               approved-source-repo (str source-root)]
              :cwd root)
          r2 (when (zero? (:code r1))
               ((:command fx) "cut-checkout" "git"
                ["checkout" "-q" "--detach" approved-commit]
                :cwd (str source-root)))
          ok (and r2 (zero? (:code r2))
                  (= (effects/git-at source-root "rev-parse" "HEAD") approved-commit)
                  (= (effects/git-at source-root "status" "--porcelain") ""))]
      (when ok
        (fs/create-dirs cut)
        (hjson/spit-utf8 (fs/file cut "cut.json")
                         (str (hjson/compact-json
                               (array-map "commit" approved-commit
                                          "project" (str source-root)
                                          "source_repo" approved-source-repo))
                              "\n")))
      (if (and ok ((:prove-cut fx)))
        r2
        (assoc (or r2 r1) :code 1)))))

(defn phase-score
  "Derive checklist, file scores, bind/verify receipt, write board."
  [{:keys [fx scratch instrument source-root verdicts-file score-cycle candidate-sha256]
    :or {score-cycle "02"}}]
  (let [checklist-out (fs/file scratch "checklist.json")
        measure ((:measure-log fx) "gen-checklist"
                 (fn []
                   (checklist/generate {:root (str source-root)
                                        :out (str checklist-out)})
                   {:stdout "checklist ok\n"}))]
    (when-not (zero? (:code measure))
      (throw (ex-info "checklist derivation failed in phase-score" measure)))
    (let [cycle-dir (fs/path instrument "harness" "cycles" score-cycle)]
      (fs/create-dirs cycle-dir)
      (fs/copy checklist-out (fs/path cycle-dir "checklist.json") {:replace-existing true})
      (let [scored (score/score-cycle {:root (str instrument)
                                       :cycle score-cycle
                                       :verdicts-path (str verdicts-file)})
            _ (receipt/bind-score-input
               {:scratch (str scratch)
                :source-root (str source-root)
                :instrument (str instrument)
                :candidate-sha256 candidate-sha256
                :verdicts-file (str verdicts-file)
                :score-cycle score-cycle})
            verified (receipt/verify-scored-cycle
                      {:scratch (str scratch)
                       :instrument (str instrument)
                       :verdicts-file (str verdicts-file)
                       :cycle score-cycle})
            board (board/report {:root (str instrument) :cycle score-cycle})]
        {:scored scored :verified verified :board board}))))
