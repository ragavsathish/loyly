(ns loyly.spike.contracts
  "PoC port of harness/pi-durable/contracts.ts re-exports."
  (:require [loyly.spike.evidence.validate-verdicts :as v]))

(def selected-checklist? v/selected-checklist?)
