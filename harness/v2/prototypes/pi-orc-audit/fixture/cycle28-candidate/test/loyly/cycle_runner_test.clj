(ns loyly.cycle-runner-test
  (:require [clojure.test :refer :all]
            [clojure.java.io :as io]
            [clojure.java.shell :as shell]
            [clojure.data.json :as json]
            [loyly.cycle-runner :as runner])
  (:import [java.io BufferedReader InputStreamReader OutputStreamWriter BufferedWriter]
           [java.util.concurrent TimeUnit]))

(def base (.getCanonicalFile (io/file ".")))
(def tmp (io/file base "test/tmp-suite"))

(defn write-file [path content]
  (let [f (io/file path)]
    (.mkdirs (.getParentFile f))
    (spit f content)
    f))

(defn executable [path content]
  (let [f (write-file path content)]
    (.setExecutable f true)
    f))

(defn checked [& args]
  (let [{:keys [exit out err]} (apply shell/sh args)]
    (when-not (zero? exit)
      (throw (ex-info "fixture command failed" {:argv args :out out :err err})))
    (.trim out)))

(defn fixture!
  ([unstamped?] (fixture! unstamped? "01"))
  ([unstamped? slice]
  (let [root (io/file tmp (str (if unstamped? "unstamped" "gapped") "-" (random-uuid)))
        repo (io/file root "repo")
        plan (io/file repo (str "plan/" slice "-demo/spec.feature"))
        app (io/file repo "impl/old.txt")
        candidate (io/file root "candidate")
        config (io/file root "config")
        selfcheck (io/file root "selfcheck")
        builder (io/file root "builder")
        gate (io/file root "gate")
        grader (io/file root "grader")
        rubric (io/file root "rubric")
        policy (io/file root "policy")]
    (write-file plan (str "Feature: Demo\n"
                          "  @item-" slice "-001\n  Scenario: first\n"
                          "  @item-" slice "-003\n  Scenario: third\n"
                          (when (= slice "06") "  @item-06-076\n  Scenario: seventy-six\n")
                          (when unstamped? "  Scenario: untagged\n")))
    (write-file app "old\n")
    (write-file (io/file candidate "data.txt") "candidate\n")
    (write-file config "PLAN_DIR=plan\nAPP_DIR=impl\nFENCED_PATHS=impl\n")
    (executable selfcheck "#!/bin/sh\necho checked\n")
    (executable builder (str "#!/bin/sh\ncp -R " (.getAbsolutePath candidate) " \"$1/impl\"\n"))
    (executable gate "#!/bin/sh\necho BOOT 5 30\necho ANSWERED 1\necho identity-ok\n")
    (executable grader
                (str "#!/bin/sh\nset -eu\nmkdir -p \"$1/work\"\n"
                     "id=$(sed -n 's/.*Grade only \\([^ ]*\\).*/\\1/p' \"$2\")\n"
                     "printf '[{\"id\":\"%s\",\"verdict\":\"pass\",\"evidence\":\"observed seam\"}]\\n' \"$id\" > \"$1/work/verdicts.json\"\n"))
    (write-file rubric "rubric\n")
    (write-file policy "")
    (checked "git" "-C" (.getAbsolutePath repo) "init" "-q")
    (checked "git" "-C" (.getAbsolutePath repo) "add" ".")
    (checked "git" "-C" (.getAbsolutePath repo) "-c" "user.name=Test"
             "-c" "user.email=test@example.org" "commit" "-qm" "fixture")
    {:root root :repo repo :config config :selfcheck selfcheck
     :builder builder :gate gate :grader grader :rubric rubric :policy policy
     :candidate candidate
     :commit (checked "git" "-C" (.getAbsolutePath repo) "rev-parse" "HEAD")})))

(defn environment [fixture image?]
  (let [root (:root fixture)
        e {"LOYLY_GRAIN_STORE" (str (io/file root "store.sqlite"))
           "LOYLY_RUNS_DIR" (str (io/file root "runs"))
           "LOYLY_PROJECT_REPO" (str (:repo fixture))
           "LOYLY_HARNESS_CONFIG" (str (:config fixture))
           "LOYLY_SELF_CHECK_CMD" (str (:selfcheck fixture))
           "LOYLY_BUILDER_HOST" (str (:builder fixture))
           "LOYLY_GATE_CMD" (str (:gate fixture))
           "LOYLY_BUILDER_INSTRUCTION" "Build it"
           "LOYLY_GRADER_RUBRIC" (str (:rubric fixture))
           "LOYLY_GRADER_HOST" (str (:grader fixture))
           "LOYLY_GRADER_HOST_POLICY" (str (:policy fixture))
           "LOYLY_GRADER_MODEL" "grade"
           "LOYLY_GRADER_IMAGE" (str (:candidate fixture))}]
    (if image?
      (assoc e "LOYLY_BUILDER_IMAGES" (str (io/file root "images")))
      e)))

(defn start-process [fixture env]
  (let [pb (ProcessBuilder. (into-array String [(str (io/file base "start.sh"))]))]
    (.directory pb base)
    (.redirectError pb (io/file (:root fixture) "stderr.log"))
    (doseq [[k v] env] (.put (.environment pb) k v))
    (let [p (.start pb)]
      {:process p
       :writer (BufferedWriter. (OutputStreamWriter. (.getOutputStream p) "UTF-8"))
       :reader (BufferedReader. (InputStreamReader. (.getInputStream p) "UTF-8"))})))

(defn rpc! [{:keys [writer reader]} id method params]
  (.write writer (str (json/write-str {:jsonrpc "2.0" :id id :method method :params params}) "\n"))
  (.flush writer)
  (let [line (deref (future (.readLine reader)) 30000 ::timeout)]
    (is (not= ::timeout line) (str "response to " method))
    (when (string? line) (json/read-str line :key-fn keyword))))

(defn send-rpc! [{:keys [writer]} id method params]
  (.write writer (str (json/write-str {:jsonrpc "2.0" :id id :method method :params params}) "\n"))
  (.flush writer))

(defn receive-rpc! [{:keys [reader]}]
  (let [line (deref (future (.readLine reader)) 30000 ::timeout)]
    (is (string? line) "async seam response arrived")
    (when (string? line) (json/read-str line :key-fn keyword))))

