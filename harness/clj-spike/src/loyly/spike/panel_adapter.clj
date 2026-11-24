(ns loyly.spike.panel-adapter
  "PoC port of selectPanelAttempt from harness/pi-durable/panel-adapter.ts.
  VM launch / compilePanel stay on the TS side."
  (:require [babashka.fs :as fs]
            [clojure.string :as str]
            [loyly.spike.digest :as d]
            [loyly.spike.hjson :as hjson]
            [loyly.spike.panel-compile :as compile]
            [loyly.spike.panel-vm :as panel-vm]
            [loyly.spike.project.loyly :as loyly]))

(defn- try-attempt [out manifest-name launch verify]
  (try
    (let [manifest (fs/file out manifest-name)
          had-manifest (fs/regular-file? manifest)
          result (cond
                   had-manifest (verify (str out))
                   (fs/exists? out) nil
                   :else (launch (str out)))]
      (if-not result
        {:ok false
         :failure "attempt was interrupted without a complete receipt"}
        (let [checked (verify (str out))]
          {:ok true
           :had-manifest had-manifest
           :checked checked
           :manifest-sha256 (d/file-sha256 manifest)})))
    (catch Exception e
      (when (fs/exists? out)
        (hjson/spit-utf8 (fs/file out "controller-error.txt")
                         (str (or (.getMessage e) (str e)) "\n")))
      {:ok false :failure (.getMessage e)})))

(defn select-panel-attempt
  "Bounded attempt selection with selected.json receipt.
  `launch` and `verify` are fns of attempt-out path; launch may return nil."
  [{:keys [root launch verify max-attempts manifest-name]
    :or {max-attempts 2 manifest-name "manifest.json"}}]
  (let [root (fs/absolutize root)]
    (fs/create-dirs root)
    (let [selected-file (fs/file root "selected.json")]
      (if (fs/regular-file? selected-file)
        (let [selected (hjson/read-json (slurp selected-file :encoding "UTF-8"))
              attempt (get selected "attempt")
              out (fs/file root (format "attempt-%02d" attempt))
              result (verify (str out))]
          (when-not (= (get selected "manifest_sha256")
                       (d/file-sha256 (fs/file out manifest-name)))
            (throw (ex-info "selected panel manifest changed" {})))
          (merge result {:attempt attempt :reconciled true}))
        (loop [attempt 1 failures []]
          (if (> attempt max-attempts)
            (throw (ex-info (str "panel VM attempts exhausted: "
                                 (str/join "; " failures))
                            {:failures failures}))
            (let [out (fs/file root (format "attempt-%02d" attempt))
                  outcome (try-attempt out manifest-name launch verify)]
              (if (:ok outcome)
                (let [selected (array-map
                                "schema" "loyly.panel-selection.v1"
                                "attempt" attempt
                                "manifest_sha256" (:manifest-sha256 outcome))
                      partial (fs/file root "selected.json.partial")]
                  (hjson/spit-utf8 partial (str (hjson/compact-json selected) "\n"))
                  (fs/move partial selected-file {:replace-existing true})
                  (merge (:checked outcome)
                         {:attempt attempt
                          :reconciled (:had-manifest outcome)}))
                (recur (inc attempt)
                       (conj failures
                             (str "attempt " attempt ": " (:failure outcome))))))))))))

(defn run-durable-panel
  "Select or launch panel VMs with pinned plan/image digests."
  [{:keys [scratch image plan-file approved-plan-sha256 approved-image-sha256
           pi-durable gondolin-fn]
    :or {plan-file loyly/DEFAULT_PANEL_PLAN
         pi-durable "harness/pi-durable"}}]
  (let [scratch (str (fs/absolutize scratch))
        image (str (fs/absolutize image))
        here (fs/file scratch pi-durable)
        plan-path (if (fs/absolute? (fs/path plan-file))
                    (fs/file plan-file)
                    (fs/file here plan-file))]
    (when (or (not (re-matches #"[0-9a-f]{64}" (str approved-plan-sha256)))
              (not (re-matches #"[0-9a-f]{64}" (str approved-image-sha256)))
              (not= (d/file-sha256 plan-path) approved-plan-sha256)
              (not= (d/file-sha256 (fs/file image "manifest.json")) approved-image-sha256))
      (throw (ex-info "panel plan or Gondolin image differs from approved digest" {})))
    (select-panel-attempt
     {:root (str (fs/file scratch "panel-vm"))
      :launch (fn [out]
                (panel-vm/run-panel-vms {:original scratch :image image :out out
                                         :plan-file (str plan-path)
                                         :pi-durable pi-durable
                                         :gondolin-fn gondolin-fn}))
      :verify (fn [out]
                (panel-vm/verify-panel-vm-run
                 {:original scratch :out out
                  :image-digest (str "sha256:" approved-image-sha256)
                  :plan-file (str plan-path)
                  :pi-durable pi-durable}))})))

(defn run-durable-panel-report
  "Select or compile a panel Allure report."
  [{:keys [scratch specialists plan-file pi-durable allure-cli-fn audit-rows-fn]
    :or {plan-file loyly/DEFAULT_PANEL_PLAN
         pi-durable "harness/pi-durable"}}]
  (let [scratch (str (fs/absolutize scratch))
        specialists (str (fs/absolutize specialists))
        plan-path (let [here (fs/file scratch pi-durable)]
                    (if (fs/absolute? (fs/path plan-file))
                      (str (fs/file plan-file))
                      (str (fs/file here plan-file))))]
    (select-panel-attempt
     {:root (str (fs/file scratch "panel-report"))
      :manifest-name "panel-manifest.json"
      :launch (fn [out]
                (compile/compile-panel {:original scratch :specialists specialists :out out
                                        :plan-file plan-path :pi-durable pi-durable
                                        :allure-cli-fn allure-cli-fn
                                        :audit-rows-fn audit-rows-fn}))
      :verify (fn [out]
                (compile/verify-compiled-panel {:original scratch :out out
                                                :plan-file plan-path}))})))
