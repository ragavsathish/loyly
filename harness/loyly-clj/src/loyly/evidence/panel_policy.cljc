(ns loyly.evidence.panel-policy
  "PoC port of harness/evidence-core/panel-policy.ts"
  (:require [clojure.string :as str]))

(defn- index-panel-expectations [plan scored-items]
  (let [checks (get plan "checks")]
    (when (or (not (vector? checks))
              (not (vector? scored-items))
              (empty? scored-items))
      (throw (ex-info "panel needs a plan and scored items" {})))
    (let [item-ids (set (map #(get % "id") scored-items))]
      (when-not (= (count item-ids) (count scored-items))
        (throw (ex-info "duplicate scored item" {})))
      (loop [checks checks check-ids #{} expected {} order []]
        (if-let [check (first checks)]
          (let [id (get check "id")]
            (when (contains? check-ids id)
              (throw (ex-info (str "duplicate panel check " id) {:id id})))
            (let [[expected order]
                  (reduce (fn [[exp ord] item]
                            (when-not (contains? item-ids item)
                              (throw (ex-info (str id " names an unscored item " item)
                                              {:check id :item item})))
                            (let [key (str id "/" item)]
                              (when (contains? exp key)
                                (throw (ex-info (str "duplicate panel assignment " key)
                                                {:key key})))
                              [(assoc exp key check) (conj ord key)]))
                          [expected order]
                          (get check "items"))]
              (recur (rest checks) (conj check-ids id) expected order)))
          {:expected expected :order order})))))

(defn- collect-observed-checks [{:keys [expected order]} observations]
  (let [observed
        (reduce
         (fn [obs row]
           (let [key (str (get row "id") "/" (get row "item"))]
             (when (or (not (contains? expected key)) (contains? obs key))
               (throw (ex-info (str "extra or duplicate panel result " key) {:key key})))
             (let [check (get expected key)]
               (when (or (not= (get row "tool") (get check "tool"))
                         (not= (get row "technique") (get check "technique")))
                 (throw (ex-info (str key " tool or technique differs from panel plan")
                                 {:key key})))
               (when (or (str/blank? (str (get row "message")))
                         (not (re-matches #"[0-9a-f]{64}" (str (get row "result_sha256")))))
                 (throw (ex-info (str key " has no bound observation") {:key key})))
               (when (and (= "handoff" (get check "role"))
                          (not= "skipped" (get row "status")))
                 (throw (ex-info (str key " must leave the independent review pending")
                                 {:key key})))
               (when (and (= "scored" (get check "role"))
                          (not (#{"passed" "failed"} (get row "status"))))
                 (throw (ex-info (str key " cannot decide a score with " (get row "status"))
                                 {:key key})))
               (assoc obs key
                      (array-map
                       "id" (get check "id")
                       "item" (get row "item")
                       "role" (get check "role")
                       "tool" (get check "tool")
                       "technique" (get check "technique")
                       "status" (get row "status")
                       "runtime" (get row "runtime")
                       "target_runtime" (get check "target_runtime")
                       "result_sha256" (get row "result_sha256")
                       "criterion" (get check "criterion")
                       "failure" (get check "failure")
                       "message" (get row "message"))))))
         {}
         observations)]
    (mapv (fn [key]
            (or (get observed key)
                (throw (ex-info (str "missing panel result " key) {:key key}))))
          order)))

(defn- evaluate-panel-items [scored-items checks]
  (mapv
   (fn [item]
     (let [selected (filterv #(= (get % "item") (get item "id")) checks)
           decisive (filterv #(= "scored" (get % "role")) selected)]
       (when (not= 1 (count decisive))
         (throw (ex-info (str (get item "id") " needs exactly one scored panel check")
                         {:id (get item "id")})))
       (let [expected-verdict (if (= "passed" (get (first decisive) "status")) "pass" "fail")]
         (when-not (= (get item "verdict") expected-verdict)
           (throw (ex-info (str (get item "id") " panel result disagrees with the filed score")
                           {:id (get item "id")})))
         (let [contradiction (some #(and (= "corroborating" (get % "role"))
                                         (not= "passed" (get % "status")))
                                   selected)
               panel-status (cond
                              contradiction "conflicted"
                              (= "pass" (get item "verdict")) "supported"
                              :else "failed")]
           (array-map
            "id" (get item "id")
            "rule" (get item "rule")
            "filed_verdict" (get item "verdict")
            "check_ids" (mapv #(get % "id") selected)
            "panel_status" panel-status)))))
   scored-items))

(defn- collect-panel-gaps [checks items]
  (vec
   (concat
    (mapcat
     (fn [check]
       (cond-> []
         (not= (get check "runtime") (get check "target_runtime"))
         (conj (str (get check "id") "/" (get check "item")
                    ": observed " (get check "runtime")
                    "; target " (get check "target_runtime")))
         (and (= "diagnostic" (get check "role"))
              (not= "passed" (get check "status")))
         (conj (str (get check "id") "/" (get check "item")
                    ": diagnostic " (get check "status")))))
     checks)
    (map (fn [item]
           (str (get item "id") ": filed " (get item "filed_verdict")
                "; panel " (get item "panel_status")))
         (filter #(not= "supported" (get % "panel_status")) items)))))

(defn evaluate-panel
  [plan scored-items observations]
  (let [indexed (index-panel-expectations plan scored-items)
        checks (collect-observed-checks indexed observations)
        items (evaluate-panel-items scored-items checks)
        gaps (collect-panel-gaps checks items)]
    {:checks checks
     :items items
     :gaps gaps
     :panel-outcome (if (seq gaps) "not-ready" "ready-for-review")}))
