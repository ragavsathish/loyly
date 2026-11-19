// THROWAWAY PROTOTYPE: rebuild an audit page from stored Pi entries, never a live watch.
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { Harness, createRegistry, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

const ctx = BACKGROUND_CONTEXT;
const dirs = process.argv.slice(2).map((p) => resolve(p));
if (dirs.length === 0) dirs.push(resolve("scratch"));

async function readAudit(dir) {
  const harness = await Harness.open(await openNodeSqliteStorage(join(dir, "cycle.PROTOTYPE.sqlite")),
    { models: createModels(), registry: createRegistry(), readOnly: true }, ctx);
  try {
    const conversation = await harness.conversation(ROOT_CONVERSATION_ID, ctx);
    if (!conversation) throw new Error(`no root conversation in ${dir}`);
    const entries = [];
    let cursor;
    do {
      const page = await conversation.entries({ order: "ascending" }, 100, cursor, ctx);
      entries.push(...page.items.filter((e) => e.kind === "loyly.proto.audit.v1"));
      cursor = page.next;
    } while (cursor);
    // The stored ledger keeps local paths for reconciliation; exported replay
    // artifacts use stable relative names and never publish the host username.
    const portable = (value) => {
      if (typeof value === "string") return value.replaceAll(dir, "<scratch>")
        .replaceAll(/\/Users\/[^/]+\/Documents\/git\/[^\s"']+/g, "<checkout>");
      if (Array.isArray(value)) return value.map(portable);
      if (value && typeof value === "object") return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [k, portable(v)]));
      return value;
    };
    const rows = entries.map((e, i) => portable({ seq: i + 1, entry_id: String(e.id), ...e.data }));
    const jsonl = rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
    writeFileSync(join(dir, "audit.v1.jsonl"), jsonl);
    const agentFacts = rows.filter((r) => r.stage === "build" || r.stage === "repair" || r.stage === "grade");
    const provenance = agentFacts.some((r) => r.fixture === true || r.fixture_grader === true)
      ? "fixture evidence" : agentFacts.some((r) => r.model) ? "live path" : "pre-agent refusal";
    return { name: dir.split("/").at(-1), rows, provenance,
      sha256: createHash("sha256").update(jsonl).digest("hex") };
  } finally { await harness.close(ctx); }
}
const runs = await Promise.all(dirs.map(readAudit));
const styles = `
:root{font:15px/1.45 'Instrument Sans',system-ui,sans-serif;color:#173129;background:#f5f2e9}
*{box-sizing:border-box}body{max-width:1180px;margin:auto;padding:28px}h1{font-size:32px;margin:0 0 8px}
button{font:inherit;cursor:pointer;border:1px solid #79978a;background:#fffdf6;border-radius:7px;padding:6px 10px}
button[aria-selected=true]{background:#173129;color:white}header p{max-width:850px;color:#526c61}
.tabs,.controls{display:flex;gap:8px;flex-wrap:wrap;margin:18px 0}.story{display:grid;grid-template-columns:repeat(auto-fit,minmax(145px,1fr));gap:8px;margin:18px 0}
.stage{background:#fffdf6;border:1px solid #cfddcf;border-radius:8px;padding:12px;opacity:.35}.stage.active{opacity:1;border-color:#287352}
.stage strong{display:block;text-transform:capitalize}.stage small{color:#567365}.lane{border-top:2px solid #a5b8aa;padding-top:10px;margin-top:18px}
.stickies{display:flex;gap:7px;flex-wrap:wrap}.sticky{border:1px solid #a6b8ac;background:#eef4e9;border-radius:7px;padding:8px 10px;text-align:left;max-width:250px;opacity:.27}
.sticky.active{opacity:1}.sticky.fail{background:#f9e2dd;border-color:#ba776b}.sticky small{display:block;color:#587163}
#detail{background:#fffdf6;border:1px solid #cfddcf;border-radius:8px;padding:14px;white-space:pre-wrap;overflow:auto;min-height:110px}
.meta{font:12px/1.4 ui-monospace,monospace;color:#546c61}input[type=range]{width:min(100%,600px)}
`;
const safe = JSON.stringify(runs).replaceAll("<", "\\u003c");
const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pi durable cycle audit prototype</title><style>${styles}</style>
<header><h1>Legacy cycle audit · throwaway prototype</h1><p>The original harness self-check, fence, checklist, gate, score and scoreboard run as recorded. Each run names fixture evidence. Every visible Pi fact was read back from committed entries; these are Pi tasks, not ORC ticks.</p></header>
<nav class="tabs" aria-label="Run examples"></nav><div class="controls"><button id="play">Play</button><button id="reset">Reset</button><input id="scrub" type="range" min="0" value="0"><span id="count"></span></div>
<section class="story" aria-label="Legacy cycle stages"></section><section class="lane"><h2>Pi durable task and decision lane</h2><div class="stickies"></div></section><h2>Selected evidence</h2><pre id="detail">Select an event.</pre><p class="meta" id="manifest"></p>
<script type="application/json" id="runs">${safe}</script><script>
const runs=JSON.parse(document.querySelector('#runs').textContent);let current=0,position=0,timer;
const stages=['cut','self-check','fence','checklist','render','build','builder-continuation','gate','retry','repair','grading-room','grade','score','scoreboard','cycle'];
const tabs=document.querySelector('.tabs'),story=document.querySelector('.story'),stickies=document.querySelector('.stickies'),scrub=document.querySelector('#scrub');
function draw(){const run=runs[current],rows=run.rows;tabs.innerHTML=runs.map((r,i)=>'<button data-run="'+i+'" aria-selected="'+(i===current)+'">'+r.name+' · '+r.provenance+'</button>').join('');
scrub.max=String(rows.length);scrub.value=String(position);document.querySelector('#count').textContent=position+' / '+rows.length;
story.innerHTML=stages.map(s=>{const matching=rows.filter((r,i)=>i<position&&r.stage===s),last=matching.at(-1);return '<div class="stage '+(last?'active':'')+'"><strong>'+s+'</strong><small>'+(last?last.outcome+(last.attempt?' · attempt '+last.attempt:''):'not reached')+'</small></div>'}).join('');
stickies.innerHTML=rows.map((r,i)=>'<button class="sticky '+(i<position?'active ':'')+(r.outcome==='failed'?'fail':'')+'" data-event="'+i+'"><b>'+r.stage+' · '+r.outcome+'</b><small>#'+r.seq+' '+(r.attempt?'attempt '+r.attempt:'')+'</small></button>').join('');
document.querySelector('#manifest').textContent='Pi committed audit entry export SHA-256 '+run.sha256+' · '+rows.length+' facts · '+run.provenance;}
tabs.onclick=e=>{const b=e.target.closest('[data-run]');if(!b)return;clearInterval(timer);current=Number(b.dataset.run);position=0;draw()};
stickies.onclick=e=>{const b=e.target.closest('[data-event]');if(!b)return;const r=runs[current].rows[Number(b.dataset.event)];document.querySelector('#detail').textContent=JSON.stringify(r,null,2)};
scrub.oninput=()=>{position=Number(scrub.value);draw()};document.querySelector('#reset').onclick=()=>{clearInterval(timer);position=0;draw()};
document.querySelector('#play').onclick=()=>{clearInterval(timer);timer=setInterval(()=>{position++;draw();if(position>=runs[current].rows.length)clearInterval(timer)},350)};draw();
</script></html>`;
const output = resolve("replay.PROTOTYPE.html");
writeFileSync(output, html);
console.log(`wrote ${output}`);
for (const run of runs) console.log(`${run.name}: ${run.rows.length} committed facts sha256:${run.sha256}`);
