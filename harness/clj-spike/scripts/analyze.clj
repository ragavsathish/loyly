#!/usr/bin/env bb
;; Static analysis for clj-spike — mirrors pi-durable npm run lint / analyze.
;;   lint          clj-kondo + loyly product-literal + deep-import rules
;;   analyze:deps  require-graph cycles (madge)
;;   analyze:dead  unreachable namespaces / unreferred public defs (knip-ish)
;;   analyze:dupes token-hash near-dupes among top-level defns (jscpd-ish)
;;   analyze:metrics LOC / form / branch counts
(ns loyly.spike.scripts.analyze
  (:require [babashka.fs :as fs]
            [babashka.process :as p]
            [clojure.string :as str]))

(def root (-> *file* fs/parent fs/parent))
(def src (fs/path root "src"))
(def formal-src (fs/path root "formal" "src"))

(def banned-literals
  [{:value "01-011" :hint "BLIND_ITEM_ID"}
   {:value "01-booking-core" :hint "BOOKING_SLICE"}
   {:value "booking-core.panel.json" :hint "DEFAULT_PANEL_PLAN"}
   {:value "work/blind-review-011.txt" :hint "BLIND_REFUSAL_FILE"}
   {:value "blind-review-011.txt" :hint "basename(BLIND_REFUSAL_FILE)"}
   {:value "not reached: blind human review required" :hint "PENDING_HUMAN"}
   {:value "not reached: blind subagent review required" :hint "PENDING_SUBAGENT"}])

;; Match eslint-plugin-loyly allow paths (+ scripts/ for this checker).
;; CLJ barrel is project/loyly.clj (TS keeps index.ts under project/loyly/).
(def allow-product-path
  #"project/loyly\.clj|project/loyly/|formal/|scripts/")

(def entry-namespaces
  "CLI / task roots that keep a namespace alive (knip entry equivalents)."
  #{"loyly.spike.demo"
    "loyly.spike.gen-checklist"
    "loyly.spike.score"
    "loyly.spike.scoreboard"
    "loyly.spike.stamp-item-ids"
    "loyly.spike.tasks.builder"
    "loyly.spike.tasks.cycle"
    "loyly.spike.tasks.gate"
    "loyly.spike.tasks.grade"
    "loyly.spike.tasks.panel"
    "loyly.spike.audit-rows"
    "loyly.formal.main"
    "loyly.formal.models"
    "loyly.formal.trace"
    "loyly.formal.props"
    "loyly.formal.theory"
    "loyly.formal.cycle"})

(defn- clj-files []
  (->> (concat (fs/glob src "**.clj")
               (when (fs/directory? formal-src)
                 (fs/glob formal-src "**.clj")))
       (map str)
       sort))

(defn- rel [path]
  (str (fs/relativize root path)))

