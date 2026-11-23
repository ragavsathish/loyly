(ns loyly.spike.panel-selection
  "PoC port of harness/pi-durable/panel-selection.ts (coverage; Ajv deferred)."
  (:require [loyly.spike.evidence.panel-selection :as core]
            [loyly.spike.project.loyly.identity :as id]
            [loyly.spike.project.loyly.schemas :as schemas]))

(defn- structural-plan? [plan]
  (and (map? plan)
       (string? (get plan "schema"))
       (vector? (get plan "checks"))
       (every? (fn [check]
                 (and (map? check)
                      (string? (get check "id"))
                      (string? (get check "source"))
                      (string? (get check "role"))
                      (vector? (get check "items"))))
               (get plan "checks"))))

(defn validate-panel-selection
  "Validate panel coverage for a checklist. Skips Ajv; structural checks only."
  [plan checklist]
  (when-not (structural-plan? plan)
    (throw (ex-info "panel plan schema: structural validation failed" {})))
  (let [legacy? (= (get plan "schema") schemas/LEGACY_PANEL_PLAN)
        coverage (core/validate-panel-coverage
                  plan checklist
                  :handoff-item (when legacy? id/BLIND_ITEM_ID))
        specialists (->> (get plan "checks")
                         (filter #(= "specialist" (get % "source")))
                         (mapv #(get % "id")))]
    {:selected (:selected coverage)
     :specialists specialists}))
