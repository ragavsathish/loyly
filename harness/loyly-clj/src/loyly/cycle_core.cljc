(ns loyly.cycle-core
  "PoC port of harness/cycle-core/lifecycle.ts — pure phase decisions.")

(defn create-lifecycle
  "Return {:after-build :after-gate :after-grade :after-assessment …}."
  [& {:keys [max-build-attempts assessments]
      :or {max-build-attempts 3 assessments []}}]
  (when (or (not (integer? max-build-attempts))
            (< max-build-attempts 1)
            (not (vector? assessments))
            (not= (count assessments) (count (set assessments)))
            (some #(nil? (re-matches #"^[a-z][a-z0-9-]*$" %)) assessments))
    (throw (ex-info "invalid lifecycle policy" {})))
  (let [after-grade-phase (or (first assessments) "score")
        next-assessment
        (fn [stage]
          (let [idx (or (first (keep-indexed (fn [i x] (when (= x stage) i)) assessments))
                        -1)]
            (when (neg? idx)
              (throw (ex-info (str "unknown assessment stage: " stage) {:stage stage})))
            (or (get assessments (inc idx)) "score")))]
    {:max-build-attempts max-build-attempts
     :assessments (vec assessments)
     :after-build
     (fn [attempt outcome]
       (when (or (not (integer? attempt)) (< attempt 1)
                 (> attempt max-build-attempts))
         (throw (ex-info "invalid build attempt" {:attempt attempt})))
       (cond
         (= (get outcome "status") "completed")
         {"phase" "gate" "attempt" attempt}

         (and (get-in outcome ["result" "retryable"])
              (< attempt max-build-attempts))
         (cond-> {"phase" "build"
                  "attempt" (inc attempt)
                  "retry" "builder"}
           (contains? (get outcome "result") "failureLog")
           (assoc "failureLog" (get-in outcome ["result" "failureLog"]))
           (contains? (get outcome "result") "failureSha256")
           (assoc "failureSha256" (get-in outcome ["result" "failureSha256"])))

         :else
         {"terminal" true
          "reason" (if (get-in outcome ["result" "retryable"])
                     "builder-attempts-exhausted"
                     "builder-attempt-failed")
          "exhausted" (boolean (get-in outcome ["result" "retryable"]))
          "attempt" attempt}))

     :after-gate
     (fn [attempt outcome]
       (when (or (not (integer? attempt)) (< attempt 1)
                 (> attempt max-build-attempts))
         (throw (ex-info "invalid gate attempt" {:attempt attempt})))
       (cond
         (or (not= (get outcome "status") "completed")
             (nil? (get outcome "result")))
         {"terminal" true "reason" "gate-effect-failed" "attempt" attempt}

         (get-in outcome ["result" "passed"])
         (cond-> {"phase" "grading-room" "attempt" attempt}
           (contains? (get outcome "result") "candidateSha256")
           (assoc "candidateSha256" (get-in outcome ["result" "candidateSha256"])))

         (< attempt max-build-attempts)
         (cond-> {"phase" "build"
                  "attempt" (inc attempt)
                  "retry" "gate"}
           (contains? (get outcome "result") "log")
           (assoc "failureLog" (get-in outcome ["result" "log"]))
           (contains? (get outcome "result") "logSha256")
           (assoc "failureSha256" (get-in outcome ["result" "logSha256"])))

         :else
         {"terminal" true
          "reason" "gate-attempts-exhausted"
          "exhausted" true
          "attempt" attempt}))

     :after-grade
     (fn [outcome]
       (if (= (get outcome "status") "completed")
         {"phase" after-grade-phase}
         {"terminal" true "reason" "grader-effect-or-verdict"}))

     :after-assessment
     (fn [stage passed?]
       (next-assessment stage)
       (if passed?
         {"phase" (next-assessment stage)}
         {"terminal" true "reason" (str stage "-effect")}))}))

(defn decide-attempt
  "Codex/Cursor decide: afterBuild (+ afterGate when build reached gate)."
  [attempt build gate]
  (let [life (create-lifecycle :max-build-attempts 3)
        after-build ((:after-build life) attempt build)]
    (if (or (contains? after-build "terminal")
            (not= (get after-build "phase") "gate"))
      {"afterBuild" after-build}
      {"afterBuild" after-build
       "afterGate" ((:after-gate life) attempt gate)})))
