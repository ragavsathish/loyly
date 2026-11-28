(ns loyly.grader-shards
  "Port of partitionByRule (+ prepareShards) from harness/pi-durable/grader-shards.ts (.cljc)."
  (:require [loyly.allure-results :as allure]
            [loyly.digest :as d]
            [loyly.grading-room :as room]
            [loyly.hjson :as hjson]
            [loyly.platform :as plat]
            [loyly.project.loyly :as loyly]))

(defn copy-safe-tree
  "Recursive copy without following symlinks (port of grader-shards copySafeTree)."
  [from to]
  (let [from (plat/path from)
        kind (plat/lstat-kind from)]
    (case kind
      :file
      (do
        (when-let [parent (plat/parent to)]
          (plat/create-dirs parent))
        (plat/copy from to))

      :dir
      (do
        (plat/create-dirs to)
        (doseq [child (plat/list-dir from)]
          (let [name (plat/file-name child)]
            (copy-safe-tree (plat/path from name) (plat/path to name)))))

      (throw (ex-info (str "grader evidence contains a symlink or special file: " from)
                      {:from (str from)})))))

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
        n (min shard-count (count order))
        shards (reduce
                (fn [shards key]
                  (let [group (get groups key)
                        idx (apply min-key (fn [i] (count (nth shards i)))
                                   (range (count shards)))]
                    (update shards idx into group)))
                (vec (repeat n []))
                order)]
    (mapv (fn [i shard-items]
            {:id (str "shard-" (plat/pad-left-zero (inc i) 2))
             :items (vec shard-items)})
          (range) shards)))

(defn prepare-shards
  "Partition checklist and materialize per-shard grading rooms.
  Pass `:shard-count` (preferred) or `:count` for the partition size."
  [{:keys [grading-room source-room scratch schema-file
           candidate-sha256 schema-sha256 shard-count
           project blind-review]
    :or {project loyly/PROJECT_ID}
    :as opts}]
  (let [shard-count (or shard-count (:count opts))
        blind-review (if (nil? blind-review)
                       (loyly/defaults-blind-review project)
                       blind-review)
        full (hjson/read-json (plat/read-text (plat/path grading-room "checklist.json")))
        partitions (partition-by-rule (get full "items") shard-count)]
    (mapv
     (fn [{:keys [id items]}]
       (let [base (plat/path scratch "grader-shards" id)
             checklist-file (plat/path base "inputs" "checklist.json")
             out (plat/path base (str "grading-" id))
             payload (array-map "items" items
                                "counts" (array-map "total" (count items)))
             bytes (str (hjson/compact-json payload) "\n")]
         (plat/create-dirs (plat/path base "inputs"))
         (when (and (plat/regular-file? checklist-file)
                    (not= (plat/read-text checklist-file) bytes))
           (throw (ex-info (str "grader shard selection changed: " id) {:id id})))
         (when-not (plat/regular-file? checklist-file)
           (hjson/spit-utf8 checklist-file bytes))
         (let [checklist-sha (d/file-sha256 checklist-file)
               args {:source-room source-room
                     :candidate-room grading-room
                     :checklist-file (str (plat/absolutize checklist-file))
                     :schema-file schema-file
                     :out (str (plat/absolutize out))
                     :candidate-sha256 candidate-sha256
                     :checklist-sha256 checklist-sha
                     :schema-sha256 schema-sha256
                     :project project
                     :blind-review blind-review}]
           (if (plat/exists? out)
             (room/verify-grading-room args)
             (room/prepare-grading-room args))
           {:id id
            :items (mapv #(get % "id") items)
            :out (str (plat/absolutize out))
            :checklist-sha256 checklist-sha
            :args args})))
     partitions)))

(defn combine-shards
  "Merge shard grading rooms into one collector view (port of combineShards)."
  [{:keys [grading-room shards candidate-sha256 schema-sha256]}]
  (let [full (hjson/read-json (plat/read-text (plat/path grading-room "checklist.json")))
        selected (mapv #(get % "id") (get full "items"))
        seen (vec (mapcat :items shards))]
    (when (or (not= (count seen) (count selected))
              (not= (count (set seen)) (count selected))
              (some #(not (contains? (set seen) %)) selected))
      (throw (ex-info "grader shards do not cover the approved checklist exactly once" {})))
    (let [work (plat/path grading-room "work")
          combined (plat/path work "allure-results")
          shards-dir (plat/path work "shards")]
      (when (plat/exists? combined) (plat/delete-tree combined))
      (when (plat/exists? shards-dir) (plat/delete-tree shards-dir))
      (plat/create-dirs combined)
      (plat/create-dirs shards-dir)
      (let [surprises (atom [])
            room-meta (hjson/read-json
                       (plat/read-text (plat/path grading-room ".grading-room.json")))]
        (doseq [shard shards]
          (room/verify-grading-room
           (array-map
            :out (:out shard)
            :candidate-sha256 candidate-sha256
            :checklist-sha256 (:checklist-sha256 shard)
            :schema-sha256 schema-sha256
            :project (or (get room-meta "project") "loyly")
            :blind-review (if (contains? room-meta "blindReview")
                            (get room-meta "blindReview")
                            true)))
          (let [judged (allure/read-allure-results (:out shard))]
            (when-not (= (count (:verdicts judged)) (count (:items shard)))
              (throw (ex-info (str "incomplete " (:id shard)) {:id (:id shard)})))
            (let [source (plat/path (:out shard) "work" "allure-results")]
              (doseq [name (map plat/file-name (plat/list-dir source))]
                (let [dest (plat/path combined name)]
                  (when (plat/exists? dest)
                    (throw (ex-info (str "Allure filename collision: " name) {:name name})))
                  (plat/copy (plat/path source name) dest)))
              (let [evidence (plat/path shards-dir (:id shard))]
                (plat/create-dirs evidence)
                (doseq [name (map plat/file-name (plat/list-dir (plat/path (:out shard) "work")))]
                  (let [source-path (plat/path (:out shard) "work" name)]
                    (when (and (not= name "allure-results")
                               (not= name "surprises.json")
                               (not (and (re-matches #"runtime-.*" name)
                                         (plat/directory? source-path))))
                      (copy-safe-tree source-path (plat/path evidence name))))))
              (swap! surprises into
                     (map (fn [s]
                            (assoc s "evidence_file"
                                   (str "work/shards/" (:id shard) "/"
                                        (subs (get s "evidence_file") 5))))
                          (:surprises judged)))))
        (hjson/spit-utf8 (plat/path work "surprises.json")
                         (hjson/compact-json @surprises))
        (allure/read-allure-results grading-room))))))
