(ns loyly.spec-check
  "Executable Gherkin spec runner for harness/specs/cycle.spec.feature and
   harness/project/loyly/cycle.spec.feature.

   Enforces strict 1-to-1 bidirectional tag coverage and executes every
   @cycle-*, @formal-*, @loyly-cycle-*, and @loyly-formal-* scenario against
   the real loyly.* and loyly.formal.* modules."
  (:require [babashka.fs :as fs]
            [babashka.process :as p]
            [clojure.set :as set]
            [clojure.string :as str]
            [loyly.builder-host :as builder-host]
            [loyly.digest :as d]
            [loyly.formal.cycle :as formal-cycle]
            [loyly.formal.main :as formal-main]
            [loyly.formal.models :as models]
            [loyly.formal.props :as props]
            [loyly.formal.theory :as theory]
            [loyly.formal.trace :as trace]
            [loyly.gen-checklist :as checklist]
            [loyly.hjson :as hjson]
            [loyly.live-contract :as live]
            [loyly.panel-compile :as panel-compile]
            [loyly.project.loyly :as loyly]
            [loyly.reassess-panel :as reassess]
            [loyly.render-allure :as render-allure]
            [loyly.replay-export :as replay-export]
            [loyly.score :as score]
            [loyly.score-receipt :as receipt]))

