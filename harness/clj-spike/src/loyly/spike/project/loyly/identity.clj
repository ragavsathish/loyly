(ns loyly.spike.project.loyly.identity
  "PoC port of harness/pi-durable/project/loyly/identity.ts")

(def PROJECT_ID "loyly")
(def BLIND_ITEM_ID "01-011")
(def BOOKING_SLICE "01-booking-core")
(def DEFAULT_PANEL_PLAN "booking-core.panel.json")
(def BLIND_REFUSAL_FILE "work/blind-review-011.txt")
(def BLIND_SPEC_RELATIVE (str "plan/" BOOKING_SLICE "/spec.feature"))

(defn defaults-blind-review [project]
  (= project PROJECT_ID))

(defn blind-allure-full-name
  ([] (blind-allure-full-name "grader"))
  ([kind]
   (let [base (str PROJECT_ID ".booking-core." BLIND_ITEM_ID)]
     (if (= kind "grader") base (str base ".blind-agent-review")))))
