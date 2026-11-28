(ns loyly.panel-adapter
  "PoC port of selectPanelAttempt from harness/pi-durable/panel-adapter.ts.
  VM launch / compilePanel stay on the TS side."
  (:require [clojure.string :as str]
            [loyly.digest :as d]
            [loyly.hjson :as hjson]
            [loyly.panel-compile :as compile]
            [loyly.panel-vm :as panel-vm]
            [loyly.platform :as plat]
            [loyly.project.loyly :as loyly]))

(defn- try-attempt [out manifest-name launch verify]
  (try
    (let [manifest (plat/path out manifest-name)
          had-manifest (plat/regular-file? manifest)
          result (cond
                   had-manifest (verify (str out))
                   (plat/exists? out) nil
                   :else (launch (str out)))]
      (if-not result
        {:ok false
         :failure "attempt was interrupted without a complete receipt"}
        (let [checked (verify (str out))]
          {:ok true
           :had-manifest had-manifest
           :checked checked
           :manifest-sha256 (d/file-sha256 manifest)})))
    (catch #?(:clj Exception :cljs :default) e
      (when (plat/exists? out)
        (hjson/spit-utf8 (plat/path out "controller-error.txt")
                         (str (or (ex-message e) (str e)) "\n")))
      {:ok false :failure (ex-message e)})))

(defn select-panel-attempt
  "Bounded attempt selection with selected.json receipt.
  `launch` and `verify` are fns of attempt-out path; launch may return nil."
  [{:keys [root launch verify max-attempts manifest-name]
    :or {max-attempts 2 manifest-name "manifest.json"}}]
  (let [root (plat/absolutize root)]
    (plat/create-dirs root)
    (let [selected-file (plat/path root "selected.json")]
      (if (plat/regular-file? selected-file)
        (let [selected (hjson/read-json (plat/read-text selected-file))
              attempt (get selected "attempt")
              out (plat/path root (str "attempt-" (plat/pad-left-zero attempt 2)))
              result (verify (str out))]
          (when-not (= (get selected "manifest_sha256")
                       (d/file-sha256 (plat/path out manifest-name)))
            (throw (ex-info "selected panel manifest changed" {})))
          (merge result {:attempt attempt :reconciled true}))
        (loop [attempt 1 failures []]
          (if (> attempt max-attempts)
            (throw (ex-info (str "panel VM attempts exhausted: "
                                 (str/join "; " failures))
                            {:failures failures}))
            (let [out (plat/path root (str "attempt-" (plat/pad-left-zero attempt 2)))
                  outcome (try-attempt out manifest-name launch verify)]
              (if (:ok outcome)
                (let [selected (array-map
                                "schema" "loyly.panel-selection.v1"
                                "attempt" attempt
                                "manifest_sha256" (:manifest-sha256 outcome))
                      partial (plat/path root "selected.json.partial")]
                  (hjson/spit-utf8 partial (str (hjson/compact-json selected) "\n"))
                  (plat/move partial selected-file)
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
  (let [scratch (str (plat/absolutize scratch))
        image (str (plat/absolutize image))
        here (plat/path scratch pi-durable)
        plan-path (if (plat/absolute? (plat/path plan-file))
                    (plat/path plan-file)
                    (plat/path here plan-file))]
    (when (or (not (re-matches #"[0-9a-f]{64}" (str approved-plan-sha256)))
              (not (re-matches #"[0-9a-f]{64}" (str approved-image-sha256)))
              (not= (d/file-sha256 plan-path) approved-plan-sha256)
              (not= (d/file-sha256 (plat/path image "manifest.json")) approved-image-sha256))
      (throw (ex-info "panel plan or Gondolin image differs from approved digest" {})))
    (select-panel-attempt
     {:root (str (plat/path scratch "panel-vm"))
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
  (let [scratch (str (plat/absolutize scratch))
        specialists (str (plat/absolutize specialists))
        plan-path (let [here (plat/path scratch pi-durable)]
                    (if (plat/absolute? (plat/path plan-file))
                      (str (plat/path plan-file))
                      (str (plat/path here plan-file))))]
    (select-panel-attempt
     {:root (str (plat/path scratch "panel-report"))
      :manifest-name "panel-manifest.json"
      :launch (fn [out]
                (compile/compile-panel {:original scratch :specialists specialists :out out
                                        :plan-file plan-path :pi-durable pi-durable
                                        :allure-cli-fn allure-cli-fn
                                        :audit-rows-fn audit-rows-fn}))
      :verify (fn [out]
                (compile/verify-compiled-panel {:original scratch :out out
                                                :plan-file plan-path}))})))
