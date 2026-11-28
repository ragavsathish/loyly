(ns loyly.replay-export
  "Rebuild portable audit JSONL, Allure evidence projection, and HTML replay page
   from committed Pi entries (.cljc). Port of harness/pi-durable/export.mjs."
  (:require [clojure.string :as str]
            [loyly.audit-rows :as audit]
            [loyly.digest :as d]
            [loyly.hjson :as hjson]
            [loyly.platform :as plat]
            [loyly.replay-evidence :as replay]))

(def ^:private checkout-re #"/Users/[^/]+/Documents/git/[^\s\"']+")

(defn portable-value
  "Sanitize host-local scratch and checkout paths recursively for portable replay artifacts."
  [dir v]
  (cond
    (string? v) (-> v
                    (str/replace (str dir) "<scratch>")
                    (str/replace checkout-re "<checkout>"))
    (vector? v) (mapv #(portable-value dir %) v)
    (map? v) (into (array-map) (map (fn [[k val]] [k (portable-value dir val)]) v))
    :else v))

(defn export-run
  "Write audit.v1.jsonl and evidence.v1.json in `dir` from committed `raw-rows`
   (or read via audit/read-audit-rows) and return the portable run summary map."
  ([dir] (export-run dir (audit/read-audit-rows dir)))
  ([dir raw-rows]
   (let [abs-dir (plat/absolutize dir)
         rows (mapv #(portable-value abs-dir %) raw-rows)
         evidence (portable-value abs-dir (replay/project-replay-evidence abs-dir rows))
         jsonl (str (str/join "\n" (map hjson/compact-json rows)) "\n")
         evidence-json (str (hjson/write evidence) "\n")
         agent-facts (filter #(#{"build" "repair" "grade"} (get % "stage")) rows)
         provenance (cond
                      (some #(or (true? (get % "fixture")) (true? (get % "fixture_grader"))) agent-facts)
                      "fixture evidence"
                      (some #(get % "model") agent-facts)
                      "live path"
                      :else "pre-agent refusal")]
     (hjson/spit-utf8 (plat/path abs-dir "audit.v1.jsonl") jsonl)
     (hjson/spit-utf8 (plat/path abs-dir "evidence.v1.json") evidence-json)
     (array-map
      "name" (plat/file-name abs-dir)
      "rows" rows
      "evidence" evidence
      "provenance" provenance
      "sha256" (d/sha256-string jsonl)
      "evidenceSha256" (d/sha256-string evidence-json)))))

(def ^:private REPLAY-STYLES
  (str ":root{font:15px/1.45 'Instrument Sans',system-ui,sans-serif;color:#173129;background:#f5f2e9}\n"
       "*{box-sizing:border-box}body{max-width:1180px;margin:auto;padding:28px}h1{font-size:32px;margin:0 0 8px}\n"
       "button{font:inherit;cursor:pointer;border:1px solid #79978a;background:#fffdf6;border-radius:7px;padding:6px 10px}\n"
       "button[aria-selected=true]{background:#173129;color:white}header p{max-width:850px;color:#526c61}\n"
       ".tabs,.controls{display:flex;gap:8px;flex-wrap:wrap;margin:18px 0}.story{display:grid;grid-template-columns:repeat(auto-fit,minmax(145px,1fr));gap:8px;margin:18px 0}\n"
       ".stage{background:#fffdf6;border:1px solid #cfddcf;border-radius:8px;padding:12px;opacity:.35}.stage.active{opacity:1;border-color:#287352}\n"
       ".stage strong{display:block;text-transform:capitalize}.stage small{color:#567365}.lane{border-top:2px solid #a5b8aa;padding-top:10px;margin-top:18px}\n"
       ".stickies{display:flex;gap:7px;flex-wrap:wrap}.sticky{border:1px solid #a6b8ac;background:#eef4e9;border-radius:7px;padding:8px 10px;text-align:left;max-width:250px;opacity:.27}\n"
       ".sticky.active{opacity:1}.sticky.fail{background:#f9e2dd;border-color:#ba776b}.sticky small{display:block;color:#587163}\n"
       ".evidence{display:flex;gap:8px;flex-wrap:wrap;margin:10px 0 18px}.evidence button{max-width:280px;text-align:left;background:#f2f6fb;border-color:#9aafc2}\n"
       ".evidence button.failed{background:#f9e2dd;border-color:#ba776b}.evidence button.skipped{background:#f6eedb;border-color:#c8af77}\n"
       ".evidence small{display:block;color:#526c61}\n"
       ".grade-flow{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px;margin:14px 0}\n"
       ".grade-card{background:#fffdf6;border:1px solid #7fa99a;border-radius:8px;padding:12px}\n"
       ".grade-card h3{margin:0 0 4px;font-size:16px}.grade-card p{margin:3px 0 8px;color:#526c61}\n"
       ".grade-items{display:flex;flex-wrap:wrap;gap:5px}.grade-items button{font:12px ui-monospace,monospace;padding:4px 6px}\n"
       ".grade-items button.skipped{background:#f6eedb;border-color:#c8af77}.grade-join{border:1px solid #287352;border-radius:8px;background:#e5f2e9;padding:10px;margin:8px 0}\n"
       "#detail{background:#fffdf6;border:1px solid #cfddcf;border-radius:8px;padding:14px;white-space:pre-wrap;overflow:auto;min-height:110px}\n"
       ".meta{font:12px/1.4 ui-monospace,monospace;color:#546c61}input[type=range]{width:min(100%,600px)}"))

(def ^:private REPLAY-SCRIPT
  (str "const runs=JSON.parse(document.querySelector('#runs').textContent);let current=0,position=0,timer;\n"
       "const stages=['cut','self-check','fence','checklist','render','build','builder-continuation','gate','retry','repair','grading-room','grade','blind-review','panel','score','scoreboard','panel-report','cycle'];\n"
       "const tabs=document.querySelector('.tabs'),story=document.querySelector('.story'),stickies=document.querySelector('.stickies'),evidence=document.querySelector('.evidence'),scrub=document.querySelector('#scrub'),gradeFlow=document.querySelector('#grade-flow'),gradeJoin=document.querySelector('#grade-join');\n"
       "const esc=s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('\"','&quot;').replaceAll(\"'\",'&#39;');\n"
       "function draw(){const run=runs[current],rows=run.rows;tabs.innerHTML=runs.map((r,i)=>'<button data-run=\"'+i+'\" aria-selected=\"'+(i===current)+'\">'+esc(r.name)+' · '+esc(r.provenance)+'</button>').join('');\n"
       "scrub.max=String(rows.length);scrub.value=String(position);document.querySelector('#count').textContent=position+' / '+rows.length;\n"
       "story.innerHTML=stages.map(s=>{const matching=rows.filter((r,i)=>i<position&&r.stage===s),last=matching.at(-1);return '<div class=\"stage '+(last?'active':'')+'\"><strong>'+s+'</strong><small>'+(last?esc(last.outcome)+(last.attempt?' · attempt '+esc(last.attempt):''):'not reached')+'</small></div>'}).join('');\n"
       "stickies.innerHTML=rows.map((r,i)=>'<button class=\"sticky '+(i<position?'active ':'')+(r.outcome==='failed'?'fail':'')+'\" data-event=\"'+i+'\"><b>'+esc(r.stage)+' · '+esc(r.outcome)+'</b><small>#'+esc(r.seq)+' '+(r.attempt?'attempt '+esc(r.attempt):'')+'</small></button>').join('');\n"
       "const grade=rows.find((r,i)=>i<position&&r.stage==='grade'&&r.outcome==='completed'&&Array.isArray(r.shards));\n"
       "if(grade){const raw=run.evidence.filter(x=>x.kind==='grader-item'&&x.after_seq===grade.seq);gradeFlow.innerHTML=grade.shards.map(shard=>'<article class=\"grade-card\"><h3>'+esc(shard.id)+'</h3><p>'+esc(shard.items.length)+' items · private VM room</p><div class=\"grade-items\">'+shard.items.map(id=>{const result=raw.find(x=>x.item===id);return '<button class=\"'+esc(result?.status||'')+'\" data-grade-item=\"'+esc(id)+'\" title=\"'+esc(result?.status||'missing')+'\">'+esc(id)+' · '+esc(result?.status||'missing')+'</button>'}).join('')+'</div></article>').join('');const passed=raw.filter(x=>x.status==='passed').length,pending=raw.filter(x=>x.status==='skipped').length;gradeJoin.textContent='Joined at Pi grade #'+grade.seq+': '+grade.shards.length+' shards · '+raw.length+' unique items · '+passed+' passed · '+pending+' blind handoff · combined Allure SHA-256 '+grade.allure_results_sha256;}else{gradeFlow.innerHTML='';gradeJoin.textContent=rows.some((r,i)=>i<position&&r.stage==='grading-room')?'Grading room prepared. Advance to the committed grade receipt to see the shard scopes.':'Advance past the gate to see parallel grading.';}\n"
       "const visible=run.evidence.filter(e=>e.after_seq<=position);evidence.innerHTML=visible.map((e,i)=>'<button class=\"'+esc(e.status)+'\" data-evidence=\"'+i+'\"><b>'+esc(e.item)+' · '+esc(e.status)+'</b><small>'+esc(e.kind)+' · '+esc(e.name)+'</small></button>').join('');\n"
       "document.querySelector('#manifest').textContent='Pi audit SHA-256 '+run.sha256+' · '+rows.length+' facts · Allure projection SHA-256 '+run.evidenceSha256+' · '+run.evidence.length+' results · '+run.provenance;}\n"
       "tabs.onclick=e=>{const b=e.target.closest('[data-run]');if(!b)return;clearInterval(timer);current=Number(b.dataset.run);position=0;draw()};\n"
       "stickies.onclick=e=>{const b=e.target.closest('[data-event]');if(!b)return;const r=runs[current].rows[Number(b.dataset.event)];document.querySelector('#detail').textContent=JSON.stringify(r,null,2)};\n"
       "gradeFlow.onclick=e=>{const b=e.target.closest('[data-grade-item]');if(!b)return;const run=runs[current],grade=run.rows.find((r,i)=>i<position&&r.stage==='grade'&&r.outcome==='completed');const result=run.evidence.find(x=>x.kind==='grader-item'&&x.after_seq===grade.seq&&x.item===b.dataset.gradeItem);if(result)document.querySelector('#detail').textContent=JSON.stringify(result,null,2)};\n"
       "evidence.onclick=e=>{const b=e.target.closest('[data-evidence]');if(!b)return;const visible=runs[current].evidence.filter(e=>e.after_seq<=position);document.querySelector('#detail').textContent=JSON.stringify(visible[Number(b.dataset.evidence)],null,2)};\n"
       "scrub.oninput=()=>{position=Number(scrub.value);draw()};document.querySelector('#reset').onclick=()=>{clearInterval(timer);position=0;draw()};\n"
       "document.querySelector('#play').onclick=()=>{clearInterval(timer);timer=setInterval(()=>{position++;draw();if(position>=runs[current].rows.length)clearInterval(timer)},350)};draw();"))

(defn render-replay-html
  "Render the self-contained HTML replay viewer for exported run summaries."
  [runs]
  (let [safe (str/replace (hjson/compact-json runs) "<" "\\u003c")]
    (str "<!doctype html><html lang=\"en\"><meta charset=\"utf-8\">"
         "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
         "<title>Pi durable cycle audit prototype</title><style>\n" REPLAY-STYLES "\n</style>\n"
         "<header><h1>Pi durable cycle audit</h1><p>The original harness self-check, fence, checklist, gate, score and scoreboard run as recorded. Pi events come from committed entries. Grader, blind-review and panel results are separately labelled Allure evidence projections, checked against those committed digests; they are not invented Pi events or ORC ticks.</p></header>\n"
         "<nav class=\"tabs\" aria-label=\"Run examples\"></nav>"
         "<div class=\"controls\"><button id=\"play\">Play</button><button id=\"reset\">Reset</button><input id=\"scrub\" type=\"range\" min=\"0\" value=\"0\"><span id=\"count\"></span></div>\n"
         "<section class=\"story\" aria-label=\"Legacy cycle stages\"></section>"
         "<section class=\"lane\"><h2>Pi durable task and decision lane</h2><div class=\"stickies\"></div></section>"
         "<section class=\"lane\"><h2>Parallel grading</h2><p>One approved checklist is divided by rule. Each Terra grader gets a private candidate copy, checklist, VM and Allure directory. The collector checks complete, unique coverage and copies the result directories into one score view. The cards below are reconstructed from the committed grade receipt and bound Allure results; individual shard start and finish times were not committed. <a href=\"../#graders\">See what each tool and instrument measures</a>.</p><div class=\"grade-flow\" id=\"grade-flow\"></div><div class=\"grade-join\" id=\"grade-join\"></div></section>"
         "<section class=\"lane\"><h2>Bound Allure evidence</h2><p>Each item appears when its committed grade or blind-review event is reached.</p><div class=\"evidence\"></div></section>"
         "<h2>Selected evidence</h2><pre id=\"detail\">Select an event or item.</pre><p class=\"meta\" id=\"manifest\"></p>\n"
         "<script type=\"application/json\" id=\"runs\">" safe "</script><script>\n" REPLAY-SCRIPT "\n</script></html>")))

(defn export-replay!
  "Write replay HTML to `output-path` from exported `runs`."
  [runs output-path]
  (let [out (plat/absolutize output-path)]
    (hjson/spit-utf8 out (render-replay-html runs))
    {:output out :runs runs}))
