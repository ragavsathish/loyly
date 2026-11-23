(ns loyly.spike.grader-shards
  "PoC port of partitionByRule (+ prepareShards) from harness/pi-durable/grader-shards.ts"
  (:require [clojure.java.io :as io]
            [loyly.spike.digest :as d]
            [loyly.spike.grading-room :as room]
            [loyly.spike.hjson :as hjson]
            [loyly.spike.project.loyly.identity :as id]))

(defn partition-by-rule
  "Balance rule-groups across up to `shard-count` shards (1..16)."
  [items shard-count]
  (when (or (not (integer? shard-count)) (< shard-count 1) (> shard-count 16))
    (throw (ex-info "grader shards must be 1..16" {:count shard-count})))
  (when (or (not (vector? items)) (empty? items))
    (throw (ex-info "empty grader checklist" {})))
  (let [[order groups]
        (loop [items items order [] groups {}]
          (if-let [item (first items)]
            (let [source (re-matches
                          #"docs/plan/(\d\d-[a-z][a-z0-9-]*)/spec\.feature:\d+"
                          (or (get item "source") ""))
                  id (get item "id")
                  rule (get item "rule")]
              (when (or (nil? id) (nil? rule) (nil? source)
                        (not= (subs (second source) 0 2) (subs id 0 2)))
                (throw (ex-info "grading scope needs item ID, numbered plan source and rule"
                                {:id id})))
              (let [key (str (second source) "\0" rule)]
                (if (contains? groups key)
                  (recur (rest items) order (update groups key conj item))
                  (recur (rest items) (conj order key) (assoc groups key [item])))))
            [order groups]))
        n (min shard-count (clojure.core/count order))
        shards (vec (repeat n []))]
    (let [shards
          (reduce
           (fn [shards key]
             (let [group (get groups key)
                   idx (apply min-key (fn [i] (clojure.core/count (nth shards i)))
                              (range (clojure.core/count shards)))]
               (update shards idx into group)))
           shards
           order)]
      (mapv (fn [i shard-items]
              {:id (format "shard-%02d" (inc i))
               :items (vec shard-items)})
            (range) shards))))

(defn prepare-shards
  "Partition checklist and materialize per-shard grading rooms."
  [{:keys [grading-room source-room scratch schema-file
           candidate-sha256 schema-sha256 count
           project blind-review]
    :or {project id/PROJECT_ID}}]
  (let [blind-review (if (nil? blind-review)
                       (id/defaults-blind-review project)
                       blind-review)
        full (hjson/read-json (slurp (io/file grading-room "checklist.json") :encoding "UTF-8"))
        partitions (partition-by-rule (get full "items") count)]
    ;; `count` is only used above as shard cardinality (keyword arg).
    (mapv
     (fn [{:keys [id items]}]
       (let [base (io/file scratch "grader-shards" id)
             checklist-file (io/file base "inputs" "checklist.json")
             out (io/file base (str "grading-" id))
             payload (array-map "items" items
                                "counts" (array-map "total" (count items)))
             bytes (str (hjson/compact-json payload) "\n")]
         (.mkdirs (io/file base "inputs"))
         (when (and (.isFile checklist-file)
                    (not= (slurp checklist-file :encoding "UTF-8") bytes))
           (throw (ex-info (str "grader shard selection changed: " id) {:id id})))
         (when-not (.isFile checklist-file)
           (hjson/spit-utf8 checklist-file bytes))
         (let [checklist-sha (d/file-sha256 checklist-file)
               args {:source-room source-room
                     :candidate-room grading-room
                     :checklist-file (.getAbsolutePath checklist-file)
                     :schema-file schema-file
                     :out (.getAbsolutePath out)
                     :candidate-sha256 candidate-sha256
                     :checklist-sha256 checklist-sha
                     :schema-sha256 schema-sha256
                     :project project
                     :blind-review blind-review}]
           (if (.exists out)
             (room/verify-grading-room args)
             (room/prepare-grading-room args))
           {:id id
            :items (mapv #(get % "id") items)
            :out (.getAbsolutePath out)
            :checklist-sha256 checklist-sha
            :args args})))
     partitions)))
