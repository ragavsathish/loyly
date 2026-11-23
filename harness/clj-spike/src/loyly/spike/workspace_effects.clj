(ns loyly.spike.workspace-effects
  "PoC port of harness/pi-durable/workspace-effects.ts without Effect-TS."
  (:require [babashka.fs :as fs]
            [loyly.spike.hjson :as hjson]))

(defn exists? [path]
  (fs/exists? path))

(defn read-text [path]
  (try
    (slurp (fs/file path) :encoding "UTF-8")
    (catch Exception e
      (throw (ex-info "workspace read failed"
                      {:path (str path) :reason (.getMessage e)})))))

(defn parse-workspace-json [path text]
  (try
    (hjson/read-json text)
    (catch Exception e
      (throw (ex-info "invalid workspace data"
                      {:path (str path) :reason (.getMessage e)})))))

(defn read-workspace-json [path]
  (parse-workspace-json path (read-text path)))
