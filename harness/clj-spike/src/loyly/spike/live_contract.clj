(ns loyly.spike.live-contract
  "PoC port of pure helpers from harness/pi-durable/live-contract.ts.
  Full Ajv schema compile is deferred; callers pass already-shaped maps."
  (:require [babashka.fs :as fs]
            [babashka.process :as p]
            [clojure.string :as str]
            [loyly.spike.digest :as d]
            [loyly.spike.evidence.validate-schema :as schema]
            [loyly.spike.gen-checklist :as checklist]
            [loyly.spike.hjson :as hjson]
            [loyly.spike.panel-selection :as panel]
            [loyly.spike.panel-vm :as panel-vm]
            [loyly.spike.project.loyly :as loyly]))

(def SPEC-PATH-RE #"^docs/plan/\d\d-[a-z][a-z0-9-]*/spec\.feature$")

(defn- require-hash [path expected]
  (let [actual (d/file-sha256 path)]
    (when-not (= actual expected)
      (throw (ex-info (str "digest changed: " path " (" actual ")")
                      {:path path :actual actual :expected expected})))))

(defn- path-in-source [repo relative]
  (when (or (fs/absolute? (fs/path relative))
            (some #{".."} (str/split relative #"[\\/]")))
    (throw (ex-info "spec_file must stay inside the pinned source cut" {:relative relative})))
  (fs/file repo relative))

(defn verify-selected-specs
  "Port of verifySelectedSpecs(repo, source, checklist?)."
  ([repo source] (verify-selected-specs repo source nil))
  ([repo source checklist]
   (let [selected (or (get source "specs")
                      [{"file" (get source "spec_file")
                        "sha256" (get source "spec_sha256")}])
         paths (mapv #(get % "file") selected)]
     (when (or (not= (count (set paths)) (count paths))
               (some #(nil? (re-matches SPEC-PATH-RE %)) paths))
       (throw (ex-info "approved specs must uniquely name numbered product plans" {})))
     (doseq [spec selected]
       (require-hash (path-in-source repo (get spec "file")) (get spec "sha256")))
     (when checklist
       (let [actual (->> (get checklist "items")
                         (map (fn [item]
                                (let [m (re-matches
                                         #"^(docs/plan/\d\d-[a-z][a-z0-9-]*/spec\.feature):\d+$"
                                         (or (get item "source") ""))]
                                  (when-not m
                                    (throw (ex-info
                                            (str "checklist item has no numbered product spec source: "
                                                 (get item "id"))
                                            {:id (get item "id")})))
                                  (second m))))
                         set
                         sort
                         vec)
             expected (->> paths sort vec)]
         (when-not (= (hjson/compact-json expected) (hjson/compact-json actual))
           (throw (ex-info "approved spec files do not exactly cover the derived checklist" {})))))
     selected)))

(defn- verify-image
  "Port of verifyImage(image, expectedManifestSha256)."
  [image expected-manifest-sha256]
  (let [manifest-file (fs/file image "manifest.json")]
    (require-hash manifest-file expected-manifest-sha256)
    (let [manifest (hjson/read-json (slurp manifest-file :encoding "UTF-8"))
          assets (or (get manifest "assets") {})
          checksums (or (get manifest "checksums") {})]
      (doseq [[kind name] assets]
        (let [expected (get checksums kind)]
          (when-not (and (string? expected) (re-matches #"[0-9a-f]{64}" expected))
            (throw (ex-info (str "image asset " kind " has no checksum") {:kind kind})))
          (require-hash (fs/file image name) expected))))))

(defn derive-approved-checklist
  "Port of deriveApprovedChecklist without panel VM worker probe."
  [{:keys [config source scratch]}]
  (fs/create-dirs scratch)
  (let [checklist-path (fs/file scratch "approved-checklist.json")]
    (when-not (fs/regular-file? checklist-path)
      (try
        (checklist/generate {:root source :out (str checklist-path)})
        (catch Exception e
          (throw (ex-info (str "checklist derivation failed: " (.getMessage e))
                          {:cause e})))))
    (require-hash checklist-path (get-in config ["source" "checklist_sha256"]))
    (let [selected (hjson/read-json (slurp checklist-path :encoding "UTF-8"))]
      (when (and (= (get config "schema") "harness.pi-live-run.v2")
                 (loyly/requires-blind-handoff
                  (or (get config "project") loyly/PROJECT_ID)
                  (get selected "items")))
        (throw (ex-info
                (str "selected " loyly/PROJECT_ID " refusal item " loyly/BLIND_ITEM_ID
                     " requires the v1 blind-review contract")
                {})))
      (verify-selected-specs source (get config "source") selected)
      selected)))

(defn verify-pinned-image
  "Public pin check for a builder/grader/panel image tree."
  [image expected-manifest-sha256]
  (verify-image image expected-manifest-sha256))

(defn- git-at [path & args]
  (let [{:keys [exit out err]}
        @(p/process (into ["git" "-C" path] args) {:out :string :err :string})]
    (when (pos? exit)
      (throw (ex-info (str "git failed at " path) {:err err :exit exit})))
    (str/trim out)))

(defn verify-pinned-agents
  "Pin-check builder/grader/blind commands, images and instructions."
  [config & {:keys [pi-durable]
             :or {pi-durable "harness/pi-durable"}}]
  (when (and (= (get config "schema") "loyly.pi-live-run.v1")
             (or (get-in config ["builder" "instruction_file"])
                 (get-in config ["blind" "instruction_file"])))
    (throw (ex-info "only the grader selects a separate instruction file in v1" {})))
  (let [here (fs/file pi-durable)
        agents (cond-> [[(get config "builder") "builder-instruction.md"]
                        [(get config "grader") (or (get-in config ["grader" "instruction_file"])
                                                   "grader-instruction-01.md")]]
                (get config "blind")
                (conj [(get config "blind")
                       (or (get-in config ["blind" "instruction_file"])
                           "blind-agent-instruction.md")]))
        checked-images (atom #{})]
    (doseq [[agent instruction] agents]
      (require-hash (fs/file (get agent "command")) (get agent "command_sha256"))
      (let [image (str (fs/absolutize (get agent "image")))
            image-key (str image ":" (get agent "image_sha256"))]
        (when-not (contains? @checked-images image-key)
          (verify-image image (get agent "image_sha256"))
          (swap! checked-images conj image-key)))
      (require-hash (fs/file here instruction) (get agent "instruction_sha256"))
      (when-let [settings (get agent "settings")]
        (require-hash (fs/file settings) (get agent "settings_sha256"))))
    (when (= (get-in config ["builder" "model"]) (get-in config ["grader" "model"]))
      (throw (ex-info "builder and black-box grader must use different models" {})))
    (require-hash (fs/file here "../evidence-core/allure-lifecycle-result.schema.json")
                  (get-in config ["grader" "schema_sha256"]))
    (when-let [panel-cfg (get config "panel")]
      (require-hash (fs/file here (or (get panel-cfg "plan_file") loyly/DEFAULT_PANEL_PLAN))
                    (get panel-cfg "plan_sha256"))
      (verify-image (get panel-cfg "image") (get panel-cfg "image_sha256")))))

(defn- derive-approved-checklist-full
  [{:keys [config source scratch pi-durable]
    :or {pi-durable "harness/pi-durable"}}]
  (let [selected (derive-approved-checklist {:config config :source source :scratch scratch})]
    (when-let [panel-cfg (get config "panel")]
      (let [here (fs/file pi-durable)
            plan-path (fs/file here (or (get panel-cfg "plan_file") loyly/DEFAULT_PANEL_PLAN))
            plan (hjson/read-json (slurp plan-path :encoding "UTF-8"))]
        (when (and (= (get config "schema") "harness.pi-live-run.v2")
                   (or (not= (get plan "schema") "harness.grading-panel-plan.v2")
                       (not= (get plan "project") (get config "project"))))
          (throw (ex-info "panel plan project differs from the live contract" {})))
        (panel/validate-panel-selection plan selected)
        (panel-vm/specialist-workers plan (str here))))
    selected))

(defn check-live-run
  "Structural live-run validation without Ajv compile (injectable `:root` for git pins)."
  [input & {:keys [make-checklist root pi-durable]
            :or {make-checklist true
                 root "."
                 pi-durable "harness/pi-durable"}}]
  (let [config ((schema/compile-schema :live-run nil) input "live run")
        source (str (fs/absolutize (get-in config ["source" "repo"])))
        scratch (str (fs/absolutize (get config "scratch")))
        repo-root (str (fs/absolutize root))]
    (when (or (= source repo-root) (= scratch source) (str/starts-with? scratch (str source "/")))
      (throw (ex-info "source, controller and output must be separate" {})))
    (when (or (not= (git-at repo-root "rev-parse" "HEAD") (get config "controller_commit"))
              (not= (git-at source "rev-parse" "HEAD") (get-in config ["source" "commit"]))
              (not (str/blank? (git-at repo-root "status" "--porcelain")))
              (not (str/blank? (git-at source "status" "--porcelain"))))
      (throw (ex-info "controller or source is dirty or differs from the approved commit" {})))
    (verify-selected-specs source (get config "source"))
    (verify-pinned-agents config :pi-durable pi-durable)
    (when make-checklist
      (derive-approved-checklist-full {:config config :source source :scratch scratch
                                       :pi-durable pi-durable}))
    {:source source :scratch scratch :config config}))