(defn- ns-of [path]
  (second (re-find #"^\(ns\s+([^\s\)]+)" (slurp path))))

(defn- spike-requires [path]
  "Requires into spike or formal modules (for the dep graph)."
  (->> (re-seq #"\[(loyly\.(?:spike|formal)[a-z0-9.-]*)(?:\s|:|\])" (slurp path))
       (map second)
       set))

(defn lint-kondo!
  "clj-kondo lint (eslint equivalent). Warnings fail the gate."
  []
  (let [kondo (or (fs/which "clj-kondo")
                  (when (fs/exists? (fs/path (fs/home) ".local/bin/clj-kondo"))
                    (str (fs/path (fs/home) ".local/bin/clj-kondo"))))]
    (when-not kondo
      (binding [*out* *err*]
        (println "clj-kondo not found; install to PATH or ~/.local/bin"))
      (System/exit 2))
    (let [{:keys [exit out err]}
          @(p/process (cond-> [kondo "--lint" (str src)
                               "--config" (str (fs/path root ".clj-kondo/config.edn"))]
                        (fs/directory? formal-src)
                        (into ["--lint" (str formal-src)]))
                      {:out :string :err :string :dir (str root)})]
      (print out)
      (print err)
      ;; 0 = clean, 2 = warnings, 3 = errors — treat any finding as fail
      (when (pos? exit)
        (binding [*out* *err*]
          (println "clj-kondo reported findings (exit" exit ")"))
        (System/exit 1))
      :ok)))

(defn- product-literal-hits [path text]
  (when-not (re-find allow-product-path (str/replace path "\\" "/"))
    (for [lit banned-literals
          :when (str/includes? text (:value lit))]
      lit)))

(defn lint-product-literals!
  "Port of eslint-plugin-loyly/no-product-literals."
  []
  (let [hits
        (vec
         (mapcat
          (fn [path]
            (let [text (slurp path)]
              (for [lit (product-literal-hits path text)]
                {:path (rel path) :literal (:value lit) :hint (:hint lit)})))
          (clj-files)))]
    (doseq [h hits]
      (binding [*out* *err*]
        (println (str (:path h) ": hard-coded product literal "
                      (pr-str (:literal h))
                      " — import " (:hint h)
                      " from loyly.spike.project.loyly instead."))))
    (when (seq hits)
      (System/exit 1))
    :ok))

(defn lint-deep-project-imports!
  "Port of eslint-plugin-loyly/no-deep-project-imports."
  []
  (let [re #"\[loyly\.spike\.project\.loyly\.(identity|blind-policy|blind-answer|blind-probe|schemas)\b"
        hits
        (vec
         (keep
          (fn [path]
            (when-not (re-find #"project/loyly\.clj|project/loyly/"
                               (str/replace path "\\" "/"))
              (when (re-find re (slurp path))
                {:path (rel path)})))
          (clj-files)))]
    (doseq [h hits]
      (binding [*out* *err*]
        (println (str (:path h)
                      ": import from loyly.spike.project.loyly instead of deep project.loyly.* paths."))))
    (when (seq hits)
      (System/exit 1))
    :ok))

(defn analyze-deps!
  "Namespace require graph — fail on cycles (madge equivalent)."
  []
  (let [graph (into {}
                    (keep (fn [path]
                            (when-let [n (ns-of path)]
                              [n (spike-requires path)]))
                          (clj-files)))
        cycles (atom [])]
    (letfn [(visit [node path seen]
              (cond
                (some #{node} path)
                (swap! cycles conj (conj (vec (drop-while #(not= % node) path)) node))
                (contains? seen node) nil
                :else
                (doseq [nxt (get graph node)]
                  (when (contains? graph nxt)
                    (visit nxt (conj path node) (conj seen node))))))]
      (doseq [n (keys graph)]
        (visit n [] #{})))
    (let [uniq (distinct @cycles)]
      (doseq [c uniq]
        (binding [*out* *err*]
          (println "circular require:" (str/join " -> " c))))
      (when (seq uniq)
        (System/exit 1))
      (println (str "analyze:deps OK (" (count graph) " namespaces, no cycles)"))
      :ok)))

(defn- public-defs [text]
  (->> (re-seq #"(?m)^\(def(?:n)?\s+([a-zA-Z*+!?_-][a-zA-Z0-9*+!?_-]*)" text)
       (map second)
       ;; skip private markers handled via defn-
       (remove #(str/ends-with? % "-"))
       set))

(defn analyze-dead!
  "Unused namespaces (not reachable from CLI entries) + unused public defs (knip-ish)."
  []
  (let [files (clj-files)
        ns->path (into {} (keep (fn [p] (when-let [n (ns-of p)] [n p])) files))
        graph (into {} (map (fn [[n p]] [n (spike-requires p)]) ns->path))
        reachable
        (loop [front (set (filter #(contains? graph %) entry-namespaces))
               seen #{}]
          (if (empty? front)
            seen
            (let [n (first front)
                  nxt (get graph n #{})]
              (recur (into (disj front n)
                           (remove seen nxt))
                     (conj seen n)))))
        orphans (sort (remove reachable (keys graph)))
        ;; defs never referred as ns-alias/name or bare name across other files
        unused-defs
        (vec
         (mapcat
          (fn [[n path]]
            (when (reachable n)
              (let [text (slurp path)
                    defs (public-defs text)
                    ;; collect alias used for this ns by others
                    alias-hits
                    (mapcat
                     (fn [other]
                       (when-not (= other path)
                         (let [ot (slurp other)
                               aliases
                               (->> (re-seq (re-pattern
                                             (str "\\[" (java.util.regex.Pattern/quote n)
                                                  "\\s+:as\\s+([a-zA-Z0-9_-]+)"))
                                            ot)
                                    (map second))]
                           (for [a aliases
                                 d defs
                                 :when (re-find (re-pattern (str "\\b" a "/" d "\\b")) ot)]
                             d))))
                     files)
                    referred (set alias-hits)
                    ;; self-refs inside the defining ns (call sites without alias)
                    self (set
                          (for [d defs
                                :when (re-find (re-pattern (str "[^/\\w]" d "\\b"))
                                               ;; strip the defining form line-ish: crude
                                               text)]
                            d))
                    unused (remove (fn [d]
                                    (or (contains? referred d)
                                        ;; keep if mentioned elsewhere in same file after def
                                        (let [after (str/split text (re-pattern (str "\\(def(?:n)?\\s+" d "\\b")) 2)]
                                          (and (= 2 (count after))
                                               (re-find (re-pattern (str "\\b" d "\\b")) (second after))))
                                        (contains? entry-namespaces n)))
                                  defs)]
                ;; Only report unused when never aliased-referred AND never self-used after def
                (for [d unused
                      :let [parts (str/split text (re-pattern (str "\\(def(?:n)?\\s+" d "\\b")) 2)
                            self-use (and (= 2 (count parts))
                                          (re-find (re-pattern (str "\\b" d "\\b")) (second parts)))]
                      :when (and (not self-use) (not (contains? referred d)))]
                  {:ns n :def d :path (rel path)}))))
          ns->path))]
    (doseq [n orphans]
      (binding [*out* *err*]
        (println (str "analyze:dead unused namespace: " n
                      " (" (rel (ns->path n)) ")"))))
    (doseq [u (take 50 unused-defs)]
      (binding [*out* *err*]
        (println (str "analyze:dead unused public def: " (:ns u) "/" (:def u)
                      " (" (:path u) ")"))))
    (when (or (seq orphans) (seq unused-defs))
      (binding [*out* *err*]
        (println (str "analyze:dead: " (count orphans) " unused ns, "
                      (count unused-defs) " unused public defs")))
      (System/exit 1))
    (println (str "analyze:dead OK (reachable " (count reachable)
                  "/" (count graph) " namespaces)"))
    :ok))

(defn analyze-dupes!
  "Flag identical top-level defn bodies ≥ 6 lines (jscpd-ish)."
  []
  (let [forms
        (mapcat
         (fn [path]
           (let [raw (slurp path)
                 text (subs raw 0 (min (count raw) 20000))
                 heads (re-seq #"(?m)^\((defn-?)\s+([a-zA-Z*+!?_-][^\s)]*)" text)]
             (for [[_kind name] heads
                   :let [anchor (str "(defn" (when (= _kind "defn-") "-") " " name)
                         idx (.indexOf text anchor)
                         body (when (pos? idx) (subs text idx (min (+ idx 1200) (count text))))
                         lines (when body (count (str/split-lines body)))]
                   :when (and body (>= lines 6) (<= lines 350))]
               {:path (rel path) :name name :lines lines
                :hash (hash (str/replace body #"\s+" " "))})))
         (clj-files))
        by-hash (group-by :hash forms)
        dupes (filter #(> (count (val %)) 1) by-hash)]
    (doseq [[_ group] dupes]
      (binding [*out* *err*]
        (println (str "analyze:dupes near-identical defn (" (:lines (first group))
                      " lines): "
                      (str/join ", " (map #(str (:path %) "#" (:name %)) group))))))
    (when (seq dupes)
      (binding [*out* *err*]
        (println (str "analyze:dupes: " (count dupes) " duplicate groups (advisory)"))))
    ;; Advisory only — Clojure ports often share structural twins with TS helpers.
    (println (str "analyze:dupes OK (scanned; "
                  (count dupes) " advisory groups)"))
    :ok))

(defn analyze-metrics!
  "Lightweight Q-factor-ish metrics for .clj sources."
  []
  (let [files (clj-files)
        loc (reduce + (map #(count (str/split-lines (slurp %))) files))
        defs (reduce + (map #(count (re-seq #"(?m)^\(def(?:n|-|n-|protocol|macro)?" (slurp %))) files))
        high-branch
        (count
         (filter
          (fn [path]
            (let [t (slurp path)
                  branches (count (re-seq #"\(or\b|\(and\b|\(when\b|\(if\b|\(cond\b|\(case\b" t))]
              (> branches 40)))
          files))]
    (println (format "analyze:metrics files=%d loc=%d public-ish-forms=%d high-branch-files=%d"
                     (count files) loc defs high-branch))
    :ok))

(defn run-lint! []
  (lint-kondo!)
  (lint-product-literals!)
  (lint-deep-project-imports!)
  (println "lint OK"))

(defn run-analyze! []
  (lint-kondo!)
  (lint-product-literals!)
  (lint-deep-project-imports!)
  (analyze-deps!)
  (analyze-dead!)
  (analyze-dupes!)
  (analyze-metrics!)
  (println "analyze OK"))

(defn -main [& args]
  (let [task (or (first args) "all")]
    (case task
      "lint" (run-lint!)
      "lint:kondo" (do (lint-kondo!) (println "lint:kondo OK"))
      "lint:loyly" (do (lint-product-literals!) (lint-deep-project-imports!)
                       (println "lint:loyly OK"))
      "analyze:deps" (analyze-deps!)
      "analyze:dead" (analyze-dead!)
      "analyze:dupes" (analyze-dupes!)
      "analyze:metrics" (analyze-metrics!)
      ("analyze" "all") (run-analyze!)
      (do (binding [*out* *err*]
            (println "usage: analyze.clj [lint|lint:kondo|lint:loyly|analyze|analyze:deps|analyze:dead|analyze:dupes|analyze:metrics]"))
          (System/exit 2)))))

(when (= *file* (System/getProperty "babashka.file"))
  (apply -main *command-line-args*))
