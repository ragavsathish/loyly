(ns loyly.node.pi-worker
  "ClojureScript Node durable Pi cycle worker (.cljs).

  Replaces harness/pi-durable/worker.mjs and harness/pi-durable/tasks/*.ts.
  Executes all cycle domain logic through shared .cljc core modules and
  delegates ONLY the @earendil-works/pi-durable SDK boundary (Harness,
  defineTask, defineEntry, defineExtension, SQLite store) to the minimal
  harness/pi-durable/pi-extension.ts shim."
  (:require [clojure.string :as str]
            [loyly.blind-agent :as blind-agent]
            [loyly.blind-review :as blind]
            [loyly.builder-adapter :as builder-ad]
            [loyly.continuation :as cont]
            [loyly.cycle-core :as life]
            [loyly.cycle-effects :as fx]
            [loyly.digest :as d]
            [loyly.gate-adapter :as gate-ad]
            [loyly.gen-checklist :as checklist]
            [loyly.grader-shards :as shards]
            [loyly.grading-room :as room]
            [loyly.hjson :as hjson]
            [loyly.node.runtime :as rt]
            [loyly.panel-adapter :as panel-ad]
            [loyly.platform :as plat]
            [loyly.project.loyly :as loyly]
            [loyly.score :as score]
            [loyly.score-receipt :as receipt]
            [loyly.scoreboard :as board]
            [loyly.worker-config :as wcfg]
            [promesa.core :as p]))

(defn- terminal-fail [stage]
  #js {:status "terminal"
       :outcome #js {:status "failed" :error stage}})

(defn- legacy-failure [error extra]
  (clj->js (merge {:status "failed" :error error} extra)))

(defn- commit-with-audit! [runtime audit task stage outcome extra next-state ctx]
  (.commit runtime
           (fn [tx]
             (p/let [_ (audit tx task stage outcome (clj->js (or extra {})))]
               (clj->js next-state)))
           ctx))

(defn- builder-receipt-path [scratch attempt]
  (plat/path scratch (str "builder-" attempt "-evidence") "session.json"))

(defn- builder-lineage [scratch attempt]
  (let [p (builder-receipt-path scratch attempt)]
    (if-not (plat/exists? p)
      {}
      (try
        (let [raw (plat/read-bytes p)
              rcpt (hjson/read-json (plat/bytes->utf8 raw))]
          {:conversation_id (get rcpt "conversationId")
           :parent_conversation_id (get rcpt "parentConversationId")
           :fork_entry_id (get rcpt "forkEntryId")
           :session_receipt_sha256 (d/file-sha256 p)})
        (catch :default _ {})))))

(defn- can-fork-builder-attempt? [scratch builder-store attempt]
  (let [p (builder-receipt-path scratch attempt)]
    (if-not (plat/exists? p)
      false
      (let [rcpt (hjson/read-json (plat/read-text p))
            cid (get rcpt "conversationId")
            lid (get rcpt "lastEntryId")]
        (and (= (get rcpt "store") builder-store)
             (integer? cid) (pos? cid)
             (integer? lid) (pos? lid))))))

(defn- run-builder-async! [req]
  (let [spawn-sync-hook (fn [cmd opts]
                          (plat/exec-sync cmd {:dir (:dir opts) :env (:env opts)}))]
    (p/resolved (builder-ad/run-builder (assoc req :spawn-fn spawn-sync-hook)))))

(defn- build-builder-task [{:keys [cfg scratch room-dir pi-dir repo run-id builder-store effects audit]}]
  (let [{:keys [live builder mode]} cfg
        candidate-digest (:candidate-digest effects)
        verify-scope (:verify-builder-scope effects)
        clear-artifacts (:clear-builder-test-artifacts effects)]
    #js {:name "loyly.proto.builder"
         :initial (fn [] #js {:phase "announce"})
         :phases
         #js {"announce"
              (fn [task runtime ctx]
                (let [input (js->clj (.-input task) :keywordize-keys true)
                      attempt (:attempt input)]
                  (commit-with-audit!
                   runtime audit task
                   (if (= 1 attempt) "build" "repair") "started"
                   {:attempt attempt
                    :session_id (str "builder-" attempt)
                    :fixture (or (not live) (str/starts-with? (str (:model builder)) "test/"))
                    :model (:model builder)
                    :previous_failure_kind (:previousFailureKind input)
                    :previous_failure_log_sha256 (:previousFailureSha256 input)}
                   (if live
                     {:status "running" :checkpoint {:phase "materialize"}}
                     {:status "sleeping" :until (+ (plat/now-ms) 1200)
                      :checkpoint {:phase "materialize"}})
                   ctx)))

              "materialize"
              (fn [task runtime ctx]
                (let [input (js->clj (.-input task) :keywordize-keys true)
                      attempt (:attempt input)]
                  (if-not live
                    (let [target (plat/path room-dir "impl")
                          red? (or (= mode "three-red") (= 1 attempt))]
                      (plat/delete-tree target)
                      (plat/create-dirs (plat/parent target))
                      (plat/copy-tree (plat/path pi-dir "fixture" "legacy-app") target)
                      (when red?
                        (plat/write-text (plat/path target "test.sh")
                                         "#!/bin/sh\necho 'fixture red suite'\nexit 1\n")
                        (plat/set-executable! (plat/path target "test.sh")))
                      (.commit runtime
                               (fn [tx]
                                 (p/let [_ (audit tx task "builder-continuation" "completed"
                                                  (clj->js {:attempt attempt
                                                            :session_id (str "builder-" attempt)
                                                            :remaining_uncarried 0
                                                            :fixture true}))
                                         _ (audit tx task (if (= 1 attempt) "build" "repair") "completed"
                                                  (clj->js {:attempt attempt
                                                            :candidate_digest (d/file-sha256 (plat/path target "test.sh"))
                                                            :fixture true}))]
                                   #js {:status "terminal"
                                        :outcome #js {:status "completed" :result #js {:red red?}}}))
                               ctx))
                    (let [session-id (str run-id "-attempt-" attempt)
                          err-log (plat/path scratch (str "builder-" attempt "-error.log"))]
                      (p/let [outcome
                              (-> (p/let [base-instr (plat/path scratch "prompt.txt")
                                          _ (when (or (not= (d/file-sha256 base-instr) (:instruction-sha256 builder))
                                                      (not= (d/file-sha256 (:command builder)) (:command-sha256 builder))
                                                      (not= (d/file-sha256 (plat/path (:image builder) "manifest.json"))
                                                            (:image-sha256 builder)))
                                              (throw (ex-info "builder inputs changed after render" {})))
                                          instr (if (> attempt 1)
                                                  (let [log (:previousFailureLog input)
                                                        kind (:previousFailureKind input)]
                                                    (when (or (not (str/starts-with? (str log) (str scratch "/")))
                                                              (not (plat/exists? log))
                                                              (not= (d/file-sha256 log) (:previousFailureSha256 input))
                                                              (not (#{"gate" "builder"} kind)))
                                                      (throw (ex-info "repair evidence differs from committed receipt" {})))
                                                    (let [rp (plat/path scratch (str "repair-" attempt ".md"))]
                                                      (plat/write-text
                                                       rp
                                                       (str (plat/read-text base-instr)
                                                            "\n\n# Previous " kind " failure\n\n"
                                                            "Continue the existing impl/ from the prior attempt. Repair the failure below, then run the suite and HTTP probe.\n\n"
                                                            (plat/read-text log) "\n"))
                                                      rp))
                                                  base-instr)]
                                      (p/let [r (run-builder-async!
                                                 {:command (:command builder)
                                                  :room room-dir
                                                  :instruction instr
                                                  :image (:image builder)
                                                  :evidence-dir (plat/path scratch (str "builder-" attempt "-evidence"))
                                                  :session-id session-id
                                                  :model (:model builder)
                                                  :state-root (plat/path repo ".pi" "harness" ".state")
                                                  :store-path builder-store
                                                  :parent-conversation-receipt
                                                  (when (> attempt 1) (builder-receipt-path scratch (dec attempt)))})]
                                        (when-not (zero? (:exit r))
                                          (verify-scope false)
                                          (throw (ex-info (str "builder host exited " (:exit r))
                                                          {:retryable (can-fork-builder-attempt? scratch builder-store attempt)
                                                           :reconciled (:reconciled r)
                                                           :instruction instr})))
                                        (verify-scope false)
                                        (when (or (not (plat/exists? (plat/path room-dir "impl" "start.sh")))
                                                  (not (plat/exists? (plat/path room-dir "impl" "test.sh"))))
                                          (throw (ex-info "builder did not leave both legacy app entrypoints"
                                                          {:retryable (can-fork-builder-attempt? scratch builder-store attempt)
                                                           :reconciled (:reconciled r)
                                                           :instruction instr})))
                                        (clear-artifacts)
                                        {:digest (candidate-digest)
                                         :reconciled (:reconciled r)
                                         :instruction instr}))
                                  (p/catch (fn [e]
                                             (let [reason (str (or (.-stack e) (ex-message e) e))
                                                   data (ex-data e)]
                                               (plat/write-text err-log (str reason "\n"))
                                               {:reason reason
                                                :retryable (boolean (:retryable data))
                                                :reconciled (boolean (:reconciled data))
                                                :instruction (or (:instruction data)
                                                                 (plat/path scratch "prompt.txt"))}))))]
                        (let [{:keys [digest reason retryable reconciled instruction]} outcome]
                          (commit-with-audit!
                           runtime audit task
                           (if (= 1 attempt) "build" "repair")
                           (if digest "completed" "failed")
                           (merge {:attempt attempt
                                   :session_id session-id
                                   :candidate_digest digest
                                   :instruction_sha256 (when (and instruction (plat/exists? instruction))
                                                         (d/file-sha256 instruction))
                                   :reconciled (boolean reconciled)
                                   :reason_code (when reason "builder-effect-or-scope")
                                   :failure_log (when reason err-log)
                                   :failure_log_sha256 (when reason (d/file-sha256 err-log))
                                   :retryable (boolean retryable)
                                   :fixture (str/starts-with? (str (:model builder)) "test/")}
                                  (builder-lineage scratch attempt))
                           (if digest
                             {:status "running"
                              :checkpoint {:phase "maybe-continue" :continuation 0 :candidateDigest digest}}
                             {:status "terminal"
                              :outcome (legacy-failure "build"
                                                       {:retryable (boolean retryable)
                                                        :failureLog err-log
                                                        :failureSha256 (d/file-sha256 err-log)})})
                           ctx)))))))

              "maybe-continue"
              (fn [task runtime ctx]
                (let [cp (js->clj (.. task -state -checkpoint) :keywordize-keys true)
                      input (js->clj (.-input task) :keywordize-keys true)
                      attempt (:attempt input)
                      continuation (:continuation cp)
                      before (:candidateDigest cp)]
                  (verify-scope true)
                  (when-not (= (candidate-digest) before)
                    (throw (ex-info "candidate changed between builder turns" {})))
                  (let [ids (cont/selected-uncarried room-dir (plat/path scratch "checklist.json"))]
                    (if (or (empty? ids) (>= continuation cont/MAX_CONTINUATIONS))
                      (commit-with-audit!
                       runtime audit task "builder-continuation" "stopped"
                       {:attempt attempt
                        :session_id (str run-id "-attempt-" attempt)
                        :continuations continuation
                        :remaining_uncarried ids
                        :reason (if (seq ids) "limit" "all-carried")
                        :fixture (str/starts-with? (str (:model builder)) "test/")}
                       {:status "terminal"
                        :outcome {:status "completed"
                                  :result {:candidateDigest before
                                           :continuations continuation
                                           :remainingUncarried ids}}}
                       ctx)
                      (let [next-c (inc continuation)]
                        (commit-with-audit!
                         runtime audit task "builder-continuation" "scheduled"
                         {:attempt attempt
                          :continuation next-c
                          :continued_ids ids
                          :candidate_before before
                          :fixture (str/starts-with? (str (:model builder)) "test/")}
                         {:status "running"
                          :checkpoint {:phase "continue" :continuation next-c
                                       :candidateDigest before :ids ids}}
                         ctx))))))

              "continue"
              (fn [task runtime ctx]
                (let [cp (js->clj (.. task -state -checkpoint) :keywordize-keys true)
                      input (js->clj (.-input task) :keywordize-keys true)
                      attempt (:attempt input)
                      continuation (:continuation cp)
                      before (:candidateDigest cp)
                      ids (:ids cp)
                      session-id (str run-id "-attempt-" attempt)
                      request-id (str session-id "-c" continuation)
                      instr (plat/path scratch (str "continuation-" attempt "-" continuation ".md"))
                      ev-dir (plat/path scratch (str "builder-" attempt "-evidence"))
                      err-log (plat/path scratch (str "continuation-" attempt "-" continuation "-error.log"))]
                  (p/let [outcome
                          (-> (p/do
                                (verify-scope true)
                                (when (and (not (builder-ad/has-builder-launch? ev-dir session-id request-id))
                                           (or (not= (candidate-digest) before)
                                               (not= (cont/selected-uncarried room-dir (plat/path scratch "checklist.json")) ids)))
                                  (throw (ex-info "candidate or uncarried list changed before continuation" {})))
                                (let [prompt (cont/continuation-prompt ids)]
                                  (when-not (plat/exists? instr)
                                    (plat/write-text instr prompt))
                                  (when-not (= (plat/read-text instr) prompt)
                                    (throw (ex-info "continuation instruction changed after scheduling" {}))))
                                (when (or (not= (d/file-sha256 (:command builder)) (:command-sha256 builder))
                                          (not= (d/file-sha256 (plat/path (:image builder) "manifest.json"))
                                                (:image-sha256 builder)))
                                  (throw (ex-info "builder command or image changed before continuation" {})))
                                (p/let [r (run-builder-async!
                                           {:command (:command builder)
                                            :room room-dir
                                            :instruction instr
                                            :image (:image builder)
                                            :evidence-dir ev-dir
                                            :session-id session-id
                                            :request-id request-id
                                            :model (:model builder)
                                            :state-root (plat/path repo ".pi" "harness" ".state")
                                            :prompt "Continue this same builder session now."
                                            :store-path builder-store
                                            :parent-conversation-receipt
                                            (when (> attempt 1) (builder-receipt-path scratch (dec attempt)))})]
                                  (when-not (zero? (:exit r))
                                    (verify-scope false)
                                    (throw (ex-info (str "builder continuation exited " (:exit r))
                                                    {:retryable (can-fork-builder-attempt? scratch builder-store attempt)
                                                     :reconciled (:reconciled r)})))
                                  (verify-scope false)
                                  (when (or (not (plat/exists? (plat/path room-dir "impl" "start.sh")))
                                            (not (plat/exists? (plat/path room-dir "impl" "test.sh"))))
                                    (throw (ex-info "builder continuation removed a legacy app entrypoint"
                                                    {:retryable (can-fork-builder-attempt? scratch builder-store attempt)
                                                     :reconciled (:reconciled r)})))
                                  (clear-artifacts)
                                  {:digest (candidate-digest) :reconciled (:reconciled r)}))
                              (p/catch (fn [e]
                                         (let [reason (str (or (.-stack e) (ex-message e) e))
                                               data (ex-data e)]
                                           (plat/write-text err-log (str reason "\n"))
                                           {:reason reason
                                            :retryable (boolean (:retryable data))
                                            :reconciled (boolean (:reconciled data))}))))]
                    (let [{:keys [digest reason retryable reconciled]} outcome
                          remaining (when digest (cont/selected-uncarried room-dir (plat/path scratch "checklist.json")))]
                      (commit-with-audit!
                       runtime audit task "builder-continuation"
                       (if digest "completed" "failed")
                       (merge {:attempt attempt
                               :continuation continuation
                               :session_id session-id
                               :request_id request-id
                               :continued_ids ids
                               :candidate_before before
                               :candidate_after digest
                               :instruction_sha256 (when (plat/exists? instr) (d/file-sha256 instr))
                               :reconciled (boolean reconciled)
                               :changed (when digest (not= digest before))
                               :remaining_uncarried remaining
                               :reason_code (when reason "builder-continuation-effect-or-scope")
                               :failure_log (when reason err-log)
                               :failure_log_sha256 (when reason (d/file-sha256 err-log))
                               :retryable (boolean retryable)
                               :fixture (str/starts-with? (str (:model builder)) "test/")}
                              (builder-lineage scratch attempt))
                       (cond
                         (nil? digest)
                         {:status "terminal"
                          :outcome (legacy-failure "continuation"
                                                   {:retryable (boolean retryable)
                                                    :failureLog err-log
                                                    :failureSha256 (d/file-sha256 err-log)})}
                         (= digest before)
                         {:status "terminal"
                          :outcome {:status "completed"
                                    :result {:candidateDigest digest
                                             :continuations continuation
                                             :remainingUncarried remaining}}}
                         :else
                         {:status "running"
                          :checkpoint {:phase "maybe-continue" :continuation continuation
                                       :candidateDigest digest}})
                       ctx)))))}}))

(defn- build-gate-task [{:keys [scratch pi-dir effects audit]}]
  (let [candidate-digest (:candidate-digest effects)
        gate-room-for (:gate-room-for effects)]
    #js {:name "loyly.proto.gate"
         :initial (fn [] #js {:phase "verify"})
         :phases
         #js {"verify"
              (fn [task runtime ctx]
                (let [attempt (.. task -input -attempt)
                      out (plat/path scratch (str "gate-" attempt "-evidence"))
                      digest (candidate-digest)
                      gate-room (gate-room-for attempt digest)
                      spawn-fn (fn [cmd opts]
                                 (plat/exec-sync cmd {:dir (or (:dir opts) pi-dir)
                                                      :env (:env opts)}))
                      r (gate-ad/run-gate {:room gate-room
                                           :out out
                                           :candidate-sha256 digest
                                           :gate-host (plat/path pi-dir "gate-host.sh")
                                           :spawn-fn spawn-fn})]
                  (commit-with-audit!
                   runtime audit task "gate" (if (:passed r) "passed" "failed")
                   {:attempt attempt
                    :gate_log (:log r)
                    :gate_log_sha256 (:log-sha256 r)
                    :exit (:exit r)
                    :candidate_digest digest
                    :reconciled (:reconciled r)}
                   {:status "terminal"
                    :outcome {:status "completed"
                              :result {:passed (:passed r)
                                       :log (:log r)
                                       :logSha256 (:log-sha256 r)
                                       :candidateSha256 digest}}}
                   ctx)))}}))

(defn- build-grade-task [{:keys [cfg scratch room-dir grading-room pi-dir repo run-id schema-file attached-schema-sha256 audit]}]
  (let [{:keys [live grader grader-shard-count project blind-required]} cfg]
    #js {:name "loyly.proto.grade"
         :initial (fn [] #js {:phase "file"})
         :phases
         #js {"file"
              (fn [task runtime ctx]
                (let [cand-sha (.. task -input -candidateSha256)]
                  (if-not live
                    (let [selected (->> (str/split-lines (str/trim (plat/read-text (plat/path grading-room "checklist.txt"))))
                                        (remove str/blank?))
                          verdicts (mapv (fn [id]
                                           (array-map "id" id
                                                      "verdict" (if (= id "01-010") "fail" "pass")
                                                      "evidence" (str "prototype fixture grader observed " id)))
                                         selected)
                          vfile (plat/path scratch "verdicts.json")]
                      (hjson/spit-utf8 vfile (hjson/compact-json verdicts))
                      (commit-with-audit!
                       runtime audit task "grade" "completed"
                       {:fixture true
                        :item_count (count verdicts)
                        :fail_count (count (filter #(= "fail" (get % "verdict")) verdicts))
                        :verdicts_sha256 (d/file-sha256 vfile)}
                       {:status "terminal"
                        :outcome {:status "completed" :result {:count (count verdicts)}}}
                       ctx))
                    (let [instr (plat/path pi-dir (:instruction-file grader))
                          err-log (plat/path scratch "grade-error.log")]
                      (p/let [outcome
                              (-> (p/do
                                    (when-not grader
                                      (throw (ex-info "independent grader not configured" {})))
                                    (when (or (not= (d/file-sha256 instr) (:instruction-sha256 grader))
                                              (not= (d/file-sha256 (:command grader)) (:command-sha256 grader))
                                              (not= (d/file-sha256 (plat/path (:image grader) "manifest.json"))
                                                    (:image-sha256 grader))
                                              (not= (d/file-sha256 (:settings grader)) (:settings-sha256 grader))
                                              (not= attached-schema-sha256 (:schema-sha256 grader)))
                                      (throw (ex-info "grader instruction, command, image, settings or schema differs from approved digest" {})))
                                    (room/verify-grading-room
                                     {:out grading-room
                                      :candidate-sha256 cand-sha
                                      :checklist-sha256 (:approved-checklist-sha256 cfg)
                                      :schema-sha256 (:schema-sha256 grader)
                                      :project project
                                      :blind-review blind-required})
                                    (let [sh (shards/prepare-shards
                                              {:grading-room grading-room
                                               :source-room room-dir
                                               :scratch scratch
                                               :schema-file schema-file
                                               :candidate-sha256 cand-sha
                                               :schema-sha256 (:schema-sha256 grader)
                                               :count grader-shard-count
                                               :project project
                                               :blind-review blind-required})]
                                      (p/let [launches
                                              (p/all
                                               (mapv (fn [shard]
                                                       (-> (run-builder-async!
                                                            {:command (:command grader)
                                                             :room (:out shard)
                                                             :instruction instr
                                                             :image (:image grader)
                                                             :evidence-dir (plat/path scratch "grader-evidence" (:id shard))
                                                             :session-id (str run-id "-grade-" (:id shard))
                                                             :model (:model grader)
                                                             :state-root (plat/path repo ".pi" "harness" ".state")
                                                             :pi-settings (:settings grader)
                                                             :prompt "Grade your selected checklist scope now, as the attached instruction says."
                                                             :room-label (str "the " (:id shard) " grading room")
                                                             :image-additions-path "/workspace/work/image-additions.txt"
                                                             :readonly-inputs true
                                                             :bash-timeout-floor-seconds 300
                                                             :bash-timeout-ceiling-seconds 300})
                                                           (p/then (fn [v] {:ok true :value v :shard shard}))
                                                           (p/catch (fn [e] {:ok false :reason (str e) :shard shard}))))
                                                     sh))]
                                        (let [failures (keep (fn [{:keys [ok value reason shard]}]
                                                               (cond
                                                                 (not ok) (str (:id shard) ": " reason)
                                                                 (not (zero? (:exit value))) (str (:id shard) ": exit " (:exit value))
                                                                 :else nil))
                                                             launches)]
                                          (when (seq failures)
                                            (throw (ex-info (str "grader shards failed: " (str/join "; " failures)) {}))))
                                        (room/verify-grading-room
                                         {:out grading-room
                                          :candidate-sha256 cand-sha
                                          :checklist-sha256 (:approved-checklist-sha256 cfg)
                                          :schema-sha256 (:schema-sha256 grader)
                                          :project project
                                          :blind-review blind-required})
                                        (let [judged (shards/combine-shards
                                                      {:grading-room grading-room
                                                       :shards sh
                                                       :candidate-sha256 cand-sha
                                                       :schema-sha256 (:schema-sha256 grader)})
                                              vfile (plat/path scratch "verdicts.json")
                                              sfile (plat/path scratch "surprises.json")]
                                          (hjson/spit-utf8 vfile (hjson/compact-json (:verdicts judged)))
                                          (plat/copy (plat/path grading-room "work" "surprises.json") sfile)
                                          {:judged judged
                                           :reconciled (boolean (some #(get-in % [:value :reconciled]) launches))
                                           :shard-count (count sh)
                                           :shard-receipts (mapv (fn [shard {:keys [value]}]
                                                                   {:id (:id shard)
                                                                    :items (:items shard)
                                                                    :checklist_sha256 (:checklist-sha256 shard)
                                                                    :reconciled (:reconciled value)})
                                                                 sh launches)}))))
                                  (p/catch (fn [e]
                                             (let [reason (str (or (.-stack e) (ex-message e) e))]
                                               (plat/write-text err-log (str reason "\n"))
                                               {:reason reason}))))]
                        (let [{:keys [judged reason reconciled shard-count shard-receipts]} outcome]
                          (commit-with-audit!
                           runtime audit task "grade" (if judged "completed" "failed")
                           {:model (:model grader)
                            :fixture (str/starts-with? (str (:model grader)) "test/")
                            :item_count (count (:verdicts judged))
                            :pass_count (or (:pass judged) 0)
                            :shard_count (or shard-count 0)
                            :shards (or shard-receipts [])
                            :allure_results_sha256 (:allure-sha256 judged)
                            :schema_sha256 (:schema-sha256 grader)
                            :verdicts_sha256 (when judged (d/file-sha256 (plat/path scratch "verdicts.json")))
                            :surprises_sha256 (when judged (d/file-sha256 (plat/path scratch "surprises.json")))
                            :reconciled (boolean reconciled)
                            :reason_code (when reason "grader-effect-or-verdict")}
                           (if judged
                             {:status "terminal"
                              :outcome {:status "completed"
                                        :result {:count (count (:verdicts judged)) :pass (:pass judged)}}}
                             {:status "terminal"
                              :outcome (legacy-failure "grade" {})})
                           ctx)))))))}}))

(defn- build-panel-task [{:keys [cfg scratch pi-dir gondolin-fn audit]}]
  (let [panel (:panel cfg)]
    #js {:name "loyly.proto.panel"
         :initial (fn [] #js {:phase "run"})
         :phases
         #js {"run"
              (fn [task runtime ctx]
                (let [cand-sha (.. task -input -candidateSha256)
                      err-log (plat/path scratch "panel-error.log")]
                  (p/let [outcome
                          (-> (p/do
                                (when-not panel
                                  (throw (ex-info "grading panel not configured" {})))
                                (let [res (panel-ad/run-durable-panel
                                           {:scratch scratch
                                            :image (:image panel)
                                            :plan-file (plat/path pi-dir (:plan-file panel))
                                            :approved-plan-sha256 (:plan-sha256 panel)
                                            :approved-image-sha256 (:image-sha256 panel)
                                            :pi-durable pi-dir
                                            :gondolin-fn gondolin-fn})]
                                  (when-not (= (get-in res [:manifest "candidate_sha256"]) cand-sha)
                                    (throw (ex-info "panel VM candidate differs from gated candidate" {})))
                                  {:result res}))
                              (p/catch (fn [e]
                                         (let [reason (str (or (.-stack e) (ex-message e) e))]
                                           (plat/write-text err-log (str reason "\n"))
                                           {:reason reason}))))]
                    (let [{:keys [result reason]} outcome]
                      (commit-with-audit!
                       runtime audit task "panel" (if result "completed" "failed")
                       {:candidate_sha256 cand-sha
                        :plan_sha256 (:plan-sha256 panel)
                        :image_sha256 (:image-sha256 panel)
                        :manifest_sha256 (when result (d/file-sha256 (plat/path (:out result) "manifest.json")))
                        :attempt (:attempt result)
                        :workers (mapv (fn [row] {:id (get row "id") :status (get row "status")})
                                       (or (get-in result [:manifest "producers"]) []))
                        :reconciled (boolean (:reconciled result))
                        :reason_code (when reason "panel-vm-effect")}
                       (if result
                         {:status "terminal"
                          :outcome {:status "completed" :result {:attempt (:attempt result)}}}
                         {:status "terminal"
                          :outcome (legacy-failure "panel" {})})
                       ctx)))))}}))

(defn- build-cycle-task
  [{:keys [cfg lifecycle scratch room-dir grading-room instrument pi-dir repo run-id score-cycle
           schema-file attached-schema-sha256 effects audit allure-cli-fn read-audit-rows-fn]}
   {:keys [Builder Gate Grade Panel]}]
  (let [{:keys [approved-commit approved-source-repo approved-checklist-sha256
                cut source-root live builder grader blind-agent blind-required project panel]} cfg
        command (:command effects)
        prove-cut (:prove-cut effects)
        proof-of-fence (:proof-of-fence effects)
        git-at (:git-at effects)
        candidate-digest (:candidate-digest effects)
        measure-log (:measure-log effects)]
    #js {:name "loyly.proto.cycle"
         :initial (fn [] #js {:phase "cut"})
         :phases
         #js {"cut"
              (fn [task runtime ctx]
                (let [r (cond
                          (or (nil? approved-commit) (prove-cut))
                          {:code 0 :sha256 (fx/hash-value "original source: no cut requested")}
                          :else
                          (do
                            (when (plat/exists? cut)
                              (throw (ex-info "incomplete or changed original-source cut" {})))
                            (plat/create-dirs cut)
                            (let [r1 (command "cut-clone" "git"
                                              ["clone" "-q" "--no-local" "--no-checkout"
                                               approved-source-repo source-root]
                                              :cwd repo)
                                  r2 (if (zero? (:code r1))
                                       (command "cut-checkout" "git"
                                                ["checkout" "-q" "--detach" approved-commit]
                                                :cwd source-root)
                                       r1)]
                              (when (and (zero? (:code r2))
                                         (= (git-at source-root "rev-parse" "HEAD") approved-commit)
                                         (= (git-at source-root "status" "--porcelain") ""))
                                (hjson/spit-utf8
                                 (plat/path cut "cut.json")
                                 (hjson/compact-json
                                  (array-map "commit" approved-commit
                                             "project" source-root
                                             "source_repo" approved-source-repo))))
                              (if (prove-cut) r2 (assoc r2 :code 1)))))]
                  (commit-with-audit!
                   runtime audit task "cut" (if (zero? (:code r)) "pinned" "failed")
                   {:approved_commit approved-commit
                    :source_root source-root
                    :log_sha256 (:sha256 r)}
                   (if (zero? (:code r))
                     {:status "running" :checkpoint {:phase "preflight"}}
                     (terminal-fail "cut"))
                   ctx)))

              "preflight"
              (fn [task runtime ctx]
                (let [r (command "preflight" "bash" ["harness/check.sh" "--local"])]
                  (commit-with-audit!
                   runtime audit task "self-check" (if (zero? (:code r)) "passed" "failed")
                   {:log_sha256 (:sha256 r)}
                   (if (zero? (:code r))
                     {:status "running" :checkpoint {:phase "fence"}}
                     (terminal-fail "self-check"))
                   ctx)))

              "fence"
              (fn [task runtime ctx]
                (let [r (if (proof-of-fence)
                          {:code 0 :output "fence OK: reconciled"
                           :sha256 (fx/hash-value "fence OK: reconciled")}
                          (command "fence" "bash" ["harness/fence.sh" room-dir]))]
                  (commit-with-audit!
                   runtime audit task "fence" (if (zero? (:code r)) "passed" "failed")
                   {:room room-dir :log_sha256 (:sha256 r)}
                   (if (zero? (:code r))
                     {:status "running" :checkpoint {:phase "checklist"}}
                     (terminal-fail "fence"))
                   ctx)))

              "checklist"
              (fn [task runtime ctx]
                (let [out (plat/path scratch "checklist.json")
                      r (measure-log "checklist"
                                     #(do (checklist/generate {:root source-root :out out})
                                          {:stdout "checklist derived\n" :stderr ""}))
                      n (if (zero? (:code r))
                          (count (get (hjson/read-json (plat/read-text out)) "items"))
                          0)
                      actual (when (zero? (:code r)) (d/file-sha256 out))
                      approved? (or (nil? approved-commit) (= actual approved-checklist-sha256))]
                  (commit-with-audit!
                   runtime audit task "checklist"
                   (if (and (zero? (:code r)) approved?) "derived" "refused")
                   {:item_count n
                    :checklist_sha256 actual
                    :approved_sha256 approved-checklist-sha256
                    :log_sha256 (:sha256 r)}
                   (if (and (zero? (:code r)) approved?)
                     {:status "running" :checkpoint {:phase "render"}}
                     (terminal-fail "checklist"))
                   ctx)))

              "render"
              (fn [task runtime ctx]
                (let [instruction (if live
                                    (plat/read-text (plat/path pi-dir (:instruction-file builder)))
                                    (str (plat/read-text (plat/path source-root "harness" "README.md"))
                                         "\n\n"
                                         (plat/read-text (plat/path source-root "docs" "plan"
                                                                    loyly/BOOKING_SLICE "spec.feature"))))
                      cmd-sha (when (and live (plat/exists? (:command builder)))
                                (d/file-sha256 (:command builder)))
                      manifest (when live (plat/path (:image builder) "manifest.json"))
                      img-sha (when (and manifest (plat/exists? manifest))
                                (d/file-sha256 manifest))
                      instr-sha (fx/hash-value instruction)
                      approved? (or (not live)
                                    (and (= instr-sha (:instruction-sha256 builder))
                                         (= cmd-sha (:command-sha256 builder))
                                         (= img-sha (:image-sha256 builder))))]
                  (when approved?
                    (plat/write-text (plat/path scratch "prompt.txt") instruction))
                  (commit-with-audit!
                   runtime audit task "render" (if approved? "completed" "refused")
                   {:instruction_sha256 instr-sha
                    :approved_instruction_sha256 (:instruction-sha256 builder)
                    :builder_command_sha256 cmd-sha
                    :approved_command_sha256 (:command-sha256 builder)
                    :builder_image_sha256 img-sha
                    :approved_image_sha256 (:image-sha256 builder)
                    :model (:model builder)}
                   (if approved?
                     {:status "running"
                      :checkpoint {:phase "build" :attempt 1 :previousGateLog nil}}
                     (terminal-fail "render"))
                   ctx)))

              "build"
              (fn [task runtime ctx]
                (let [cp (js->clj (.. task -state -checkpoint) :keywordize-keys true)]
                  (.commit runtime
                           (fn [tx]
                             (p/let [id (.createTask tx Builder
                                                     (clj->js {:attempt (:attempt cp)
                                                               :previousFailureLog (:previousFailureLog cp)
                                                               :previousFailureSha256 (:previousFailureSha256 cp)
                                                               :previousFailureKind (:previousFailureKind cp)})
                                                     #js {:ownership #js {:kind "task" :taskId (.-id task)}})]
                               #js {:status "waiting"
                                    :checkpoint #js {:phase "after-build"
                                                     :attempt (:attempt cp)
                                                     :builder id}
                                    :on #js [id]
                                    :policy "failFast"}))
                           ctx)))

              "after-build"
              (fn [task runtime ctx]
                (let [cp (js->clj (.. task -state -checkpoint) :keywordize-keys true)
                      attempt (:attempt cp)]
                  (p/let [outcomes (.outcomes runtime #js [(:builder cp)] ctx)]
                    (let [outcome (js->clj (aget outcomes 0))
                          decision ((:after-build lifecycle) attempt outcome)]
                      (cond
                        (= "builder" (get decision "retry"))
                        (commit-with-audit!
                         runtime audit task "retry" "scheduled"
                         {:attempt (get decision "attempt")
                          :previous_builder_log (get decision "failureLog")
                          :previous_builder_log_sha256 (get decision "failureSha256")
                          :fork_from (builder-receipt-path scratch attempt)}
                         {:status "running"
                          :checkpoint {:phase "build"
                                       :attempt (get decision "attempt")
                                       :previousFailureLog (get decision "failureLog")
                                       :previousFailureSha256 (get decision "failureSha256")
                                       :previousFailureKind "builder"}}
                         ctx)

                        (get decision "terminal")
                        (commit-with-audit!
                         runtime audit task "cycle" "failed"
                         {:reason (get decision "reason") :attempt attempt}
                         (if (get decision "exhausted")
                           {:status "terminal"
                            :outcome {:status "completed" :result {:passed false :attempts attempt}}}
                           (terminal-fail "build"))
                         ctx)

                        :else
                        (.commit runtime
                                 (fn [_tx]
                                   #js {:status "running"
                                        :checkpoint #js {:phase (get decision "phase") :attempt attempt}})
                                 ctx))))))

              "gate"
              (fn [task runtime ctx]
                (let [attempt (.. task -state -checkpoint -attempt)]
                  (.commit runtime
                           (fn [tx]
                             (p/let [id (.createTask tx Gate #js {:attempt attempt}
                                                     #js {:ownership #js {:kind "task" :taskId (.-id task)}})]
                               #js {:status "waiting"
                                    :checkpoint #js {:phase "after-gate" :attempt attempt :gate id}
                                    :on #js [id]
                                    :policy "failFast"}))
                           ctx)))

              "after-gate"
              (fn [task runtime ctx]
                (let [cp (js->clj (.. task -state -checkpoint) :keywordize-keys true)
                      attempt (:attempt cp)]
                  (p/let [outcomes (.outcomes runtime #js [(:gate cp)] ctx)]
                    (let [outcome (js->clj (aget outcomes 0))
                          decision ((:after-gate lifecycle) attempt outcome)]
                      (cond
                        (= "gate-effect-failed" (get decision "reason"))
                        (commit-with-audit!
                         runtime audit task "cycle" "failed"
                         {:reason (get decision "reason") :attempt attempt}
                         (terminal-fail "gate")
                         ctx)

                        (= "gate" (get decision "retry"))
                        (commit-with-audit!
                         runtime audit task "retry" "scheduled"
                         {:attempt (get decision "attempt")
                          :previous_gate_log (get decision "failureLog")
                          :previous_gate_log_sha256 (get decision "failureSha256")
                          :fork_from (when live (builder-receipt-path scratch attempt))}
                         {:status "running"
                          :checkpoint {:phase "build"
                                       :attempt (get decision "attempt")
                                       :previousFailureLog (get decision "failureLog")
                                       :previousFailureSha256 (get decision "failureSha256")
                                       :previousFailureKind "gate"}}
                         ctx)

                        (get decision "terminal")
                        (commit-with-audit!
                         runtime audit task "cycle" "failed"
                         {:reason (get decision "reason") :attempts attempt}
                         {:status "terminal"
                          :outcome {:status "completed" :result {:passed false :attempts attempt}}}
                         ctx)

                        :else
                        (.commit runtime
                                 (fn [_tx]
                                   #js {:status "running"
                                        :checkpoint #js {:phase (get decision "phase")
                                                         :attempt attempt
                                                         :candidateSha256 (get decision "candidateSha256")}})
                                 ctx))))))

              "grading-room"
              (fn [task runtime ctx]
                (let [cp (js->clj (.. task -state -checkpoint) :keywordize-keys true)
                      cand-sha (or (:candidateSha256 cp) (candidate-digest))]
                  (if live
                    (room/prepare-grading-room
                     {:source-room source-root
                      :candidate-room room-dir
                      :checklist-file (plat/path scratch "checklist.json")
                      :schema-file schema-file
                      :out grading-room
                      :candidate-sha256 cand-sha
                      :checklist-sha256 approved-checklist-sha256
                      :schema-sha256 (:schema-sha256 grader)
                      :project project
                      :blind-review blind-required})
                    (do
                      (plat/create-dirs grading-room)
                      (let [ids (map #(get % "id")
                                     (get (hjson/read-json (plat/read-text (plat/path scratch "checklist.json"))) "items"))]
                        (plat/write-text (plat/path grading-room "checklist.txt")
                                         (str (str/join "\n" ids) "\n")))))
                  (commit-with-audit!
                   runtime audit task "grading-room" "prepared"
                   {:room grading-room
                    :candidate_sha256 cand-sha
                    :checklist_sha256 approved-checklist-sha256
                    :schema_sha256 (when live attached-schema-sha256)}
                   {:status "running"
                    :checkpoint {:phase "grade" :attempt (:attempt cp) :candidateSha256 cand-sha}}
                   ctx)))

              "grade"
              (fn [task runtime ctx]
                (let [cp (js->clj (.. task -state -checkpoint) :keywordize-keys true)]
                  (.commit runtime
                           (fn [tx]
                             (p/let [id (.createTask tx Grade #js {:candidateSha256 (:candidateSha256 cp)}
                                                     #js {:ownership #js {:kind "task" :taskId (.-id task)}})]
                               #js {:status "waiting"
                                    :checkpoint #js {:phase "after-grade"
                                                     :attempt (:attempt cp)
                                                     :candidateSha256 (:candidateSha256 cp)
                                                     :grade id}
                                    :on #js [id]
                                    :policy "failFast"}))
                           ctx)))

              "after-grade"
              (fn [task runtime ctx]
                (let [cp (js->clj (.. task -state -checkpoint) :keywordize-keys true)]
                  (p/let [outcomes (.outcomes runtime #js [(:grade cp)] ctx)]
                    (let [outcome (js->clj (aget outcomes 0))
                          decision ((:after-grade lifecycle) outcome)]
                      (if (get decision "terminal")
                        (commit-with-audit!
                         runtime audit task "cycle" "failed"
                         {:reason (get decision "reason") :attempt (:attempt cp)}
                         (terminal-fail "grade")
                         ctx)
                        (.commit runtime
                                 (fn [_tx]
                                   #js {:status "running"
                                        :checkpoint #js {:phase (get decision "phase")
                                                         :attempt (:attempt cp)
                                                         :candidateSha256 (:candidateSha256 cp)}})
                                 ctx))))))

              "blind-review"
              (fn [task runtime ctx]
                (let [cp (js->clj (.. task -state -checkpoint) :keywordize-keys true)
                      err-log (plat/path scratch "blind-review-error.log")]
                  (p/let [outcome
                          (-> (p/do
                                (when-not blind-agent
                                  (throw (ex-info "blind review agent not configured" {})))
                                (let [packet-dir (plat/path scratch "blind-agent-packet")
                                      _ (blind/prepare-blind-review {:grading-room grading-room :out packet-dir})
                                      res (blind-agent/run-blind-agent
                                           {:packet-dir packet-dir
                                            :grading-room grading-room
                                            :room (plat/path scratch "blind-agent-room")
                                            :instruction (plat/path pi-dir (:instruction-file blind-agent))
                                            :command (:command blind-agent)
                                            :image (:image blind-agent)
                                            :settings (:settings blind-agent)
                                            :model (:model blind-agent)
                                            :evidence-dir (plat/path scratch "blind-agent-evidence")
                                            :state-root (plat/path repo ".pi" "harness" ".state")
                                            :session-id (str run-id "-blind")
                                            :instruction-sha256 (:instruction-sha256 blind-agent)
                                            :command-sha256 (:command-sha256 blind-agent)
                                            :image-sha256 (:image-sha256 blind-agent)
                                            :settings-sha256 (:settings-sha256 blind-agent)
                                            :spawn-fn (fn [cmd opts]
                                                        (plat/exec-sync cmd {:dir (:dir opts) :env (:env opts)}))})
                                      review-file (plat/path scratch "blind-agent-review.json")
                                      _ (hjson/spit-utf8 review-file (str (hjson/write (:review res)) "\n"))
                                      _ (when (:request res)
                                          (hjson/spit-utf8 (plat/path scratch "blind-agent-request.json")
                                                           (str (hjson/write (:request res)) "\n")))
                                      verif-dir (when (= "pass" (get (:review res) "verdict"))
                                                  (let [vdir (plat/path scratch "blind-agent-verification")]
                                                    (blind/probe-blind-answer
                                                     {:packet-dir packet-dir
                                                      :review-file review-file
                                                      :grading-room grading-room
                                                      :request (:request res)
                                                      :out vdir})
                                                    vdir))
                                      allure-dir (plat/path scratch "blind-agent-allure")
                                      _ (blind/write-blind-agent-allure
                                         {:packet-dir packet-dir
                                          :review-file review-file
                                          :grading-room grading-room
                                          :verification-dir verif-dir
                                          :out allure-dir})
                                      projected (blind/final-verdicts-from-blind-review
                                                 {:packet-dir packet-dir
                                                  :review-file review-file
                                                  :grading-room grading-room
                                                  :verification-dir verif-dir
                                                  :out allure-dir})
                                      final-vfile (plat/path scratch "final-verdicts.json")]
                                  (hjson/spit-utf8 final-vfile (hjson/compact-json (:verdicts projected)))
                                  {:res res :projected projected}))
                              (p/catch (fn [e]
                                         (let [reason (str (or (.-stack e) (ex-message e) e))]
                                           (plat/write-text err-log (str reason "\n"))
                                           {:reason reason}))))]
                    (let [{:keys [res projected reason]} outcome
                          ok? (some? projected)
                          decision ((:after-assessment lifecycle) "blind-review" ok?)]
                      (commit-with-audit!
                       runtime audit task "blind-review" (if ok? "completed" "failed")
                       {:item loyly/BLIND_ITEM_ID
                        :model (:model blind-agent)
                        :verdict (get-in res [:review "verdict"])
                        :raw_allure_sha256 (:raw-allure-sha256 projected)
                        :review_sha256 (:review-sha256 projected)
                        :agent_launch_receipt_sha256 (get-in res [:review "launch_receipt_sha256"])
                        :reconciled (boolean (:reconciled res))
                        :reason_code (when reason "blind-review-effect")}
                       (if (get decision "terminal")
                         (terminal-fail "blind-review")
                         {:status "running"
                          :checkpoint {:phase (get decision "phase")
                                       :attempt (:attempt cp)
                                       :candidateSha256 (:candidateSha256 cp)}})
                       ctx)))))

              "panel"
              (fn [task runtime ctx]
                (let [cp (js->clj (.. task -state -checkpoint) :keywordize-keys true)]
                  (.commit runtime
                           (fn [tx]
                             (p/let [id (.createTask tx Panel #js {:candidateSha256 (:candidateSha256 cp)}
                                                     #js {:ownership #js {:kind "task" :taskId (.-id task)}})]
                               #js {:status "waiting"
                                    :checkpoint #js {:phase "after-panel"
                                                     :attempt (:attempt cp)
                                                     :candidateSha256 (:candidateSha256 cp)
                                                     :panel id}
                                    :on #js [id]
                                    :policy "failFast"}))
                           ctx)))

              "after-panel"
              (fn [task runtime ctx]
                (let [cp (js->clj (.. task -state -checkpoint) :keywordize-keys true)]
                  (p/let [outcomes (.outcomes runtime #js [(:panel cp)] ctx)]
                    (let [outcome (js->clj (aget outcomes 0))
                          ok? (= "completed" (get outcome "status"))
                          decision ((:after-assessment lifecycle) "panel" ok?)]
                      (if (get decision "terminal")
                        (commit-with-audit!
                         runtime audit task "cycle" "failed"
                         {:reason (get decision "reason") :attempt (:attempt cp)}
                         (terminal-fail "panel")
                         ctx)
                        (.commit runtime
                                 (fn [_tx]
                                   #js {:status "running"
                                        :checkpoint #js {:phase (get decision "phase")
                                                         :attempt (:attempt cp)
                                                         :candidateSha256 (:candidateSha256 cp)
                                                         :panelAttempt (get-in outcome ["result" "attempt"])}})
                                 ctx))))))

              "score"
              (fn [task runtime ctx]
                (let [cp (js->clj (.. task -state -checkpoint) :keywordize-keys true)
                      cand-sha (:candidateSha256 cp)
                      verdicts-file (plat/path scratch (if (and live blind-required)
                                                         "final-verdicts.json"
                                                         "verdicts.json"))
                      _ (when-not (plat/exists? instrument)
                          (let [r (command "instrument-clone" "git"
                                           ["clone" "-q" "--depth" "1"
                                            (str "file://" source-root) instrument]
                                           :cwd repo)]
                            (when-not (zero? (:code r))
                              (throw (ex-info "instrument clone failed" r)))))
                      cycle-dir (plat/path instrument "harness" "cycles" score-cycle)
                      _ (plat/create-dirs cycle-dir)
                      _ (plat/copy (plat/path scratch "checklist.json")
                                   (plat/path cycle-dir "checklist.json"))
                      _ (receipt/bind-score-input
                         {:scratch scratch
                          :source-root source-root
                          :instrument instrument
                          :candidate-sha256 cand-sha
                          :verdicts-file verdicts-file
                          :score-cycle score-cycle})
                      scored (measure-log "score"
                                          #(score/score-cycle {:root instrument
                                                               :cycle score-cycle
                                                               :verdicts-path verdicts-file}))
                      verified (when (zero? (:code scored))
                                 (receipt/verify-scored-cycle
                                  {:scratch scratch
                                   :instrument instrument
                                   :verdicts-file verdicts-file
                                   :cycle score-cycle}))
                      board-res (when verified
                                  (measure-log "scoreboard"
                                               #(let [res (board/report {:root instrument :cycle score-cycle})]
                                                  {:stdout (:text res) :stderr ""})))
                      ok? (and verified board-res (zero? (:code board-res)))]
                  (.commit runtime
                           (fn [tx]
                             (p/let [_ (audit tx task "score" (if ok? "filed" "failed")
                                              (clj->js {:score (:score verified)
                                                        :score_file_sha256 (:score-sha256 verified)
                                                        :score_input_sha256 (d/file-sha256 (plat/path scratch "score-input.json"))
                                                        :log_sha256 (:sha256 scored)}))
                                     _ (when ok?
                                         (audit tx task "scoreboard" "written"
                                                (clj->js {:log_sha256 (:sha256 board-res)})))]
                               (if-not ok?
                                 (terminal-fail "score")
                                 (if (and live panel)
                                   #js {:status "running"
                                        :checkpoint (clj->js (assoc cp :phase "panel-report"
                                                                    :score (:score verified)))}
                                   (p/let [_ (audit tx task "cycle" "measured"
                                                    (clj->js {:attempt (:attempt cp) :score (:score verified)}))]
                                     #js {:status "terminal"
                                          :outcome #js {:status "completed"
                                                        :result #js {:passed true
                                                                     :attempt (:attempt cp)
                                                                     :score (:score verified)}}})))))
                           ctx)))

              "panel-report"
              (fn [task runtime ctx]
                (let [cp (js->clj (.. task -state -checkpoint) :keywordize-keys true)
                      panel-attempt (:panelAttempt cp)
                      spec-dir (plat/path scratch "panel-vm" (str "attempt-" (plat/pad-left-zero panel-attempt 2)))]
                  (p/let [rows (read-audit-rows-fn scratch)]
                    (let [rep (panel-ad/run-durable-panel-report
                               {:scratch scratch
                                :specialists spec-dir
                                :plan-file (plat/path pi-dir (:plan-file panel))
                                :pi-durable pi-dir
                                :allure-cli-fn allure-cli-fn
                                :audit-rows-fn (constantly rows)})
                          ok? (= "ready-for-review" (get-in rep [:summary "panel_outcome"]))]
                      (.commit runtime
                               (fn [tx]
                                 (p/let [_ (audit tx task "panel-report" (if ok? "ready" "failed")
                                                  (clj->js {:panel_outcome (get-in rep [:summary "panel_outcome"])
                                                            :panel_manifest_sha256 (d/file-sha256 (plat/path (:out rep) "panel-manifest.json"))
                                                            :attempt (:attempt rep)}))]
                                   (if ok?
                                     (p/let [_ (audit tx task "cycle" "measured"
                                                      (clj->js {:attempt (:attempt cp) :score (:score cp)}))]
                                       #js {:status "terminal"
                                            :outcome #js {:status "completed"
                                                          :result #js {:passed true
                                                                       :attempt (:attempt cp)
                                                                       :score (:score cp)
                                                                       :panelOutcome (get-in rep [:summary "panel_outcome"])}}})
                                     (terminal-fail "panel-report"))))
                               ctx)))))

              "done"
              (fn [_task runtime ctx]
                (.commit runtime
                         (fn [_tx]
                           #js {:status "terminal"
                                :outcome #js {:status "completed" :result #js {:passed true}}})
                         ctx))}}))

(defn build-cycle-input [cfg run-id score-cycle env-map]
  (let [{:keys [approved-commit approved-checklist-sha256 mode builder grader
                grader-shard-count blind-agent blind-required project panel
                approved-source-repo live]} cfg]
    (cond-> {:runId run-id
             :approvedCommit approved-commit
             :approvedChecklistSha256 approved-checklist-sha256
             :mode mode
             :builder builder
             :grader grader
             :blindAgent blind-agent
             :panel panel
             :graderShardCount (when live grader-shard-count)}
      (get env-map "LOYLY_SOURCE_REPO") (assoc :approvedSourceRepo approved-source-repo)
      (not= score-cycle "02") (assoc :scoreCycle score-cycle)
      (get env-map "HARNESS_PROJECT_ID") (assoc :project project)
      (and live (not blind-required)) (assoc :blindRequired false))))

(defn run-worker!
  "Execute the Pi durable cycle worker via .cljc core + minimal pi-extension.ts."
  [{:keys [repo scratch mode env gondolin-fn allure-cli-fn]}]
  (let [repo (rt/resolve-repo repo)
        pi-dir (plat/path repo "harness" "pi-durable")
        env-map (or env (plat/getenv))
        scratch (plat/absolutize (or scratch (plat/path pi-dir "scratch")))
        run-id (or (get env-map "LOYLY_RUN_ID") "prototype-cycle-1")
        score-cycle (or (get env-map "LOYLY_SCORE_CYCLE") "02")
        _ (when-not (re-matches #"[A-Za-z0-9._-]+" run-id)
            (rt/die! "LOYLY_RUN_ID contains unsafe characters"))
        _ (when-not (re-matches #"\d\d" score-cycle)
            (rt/die! "LOYLY_SCORE_CYCLE must be two digits"))
        cfg (wcfg/parse-worker-config repo scratch mode env-map)
        lifecycle (life/create-lifecycle
                   :assessments (if (:live cfg)
                                  (cond-> []
                                    (:blind-required cfg) (conj "blind-review")
                                    (:panel cfg) (conj "panel"))
                                  []))
        store-path (plat/path scratch "cycle.PROTOTYPE.sqlite")
        room-dir (plat/path scratch "fenced-room")
        grading-room (plat/path scratch "grading-room")
        instrument (plat/path scratch "instrument")
        builder-store (plat/path scratch "builder-lineage" "session.sqlite")
        schema-file (plat/path pi-dir "allure-lifecycle-result.schema.json")
        attached-schema-sha256 (d/file-sha256 schema-file)
        _ (plat/create-dirs scratch)
        effects (fx/create-cycle-effects
                 {:root repo
                  :scratch scratch
                  :room room-dir
                  :cut (:cut cfg)
                  :source-root (:source-root cfg)
                  :approved-source-repo (:approved-source-repo cfg)
                  :approved-commit (:approved-commit cfg)
                  :digest-candidate room/candidate-digest
                  :environment env-map})
        cycle-input (build-cycle-input cfg run-id score-cycle env-map)
        ext-path (plat/path pi-dir "pi-extension.ts")]
    (p/let [ext (rt/import-esm ext-path)
            read-audit-rows-fn (fn [dir]
                                 (p/let [rows ((.-readAuditRows ext) (plat/absolutize dir))]
                                   (js->clj rows)))
            res ((.-runDurableCycle ext)
                 #js {:storePath store-path
                      :scratch scratch
                      :runId run-id
                      :mode (:mode cfg)
                      :cycleInput (clj->js cycle-input)
                      :buildTasks
                      (fn [helpers]
                        (let [audit (.-audit helpers)
                              shared {:cfg cfg
                                      :lifecycle lifecycle
                                      :scratch scratch
                                      :room-dir room-dir
                                      :grading-room grading-room
                                      :instrument instrument
                                      :pi-dir pi-dir
                                      :repo repo
                                      :run-id run-id
                                      :score-cycle score-cycle
                                      :builder-store builder-store
                                      :schema-file schema-file
                                      :attached-schema-sha256 attached-schema-sha256
                                      :effects effects
                                      :audit audit
                                      :gondolin-fn gondolin-fn
                                      :allure-cli-fn allure-cli-fn
                                      :read-audit-rows-fn read-audit-rows-fn}]
                          #js {:builder (build-builder-task shared)
                               :gate (build-gate-task shared)
                               :grade (build-grade-task shared)
                               :panel (build-panel-task shared)
                               :cycle (fn [refs]
                                        (build-cycle-task
                                         shared
                                         {:Builder (.-Builder refs)
                                          :Gate (.-Gate refs)
                                          :Grade (.-Grade refs)
                                          :Panel (.-Panel refs)}))}))})]
      (let [final (js->clj (.-final res))
            outcome (get-in final ["state" "outcome"])]
        (if (or (not= "completed" (get outcome "status"))
                (and (:live cfg) (not= true (get-in outcome ["result" "passed"]))))
          1
          0)))))
