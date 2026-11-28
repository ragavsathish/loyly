(ns loyly.node.runtime
  "Node async runtime primitives for ClojureScript wrappers (.cljs).

  Provides Promise-based child process execution, native Node fetch with
  timeouts, dynamic ESM module loading, and repo root resolution."
  (:require ["node:child_process" :as cp]
            ["node:process" :as node-proc]
            ["node:url" :as node-url]
            [loyly.platform :as plat]
            [promesa.core :as p]))

(defn die!
  "Write error message to stderr and exit with code 2."
  [msg]
  (plat/err (str msg "\n"))
  (plat/exit! 2))

(defn resolve-repo
  "Find the Löyly repository root containing harness/pi-durable."
  [root]
  (let [base (plat/absolutize (or root "."))]
    (cond
      (plat/directory? (plat/path base "harness" "pi-durable")) base
      (plat/directory? (plat/path base ".." ".." "harness" "pi-durable"))
      (plat/absolutize (plat/path base ".." ".."))
      :else (die! (str "not a Löyly repo root (missing harness/pi-durable): " base)))))

(defn script-path
  "Resolve and verify a repo-relative Node script."
  [repo rel]
  (let [target (plat/path repo rel)]
    (when-not (plat/regular-file? target)
      (die! (str "driver script missing: " rel)))
    target))

(defn- env->js [env-map]
  (let [obj #js {}]
    (doseq [[k v] env-map]
      (when (some? v)
        (aset obj (str k) (str v))))
    obj))

(defn spawn-async
  "Spawn a subprocess asynchronously. Returns a Promise resolving to:
   - {:exit code :out str :err str} when :stdio is :pipe (default)
   - {:exit code} when :stdio is :inherit."
  ([cmd-vec] (spawn-async cmd-vec {}))
  ([cmd-vec {:keys [cwd env stdio]
             :or {stdio :pipe}}]
   (p/create
    (fn [resolve reject]
      (let [[bin & args] (vec cmd-vec)
            opts (cond-> #js {:stdio (if (= stdio :inherit) "inherit" "pipe")}
                   cwd (doto (aset "cwd" (str cwd)))
                   env (doto (aset "env" (env->js env))))
            child (.spawn cp bin (clj->js args) opts)
            out-chunks #js []
            err-chunks #js []]
        (when (not= stdio :inherit)
          (when-let [s (.-stdout child)]
            (.on s "data" (fn [chunk] (.push out-chunks (.toString chunk "utf8")))))
          (when-let [s (.-stderr child)]
            (.on s "data" (fn [chunk] (.push err-chunks (.toString chunk "utf8"))))))
        (.on child "error" reject)
        (.on child "close"
             (fn [code]
               (let [exit (if (nil? code) 1 code)]
                 (if (= stdio :inherit)
                   (resolve {:exit exit})
                   (resolve {:exit exit
                             :out (.join out-chunks "")
                             :err (.join err-chunks "")}))))))))))

(defn spawn-node-inherit
  "Spawn Node with inherited stdio. Returns a Promise resolving to the exit code."
  [{:keys [node cwd args env]
    :or {node (.-execPath node-proc)}}]
  (p/let [res (spawn-async (into [node] args)
                           {:cwd cwd
                            :env (or env (plat/getenv))
                            :stdio :inherit})]
    (:exit res)))

(defn fetch-json
  "Async HTTP request using Node 22 native fetch with AbortController timeout."
  [{:keys [method url headers body timeout-ms]
    :or {method "GET" timeout-ms 5000}}]
  (let [controller (js/AbortController.)
        timer (js/setTimeout #(.abort controller) timeout-ms)
        init (cond-> #js {:method method
                          :signal (.-signal controller)}
               headers (doto (aset "headers" (clj->js headers)))
               body (doto (aset "body" body)))]
    (-> (p/let [resp (js/fetch url init)
                text (.text resp)]
          {:ok (.-ok resp)
           :status (.-status resp)
           :body text})
        (p/finally (fn [_ _] (js/clearTimeout timer))))))

(defn import-esm
  "Dynamically import a local ESM module (.mjs / .js) by filesystem path."
  [abs-path]
  (js/import (.-href (.pathToFileURL node-url (plat/absolutize abs-path)))))
