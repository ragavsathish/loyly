(ns loyly.spike.project.loyly
  "Barrel matching harness/pi-durable/project/loyly/index.ts"
  (:require [loyly.spike.project.loyly.blind-answer :as answer]
            [loyly.spike.project.loyly.blind-policy :as policy]
            [loyly.spike.project.loyly.blind-probe :as probe]
            [loyly.spike.project.loyly.identity :as id]
            [loyly.spike.project.loyly.schemas :as schemas]))

(def PROJECT_ID id/PROJECT_ID)
(def BLIND_ITEM_ID id/BLIND_ITEM_ID)
(def BOOKING_SLICE id/BOOKING_SLICE)
(def DEFAULT_PANEL_PLAN id/DEFAULT_PANEL_PLAN)
(def BLIND_REFUSAL_FILE id/BLIND_REFUSAL_FILE)
(def BLIND_SPEC_RELATIVE id/BLIND_SPEC_RELATIVE)
(def defaults-blind-review id/defaults-blind-review)
(def blind-allure-full-name id/blind-allure-full-name)

(def BLIND_QUESTION policy/BLIND_QUESTION)
(def PENDING_HUMAN policy/PENDING_HUMAN)
(def PENDING_SUBAGENT policy/PENDING_SUBAGENT)
(def PERSON_SPEC_SHA256 policy/PERSON_SPEC_SHA256)
(def requires-blind-handoff policy/requires-blind-handoff)
(def pending-evidence-prefix policy/pending-evidence-prefix)
(def historical-person-cut? policy/historical-person-cut?)
(def blind-pending-result? policy/blind-pending-result?)
(def assert-blind-verdict-handoff policy/assert-blind-verdict-handoff)

(def parse-blind-agent-answer answer/parse-blind-agent-answer)
(def booking-form-action probe/booking-form-action)
(def resolve-room-in-public-form probe/resolve-room-in-public-form)
(def match-public-json-booking probe/match-public-json-booking)
(def public-json-booking probe/public-json-booking)

(def GRADING_ROOM schemas/GRADING_ROOM)
(def BLIND_PACKET schemas/BLIND_PACKET)
(def BLIND_RESPONSE schemas/BLIND_RESPONSE)
(def BLIND_PROBE schemas/BLIND_PROBE)
(def LEGACY_PANEL_PLAN schemas/LEGACY_PANEL_PLAN)
(def PANEL_VM_RUN schemas/PANEL_VM_RUN)
(def PANEL_SUMMARY schemas/PANEL_SUMMARY)
(def PANEL_REPORT schemas/PANEL_REPORT)
