(ns loyly.spike.project.loyly.blind-probe
  "PoC port of sync helpers from harness/pi-durable/project/loyly/blind-probe.ts.
  publicJsonBooking (HTTP) stays on the TS side for now."
  (:require [clojure.string :as str]))

(defn- attribute [tag name]
  (second (re-find (re-pattern (str "(?i)\\b" name "\\s*=\\s*[\"']([^\"']+)[\"']")) tag)))

(defn booking-form-action
  "Return the same-origin POST action path for the public booking form, or nil."
  [html]
  (let [forms
        (->> (re-seq #"(?is)<form\b([^>]*)>([\s\S]*?)</form>" html)
             (filter (fn [[_ tag body]]
                       (and (= "post" (some-> (attribute tag "method") str/lower-case))
                            (every? (fn [name]
                                      (re-find (re-pattern
                                                (str "(?i)<(?:input|select)\\b[^>]*\\bname\\s*=\\s*[\"']"
                                                     name "[\"']"))
                                               body))
                                    ["household" "resource" "weekday" "start"])))))]
    (when (> (count forms) 1)
      (throw (ex-info "expected at most one public booking form" {})))
    (when (seq forms)
      (let [path (attribute (second (first forms)) "action")]
        (when (or (not (re-matches #"/[A-Za-z0-9/?=&%._-]*" (str path)))
                  (str/starts-with? (str path) "//"))
          (throw (ex-info "booking form action must be a same-origin path" {})))
        path))))

(defn- form-encode
  "application/x-www-form-urlencoded without java.net.URLEncoder quirks for spaces."
  [params]
  (->> params
       (map (fn [[k v]]
              (str (java.net.URLEncoder/encode (str k) "UTF-8")
                   "="
                   (java.net.URLEncoder/encode (str v) "UTF-8"))))
       (str/join "&")
       (#(str/replace % "+" "%20"))))

(defn- parse-form-body [body]
  (->> (str/split body #"&")
       (remove str/blank?)
       (map (fn [pair]
              (let [[k v] (str/split pair #"=" 2)]
                [(java.net.URLDecoder/decode (or k "") "UTF-8")
                 (java.net.URLDecoder/decode (or v "") "UTF-8")])))
       (into {})))

(defn resolve-room-in-public-form
  "Replace @room:N resource token with the matching public form option value."
  [html body answer]
  (let [params (parse-form-body body)
        token (re-matches #"^@room:(\d+)$" (str (get params "resource")))]
    (if-not token
      body
      (do
        (when-not (re-find (re-pattern (str "(?i)^REQUEST:\\s*pukuhuone\\s+" (second token) "\\s*\\|"))
                           answer)
          (throw (ex-info "blind answer and requested room differ" {})))
        (let [select (re-find #"(?is)<select\b[^>]*\bname\s*=\s*[\"']resource[\"'][^>]*>([\s\S]*?)</select>"
                              html)]
          (when-not select
            (throw (ex-info "public booking form has no resource selection" {})))
          (let [options (re-seq #"(?is)<option\b[^>]*\bvalue\s*=\s*[\"']([^\"']+)[\"'][^>]*>([\s\S]*?)</option>"
                                (second select))
                matching (filter (fn [[_ _ label]]
                                   (= (str/lower-case
                                       (str/trim (str/replace label #"<[^>]+>" "")))
                                      (str "pukuhuone " (second token))))
                                 options)]
            (when-not (= 1 (count matching))
              (throw (ex-info "blind room is not a unique public form option" {})))
            (form-encode (assoc params "resource" (second (first matching))))))))))