(defn stop-process [{:keys [process writer]}]
  (.close writer)
  (when-not (.waitFor process 30 TimeUnit/SECONDS)
    (.destroyForcibly process)
    (is false "candidate did not exit on EOF")))

(defn params [fixture run-id]
  {:run-id run-id :cycle-id (str "C-" run-id) :cut-id (str "K-" run-id)
   :commit (:commit fixture) :selection-id "S-1"
   :budget {:gate-attempt-limit 3 :max-outer-cycles 1 :max-continuations 0
            :stage-timeouts-seconds {:fence 30 :regenerate 30 :gate 30 :score 30}}
   :grader-digests [(runner/grader-digest (environment fixture false))]})

(defn recommit! [fixture]
  (checked "git" "-C" (str (:repo fixture)) "add" ".")
  (checked "git" "-C" (str (:repo fixture)) "-c" "user.name=Test"
           "-c" "user.email=test@example.org" "commit" "-qm" "fixture variant")
  (assoc fixture :commit (checked "git" "-C" (str (:repo fixture)) "rev-parse" "HEAD")))

(defn run-and-progress! [session fixture id]
  (rpc! session (str id "-start") "cycle-runner/start-run" (params fixture id))
  (get-in (rpc! session (str id "-progress") "cycle-runner/run-progress" {:run-id id})
          [:result :run]))

(defn grader-variant! [fixture mode]
  (executable (:grader fixture)
              (str "#!/bin/sh\nset -eu\nitem=${1##*/}\nmkdir -p \"$1/work\"\n"
                   (case mode
                     :first-only "[ \"$item\" = 01-001 ] || exit 0\n"
                     :empty-second "evidence=observed\n[ \"$item\" = 01-003 ] && evidence= || true\n"
                     :none "exit 0\n"
                     "")
                   "evidence=${evidence:-observed}\n"
                   (when (= mode :empty-second)
                     "[ \"$item\" = 01-003 ] && evidence= || true\n")
                   "printf '[{\"id\":\"%s\",\"verdict\":\"pass\",\"evidence\":\"%s\"}]\\n' \"$item\" \"$evidence\" > \"$1/work/verdicts.json\"\n")))

(deftest item-06-005-and-001-and-064-public-seam
  (let [f (fixture! false)
        session (start-process f (environment f false))]
    (try
      (let [bad (rpc! session 1 "cycle-runner/start-run"
                      (assoc (params f "bad") :commit (apply str (repeat 40 "a"))))]
        (is (= "not-a-commit" (get-in bad [:error :data :refusal])) "@item-06-005"))
      (let [good (rpc! session 2 "cycle-runner/start-run" (params f "full"))
            progress (rpc! session 3 "cycle-runner/run-progress" {:run-id "full"})
            run (get-in progress [:result :run])
            effects (mapv :effect (:effect-results run))]
        (is (= "cycle-runner/run-started" (get-in good [:result :events 0 :type])) "@item-06-001")
        (is (not (contains? (get-in good [:result :events 0]) :event/type)) "@item-06-001 public event shape")
        (is (= "passed" (:status run)) "@item-06-001")
        (is (= ["stamp" "pin" "checklist" "self-check" "fence" "regenerate"
                "install" "self-check" "gate" "file-verdicts" "file-score"] effects)
            "@item-06-001")
        (is (= ["01-001" "01-003"] (mapv :item-id (:scores run))) "@item-06-064")
        (is (= 2 (Integer/parseInt
                  (checked "sqlite3" (str (io/file (:root f) "store.sqlite"))
                           "select count(*) from events where type=':judge/score-emitted'")))
            "@item-06-064")
        (is (= 3 (Integer/parseInt
                  (checked "sqlite3" (str (io/file (:root f) "store.sqlite"))
                           "select count(*) from events where type=':sheet/tree-tick-completed'")))
            "@item-06-064")
        (let [same-run (rpc! session 4 "cycle-runner/start-run"
                             (assoc (params f "full") :cycle-id "C-other"))
              same-cycle (rpc! session 5 "cycle-runner/start-run"
                               (assoc (params f "other") :cycle-id "C-full"))]
          (is (= "run-already-started" (get-in same-run [:error :data :refusal]))
              "@item-06-002")
          (is (= "cycle-already-run" (get-in same-cycle [:error :data :refusal]))
              "@item-06-004"))
        (let [count-before (Integer/parseInt
                            (checked "sqlite3" (str (io/file (:root f) "store.sqlite"))
                                     "select count(*) from events"))
              again (get-in (rpc! session 6 "cycle-runner/run-progress" {:run-id "full"})
                            [:result :run])
              count-after (Integer/parseInt
                           (checked "sqlite3" (str (io/file (:root f) "store.sqlite"))
                                    "select count(*) from events"))]
          (is (= "passed" (:status again)) "@item-06-034")
          (is (= (:effect-results run) (:effect-results again)) "@item-06-034")
          (is (= count-before count-after) "@item-06-035")))
      (finally (stop-process session)))))

(deftest item-06-068-unapproved-grader-halts-before-cycle
  (let [f (fixture! false)
        session (start-process f (environment f false))]
    (try
      (rpc! session 1 "cycle-runner/start-run"
            (assoc (params f "unapproved") :grader-digests ["wrong-digest"]))
      (let [run (get-in (rpc! session 2 "cycle-runner/run-progress" {:run-id "unapproved"})
                        [:result :run])]
        (is (= "halted" (:status run)) "@item-06-068")
        (is (= "grader" (get-in run [:halt :effect])) "@item-06-068")
        (is (= ["stamp" "pin" "checklist"] (mapv :effect (:effect-results run)))
            "@item-06-068"))
      (finally (stop-process session)))))

(deftest item-06-009-unstamped-halts-before-pin
  (let [f (fixture! true)
        session (start-process f (environment f false))]
    (try
      (rpc! session 1 "cycle-runner/start-run" (params f "unstamped"))
      (let [run (get-in (rpc! session 2 "cycle-runner/run-progress" {:run-id "unstamped"})
                        [:result :run])]
        (is (= "halted" (:status run)) "@item-06-009")
        (is (= "stamp" (get-in run [:halt :effect])) "@item-06-009")
        (is (= ["stamp"] (mapv :effect (:effect-results run))) "@item-06-009"))
      (finally (stop-process session)))))

