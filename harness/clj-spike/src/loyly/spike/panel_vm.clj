(ns loyly.spike.panel-vm
  "PoC port of specialist worker resolution from harness/pi-durable/panel-vm-run.ts.
  VM launch / QEMU stay on the TS side."
  (:require [babashka.fs :as fs]
            [loyly.spike.digest :as d]
            [loyly.spike.grading-room :as room]
            [loyly.spike.hjson :as hjson]
            [loyly.spike.project.loyly.schemas :as schemas]
            [loyly.spike.score-receipt :as receipt]))

(def LEGACY_WORKERS
  [{:id "browser" :script "panel-browser.mjs" :tool "Playwright" :item "01-003"}
   {:id "protocol" :script "panel-protocol.mjs" :tool "Node.js" :item "01-010"}
   {:id "telemetry" :script "panel-telemetry.mjs" :tool "OpenTelemetry" :item "01-003"}])

(defn worker-bundle
  "Resolve specialist script root. `here` is the pi-durable directory."
  [plan here]
  (cond
    (= (get plan "schema") schemas/LEGACY_PANEL_PLAN)
    {:root (str here) :sha256 nil}

    (not (and (= (get plan "schema") "harness.grading-panel-plan.v2")
              (re-matches #"[a-z][a-z0-9/-]*" (str (get-in plan ["bundle" "path"])))
              (re-matches #"[0-9a-f]{64}" (str (get-in plan ["bundle" "sha256"])))))
    (throw (ex-info "panel needs a pinned project worker bundle" {}))

    :else
    (let [root (fs/path here (get-in plan ["bundle" "path"]))
          digest (d/tree-digest root "bundle")]
      (when-not (= digest (get-in plan ["bundle" "sha256"]))
        (throw (ex-info "project worker bundle differs from the panel plan" {})))
      {:root (str root) :sha256 (get-in plan ["bundle" "sha256"])})))

(defn specialist-workers
  "Resolve specialist checks to runnable worker descriptors."
  [plan here]
  (let [{:keys [root]} (worker-bundle plan here)
        checks (filterv #(= "specialist" (get % "source")) (or (get plan "checks") []))]
    (when (or (empty? checks)
              (not= (count checks) (count (set (map #(get % "id") checks)))))
      (throw (ex-info "panel needs unique specialist checks" {})))
    (mapv
     (fn [check]
       (let [legacy (when (= (get plan "schema") schemas/LEGACY_PANEL_PLAN)
                      (first (filter #(= (:id %) (get check "id")) LEGACY_WORKERS)))
             script (or (get check "script") (:script legacy))]
         (when (or (nil? script)
                   (not (re-matches #"[a-z][a-z0-9-]*\.mjs" script))
                   (not (fs/regular-file? (fs/path root script)))
                   (not= 1 (count (get check "items")))
                   (and (nil? (get check "script"))
                        (or (nil? legacy)
                            (not= (:tool legacy) (get check "tool"))
                            (not= (:item legacy) (first (get check "items"))))))
           (throw (ex-info (str (get check "id")
                                ": specialist script or item differs from the panel plan")
                           {:id (get check "id")})))
         {:id (get check "id")
          :script script
          :tool (get check "tool")
          :item (first (get check "items"))
          :technique (get check "technique")
          :feature (or (get check "feature") (get plan "feature"))
          :probe (get check "probe")}))
     checks)))

(defn run-binding
  "Port of runBinding(original): score-input or cut HEAD + candidate digest."
  [original]
  (let [input (fs/file original "score-input.json")]
    (if (fs/regular-file? input)
      (hjson/read-json (slurp input :encoding "UTF-8"))
      (let [cut (fs/path original "cut" "project")
            head (d/git cut "rev-parse" "HEAD")]
        (when-not (re-matches #"[0-9a-f]{40}" head)
          (throw (ex-info "panel needs a pinned source cut" {})))
        (array-map "source_commit" head
                   "candidate_sha256"
                   (room/candidate-digest (fs/path original "fenced-room")))))))

(defn score-digest
  "SHA-256 of the bound cycle scores.json, or nil."
  [original]
  (let [input (fs/file original "score-input.json")]
    (when (fs/regular-file? input)
      (let [cycle (receipt/score-cycle-for original)
            score (fs/file original "instrument" "harness" "cycles" cycle "scores.json")]
        (when (fs/regular-file? score)
          (d/file-sha256 score))))))
