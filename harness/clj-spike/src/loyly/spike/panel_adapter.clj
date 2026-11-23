(ns loyly.spike.panel-adapter
  "PoC port of selectPanelAttempt from harness/pi-durable/panel-adapter.ts.
  VM launch / compilePanel stay on the TS side."
  (:require [babashka.fs :as fs]
            [clojure.string :as str]
            [loyly.spike.digest :as d]
            [loyly.spike.hjson :as hjson]))

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
         :failure (str "attempt was interrupted without a complete receipt")}
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
