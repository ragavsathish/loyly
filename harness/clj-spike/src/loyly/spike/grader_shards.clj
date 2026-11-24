(ns loyly.spike.grader-shards
  "PoC port of partitionByRule (+ prepareShards) from harness/pi-durable/grader-shards.ts"
  (:require [babashka.fs :as fs]
            [loyly.spike.allure-results :as allure]
            [loyly.spike.digest :as d]
            [loyly.spike.grading-room :as room]
            [loyly.spike.hjson :as hjson]
            [loyly.spike.project.loyly :as loyly])
  (:import [java.nio.file Files LinkOption]))

(defn copy-safe-tree
  "Recursive copy without following symlinks (port of grader-shards copySafeTree)."
  [from to]
  (let [from (fs/path from)
        attrs (Files/readAttributes from "basic:fileAttributes"
                                    (into-array LinkOption [LinkOption/NOFOLLOW_LINKS]))]
    (cond
      (.isSymbolicLink attrs)
      (throw (ex-info (str "grader evidence contains a symlink or special file: " from)
                      {:from (str from)}))

      (.isRegularFile attrs)
      (do
        (when-let [parent (fs/parent to)]
          (fs/create-dirs parent))
        (fs/copy from to {:replace-existing true}))

      (.isDirectory attrs)
      (do
        (fs/create-dirs to)
        (doseq [name (fs/list-dir from)]
          (copy-safe-tree (fs/path from name) (fs/path to name))))

      :else
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
            {:id (format "shard-%02d" (inc i))
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
        full (hjson/read-json (slurp (fs/file grading-room "checklist.json") :encoding "UTF-8"))
        partitions (partition-by-rule (get full "items") shard-count)]
    (mapv
     (fn [{:keys [id items]}]
       (let [base (fs/path scratch "grader-shards" id)
             checklist-file (fs/file base "inputs" "checklist.json")
             out (fs/file base (str "grading-" id))
             payload (array-map "items" items
                                "counts" (array-map "total" (count items)))
             bytes (str (hjson/compact-json payload) "\n")]
         (fs/create-dirs (fs/path base "inputs"))
         (when (and (fs/regular-file? checklist-file)
                    (not= (slurp checklist-file :encoding "UTF-8") bytes))
           (throw (ex-info (str "grader shard selection changed: " id) {:id id})))
         (when-not (fs/regular-file? checklist-file)
           (hjson/spit-utf8 checklist-file bytes))
         (let [checklist-sha (d/file-sha256 checklist-file)
               args {:source-room source-room
                     :candidate-room grading-room
                     :checklist-file (str (fs/absolutize checklist-file))
                     :schema-file schema-file
                     :out (str (fs/absolutize out))
                     :candidate-sha256 candidate-sha256
                     :checklist-sha256 checklist-sha
                     :schema-sha256 schema-sha256
                     :project project
                     :blind-review blind-review}]
           (if (fs/exists? out)
             (room/verify-grading-room args)
             (room/prepare-grading-room args))
           {:id id
            :items (mapv #(get % "id") items)
            :out (str (fs/absolutize out))
            :checklist-sha256 checklist-sha
            :args args})))
     partitions)))

(defn combine-shards
  "Merge shard grading rooms into one collector view (port of combineShards)."
  [{:keys [grading-room shards candidate-sha256 schema-sha256]}]
  (let [full (hjson/read-json (slurp (fs/file grading-room "checklist.json") :encoding "UTF-8"))
        selected (mapv #(get % "id") (get full "items"))
        seen (vec (mapcat :items shards))]
    (when (or (not= (count seen) (count selected))
              (not= (count (set seen)) (count selected))
              (some #(not (contains? (set seen) %)) selected))
      (throw (ex-info "grader shards do not cover the approved checklist exactly once" {})))
    (let [work (fs/path grading-room "work")
          combined (fs/path work "allure-results")
          shards-dir (fs/path work "shards")]
      (when (fs/exists? combined) (fs/delete-tree combined))
      (when (fs/exists? shards-dir) (fs/delete-tree shards-dir))
      (fs/create-dirs combined)
      (fs/create-dirs shards-dir)
      (let [surprises (atom [])
            room-meta (hjson/read-json
                       (slurp (fs/file grading-room ".grading-room.json") :encoding "UTF-8"))]
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
            (let [source (fs/path (:out shard) "work" "allure-results")]
              (doseq [name (map fs/file-name (fs/list-dir source))]
                (let [dest (fs/path combined name)]
                  (when (fs/exists? dest)
                    (throw (ex-info (str "Allure filename collision: " name) {:name name})))
                  (fs/copy (fs/path source name) dest)))
              (let [evidence (fs/path shards-dir (:id shard))]
                (fs/create-dirs evidence)
                (doseq [name (map fs/file-name (fs/list-dir (fs/path (:out shard) "work")))]
                  (let [source-path (fs/path (:out shard) "work" name)]
                    (when (and (not= name "allure-results")
                               (not= name "surprises.json")
                               (not (and (re-matches #"runtime-.*" name)
                                         (fs/directory? source-path))))
                      (copy-safe-tree source-path (fs/path evidence name))))))
              (swap! surprises into
                     (map (fn [s]
                            (assoc s "evidence_file"
                                   (str "work/shards/" (:id shard) "/"
                                        (subs (get s "evidence_file") 5))))
                          (:surprises judged)))))
        (hjson/spit-utf8 (fs/file work "surprises.json")
                         (hjson/compact-json @surprises))
        (allure/read-allure-results grading-room))))))
