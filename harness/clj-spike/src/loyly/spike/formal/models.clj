(ns loyly.spike.formal.models
  "Mathematical models (Malli) for Löyly spike contracts.
  Formal-verification road: schemas define the system; validators prove
  instances obey them. Traceability to TS JSON Schema lives in formal.trace."
  (:require [clojure.test.check.generators :as gen]
            [loyly.spike.project.loyly :as loyly]
            [malli.core :as m]
            [malli.error :as me]
            [malli.generator :as mg]))

(defn- hex-string-gen [n]
  (gen/fmap #(apply str %) (gen/vector (gen/elements (vec "0123456789abcdef")) n)))

(def Sha256
  [:re {:gen/gen (hex-string-gen 64)} #"^[0-9a-f]{64}$"])

(def Commit40
  [:re {:gen/gen (hex-string-gen 40)} #"^[0-9a-f]{40}$"])

(def ItemId
  [:re {:gen/gen (gen/fmap (fn [[a b]] (format "%02d-%03d" a b))
                           (gen/tuple (gen/choose 0 99) (gen/choose 0 999)))}
   #"^\d{2}-\d{3}$"])

(def Uuid
  [:re {:gen/gen
        (gen/fmap (fn [[a b c d e]]
                    (str a "-" b "-" c "-" d "-" e))
                  (gen/tuple (hex-string-gen 8) (hex-string-gen 4)
                             (hex-string-gen 4) (hex-string-gen 4)
                             (hex-string-gen 12)))}
   #"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"])

(def BlindPacket
  [:map
   ["schema" [:= loyly/BLIND_PACKET]]
   ["item" [:= loyly/BLIND_ITEM_ID]]
   ["candidate_sha256" Sha256]
   ["checklist_sha256" Sha256]
   ["spec_sha256" Sha256]
   ["allure_results_sha256" Sha256]
   ["refusal_sha256" Sha256]])

(def BlindResponse
  [:map
   ["schema" [:= loyly/BLIND_RESPONSE]]
   ["packet_sha256" Sha256]
   ["reviewer_kind" [:= "agent"]]
   ["reviewer" [:string {:min 1}]]
   ["had_not_read_configuration" [:= true]]
   ["saw_only_refusal" [:= true]]
   ["answer" [:string {:min 1}]]
   ["verdict" [:enum "pass" "fail"]]
   ["reason" [:string {:min 1}]]
   ["reviewed_at" [:int {:min 1}]]])

(def BlindProbe
  [:map
   ["schema" [:= loyly/BLIND_PROBE]]
   ["item" [:= loyly/BLIND_ITEM_ID]]
   ["candidate_sha256" Sha256]
   ["packet_sha256" Sha256]
   ["review_sha256" Sha256]
   ["http_status" [:int {:min 100 :max 599}]]
   ["response_sha256" Sha256]
   ["accepted" :boolean]
   ["observed_at" [:int {:min 1}]]])

(def AllureLabel
  [:map
   ["name" :string]
   ["value" :string]])

(def AllureAttachment
  [:map
   ["name" :string]
   ["source" :string]
   ["type" :string]])

(def AllureStep
  [:map
   ["name" :string]
   ["status" [:enum "passed" "failed" "broken" "skipped" "unknown"]]
   ["stage" [:enum "scheduled" "running" "finished" "pending" "interrupted"]]])

(def AllureLifecycle
  [:map
   ["uuid" Uuid]
   ["status" [:enum "passed" "failed" "broken" "skipped" "unknown"]]
   ["stage" [:enum "scheduled" "running" "finished" "pending" "interrupted"]]
   ["statusDetails" [:map ["message" :string]]]
   ["labels" [:vector AllureLabel]]
   ["attachments" [:vector AllureAttachment]]
   ["steps" [:vector {:min 1} AllureStep]]])

(def id-token-gen
  (gen/fmap (fn [[h t]] (str h (apply str t)))
            (gen/tuple (gen/elements (vec "abcdefghijklmnopqrstuvwxyz"))
                       (gen/vector (gen/elements (vec "abcdefghijklmnopqrstuvwxyz0123456789-"))
                                   0 8))))

(def PanelCheck
  [:map
   ["id" [:re {:gen/gen id-token-gen} #"^[a-z][a-z0-9-]*$"]]
   ["source" [:enum "raw-grader" "blind-review" "specialist"]]
   ["role" [:enum "scored" "handoff" "corroborating" "diagnostic"]]
   ["tool" [:string {:min 1}]]
   ["technique" [:string {:min 1}]]
   ["items" [:vector {:min 1} ItemId]]
   ["criterion" [:string {:min 1}]]
   ["failure" [:string {:min 1}]]
   ["target_runtime" [:= "gondolin-qemu-vm"]]
   ["script" {:optional true}
    [:re {:gen/gen (gen/fmap #(str % ".mjs") id-token-gen)}
     #"^[a-z][a-z0-9-]*\.mjs$"]]
   ["feature" {:optional true} [:string {:min 1}]]])

(def PanelPlan
  [:map
   ["schema" [:enum loyly/LEGACY_PANEL_PLAN "harness.grading-panel-plan.v2"]]
   ["project" [:string {:min 1}]]
   ["feature" [:string {:min 1}]]
   ["checks" [:vector {:min 1} PanelCheck]]
   ["bundle" {:optional true}
    [:map
     ["path" [:re {:gen/gen id-token-gen} #"^[a-z][a-z0-9/-]*$"]]
     ["sha256" Sha256]]]])

(def PanelSummary
  [:map
   ["schema" [:= loyly/PANEL_SUMMARY]]
   ["candidate_sha256" Sha256]
   ["plan_sha256" Sha256]
   ["original_score_sha256" Sha256]
   ["panel_outcome" [:string {:min 1}]]])

(def CycleDigits
  [:re {:gen/gen (gen/fmap #(format "%02d" %) (gen/choose 0 99))} #"^\d{2}$"])

(def ProjectId
  [:re {:gen/gen id-token-gen} #"^[a-z][a-z0-9-]*$"])

(def RunId
  [:re {:gen/gen (gen/fmap #(apply str %)
                           (gen/vector
                            (gen/elements
                             (vec "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._-"))
                            1 12))}
   #"^[A-Za-z0-9._-]+$"])

(def AgentPin
  "Base agent pin (builder)."
  [:map
   ["command" [:string {:min 1}]]
   ["command_sha256" Sha256]
   ["image" [:string {:min 1}]]
   ["image_sha256" Sha256]
   ["model" [:string {:min 1}]]
   ["instruction_sha256" Sha256]
   ["instruction_file" {:optional true}
    [:re {:gen/gen (gen/fmap #(str % ".md") id-token-gen)} #"^[A-Za-z0-9._-]+\.md$"]]
   ["settings" {:optional true} [:string {:min 1}]]
   ["settings_sha256" {:optional true} Sha256]
   ["schema_sha256" {:optional true} Sha256]
   ["shards" {:optional true} [:int {:min 1 :max 16}]]])

(def GraderPin
  "Grader pin — settings, schema digest and shard count required."
  [:map
   ["command" [:string {:min 1}]]
   ["command_sha256" Sha256]
   ["image" [:string {:min 1}]]
   ["image_sha256" Sha256]
   ["model" [:string {:min 1}]]
   ["instruction_sha256" Sha256]
   ["instruction_file" {:optional true}
    [:re {:gen/gen (gen/fmap #(str % ".md") id-token-gen)} #"^[A-Za-z0-9._-]+\.md$"]]
   ["settings" [:string {:min 1}]]
   ["settings_sha256" Sha256]
   ["schema_sha256" Sha256]
   ["shards" [:int {:min 1 :max 16}]]])

(def BlindAgentPin
  "Blind-review agent pin — settings required."
  [:map
   ["command" [:string {:min 1}]]
   ["command_sha256" Sha256]
   ["image" [:string {:min 1}]]
   ["image_sha256" Sha256]
   ["model" [:string {:min 1}]]
   ["instruction_sha256" Sha256]
   ["instruction_file" {:optional true}
    [:re {:gen/gen (gen/fmap #(str % ".md") id-token-gen)} #"^[A-Za-z0-9._-]+\.md$"]]
   ["settings" [:string {:min 1}]]
   ["settings_sha256" Sha256]])

(def PanelPin
  [:map
   ["image" [:string {:min 1}]]
   ["image_sha256" Sha256]
   ["plan_sha256" Sha256]
   ["plan_file" {:optional true}
    [:re {:gen/gen (gen/fmap #(str % ".panel.json") id-token-gen)}
     #"^[a-z][a-z0-9-]*\.panel\.json$"]]])

(def LiveRunSource
  [:map
   ["repo" [:string {:min 1}]]
   ["commit" Commit40]
   ["checklist_sha256" Sha256]
   ["spec_file" {:optional true} [:string {:min 1}]]
   ["spec_sha256" {:optional true} Sha256]
   ["specs" {:optional true}
    [:vector {:min 1}
     [:map ["file" [:string {:min 1}]] ["sha256" Sha256]]]]])

(def LiveRunV1
  "loyly.pi-live-run.v1 — blind + panel required; no project."
  [:map
   ["schema" [:= "loyly.pi-live-run.v1"]]
   ["run_id" RunId]
   ["score_cycle" {:optional true} CycleDigits]
   ["controller_commit" Commit40]
   ["source" LiveRunSource]
   ["scratch" [:string {:min 1}]]
   ["builder" AgentPin]
   ["grader" GraderPin]
   ["blind" BlindAgentPin]
   ["panel" PanelPin]
   ["runtime" {:optional true}
    [:map ["java21" {:optional true} :boolean]]]])

(def LiveRunV2
  "harness.pi-live-run.v2 — project required; blind forbidden."
  [:map
   ["schema" [:= "harness.pi-live-run.v2"]]
   ["project" ProjectId]
   ["run_id" RunId]
   ["score_cycle" {:optional true} CycleDigits]
   ["controller_commit" Commit40]
   ["source" LiveRunSource]
   ["scratch" [:string {:min 1}]]
   ["builder" AgentPin]
   ["grader" GraderPin]
   ["panel" {:optional true} PanelPin]
   ["runtime" {:optional true}
    [:map ["java21" {:optional true} :boolean]]]])

(def LiveRun
  [:multi {:dispatch #(get % "schema")
           :default ::invalid}
   ["loyly.pi-live-run.v1" LiveRunV1]
   ["harness.pi-live-run.v2" LiveRunV2]])

(def ScoreInput
  [:map
   ["schema" [:= "loyly.score-input.v1"]]
   ["source_commit" Commit40]
   ["candidate_sha256" Sha256]
   ["checklist_sha256" Sha256]
   ["verdicts_sha256" Sha256]
   ["score_cycle" {:optional true} CycleDigits]
   ["panel_manifest_sha256" {:optional true} Sha256]])

(def ChecklistItem
  [:map
   ["id" ItemId]
   ["name" [:string {:min 1}]]
   ["rule" [:string {:min 1}]]
   ["source" [:string {:min 1}]]])

(def Checklist
  [:map
   ["items" [:vector {:min 1} ChecklistItem]]
   ["counts" [:map ["total" [:int {:min 1}]]]]])

(def Verdict
  [:map
   ["id" ItemId]
   ["verdict" [:enum "pass" "fail"]]
   ["evidence" :string]])

(def Verdicts
  [:vector {:min 1} Verdict])

(def ScoredItem
  [:map
   ["id" ItemId]
   ["name" {:optional true} [:string {:min 1}]]
   ["rule" {:optional true} [:string {:min 1}]]
   ["source" {:optional true} [:string {:min 1}]]
   ["verdict" [:enum "pass" "fail"]]
   ["evidence" :string]])

(def Scores
  [:map
   ["items" [:vector {:min 1} ScoredItem]]])

(def GradingRoom
  "Receipt written as `.grading-room.json`."
  [:map
   ["schema" [:= loyly/GRADING_ROOM]]
   ["candidateSha256" Sha256]
   ["checklistSha256" Sha256]
   ["schemaSha256" Sha256]
   ["planSha256" Sha256]
   ["sourcePlans" [:vector {:min 1} [:string {:min 1}]]]
   ["sourcePlan" {:optional true} [:maybe [:string {:min 1}]]]
   ["project" {:optional true} ProjectId]
   ["blindReview" {:optional true} :boolean]])

(def PanelVmProducer
  [:map
   ["started" [:int {:min 0}]]
   ["stopped" [:int {:min 0}]]
   ["tool" {:optional true} [:string {:min 1}]]
   ["item" {:optional true} [:string {:min 1}]]
   ["status" {:optional true} :string]
   ["result" {:optional true} :string]
   ["image_digest" {:optional true} Sha256]])

(def PanelVmRun
  "Panel VM attempt `manifest.json`."
  [:map
   ["schema" [:= loyly/PANEL_VM_RUN]]
   ["source_commit" Commit40]
   ["candidate_sha256" Sha256]
   ["plan_sha256" Sha256]
   ["allure_schema_sha256" Sha256]
   ["original_score_unchanged" [:= true]]
   ["producers" [:vector {:min 1} PanelVmProducer]]
   ["score_state" {:optional true} [:enum "filed" "pre-score"]]
   ["original_score_sha256" {:optional true} Sha256]
   ["worker_bundle_sha256" {:optional true} Sha256]
   ["image_digest" {:optional true} Sha256]
   ["parallel_overlap_ms" {:optional true} [:int {:min 0}]]])

(def PanelReport
  "Compiled panel report `panel-manifest.json`."
  [:map
   ["schema" [:= loyly/PANEL_REPORT]]
   ["panel_summary_sha256" Sha256]
   ["report_html_sha256" Sha256]
   ["audit_entries_sha256" Sha256]
   ["specialist_manifest_sha256" Sha256]
   ["result_count" [:int {:min 0}]]
   ["original_score_unchanged" [:= true]]])

(def GateReceiptFields
  [:map
   ["room" [:string {:min 1}]]
   ["candidate_sha256" Sha256]
   ["exit" [:re {:gen/gen (gen/fmap str (gen/choose 0 255))} #"^\d+$"]]
   ["log_sha256" Sha256]])

(def ReplayEvidence
  [:map
   ["schema" [:= "loyly.replay-evidence.v1"]]
   ["source" :string]
   ["kind" :string]
   ["item" :string]
   ["status" :string]
   ["stage" :string]
   ["observation" :string]
   ["source_digest" Sha256]])

(def Registry
  "Named models for explain / generate / digest.
  Cycle sorts (PhaseName, CycleState) live in formal.cycle."
  {:sha256 Sha256
   :commit Commit40
   :item-id ItemId
   :blind-packet BlindPacket
   :blind-response BlindResponse
   :blind-probe BlindProbe
   :allure-lifecycle AllureLifecycle
   :panel-plan PanelPlan
   :panel-summary PanelSummary
   :live-run LiveRun
   :score-input ScoreInput
   :checklist Checklist
   :verdict Verdict
   :verdicts Verdicts
   :scores Scores
   :grading-room GradingRoom
   :panel-vm-run PanelVmRun
   :panel-report PanelReport
   :gate-receipt GateReceiptFields
   :replay-evidence ReplayEvidence})

(defn schema [name]
  (or (get Registry name)
      (throw (ex-info (str "unknown formal model: " name) {:name name}))))

(defn valid? [name value]
  (m/validate (schema name) value))

(defn explain [name value]
  (some-> (m/explain (schema name) value) me/humanize))

(defn assert! [name value]
  (when-not (valid? name value)
    (throw (ex-info (str "formal model " name " rejected value")
                    {:name name :explain (explain name value)})))
  value)

(defn generate
  "Sample a value from the model (for property tests / fixtures)."
  [name & {:keys [seed size] :or {size 10}}]
  (if seed
    (mg/generate (schema name) {:seed seed :size size})
    (mg/generate (schema name) {:size size})))

(defn model-form
  "Closed form of a named schema (for digesting the model itself)."
  [name]
  (m/form (schema name)))
