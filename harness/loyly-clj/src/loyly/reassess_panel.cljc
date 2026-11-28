(ns loyly.reassess-panel
  "Reassess only the project panel against a previously scored, frozen Pi cycle (.cljc).

  Port of harness/pi-durable/reassess-panel.mjs. Original score and Pi audit are
  immutable inputs; writes a separate reassessment receipt under :out."
  (:require [loyly.audit-rows :as audit]
            [loyly.digest :as d]
            [loyly.grading-room :as room]
            [loyly.hjson :as hjson]
            [loyly.panel-adapter :as panel-ad]
            [loyly.panel-compile :as compile]
            [loyly.panel-vm :as panel-vm]
            [loyly.platform :as plat]
            [loyly.project.loyly :as loyly]
            [loyly.score-receipt :as receipt]))

(def ^:private hex40 #"^[0-9a-f]{40}$")
(def ^:private hex64 #"^[0-9a-f]{64}$")
(def ^:private plan-file-re #"^[a-z][a-z0-9-]*\.panel\.json$")

(defn check-reassessment
  "Verify a pinned loyly.pi-panel-reassessment.v1 contract against the clean
   controller commit, frozen candidate, filed score, and committed Pi audit.
   Pass :audit-rows (vector of maps) if already loaded asynchronously."
  [config {:keys [root pi-durable audit-rows]}]
  (let [plan-file-name (get config "plan_file")]
    (when (or (not= "loyly.pi-panel-reassessment.v1" (get config "schema"))
              (not (re-matches hex40 (str (or (get config "controller_commit") ""))))
              (not (re-matches hex40 (str (or (get config "source_commit") ""))))
              (some #(not (re-matches hex64 (str (or % ""))))
                    [(get config "candidate_sha256")
                     (get config "score_sha256")
                     (get config "plan_sha256")
                     (get config "image_sha256")])
              (not (string? (get config "original")))
              (not (string? (get config "out")))
              (not (string? (get config "image")))
              (and (some? plan-file-name)
                   (not (re-matches plan-file-re (str plan-file-name)))))
      (throw (ex-info "panel reassessment needs a fully pinned contract" {}))))
  (let [repo (plat/absolutize (or root "."))
        here (plat/absolutize (or pi-durable (plat/path repo "harness" "pi-durable")))
        original (plat/absolutize (get config "original"))
        out (plat/absolutize (get config "out"))
        image (plat/absolutize (get config "image"))]
    (when (or (= out original) (not (.startsWith out (str original "/"))))
      (throw (ex-info "reassessment output must be a private directory in the original scratch" {})))
    (when (or (not= (d/git repo "rev-parse" "HEAD") (get config "controller_commit"))
              (seq (d/git repo "status" "--porcelain")))
      (throw (ex-info "controller differs from the pinned clean commit" {})))
    (let [plan-file (plat/path here (or (get config "plan_file") loyly/DEFAULT_PANEL_PLAN))]
      (when (or (not= (d/file-sha256 plan-file) (get config "plan_sha256"))
                (not= (d/file-sha256 (plat/path image "manifest.json")) (get config "image_sha256")))
        (throw (ex-info "panel plan or VM image changed" {})))
      (let [score (receipt/verify-scored-cycle
                   {:scratch original
                    :instrument (plat/path original "instrument")
                    :verdicts-file (plat/path original "final-verdicts.json")
                    :cycle (receipt/score-cycle-for original)})
            input (hjson/read-json (plat/read-text (plat/path original "score-input.json")))
            rows (or audit-rows (audit/read-audit-rows original))
            filed (last (filter #(and (= "score" (get % "stage"))
                                      (= "filed" (get % "outcome")))
                                rows))]
        (when (or (not= (get input "source_commit") (get config "source_commit"))
                  (not= (get input "candidate_sha256") (get config "candidate_sha256"))
                  (not= (room/candidate-digest (plat/path original "fenced-room"))
                        (get config "candidate_sha256"))
                  (not= (:score-sha256 score) (get config "score_sha256"))
                  (not= (get filed "score_file_sha256") (get config "score_sha256"))
                  (not= (get filed "score_input_sha256")
                        (d/file-sha256 (plat/path original "score-input.json"))))
          (throw (ex-info "frozen candidate or filed Pi score differs from reassessment contract" {})))
        {:original original
         :out out
         :image image
         :plan-file plan-file
         :score score
         :input input}))))

(defn finalize-reassessment-receipt
  "Write and verify the immutable loyly.pi-panel-reassessment-result.v1 receipt."
  [{:keys [config out score input vm-dir vm-attempt report-dir report-attempt
           panel-outcome allure-cases]}]
  (let [receipt-file (plat/path out "reassessment.json")
        receipt-map (array-map
                     "schema" "loyly.pi-panel-reassessment-result.v1"
                     "controller_commit" (get config "controller_commit")
                     "source_commit" (get config "source_commit")
                     "candidate_sha256" (get config "candidate_sha256")
                     "filed_score_sha256" (:score-sha256 score)
                     "filed_score" (:score score)
                     "original_panel_manifest_sha256" (get input "panel_manifest_sha256")
                     "revised_plan_sha256" (get config "plan_sha256")
                     "revised_vm_manifest_sha256" (d/file-sha256 (plat/path vm-dir "manifest.json"))
                     "revised_report_manifest_sha256" (d/file-sha256 (plat/path report-dir "panel-manifest.json"))
                     "panel_outcome" panel-outcome
                     "allure_cases" allure-cases
                     "vm_attempt" vm-attempt
                     "report_attempt" report-attempt
                     "original_cycle_unchanged" true)
        bytes (str (hjson/write receipt-map) "\n")]
    (when (and (plat/exists? receipt-file)
               (not= (plat/read-text receipt-file) bytes))
      (throw (ex-info "panel reassessment receipt changed" {:receipt receipt-file})))
    (when-not (plat/exists? receipt-file)
      (hjson/spit-utf8 (str receipt-file ".partial") bytes)
      (plat/move (str receipt-file ".partial") receipt-file))
    (assoc receipt-map "out" report-dir)))

(defn run-reassessment
  "Execute panel-only reassessment synchronously via injectable VM + Allure hooks."
  [config {:keys [root pi-durable audit-rows gondolin-fn allure-cli-fn]}]
  (let [{:keys [original out image plan-file score input]}
        (check-reassessment config {:root root :pi-durable pi-durable :audit-rows audit-rows})
        here (plat/absolutize (or pi-durable (plat/path (or root ".") "harness" "pi-durable")))]
    (plat/create-dirs out)
    (let [vm (panel-ad/select-panel-attempt
              {:root (plat/path out "vm")
               :launch (fn [dir]
                         (panel-vm/run-panel-vms
                          {:original original :image image :out dir :plan-file plan-file
                           :pi-durable here :gondolin-fn gondolin-fn}))
               :verify (fn [dir]
                         (panel-vm/verify-panel-vm-run
                          {:original original :out dir
                           :image-digest (str "sha256:" (get config "image_sha256"))
                           :plan-file plan-file :pi-durable here}))})
          vm-dir (plat/path out "vm" (str "attempt-" (plat/pad-left-zero (:attempt vm) 2)))
          report (panel-ad/select-panel-attempt
                  {:root (plat/path out "report")
                   :manifest-name "panel-manifest.json"
                   :launch (fn [dir]
                             (compile/compile-panel
                              {:original original :specialists vm-dir :out dir :plan-file plan-file
                               :pi-durable here :allure-cli-fn allure-cli-fn
                               :audit-rows-fn (when audit-rows (constantly audit-rows))}))
                   :verify (fn [dir]
                             (compile/verify-compiled-panel
                              {:original original :out dir :plan-file plan-file :pi-durable here}))})
          report-dir (plat/path out "report" (str "attempt-" (plat/pad-left-zero (:attempt report) 2)))]
      (finalize-reassessment-receipt
       {:config config
        :out out
        :score score
        :input input
        :vm-dir vm-dir
        :vm-attempt (:attempt vm)
        :report-dir report-dir
        :report-attempt (:attempt report)
        :panel-outcome (get-in report [:summary "panel_outcome"])
        :allure-cases (get-in report [:stats "total"])}))))
