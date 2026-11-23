(ns loyly.spike.gen-checklist
  "PoC port of harness/pi-durable/measure/gen-checklist.ts"
  (:require [clojure.java.io :as io]
            [clojure.string :as str]
            [loyly.spike.hjson :as hjson]))

(def scenario-line #"^\s*Scenario(?: Outline)?:\s*(.+?)\s*$")
(def rule-line #"^\s*Rule:\s*(.*?)\s*$")
(def item-tag #"@item-(\d+-\d+)")
(def skipped-statuses #{"planned" "backlog"})

(defn- slice-status [dir]
  (let [plan (io/file dir "plan.md")]
    (when (.isFile plan)
      (second (re-find #"(?m)^status:\s*(\S+)" (slurp plan :encoding "UTF-8"))))))

(defn- scan [root f]
  (let [path (hjson/rel root f)]
    (loop [lines (str/split (slurp f :encoding "UTF-8") #"\n" -1)
           n 1, rule nil, pending nil, items [], errors []]
      (if-let [line (first lines)]
        (let [stripped (str/trim line)]
          (cond
            (str/starts-with? stripped "@")
            (recur (rest lines) (inc n) rule
                   (or (last (map second (re-seq item-tag line))) pending)
                   items errors)

            (re-find rule-line line)
            (recur (rest lines) (inc n) (second (re-find rule-line line)) pending items errors)

            (re-find scenario-line line)
            (let [name (second (re-find scenario-line line))]
              (if pending
                (recur (rest lines) (inc n) rule nil
                       (conj items (array-map "id" pending "name" name "rule" rule
                                              "source" (str path ":" n)))
                       errors)
                (recur (rest lines) (inc n) rule nil items
                       (conj errors (str "  " path ":" n ": UNSTAMPED: " name)))))

            :else (recur (rest lines) (inc n) rule pending items errors)))
        [items errors]))))

(defn- parse-args [args]
  (let [args (vec args)
        root (or (second (drop-while #(not= "--root" %) args)) ".")
        out (second (drop-while #(not= "--out" %) args))]
    {:root (.getCanonicalFile (io/file root))
     :out out}))

(defn generate
  "Library entry matching TS genChecklist({ root, out })."
  [{:keys [root out]}]
  (let [root (io/file root)
        files (vec (remove (fn [f]
                             (let [dir (.getParentFile f)
                                   status (slice-status dir)]
                               (when (skipped-statuses status)
                                 (hjson/err (str "gen_checklist: skipping " (.getName dir)
                                                 " (status: " status ")\n"))
                                 true)))
                           (hjson/spec-files root)))]
    (when (empty? files)
      (hjson/refuse (str "gen_checklist: no NN-slug/spec.feature under " (hjson/plan-dir root)
                         ". An empty checklist lets a scoring run report a flawless cycle in"
                         " which nothing was ever checked, so none is written.")))
    (let [items (reduce (fn [acc f]
                          (let [[items errors] (scan root f)]
                            (when (seq errors)
                              (hjson/refuse (str "gen_checklist: some scenarios carry no item id."
                                                 " A checklist built now would quietly score fewer"
                                                 " items than the spec contains, so stamp them first"
                                                 " with stamp:\n"
                                                 (str/join "\n" errors))))
                            (into acc items)))
                        [] files)
          text (str (hjson/write (array-map "items" items
                                            "counts" (array-map "total" (count items))))
                    "\n")]
      (if out
        (hjson/spit-utf8 out text)
        (hjson/out text))
      (hjson/err (str "checklist: {'total': " (count items) "}\n"))
      {:items items :counts {:total (count items)} :text text})))

(defn -main [& args]
  (generate (parse-args args))
  nil)
