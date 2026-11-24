(ns loyly.spike.scoreboard
  "PoC port of harness/pi-durable/measure/scoreboard.ts"
  (:require [clojure.java.io :as io]
            [clojure.string :as str]
            [loyly.spike.hjson :as hjson]))

(defn- pct [n d]
  (-> (java.math.BigDecimal. (double (/ (* 100.0 n) d)))
      (.setScale 1 java.math.RoundingMode/HALF_EVEN)
      (.toPlainString)))

(defn- rate [n d]
  (str (hjson/ralign (str n "/" d) 7)
       (if (zero? d) " =   n/a" (str " = " (hjson/ralign (pct n d) 5) "%"))))

(defn- verdicts-of [f]
  (when (.isFile f)
    (let [items (get (hjson/read-json (slurp f :encoding "UTF-8")) "items")]
      (reduce (fn [m i] (assoc m (get i "id") (get i "verdict"))) {} items))))

(defn- parse-args [args]
  (let [args (vec args)
        root (or (second (drop-while #(not= "--root" %) args)) ".")
        cycle (first (remove #{"--root" root} args))]
    {:root (.getCanonicalFile (io/file root))
     :cycle cycle}))

(defn report
  "Library entry matching TS scoreboard({ root, cycle })."
  [{:keys [root cycle]}]
  (when-not cycle (hjson/refuse "scoreboard: usage: scoreboard --root <repo> <cycle>"))
  (let [root (io/file root)
        scores-rel (str "harness/cycles/" cycle "/scores.json")
        this (verdicts-of (io/file root scores-rel))]
    (when (empty? this)
      (hjson/refuse (str "scoreboard: nothing recorded at " scores-rel)))
    (let [total (count this)
          passes (count (filter #(= "pass" %) (vals this)))
          prev-cycle (when (re-matches #"\d+" cycle)
                       (format (str "%0" (count cycle) "d") (dec (Long/parseLong cycle))))
          prev (when prev-cycle (verdicts-of (io/file root (str "harness/cycles/" prev-cycle "/scores.json"))))
          head [(str "cycle " cycle ": " passes "/" total " checklist items pass") ""]
          body (if (nil? prev)
                 ["  no previous cycle to diff against: baseline cycle."]
                 (let [shared (filter (set (keys prev)) (keys this))
                       added (remove (set (keys prev)) (keys this))
                       dropped (remove (set (keys this)) (keys prev))
                       shared-n (count shared)
                       prev-pass (count (filter #(= "pass" (prev %)) shared))
                       this-pass (count (filter #(= "pass" (this %)) shared))
                       better (count (filter #(and (= "fail" (prev %)) (= "pass" (this %))) shared))
                       worse (count (filter #(and (= "pass" (prev %)) (= "fail" (this %))) shared))]
                   (concat
                    [(str "  against cycle " prev-cycle ", counting only the " shared-n
                          " items both cycles carried:")
                     (str "    cycle " prev-cycle "  " (rate prev-pass shared-n))
                     (str "    cycle " cycle "  " (rate this-pass shared-n)
                          "   <- these two are the fair comparison")
                     (str "    now passing   " (hjson/ralign better 3) "   <- repaired since then")
                     (str "    now failing   " (hjson/ralign worse 3) "   <- broken since then")]
                    (when (or (seq added) (seq dropped))
                      ["" (str "  THE ITEM SET MOVED: " (count prev) " items -> " total
                               " (" (count added) " added, " (count dropped) " dropped),"
                               " so the two headline")
                       "  rates count different things and must not be read against each other."
                       "  The added items cover work last cycle's spec never asked for."]))))
          text (str/join "\n" (concat head body [""]))]
      (hjson/out text)
      {:text text})))

(defn -main [& args]
  (report (parse-args args))
  nil)
