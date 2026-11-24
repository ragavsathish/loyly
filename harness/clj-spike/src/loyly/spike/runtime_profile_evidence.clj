(ns loyly.spike.runtime-profile-evidence
  "PoC port of harness/pi-durable/runtime-profile-evidence.mjs checks used by
  panel-runtime workers."
  (:require [babashka.fs :as fs]
            [clojure.string :as str]
            [loyly.spike.hjson :as hjson]))

(defn verify-runtime-profile-evidence
  "Ensure a panel-runtime worker wrote a coherent profile attachment."
  [{:keys [dir result candidate-sha256 probe]}]
  (when-not (and (map? result) (vector? (get result "attachments")))
    (throw (ex-info "runtime profile needs an Allure result with attachments" {})))
  (let [attachments (get result "attachments")
        profile (some (fn [a]
                        (when (or (str/includes? (str (get a "name")) "profile")
                                  (str/ends-with? (str (get a "source")) ".profile.json"))
                          a))
                      attachments)]
    (when-not profile
      (throw (ex-info "runtime profile evidence attachment missing" {})))
    (let [path (fs/file dir (get profile "source"))]
      (when-not (fs/regular-file? path)
        (throw (ex-info "runtime profile bytes missing" {:path (str path)})))
      (let [body (hjson/read-json (slurp path :encoding "UTF-8"))]
        (when (and candidate-sha256
                   (not= (get body "candidate_sha256") candidate-sha256))
          (throw (ex-info "runtime profile candidate digest differs" {})))
        (when (and probe (not= (get body "probe") probe)
                   (not= (get-in body ["probe" "id"]) (get probe "id")))
          (throw (ex-info "runtime profile probe differs from panel plan" {})))
        body))))
