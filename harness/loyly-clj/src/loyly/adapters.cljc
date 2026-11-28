(ns loyly.adapters
  "CLJ Codex/Cursor adapter actions — uses spike modules, not Node."
  (:require [loyly.candidate-caches :as caches]
            [loyly.cycle-core :as life]
            [loyly.evidence.assess-room-panel :as panel]
            [loyly.evidence.check-room :as room]
            [loyly.hjson :as hjson]
            [loyly.platform :as plat]
            [loyly.project.loyly :as loyly]))

(def CURSOR-SEALS
  {"graderTool" "Cursor black-box grader"
   "blindTool" "fresh blind subagent"
   "handoffItem" loyly/BLIND_ITEM_ID
   "project" loyly/PROJECT_ID})

(def CODEX-SEALS
  {"graderTool" "Codex black-box grader"
   "blindTool" "fresh blind subagent"
   "handoffItem" loyly/BLIND_ITEM_ID
   "project" loyly/PROJECT_ID})

(defn- seals-for [driver]
  (case driver
    :cursor CURSOR-SEALS
    :codex CODEX-SEALS
    (throw (ex-info (str "unknown adapter driver: " driver) {:driver driver}))))

(defn- read-json [path]
  (hjson/read-json (plat/read-text path)))

(defn decide
  [input-path]
  (let [input (read-json input-path)]
    (life/decide-attempt
     (get input "attempt")
     (get input "build")
     (get input "gate"))))

(defn candidate
  [input-path]
  (let [input (read-json input-path)]
    (caches/check-candidate-caches
     (get input "room")
     :mode (or (get input "mode") "sealed"))))

(defn evidence
  [driver input-path]
  (let [files (read-json input-path)
        report (room/check-room-evidence files (seals-for driver))
        life (life/create-lifecycle
              :assessments (get report "assessments"))]
    (assoc report "nextPhase" ((:after-grade life) {"status" "completed"}))))

(defn panel
  [input-path]
  (let [files (read-json input-path)
        assessed (panel/assess-room-panel files)
        life (life/create-lifecycle :assessments ["panel"])]
    (assoc assessed
           "nextPhase"
           ((:after-assessment life)
            "panel"
            (= "ready-for-review" (get assessed "panel_outcome"))))))

(defn dispatch
  "Run one adapter action; return report map (caller prints JSON)."
  [driver action input-path]
  (case action
    "decide" (decide input-path)
    "candidate" (candidate input-path)
    "evidence" (evidence driver input-path)
    "panel" (panel input-path)
    (throw (ex-info (str "CLJ adapter does not implement: " action
                         " (preflight still needs the TS contract checker;"
                         " pass --ts to spawn Node)")
                    {:action action}))))
