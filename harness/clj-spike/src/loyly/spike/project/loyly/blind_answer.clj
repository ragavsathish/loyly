(ns loyly.spike.project.loyly.blind-answer
  "PoC port of harness/pi-durable/project/loyly/blind-answer.ts"
  (:require [clojure.string :as str]))

(def ^:private DAYS "Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday")
(def ^:private REQUEST
  (re-pattern
   (str "(?i)^REQUEST:\\s*pukuhuone\\s+(\\d+)\\s*\\|\\s*(" DAYS ")\\s*\\|\\s*(\\d{2}:\\d{2})$")))

(defn- escape-re [value]
  (str/replace value #"([.*+?^${}()|\[\]\\])" "\\\\$1"))

(defn- valid-time? [value]
  (and (<= (Long/parseLong (subs value 0 2)) 23)
       (<= (Long/parseLong (subs value 3)) 59)))

(defn parse-blind-agent-answer
  "Parse the one-line REQUEST / UNUSABLE answer from a Löyly blind agent."
  [answer refusal]
  (let [line (str/trim answer)
        unusable (re-find #"(?i)^UNUSABLE:\s*(.{3,500})$" line)]
    (if unusable
      {:verdict "fail" :reason (second unusable) :request nil}
      (let [match (re-find REQUEST line)]
        (when-not match
          (throw (ex-info "blind agent answer did not use REQUEST or UNUSABLE format" {})))
        (let [[_ number weekday-raw start] match
              weekday (str (str/upper-case (subs weekday-raw 0 1))
                           (str/lower-case (subs weekday-raw 1)))]
          (when (or (not (valid-time? start))
                    (not (re-find (re-pattern (str "(?i)pukuhuone\\s*" (escape-re number) "\\b"))
                                  refusal))
                    (not (re-find (re-pattern (str "(?i)\\b" (escape-re weekday) "\\b")) refusal))
                    (not (str/includes? refusal start)))
            (throw (ex-info "blind agent named a room, day or start time absent from the refusal" {})))
          {:verdict "pass"
           :reason "The fresh agent named a request from the refusal; HTTP confirmation follows."
           :request {:method "POST"
                     :path "@booking-form"
                     :body (str "household=12"
                                "&resource=" (java.net.URLEncoder/encode (str "@room:" number) "UTF-8")
                                "&weekday=" (java.net.URLEncoder/encode weekday "UTF-8")
                                "&start=" (java.net.URLEncoder/encode start "UTF-8"))
                     :matches_answer true}})))))
