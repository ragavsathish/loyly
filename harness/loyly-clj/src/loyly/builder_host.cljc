(ns loyly.builder-host
  "Builder/grader Gondolin VM policy, prompt builder, bash timeout bounds,
   conversation/fork receipt validation, and steer inbox scanning (.cljc).

   Primary cross-platform core formerly in .pi/harness/builder-host/{policy,host}.ts."
  (:require [clojure.string :as str]
            [loyly.hjson :as hjson]
            [loyly.platform :as plat]))

(def GUEST_WORKSPACE "/workspace")

(def ALLOWED_HOSTS
  ["registry.npmjs.org"
   "repo1.maven.org"
   "repo.clojars.org"
   "github.com"
   "codeload.github.com"
   "objects.githubusercontent.com"
   "dl-cdn.alpinelinux.org"])

(def IMAGE_ADDITIONS
  (str GUEST_WORKSPACE "/.builder/image-additions.txt"))

(def GUEST_USER "root")

(def DEFAULT_PROMPT "Build it now, as the attached instruction says.")

(def DEFAULT_MODEL
  {:provider "openai-codex" :model-id "gpt-6.1-sol"})

(def BASH_TIMEOUT_FLOOR 1800)

(defn model-from-env
  "Parse LOYLY_PI_MODEL (provider/modelId) or return DEFAULT_MODEL."
  [value]
  (let [trimmed (some-> value str/trim)]
    (if (str/blank? trimmed)
      DEFAULT_MODEL
      (let [slash (str/index-of trimmed "/")]
        (when (or (nil? slash) (<= slash 0) (= slash (dec (count trimmed))))
          (throw (ex-info (str "LOYLY_PI_MODEL=" trimmed ": expected provider/modelId")
                          {:value trimmed})))
        {:provider (subs trimmed 0 slash)
         :model-id (subs trimmed (inc slash))}))))

