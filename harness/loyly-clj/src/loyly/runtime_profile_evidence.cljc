(ns loyly.runtime-profile-evidence
  "PoC port of harness/pi-durable/runtime-profile-evidence.mjs checks used by
  panel-runtime workers."
  (:require [clojure.string :as str]
            [loyly.hjson :as hjson]
            [loyly.platform :as plat]))

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
    (let [path (plat/path dir (get profile "source"))]
      (when-not (plat/regular-file? path)
        (throw (ex-info "runtime profile bytes missing" {:path (str path)})))
      (let [body (hjson/read-json (plat/read-text path))]
        (when (and candidate-sha256
                   (not= (get body "candidate_sha256") candidate-sha256))
          (throw (ex-info "runtime profile candidate digest differs" {})))
        (when (and probe (not= (get body "probe") probe)
                   (not= (get-in body ["probe" "id"]) (get probe "id")))
          (throw (ex-info "runtime profile probe differs from panel plan" {})))
        body))))
