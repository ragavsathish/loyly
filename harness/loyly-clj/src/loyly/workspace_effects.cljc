(ns loyly.workspace-effects
  "Port of harness/pi-durable/workspace-effects.ts (.cljc)."
  #?(:cljs (:refer-clojure :exclude [exists?]))
  (:require [loyly.hjson :as hjson]
            [loyly.platform :as plat]))

(defn exists? [path]
  (plat/exists? path))

(defn read-text [path]
  (try
    (plat/read-text (plat/path path))
    (catch #?(:clj Exception :cljs :default) e
      (throw (ex-info "workspace read failed"
                      {:path (str path) :reason (ex-message e)})))))

(defn parse-workspace-json [path text]
  (try
    (hjson/read-json text)
    (catch #?(:clj Exception :cljs :default) e
      (throw (ex-info "invalid workspace data"
                      {:path (str path) :reason (ex-message e)})))))

(defn read-workspace-json [path]
  (parse-workspace-json path (read-text path)))
