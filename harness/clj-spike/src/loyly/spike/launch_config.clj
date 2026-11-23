(ns loyly.spike.launch-config
  "PoC port of harness/pi-durable/launch-config.ts"
  (:require [clojure.string :as str]
            [loyly.spike.project.loyly.identity :as id]))

(defn worker-environment
  "Build the approved LOYLY_* env map from a validated live run.
  `validated` is {:config … :source …}; `inherited` is a string-keyed env map."
  [{:keys [config source]} inherited]
  (let [inherited-clean
        (into {}
              (remove (fn [[k _]]
                        (or (str/starts-with? (name k) "LOYLY_")
                            (= (name k) "HARNESS_PROJECT_ID")))
                      inherited))
        path (let [java-home (or (get inherited "JAVA_HOME") (get inherited :JAVA_HOME))
                   base (or (get inherited "PATH") (get inherited :PATH) "")]
               (if java-home (str java-home "/bin:" base) base))
        schema (get config "schema")
        builder (get config "builder")
        grader (get config "grader")
        blind (get config "blind")
        panel (get config "panel")
        base {"PATH" path
              "LOYLY_RUN_ID" (get config "run_id")
              "LOYLY_SCORE_CYCLE" (or (get config "score_cycle") "02")
              "LOYLY_SOURCE_REPO" source
              "LOYLY_APPROVED_COMMIT" (get-in config ["source" "commit"])
              "LOYLY_APPROVED_CHECKLIST_SHA256" (get-in config ["source" "checklist_sha256"])
              "LOYLY_BUILDER_COMMAND" (get builder "command")
              "LOYLY_BUILDER_COMMAND_SHA256" (get builder "command_sha256")
              "LOYLY_BUILDER_IMAGE" (get builder "image")
              "LOYLY_BUILDER_IMAGE_SHA256" (get builder "image_sha256")
              "LOYLY_BUILDER_MODEL" (get builder "model")
              "LOYLY_BUILDER_INSTRUCTION_SHA256" (get builder "instruction_sha256")
              "LOYLY_BUILDER_INSTRUCTION_FILE" (or (get builder "instruction_file")
                                                   "builder-instruction.md")
              "LOYLY_GRADER_COMMAND" (get grader "command")
              "LOYLY_GRADER_COMMAND_SHA256" (get grader "command_sha256")
              "LOYLY_GRADER_IMAGE" (get grader "image")
              "LOYLY_GRADER_IMAGE_SHA256" (get grader "image_sha256")
              "LOYLY_GRADER_MODEL" (get grader "model")
              "LOYLY_GRADER_SETTINGS" (get grader "settings")
              "LOYLY_GRADER_SETTINGS_SHA256" (get grader "settings_sha256")
              "LOYLY_GRADER_INSTRUCTION_SHA256" (get grader "instruction_sha256")
              "LOYLY_GRADER_INSTRUCTION_FILE" (or (get grader "instruction_file")
                                                  "grader-instruction-01.md")
              "LOYLY_GRADER_SCHEMA_SHA256" (get grader "schema_sha256")
              "LOYLY_GRADER_SHARDS" (str (get grader "shards"))
              "LOYLY_BLIND_REQUIRED" (if (or (= schema "loyly.pi-live-run.v1") blind) "1" "0")
              "LOYLY_PANEL_REQUIRED" (if (= schema "loyly.pi-live-run.v1") "1" "0")}]
    (cond-> (merge inherited-clean base)
      (get config "project") (assoc "HARNESS_PROJECT_ID" (get config "project"))
      blind (merge {"LOYLY_BLIND_AGENT_COMMAND" (get blind "command")
                    "LOYLY_BLIND_AGENT_COMMAND_SHA256" (get blind "command_sha256")
                    "LOYLY_BLIND_AGENT_IMAGE" (get blind "image")
                    "LOYLY_BLIND_AGENT_IMAGE_SHA256" (get blind "image_sha256")
                    "LOYLY_BLIND_AGENT_MODEL" (get blind "model")
                    "LOYLY_BLIND_AGENT_SETTINGS" (get blind "settings")
                    "LOYLY_BLIND_AGENT_SETTINGS_SHA256" (get blind "settings_sha256")
                    "LOYLY_BLIND_AGENT_INSTRUCTION_SHA256" (get blind "instruction_sha256")
                    "LOYLY_BLIND_AGENT_INSTRUCTION_FILE"
                    (or (get blind "instruction_file") "blind-agent-instruction.md")})
      panel (merge {"LOYLY_PANEL_IMAGE" (get panel "image")
                    "LOYLY_PANEL_IMAGE_SHA256" (get panel "image_sha256")
                    "LOYLY_PANEL_PLAN_SHA256" (get panel "plan_sha256")
                    "LOYLY_PANEL_PLAN_FILE" (or (get panel "plan_file")
                                               id/DEFAULT_PANEL_PLAN)}))))