(def ^:private TAG-RE #"^@(cycle-\d+|formal-\d+|loyly-cycle-\d+|loyly-formal-\d+)$")
(def ^:private SCENARIO-RE #"^\s*Scenario(?: Outline)?:\s*(.+?)\s*$")

(defn- default-repo []
  (let [cwd (str (fs/cwd))
        candidate (fs/path cwd ".." "..")]
    (if (fs/directory? (fs/path candidate "harness"))
      (str (fs/absolutize candidate))
      (str (fs/absolutize (fs/path cwd ".." ".." ".."))))))

(defn- parse-feature-scenarios
  "Extract tagged scenarios from a Gherkin .feature file."
  [repo rel-path]
  (let [full (fs/path repo rel-path)
        _ (when-not (fs/regular-file? full)
            (throw (ex-info (str "missing feature file: " rel-path) {:path (str full)})))
        lines (str/split-lines (slurp (str full) :encoding "UTF-8"))]
    (loop [idx 0
           pending-tags []
           acc []]
      (if (>= idx (count lines))
        acc
        (let [line (nth lines idx)
              trimmed (str/trim line)]
          (cond
            (str/starts-with? trimmed "@")
            (let [tags (->> (str/split trimmed #"\s+")
                            (filter #(re-matches TAG-RE %))
                            vec)]
              (recur (inc idx) (into pending-tags tags) acc))

            (re-matches SCENARIO-RE line)
            (let [title (second (re-matches SCENARIO-RE line))]
              (when (empty? pending-tags)
                (throw (ex-info (str "unstamped scenario in " rel-path ":" (inc idx) ": " title)
                                {:file rel-path :line (inc idx)})))
              (recur (inc idx)
                     []
                     (into acc
                           (map (fn [t]
                                  {:tag t
                                   :scenario title
                                   :file rel-path
                                   :line (inc idx)})
                                pending-tags))))

            (or (str/blank? trimmed) (str/starts-with? trimmed "#"))
            (recur (inc idx) pending-tags acc)

            :else
            (recur (inc idx) [] acc)))))))

(defn- with-temp-dir [f]
  (let [tmp (fs/create-temp-dir {:prefix "loyly-spec-"})]
    (try
      (f (str tmp))
      (finally
        (fs/delete-tree tmp)))))

(defn- git! [dir & args]
  (let [{:keys [exit out err]}
        @(p/process (into ["git" "-C" (str dir)] args)
                    {:out :string :err :string})]
    (when-not (zero? exit)
      (throw (ex-info (str "git failed: " (str/join " " args) " -> " err)
                      {:dir dir :args args :exit exit :err err})))
    (str/trim out)))

(defn- write-file! [path content]
  (fs/create-dirs (fs/parent path))
  (spit (str path) content :encoding "UTF-8")
  (str path))

(defn- init-git-repo! [dir files-map]
  (fs/create-dirs dir)
  (git! dir "init" "-q")
  (git! dir "config" "user.name" "Loyly Spec")
  (git! dir "config" "user.email" "spec@loyly.test")
  (doseq [[rel content] files-map]
    (write-file! (fs/path dir rel) content))
  (git! dir "add" "-A")
  (git! dir "commit" "-q" "-m" "fixture")
  (git! dir "rev-parse" "HEAD"))

(defn- assert! [pred msg]
  (when-not pred
    (throw (ex-info (str "assertion failed: " msg) {}))))

(defn- assert-throws! [f pattern msg]
  (let [thrown (try
                 (f)
                 nil
                 (catch Exception e e))]
    (when-not thrown
      (throw (ex-info (str "expected failure (" msg ") but succeeded") {})))
    (let [m (or (ex-message thrown) (str thrown))]
      (when (and pattern (not (re-find pattern m)))
        (throw (ex-info (str "unexpected error message for " msg ": " m)
                        {:expected pattern :actual m}))))
    thrown))

(defn- make-pinned-live-fixture!
  "Build isolated clean controller + source git repos and a valid live-run v1 contract."
  [tmp repo]
  (let [pi-durable (str (fs/path repo "harness" "pi-durable"))
        spec-rel (str "docs/plan/" loyly/BOOKING_SLICE "/spec.feature")
        spec-src (slurp (str (fs/path repo spec-rel)) :encoding "UTF-8")
        controller (str (fs/path tmp "controller"))
        source (str (fs/path tmp "source"))
        scratch (str (fs/path tmp "scratch"))
        image (str (fs/path tmp "image"))
        wrapper (write-file! (fs/path tmp "bin" "wrapper.sh") "#!/bin/sh\nexit 0\n")
        settings (write-file! (fs/path tmp "settings.json") "{}\n")
        kernel (write-file! (fs/path image "vmlinux") "dummy-kernel\n")
        manifest-content (hjson/compact-json
                          {"assets" {"kernel" "vmlinux"}
                           "checksums" {"kernel" (d/file-sha256 kernel)}})
        manifest (write-file! (fs/path image "manifest.json") (str manifest-content "\n"))
        controller-head (init-git-repo! controller {"README.md" "controller\n"})
        source-head (init-git-repo! source {spec-rel spec-src})
        checklist-tmp (str (fs/path tmp "derived-checklist.json"))
        _ (checklist/generate {:root source :out checklist-tmp})
        checklist-sha (d/file-sha256 checklist-tmp)
        spec-sha (d/file-sha256 (str (fs/path source spec-rel)))
        wrapper-sha (d/file-sha256 wrapper)
        settings-sha (d/file-sha256 settings)
        image-sha (d/file-sha256 manifest)
        builder-instr-sha (d/file-sha256 (str (fs/path pi-durable "builder-instruction.md")))
        grader-instr-sha (d/file-sha256 (str (fs/path pi-durable "grader-instruction-01.md")))
        blind-instr-sha (d/file-sha256 (str (fs/path pi-durable "blind-agent-instruction.md")))
        schema-sha (d/file-sha256 (str (fs/path pi-durable "allure-lifecycle-result.schema.json")))
        panel-plan-sha (d/file-sha256 (str (fs/path pi-durable loyly/DEFAULT_PANEL_PLAN)))
        config {"schema" "loyly.pi-live-run.v1"
                "run_id" "spec-check-01"
                "score_cycle" "02"
                "controller_commit" controller-head
                "source" {"repo" source
                          "commit" source-head
                          "checklist_sha256" checklist-sha
                          "specs" [{"file" spec-rel "sha256" spec-sha}]}
                "scratch" scratch
                "builder" {"command" wrapper
                           "command_sha256" wrapper-sha
                           "image" image
                           "image_sha256" image-sha
                           "model" "openai-codex/builder-test"
                           "instruction_sha256" builder-instr-sha}
                "grader" {"command" wrapper
                          "command_sha256" wrapper-sha
                          "image" image
                          "image_sha256" image-sha
                          "model" "anthropic/grader-test"
                          "instruction_sha256" grader-instr-sha
                          "settings" settings
                          "settings_sha256" settings-sha
                          "schema_sha256" schema-sha
                          "shards" 2}
                "blind" {"command" wrapper
                         "command_sha256" wrapper-sha
                         "image" image
                         "image_sha256" image-sha
                         "model" "anthropic/blind-test"
                         "instruction_sha256" blind-instr-sha
                         "settings" settings
                         "settings_sha256" settings-sha}
                "panel" {"image" image
                         "image_sha256" image-sha
                         "plan_file" loyly/DEFAULT_PANEL_PLAN
                         "plan_sha256" panel-plan-sha}}]
    {:controller controller
     :source source
     :scratch scratch
     :pi-durable pi-durable
     :config config}))

;;; --- Executable scenario checks --------------------------------------------

(defn- check-cycle-001 [repo]
  (with-temp-dir
    (fn [tmp]
      (let [{:keys [controller pi-durable config]} (make-pinned-live-fixture! tmp repo)
            res (live/check-live-run config :root controller :pi-durable pi-durable)]
        (assert! (= (:config res) config) "check-live-run returns verified config")))))

(defn- check-cycle-002 [repo]
  (with-temp-dir
    (fn [tmp]
      (let [{:keys [controller pi-durable config]} (make-pinned-live-fixture! tmp repo)
            bad-commit (assoc config "controller_commit" (apply str (repeat 40 "0")))]
        (assert-throws!
         #(live/check-live-run bad-commit :root controller :pi-durable pi-durable)
         #"dirty or differs"
         "mismatched controller commit")
        (write-file! (fs/path controller "dirty.txt") "uncommitted\n")
        (assert-throws!
         #(live/check-live-run config :root controller :pi-durable pi-durable)
         #"dirty or differs"
         "dirty controller working tree")))))

(defn- check-cycle-003 [repo]
  (with-temp-dir
    (fn [tmp]
      (let [{:keys [controller source pi-durable config]} (make-pinned-live-fixture! tmp repo)
            inside-source (assoc config "scratch" (str (fs/path source "nested-scratch")))
            same-root (assoc-in config ["source" "repo"] controller)]
        (assert-throws!
         #(live/check-live-run inside-source :root controller :pi-durable pi-durable)
         #"separate"
         "scratch inside source")
        (assert-throws!
         #(live/check-live-run same-root :root controller :pi-durable pi-durable)
         #"separate"
         "source equals controller root")))))

(defn- check-cycle-004 [repo]
  (with-temp-dir
    (fn [tmp]
      (let [{:keys [controller pi-durable config]} (make-pinned-live-fixture! tmp repo)
            same-model (assoc-in config ["grader" "model"] (get-in config ["builder" "model"]))]
        (assert-throws!
         #(live/check-live-run same-model :root controller :pi-durable pi-durable)
         #"different models"
         "builder and grader share model")))))

(defn- check-cycle-005 [repo]
  (with-temp-dir
    (fn [tmp]
      (let [{:keys [controller pi-durable config]} (make-pinned-live-fixture! tmp repo)
            v2 (-> config
                   (dissoc "blind" "panel")
                   (assoc "schema" "harness.pi-live-run.v2"
                          "project" loyly/PROJECT_ID))]
        (assert-throws!
         #(live/check-live-run v2 :root controller :pi-durable pi-durable)
         #"blind-review contract"
         "v2 contract missing blind agent for project requiring blind handoff")))))

(defn- check-cycle-006 [_repo]
  (let [p (formal-cycle/path)
        i-blind (.indexOf p "blind-review")
        i-score (.indexOf p "score")
        i-panel (.indexOf p "panel")]
    (assert! (and (>= i-blind 0) (< i-blind i-score)) "blind-review precedes score")
    (assert! (and (>= i-panel 0) (< i-score i-panel)) "panel follows score")
    (assert! (= #{"done"} formal-cycle/F) "done is the only terminal phase")))

(defn- check-cycle-007 [_repo]
  (with-temp-dir
    (fn [tmp]
      (let [verdicts-file (write-file! (fs/path tmp "final-verdicts.json")
                                       (hjson/compact-json [{"id" "01-001" "verdict" "pass" "evidence" "ok"}]))
            before-sha (d/file-sha256 verdicts-file)
            summary (panel-compile/build-panel-summary-shape
                     {:candidate-sha256 (d/sha256-string "cand")
                      :plan-sha256 (d/sha256-string "plan")
                      :original-score-sha256 before-sha
                      :evaluation {:panel-outcome "not-ready"
                                   :gaps ["runtime-gap"]
                                   :checks [{"id" "check-1"}]
                                   :items ["01-001"]}})
            report (models/generate :panel-report :seed 1)]
        (assert! (= "not-ready" (get summary "panel_outcome")) "not-ready outcome recorded")
        (assert! (= before-sha (get summary "original_score_sha256")) "summary binds original score digest")
        (assert! (true? (get report "original_score_unchanged")) "panel report records original_score_unchanged=true")
        (assert! (= before-sha (d/file-sha256 verdicts-file)) "filed verdicts unchanged on disk")))))

(defn- check-cycle-008 [_repo]
  (with-temp-dir
    (fn [tmp]
      (let [instrument (str (fs/path tmp "instrument"))
            scratch (str (fs/path tmp "scratch"))
            _ (fs/create-dirs scratch)
            head (init-git-repo! instrument {"README.md" "inst\n"})
            cl-path (write-file! (fs/path scratch "checklist.json")
                                 (hjson/write {"items" [{"id" "01-001" "name" "a" "rule" "R" "source" "s:1"}]
                                               "counts" {"total" 1}}))
            inst-cl (write-file! (fs/path instrument "harness" "cycles" "02" "checklist.json")
                                 (slurp cl-path))
            v-path (write-file! (fs/path scratch "verdicts.json")
                                (hjson/compact-json [{"id" "01-001" "verdict" "pass" "evidence" "ok"}]))
            _ (write-file! (fs/path scratch "score-input.json")
                           (hjson/compact-json {"schema" "loyly.score-input.v1"
                                                "source_commit" head
                                                "candidate_sha256" (d/sha256-string "cand")
                                                "checklist_sha256" (d/sha256-string "wrong-checklist")
                                                "verdicts_sha256" (d/file-sha256 v-path)}))]
        (assert! (fs/regular-file? inst-cl) "instrument checklist present")
        (assert-throws!
         #(receipt/verify-scored-cycle {:scratch scratch
                                        :instrument instrument
                                        :verdicts-file v-path
                                        :cycle "02"})
         #"differ from the bound"
         "mismatched checklist digest refuses")
        (assert! (not (fs/exists? (fs/path instrument "harness" "cycles" "02" "scores.json")))
                 "no score record written on refusal")
        ;; Also verify score tool refuses unknown id without writing scores.json
        (let [bad-v (write-file! (fs/path scratch "bad-verdicts.json")
                                 (hjson/compact-json [{"id" "99-999" "verdict" "pass" "evidence" "x"}]))]
          (with-redefs [hjson/refuse (fn [msg] (throw (ex-info msg {:refused true})))]
            (assert-throws!
             #(score/score-cycle {:root instrument :cycle "02" :verdicts-path bad-v})
             #"not on the checklist"
             "score refuses unknown id"))
          (assert! (not (fs/exists? (fs/path instrument "harness" "cycles" "02" "scores.json")))
                   "no scores.json created on refusal"))))))

(defn- check-cycle-009 [repo]
  (with-temp-dir
    (fn [tmp]
      (let [{:keys [controller scratch pi-durable config]} (make-pinned-live-fixture! tmp repo)]
        (live/check-live-run config :root controller :pi-durable pi-durable :make-checklist false)
        (assert! (not (fs/exists? (fs/path scratch "pi-audit.sqlite"))) "no worker audit db created")
        (assert! (not (fs/exists? (fs/path scratch "score-input.json"))) "no score input written")))))

(defn- check-cycle-010 [repo]
  (with-temp-dir
    (fn [tmp]
      (assert-throws!
       #(reassess/check-reassessment {"schema" "loyly.pi-panel-reassessment.v1"}
                                     {:root repo})
       #"fully pinned"
       "unpinned reassessment contract refused")
      (let [hex40 (apply str (repeat 40 "a"))
            hex64 (apply str (repeat 64 "b"))
            outside-cfg {"schema" "loyly.pi-panel-reassessment.v1"
                         "controller_commit" hex40
                         "source_commit" hex40
                         "candidate_sha256" hex64
                         "score_sha256" hex64
                         "plan_sha256" hex64
                         "image_sha256" hex64
                         "original" (str (fs/path tmp "orig"))
                         "out" (str (fs/path tmp "outside"))
                         "image" (str (fs/path tmp "image"))}]
        (assert-throws!
         #(reassess/check-reassessment outside-cfg {:root repo})
         #"private directory in the original scratch"
         "output outside original scratch refused")))))

(defn- check-cycle-011 [_repo]
  (with-temp-dir
    (fn [tmp]
      (let [out (str (fs/path tmp "reassess"))
            vm-dir (str (fs/path tmp "vm"))
            report-dir (str (fs/path tmp "report"))
            _ (fs/create-dirs out)
            _ (write-file! (fs/path vm-dir "manifest.json") "{\"ok\":true}\n")
            _ (write-file! (fs/path report-dir "panel-manifest.json") "{\"ok\":true}\n")
            hex40 (apply str (repeat 40 "a"))
            hex64 (apply str (repeat 64 "b"))
            base {:config {"controller_commit" hex40
                           "source_commit" hex40
                           "candidate_sha256" hex64
                           "plan_sha256" hex64}
                  :out out
                  :score {:score-sha256 hex64 :score "10/11"}
                  :input {"panel_manifest_sha256" hex64}
                  :vm-dir vm-dir
                  :vm-attempt 1
                  :report-dir report-dir
                  :report-attempt 1
                  :panel-outcome "ready"
                  :allure-cases 12}
            r (reassess/finalize-reassessment-receipt base)]
        (assert! (true? (get r "original_cycle_unchanged")) "original_cycle_unchanged is true")
        (assert! (= "loyly.pi-panel-reassessment-result.v1" (get r "schema")) "receipt schema")
        ;; Idempotent replay succeeds
        (reassess/finalize-reassessment-receipt base)
        ;; Conflicting rewrite fails
        (assert-throws!
         #(reassess/finalize-reassessment-receipt (assoc base :panel-outcome "not-ready"))
         #"receipt changed"
         "conflicting receipt rewrite refused")))))

(defn- check-cycle-012 [_repo]
  (assert! (= 1800 (builder-host/clamp-bash-timeout 30 1800 nil)) "below floor raised to floor")
  (assert! (nil? (builder-host/clamp-bash-timeout 2400 1800 nil)) "above floor with no ceiling unchanged")
  (assert! (= 3600 (builder-host/clamp-bash-timeout 9999 1800 3600)) "above ceiling capped")
  (assert! (= 1800 (builder-host/clamp-bash-timeout nil 1800 3600)) "nil timeout defaults to floor when ceiling set"))

(defn- check-cycle-013 [_repo]
  (assert! (= "/workspace/extra.txt" (builder-host/validate-image-additions-path "/workspace/extra.txt"))
           "valid workspace path accepted")
  (assert-throws!
   #(builder-host/validate-image-additions-path "/etc/passwd")
   #"inside /workspace"
   "outside /workspace rejected")
  (assert-throws!
   #(builder-host/validate-image-additions-path "/workspace/../escape")
   #"inside /workspace"
   "parent traversal rejected")
  (assert! (= {:memory "8G" :cpus 4}
              (builder-host/validate-vm-resources {"LOYLY_VM_MEMORY" "8G" "LOYLY_VM_CPUS" "4"}))
           "valid VM resources accepted")
  (assert-throws!
   #(builder-host/validate-vm-resources {"LOYLY_VM_MEMORY" "0G"})
   #"LOYLY_VM_MEMORY"
   "invalid VM memory rejected")
  (assert-throws!
   #(builder-host/validate-vm-resources {"LOYLY_VM_CPUS" "abc"})
   #"LOYLY_VM_CPUS"
   "invalid VM CPUs rejected"))

(defn- check-cycle-014 [_repo]
  (with-temp-dir
    (fn [tmp]
      (let [parent-ok (builder-host/save-conversation-receipt!
                       (str (fs/path tmp "parent-ok.json"))
                       {"store" "/s1.sqlite" "conversationId" 1 "lastEntryId" 7})
            parent-incomplete (builder-host/save-conversation-receipt!
                               (str (fs/path tmp "parent-incomplete.json"))
                               {"store" "/s1.sqlite" "conversationId" 1})
            fork-ok (builder-host/save-conversation-receipt!
                     (str (fs/path tmp "fork.json"))
                     {"store" "/s1.sqlite" "conversationId" 2
                      "parentConversationId" 1 "forkEntryId" 7})]
        ;; Valid fork lineage passes
        (builder-host/validate-existing-receipt! fork-ok "/s1.sqlite" parent-ok)
        ;; Mismatched store fails
        (assert-throws!
         #(builder-host/validate-existing-receipt! fork-ok "/other.sqlite" parent-ok)
         #"another store"
         "mismatched store refused")
        ;; Fork reopened without parent fails
        (assert-throws!
         #(builder-host/validate-existing-receipt! fork-ok "/s1.sqlite" nil)
         #"without its parent"
         "fork without parent refused")
        ;; Parent with no lastEntryId fails
        (assert-throws!
         #(builder-host/validate-parent-receipt! parent-incomplete "/s1.sqlite" fork-ok)
         #"no completed fork point"
         "parent without lastEntryId refused")))))

(defn- check-cycle-015 [_repo]
  (with-temp-dir
    (fn [tmp]
      (let [dir (str (fs/path tmp "steer"))]
        (write-file! (fs/path dir "02-second.md") "second")
        (write-file! (fs/path dir "01-first.md") "first")
        (write-file! (fs/path dir "03-done.md") "done")
        (write-file! (fs/path dir "03-done.steered") "ok")
        (write-file! (fs/path dir "04-refused.md") "no")
        (write-file! (fs/path dir "04-refused.refused") "no")
        (write-file! (fs/path dir "05-ignore.txt") "txt")
        (write-file! (fs/path dir "bad name.md") "bad")
        (let [items (builder-host/pending-steer-files dir)]
          (assert! (= ["01-first" "02-second"] (mapv :name items))
                   "only sorted unprocessed valid markdown files returned"))))))

(defn- check-cycle-016 [_repo]
  (with-temp-dir
    (fn [tmp]
      (let [d1 (str (fs/path tmp "run-fixture"))
            d2 (str (fs/path tmp "run-live"))
            d3 (str (fs/path tmp "run-refusal"))]
        (doseq [d [d1 d2 d3]] (fs/create-dirs d))
        (let [r1 (replay-export/export-run
                  d1
                  [{"seq" 1 "stage" "build" "outcome" "completed" "fixture" true "path" (str d1 "/work")}])
              r2 (replay-export/export-run
                  d2
                  [{"seq" 1 "stage" "build" "outcome" "completed" "model" "m/1" "path" (str d2 "/work")}])
              r3 (replay-export/export-run
                  d3
                  [{"seq" 1 "stage" "cut" "outcome" "refused"}])]
          (assert! (= "fixture evidence" (get r1 "provenance")) "fixture provenance")
          (assert! (= "live path" (get r2 "provenance")) "live provenance")
          (assert! (= "pre-agent refusal" (get r3 "provenance")) "pre-agent refusal provenance")
          (assert! (= "<scratch>/work" (get (first (get r1 "rows")) "path")) "scratch sanitized")
          (assert! (not (str/includes? (slurp (str (fs/path d1 "audit.v1.jsonl"))) d1))
                   "audit.v1.jsonl contains no host scratch path")
          (assert! (fs/regular-file? (fs/path d1 "evidence.v1.json")) "evidence.v1.json written"))))))

(defn- check-cycle-017 [repo]
  (with-temp-dir
    (fn [tmp]
      (let [scratch (str (fs/path tmp "scored"))
            fenced (str (fs/path scratch "fenced-room"))
            groom (str (fs/path scratch "grading-room"))]
        (write-file! (fs/path fenced "impl" "app.txt") "mutated-candidate\n")
        (write-file! (fs/path groom ".grading-room.json")
                     (hjson/compact-json {"blindReview" false}))
        (write-file! (fs/path scratch "score-input.json")
                     (hjson/compact-json {"schema" "loyly.score-input.v1"
                                          "candidate_sha256" (apply str (repeat 64 "0"))}))
        (assert-throws!
         #(render-allure/render-scored-allure
           scratch
           {:pi-durable (str (fs/path repo "harness" "pi-durable"))
            :audit-rows []})
         #"candidate differs"
         "drifted candidate refuses Allure render")
        (assert! (not (fs/exists? (fs/path scratch "allure-report" "loyly-report-manifest.json")))
                 "no report manifest written on refusal")))))

(defn- check-formal-001 [_repo]
  (let [t (theory/theory)
        inv-ids (mapv :id (:invariants t))]
    (assert! (= "loyly.formal-theory.v1" (:schema t)) "formal theory schema")
    (assert! (seq (:sorts t)) "sorts exported")
    (assert! (seq (:predicates t)) "predicates exported")
    (assert! (seq (:functions t)) "functions exported")
    (assert! (= (mapv #(keyword (str "I" %)) (range 1 14)) inv-ids) "invariants I1..I13 listed")))

(defn- check-formal-002 [_repo]
  (doseq [k (keys models/Registry)]
    (let [v (models/generate k :seed 1)]
      (assert! (models/valid? k v) (str "generated value valid for sort " k)))))

(defn- check-formal-003 [_repo]
  (let [h1 (d/sha256-string "loyly-spec")
        h2 (d/sha256-string "loyly-spec")]
    (assert! (= 64 (count h1)) "sha256 length 64")
    (assert! (boolean (re-matches #"[0-9a-f]{64}" h1)) "sha256 lowercase hex")
    (assert! (= h1 h2) "sha256 deterministic")
    (assert! (not (models/valid? :sha256 "not-a-hex-digest")) "non-hex rejected")))

(defn- check-formal-004 [_repo]
  (let [res (formal-cycle/prove-cycle!)]
    (assert! (= "prepare" (:q0 res)) "q0 is prepare")
    (assert! (= ["done"] (:F res)) "F is {done}")
    (assert! (= 8 (count (:path res))) "8 canonical phases")
    (assert! (= (count formal-cycle/Q) (count (:path res))) "path length |Q|")
    (assert! (= [:C1 :C2 :C3 :C4 :C5] (:invariants res)) "C1..C5 proved")))

(defn- check-formal-005 [_repo]
  (assert! (formal-cycle/I-labels-subset-registry) "C5 holds"))

(defn- check-formal-006 [_repo]
  (assert! (contains? (formal-cycle/labels "prepare") :live-run) "L(prepare) has :live-run")
  (assert! (set/subset? #{:score-input :verdicts} (formal-cycle/labels "score"))
           "L(score) has :score-input and :verdicts")
  (assert! (contains? (formal-cycle/labels "blind-review") :blind-packet)
           "L(blind-review) has :blind-packet")
  (assert! (set/subset? #{:panel-plan :panel-report} (formal-cycle/labels "panel"))
           "L(panel) has :panel-plan and :panel-report"))

(defn- check-formal-007 [repo]
  (let [pins (trace/pin-all-json-schemas! repo)
        by-file (into {} (map (juxt :file :sha256) pins))]
    (doseq [f ["panel-plan.schema.json"
               "panel-summary.schema.json"
               "live-run.schema.json"
               "allure-lifecycle-result.schema.json"]]
      (assert! (models/valid? :sha256 (get by-file f)) (str "schema pinned with sha256: " f)))))

(defn- check-formal-008 [repo]
  (let [proof (trace/prove-booking-panel! repo)]
    (assert! (true? (:ok proof)) "default panel plan proof ok")))

(defn- check-formal-009 [repo]
  (let [out (with-out-str (formal-main/-main "--root" repo))
        lines (str/split-lines (str/trim out))
        report (hjson/read-json (first lines))]
    (assert! (= "loyly.formal-run.v1" (get report "schema")) "formal-run schema")
    (assert! (true? (get report "ok")) "formal-run ok")
    (assert! (= "prepare" (first (get-in report ["cycle" "path"]))) "path starts at prepare")
    (assert! (= "done" (last (get-in report ["cycle" "path"]))) "path ends at done")
    (assert! (= (mapv #(str "I" %) (range 1 14)) (get report "invariants")) "I1..I13 reported")
    (assert! (= ["C1" "C2" "C3" "C4" "C5"] (get-in report ["cycle" "invariants"])) "C1..C5 reported")))

(defn- check-formal-010 [repo]
  (let [cert (trace/certificate repo)
        panel-file (get-in cert [:panel :file])]
    (assert! (not (str/includes? (str panel-file) "/impl/")) "panel plan not from impl/")
    (doseq [p (:json-schema-pins cert)]
      (let [full (str (fs/path repo "harness" "pi-durable" (:file p)))]
        (assert! (fs/regular-file? full) (str "schema pin lives in controller harness/pi-durable: " (:file p)))))))

(defn- check-formal-011 [repo]
  ;; Certificate builds purely from published files in repo without any scratch/worker dir
  (let [cert (trace/certificate repo)]
    (assert! (= "loyly.formal-certificate.v1" (:schema cert)) "certificate built without worker")
    (assert! (true? (get-in cert [:panel :ok])) "panel ok without worker")))

(defn- check-formal-012 [repo]
  (let [cert (trace/certificate repo)]
    (assert! (= 4 (count (:json-schema-pins cert))) "certificate names 4 schema pins")
    (assert! (models/valid? :sha256 (get-in cert [:panel :file-sha256])) "certificate names panel sha256")
    (assert! (= #{:schema :registry-digest :models :json-schema-pins :panel :digest-roundtrips :project}
                (set (keys cert)))
             "certificate only reports formal pins/proofs, not a live worker run")))

(defn- check-formal-013 [_repo]
  (let [suite (props/run-all! :num-tests 15)
        by-name (into {} (map (juxt :name :pass?) (:results suite)))]
    (assert! (true? (:panel-selection-attempt by-name)) "I11 holds")
    (assert! (true? (:grader-shards-bounded by-name)) "I12 holds")
    (assert! (true? (:continuation-max by-name)) "I13 holds")))

(defn- check-loyly-cycle-001 [repo]
  (assert! (true? (loyly/requires-blind-handoff loyly/PROJECT_ID [{"id" loyly/BLIND_ITEM_ID}]))
           "project requires blind handoff for refusal item")
  (check-cycle-005 repo))

(defn- check-loyly-cycle-002 [_repo]
  (assert! (true? (formal-cycle/I-blind-when-loyly)) "C4 holds for loyly path")
  (check-cycle-006 nil))

(defn- check-loyly-formal-001 [repo]
  (let [proof (trace/prove-booking-panel! repo)]
    (assert! (str/ends-with? (:file proof) loyly/DEFAULT_PANEL_PLAN) "booking panel file checked")
    (assert! (true? (:ok proof)) "I6 holds")))

(defn- check-loyly-formal-002 [repo]
  (let [out (with-out-str (formal-main/-main "--root" repo))
        report (hjson/read-json (first (str/split-lines (str/trim out))))]
    (assert! (str/ends-with? (str (get report "panel-file")) loyly/DEFAULT_PANEL_PLAN)
             "formal prove names booking panel plan")
    (assert! (true? (get report "panel-ok")) "formal prove panel-ok")))

(defn- check-loyly-formal-003 [_repo]
  (let [pkt (models/generate :blind-packet :seed 7)]
    (assert! (= loyly/BLIND_ITEM_ID (get pkt "item")) "blind packet item matches BLIND_ITEM_ID")
    (assert! (models/valid? :blind-packet pkt) "blind packet valid")))

(def ^:private scenario-checks
  {"@cycle-001" check-cycle-001
   "@cycle-002" check-cycle-002
   "@cycle-003" check-cycle-003
   "@cycle-004" check-cycle-004
   "@cycle-005" check-cycle-005
   "@cycle-006" check-cycle-006
   "@cycle-007" check-cycle-007
   "@cycle-008" check-cycle-008
   "@cycle-009" check-cycle-009
   "@cycle-010" check-cycle-010
   "@cycle-011" check-cycle-011
   "@cycle-012" check-cycle-012
   "@cycle-013" check-cycle-013
   "@cycle-014" check-cycle-014
   "@cycle-015" check-cycle-015
   "@cycle-016" check-cycle-016
   "@cycle-017" check-cycle-017
   "@formal-001" check-formal-001
   "@formal-002" check-formal-002
   "@formal-003" check-formal-003
   "@formal-004" check-formal-004
   "@formal-005" check-formal-005
   "@formal-006" check-formal-006
   "@formal-007" check-formal-007
   "@formal-008" check-formal-008
   "@formal-009" check-formal-009
   "@formal-010" check-formal-010
   "@formal-011" check-formal-011
   "@formal-012" check-formal-012
   "@formal-013" check-formal-013
   "@loyly-cycle-001" check-loyly-cycle-001
   "@loyly-cycle-002" check-loyly-cycle-002
   "@loyly-formal-001" check-loyly-formal-001
   "@loyly-formal-002" check-loyly-formal-002
   "@loyly-formal-003" check-loyly-formal-003})

(def ^:private feature-files
  ["harness/specs/cycle.spec.feature"
   (str "harness/project/" loyly/PROJECT_ID "/cycle.spec.feature")])

(defn -main [& args]
  (let [args (vec args)
        repo (or (second (drop-while #(not= "--root" %) args))
                 (default-repo))
        scenarios (vec (mapcat #(parse-feature-scenarios repo %) feature-files))
        tags (mapv :tag scenarios)
        tag-set (set tags)
        check-set (set (keys scenario-checks))
        dupes (->> (frequencies tags) (filter #(> (val %) 1)) (map key) sort vec)
        missing (sort (set/difference tag-set check-set))
        extra (sort (set/difference check-set tag-set))]
    (when (or (seq dupes) (seq missing) (seq extra))
      (binding [*out* *err*]
        (when (seq dupes) (println "duplicate Gherkin tags:" (str/join ", " dupes)))
        (when (seq missing) (println "Gherkin scenarios missing checks:" (str/join ", " missing)))
        (when (seq extra) (println "orphan checks not in Gherkin:" (str/join ", " extra))))
      (System/exit 1))
    (let [failures (atom 0)]
      (doseq [{:keys [tag scenario file line]} scenarios]
        (let [check-fn (get scenario-checks tag)]
          (try
            (check-fn repo)
            (println (str "  ok    " tag "  " scenario))
            (catch Exception e
              (swap! failures inc)
              (binding [*out* *err*]
                (println (str "  FAIL  " tag " (" file ":" line "): " (ex-message e))))))))
      (if (pos? @failures)
        (do (binding [*out* *err*]
              (println (str @failures " / " (count scenarios) " Gherkin scenarios failed.")))
            (System/exit 1))
        (do (println (str "spec OK (" (count scenarios) "/" (count scenarios)
                          " Gherkin scenarios verified across " (count feature-files) " files)"))
            :ok)))))
