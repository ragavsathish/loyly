(ns loyly.node.builder-host
  "Thin ClojureScript Node adapter for the builder/grader session host (.cljs).

  Orchestrates policy, prompt generation, timeout clamping, receipt lineage
  verification, and steer inbox polling via shared .cljc loyly.builder-host,
  and delegates ONLY the @earendil-works/* SDK boundary to
  harness/pi-durable/pi-builder-extension.ts + gondolin-vm.ts."
  (:require ["node:process" :as node-proc]
            [loyly.builder-host :as bh]
            [loyly.hjson :as hjson]
            [loyly.node.runtime :as rt]
            [loyly.platform :as plat]
            [promesa.core :as p]))

(defn- steer-poll-fn [steer-dir log]
  (when steer-dir
    (fn [submit-steer]
      (let [items (bh/pending-steer-files steer-dir)]
        (reduce
         (fn [acc {:keys [name base request-id content]}]
           (p/let [_ acc]
             (-> (p/let [res (submit-steer #js {:content content :requestId request-id})]
                   (plat/write-text (str base ".steered")
                                    (str "submission " (.-id res) " request " request-id "\n"))
                   (log (str "steer " name ": submission " (.-id res))))
                 (p/catch (fn [e]
                            (let [why (or (ex-message e) (str e))]
                              (plat/write-text (str base ".refused") (str why "\n"))
                              (log (str "steer " name " refused: " why))))))))
         (p/resolved nil)
         items)))))

(defn run-builder-host!
  "Run one durable builder/grader session via loyly.builder-host (.cljc) +
   minimal harness/pi-durable/pi-builder-extension.ts. Returns Promise of exit code."
  [{:keys [repo argv env]}]
  (let [env-map (or env (plat/getenv))
        log (fn [text] (plat/err (str text "\n")))]
    (try
      (let [cfg (bh/parse-builder-host-config argv env-map)
            _ (bh/validate-vm-resources env-map)
            ;; Export canonical policy from .cljc into process.env for gondolin-vm.ts child.
            _ (do (aset (.-env node-proc) "LOYLY_GUEST_WORKSPACE" bh/GUEST_WORKSPACE)
                  (aset (.-env node-proc) "LOYLY_GUEST_USER" bh/GUEST_USER)
                  (aset (.-env node-proc) "LOYLY_ALLOWED_HOSTS" (hjson/compact-json bh/ALLOWED_HOSTS)))
            ext-path (plat/path repo "harness" "pi-durable" "pi-builder-extension.ts")
            {:keys [room instruction store request-id pi-settings model
                    timeout-floor timeout-ceiling room-label image-additions-path
                    prompt steer-dir guest-dir readonly-inputs?
                    conversation-receipt parent-conversation-receipt]} cfg
            model-js #js {:provider (:provider model) :modelId (:model-id model)}]
        (-> (p/let [ext (rt/import-esm ext-path)
                    tools-js ((.-resolvePiSettingsTools ext) pi-settings bh/GUEST_WORKSPACE)
                    tools (vec (js->clj tools-js))
                    env-text (bh/environment-text
                              {:tools tools
                               :room-label room-label
                               :timeout-floor timeout-floor
                               :image-additions-path image-additions-path
                               :timeout-ceiling timeout-ceiling
                               :readonly-inputs? readonly-inputs?
                               :guest-dir guest-dir})
                    _ (do (log (str "model: " (:provider model) "/" (:model-id model)))
                          (log (str "bash timeout floor: " timeout-floor "s"))
                          (when (some? timeout-ceiling)
                            (log (str "bash timeout ceiling: " timeout-ceiling "s")))
                          (log (str "environment prompt:\n" env-text)))
                    models ((.-openModelRuntime ext) model-js)]
              (let [lineage-atom (atom nil)
                    existing-conv-id
                    (when (and conversation-receipt (plat/exists? conversation-receipt))
                      (let [lin (bh/validate-existing-receipt!
                                 conversation-receipt store parent-conversation-receipt)]
                        (reset! lineage-atom lin)
                        (get lin "conversationId")))
                    fork-from
                    (when (and (nil? existing-conv-id) parent-conversation-receipt)
                      (let [parent (bh/validate-parent-receipt!
                                    parent-conversation-receipt store conversation-receipt)]
                        #js {:conversationId (get parent "conversationId")
                             :lastEntryId (get parent "lastEntryId")}))
                    content (str (plat/read-text instruction) "\n\n" prompt)
                    on-conv-ready
                    (fn [info]
                      (when conversation-receipt
                        (let [lin (array-map
                                   "store" store
                                   "conversationId" (.-conversationId info)
                                   "parentConversationId" (.-parentConversationId info)
                                   "forkEntryId" (.-forkEntryId info)
                                   "lastEntryId" nil)]
                          (reset! lineage-atom lin)
                          (bh/save-conversation-receipt! conversation-receipt lin))))
                    on-settled-last-entry
                    (fn [last-id]
                      (when (and @lineage-atom conversation-receipt)
                        (let [updated (assoc @lineage-atom "lastEntryId" last-id)]
                          (reset! lineage-atom updated)
                          (bh/save-conversation-receipt! conversation-receipt updated))))
                    clamp-fn (fn [requested]
                               (bh/clamp-bash-timeout requested timeout-floor timeout-ceiling))]
                (-> (p/let [res ((.-runBuilderSession ext)
                                 (cond-> #js {:room room
                                              :store store
                                              :requestId request-id
                                              :content content
                                              :environmentPrompt env-text
                                              :workspace bh/GUEST_WORKSPACE
                                              :tools tools-js
                                              :model model-js
                                              :models models
                                              :clampTimeout clamp-fn
                                              :onConversationReady on-conv-ready
                                              :onSettledLastEntry on-settled-last-entry
                                              :log log}
                                   (some? existing-conv-id)
                                   (doto (aset "existingConversationId" existing-conv-id))
                                   (some? fork-from)
                                   (doto (aset "forkFrom" fork-from))
                                   steer-dir
                                   (doto (aset "pollSteer" (steer-poll-fn steer-dir log)))))]
                      (let [settled (.-settled res)
                            answer (.-answer res)]
                        (when answer
                          (plat/out (str answer "\n")))
                        (if (= "done" (.-status settled))
                          (do (log "status=done") 0)
                          (let [reason (or (.-reason settled) "unknown")
                                detail (.-detail settled)]
                            (log (str "status=unanswered reason=" reason
                                      (when (some? detail)
                                        (str " detail=" (js/JSON.stringify detail)))))
                            1))))
                    (p/catch (fn [e]
                               (log (str "status=error " (or (ex-message e) (str e))))
                               1))
                    (p/finally (fn [_ _]
                                 (.settleCredentialWrites models))))))
            (p/catch (fn [e]
                       (log (or (ex-message e) (str e)))
                       2))))
      (catch :default e
        (log (or (ex-message e) (str e)))
        (p/resolved 2)))))
