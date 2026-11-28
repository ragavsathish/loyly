(ns loyly.score
  "Port of harness/pi-durable/measure/score.ts (.cljc)."
  (:require [clojure.string :as str]
            [loyly.hjson :as hjson]
            [loyly.platform :as plat]))

(def unreached-evidence "not scored: the grader never reached this item")

(defn- parse-args [args]
  (let [args (vec args)
        root (or (second (drop-while #(not= "--root" %) args)) ".")
        verdicts (second (drop-while #(not= "--verdicts" %) args))
        cycle (first (remove #{"--root" root "--verdicts" verdicts} args))]
    {:root (plat/real-path (plat/absolutize root))
     :cycle cycle
     :verdicts-path verdicts}))

(defn score-cycle
  "Library entry matching TS scoreCycle({ root, cycle, verdictsPath })."
  [{:keys [root cycle verdicts-path]}]
  (when-not cycle (hjson/refuse "score: usage: score --root <repo> <cycle> --verdicts <file>"))
  (when-not verdicts-path (hjson/refuse "score: --verdicts <file> is required"))
  (let [root (str root)
        checklist-rel (str "harness/cycles/" cycle "/checklist.json")
        checklist-file (plat/path root checklist-rel)
        scores-rel (str "harness/cycles/" cycle "/scores.json")]
    (when-not (plat/regular-file? checklist-file)
      (hjson/refuse (str "score: no " checklist-rel ": generate it first:\n"
                         "  bin/loyly-clj gen-checklist --root <repo> --out "
                         checklist-rel)))
    (let [items (get (hjson/read-json (plat/read-text checklist-file)) "items")
          _ (when-not (plat/regular-file? verdicts-path)
              (hjson/refuse (str "score: no verdicts at " verdicts-path
                                 ". A measurement that is not there is not a measurement:"
                                 " nothing was written.")))
          raw (plat/read-text verdicts-path)
          _ (when (str/blank? raw)
              (hjson/refuse "score: 0 items scored. A run that graded nothing tells you the grading did not happen, not that every item failed. Nothing recorded."))
          verdicts (try (hjson/read-json raw)
                        (catch #?(:clj Exception :cljs :default) e
                          (hjson/refuse (str "score: " verdicts-path " is not valid JSON ("
                                             (hjson/detail e) "). A measurement that cannot be"
                                             " read is not a measurement: nothing was written."))))]
      (when-not (vector? verdicts)
        (hjson/refuse (str "score: " verdicts-path " should hold a list of verdicts, found "
                           (hjson/type-name verdicts) ". Nothing was written.")))
      (when (empty? verdicts)
        (hjson/refuse "score: 0 items scored. A run that graded nothing tells you the grading did not happen, not that every item failed. Nothing recorded."))
      (let [known (set (map #(get % "id") items))
            unknown (remove known (map #(get % "id") verdicts))]
        (when (seq unknown)
          (hjson/refuse (str "score: verdicts for items not on the checklist"
                             " (the spec is the only author of the item list): "
                             (str/join ", " unknown)))))
      (let [bad (->> verdicts
                     (remove #(#{"pass" "fail"} (get % "verdict")))
                     (map #(get % "id")))]
        (when (seq bad)
          (hjson/refuse (str "score: verdict must be 'pass' or 'fail' for: " (str/join ", " bad)))))
      (let [by-id (reduce (fn [m v] (assoc m (get v "id") v)) {} verdicts)
            scored (mapv (fn [item]
                           (let [v (by-id (get item "id"))]
                             (apply array-map
                                    (concat (mapcat identity item)
                                            ["verdict" (if v (get v "verdict") "fail")
                                             "evidence" (if v
                                                          (get v "evidence" "")
                                                          unreached-evidence)]))))
                         items)
            passes (count (filter #(= "pass" (get % "verdict")) scored))
            unreached (- (count items) (count (filter #(by-id (get % "id")) items)))]
        (hjson/spit-utf8 (plat/path root scores-rel)
                         (str (hjson/write (array-map "items" scored)) "\n"))
        (hjson/out (str "scored cycle " cycle ": " passes "/" (count items) " pass"
                        (when (pos? unreached)
                          (str " (" unreached " unreached, recorded as fail)"))
                        "\n"
                        "filed: " scores-rel "\n"))
        {:passes passes :total (count items) :unreached unreached :scores-rel scores-rel}))))

(defn -main [& args]
  (score-cycle (parse-args args))
  nil)
