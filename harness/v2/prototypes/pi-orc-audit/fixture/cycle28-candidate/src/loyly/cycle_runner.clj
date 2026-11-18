(ns loyly.cycle-runner
  (:require [clojure.edn :as edn]
            [clojure.java.io :as io]
            [clojure.string :as str]
            [clojure.walk :as walk]
            [clojure.data.json :as json]
            [ai.obney.grain.event-model.interface :as event-model]
            [ai.obney.grain.event-store-v3.interface :as es]
            [ai.obney.grain.event-store-v3.interface.event-definition :as event-definition]
            [ai.obney.grain.event-store-sqlite-v3.interface]
            [ai.obney.grain.command-processor-v2.interface :as command]
            [ai.obney.grain.query-processor.interface :as query]
            [ai.obney.grain.read-model-processor-v2.interface :as read-model]
            [ai.obney.grain.periodic-task.interface :as periodic]
            [ai.obney.grain.schema-util.interface :as schema-util]
            [ai.obney.grain.event-model-validator.interface :as validator]
            [ai.obney.grain.kv-store.interface :as kv]
            [ai.obney.grain.kv-store-lmdb.interface :as lmdb]
            [ai.obney.grain.todo-processor-v2.interface :as todo]
            [ai.obney.orc.orc-service.interface :as orc]
            [ai.obney.orc.evaluation.interface])
  (:import [java.io File]
           [java.security MessageDigest]
           [java.time Instant]
           [java.util UUID]))

