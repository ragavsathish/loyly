(ns loyly.spike.audit-rows
  "PoC port of harness/pi-durable/audit-rows.ts.
  Pi Harness + Node sqlite stay deferred; accept an injectable reader or a
  committed JSONL/JSON dump of audit rows for replay."
  (:require [babashka.fs :as fs]
            [loyly.spike.hjson :as hjson]))

(defn normalize-rows
  "Ensure each row has sequential :seq / \"seq\" numbering when missing."
  [rows]
  (mapv (fn [i row]
          (cond-> row
            (and (map? row) (nil? (or (get row "seq") (:seq row))))
            (assoc "seq" (inc i))))
        (range)
        rows))

(defn read-audit-rows-json
  "Read committed audit rows from `dir/audit-rows.json` (spike substitute for sqlite)."
  [dir]
  (let [path (fs/file dir "audit-rows.json")]
    (when-not (fs/regular-file? path)
      (throw (ex-info (str "no audit-rows.json in " dir
                           " — inject :read-audit-rows or dump Pi audit here")
                      {:dir (str dir)})))
    (normalize-rows (hjson/read-json (slurp path :encoding "UTF-8")))))

(defn read-audit-rows
  "Port of readAuditRows(dir). Default reads audit-rows.json; pass
  `:read-fn` to inject the Pi sqlite/Harness reader."
  [dir & {:keys [read-fn]}]
  (if read-fn
    (normalize-rows (read-fn dir))
    (read-audit-rows-json dir)))