(defn timeout-floor-from-env
  "Parse LOYLY_BASH_TIMEOUT_FLOOR_SECONDS (positive number) or return BASH_TIMEOUT_FLOOR."
  [value]
  (let [trimmed (some-> value str/trim)]
    (if (str/blank? trimmed)
      BASH_TIMEOUT_FLOOR
      (let [n (try (plat/parse-double-strict trimmed)
                   (catch #?(:clj Exception :cljs :default) _ nil))]
        (when (or (nil? n) (<= n 0))
          (throw (ex-info (str "LOYLY_BASH_TIMEOUT_FLOOR_SECONDS=" trimmed
                               ": expected a positive number of seconds")
                          {:value trimmed})))
        (if (== n (long n)) (long n) n)))))

(defn timeout-ceiling-from-env
  "Parse optional LOYLY_BASH_TIMEOUT_CEILING_SECONDS (integer >= floor)."
  [floor value]
  (let [trimmed (some-> value str/trim)]
    (when-not (str/blank? trimmed)
      (let [n (try (plat/parse-long-strict trimmed)
                   (catch #?(:clj Exception :cljs :default) _ nil))]
        (when (or (nil? n) (< n floor))
          (throw (ex-info (str "LOYLY_BASH_TIMEOUT_CEILING_SECONDS=" trimmed
                               ": expected integer >= floor " floor)
                          {:value trimmed :floor floor})))
        n))))

(defn clamp-bash-timeout
  "Compute bounded timeout for a bash tool call given floor, optional ceiling, and requested timeout.
   Returns nil when no rewrite is needed."
  [requested floor ceiling]
  (if (nil? ceiling)
    (when (and (number? requested) (< requested floor))
      floor)
    (min (max (if (number? requested) requested floor) floor) ceiling)))

(defn validate-image-additions-path
  "Ensure optional LOYLY_IMAGE_ADDITIONS_PATH stays inside /workspace without '..'."
  [value]
  (let [trimmed (some-> value str/trim)]
    (when-not (str/blank? trimmed)
      (when (or (not (str/starts-with? trimmed (str GUEST_WORKSPACE "/")))
                (some #(= ".." %) (str/split trimmed #"/")))
        (throw (ex-info "LOYLY_IMAGE_ADDITIONS_PATH must be inside /workspace"
                        {:value trimmed})))
      trimmed)))

(defn validate-vm-resources
  "Validate LOYLY_VM_MEMORY and LOYLY_VM_CPUS with Gondolin defaults (16G, 10)."
  [env-map]
  (let [mem (let [v (some-> (get env-map "LOYLY_VM_MEMORY") str/trim)]
              (if (str/blank? v) "16G" v))
        cpus (let [v (some-> (get env-map "LOYLY_VM_CPUS") str/trim)]
               (if (str/blank? v) "10" v))]
    (when-not (re-matches (plat/re-flags "i" "^[1-9]\\d*[KMGT]?$") mem)
      (throw (ex-info (str "vm-daemon: LOYLY_VM_MEMORY=" mem
                           ": expected a positive integer with an optional K/M/G/T suffix")
                      {:memory mem})))
    (when-not (re-matches #"^[1-9]\d*$" cpus)
      (throw (ex-info (str "vm-daemon: LOYLY_VM_CPUS=" cpus ": expected a positive integer")
                      {:cpus cpus})))
    {:memory mem :cpus (plat/parse-long-strict cpus)}))

(defn image-config
  "Read Gondolin's build config from <guest-dir>/manifest.json, or nil."
  [guest-dir]
  (when-not (str/blank? (str guest-dir))
    (let [manifest (plat/path guest-dir "manifest.json")]
      (when (plat/regular-file? manifest)
        (get (hjson/read-json (plat/read-text manifest)) "config")))))

(defn- format-minutes [seconds]
  (if (zero? (mod seconds 60))
    (str (quot seconds 60) " minutes")
    (str seconds " seconds")))

(defn environment-text
  "Build the environment system prompt section from VM policy, guest image config, and tool list."
  [{:keys [tools room-label timeout-floor image-additions-path timeout-ceiling
           readonly-inputs? guest-dir]
    :or {room-label "the builder room"
         timeout-floor BASH_TIMEOUT_FLOOR
         image-additions-path IMAGE_ADDITIONS}}]
  (let [cfg (image-config guest-dir)
        img-line (if-not cfg
                   "an isolated Linux VM"
                   (let [base (or (get-in cfg ["oci" "image"])
                                  (str/trim (str (or (get cfg "distro") "linux")
                                                 " "
                                                 (or (get-in cfg ["alpine" "version"]) ""))))]
                     (str "an isolated Linux VM (image " base ", " (get cfg "arch") ")")))
        install-cmd (when (= "alpine" (get cfg "distro")) "apk add")
        network (if (empty? ALLOWED_HOSTS)
                  "Network: none. Every outbound connection from the VM is refused; nothing can be downloaded, so work with what the image already has."
                  (str "Network: HTTPS and HTTP only to " (str/join ", " ALLOWED_HOSTS)
                       "; every other outbound connection is refused, and there is no SSH."))
        lines (cond-> [(str "You run as " GUEST_USER " (superuser) in " img-line ".")
                       network
                       (str "Your working directory is " GUEST_WORKSPACE ": " room-label
                            ", and the only host directory the VM can see.")
                       (if readonly-inputs?
                         "The plan and impl directories are mounted read-only; put every writable runtime copy and observation under /workspace/work."
                         "The room is read-write.")
                       "The image already carries the toolchain; use it first."]
                install-cmd
                (conj (str "If something you need is missing, install it with `" install-cmd
                           "` as " GUEST_USER ", and append the exact install command to "
                           image-additions-path " (outside the candidate scope) so the image's Dockerfile can be updated."))
                true
                (conj (str "Your tools, all running inside the VM: " (str/join ", " tools) "."))
                (some #{"bash"} tools)
                (conj (if (nil? timeout-ceiling)
                        (str "A bash command may run up to " (format-minutes timeout-floor)
                             ": whatever timeout you pass is raised to at least that.")
                        (str "Every bash command has a " (format-minutes timeout-ceiling)
                             " timeout, including commands without an explicit timeout."))))]
    (str/join "\n" lines)))

(defn read-conversation-receipt
  "Read and validate a builder conversation receipt JSON file."
  [path]
  (let [v (hjson/read-json (plat/read-text path))
        cid (get v "conversationId")
        lid (get v "lastEntryId")]
    (when (or (str/blank? (str (get v "store")))
              (not (integer? cid)) (< cid 1)
              (and (some? lid) (or (not (integer? lid)) (< lid 1))))
      (throw (ex-info (str "invalid Pi conversation receipt: " path) {:path path})))
    v))

(defn save-conversation-receipt!
  "Atomically write a conversation receipt JSON file."
  [path receipt-map]
  (let [tmp (str path ".tmp." (plat/now-ms) "." (plat/random-uuid-str))]
    (hjson/spit-utf8 tmp (str (hjson/compact-json receipt-map) "\n"))
    (plat/move tmp path)
    path))

(defn validate-existing-receipt!
  "Verify an existing conversation receipt matches store and optional parent receipt."
  [receipt-path store parent-receipt-path]
  (let [lineage (read-conversation-receipt receipt-path)]
    (when-not (= (get lineage "store") store)
      (throw (ex-info "Pi conversation receipt names another store" {:path receipt-path})))
    (if parent-receipt-path
      (let [parent (read-conversation-receipt parent-receipt-path)]
        (when (or (not= (get parent "store") store)
                  (not= (get lineage "parentConversationId") (get parent "conversationId"))
                  (not= (get lineage "forkEntryId") (get parent "lastEntryId")))
          (throw (ex-info "Pi fork receipt differs from prior completed session"
                          {:path receipt-path :parent parent-receipt-path}))))
      (when (some? (get lineage "parentConversationId"))
        (throw (ex-info "Pi fork receipt reopened without its parent" {:path receipt-path}))))
    lineage))

(defn validate-parent-receipt!
  "Verify a parent receipt is eligible to fork from in `store`."
  [parent-receipt-path store conversation-receipt-path]
  (when-not conversation-receipt-path
    (throw (ex-info "fork requires a conversation receipt path" {})))
  (let [parent (read-conversation-receipt parent-receipt-path)]
    (when (or (not= (get parent "store") store)
              (nil? (get parent "lastEntryId")))
      (throw (ex-info "prior Pi session has no completed fork point in this store"
                      {:parent parent-receipt-path})))
    parent))

(defn pending-steer-files
  "Return sorted pending steer inbox items in `dir` (<name>.md without .steered/.refused)."
  [dir]
  (if-not (plat/directory? dir)
    []
    (->> (plat/list-dir dir)
         (map plat/file-name)
         (filter #(str/ends-with? % ".md"))
         sort
         (keep (fn [file]
                 (let [n (subs file 0 (- (count file) 3))
                       base (plat/path dir n)]
                   (when (and (re-matches #"[A-Za-z0-9._-]+" n)
                              (not (plat/exists? (str base ".steered")))
                              (not (plat/exists? (str base ".refused"))))
                     {:name n
                      :base base
                      :request-id (str "steer-" n)
                      :content (plat/read-text (plat/path dir file))}))))
         vec)))

(defn parse-builder-host-config
  "Parse and validate CLI arguments + environment variables for builder-host."
  [argv env-map]
  (let [[room instruction store request-id pi-settings] argv]
    (when-not (and room instruction store request-id pi-settings)
      (throw (ex-info "usage: builder-host <builder-room> <instruction-file> <session.sqlite> <request-id> <pi-settings.json>" {})))
    (let [model (model-from-env (get env-map "LOYLY_PI_MODEL"))
          floor (timeout-floor-from-env (get env-map "LOYLY_BASH_TIMEOUT_FLOOR_SECONDS"))
          ceiling (timeout-ceiling-from-env floor (get env-map "LOYLY_BASH_TIMEOUT_CEILING_SECONDS"))
          img-additions (validate-image-additions-path (get env-map "LOYLY_IMAGE_ADDITIONS_PATH"))
          room-label (let [v (some-> (get env-map "LOYLY_ROOM_LABEL") str/trim)]
                       (when-not (str/blank? v) v))
          prompt (let [v (some-> (get env-map "LOYLY_PI_PROMPT") str/trim)]
                   (when-not (str/blank? v) v))
          steer-dir (let [v (some-> (get env-map "LOYLY_STEER_DIR") str/trim)]
                      (when-not (str/blank? v) v))]
      {:room room
       :instruction instruction
       :store store
       :request-id request-id
       :pi-settings pi-settings
       :model model
       :timeout-floor floor
       :timeout-ceiling ceiling
       :room-label (or room-label "the builder room")
       :image-additions-path (or img-additions IMAGE_ADDITIONS)
       :prompt (or prompt DEFAULT_PROMPT)
       :steer-dir steer-dir
       :guest-dir (get env-map "GONDOLIN_GUEST_DIR")
       :readonly-inputs? (= "1" (get env-map "LOYLY_ROOM_READONLY_INPUTS"))
       :conversation-receipt (get env-map "LOYLY_PI_CONVERSATION_RECEIPT")
       :parent-conversation-receipt (get env-map "LOYLY_PI_PARENT_RECEIPT")})))
