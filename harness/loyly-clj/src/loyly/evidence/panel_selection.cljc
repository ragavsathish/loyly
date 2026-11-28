(ns loyly.evidence.panel-selection
  "PoC port of harness/evidence-core/panel-selection.ts")

(defn validate-panel-coverage
  "Return {:selected :specialist-ids}."
  [plan checklist & {:keys [handoff-item]}]
  (let [ids (mapv #(get % "id") (get checklist "items"))]
    (when (or (not (vector? ids)) (empty? ids) (not= (count ids) (count (set ids))))
      (throw (ex-info "panel selection needs a unique scored checklist" {})))
    (let [selected (set ids)]
      (when (and handoff-item (not (contains? selected handoff-item)))
        (throw (ex-info (str "blind handoff requires selected item " handoff-item)
                        {:handoff-item handoff-item})))
      (let [checks (get plan "checks")
            check-ids (mapv #(get % "id") checks)]
        (when-not (= (count check-ids) (count (set check-ids)))
          (throw (ex-info "panel check IDs must be unique" {})))
        (let [raw (filterv #(= "raw-grader" (get % "source")) checks)
              raw-ids (mapcat #(get % "items") raw)]
          (when (or (not= (count raw-ids) (count ids))
                    (not= (count (set raw-ids)) (count ids))
                    (some #(not (contains? selected %)) raw-ids))
            (throw (ex-info "raw grader checks must exactly cover selected checklist items" {})))
          (when (some (fn [check]
                        (some (fn [id]
                                (not= (get check "role")
                                      (if (and handoff-item (= id handoff-item))
                                        "handoff" "scored")))
                              (get check "items")))
                      raw)
            (throw (ex-info "raw grader roles differ from the selected blind handoff" {})))
          (let [blind (filterv #(= "blind-review" (get % "source")) checks)]
            (when (if handoff-item
                    (or (not= 1 (count blind))
                        (not= "scored" (get (first blind) "role"))
                        (not= 1 (count (get (first blind) "items")))
                        (not= handoff-item (first (get (first blind) "items"))))
                    (not (zero? (count blind))))
              (throw (ex-info (str "panel needs one scored blind review for "
                                   (or handoff-item "selected item"))
                              {})))
            (let [specialists (filterv #(= "specialist" (get % "source")) checks)]
              (when (some #(not (#{"corroborating" "diagnostic"} (get % "role"))) specialists)
                (throw (ex-info "specialist checks may corroborate or diagnose, not file a score" {})))
              (when (some (fn [check]
                            (some #(not (contains? selected %)) (get check "items")))
                          specialists)
                (throw (ex-info "specialist check names an unselected item" {})))
              {:selected ids
               :specialist-ids (mapv #(get % "id") specialists)})))))))
