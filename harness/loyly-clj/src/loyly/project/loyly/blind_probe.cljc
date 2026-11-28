(ns loyly.project.loyly.blind-probe
  "Port of harness/pi-durable/project/loyly/blind-probe.ts (.cljc)."
  (:require [clojure.string :as str]
            [loyly.platform :as plat]))

(def ^:private FORM-RE (plat/re-flags "is" "<form\\b([^>]*)>([\\s\\S]*?)</form>"))
(def ^:private SELECT-RE (plat/re-flags "is" "<select\\b[^>]*\\bname\\s*=\\s*[\"']resource[\"'][^>]*>([\\s\\S]*?)</select>"))
(def ^:private OPTION-RE (plat/re-flags "is" "<option\\b[^>]*\\bvalue\\s*=\\s*[\"']([^\"']+)[\"'][^>]*>([\\s\\S]*?)</option>"))

(defn- attribute [tag name]
  (second (re-find (plat/re-flags "i" (str "\\b" name "\\s*=\\s*[\"']([^\"']+)[\"']")) tag)))

(defn booking-form-action
  "Return the same-origin POST action path for the public booking form, or nil."
  [html]
  (let [forms
        (filter
         (fn [[_ tag body]]
           (and (= "post" (some-> (attribute tag "method") str/lower-case))
                (every? (fn [name]
                          (re-find
                           (plat/re-flags
                            "i"
                            (str "<(?:input|select)\\b[^>]*\\bname\\s*=\\s*[\"']"
                                 name "[\"']"))
                           body))
                        ["household" "resource" "weekday" "start"])))
         (re-seq FORM-RE html))]
    (when (> (count forms) 1)
      (throw (ex-info "expected at most one public booking form" {})))
    (when (seq forms)
      (let [path (attribute (second (first forms)) "action")]
        (when (or (not (re-matches #"/[A-Za-z0-9/?=&%._-]*" (str path)))
                  (str/starts-with? (str path) "//"))
          (throw (ex-info "booking form action must be a same-origin path" {})))
        path))))

(defn- form-encode [params]
  (->> params
       (map (fn [[k v]]
              (str (plat/url-encode (str k))
                   "="
                   (plat/url-encode (str v)))))
       (str/join "&")
       (#(str/replace % "+" "%20"))))

(defn- parse-form-body [body]
  (->> (str/split body #"&")
       (remove str/blank?)
       (map (fn [pair]
              (let [[k v] (str/split pair #"=" 2)]
                [(plat/url-decode (or k ""))
                 (plat/url-decode (or v ""))])))
       (into {})))

(defn resolve-room-in-public-form
  "Replace @room:N resource token with the matching public form option value."
  [html body answer]
  (let [params (parse-form-body body)
        token (re-matches #"^@room:(\d+)$" (str (get params "resource")))]
    (if-not token
      body
      (do
        (when-not (re-find (plat/re-flags "i" (str "^REQUEST:\\s*pukuhuone\\s+" (second token) "\\s*\\|"))
                           answer)
          (throw (ex-info "blind answer and requested room differ" {})))
        (let [select (re-find SELECT-RE html)]
          (when-not select
            (throw (ex-info "public booking form has no resource selection" {})))
          (let [options (re-seq OPTION-RE (second select))
                matching (filter (fn [[_ _ label]]
                                   (= (str/lower-case
                                       (str/trim (str/replace label #"<[^>]+>" "")))
                                      (str "pukuhuone " (second token))))
                                 options)]
            (when-not (= 1 (count matching))
              (throw (ex-info "blind room is not a unique public form option" {})))
            (form-encode (assoc params "resource" (second (first matching))))))))))

(defn- assert-room-answer [params answer]
  (let [resource (get params "resource")
        room (some-> (when (string? resource) (re-matches #"^@room:(\d+)$" resource))
                     second)]
    (when (or (nil? room)
              (not (re-find (plat/re-flags "i" (str "^REQUEST:\\s*pukuhuone\\s+" room "\\s*\\|"))
                            answer)))
      (throw (ex-info "blind answer and requested room differ" {})))
    room))

(defn- named-resource [resources room]
  (filterv #(= (str/trim (str/lower-case (or (get % "name") ""))) (str "pukuhuone " room))
           resources))

(defn- booking-payload-from-match [{:keys [house resource role path modern-roles params]}]
  (let [payload (cond-> {"house" house
                         "household" (get params "household")
                         "resource" resource
                         "weekday" (get params "weekday")
                         "start" (get params "start")
                         "kind" "standing"}
                  modern-roles (assoc "bookerRole" role "actorRole" role)
                  (not modern-roles) (assoc "role" role))]
    (when-not (every? #(and (string? %) (not (str/blank? %))) (vals payload))
      (throw (ex-info "public booking request is incomplete" {})))
    {:path path :body (plat/compact-json payload) :content-type "application/json"}))

(defn match-public-json-booking
  "Pure match of house listing data to a JSON booking request (no HTTP)."
  [house-listing body answer]
  (let [params (parse-form-body body)
        room (assert-room-answer params answer)
        houses (cond
                 (vector? house-listing) house-listing
                 (and (map? house-listing) (vector? (get house-listing "houses")))
                 (get house-listing "houses")
                 :else (throw (ex-info "public house API has no houses" {})))
        house-scoped? (vector? house-listing)
        matches
        (vec
         (keep
          (fn [house]
            (let [id (get house "id")]
              (when (and (string? id) (re-matches #"[A-Za-z0-9_-]+" id))
                (let [policy (get house "policy")
                      resources (get policy "resources")
                      route (or (get policy "route") (get policy "bookingMode"))
                      modern? (string? (get policy "bookingMode"))
                      path (if (or house-scoped? modern?)
                             (str "/api/houses/" id "/bookings")
                             "/api/bookings")
                      named (named-resource resources room)]
                  (when (and (= route "self-service") (= 1 (count named)))
                    {:house id
                     :resource (get (first named) "id")
                     :role (or (first (get policy "eligibleRoles"))
                               (first (get policy "bookerRoles")))
                     :path path
                     :modern-roles modern?
                     :params params})))))
          houses))]
    (when-not (= 1 (count matches))
      (throw (ex-info "blind room is not unique in the public self-service API" {})))
    (booking-payload-from-match (first matches))))

(defn public-json-booking
  "Resolve booking via GET `:fetch-fn` taking `{:method :url :timeout-ms}`."
  [base body answer & {:keys [fetch-fn]}]
  (when-not fetch-fn
    (throw (ex-info "public-json-booking needs :fetch-fn" {})))
  (let [res (fetch-fn {:method "GET" :url (str base "/api/houses") :timeout-ms 1000})]
    (when-not (:ok res)
      (throw (ex-info "no public booking form or house API" res)))
    (let [listing (plat/parse-json-native (:body res))]
      (try
        (match-public-json-booking listing body answer)
        (catch #?(:clj Exception :cljs :default) _
          (let [params (parse-form-body body)
                room (assert-room-answer params answer)
                houses (if (vector? listing) listing (get listing "houses"))
                matches (atom [])]
            (doseq [house houses]
              (let [id (get house "id")]
                (when (and (string? id) (re-matches #"[A-Za-z0-9_-]+" id))
                  (let [state (fetch-fn {:method "GET"
                                         :url (str base "/api/houses/" id "/state")
                                         :timeout-ms 1000})]
                    (when (:ok state)
                      (let [parsed (plat/parse-json-native (:body state))
                            resources (get parsed "resources")
                            route (get-in parsed ["route" "kind"])
                            policy (get parsed "policy")
                            named (named-resource resources room)]
                        (when (and (= route "self-service") (= 1 (count named)))
                          (swap! matches conj
                                 {:house id
                                  :resource (get (first named) "id")
                                  :role (or (first (get policy "eligibleRoles"))
                                            (first (get policy "bookerRoles")))
                                  :path (str "/api/houses/" id "/bookings")
                                  :modern-roles (string? (get policy "bookingMode"))
                                  :params params})))))))
            (when-not (= 1 (count @matches))
              (throw (ex-info "blind room is not unique in the public self-service API" {})))
            (booking-payload-from-match (first @matches)))))))))