(deftest item-06-050-missing-builder-image-refuses-start
  (let [f (fixture! false)]
    (spit (:config f) "PLAN_DIR=plan\nAPP_DIR=impl\nFENCED_PATHS=impl\nBUILDER_IMAGE=missing\n")
    (let [session (start-process f (environment f true))]
      (try
        (let [reply (rpc! session 1 "cycle-runner/start-run" (params f "missing"))
              progress (rpc! session 2 "cycle-runner/run-progress" {:run-id "missing"})]
          (is (= "builder-image-missing" (get-in reply [:error :data :refusal]))
              "@item-06-050")
          (is (nil? (get-in progress [:result :run])) "@item-06-050"))
        (finally (stop-process session))))))

(deftest item-06-077-retired-gap-is-preserved-on-fresh-store
  (let [f (fixture! false "06")
        session (start-process f (environment f false))]
    (try
      (rpc! session 1 "cycle-runner/start-run" (params f "gap"))
      (let [run (get-in (rpc! session 2 "cycle-runner/run-progress" {:run-id "gap"})
                        [:result :run])
            ledger (get-in (rpc! session 3 "specification/stamped-items" {:slice "06"})
                           [:result :slice])
            checklist (get-in (rpc! session 4 "measurement/checklist" {:cut-id "K-gap"})
                              [:result :checklist])
            score (get-in (rpc! session 5 "measurement/cycle-measurement" {:cycle-id "C-gap"})
                          [:result :measurement])
            ids ["06-001" "06-003" "06-076"]]
        (is (= "passed" (:status run)) "@item-06-077")
        (is (= ids (mapv :item-id (:items ledger))) "@item-06-077")
        (is (= 77 (:next-number ledger)) "@item-06-077")
        (is (= ids (mapv :item-id (:items checklist))) "@item-06-077")
        (is (= ids (mapv :item-id (:items score))) "@item-06-077"))
      (finally (stop-process session)))))