(def tenant-id #uuid "b9e9183a-a7cf-49bb-8a56-c28e065b19ac")
(defonce system (atom nil))
(defonce runs (atom []))
(defonce active (atom nil))
(defonce start-lock (Object.))
(defonce grade-sheet-id (atom nil))

(defn now [] (java.util.Date.))
(defn digest [s]
  (let [md (MessageDigest/getInstance "SHA-256")]
    (.update md (.getBytes (str s) "UTF-8"))
    (str "sha256:" (apply str (map #(format "%02x" (bit-and % 255)) (.digest md))))))
(defn file-digest [path] (digest (slurp path :encoding "ISO-8859-1")))
(defn shahex [s] (subs (digest s) 7))

(defn merge-deep [a b]
  (merge-with (fn [x y] (if (and (map? x) (map? y)) (merge-deep x y) y)) a b))

(defn model []
  (reduce (fn [m ^File file]
            (merge-deep m (edn/read-string (slurp file))))
          {}
          (sort-by str (filter #(.isFile ^File %)
                               (file-seq (io/file "event-model"))))))

(defn evaluated-schema [schema]
  (walk/postwalk (fn [v]
                   (if (symbol? v)
                     (case (str v)
                       "inst?" inst?
                       "pos-int?" pos-int?
                       "int?" int?
                       v)
                     v)) schema))

(declare read-model-reducer query-handler)

(defn register-model! []
  (doseq [[area body] (model)]
    (event-model/register-event-model! area body)
    (doseq [[event {:keys [schema description]}] (:events body)]
      (event-definition/register-event-definition!
       event description {:schema (evaluated-schema schema)}
       {:ns "loyly.cycle-runner" :file "event-model" :line 1}))
    (doseq [[name {:keys [schema reads produces]}] (:commands body)]
      (schema-util/register! {name (evaluated-schema schema)})
      (command/register-command! name
                                 (fn [_] {:command-result/events []})
                                 {:grain.event-model/reads reads
                                  :grain.event-model/produces produces}))
    (doseq [[name {:keys [schema reads]}] (:queries body)]
      (schema-util/register! {name (evaluated-schema schema)})
      (query/register-query! name
                             (partial query-handler name)
                             {:grain.event-model/reads reads}))
    (doseq [[name {:keys [schema consumes]}] (:read-models body)]
      (read-model/register-read-model!
       name (partial read-model-reducer name)
       (cond-> {:events consumes :version 1}
         schema (assoc :schema (evaluated-schema schema)))))
    (doseq [[name {:keys [subscribes reads produces]}] (:todo-processors body)]
      (todo/register-processor! name (fn [_] {})
                                {:topics subscribes
                                 :grain.event-model/reads reads
                                 :grain.event-model/produces produces}))
    (doseq [[name {:keys [schedule produces]}] (:periodic-tasks body)]
      (periodic/register-periodic-trigger! name (fn [_ _] {})
                                           {:schedule schedule
                                            :grain.event-model/produces produces})))
  (validator/verify-or-throw!))

(defn read-model-reducer [name state event]
  (let [state (or state {})
        type (:event/type event)]
    (case name
      :cycle-runner/runs
      (case type
        :cycle-runner/run-started
        (assoc state (:run-id event)
               (select-keys (assoc event :status "running" :effects 0 :attempts 0)
                            [:run-id :cycle-id :cut-id :commit :status :effects :attempts]))
        :cycle-runner/effect-recorded
        (update state (:run-id event)
                (fn [run]
                  (cond-> (update run :effects (fnil inc 0))
                    (= "regenerate" (:effect event))
                    (assoc :attempts (:attempt event)
                           :candidate-digest (get-in event [:events 0 :candidate-digest])))))
        :cycle-runner/run-concluded
        (update state (:run-id event) assoc :status (:cycle-status event) :cycle (:cycle event))
        :cycle-runner/run-halted
        (update state (:run-id event) assoc :status "halted"
                :halt (select-keys event [:effect :reason :detail]))
        state)

      :cycle-runner/effect-results
      (if (= type :cycle-runner/effect-recorded)
        (update state (:run-id event) (fnil conj [])
                (select-keys event [:run-id :position :effect :attempt :context
                                    :method :outcome :refusal :events :detail]))
        state)

      :specification/stamped-items
      (case type
        :specification/scenario-stamped
        (let [slice (:slice event)
              n (Long/parseLong (last (str/split (:item-id event) #"-")))
              item (select-keys event [:item-id :source :line :title])]
          (update state slice
                  (fn [row]
                    (-> (or row {:slice slice :next-number 1 :items []})
                        (update :next-number max (inc n))
                        (update :items conj item)))))
        :specification/empty-title-headings-reported
        (update state (:slice event) assoc :empty-title-lines (:lines event))
        state)

      :cycle-preparation/source-cuts
      (if (= type :cycle-preparation/source-cut-pinned)
        (assoc state (:cut-id event)
               (select-keys event [:cut-id :commit :tree-digest :pinned-at])) state)

      :measurement/checklists
      (if (= type :measurement/checklist-derived)
        (assoc state (:cut-id event)
               (select-keys event [:cut-id :selection-id :checklist-digest :items :total])) state)

      :measurement/cycle-measurements
      (case type
        :measurement/measurement-filed
        (assoc state (:cycle-id event)
               (-> (select-keys event [:cycle-id :cut-id :candidate-digest :total
                                       :passes :unreached :items])
                   (assoc :status "filed")))
        :measurement/score-stage-failed
        (assoc state (:cycle-id event)
               {:cycle-id (:cycle-id event) :status "score-stage-failed"
                :refusal (:refusal event)})
        state)

      :measurement/scoreboards
      (if (= type :measurement/scoreboard-reported)
        (assoc state (:cycle-id event)
               (select-keys event [:cycle-id :selection-id :passes :total :rate
                                   :previous-cycle-id :previous-selection-id
                                   :new-items :dropped-items])) state)

      state)))

(defn judge-scores-for [run-id context]
  (->> (into [] (es/read (:event-store context)
                         {:tenant-id tenant-id :types #{:judge/score-emitted}}))
       (filter #(= run-id (get-in % [:judge-config :run-id])))
       (mapv (fn [event]
               {:item-id (subs (:judge-name event) (count "checklist/"))
                :verdict (if (= 1.0 (:score event)) "pass" "fail")
                :reason (:feedback event)}))))

(defn query-handler [name context]
  (let [params (:query context)
        project #(read-model/project context %)]
    {:query/result
     (case name
       :cycle-runner/run-progress
       (let [rows (project :cycle-runner/runs)
             results (project :cycle-runner/effect-results)
             enrich (fn [run]
                      (when run
                        (assoc run :effect-results (get results (:run-id run) [])
                                   :scores (judge-scores-for (:run-id run) context))))]
         (if-let [run-id (:run-id params)]
           {:run (enrich (get rows run-id))}
           {:runs (mapv enrich (vals rows))}))

       :specification/stamped-items
       (let [rows (project :specification/stamped-items)]
         (if-let [slice (:slice params)]
           {:slice (get rows slice)}
           {:slices (vec (vals rows))}))

       :cycle-preparation/source-cuts
       {:cuts (vec (vals (project :cycle-preparation/source-cuts)))}

       :measurement/checklist
       {:checklist (get (project :measurement/checklists) (:cut-id params))}

       :measurement/cycle-measurement
       {:measurement (get (project :measurement/cycle-measurements) (:cycle-id params))}

       :measurement/scoreboard
       {:scoreboard (get (project :measurement/scoreboards) (:cycle-id params))}

       nil)}))

(defn append! [type body]
  (let [sys @system
        event (es/->event {:type type :body body :tags #{}})
        result (es/append (:store sys) {:tenant-id tenant-id :events [event]})]
    (when (map? result)
      (when (:cognitect.anomalies/category result)
        (throw (ex-info "Event append failed" {:result result}))))
    event))

(defn shell [dir & argv]
  (let [pb (ProcessBuilder. ^java.util.List (mapv str argv))]
    (.directory pb (io/file dir))
    (.redirectErrorStream pb true)
    (let [p (.start pb)
          out (slurp (.getInputStream p))
          code (.waitFor p)]
      {:exit code :out (str/trim out)})))

(defn commit? [repo commit]
  (and (re-matches #"[0-9a-f]{40,64}" (str commit))
       (zero? (:exit (shell repo "git" "cat-file" "-e" (str commit "^{commit}"))))))

(defn config [path]
  (into {}
        (keep (fn [line]
                (when-let [[_ k v] (re-matches #"([A-Z_]+)=(.*)" line)]
                  [k (str/replace v #"^['\"]|['\"]$" "")]))
              (str/split-lines (slurp path)))))

(defn start-input [params]
  (let [env (into {} (System/getenv))
        cfg (config (get env "LOYLY_HARNESS_CONFIG"))
        repo (get env "LOYLY_PROJECT_REPO")
        image (get cfg "BUILDER_IMAGE")
        stored-runs (vals (read-model/project (:context @system) :cycle-runner/runs))]
    (cond
      (some #(= (:run-id %) (:run-id params)) stored-runs) {:refusal "run-already-started"}
      (some #(= (:cycle-id %) (:cycle-id params)) stored-runs) {:refusal "cycle-already-run"}
      @active {:refusal "run-in-progress"}
      (not (commit? repo (:commit params))) {:refusal "not-a-commit"}
      (and (seq image)
           (not (.isDirectory (io/file (get env "LOYLY_BUILDER_IMAGES" "") image))))
      {:refusal "builder-image-missing"}
      :else {:env env :config cfg :repo repo})))

(defn event-results [run-id]
  (get (first (filter #(= run-id (:run-id %)) @runs)) :effect-results []))

(declare run-for)

(defn record! [run-id effect context method outcome events detail & [refusal]]
  (let [position (inc (count (event-results run-id)))
        row (cond-> {:run-id run-id :position position :effect effect
                     :attempt (if (= effect "regenerate") 1 (:attempts (run-for run-id)))
                     :context context :method method :outcome outcome
                     :events events :detail detail :performed-at (now)}
              refusal (assoc :refusal refusal))]
    (append! :cycle-runner/effect-recorded row)
    (swap! runs (fn [rs] (mapv (fn [r]
                                 (if (= run-id (:run-id r))
                                   (-> r (update :effects inc)
                                       (update :effect-results conj
                                               (dissoc row :performed-at)))
                                   r)) rs)))
    row))

(defn halt! [run-id effect reason detail]
  (append! :cycle-runner/run-halted
           {:run-id run-id :effect effect :reason reason :detail detail :halted-at (now)})
  (swap! runs (fn [rs] (mapv (fn [r] (if (= run-id (:run-id r))
                                      (assoc r :status "halted"
                                             :halt {:effect effect :reason reason :detail detail}) r)) rs))))

(defn mark-halt! [run-id effect reason detail]
  (swap! runs (fn [rs] (mapv (fn [r] (if (= run-id (:run-id r))
                                      (assoc r :pending-halt {:effect effect :reason reason :detail detail}) r)) rs))))

(defn run-for [run-id] (first (filter #(= run-id (:run-id %)) @runs)))

(defn plan-slices [repo commit cfg]
  (let [plan (get cfg "PLAN_DIR" "docs/plan")
        ls (:out (shell repo "git" "ls-tree" "--name-only" (str commit ":" plan)))
        names (str/split ls #"\s+")
        wanted (set (str/split (str/trim (get cfg "PLAN_SLICES" "")) #"\s+"))]
    (->> names
         (keep (fn [name]
                 (when-let [[_ slice] (re-matches #"([0-9]+)-.*" name)]
                   (when (or (empty? (get cfg "PLAN_SLICES" "")) (contains? wanted slice))
                     {:slice slice :path (str plan "/" name "/spec.feature")}))))
         vec)))

(defn git-file [repo commit path]
  (loop [path path hops 0]
    (when (> hops 8)
      (throw (ex-info "Too many slice links" {:path path})))
    (let [parts (str/split path #"/")
          link (first
                (for [n (range 1 (inc (count parts)))
                      :let [prefix (str/join "/" (take n parts))
                            entry (:out (shell repo "git" "ls-tree" commit prefix))]
                      :when (str/starts-with? entry "120000 ")]
                  n))]
      (if link
        (let [prefix (str/join "/" (take link parts))
              target (str/trim (:out (shell repo "git" "show" (str commit ":" prefix))))
              parent (.getParent (.toPath (io/file prefix)))
              resolved (str (.normalize (.resolve parent target)))
              path' (str/join "/" (concat [resolved] (drop link parts)))]
          (when (or (str/starts-with? path' "../") (str/starts-with? path' "/"))
            (throw (ex-info "Slice link escapes cut" {:path path :target target})))
          (recur path' (inc hops)))
        (let [{:keys [exit out]} (shell repo "git" "show" (str commit ":" path))]
          (if (zero? exit) out
              (throw (ex-info "Cannot read plan" {:path path :output out}))))))))

(defn parse-scenarios [slice source text]
  (let [lines (str/split-lines text)]
    (loop [indexed (map-indexed vector lines) tag nil out []]
      (if-let [[n line] (first indexed)]
        (if-let [[_ id] (re-find #"@item-([0-9]+-[0-9]{3,})" line)]
          (recur (rest indexed) id out)
          (if-let [[_ title] (re-matches #"\s*Scenario(?: Outline)?:\s*(.*?)\s*" line)]
            (recur (rest indexed) nil
                   (conj out {:item-id tag :slice slice :source source
                              :title title :line (inc n)}))
            (recur (rest indexed) tag out)))
        out))))

(defn stamp! [{:keys [params env config repo]}]
  (let [run-id (:run-id params)
        slices (plan-slices repo (:commit params) config)
        scenarios (mapcat (fn [{:keys [slice path]}]
                            (parse-scenarios slice path (git-file repo (:commit params) path)))
                          slices)
        known (->> (vals (read-model/project (:context @system) :specification/stamped-items))
                   (mapcat :items) (map :item-id) set)
        events (mapv (fn [s]
                       (append! :specification/scenario-stamped
                                {:item-id (:item-id s) :slice (:slice s)
                                 :source (:source s) :line (:line s)
                                 :title (:title s) :stamped-at (now)}))
                     (filter #(and (:item-id %) (not (contains? known (:item-id %)))) scenarios))]
    (record! run-id "stamp" "specification" "specification/stamp-slice"
             "recorded" events "Imported stamped scenarios")
    (if (some #(nil? (:item-id %)) scenarios)
      (mark-halt! run-id "stamp" "refused-before-the-cycle" "Unstamped scenario in approved cut")
      (swap! runs (fn [rs] (mapv (fn [r] (if (= run-id (:run-id r))
                                          (assoc r :items (vec scenarios)) r)) rs))))))

(defn pin! [params repo]
  (let [run-id (:run-id params)
        tree (:out (shell repo "git" "rev-parse" (str (:commit params) "^{tree}")))
        event (append! :cycle-preparation/source-cut-pinned
                       {:cut-id (:cut-id params) :commit (:commit params)
                        :tree-digest tree :pinned-at (now)})]
    (record! run-id "pin" "cycle-preparation" "cycle-preparation/pin-source-cut"
             "recorded" [event] "Pinned source cut")))

(defn checklist! [params]
  (let [run-id (:run-id params)
        scenarios (:items (run-for run-id))
        items (mapv (fn [s] (select-keys
                              (assoc s :scenario-digest (digest (:title s)) :rule nil)
                              [:item-id :scenario-digest :rule :source :title])) scenarios)]
    (if (empty? items)
      (do (record! run-id "checklist" "measurement" "measurement/derive-checklist"
                   "refused" [] "No selected scenarios" "empty-checklist")
          (mark-halt! run-id "checklist" "refused-before-the-cycle" "empty-checklist"))
      (let [event (append! :measurement/checklist-derived
                           {:cut-id (:cut-id params) :selection-id (:selection-id params)
                            :checklist-digest (digest (pr-str items))
                            :items items :total (count items) :skipped-slices []
                            :derived-at (now)})]
        (record! run-id "checklist" "measurement" "measurement/derive-checklist"
                 "recorded" [event] "Derived checklist")
        (swap! runs (fn [rs] (mapv (fn [r] (if (= run-id (:run-id r))
                                      (assoc r :checklist items :checklist-digest (:checklist-digest event)) r)) rs)))))))

(defn grader-digest [env]
  (let [rubric (get env "LOYLY_GRADER_RUBRIC")
        host (get env "LOYLY_GRADER_HOST")
        policy (get env "LOYLY_GRADER_HOST_POLICY")
        model (get env "LOYLY_GRADER_MODEL" "")
        lines ["cycle-runner/grade.v2" "singleton-id-verdict-evidence-v1"
               (shahex (slurp rubric :encoding "ISO-8859-1"))
               (shahex (slurp host :encoding "ISO-8859-1"))
               (shahex (slurp policy :encoding "ISO-8859-1")) model]]
    (digest (str (str/join "\n" lines) "\n"))))

(defn grader! [params env]
  (let [digest (grader-digest env)]
    (if (some #{digest} (:grader-digests params))
      (swap! runs (fn [rs] (mapv (fn [r] (if (= (:run-id params) (:run-id r))
                                          (assoc r :grader-digest digest) r)) rs)))
      (mark-halt! (:run-id params) "grader" "refused-before-the-cycle"
                  (str "Unapproved grader digest " digest)))))

(defn update-run! [run-id f]
  (swap! runs (fn [rs] (mapv (fn [r] (if (= run-id (:run-id r)) (f r) r)) rs))))

(defn stop-process-tree! [^Process p]
  (with-open [stream (.descendants (.toHandle p))]
    (doseq [^java.lang.ProcessHandle child (reverse (vec (iterator-seq (.iterator stream))))]
      (.destroyForcibly child)))
  (.destroyForcibly p)
  (.waitFor p 2 java.util.concurrent.TimeUnit/SECONDS))

(defn perform
  ([dir env argv] (perform dir env argv nil false))
  ([dir env argv timeout-ms] (perform dir env argv timeout-ms false))
  ([dir env argv timeout-ms clean-env?]
   (let [pb (ProcessBuilder. ^java.util.List (mapv str argv))]
     (.directory pb (io/file dir))
     (.redirectErrorStream pb true)
     (when clean-env?
       (doseq [key (vec (.keySet (.environment pb)))
               :when (or (str/starts-with? key "LOYLY_") (= key "GATE_STORE"))]
         (.remove (.environment pb) key)))
     (doseq [[k v] env] (.put (.environment pb) k (str v)))
     (let [p (.start pb)
           finished? (if timeout-ms
                       (.waitFor p (long timeout-ms) java.util.concurrent.TimeUnit/MILLISECONDS)
                       (do (.waitFor p) true))]
       (when-not finished? (stop-process-tree! p))
       {:exit (if finished? (.exitValue p) 124)
        :out (try (str/trim (slurp (.getInputStream p)))
                  (catch java.io.IOException _ ""))}))))

(defn command-parts [text]
  (vec (remove empty? (str/split (str/trim (or text "")) #"\s+"))))

(defn fail-cycle! [params stage reason detail]
  (let [run-id (:run-id params)
        cycle-id (:cycle-id params)
        candidate (:candidate-digest (run-for run-id))
        failure {:stage stage :reason reason :detail detail}
        event (append! :regeneration-cycle/cycle-failed
                       (cond-> {:cycle-id cycle-id :stage stage :reason reason
                                :detail detail :concluded-at (now)}
                         candidate (assoc :candidate-digest candidate)))]
    (when-not (contains? #{"harness-self-check-failed" "score-stage-failed"} reason)
      (record! run-id "fail-cycle" "regeneration-cycle" "regeneration-cycle/fail-cycle"
               "recorded" [event] detail))
    (update-run! run-id #(assoc % :pending-cycle {:cycle-id cycle-id :stage "result"
                                                  :status "failed" :attempts (:attempts %)
                                                  :failure failure}))))

(defn self-check! [params env cfg repo occasion attempt]
  (let [run-id (:run-id params)
        cmd (get env "LOYLY_SELF_CHECK_CMD" "")
        parts (remove empty? (str/split cmd #"\s+"))
        result (if (seq parts) (perform repo {} parts) {:exit 1 :out "No self-check command"})
        probe (get cfg "APP_PROBE" "")
        probe-text (try (git-file repo (:commit params) probe) (catch Throwable _ ""))
        gate-command (get env "LOYLY_GATE_CMD" "")
        extra (if (seq gate-command) gate-command
                  (if (= "stdio" (get cfg "APP_SEAM"))
                    (get env "LOYLY_STORE_CHECK_CMD" "") ""))
        harness (digest (str (slurp (get env "LOYLY_HARNESS_CONFIG")) cmd probe-text extra))
        common {:cycle-id (:cycle-id params) :cut-id (:cut-id params)
                :occasion occasion :attempt attempt :budget (:budget params)
                :harness-digest harness :checked-at (now)}
        skips (->> (str/split-lines (:out result))
                   (keep #(second (re-matches #"SKIP\s+(.*)" %))) vec)
        event (if (zero? (:exit result))
                (append! :regeneration-cycle/harness-self-check-passed
                         (assoc common :goldens-digest (digest "")
                                :identity-probe-digest (digest probe-text)
                                :skipped-checks skips
                                :grader-digests (:grader-digests params)))
                (append! :regeneration-cycle/harness-self-check-failed
                         (assoc common :failing-check (or (last (str/split-lines (:out result))) "self-check")
                                :detail (:out result) :reworded-goldens [])))]
    (record! run-id "self-check" "regeneration-cycle" "regeneration-cycle/record-harness-self-check"
             "recorded" [event] (:out result))
    (when-not (zero? (:exit result))
      (update-run! run-id #(assoc % :pending-failure {:stage "fence"
                                                       :reason "harness-self-check-failed"
                                                       :detail (:out result)})))))

(defn copy-tree! [source target]
  (let [src (.toPath (io/file source))
        dst (.toPath (io/file target))]
    (doseq [^File f (file-seq (io/file source))]
      (let [rel (.relativize src (.toPath f))
            to (.resolve dst rel)]
        (if (.isDirectory f)
          (java.nio.file.Files/createDirectories to (make-array java.nio.file.attribute.FileAttribute 0))
          (do (java.nio.file.Files/createDirectories (.getParent to) (make-array java.nio.file.attribute.FileAttribute 0))
              (java.nio.file.Files/copy (.toPath f) to
                                        (into-array java.nio.file.CopyOption
                                                    [java.nio.file.StandardCopyOption/REPLACE_EXISTING])))))))
  target)

(defn delete-tree! [path]
  (let [f (io/file path)]
    (when (.exists f)
      (doseq [^File x (reverse (file-seq f))] (.delete x)))))

(defn fence! [params env cfg repo]
  (let [run-id (:run-id params)
        dir (io/file (get env "LOYLY_RUNS_DIR") run-id)
        room (io/file dir "clean-room")
        archive (io/file dir "cut.tar")
        fenced (->> (str/split (get cfg "FENCED_PATHS" "") #"\s+") (remove empty?) vec)]
    (.mkdirs dir)
    (.mkdirs room)
    (let [out (perform repo {} ["git" "archive" "--format=tar" "--output" (.getAbsolutePath archive) (:commit params)])]
      (when-not (zero? (:exit out)) (throw (ex-info "git archive failed" out))))
    (let [out (perform (.getAbsolutePath room) {} ["tar" "-xf" (.getAbsolutePath archive)])]
      (when-not (zero? (:exit out)) (throw (ex-info "tar failed" out))))
    (if (or (empty? fenced)
            (some #(not (.exists (io/file room %))) fenced))
      (do
        (record! run-id "fence" "regeneration-cycle" "regeneration-cycle/prove-clean-room"
                 "refused" [] "Fenced path did not match" "fenced-path-matched-nothing")
        (update-run! run-id #(assoc % :pending-failure {:stage "fence" :reason "fence-refused"
                                                         :detail "Fenced path did not match"})))
      (do
        (doseq [p fenced] (delete-tree! (io/file room p)))
        (perform (.getAbsolutePath room) {} ["git" "init" "-q"])
        (perform (.getAbsolutePath room) {} ["git" "add" "."])
        (let [entries (str/split-lines
                       (:out (shell repo "git" "ls-tree" "-r" (:commit params))))]
          (doseq [entry entries
                  :let [[_ target path] (re-matches #"160000 commit ([0-9a-f]+)\t(.+)" entry)]
                  :when (and target
                             (not-any? #(or (= path %)
                                            (str/starts-with? path (str % "/"))) fenced))]
            (let [out (perform (.getAbsolutePath room) {}
                               ["git" "update-index" "--add" "--cacheinfo"
                                (str "160000," target "," path)])]
              (when-not (zero? (:exit out))
                (throw (ex-info "Could not preserve gitlink" {:path path :output out}))))))
        (perform (.getAbsolutePath room)
                 {"GIT_AUTHOR_NAME" "Runner" "GIT_AUTHOR_EMAIL" "runner@example.org"
                  "GIT_COMMITTER_NAME" "Runner" "GIT_COMMITTER_EMAIL" "runner@example.org"}
                 ["git" "commit" "-qm" "clean-room"])
        (let [commit (:out (shell (.getAbsolutePath room) "git" "rev-parse" "HEAD"))
              event (append! :regeneration-cycle/clean-room-proved
                             {:cycle-id (:cycle-id params) :cut-id (:cut-id params)
                              :clean-room-commit commit :fenced-paths fenced :proved-at (now)})]
          (record! run-id "fence" "regeneration-cycle" "regeneration-cycle/prove-clean-room"
                   "recorded" [event] (.getAbsolutePath room))
          (update-run! run-id #(assoc % :clean-room (.getAbsolutePath room))))))))

(defn render! [params env]
  (let [run-id (:run-id params)
        seed (get env "LOYLY_BUILDER_INSTRUCTION" "")
        endpoint (get env "LOYLY_MODEL_API_BASE")
        model (get env "LOYLY_RENDER_MODEL" "")
        rendered (if (seq endpoint)
                   (let [url (str (str/replace endpoint #"/$" "") "/chat/completions")
                         client (java.net.http.HttpClient/newHttpClient)
                         body (json/write-str {:model model :messages [{:role "user" :content seed}]})
                         request (-> (java.net.http.HttpRequest/newBuilder (java.net.URI/create url))
                                     (.header "Content-Type" "application/json")
                                     (.POST (java.net.http.HttpRequest$BodyPublishers/ofString body))
                                     (.build))
                         response (.send client request (java.net.http.HttpResponse$BodyHandlers/ofString))
                         content (get-in (json/read-str (.body response) :key-fn keyword)
                                         [:choices 0 :message :content])]
                     (or (second (re-find #"(?s)\[\[ ## builder-instruction ## \]\]\s*(.*?)\s*\[\[ ## completed ## \]\]" content))
                         (second (re-find #"(?s)\[\[ ## instruction ## \]\]\s*(.*?)\s*\[\[ ## completed ## \]\]" content))
                         content))
                   seed)]
    (update-run! run-id #(assoc % :builder-instruction rendered))))

(defn candidate-digest [root]
  (let [base (.toPath (io/file root))]
    (digest (apply str (for [^File f (sort-by str (filter #(.isFile ^File %) (file-seq (io/file root))))]
                         (str (.toString (.relativize base (.toPath f))) "\t"
                              (shahex (slurp f :encoding "ISO-8859-1")) "\n"))))))

(defn regenerate! [params env cfg]
  (let [run-id (:run-id params)
        dir (io/file (get env "LOYLY_RUNS_DIR") run-id)
        room (io/file dir "builder-1")
        app (get cfg "APP_DIR")
        instruction (io/file dir "instruction.txt")
        image (get cfg "BUILDER_IMAGE")
        host (get env "LOYLY_BUILDER_HOST")]
    (copy-tree! (:clean-room (run-for run-id)) room)
    (spit instruction (:builder-instruction (run-for run-id)))
    (let [argv (cond-> [host (.getAbsolutePath room) (.getAbsolutePath instruction)]
                 (seq image) (conj (str (io/file (get env "LOYLY_BUILDER_IMAGES") image))))
          result (perform (.getAbsolutePath room)
                          {"LOYLY_BUILDER_SESSION_ID" (str run-id "/1")}
                          argv (* 1000 (get-in params [:budget :stage-timeouts-seconds :regenerate])))
          candidate (io/file room app)]
      (if (= 124 (:exit result))
        (update-run! run-id #(assoc % :pending-failure {:stage "regenerate"
                                                         :reason "budget"
                                                         :detail "regenerate timeout"}))
        (if-not (.isDirectory candidate)
        (update-run! run-id #(assoc % :pending-failure {:stage "regenerate"
                                                         :reason "candidate-not-regenerated"
                                                         :detail (:out result)}))
        (let [digest (candidate-digest candidate)
              event (append! :regeneration-cycle/candidate-regenerated
                             {:cycle-id (:cycle-id params) :attempt 1
                              :purpose "fresh-generation" :candidate-digest digest
                              :regenerated-at (now)})]
          (record! run-id "regenerate" "regeneration-cycle"
                   "regeneration-cycle/record-regenerated-candidate" "recorded"
                   [event] (:out result))
          (update-run! run-id #(assoc % :builder-room (.getAbsolutePath room)
                                        :candidate-digest digest :attempts 1))))))))

(defn install! [params env cfg]
  (let [run-id (:run-id params)
        run (run-for run-id)
        dir (io/file (get env "LOYLY_RUNS_DIR") run-id)
        room (io/file dir "gate-1")
        candidate (io/file dir "candidate-1")]
    (copy-tree! (:clean-room run) room)
    (copy-tree! (io/file (:builder-room run) (get cfg "APP_DIR")) candidate)
    (when-not (seq (get env "LOYLY_GATE_CMD"))
      (copy-tree! candidate (io/file room (get cfg "APP_DIR"))))
    (let [event (append! :regeneration-cycle/candidate-installed-in-gate-room
                         {:cycle-id (:cycle-id params) :attempt 1
                          :candidate-digest (:candidate-digest run)
                          :purpose "fresh-generation" :gate-room (.getAbsolutePath room)
                          :installed-at (now)})]
      (record! run-id "install" "regeneration-cycle"
               "regeneration-cycle/install-candidate-in-gate-room" "recorded"
               [event] (.getAbsolutePath candidate))
      (update-run! run-id #(assoc % :gate-room (.getAbsolutePath room)
                                    :candidate-path (.getAbsolutePath candidate))))))

(defn stdio-gate-result [params env cfg repo run evidence]
  (let [room (:gate-room run)
        app (get cfg "APP_DIR")
        suite (io/file room app "test.sh")
        launch (io/file room app "start.sh")
        probe-path (get cfg "APP_PROBE" "harness/probe.sh")
        probe-mode (:out (shell repo "git" "ls-tree" (:commit params) probe-path))
        probe (io/file (get env "LOYLY_RUNS_DIR") (:run-id params) "cut-probe.sh")
        gate-store (io/file evidence "events.sqlite")
        deadline (* 1000 (get-in params [:budget :stage-timeouts-seconds :gate]))]
    (cond
      (not (and (.canExecute suite) (.canExecute launch)))
      {:exit 1 :out "BOOT 1 30\ncontract-missing test.sh or start.sh"}

      (not (str/starts-with? probe-mode "100755 "))
      {:exit 1 :out "BOOT 1 30\nidentity-probe-missing cut probe"}

      :else
      (do
        (spit probe (git-file repo (:commit params) probe-path))
        (.setExecutable probe true)
        (let [suite-result (perform room {} [(.getAbsolutePath suite)] deadline true)]
          (if-not (zero? (:exit suite-result))
            {:exit 1 :out (str "BOOT 1 30\nsuite-red " (:out suite-result))}
            (let [probe-result (perform room {"GATE_STORE" (.getAbsolutePath gate-store)}
                                        [(.getAbsolutePath probe) (.getAbsolutePath launch) "30"]
                                        deadline true)]
              (if-not (zero? (:exit probe-result))
                {:exit 1 :out (str "BOOT 1 30\nidentity-probe-failed " (:out probe-result))}
                (let [parts (command-parts (get env "LOYLY_STORE_CHECK_CMD"))]
                  (when (empty? parts)
                    (throw (ex-info "Store check command is absent" {})))
                  (let [store-result (perform repo {} (conj parts (.getAbsolutePath gate-store))
                                              deadline true)]
                    (if-not (zero? (:exit store-result))
                      {:exit 1 :out (str "BOOT 1 30\nidentity-probe-failed " (:out store-result))}
                      {:exit 0 :out (str "BOOT 1 30\nANSWERED 1\n" (:out probe-result))})))))))))))

(defn http-response [url]
  (try
    (let [connection ^java.net.HttpURLConnection
          (.openConnection (java.net.URL. url))]
      (.setConnectTimeout connection 350)
      (.setReadTimeout connection 350)
      (.setRequestMethod connection "GET")
      (try
        (when (< (.getResponseCode connection) 400)
          (slurp (.getInputStream connection)))
        (finally (.disconnect connection))))
    (catch Exception _ nil)))

(defn http-gate-result [params env cfg run]
  (let [room (:gate-room run)
        app (get cfg "APP_DIR")
        suite (io/file room app "test.sh")
        launch (io/file room app "start.sh")
        probe (io/file room (get cfg "APP_PROBE" "harness/probe.sh"))
        port (get cfg "PORT" "8901")
        url (str "http://127.0.0.1:" port)
        deadline (* 1000 (get-in params [:budget :stage-timeouts-seconds :gate]))]
    (cond
      (not (and (.canExecute suite) (.canExecute launch)))
      {:exit 1 :out "BOOT 20 10\ncontract-missing test.sh or start.sh"}

      (not (.canExecute probe))
      {:exit 1 :out "BOOT 20 10\nidentity-probe-failed identity-probe-missing"}

      (some? (http-response url))
      {:exit 1 :out (str "BOOT 20 10\nseam-answered-before-boot " url)}

      :else
      (let [suite-result (perform room {} [(.getAbsolutePath suite)] deadline true)]
        (if-not (zero? (:exit suite-result))
          {:exit 1 :out (str "BOOT 20 10\nsuite-red " (:out suite-result))}
          (let [pb (ProcessBuilder. ^java.util.List [(.getAbsolutePath launch) (str port)])]
            (.directory pb (io/file room))
            (.redirectErrorStream pb true)
            (.redirectOutput pb java.lang.ProcessBuilder$Redirect/DISCARD)
            (doseq [key (vec (.keySet (.environment pb)))
                    :when (or (str/starts-with? key "LOYLY_") (= key "GATE_STORE"))]
              (.remove (.environment pb) key))
            (let [process (.start pb)]
              (try
                (loop [poll 1]
                  (let [page (http-response url)]
                    (cond
                      page
                      (if-not (str/includes? (str/lower-case page)
                                             (str/lower-case (get cfg "APP_MARKER" "")))
                        {:exit 1 :out (str "BOOT 20 10\nidentity-probe-failed marker absent at " url)}
                        (let [result (perform room {} [(.getAbsolutePath probe) url] deadline true)]
                          (if (zero? (:exit result))
                            {:exit 0 :out (str "BOOT 20 10\nANSWERED " poll "\n" (:out result))}
                            {:exit 1 :out (str "BOOT 20 10\nidentity-probe-failed " (:out result))})))

                      (= poll 20)
                      {:exit 1 :out (str "BOOT 20 10\nboot-budget-exhausted " url)}

                      :else
                      (do (Thread/sleep 500) (recur (inc poll))))))
                (finally (stop-process-tree! process))))))))))

(defn gate! [params env cfg repo]
  (let [run-id (:run-id params)
        run (run-for run-id)
        evidence (io/file (get env "LOYLY_RUNS_DIR") run-id "gate-evidence-1")
        _ (.mkdirs evidence)
        cmd (get env "LOYLY_GATE_CMD")
        result (if (seq cmd)
                 (perform repo {} [cmd (:gate-room run) (:candidate-path run)
                                   (.getAbsolutePath evidence)]
                          (* 1000 (get-in params [:budget :stage-timeouts-seconds :gate])))
                 (if (= "stdio" (get cfg "APP_SEAM"))
                   (stdio-gate-result params env cfg repo run evidence)
                   (http-gate-result params env cfg run)))
        lines (str/split-lines (:out result))
        boot (some #(re-matches #"BOOT\s+(\d+)\s+(\d+)" %) lines)
        answered (some #(re-matches #"ANSWERED\s+(\d+)" %) lines)
        last-line (last lines)]
    (if (= 124 (:exit result))
      (update-run! run-id #(assoc % :pending-failure {:stage "gate"
                                                       :reason "budget"
                                                       :detail "gate timeout"}))
    (if (zero? (:exit result))
      (let [event (append! :regeneration-cycle/gate-attempt-passed
                           {:cycle-id (:cycle-id params) :cut-id (:cut-id params)
                            :attempt 1 :candidate-digest (:candidate-digest run)
                            :boot-budget-seconds (if boot (Long/parseLong (nth boot 2)) 30)
                            :boot-polls (if boot (Long/parseLong (nth boot 1)) 1)
                            :answered-on-poll (if answered (Long/parseLong (nth answered 1)) 1)
                            :identity-probe-result (str last-line)
                            :evidence-root (.getAbsolutePath evidence) :passed-at (now)})]
        (record! run-id "gate" "regeneration-cycle" "regeneration-cycle/record-gate-attempt"
                 "recorded" [event] (:out result))
        (update-run! run-id #(assoc % :gate-passed true :evidence-root (.getAbsolutePath evidence))))
      (let [[_ reason detail] (re-matches #"(\S+)(?:\s+(.*))?" (or last-line ""))]
        (if (contains? #{"contract-missing" "suite-discovery-empty" "suite-red"
                         "boot-budget-exhausted" "identity-probe-failed"} reason)
          (let [event (append! :regeneration-cycle/gate-attempt-failed
                               {:cycle-id (:cycle-id params) :attempt 1
                                :candidate-digest (:candidate-digest run) :reason reason
                                :boot-budget-seconds (if boot (Long/parseLong (nth boot 2)) 30)
                                :boot-polls (if boot (Long/parseLong (nth boot 1)) 1)
                                :evidence-root (.getAbsolutePath evidence)
                                :detail (or detail "") :failed-at (now)})]
            (record! run-id "gate" "regeneration-cycle"
                     "regeneration-cycle/record-gate-attempt" "recorded"
                     [event] (:out result))
            (update-run! run-id #(assoc % :pending-failure {:stage "gate"
                                                             :reason "gate-attempts-exhausted"
                                                             :detail (:out result)})))
          (mark-halt! run-id "gate" "effect-could-not-run" (:out result))))))))

(defn grade-one! [params env cfg item]
  (let [run-id (:run-id params)
        run (run-for run-id)
        item-id (:item-id item)
        dir (io/file (get env "LOYLY_RUNS_DIR") run-id "grading" item-id)
        work (io/file dir "work")
        instruction (io/file dir "instruction.txt")
        rubric (get env "LOYLY_GRADER_RUBRIC")
        host (get env "LOYLY_GRADER_HOST")
        image (get env "LOYLY_GRADER_IMAGE" "")]
    (copy-tree! (:gate-room run) dir)
    (copy-tree! (:candidate-path run) (io/file dir (get cfg "APP_DIR")))
    (.mkdirs work)
    (io/copy (io/file rubric) (io/file dir "rubric.md"))
    (spit instruction (str "Grade only " item-id " (" (:title item) ") through its public seam. "
                           "Do not inspect candidate source. Write one verdict to work/verdicts.json.\n"))
    (let [result (perform (.getAbsolutePath dir)
                          {"GRADER_EVIDENCE_DIR" (.getAbsolutePath work)
                           "LOYLY_GRADER_MODEL" (get env "LOYLY_GRADER_MODEL" "")}
                          [host (.getAbsolutePath dir) (.getAbsolutePath instruction) image])
          row (try (first (json/read-str (slurp (io/file work "verdicts.json")) :key-fn keyword))
                   (catch Throwable _ nil))]
      (when (and (zero? (:exit result)) (= item-id (:id row))
                 (contains? #{"pass" "fail"} (:verdict row))
                 (seq (:evidence row)))
        {:item-id item-id :verdict (:verdict row) :reason (:evidence row)}))))

(defn grading-room! [params env cfg item]
  (let [run (run-for (:run-id params))
        dir (io/file (get env "LOYLY_RUNS_DIR") (:run-id params)
                     "grading" (:item-id item))
        work (io/file dir "work")
        instruction (io/file dir "instruction.txt")]
    (copy-tree! (:gate-room run) dir)
    (copy-tree! (:candidate-path run) (io/file dir (get cfg "APP_DIR")))
    (.mkdirs work)
    (io/copy (io/file (get env "LOYLY_GRADER_RUBRIC")) (io/file dir "rubric.md"))
    (spit instruction (str "Grade only " (:item-id item) " (" (:title item) ") through its public seam. "
                           "Do not inspect candidate source. Write one verdict to work/verdicts.json.\n"))
    (.getAbsolutePath dir)))

(defn clear-evidence-leaf [{:keys [inputs]}]
  {:grading-room (grading-room! (:params inputs) (:env inputs)
                                (:config inputs) (:item inputs))})

(defn grade-item-leaf [{:keys [inputs tick-id node-id]}]
  (let [params (:params inputs)
        env (:env inputs)
        item (:item inputs)
        dir (:grading-room inputs)
        host (get env "LOYLY_GRADER_HOST")
        work (io/file dir "work")
        item-count (max 1 (count (:checklist (run-for (:run-id params)))))
        score-seconds (get-in params [:budget :stage-timeouts-seconds :score])
        item-timeout-ms (max 1000 (long (/ (* 1000 score-seconds) item-count)))
        result (perform dir {"GRADER_EVIDENCE_DIR" (.getAbsolutePath work)
                             "LOYLY_GRADER_MODEL" (get env "LOYLY_GRADER_MODEL" "")}
                        [host dir (str (io/file dir "instruction.txt"))
                         (get env "LOYLY_GRADER_IMAGE" "")]
                        item-timeout-ms)
        row (try (first (json/read-str (slurp (io/file work "verdicts.json")) :key-fn keyword))
                 (catch Throwable _ nil))
        score (when (and (zero? (:exit result))
                         (= (:item-id item) (:id row))
                         (contains? #{"pass" "fail"} (:verdict row))
                         (seq (:evidence row)))
                {:item-id (:item-id item) :verdict (:verdict row) :reason (:evidence row)})]
    (when score
      (let [result (command/process-command
                    (assoc (:context @system)
                           :command {:command/name :evaluation/record-judge-score
                                     :command/id (random-uuid)
                                     :command/timestamp (java.time.OffsetDateTime/now)
                                     :sheet-id @grade-sheet-id
                                     :tick-id tick-id :node-id node-id
                                     :judge-name (str "checklist/" (:item-id item))
                                     :judge-config {:grader-digest (:grader-digest (run-for (:run-id params)))
                                                    :run-id (:run-id params)}
                                     :score (if (= "pass" (:verdict row)) 1.0 0.0)
                                     :feedback (:evidence row) :dimensions []
                                     :emitted-at (str (Instant/now))}))]
        (when (:cognitect.anomalies/category result)
          (throw (ex-info "Could not record judge score" {:result result})))
        (update-run! (:run-id params) #(update % :scores conj score))))
    {:grade-result (if score (json/write-str score) "")}))

(defn grade-workflow []
  (orc/workflow "cycle-runner/grade.v2"
    (orc/blackboard
     {:params (evaluated-schema (get-in (model) [:cycle-runner :commands :cycle-runner/start-run :schema]))
      :env [:map-of :string :string]
      :config [:map-of :string :string]
      :item [:map [:item-id :string] [:scenario-digest :string] [:rule [:maybe :string]]
             [:source :string] [:title :string]]
      :grading-room :string :grade-result :string})
    (orc/sequence "grade"
      (orc/code "clear-evidence" :fn "loyly.cycle-runner/clear-evidence-leaf"
                :reads [:params :env :config :item] :writes [:grading-room])
      (orc/code "grade-item" :fn "loyly.cycle-runner/grade-item-leaf"
                :reads [:params :env :item :grading-room] :writes [:grade-result]))))

(defn grade-all! [params env cfg]
  (let [run-id (:run-id params)
        scores (->> (:checklist (run-for run-id))
                    (map #(grade-one! params env cfg %)) (remove nil?) vec)]
    (update-run! run-id #(assoc % :scores scores))))

(defn file-verdicts! [params]
  (let [run-id (:run-id params)
        run (run-for run-id)
        scores (:scores run)]
    (if (empty? scores)
      (do (record! run-id "file-verdicts" "measurement"
                   "measurement/file-item-verdicts" "refused" []
                   "No valid item verdicts" "zero-verdicts")
          (update-run! run-id #(assoc % :pending-failure {:stage "score"
                                                           :reason "score-stage-failed"
                                                           :detail "zero-verdicts"})))
      (let [event (append! :measurement/item-verdicts-filed
                           {:cycle-id (:cycle-id params)
                            :candidate-digest (:candidate-digest run)
                            :grader-digest (:grader-digest run)
                            :verdicts (mapv #(-> % (assoc :evidence (:reason %)) (dissoc :reason)) scores)
                            :filed-at (now)})]
        (record! run-id "file-verdicts" "measurement" "measurement/file-item-verdicts"
                 "recorded" [event] "Verdicts filed")))))

(defn file-score! [params]
  (let [run-id (:run-id params)
        run (run-for run-id)
        scored (into {} (map (juxt :item-id identity) (:scores run)))
        items (mapv (fn [item]
                      (if-let [s (get scored (:item-id item))]
                        {:item-id (:item-id item) :verdict (:verdict s) :evidence (:reason s)}
                        {:item-id (:item-id item) :verdict "fail" :reason "unreached"
                         :evidence "unreached"})) (:checklist run))
        passes (count (filter #(= "pass" (:verdict %)) items))
        event (append! :measurement/measurement-filed
                       {:cycle-id (:cycle-id params) :cut-id (:cut-id params)
                        :selection-id (:selection-id params)
                        :candidate-digest (:candidate-digest run)
                        :checklist-digest (:checklist-digest run)
                        :grader-digests (:grader-digests params)
                        :total (count items) :passes passes
                        :unreached (count (filter #(= "unreached" (:reason %)) items))
                        :items items :superseded [] :filed-at (now)})]
    (record! run-id "file-score" "measurement" "measurement/file-score"
             "recorded" [event] (str passes "/" (count items)))
    (try
      (let [folder (io/file (get (System/getenv) "LOYLY_RUNS_DIR") run-id "allure-results")]
        (.mkdirs folder)
        (doseq [item (:items event)]
          (let [item-id (:item-id item)
                uuid (random-uuid)
                identity (str (UUID/nameUUIDFromBytes (.getBytes item-id "UTF-8")))
                passed? (= "pass" (:verdict item))
                reason (or (:reason item) (:evidence item))
                result (cond-> {:uuid (str uuid)
                                :historyId identity :testCaseId identity
                                :fullName (str "checklist/" item-id)
                                :name item-id :status (if passed? "passed" "failed")
                                :labels [{:name "tag" :value (str "item-" item-id)}]
                                :description (or (:evidence item) reason "")}
                         (not passed?) (assoc :statusDetails {:message reason}))]
            (spit (io/file folder (str uuid "-result.json")) (json/write-str result)))))
      (catch Throwable e
        (mark-halt! run-id "allure-results" "effect-could-not-run"
                    (or (.getMessage e) "Allure projection failed"))))
    (when-not (:pending-halt (run-for run-id))
      (let [previous (->> (into [] (es/read (:event-store (:context @system))
                                          {:tenant-id tenant-id
                                           :types #{:measurement/measurement-filed}}))
                          (filter #(and (= (:selection-id params) (:selection-id %))
                                        (not= (:cycle-id params) (:cycle-id %))))
                          last)
            previous-items (set (map :item-id (:items previous)))
            current-items (set (map :item-id items))
            scoreboard (append! :measurement/scoreboard-reported
                              {:cycle-id (:cycle-id params) :selection-id (:selection-id params)
                               :passes passes :total (count items)
                               :rate (format "%.1f" (* 100.0 (/ passes (count items))))
                               :previous-cycle-id (:cycle-id previous)
                               :previous-selection-id (:selection-id previous)
                               :new-items (vec (remove previous-items (map :item-id items)))
                               :dropped-items (vec (remove current-items (map :item-id (:items previous))))
                               :reported-at (now)})
          passed (append! :regeneration-cycle/cycle-passed
                          {:cycle-id (:cycle-id params)
                           :candidate-digest (:candidate-digest run)
                           :concluded-at (now)})]
      (update-run! run-id #(assoc % :pending-cycle {:cycle-id (:cycle-id params)
                                                    :stage "result" :status "passed"
                                                    :attempts 1 :failure nil}))))))

(defn conclude! [params]
  (let [run-id (:run-id params)
        cycle (:pending-cycle (run-for run-id))
        event (append! :cycle-runner/run-concluded
                       {:run-id run-id :cycle-id (:cycle-id params)
                        :cycle-status (:status cycle) :cycle cycle
                        :concluded-at (now)})]
    (update-run! run-id #(assoc % :status (:status cycle) :cycle cycle))))

(defn start-leaf [{:keys [inputs]}]
  (let [params (:params inputs)]
    (let [event (append! :cycle-runner/run-started
                         (assoc params :started-at (now)))]
    (swap! runs conj {:run-id (:run-id params) :cycle-id (:cycle-id params)
                     :cut-id (:cut-id params) :commit (:commit params)
                     :status "running" :effects 0 :attempts 0
                     :start-event event :effect-results [] :scores []})
    {:run-id (:run-id params)})))

(defn stamp-leaf [{:keys [inputs]}]
  (stamp! {:params (:params inputs) :env (:env inputs)
           :config (:config inputs) :repo (:repo inputs)})
  {:stage (if (:pending-halt (run-for (get-in inputs [:params :run-id]))) "halting" "running")})

(defn pin-leaf [{:keys [inputs]}]
  (pin! (:params inputs) (:repo inputs))
  {:stage "running"})

(defn checklist-leaf [{:keys [inputs]}]
  (checklist! (:params inputs))
  {:stage (if (:pending-halt (run-for (get-in inputs [:params :run-id]))) "halting" "running")
   :grade-items (or (:checklist (run-for (get-in inputs [:params :run-id]))) [])})

(defn grader-leaf [{:keys [inputs]}]
  (grader! (:params inputs) (:env inputs))
  {:stage (if (:pending-halt (run-for (get-in inputs [:params :run-id]))) "halting" "running")})

(defn halt-leaf [{:keys [inputs]}]
  (let [run-id (:run-id inputs)
        {:keys [effect reason detail]} (:pending-halt (run-for run-id))]
    (halt! run-id effect reason detail)
    {:stage "halted"}))

(defn stage-for [run-id]
  (let [run (run-for run-id)]
    (cond (:pending-halt run) "halting"
          (= "score-stage-failed" (get-in run [:pending-failure :reason])) "scoring-failed"
          (:pending-failure run) "failing"
          :else "running")))

(defn self-check-leaf [{:keys [inputs]}]
  (self-check! (:params inputs) (:env inputs) (:config inputs) (:repo inputs)
               "before-fence" 0)
  {:stage (stage-for (get-in inputs [:params :run-id]))})

(defn fence-leaf [{:keys [inputs]}]
  (fence! (:params inputs) (:env inputs) (:config inputs) (:repo inputs))
  {:stage (stage-for (get-in inputs [:params :run-id]))})

(defn render-leaf [{:keys [inputs]}]
  (let [params (:params inputs)]
    (try (render! params (:env inputs))
         (catch Throwable e
           (mark-halt! (:run-id params) "render" "effect-could-not-run"
                       (or (.getMessage e) "render failed"))))
    {:stage (stage-for (:run-id params))}))

(defn regenerate-leaf [{:keys [inputs]}]
  (try
    (regenerate! (:params inputs) (:env inputs) (:config inputs))
    (catch Throwable e
      (mark-halt! (get-in inputs [:params :run-id]) "regenerate"
                  "effect-could-not-run" (or (.getMessage e) "builder could not start"))))
  {:stage (stage-for (get-in inputs [:params :run-id]))})

(defn install-leaf [{:keys [inputs]}]
  (install! (:params inputs) (:env inputs) (:config inputs))
  {:stage (stage-for (get-in inputs [:params :run-id]))})

(defn gate-self-check-leaf [{:keys [inputs]}]
  (self-check! (:params inputs) (:env inputs) (:config inputs) (:repo inputs)
               "before-gate" 1)
  {:stage (stage-for (get-in inputs [:params :run-id]))})

(defn gate-leaf [{:keys [inputs]}]
  (try (gate! (:params inputs) (:env inputs) (:config inputs) (:repo inputs))
       (catch Throwable e
         (mark-halt! (get-in inputs [:params :run-id]) "gate" "effect-could-not-run"
                     (or (.getMessage e) "Gate could not run"))))
  {:stage (stage-for (get-in inputs [:params :run-id]))})

(defn grade-leaf [{:keys [inputs]}]
  (grade-all! (:params inputs) (:env inputs) (:config inputs))
  {:stage "running"})

(defn file-verdicts-leaf [{:keys [inputs]}]
  (file-verdicts! (:params inputs))
  {:stage (stage-for (get-in inputs [:params :run-id]))})

(defn file-score-leaf [{:keys [inputs]}]
  (file-score! (:params inputs))
  {:stage (if (:pending-halt (run-for (get-in inputs [:params :run-id])))
            "halting" "cycle-passed")})

(defn fail-cycle-leaf [{:keys [inputs]}]
  (let [params (:params inputs)
        {:keys [stage reason detail]} (:pending-failure (run-for (:run-id params)))]
    (fail-cycle! params stage reason detail)
    {:stage "cycle-failed"}))

(defn fail-score-stage-leaf [{:keys [inputs]}]
  (let [params (:params inputs)
        run-id (:run-id params)
        detail (get-in (run-for run-id) [:pending-failure :detail])
        event (append! :measurement/score-stage-failed
                       {:cycle-id (:cycle-id params) :refusal "zero-verdicts"
                        :detail detail :failed-at (now)})]
    (record! run-id "fail-score-stage" "measurement" "measurement/fail-score-stage"
             "recorded" [event] detail)
    {:stage "scoring-failed"}))

(defn conclude-leaf [{:keys [inputs]}]
  (conclude! (:params inputs))
  {:stage "concluded"})

(defn skeleton [grade-id]
  (orc/workflow "cycle-runner/cycle.v2"
    (orc/blackboard {:params (evaluated-schema (get-in (model) [:cycle-runner :commands :cycle-runner/start-run :schema]))
                     :env [:map-of :string :string]
                     :config [:map-of :string :string] :repo :string
                     :run-id :string :stage :string
                     :grade-items [:vector [:map [:item-id :string] [:scenario-digest :string]
                                            [:rule [:maybe :string]] [:source :string] [:title :string]]]
                     :item [:map [:item-id :string] [:scenario-digest :string]
                            [:rule [:maybe :string]] [:source :string] [:title :string]]
                     :grade-result :string
                     :grade-results [:vector :string]})
    (orc/fallback "cycle"
      (orc/sequence "main"
        (orc/code "start" :fn "loyly.cycle-runner/start-leaf"
                  :reads [:params] :writes [:run-id])
        (orc/code "stamp" :fn "loyly.cycle-runner/stamp-leaf"
                  :reads [:params :env :config :repo] :writes [:stage])
        (orc/condition "stamp-ok" :check {:key :stage :op :equals :value "running"})
        (orc/code "pin" :fn "loyly.cycle-runner/pin-leaf"
                  :reads [:params :repo] :writes [:stage])
        (orc/code "checklist" :fn "loyly.cycle-runner/checklist-leaf"
                  :reads [:params] :writes [:stage :grade-items])
        (orc/condition "checklist-ok" :check {:key :stage :op :equals :value "running"})
        (orc/code "grader" :fn "loyly.cycle-runner/grader-leaf"
                  :reads [:params :env] :writes [:stage])
        (orc/condition "grader-ok" :check {:key :stage :op :equals :value "running"})
        (orc/code "self-check:0" :fn "loyly.cycle-runner/self-check-leaf"
                  :reads [:params :env :config :repo] :writes [:stage])
        (orc/condition "self-check-ok" :check {:key :stage :op :equals :value "running"})
        (orc/code "fence" :fn "loyly.cycle-runner/fence-leaf"
                  :reads [:params :env :config :repo] :writes [:stage])
        (orc/condition "fence-ok" :check {:key :stage :op :equals :value "running"})
        (orc/code "render" :fn "loyly.cycle-runner/render-leaf"
                  :reads [:params :env] :writes [:stage])
        (orc/condition "render-ok" :check {:key :stage :op :equals :value "running"})
        (orc/code "regenerate" :fn "loyly.cycle-runner/regenerate-leaf"
                  :reads [:params :env :config] :writes [:stage])
        (orc/condition "regenerate-ok" :check {:key :stage :op :equals :value "running"})
        (orc/code "install" :fn "loyly.cycle-runner/install-leaf"
                  :reads [:params :env :config] :writes [:stage])
        (orc/code "self-check:1" :fn "loyly.cycle-runner/gate-self-check-leaf"
                  :reads [:params :env :config :repo] :writes [:stage])
        (orc/condition "gate-self-check-ok" :check {:key :stage :op :equals :value "running"})
        (orc/code "gate" :fn "loyly.cycle-runner/gate-leaf"
                  :reads [:params :env :config :repo] :writes [:stage])
        (orc/condition "gate-ok" :check {:key :stage :op :equals :value "running"})
        (orc/map-each "grade-items" :from :grade-items :as :item :into :grade-results
          (orc/delegate "grade-item" :target-sheet-id grade-id
                        :reads [:params :env :config :item] :writes [:grade-result]))
        (orc/code "file-verdicts" :fn "loyly.cycle-runner/file-verdicts-leaf"
                  :reads [:params] :writes [:stage])
        (orc/condition "verdicts-ok" :check {:key :stage :op :equals :value "running"})
        (orc/code "file-score" :fn "loyly.cycle-runner/file-score-leaf"
                  :reads [:params] :writes [:stage])
        (orc/condition "score-passed" :check {:key :stage :op :equals :value "cycle-passed"})
        (orc/code "conclude:passed" :fn "loyly.cycle-runner/conclude-leaf"
                  :reads [:params] :writes [:stage]))
      (orc/sequence "failed-path"
        (orc/condition "failing" :check {:key :stage :op :equals :value "failing"})
        (orc/code "fail-cycle" :fn "loyly.cycle-runner/fail-cycle-leaf"
                  :reads [:params] :writes [:stage])
        (orc/code "conclude:failed" :fn "loyly.cycle-runner/conclude-leaf"
                  :reads [:params] :writes [:stage]))
      (orc/sequence "score-failed-path"
        (orc/condition "scoring-failed" :check {:key :stage :op :equals :value "scoring-failed"})
        (orc/code "fail-score-stage" :fn "loyly.cycle-runner/fail-score-stage-leaf"
                  :reads [:params] :writes [:stage])
        (orc/code "fail-cycle:score" :fn "loyly.cycle-runner/fail-cycle-leaf"
                  :reads [:params] :writes [:stage])
        (orc/code "conclude:score" :fn "loyly.cycle-runner/conclude-leaf"
                  :reads [:params] :writes [:stage]))
      (orc/sequence "halt-path"
        (orc/condition "halting" :check {:key :stage :op :equals :value "halting"})
        (orc/code "halt" :fn "loyly.cycle-runner/halt-leaf"
                  :reads [:run-id] :writes [:stage])))))

(defn run-cycle! [params input]
  (let [ctx (:context @system)
        grade-id (orc/build-workflow! ctx (grade-workflow))
        _ (reset! grade-sheet-id grade-id)
        id (orc/build-workflow! ctx (skeleton grade-id))
        result (orc/execute ctx id {:params params :env (:env input)
                                    :config (:config input) :repo (:repo input)})]
    (when-not (= :success (:status result))
      (binding [*out* *err*] (println "ORC tick failed" (pr-str result))))
    result))

(defn dispatch [method params]
  (case method
    "cycle-runner/run-progress"
    (let [result (query/process-query
                  (assoc (:context @system)
                         :query (assoc params :query/name :cycle-runner/run-progress
                                              :query/id (random-uuid)
                                              :query/timestamp (java.time.OffsetDateTime/now))))]
      (:query/result result))
    "specification/stamped-items"
    (:query/result
     (query/process-query
      (assoc (:context @system)
             :query (assoc params :query/name :specification/stamped-items
                                  :query/id (random-uuid)
                                  :query/timestamp (java.time.OffsetDateTime/now)))))
    "measurement/checklist"
    (:query/result
     (query/process-query
      (assoc (:context @system)
             :query (assoc params :query/name :measurement/checklist
                                  :query/id (random-uuid)
                                  :query/timestamp (java.time.OffsetDateTime/now)))))
    "measurement/cycle-measurement"
    (:query/result
     (query/process-query
      (assoc (:context @system)
             :query (assoc params :query/name :measurement/cycle-measurement
                                  :query/id (random-uuid)
                                  :query/timestamp (java.time.OffsetDateTime/now)))))
    "measurement/scoreboard"
    (:query/result
     (query/process-query
      (assoc (:context @system)
             :query (assoc params :query/name :measurement/scoreboard
                                  :query/id (random-uuid)
                                  :query/timestamp (java.time.OffsetDateTime/now)))))
    "cycle-runner/start-run"
    (let [input (locking start-lock
                  (let [input (start-input params)]
                    (when-not (:refusal input) (reset! active (:run-id params)))
                    input))]
      (if-let [refusal (:refusal input)]
        {:error {:code -32000 :message refusal :data {:refusal refusal}}}
        (try
          (run-cycle! params input)
          {:events [(:start-event (run-for (:run-id params)))]}
          (finally (reset! active nil)))))
    {:error {:code -32601 :message "Method not found" :data {}}}))

(defn respond [line]
  (try
    (let [{:keys [jsonrpc id method params]} (json/read-str line :key-fn keyword)]
      (if (not= jsonrpc "2.0")
        {:jsonrpc "2.0" :id id :error {:code -32600 :message "Invalid request" :data {}}}
        (let [answer (dispatch method (or params {}))]
          (merge {:jsonrpc "2.0" :id id}
                 (if (:error answer) answer {:result answer})))))
    (catch Throwable e
      (binding [*out* *err*] (.printStackTrace e))
      {:jsonrpc "2.0" :id nil :error {:code -32000 :message (or (.getMessage e) "Failed") :data {}}})))

(defn wire-value [value]
  (walk/postwalk
   (fn [x]
     (cond
       (and (map? x) (contains? x "event/type"))
       (-> x
           (dissoc "event/type" "event/tags")
           (assoc "type" (get x "event/type")))
       (keyword? x)
       (if-let [ns (namespace x)] (str ns "/" (name x)) (name x))
       :else x))
   value))

(defn -main [& _]
  (register-model!)
  (let [path (or (System/getenv "LOYLY_GRAIN_STORE")
                 (throw (ex-info "LOYLY_GRAIN_STORE is required" {})))
        store (es/start {:conn {:type :sqlite :database-file path}})
        cache (kv/start (lmdb/->KV-Store-LMDB
                         {:storage-dir (str path ".cache") :db-name "orc"}))
        context {:tenant-id tenant-id :event-store store :cache cache}
        poller (todo/start-tenant-poller
                {:event-store store :tenant-ids #{tenant-id}
                 :context {:cache cache} :poll-interval-ms 50})]
    (reset! system {:store store :cache cache :context context :poller poller})
    (try
      (let [write-lock (Object.)
            tasks (atom [])]
        (doseq [line (line-seq (io/reader *in*))]
          (swap! tasks conj
                 (future
                   (let [response (respond line)
                         wire (wire-value response)]
                     (locking write-lock
                       (println (json/write-str wire))
                       (flush))))))
        (doseq [task @tasks] @task))
      (finally
        (System/exit 0)))))
