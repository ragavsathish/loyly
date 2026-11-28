(ns loyly.cycle-core
  "Core cycle lifecycle policy and canonical phase list (.cljc).

   7 active phases + terminal done:
     prepare -> build -> gate -> grade -> blind-review -> score -> panel -> done")

(def PHASES
  ["prepare" "build" "gate" "grade" "blind-review" "score" "panel" "done"])

(defn create-lifecycle
  "Return transition functions for the simplified cycle API:
   {:max-build-attempts :blind-review? :panel?
    :after-build :after-gate :after-grade :after-blind-review :after-score :after-panel}."
  [& {:keys [max-build-attempts blind-review? panel?]
      :or {max-build-attempts 3 blind-review? false panel? false}}]
  (when (or (not (integer? max-build-attempts))
            (< max-build-attempts 1))
    (throw (ex-info "invalid lifecycle policy" {})))
  (let [blind? (boolean blind-review?)
        panel-enabled? (boolean panel?)]
    {:max-build-attempts max-build-attempts
     :blind-review? blind?
     :panel? panel-enabled?
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
         (cond-> {"phase" "grade" "attempt" attempt}
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
         {"phase" (if blind? "blind-review" "score")}
         {"terminal" true "reason" "grader-effect-or-verdict"}))

     :after-blind-review
     (fn [passed?]
       (if passed?
         {"phase" "score"}
         {"terminal" true "reason" "blind-review-effect"}))

     :after-score
     (fn [passed?]
       (if passed?
         {"phase" (if panel-enabled? "panel" "done")}
         {"terminal" true "reason" "score-effect"}))

     :after-panel
     (fn [passed?]
       (if passed?
         {"phase" "done"}
         {"terminal" true "reason" "panel-effect"}))}))

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