(deftest item-06-008-010-011-012-015-016-failure-and-fence-paths
  (let [base-fixture (fixture! false)
        session (start-process base-fixture (environment base-fixture false))]
    (try
      (write-file (io/file (:repo base-fixture) "plan/01-demo/spec.feature")
                  "Feature: Empty\n")
      (let [f (recommit! base-fixture)
            run (run-and-progress! session f "empty")]
        (is (= "halted" (:status run)) "@item-06-008")
        (is (= "checklist" (get-in run [:halt :effect])) "@item-06-008")
        (is (= "empty-checklist" (get-in run [:effect-results 2 :refusal]))
            "@item-06-008"))

      (write-file (io/file (:repo base-fixture) "plan/01-demo/spec.feature")
                  "Feature: Demo\n  @item-01-001\n  Scenario: first\n  @item-01-003\n  Scenario: third\n")
      (let [f (recommit! base-fixture)]
        (executable (:selfcheck f)
                    "#!/bin/sh\necho checking\necho golden checklist differs\nexit 1\n")
        (let [run (run-and-progress! session f "red-check")]
          (is (= "failed" (:status run)) "@item-06-010")
          (is (= {:stage "fence" :reason "harness-self-check-failed"
                  :detail "checking\ngolden checklist differs"}
                 (get-in run [:cycle :failure])) "@item-06-010")
          (is (= "self-check" (:effect (last (:effect-results run)))) "@item-06-010"))

        (executable (:selfcheck f) "#!/bin/sh\necho SKIP bb-tools\n")
        (let [run (run-and-progress! session f "skip")
              event (get-in run [:effect-results 3 :events 0])]
          (is (= "regeneration-cycle/harness-self-check-passed" (:type event))
              "@item-06-011")
          (is (= ["bb-tools"] (:skipped-checks event)) "@item-06-011")
          (is (.contains (get-in run [:effect-results 3 :detail]) "bb-tools")
              "@item-06-011"))

        (spit (:config f) "PLAN_DIR=plan\nAPP_DIR=impl\nFENCED_PATHS=impl harness/cycles\n")
        (let [run (run-and-progress! session f "bad-fence")]
          (is (= "failed" (:status run)) "@item-06-012")
          (is (= "fenced-path-matched-nothing"
                 (get-in run [:effect-results 4 :refusal])) "@item-06-012")
          (is (= "fail-cycle" (get-in run [:effect-results 5 :effect])) "@item-06-012"))

        (spit (:config f) "PLAN_DIR=plan\nAPP_DIR=impl\nFENCED_PATHS=impl\n")
        (executable (:builder f)
                    (str "#!/bin/sh\ncp -R " (:candidate f) " \"$1/impl\"\nexit 1\n"))
        (let [run (run-and-progress! session f "builder-red")]
          (is (= "passed" (:status run)) "@item-06-015")
          (is (= "regenerate" (get-in run [:effect-results 5 :effect]))
              "@item-06-015"))

        (executable (:builder f) "#!/bin/sh\nexit 0\n")
        (let [run (run-and-progress! session f "builder-empty")]
          (is (= "failed" (:status run)) "@item-06-016")
          (is (= "candidate-not-regenerated" (get-in run [:cycle :failure :reason]))
              "@item-06-016")
          (is (not-any? #(= "regenerate" (:effect %)) (:effect-results run))
              "@item-06-016")))
      (finally (stop-process session)))))

(deftest item-06-026-065-067-069-074-unreached-and-empty-scores
  (let [f (fixture! false)
        session (start-process f (environment f false))]
    (try
      (grader-variant! f :first-only)
      (executable (:grader f)
                  "#!/bin/sh\nset -eu\nitem=${1##*/}\nmkdir -p \"$1/work\"\n[ \"$item\" = 01-001 ] || exit 0\nprintf '[{\"id\":\"%s\",\"verdict\":\"pass\",\"evidence\":\"E-ONE\"}]\\n' \"$item\" > \"$1/work/verdicts.json\"\n")
      (let [run (run-and-progress! session f "one-scored")
            verdicts (get-in run [:effect-results 9 :events 0 :verdicts])
            measurement (get-in run [:effect-results 10 :events 0])
            results-dir (io/file (:root f) "runs/one-scored/allure-results")
            result-files (filter #(clojure.string/ends-with? (.getName %) "-result.json")
                                 (.listFiles results-dir))
            results (mapv #(json/read-str (slurp %) :key-fn keyword) result-files)
            by-name (into {} (map (juxt :name identity) results))]
        (is (= "passed" (:status run)) "@item-06-026")
        (is (= ["01-001"] (mapv :item-id verdicts)) "@item-06-026")
        (is (= 1 (:passes measurement)) "@item-06-026")
        (is (= "unreached" (get-in measurement [:items 1 :reason])) "@item-06-026")
        (is (= "E-ONE" (get-in run [:scores 0 :reason])) "@item-06-065")
        (is (not (clojure.string/includes?
                  (slurp (io/file (:root f) "runs/one-scored/grading/01-003/instruction.txt"))
                  "E-ONE")) "@item-06-065")
        (is (= 2 (count results)) "@item-06-074")
        (is (= #{"passed" "failed"} (set (map :status results))) "@item-06-074")
        (is (= "unreached" (get-in by-name ["01-003" :statusDetails :message]))
            "@item-06-074")
        (is (every? #(and (seq (:testCaseId %)) (seq (:historyId %))
                          (some (fn [label] (= "tag" (:name label))) (:labels %))) results)
            "@item-06-074"))

      (grader-variant! f :empty-second)
      (let [run (run-and-progress! session f "empty-evidence")
            measurement (get-in run [:effect-results 10 :events 0])]
        (is (= ["01-001"] (mapv :item-id (:scores run))) "@item-06-067")
        (is (= "unreached" (get-in measurement [:items 1 :reason])) "@item-06-067"))

      (grader-variant! f :none)
      (let [run (run-and-progress! session f "zero-scores")]
        (is (= "failed" (:status run)) "@item-06-069")
        (is (= "zero-verdicts" (get-in run [:effect-results 9 :refusal]))
            "@item-06-069")
        (is (= "fail-score-stage" (get-in run [:effect-results 10 :effect]))
            "@item-06-069")
        (is (= "score-stage-failed" (get-in run [:cycle :failure :reason]))
            "@item-06-069"))
      (finally (stop-process session)))))

(deftest item-06-053-056-gate-command-results
  (let [f (fixture! false)
        session (start-process f (environment f false))]
    (try
      (executable (:gate f)
                  (str "#!/bin/sh\npwd > " (io/file (:root f) "gate.cwd") "\n"
                       "printf '%s\\n' \"$1\" \"$2\" \"$3\" > "
                       (io/file (:root f) "gate.args") "\n"
                       "echo evidence > \"$3/probe.txt\"\n"
                       "echo BOOT 20 10\necho ANSWERED 3\necho ledger answered as itself\n"))
      (let [run (run-and-progress! session f "gate-pass")
            event (get-in run [:effect-results 8 :events 0])
            args (clojure.string/split-lines (slurp (io/file (:root f) "gate.args")))]
        (is (= "passed" (:status run)) "@item-06-053")
        (is (= "regeneration-cycle/gate-attempt-passed" (:type event))
            "@item-06-053")
        (is (= [20 10 3] [(:boot-polls event) (:boot-budget-seconds event)
                          (:answered-on-poll event)]) "@item-06-053")
        (is (= "ledger answered as itself" (:identity-probe-result event))
            "@item-06-053")
        (is (= (str (:repo f)) (clojure.string/trim (slurp (io/file (:root f) "gate.cwd"))))
            "@item-06-053")
        (is (= (:candidate-digest run) (get-in run [:effect-results 6 :events 0 :candidate-digest]))
            "@item-06-053")
        (is (= (nth args 2) (:evidence-root event)) "@item-06-053"))

      (executable (:gate f)
                  "#!/bin/sh\necho BOOT 20 10\necho infrastructure the world did not come up\nexit 2\n")
      (let [run (run-and-progress! session f "gate-halt")]
        (is (= "halted" (:status run)) "@item-06-056")
        (is (= "gate" (get-in run [:halt :effect])) "@item-06-056")
        (is (not-any? #(= "gate" (:effect %)) (:effect-results run)) "@item-06-056")
        (is (nil? (:cycle run)) "@item-06-056"))
      (finally (stop-process session)))))

(deftest item-06-072-render-failure-halts-before-builder
  (let [f (fixture! false)
        env (assoc (environment f false) "LOYLY_MODEL_API_BASE" "http://127.0.0.1:1/v1")
        session (start-process f env)]
    (try
      (let [run (run-and-progress! session f "render-fail")]
        (is (= "halted" (:status run)) "@item-06-072")
        (is (= "render" (get-in run [:halt :effect])) "@item-06-072")
        (is (not-any? #(= "regenerate" (:effect %)) (:effect-results run))
            "@item-06-072")
        (is (nil? (:cycle run)) "@item-06-072"))
      (finally (stop-process session)))))

(deftest item-06-003-second-run-refused-during-builder
  (let [f (fixture! false)
        launched (io/file (:root f) "builder-launched")]
    (executable (:builder f)
                (str "#!/bin/sh\necho launched > " launched "\nsleep 4\ncp -R "
                     (:candidate f) " \"$1/impl\"\n"))
    (let [session (start-process f (environment f false))]
      (try
        (send-rpc! session 1 "cycle-runner/start-run" (params f "slow"))
        (let [deadline (+ (System/currentTimeMillis) 20000)]
          (while (and (not (.exists launched)) (< (System/currentTimeMillis) deadline))
            (Thread/sleep 50)))
        (is (.exists launched) "@item-06-003 builder launched")
        (send-rpc! session 2 "cycle-runner/start-run" (params f "second"))
        (let [start (System/currentTimeMillis)
              reply (receive-rpc! session)]
          (is (= 2 (:id reply)) "@item-06-003 second start answered before first")
          (is (= "run-in-progress" (get-in reply [:error :data :refusal]))
              "@item-06-003")
          (is (< (- (System/currentTimeMillis) start) 3000)
              "@item-06-003 second start did not wait for builder"))
        (let [during (rpc! session 21 "cycle-runner/run-progress" {:run-id "slow"})]
          (is (= "running" (get-in during [:result :run :status]))
              "@item-06-003 first run remains running"))
        (let [first-reply (receive-rpc! session)
              missing (rpc! session 3 "cycle-runner/run-progress" {:run-id "second"})]
          (is (= 1 (:id first-reply)) "@item-06-003 original run completed")
          (is (nil? (get-in missing [:result :run])) "@item-06-003"))
        (finally (stop-process session))))))

(deftest item-06-017-builder-timeout-stops-session
  (let [f (fixture! false)
        pid-file (io/file (:root f) "builder.pid")]
    (executable (:builder f)
                (str "#!/bin/sh\necho $$ > " pid-file "\nsleep 30\ncp -R "
                     (:candidate f) " \"$1/impl\"\n"))
    (let [session (start-process f (environment f false))]
      (try
        (let [p (assoc-in (params f "budget") [:budget :stage-timeouts-seconds :regenerate] 2)]
          (rpc! session 1 "cycle-runner/start-run" p)
          (let [run (get-in (rpc! session 2 "cycle-runner/run-progress" {:run-id "budget"})
                            [:result :run])]
            (is (= "failed" (:status run)) "@item-06-017")
            (is (= "budget" (get-in run [:cycle :failure :reason])) "@item-06-017")
            (is (= "regenerate" (get-in run [:cycle :failure :stage])) "@item-06-017")
            (is (not-any? #(= "regenerate" (:effect %)) (:effect-results run))
                "@item-06-017")))
        (is (.exists pid-file) "@item-06-017 builder started")
        (let [pid (Long/parseLong (clojure.string/trim (slurp pid-file)))
              alive? (-> (java.lang.ProcessHandle/of pid) (.isPresent))]
          (is (not alive?) "@item-06-017 builder process stopped"))
        (finally (stop-process session))))))

(deftest item-06-075-grader-deadline-stops-child
  (let [f (fixture! false)
        pid-file (io/file (:root f) "grader-child.pid")]
    (executable (:grader f)
                (str "#!/bin/sh\nset -eu\nitem=${1##*/}\nmkdir -p \"$1/work\"\n"
                     "if [ \"$item\" = 01-001 ]; then\n"
                     "sleep 30 &\necho $! > " pid-file "\nwait\nfi\n"
                     "printf '[{\"id\":\"%s\",\"verdict\":\"pass\",\"evidence\":\"other\"}]\\n' \"$item\" > \"$1/work/verdicts.json\"\n"))
    (let [session (start-process f (environment f false))]
      (try
        (let [p (assoc-in (params f "grader-timeout") [:budget :stage-timeouts-seconds :score] 4)]
          (rpc! session 1 "cycle-runner/start-run" p)
          (let [run (get-in (rpc! session 2 "cycle-runner/run-progress" {:run-id "grader-timeout"})
                            [:result :run])
                measurement (get-in run [:effect-results 10 :events 0])]
            (is (= "passed" (:status run)) "@item-06-075")
            (is (= ["01-003"] (mapv :item-id (:scores run))) "@item-06-075")
            (is (= "unreached" (get-in measurement [:items 0 :reason])) "@item-06-075")
            (is (= 1 (count (filter #(= "regenerate" (:effect %)) (:effect-results run))))
                "@item-06-075")))
        (is (.exists pid-file) "@item-06-075 child started")
        (let [pid (Long/parseLong (clojure.string/trim (slurp pid-file)))]
          (is (not (.isPresent (java.lang.ProcessHandle/of pid)))
              "@item-06-075 child stopped"))
        (finally (stop-process session))))))

(deftest item-06-065-074-exact-two-item-projection
  (let [f0 (fixture! false)
        plan (io/file (:repo f0) "plan/01-demo/spec.feature")]
    (write-file plan (clojure.string/replace (slurp plan) "01-003" "01-002"))
    (let [f (recommit! f0)]
      (executable (:grader f)
                  "#!/bin/sh\nset -eu\nitem=${1##*/}\nmkdir -p \"$1/work\"\n[ \"$item\" = 01-001 ] || exit 0\nprintf '[{\"id\":\"01-001\",\"verdict\":\"pass\",\"evidence\":\"E-ONE\"}]\\n' > \"$1/work/verdicts.json\"\n")
      (let [session (start-process f (environment f false))]
        (try
          (let [run (run-and-progress! session f "exact-two")
                measurement (get-in run [:effect-results 10 :events 0])
                room (io/file (:root f) "runs/exact-two/grading/01-002")
                files (filter #(clojure.string/ends-with? (.getName %) "-result.json")
                              (.listFiles (io/file (:root f) "runs/exact-two/allure-results")))
                by-name (into {} (map (fn [file]
                                        (let [r (json/read-str (slurp file) :key-fn keyword)]
                                          [(:name r) r])) files))]
            (is (= "passed" (:status run)) "@item-06-065")
            (is (= ["01-001" "01-002"] (mapv :item-id (:items measurement)))
                "@item-06-074 exact denominator")
            (is (= "E-ONE" (get-in run [:scores 0 :reason])) "@item-06-065")
            (is (not (clojure.string/includes?
                      (slurp (io/file room "instruction.txt")) "E-ONE"))
                "@item-06-065 second instruction clear")
            (is (not (clojure.string/includes?
                      (str (map slurp (filter #(.isFile %) (file-seq room)))) "E-ONE"))
                "@item-06-065 second room clear")
            (is (= 1 (:passes measurement)) "@item-06-074")
            (is (= "unreached" (get-in measurement [:items 1 :reason])) "@item-06-074")
            (is (= #{"01-001" "01-002"} (set (keys by-name))) "@item-06-074")
            (is (= ["passed" "failed"] (mapv #(get-in by-name [% :status])
                                               ["01-001" "01-002"])) "@item-06-074")
            (is (= "unreached" (get-in by-name ["01-002" :statusDetails :message]))
                "@item-06-074")
            (is (every? (fn [result]
                          (and (seq (:historyId result)) (seq (:testCaseId result))
                               (some (fn [label]
                                       (= (str "item-" (:name result)) (:value label)))
                                     (:labels result)))) (vals by-name))
                "@item-06-074"))
          (finally (stop-process session)))))))

(deftest item-06-034-ended-runs-stay-ended
  (let [f (fixture! false)
        session (start-process f (environment f false))]
    (try
      (write-file (:config f)
                  "PLAN_DIR=plan\nAPP_DIR=impl\nFENCED_PATHS=missing-path\n")
      (let [failed (run-and-progress! session f "fence-failed")]
        (is (= "failed" (:status failed)) "@item-06-034 fence failure")
        (is (= "fence" (get-in failed [:cycle :failure :stage])) "@item-06-034")
        (write-file (:config f)
                    "PLAN_DIR=plan\nPLAN_SLICES=99\nAPP_DIR=impl\nFENCED_PATHS=impl\n")
        (let [halted (run-and-progress! session f "checklist-halted")]
          (is (= "halted" (:status halted)) "@item-06-034 checklist halt")
          (is (= "checklist" (get-in halted [:halt :effect])) "@item-06-034")
          (Thread/sleep 5000)
          (let [failed-again (get-in (rpc! session 101 "cycle-runner/run-progress"
                                          {:run-id "fence-failed"}) [:result :run])
                halted-again (get-in (rpc! session 102 "cycle-runner/run-progress"
                                          {:run-id "checklist-halted"}) [:result :run])]
            (is (= failed failed-again) "@item-06-034 failed history remains")
            (is (= halted halted-again) "@item-06-034 halted history remains"))))
      (finally (stop-process session)))))

(deftest item-06-038-skipped-self-check-text
  (let [f (fixture! false)
        session (start-process f (environment f false))]
    (try
      (executable (:selfcheck f)
                  "#!/bin/sh\necho 'SKIP  the oracle cannot judge this tree: a tool it grades is absent.'\n")
      (let [run (run-and-progress! session f "skip-check")
            event (get-in run [:effect-results 3 :events 0])]
        (is (= "passed" (:status run)) "@item-06-038")
        (is (= "regeneration-cycle/harness-self-check-passed" (:type event))
            "@item-06-038")
        (is (= ["the oracle cannot judge this tree: a tool it grades is absent."]
               (:skipped-checks event)) "@item-06-038")
        (is (clojure.string/includes? (get-in run [:effect-results 3 :detail])
                                      "the oracle cannot judge this tree: a tool it grades is absent.")
            "@item-06-038"))
      (finally (stop-process session)))))

(deftest item-06-048-plan-slices-control-selection
  (let [f0 (fixture! false)]
    (write-file (io/file (:repo f0) "plan/01-demo/spec.feature")
                "Feature: One\n  @item-01-001\n  Scenario: first\n  @item-01-002\n  Scenario: second\n")
    (write-file (io/file (:repo f0) "plan/02-other/spec.feature")
                "Feature: Two\n  @item-02-001\n  Scenario: other\n")
    (write-file (:config f0)
                "PLAN_DIR=plan\nPLAN_SLICES=02\nAPP_DIR=impl\nFENCED_PATHS=impl\n")
    (let [f (recommit! f0)
          session (start-process f (environment f false))]
      (try
        (let [run (run-and-progress! session f "selected")
              stamps (get-in run [:effect-results 0 :events])
              checklist (get-in run [:effect-results 2 :events 0 :items])]
          (is (= "passed" (:status run)) "@item-06-048")
          (is (= ["02-001"] (mapv :item-id stamps)) "@item-06-048")
          (is (= ["02-001"] (mapv :item-id checklist)) "@item-06-048"))
        (finally (stop-process session))))))

(deftest item-06-047-slice-symlink-at-cut
  (let [f0 (fixture! false)
        repo (:repo f0)
        link (io/file repo "plan/01-a")]
    (runner/delete-tree! (io/file repo "plan/01-demo"))
    (write-file (io/file repo "spec/a/spec.feature")
                "Feature: linked\n  @item-01-001\n  Scenario: first\n  @item-01-002\n  Scenario: second\n")
    (java.nio.file.Files/createSymbolicLink (.toPath link)
                                             (.toPath (io/file "../spec/a"))
                                             (make-array java.nio.file.attribute.FileAttribute 0))
    (let [f (recommit! f0)
          session (start-process f (environment f false))]
      (try
        (let [run (run-and-progress! session f "linked")
              stamps (get-in run [:effect-results 0 :events])
              checklist (get-in run [:effect-results 2 :events 0 :items])]
          (is (= "passed" (:status run)) "@item-06-047")
          (is (= ["01-001" "01-002"] (mapv :item-id checklist)) "@item-06-047")
          (is (every? #(clojure.string/includes? (:source %) "plan/01-a") stamps)
              "@item-06-047 source through link"))
        (finally (stop-process session))))))

(deftest item-06-051-second-cycle-compares-first
  (let [f (fixture! false)
        session (start-process f (environment f false))]
    (try
      (let [first (run-and-progress! session f "baseline")
            second (run-and-progress! session f "following")
            scoreboard (get-in (rpc! session 103 "measurement/scoreboard"
                                    {:cycle-id "C-following"}) [:result :scoreboard])]
        (is (= "passed" (:status first)) "@item-06-051")
        (is (= "passed" (:status second)) "@item-06-051")
        (is (= "C-baseline" (:previous-cycle-id scoreboard)) "@item-06-051")
        (is (empty? (get-in second [:effect-results 0 :events]))
            "@item-06-051 no new stamp identity"))
      (finally (stop-process session)))))

(deftest item-06-013-builder-clean-room-retains-gitlink
  (let [f0 (fixture! false)
        root (:root f0)
        repo (:repo f0)]
    (write-file (io/file repo "harness/config.sh") "PORT=8920\n")
    (write-file (io/file repo "harness/cycles/old.txt") "old\n")
    (write-file (:config f0)
                "PLAN_DIR=plan\nAPP_DIR=impl\nFENCED_PATHS=impl harness/cycles\n")
    (let [f1 (recommit! f0)
          _ (checked "git" "-C" (str repo) "update-index" "--add" "--cacheinfo"
                     (str "160000," (:commit f0) ",provided-runtime"))
          _ (checked "git" "-C" (str repo) "-c" "user.name=Test"
                     "-c" "user.email=test@example.org" "commit" "-qm" "gitlink")
          f (assoc f1 :commit (checked "git" "-C" (str repo) "rev-parse" "HEAD"))
          observed (io/file root "builder-observed")]
      (executable (:builder f)
                  (str "#!/bin/sh\nset -eu\n"
                       "test -f plan/01-demo/spec.feature\n"
                       "test -f harness/config.sh\n"
                       "test ! -e impl\n"
                       "test ! -e harness/cycles\n"
                       "git rev-list --count HEAD > " observed ".count\n"
                       "git ls-tree HEAD provided-runtime > " observed ".link\n"
                       "git ls-tree -r --name-only HEAD > " observed ".paths\n"
                       "cp -R " (:candidate f) " \"$1/impl\"\n"))
      (let [session (start-process f (environment f false))]
        (try
          (let [run (run-and-progress! session f "gitlink")
                paths (slurp (str observed ".paths"))
                link (slurp (str observed ".link"))]
            (is (= "passed" (:status run)) "@item-06-013")
            (is (= "1" (clojure.string/trim (slurp (str observed ".count"))))
                "@item-06-013 one clean commit")
            (is (not (re-find #"(?m)^(impl|harness/cycles)(/|$)" paths))
                "@item-06-013 fenced paths absent")
            (is (clojure.string/includes? paths "plan/01-demo/spec.feature")
                "@item-06-013 plan remains")
            (is (clojure.string/includes? link
                                          (str "160000 commit " (:commit f0)))
                "@item-06-013 gitlink target remains"))
          (finally (stop-process session)))))))

(deftest item-06-039-040-044-stdio-gate-passes-from-cut
  (let [f0 (fixture! false)
        root (:root f0)
        store-check (io/file root "store-check")]
    (write-file (:config f0)
                "PLAN_DIR=plan\nAPP_DIR=impl\nFENCED_PATHS=impl\nAPP_SEAM=stdio\nAPP_PROBE=harness/probe.sh\n")
    (executable (io/file (:repo f0) "harness/probe.sh")
                (str "#!/bin/sh\nset -eu\nprintf '%s\\n' \"$1\" \"$2\" > "
                     (io/file root "probe.args") "\nenv > " (io/file root "probe.env")
                     "\necho answered as the context\n"))
    (executable store-check
                (str "#!/bin/sh\nprintf '%s\\n' \"$@\" > "
                     (io/file root "store.args") "\necho store-ok\n"))
    (executable (io/file (:candidate f0) "test.sh")
                (str "#!/bin/sh\nset -eu\ntest -f plan/01-demo/spec.feature\n"
                     "env > " (io/file root "suite.env") "\n"))
    (executable (io/file (:candidate f0) "start.sh") "#!/bin/sh\nexit 0\n")
    (let [f (recommit! f0)
          env (-> (environment f false)
                  (dissoc "LOYLY_GATE_CMD")
                  (assoc "LOYLY_STORE_CHECK_CMD" (str store-check)))
          session (start-process f env)]
      (try
        (let [run (run-and-progress! session f "stdio-pass")
              gate (get-in run [:effect-results 8 :events 0])
              args (clojure.string/split-lines (slurp (io/file root "probe.args")))
              gate-store (some #(when (clojure.string/starts-with? % "GATE_STORE=")
                                  (subs % (count "GATE_STORE=")))
                               (clojure.string/split-lines (slurp (io/file root "probe.env"))))]
          (is (= "passed" (:status run)) "@item-06-039")
          (is (= "regeneration-cycle/gate-attempt-passed" (:type gate)) "@item-06-039")
          (is (= [30 1 1] [(:boot-budget-seconds gate) (:boot-polls gate)
                           (:answered-on-poll gate)]) "@item-06-039")
          (is (= "answered as the context" (:identity-probe-result gate)) "@item-06-039")
          (is (= 2 (count args)) "@item-06-040")
          (is (= "30" (second args)) "@item-06-040")
          (is (= (str (io/file (get-in run [:effect-results 6 :events 0 :gate-room])
                               "impl/start.sh")) (first args))
              "@item-06-040")
          (is (clojure.string/starts-with? gate-store (str (io/file root "runs")))
              "@item-06-040")
          (is (not (clojure.string/includes? (slurp (io/file root "probe.env")) "LOYLY_"))
              "@item-06-040")
          (is (= gate-store (clojure.string/trim (slurp (io/file root "store.args"))))
              "@item-06-040")
          (is (not (clojure.string/includes? (slurp (io/file root "suite.env")) "LOYLY_"))
              "@item-06-044")
          (is (= (:candidate-digest run) (get-in run [:effect-results 6 :events 0 :candidate-digest]))
              "@item-06-044"))
        (finally (stop-process session))))))

(deftest item-06-036-037-default-http-gate-passes-from-cut
  (let [f0 (fixture! false)
        root (:root f0)
        port (with-open [socket (java.net.ServerSocket. 0)] (.getLocalPort socket))]
    (write-file (:config f0)
                (str "PLAN_DIR=plan\nAPP_DIR=impl\nFENCED_PATHS=impl\n"
                     "APP_PROBE=harness/probe.sh\nAPP_MARKER=pi-harness\nPORT=" port "\n"))
    (executable (io/file (:repo f0) "harness/probe.sh")
                (str "#!/bin/sh\nset -eu\n"
                     "printf '%s\\n' \"$@\" > " (io/file root "probe.args") "\n"
                     "curl -fs \"$1\" | grep -qi pi-harness\n"
                     "echo identity-ok\n"))
    (executable (io/file (:candidate f0) "test.sh")
                "#!/bin/sh\nset -eu\nmkdir -p impl/suite-temp\nrmdir impl/suite-temp\n")
    (executable (io/file (:candidate f0) "start.sh")
                "#!/bin/sh\nexec python3 -m http.server \"$1\" --bind 127.0.0.1 --directory impl\n")
    (write-file (io/file (:candidate f0) "index.html") "<h1>Pi-Harness</h1>\n")
    (let [f (recommit! f0)
          session (start-process f (dissoc (environment f false) "LOYLY_GATE_CMD"))]
      (try
        (let [run (run-and-progress! session f "http-pass")
              gate (some #(when (= "gate" (:effect %)) (get-in % [:events 0]))
                         (:effect-results run))]
          (is (= "passed" (:status run)) "@item-06-036")
          (is (= "regeneration-cycle/gate-attempt-passed" (:type gate)) "@item-06-036")
          (is (= [10 20] [(:boot-budget-seconds gate) (:boot-polls gate)]) "@item-06-036")
          (is (= (str "http://127.0.0.1:" port)
                 (clojure.string/trim (slurp (io/file root "probe.args")))) "@item-06-036")
          (is (= (:candidate-digest run)
                 (get-in (some #(when (= "install" (:effect %)) %) (:effect-results run))
                         [:events 0 :candidate-digest])) "@item-06-037"))
        (finally (stop-process session))))))

(defn stdio-gate-fixture! []
  (let [f0 (fixture! false)
        root (:root f0)]
    (write-file (:config f0)
                "PLAN_DIR=plan\nAPP_DIR=impl\nFENCED_PATHS=impl\nAPP_SEAM=stdio\nAPP_PROBE=harness/probe.sh\n")
    (write-file (io/file root "suite-mode") "pass\n")
    (write-file (io/file root "probe-mode") "pass\n")
    (write-file (io/file root "store-mode") "pass\n")
    (executable (io/file (:repo f0) "harness/probe.sh")
                (str "#!/bin/sh\nset -eu\necho probe >> " (io/file root "probe.log")
                     "\nif [ \"$(cat " (io/file root "probe-mode") ")\" = fail ]; then\n"
                     "echo no response within the 30s boot budget\nexit 1\nfi\n"
                     "echo answered as the context\n"))
    (executable (io/file root "store-check")
                (str "#!/bin/sh\nset -eu\necho store >> " (io/file root "store.log")
                     "\nif [ \"$(cat " (io/file root "store-mode") ")\" = fail ]; then\n"
                     "echo FAIL event 7 was not written inside a run of the ORC workflow\nexit 1\nfi\n"
                     "echo store-ok\n"))
    (executable (io/file (:candidate f0) "test.sh")
                (str "#!/bin/sh\nset -eu\nenv > " (io/file root "suite.env")
                     "\nif [ \"$(cat " (io/file root "suite-mode") ")\" = fail ]; then\n"
                     "echo 3 of 65 tests failed\nexit 1\nfi\n"))
    (executable (io/file (:candidate f0) "start.sh") "#!/bin/sh\nexit 0\n")
    (recommit! f0)))

(deftest item-06-041-042-043-stdio-failures-preserve-order
  (let [f (stdio-gate-fixture!)
        root (:root f)
        env (-> (environment f false)
                (dissoc "LOYLY_GATE_CMD")
                (assoc "LOYLY_STORE_CHECK_CMD" (str (io/file root "store-check"))))
        session (start-process f env)]
    (try
      (write-file (io/file root "suite-mode") "fail\n")
      (let [run (run-and-progress! session f "suite-red")
            event (get-in run [:effect-results 8 :events 0])]
        (is (= "failed" (:status run)) "@item-06-041")
        (is (= "suite-red" (:reason event)) "@item-06-041")
        (is (not (.exists (io/file root "probe.log"))) "@item-06-041")
        (is (not (.exists (io/file root "store.log"))) "@item-06-041")
        (is (not (clojure.string/includes? (slurp (io/file root "suite.env")) "LOYLY_"))
            "@item-06-041")
        (is (not (clojure.string/includes? (slurp (io/file root "suite.env")) "GATE_STORE="))
            "@item-06-041"))
      (write-file (io/file root "suite-mode") "pass\n")
      (write-file (io/file root "probe-mode") "fail\n")
      (let [run (run-and-progress! session f "probe-red")
            event (get-in run [:effect-results 8 :events 0])]
        (is (= "failed" (:status run)) "@item-06-042")
        (is (= "identity-probe-failed" (:reason event)) "@item-06-042")
        (is (clojure.string/includes? (:detail event) "no response within the 30s boot budget")
            "@item-06-042")
        (is (not (.exists (io/file root "store.log"))) "@item-06-042"))
      (write-file (io/file root "probe-mode") "pass\n")
      (write-file (io/file root "store-mode") "fail\n")
      (let [run (run-and-progress! session f "store-red")
            event (get-in run [:effect-results 8 :events 0])]
        (is (= "failed" (:status run)) "@item-06-043")
        (is (= "identity-probe-failed" (:reason event)) "@item-06-043")
        (is (clojure.string/includes? (:detail event)
                                      "FAIL event 7 was not written inside a run of the ORC workflow")
            "@item-06-043")
        (is (= "gate-attempts-exhausted" (get-in run [:cycle :failure :reason]))
            "@item-06-043"))
      (finally (stop-process session)))))

(deftest item-06-045-missing-stdio-store-check-halts
  (let [f (stdio-gate-fixture!)
        env (-> (environment f false)
                (dissoc "LOYLY_GATE_CMD")
                (assoc "LOYLY_STORE_CHECK_CMD" (str (io/file (:root f) "absent-check"))))
        session (start-process f env)]
    (try
      (let [run (run-and-progress! session f "no-store-check")]
        (is (= "halted" (:status run)) "@item-06-045")
        (is (= "gate" (get-in run [:halt :effect])) "@item-06-045")
        (is (= "effect-could-not-run" (get-in run [:halt :reason])) "@item-06-045")
        (is (not-any? #(= "gate" (:effect %)) (:effect-results run)) "@item-06-045"))
      (finally (stop-process session)))))

(deftest item-06-046-stdio-harness-digest-covers-store-check
  (let [f (stdio-gate-fixture!)
        root (:root f)
        check (str (io/file root "store-check"))]
    (write-file (io/file root "probe-mode") "fail\n")
    (let [env (-> (environment f false) (dissoc "LOYLY_GATE_CMD")
                  (assoc "LOYLY_STORE_CHECK_CMD" (str check " one")))
          session (start-process f env)]
      (try
        (let [run (run-and-progress! session f "digest-one")]
          (is (= "regeneration-cycle/harness-self-check-passed"
                 (get-in run [:effect-results 3 :events 0 :type])) "@item-06-046"))
        (finally (stop-process session))))
    (let [env (-> (environment f false) (dissoc "LOYLY_GATE_CMD")
                  (assoc "LOYLY_STORE_CHECK_CMD" (str check " two")))
          session (start-process f env)]
      (try
        (let [run (run-and-progress! session f "digest-two")
              one (get-in (rpc! session 104 "cycle-runner/run-progress"
                                {:run-id "digest-one"})
                          [:result :run :effect-results 3 :events 0 :harness-digest])
              two (get-in run [:effect-results 3 :events 0 :harness-digest])]
          (is (= "regeneration-cycle/harness-self-check-passed"
                 (get-in run [:effect-results 3 :events 0 :type])) "@item-06-046")
          (is (not= one two) "@item-06-046"))
        (finally (stop-process session))))))

(defn -main [& _]
  (when (.exists tmp)
    (runner/delete-tree! tmp))
  (.mkdirs tmp)
  (let [result (try
                 (run-tests 'loyly.cycle-runner-test)
                 (finally (runner/delete-tree! tmp)))]
    (System/exit (if (zero? (+ (:fail result) (:error result))) 0 1))))
