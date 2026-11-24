(ns loyly.spike.worker-config
  "PoC port of harness/pi-durable/worker-config.ts"
  (:require [babashka.fs :as fs]
            [loyly.spike.project.loyly :as loyly]))

(def ^:private HASH64 #"[0-9a-f]{64}")
(def ^:private HASH40 #"[0-9a-f]{40}")

(defn- require-digests [values message]
  (when (some #(nil? (re-matches HASH64 (str %))) values)
    (throw (ex-info message {}))))

(defn- env [environment k]
  (or (get environment k) (get environment (keyword k))))

(defn- parse-builder [root environment live?]
  (when live?
    (let [builder {:command (str (fs/absolutize
                                  (or (env environment "LOYLY_BUILDER_COMMAND")
                                      (fs/path root ".pi/harness/bin/builder.sh"))))
                   :image (str (fs/absolutize (or (env environment "LOYLY_BUILDER_IMAGE") "")))
                   :model (env environment "LOYLY_BUILDER_MODEL")
                   :command-sha256 (env environment "LOYLY_BUILDER_COMMAND_SHA256")
                   :image-sha256 (env environment "LOYLY_BUILDER_IMAGE_SHA256")
                   :instruction-sha256 (env environment "LOYLY_BUILDER_INSTRUCTION_SHA256")
                   :instruction-file (or (env environment "LOYLY_BUILDER_INSTRUCTION_FILE")
                                         "builder-instruction.md")}]
      (when (or (nil? (env environment "LOYLY_APPROVED_COMMIT"))
                (nil? (env environment "LOYLY_BUILDER_IMAGE"))
                (nil? (:model builder))
                (some #(nil? (re-matches HASH64 (str %)))
                      [(:command-sha256 builder)
                       (:image-sha256 builder)
                       (:instruction-sha256 builder)]))
        (throw (ex-info
                "live build needs approved cut/checklist, model, command, image, and three SHA-256 values"
                {})))
      builder)))

(defn- parse-grader [root environment live? builder]
  (when (and live? (env environment "LOYLY_GRADER_MODEL"))
    (let [grader {:command (str (fs/absolutize
                                 (or (env environment "LOYLY_GRADER_COMMAND")
                                     (:command builder))))
                  :image (str (fs/absolutize
                               (or (env environment "LOYLY_GRADER_IMAGE")
                                   (:image builder))))
                  :settings (str (fs/absolutize
                                  (or (env environment "LOYLY_GRADER_SETTINGS")
                                      (fs/path root ".pi/harness/config/pi.grader.settings.json"))))
                  :model (env environment "LOYLY_GRADER_MODEL")
                  :command-sha256 (env environment "LOYLY_GRADER_COMMAND_SHA256")
                  :image-sha256 (env environment "LOYLY_GRADER_IMAGE_SHA256")
                  :settings-sha256 (env environment "LOYLY_GRADER_SETTINGS_SHA256")
                  :instruction-sha256 (env environment "LOYLY_GRADER_INSTRUCTION_SHA256")
                  :instruction-file (or (env environment "LOYLY_GRADER_INSTRUCTION_FILE")
                                        "grader-instruction-01.md")
                  :schema-sha256 (env environment "LOYLY_GRADER_SCHEMA_SHA256")}]
      (when (or (= (:model grader) (:model builder))
                (not (re-matches #"[A-Za-z0-9._-]+\.md" (:instruction-file grader)))
                (some #(nil? (re-matches HASH64 (str %)))
                      [(:command-sha256 grader) (:image-sha256 grader)
                       (:settings-sha256 grader) (:instruction-sha256 grader)
                       (:schema-sha256 grader)]))
        (throw (ex-info
                "independent grader needs another model and approved command, image, settings, schema and instruction digests"
                {})))
      grader)))

(defn- parse-blind [root environment live? builder]
  (when (and live? (env environment "LOYLY_BLIND_AGENT_MODEL"))
    (let [blind {:command (str (fs/absolutize
                                (or (env environment "LOYLY_BLIND_AGENT_COMMAND")
                                    (:command builder))))
                 :image (str (fs/absolutize
                              (or (env environment "LOYLY_BLIND_AGENT_IMAGE")
                                  (:image builder))))
                 :settings (str (fs/absolutize
                                 (or (env environment "LOYLY_BLIND_AGENT_SETTINGS")
                                     (fs/path root ".pi/harness/config/pi.blind-review.settings.json"))))
                 :model (env environment "LOYLY_BLIND_AGENT_MODEL")
                 :command-sha256 (env environment "LOYLY_BLIND_AGENT_COMMAND_SHA256")
                 :image-sha256 (env environment "LOYLY_BLIND_AGENT_IMAGE_SHA256")
                 :settings-sha256 (env environment "LOYLY_BLIND_AGENT_SETTINGS_SHA256")
                 :instruction-sha256 (env environment "LOYLY_BLIND_AGENT_INSTRUCTION_SHA256")
                 :instruction-file (or (env environment "LOYLY_BLIND_AGENT_INSTRUCTION_FILE")
                                       "blind-agent-instruction.md")}]
      (require-digests
       [(:command-sha256 blind) (:image-sha256 blind)
        (:settings-sha256 blind) (:instruction-sha256 blind)]
       "blind agent needs approved command, image, settings and instruction digests")
      blind)))

(defn- parse-panel [environment live?]
  (let [panel (when (and live? (env environment "LOYLY_PANEL_IMAGE"))
                {:image (str (fs/absolutize (env environment "LOYLY_PANEL_IMAGE")))
                 :plan-file (or (env environment "LOYLY_PANEL_PLAN_FILE") loyly/DEFAULT_PANEL_PLAN)
                 :plan-sha256 (env environment "LOYLY_PANEL_PLAN_SHA256")
                 :image-sha256 (env environment "LOYLY_PANEL_IMAGE_SHA256")})]
    (when (and live? (= (env environment "LOYLY_PANEL_REQUIRED") "1") (nil? panel))
      (throw (ex-info "production live cycle requires the approved grading panel" {})))
    (when panel
      (require-digests
       [(:plan-sha256 panel) (:image-sha256 panel)]
       "grading panel needs approved plan and image manifest digests")
      (when-not (re-matches #"[a-z][a-z0-9-]*\.panel\.json" (:plan-file panel))
        (throw (ex-info "grading panel plan file must be a local named plan" {}))))
    panel))

(defn parse-worker-config
  [root scratch mode-arg environment]
  (let [approved-commit (env environment "LOYLY_APPROVED_COMMIT")
        _ (when (and approved-commit (not (re-matches HASH40 approved-commit)))
            (throw (ex-info "LOYLY_APPROVED_COMMIT must be a full 40-character commit ID" {})))
        approved-checklist (env environment "LOYLY_APPROVED_CHECKLIST_SHA256")
        _ (when (and approved-commit (not (re-matches HASH64 (str approved-checklist))))
            (throw (ex-info "a pinned cut needs LOYLY_APPROVED_CHECKLIST_SHA256" {})))
        cut (str (fs/path scratch "cut"))
        source-root (if approved-commit (str (fs/path cut "project")) (str root))
        approved-source (if-let [repo (env environment "LOYLY_SOURCE_REPO")]
                          (str (fs/absolutize repo))
                          (str root))
        mode (or mode-arg "repair")
        live? (= mode "live")
        builder (parse-builder root environment live?)
        grader (parse-grader root environment live? builder)
        grader-shards (Long/parseLong (str (or (env environment "LOYLY_GRADER_SHARDS") "3")))
        _ (when (and live? (or (not (integer? grader-shards))
                               (< grader-shards 1)
                               (> grader-shards 16)))
            (throw (ex-info "LOYLY_GRADER_SHARDS must be an integer from 1 to 16" {})))
        blind (parse-blind root environment live? builder)
        blind-required (and live? (not= (env environment "LOYLY_BLIND_REQUIRED") "0"))
        project (or (env environment "HARNESS_PROJECT_ID") loyly/PROJECT_ID)
        _ (when-not (re-matches #"[a-z][a-z0-9-]*" project)
            (throw (ex-info "invalid harness project" {})))
        panel (parse-panel environment live?)]
    {:approved-commit approved-commit
     :approved-checklist-sha256 approved-checklist
     :cut cut
     :source-root source-root
     :approved-source-repo approved-source
     :mode mode
     :live live?
     :builder builder
     :grader grader
     :grader-shard-count grader-shards
     :blind-agent blind
     :blind-required blind-required
     :project project
     :panel panel}))
