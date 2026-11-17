#!/usr/bin/env bb
;; Build the public cycle-25 playback from selected trace fields and compact Grain timelines.
(require '[cheshire.core :as json] '[clojure.string :as str])
(def root (str (-> (java.io.File. *file*) .getCanonicalFile .getParentFile .getParentFile .getParentFile .getParentFile)))
(def evidence (str root "/harness/v2/cycles/06/25/"))
(def replay (str root "/tools/spec/replay/"))
(defn read-json [file] (json/parse-string (slurp file) true))
(defn attrs [record] (into {} (for [{:keys [key value]} (:attributes record)] [key (first (vals value))])))
(def trace (read-json (str evidence "profile.traces.otlp.json")))
(def profile (read-json (str evidence "profile.json")))
(def scores (read-json (str evidence "scores.json")))
(def spans (vec (mapcat #(mapcat :spans (:scopeSpans %)) (:resourceSpans trace))))
(def grade-spans (filterv #(= "loyly.grade.item" (:name %)) spans))
(def score-by-id (into {} (map (juxt :id identity) (:items scores))))
(def profile-by-id (into {} (map (juxt :id identity) (:cases profile))))
(def allowed #{"loyly.profile.phase" "loyly.vm.qemu.count" "loyly.process.count"
               "loyly.grain.events" "loyly.orc.traces" "loyly.orc.nodes"
               "loyly.judge.scores" "loyly.orc.sheet" "loyly.orc.status"
               "loyly.orc.duration.ms" "loyly.orc.node" "loyly.orc.executions"
               "loyly.orc.total_tokens" "loyly.jvm.command" "loyly.jvm.status"})
(defn ms [n] (quot (Long/parseLong (str n)) 1000000))
(def base-time (apply min (map #(Long/parseLong (str (:startTimeUnixNano %))) spans)))
(defn case-data [span]
  (let [id (get (attrs span) "loyly.item.id")
        score (score-by-id id) case (profile-by-id id)]
    (assert (and (= "pass" (:verdict score)) (= "clean" (:status case))) id)
    {:id id :name (:name score) :verdict (:verdict score) :profile (:status case)
     :model (:model_requests case) :qemu (:peak_observed_qemu case)
     :grain (:grain_profiles case) :elapsed (:elapsed_ms case)
     :events (count (:events span))}))
(defn event-data [id order event]
  (let [a (attrs event) mark (get a "loyly.mark.name")
        detail (if (= "loyly.profile.mark" (:name event))
                 (when (#{"run-id" "trace-id" "model-requests"} mark)
                   (cond-> {:mark mark} (= mark "model-requests")
                     (assoc :count (Long/parseLong (str (get a "loyly.mark.value"))))))
                 (into {} (for [[k v] a :when (contains? allowed k)] [(subs k 6) v])))]
    (when detail
      {:t (ms (- (Long/parseLong (str (:timeUnixNano event))) base-time))
       :id id :kind (str/replace-first (:name event) #"^loyly\." "")
       :detail detail :order order})))
(assert (= 61 (count grade-spans) (count score-by-id) (count profile-by-id)))
(assert (and (= "failed" (:status profile)) (= 61 (get-in profile [:verdicts :pass_count]))))
(def cases (vec (sort-by :id (map case-data grade-spans))))
(def events (->> grade-spans
                 (mapcat (fn [span] (let [id (get (attrs span) "loyly.item.id")]
                                      (keep-indexed (partial event-data id) (:events span)))))
                 (sort-by (juxt :t :id :order))
                 (mapv #(dissoc % :order))))
(assert (>= (count events) 3000))
(def grain (into {} (map (fn [[k v]] [(name k) v]) (:cases (read-json (str replay "src/replay/cycle-25-grain-events.json"))))))
(def orc (into {} (map (fn [[k v]] [(name k) v]) (:cases (read-json (str replay "src/replay/cycle-25-orc-events.json"))))))
(assert (= (set (keys grain)) (set (keys score-by-id)) (set (keys orc))))
(assert (= 1910 (reduce + (map count (vals grain)))))
(assert (= 883 (reduce + (map count (vals orc)))))
(def story (second (str/split (slurp (str root "/tools/spec/views/dist/story.svg")) #"\?>" 2)))
(assert (= 25 (count (re-seq #"data-event=\"" story))))
(def story (str/replace (str/trim story) "href=\"#" "href=\"../index.html#"))
(def data {:cases cases :events events :status (:status profile) :problem (first (:problems profile))
           :trace (:otel_trace_id profile) :grain grain :orc orc})
(def safe-json (-> (json/generate-string data) (str/replace "<" "\\u003c")
                   (str/replace ">" "\\u003e") (str/replace "&" "\\u0026")))
(def page (-> (slurp (str replay "src/replay/grading-template.html"))
              (str/replace "BASE_CSS" (slurp (str root "/tools/spec/views/src/specviews/page.css")))
              (str/replace "REPLAY_CSS" (slurp (str replay "src/replay/page.css")))
              (str/replace "STORY_SVG" story)
              (str/replace "DATA_JSON" safe-json)))
(spit (str replay "cycle-25-grading.html") page)
(println "cycle-25-grading.html:" (count cases) "cases," (count events) "trace events," (reduce + (map count (vals orc))) "ORC transitions")
