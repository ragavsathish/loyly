(ns loyly.spike.live-contract
  "PoC port of pure helpers from harness/pi-durable/live-contract.ts.
  Full Ajv schema compile is deferred; callers pass already-shaped maps."
  (:require [babashka.fs :as fs]
            [clojure.string :as str]
            [loyly.spike.digest :as d]
            [loyly.spike.gen-checklist :as checklist]
            [loyly.spike.hjson :as hjson]
            [loyly.spike.project.loyly :as loyly]))

(def SPEC-PATH-RE #"^docs/plan/\d\d-[a-z][a-z0-9-]*/spec\.feature$")

(defn- require-hash [path expected]
  (let [actual (d/file-sha256 path)]
    (when-not (= actual expected)
      (throw (ex-info (str "digest changed: " path " (" actual ")")
                      {:path path :actual actual :expected expected})))))

(defn- path-in-source [repo relative]
  (when (or (fs/absolute? (fs/path relative))
            (some #{".."} (str/split relative #"[\\/]")))
    (throw (ex-info "spec_file must stay inside the pinned source cut" {:relative relative})))
  (fs/file repo relative))

(defn verify-selected-specs
  "Port of verifySelectedSpecs(repo, source, checklist?)."
  ([repo source] (verify-selected-specs repo source nil))
  ([repo source checklist]
   (let [selected (or (get source "specs")
                      [{"file" (get source "spec_file")
                        "sha256" (get source "spec_sha256")}])
         paths (mapv #(get % "file") selected)]
     (when (or (not= (count (set paths)) (count paths))
               (some #(nil? (re-matches SPEC-PATH-RE %)) paths))
       (throw (ex-info "approved specs must uniquely name numbered product plans" {})))
     (doseq [spec selected]
       (require-hash (path-in-source repo (get spec "file")) (get spec "sha256")))
     (when checklist
       (let [actual (->> (get checklist "items")
                         (map (fn [item]
                                (let [m (re-matches
                                         #"^(docs/plan/\d\d-[a-z][a-z0-9-]*/spec\.feature):\d+$"
                                         (or (get item "source") ""))]
                                  (when-not m
                                    (throw (ex-info
                                            (str "checklist item has no numbered product spec source: "
                                                 (get item "id"))
                                            {:id (get item "id")})))
                                  (second m))))
                         set
                         sort
                         vec)
             expected (->> paths sort vec)]
         (when-not (= (hjson/compact-json expected) (hjson/compact-json actual))
           (throw (ex-info "approved spec files do not exactly cover the derived checklist" {})))))
     selected)))

(defn- verify-image
  "Port of verifyImage(image, expectedManifestSha256)."
  [image expected-manifest-sha256]
  (let [manifest-file (fs/file image "manifest.json")]
    (require-hash manifest-file expected-manifest-sha256)
    (let [manifest (hjson/read-json (slurp manifest-file :encoding "UTF-8"))
          assets (or (get manifest "assets") {})
          checksums (or (get manifest "checksums") {})]
      (doseq [[kind name] assets]
        (let [expected (get checksums kind)]
          (when-not (and (string? expected) (re-matches #"[0-9a-f]{64}" expected))
            (throw (ex-info (str "image asset " kind " has no checksum") {:kind kind})))
          (require-hash (fs/file image name) expected))))))

(defn derive-approved-checklist
  "Port of deriveApprovedChecklist without panel VM worker probe."
  [{:keys [config source scratch]}]
  (fs/create-dirs scratch)
  (let [checklist-path (fs/file scratch "approved-checklist.json")]
    (when-not (fs/regular-file? checklist-path)
      (try
        (checklist/generate {:root source :out (str checklist-path)})
        (catch Exception e
          (throw (ex-info (str "checklist derivation failed: " (.getMessage e))
                          {:cause e})))))
    (require-hash checklist-path (get-in config ["source" "checklist_sha256"]))
    (let [selected (hjson/read-json (slurp checklist-path :encoding "UTF-8"))]
      (when (and (= (get config "schema") "harness.pi-live-run.v2")
                 (loyly/requires-blind-handoff
                  (or (get config "project") loyly/PROJECT_ID)
                  (get selected "items")))
        (throw (ex-info
                (str "selected " loyly/PROJECT_ID " refusal item " loyly/BLIND_ITEM_ID
                     " requires the v1 blind-review contract")
                {})))
      (verify-selected-specs source (get config "source") selected)
      selected)))

(defn verify-pinned-image
  "Public pin check for a builder/grader/panel image tree."
  [image expected-manifest-sha256]
  (verify-image image expected-manifest-sha256))
