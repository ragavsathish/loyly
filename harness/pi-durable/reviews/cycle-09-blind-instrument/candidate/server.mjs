import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.dirname(fileURLToPath(import.meta.url));
const file=process.env.LOyly_DATA||process.env.LOYLY_DATA||path.join(root,'data','record.json');
fs.mkdirSync(path.dirname(file),{recursive:true});
let db=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{seq:0,houses:[]};
const id=p=>`${p}-${++db.seq}`;
const days=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const fail=message=>{throw new Error(message)};
const copy=x=>JSON.parse(JSON.stringify(x));
const now=h=>h.clock||new Date().toISOString();
const iso=s=>{if(!s||!Number.isFinite(Date.parse(s)))fail('A valid date and instant are required');return new Date(s).toISOString();};
const dateOK=s=>typeof s==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(s)&&!isNaN(Date.parse(s))&&new Date(s+'T00:00:00Z').toISOString().slice(0,10)===s;
const weekday=d=>{if(!dateOK(d))fail('Use a real calendar date YYYY-MM-DD');return days[new Date(d+'T12:00:00Z').getUTCDay()];};
const minutes=s=>{if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(s))fail('Start must be a named time HH:MM');return Number(s.slice(0,2))*60+Number(s.slice(3));};
const end=(s,d)=>{const m=minutes(s)+d;return `${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`;};
const instant=(d,t)=>d+'T'+t+':00.000Z';
const plus=(t,d)=>new Date(Date.parse(t)+d*86400000).toISOString();
const defaults={route:'self-service',bookerRoles:['tenant'],operatorRole:'manager',billingRole:'billing',disputeRole:'manager',authority:'board',chooseDays:14,noticeDays:30,standingPriceRef:'house standing tariff',salePriceRef:'house resale tariff',occurrencePriceRef:'house occurrence tariff',classCaps:{}};
function validateResources(rs){
 if(!Array.isArray(rs)||!rs.length)fail('Configure at least one resource');
 const ids=new Set();for(const r of rs){r.id=String(r.id||'');if(!r.id||ids.has(r.id))fail('Resource ids must be unique and nonempty');ids.add(r.id);r.name=r.name||r.id;r.group=r.group||r.id;r.duration=Number(r.duration||90);if(!Number.isInteger(r.duration)||r.duration<1||r.duration>720)fail('Invalid slot duration');
 const ws=windows(r);const keys=new Set();for(const w of ws){if(!days.includes(w.weekday))fail('Weekday must be named');minutes(w.start);if(minutes(w.start)+r.duration>1440)fail('Windows must end on the same calendar day');const k=w.weekday+w.start;if(keys.has(k))fail('Duplicate window');keys.add(k);}
 for(let i=0;i<ws.length;i++)for(let j=0;j<i;j++)if(ws[i].weekday===ws[j].weekday&&Math.abs(minutes(ws[i].start)-minutes(ws[j].start))<r.duration)fail('Resource windows cannot overlap');
 }return rs;
}
function windows(r){return r.windows||((r.days||[]).flatMap(weekday=>(r.starts||[]).map(start=>({weekday,start,timeClass:r.timeClass||'ordinary'}))));}
function validatePolicy(p){if(!['manager','self-service'].includes(p.route))fail('Route must be manager or self-service');if(!Array.isArray(p.bookerRoles)||!p.bookerRoles.length||p.bookerRoles.some(r=>typeof r!=='string'||!r.trim())||typeof p.authority!=='string'||!p.authority.trim())fail('Booker roles must be an array of names and policy authority is required');for(const k of ['operatorRole','billingRole','disputeRole','standingPriceRef','salePriceRef','occurrencePriceRef'])if(typeof p[k]!=='string'||!p[k].trim())fail(`${k} must be a nonempty name or reference`);if(!Number.isFinite(p.chooseDays)||!Number.isFinite(p.noticeDays)||!(p.chooseDays>0&&p.noticeDays>p.chooseDays))fail('Notice clock must be longer than choose clock, both numeric day lengths');for(const cap of Object.values(p.classCaps||{}))if(!Number.isInteger(cap)||cap<1)fail('Class caps must be positive integers');return p;}
function createHouse(b){if(!b.id||db.houses.some(h=>h.id===b.id))fail('House id is required and must be unique');if(!/^[a-zA-Z0-9_-]+$/.test(b.id))fail('House id uses letters, digits, dash and underscore');const p=validatePolicy({...defaults,...b.policy,version:id('policy'),effectiveAt:iso(b.effectiveAt||'2000-01-01T00:00:00Z'),resources:validateResources(copy(b.resources)),authority:b.policy?.authority||'board'});const h={id:b.id,name:b.name||b.id,clock:b.now?iso(b.now):null,policies:[p],bookings:[],releases:[],queue:[],notices:[],events:[],disputes:[]};db.houses.push(h);return h;}
const policy=(h,t=now(h))=>h.policies.filter(p=>p.effectiveAt<=t).sort((a,b)=>(a.effectiveAt<b.effectiveAt?-1:a.effectiveAt>b.effectiveAt?1:0)||h.policies.indexOf(a)-h.policies.indexOf(b)).at(-1)||fail('No effective policy at this instant');
const active=(b,t)=>b.status==='confirmed'&&b.createdAt<=t&&(!b.endedAt||b.endedAt>t);
const same=(a,b)=>a.resource===b.resource&&a.weekday===b.weekday&&a.start===b.start;
function grid(h,p=policy(h)){return p.resources.flatMap(r=>windows(r).map(w=>({...w,timeClass:w.timeClass||'ordinary',resource:r.id,resourceName:r.name,sauna:r.sauna||'',group:r.group,duration:r.duration,end:end(w.start,r.duration)})));}
function live(h,t=now(h)){return h.bookings.filter(b=>active(b,t));}
function event(h,action,object,p=policy(h),extra={}){const e={id:id('event'),at:now(h),action,bookingId:object.bookingId||object.id,policyVersion:p.version,record:copy(object),...extra};h.events.push(e);return e;}
function refusal(h,reason,p=policy(h),extra={}){return {id:id('refusal'),status:'refused',reason,policyVersion:p.version,at:now(h),...extra};}
function eligible(p,b){return p.bookerRoles.includes(b.role||'');}
function capReason(h,p,b,w){
 const cap=p.classCaps?.[w.timeClass];if(!cap)return null;
 const bs=live(h).filter(x=>x.household===b.household&&x.timeClass===w.timeClass&&(x.kind==='standing'||instant(x.date,x.end)>now(h)));
 // Occurrence transfers also consume the taker's class allowance while active/upcoming.
 const transfers=h.releases.filter(o=>o.status==='taken'&&o.taker===b.household&&o.timeClass===w.timeClass&&instant(o.date,o.end)>now(h));
 if(bs.length+transfers.length>=cap)return {reason:`The ${w.timeClass} time-class cap is ${cap} active or upcoming booking(s) per household. Existing booking: ${bs[0]?.id||transfers[0]?.bookingId}.`,existingBookingId:bs[0]?.id||transfers[0]?.bookingId};return null;
}
function book(h,input){const p=policy(h),b={...input,household:String(input.household||''),resource:String(input.resource||''),kind:input.date?'occurrence':'standing'};
 if(!b.household)fail('Household is required');
 if(b.date)b.weekday=weekday(b.date);if(!days.includes(b.weekday))fail('A named weekday or date is required');minutes(b.start);
 const deny=(reason,extra={})=>{const r=refusal(h,reason,p,extra);event(h,'refused',r,p,{reason,...extra});return r;};
 if(!eligible(p,b))return deny(`Only the house's configured booker roles (${p.bookerRoles.join(', ')}) may book. Provided role: ${b.role||'none'}.`);
 const r=p.resources.find(r=>r.id===b.resource);if(!r)return deny('This resource does not belong to this house.');
 const g=grid(h,p),w=g.find(w=>same(w,b));
 if(!w){const open=[...new Set(windows(r).map(w=>w.weekday))];const free=g.filter(s=>!live(h).some(x=>x.kind==='standing'&&same(x,s)));const alt=free.find(s=>s.weekday===b.weekday)||free[0];const alternative=alt?{resource:alt.resource,weekday:alt.weekday,start:alt.start}:undefined;
 return deny(`${r.name} has no sauna day/window on ${b.weekday} at ${b.start}. Its opening days are ${open.join(', ')}.${alt?` You can request a standing slot in ${alt.resourceName} on ${alt.weekday} at ${alt.start} (${alt.end} end).`:''}`,alternative?{alternative}:{});}
 if(b.date&&instant(b.date,w.start)<=now(h))return deny('This occurrence has already begun. Choose an upcoming configured window.');
 // The conditional standing-slot cap has exactly one decision site (INV-3).
 if(b.kind==='standing'&&live(h).some(x=>x.kind==='standing'&&x.household===b.household)&&!g.some(s=>!live(h).some(x=>x.kind==='standing'&&same(s,x))))return deny('The weekly schedule has no free standing slot.');
 const cap=capReason(h,p,b,w);if(cap)return deny(cap.reason,{existingBookingId:cap.existingBookingId});
 const conflict=live(h).some(x=>same(x,b)&&(b.kind==='standing'||x.kind==='standing'||x.date===b.date)&&!(x.kind==='occurrence'&&instant(x.date,x.end)<=now(h)));
 if(conflict)return deny('The slot is held. The existing holding remains unchanged.');
 const saved={id:id('booking'),status:'confirmed',kind:b.kind,household:b.household,resource:b.resource,sauna:w.sauna,resourceName:w.resourceName,weekday:b.weekday,start:b.start,end:w.end,duration:w.duration,timeClass:w.timeClass,group:w.group,date:b.date||null,createdAt:now(h),endedAt:null,policyVersion:p.version,priceRef:b.kind==='standing'?p.standingPriceRef:p.occurrencePriceRef};h.bookings.push(saved);event(h,'confirmed',saved,p);return saved;
}
function queueEntries(h,group){return h.queue.filter(q=>q.status==='waiting'&&q.group===group).sort((a,b)=>a.sequence-b.sequence);}
function noticeView(h,n){const q=queueEntries(h,n.group).filter(q=>!n.declined.includes(q.household));return {...n,choiceHousehold:n.selectedBookingId?null:(now(h)<n.chooseDeadline?n.household:q[0]?.household||null),offeredTo:n.pendingSuccessor||q[0]?.household||null};}
function refresh(h){
 const t=now(h);for(const o of h.releases)if(o.status==='offered'&&instant(o.date,o.start)<=t){o.status='unclaimed';event(h,'offer-expired',o,h.policies.find(p=>p.version===o.policyVersion));}
 for(const n of h.notices){if(n.status!=='active'||n.noticeDeadline>t||!n.selectedBookingId)continue;const b=h.bookings.find(b=>b.id===n.selectedBookingId);if(b&&!b.endedAt){b.endedAt=n.noticeDeadline;event(h,'lapsed',b,h.policies.find(p=>p.version===n.policyVersion),{noticeId:n.id,effectiveAt:n.noticeDeadline});
 if(n.pendingSuccessor){const successor={...copy(b),id:id('booking'),household:n.pendingSuccessor,createdAt:n.noticeDeadline,endedAt:null,policyVersion:n.policyVersion};h.bookings.push(successor);event(h,'confirmed',successor,h.policies.find(p=>p.version===n.policyVersion),{noticeId:n.id,effectiveAt:n.noticeDeadline});const q=h.queue.find(q=>q.id===n.pendingQueueId);if(q)q.status='fulfilled';n.successorBookingId=successor.id;}}
 n.status='lapsed';}
}
function evaluate(h,group){const p=policy(h);if(p.route!=='self-service')return [];const g=grid(h).filter(w=>w.group===group),bs=live(h).filter(b=>b.kind==='standing'&&b.group===group);if(!g.length||!queueEntries(h,group).length||g.some(w=>!bs.some(b=>same(w,b))))return h.notices.filter(n=>n.group===group);
 for(const hh of new Set(bs.map(b=>b.household))){if(bs.filter(b=>b.household===hh).length<2||h.notices.some(n=>n.status==='active'&&n.household===hh))continue;const n={id:id('notice'),status:'active',household:hh,group,startedAt:now(h),chooseDeadline:plus(now(h),p.chooseDays),noticeDeadline:plus(now(h),p.noticeDays),policyVersion:p.version,eligibleBookingIds:bs.filter(b=>b.household===hh).map(b=>b.id),selectedBookingId:null,pendingSuccessor:null,declined:[]};h.notices.push(n);event(h,'notice-started',{id:n.id},p,{notice:copy(n)});}
 return h.notices.filter(n=>n.group===group).map(n=>noticeView(h,n));}
function derive(h,date){if(date)weekday(date);const t=date?instant(date,'23:59'):now(h);const rows=[];const billing=[];
 const bs=h.bookings.filter(b=>b.status==='confirmed'&&b.createdAt<=(date?instant(date,b.end):t)&&(!b.endedAt||b.endedAt>(date?instant(date,b.start):t))&&(date?(b.kind==='standing'?b.weekday===weekday(date):b.date===date):(b.kind==='standing'||instant(b.date,b.end)>t)));
 for(const b of bs){const o=date?h.releases.filter(o=>o.bookingId===b.id&&o.date===date&&o.status!=='withdrawn').at(-1):null;const status=o?.status||'held',household=o?(o.status==='taken'?o.taker:null):b.household;const occurrence=date?{date,resource:b.resource,start:b.start}:b.date?{date:b.date,resource:b.resource,start:b.start}:null;
 rows.push({bookingId:b.id,resource:b.resource,sauna:b.sauna,resourceName:b.resourceName,weekday:b.weekday,start:b.start,end:b.end,date:date||b.date,household,standingHolder:b.household,status,timeClass:b.timeClass,policyVersion:b.policyVersion});
 billing.push({payer:b.household,holdingId:b.id,occurrence:b.kind==='occurrence'?occurrence:null,kind:b.kind,policyVersion:b.policyVersion,priceRef:b.priceRef});
 if(o?.status==='taken'&&o.mode==='SALE')billing.push({payer:o.taker,holdingId:b.id,occurrence,kind:'resale',policyVersion:o.takePolicyVersion||o.policyVersion,priceRef:o.priceRef});}
 if(!date)for(const o of h.releases.filter(o=>o.status==='taken'&&o.mode==='SALE'))billing.push({payer:o.taker,holdingId:o.bookingId,occurrence:{date:o.date,resource:o.resource,start:o.start},kind:'resale',policyVersion:o.takePolicyVersion||o.policyVersion,priceRef:o.priceRef});
 return {postedList:rows,heaterSchedule:rows.filter(r=>r.household).map(r=>({...r,signal:'heat',note:'Derived schedule only; no equipment commands'})),billingSignals:billing};}
function revise(h,b){const p=policy(h);if(b.authority!==p.authority)fail(`Only the configured policy authority (${p.authority}) may revise this rule`);const effectiveAt=iso(b.effectiveAt);const changes=copy(b);delete changes.version;const next=validatePolicy({...copy(p),...changes,version:id('policy'),effectiveAt,resources:validateResources(copy(b.resources||p.resources))});h.policies.push(next);event(h,'policy-revised',{id:next.version},p,{authority:b.authority,effectiveAt,version:next.version});return next;}
function handle(h,method,parts,b,url){refresh(h);const [section,key,action]=parts,p=policy(h);if(section==='config'&&method==='GET')return {...h,policy:p,now:now(h)};
 if(section==='policies')return method==='GET'?h.policies:revise(h,b);
 if(section==='clock'){if(method==='GET')return {now:now(h),controlled:!!h.clock};const t=iso(b.now);if(t<now(h))fail('The house clock cannot go backwards');h.clock=t;refresh(h);return {now:now(h)};}
 if(section==='route')return {route:p.route,operatorRole:p.operatorRole,bookerRoles:p.bookerRoles,queueEnabled:p.route==='self-service',message:p.route==='manager'?`Request through the ${p.operatorRole}; no resident self-service queue.`:'Residents may request directly and join the eligible-group waiting queue.'};
 if(section==='schedule')return grid(h).map(w=>{const holder=live(h).find(b=>b.kind==='standing'&&same(w,b));return {...w,status:holder?'held':'free',household:holder?.household||null,bookingId:holder?.id||null};});
 if(section==='views')return derive(h,url.searchParams.get('date'));
 if(section==='bookings'){
 if(method==='GET'){if(key&&action==='history')return h.events.filter(e=>e.bookingId===key);if(key)return h.bookings.find(x=>x.id===key)||fail('Booking not found');return h.bookings;}
 if(!key)return book(h,b);const bk=h.bookings.find(x=>x.id===key)||fail('Booking not found');
 if(action==='give-up'){if(bk.household!==String(b.household)||!active(bk,now(h)))return refusal(h,'Only the current holder may give up this holding');bk.endedAt=now(h);event(h,'given-up',bk);return {...bk,status:'given-up'};}
 }
 if(section==='releases'){
 if(method==='GET')return h.releases;
 if(!key){const bk=h.bookings.find(x=>x.id===b.bookingId);if(!bk||bk.kind!=='standing'||!active(bk,now(h))||bk.household!==String(b.household))return refusal(h,'Only the current standing holder may release one occurrence');if(weekday(b.date)!==bk.weekday)return refusal(h,'The date is not an occurrence of this standing holding');if(instant(b.date,bk.start)<=now(h))return refusal(h,'This occurrence has already begun');if(!['FREE','SALE'].includes(b.mode))fail('Release mode must be FREE or SALE');if(h.releases.some(o=>o.bookingId===bk.id&&o.date===b.date&&o.status!=='withdrawn'))return refusal(h,'This occurrence already has an offer');const o={id:id('offer'),bookingId:bk.id,household:bk.household,date:b.date,resource:bk.resource,start:bk.start,end:bk.end,timeClass:bk.timeClass,mode:b.mode,status:'offered',createdAt:now(h),policyVersion:p.version,priceRef:p.salePriceRef};h.releases.push(o);event(h,'released',o,p,{occurrence:{date:o.date,resource:o.resource,start:o.start},mode:o.mode});return o;}
 const o=h.releases.find(o=>o.id===key)||fail('Offer not found');
 if(action==='take'){if(o.status!=='offered')return refusal(h,'The occurrence is no longer available');if(!eligible(p,b))return refusal(h,'The taker must have a configured booker role in this house');if(!b.household||String(b.household)===o.household)return refusal(h,'A different household must take the occurrence');const bk=h.bookings.find(x=>x.id===o.bookingId);if(!active(bk,now(h)))return refusal(h,'The standing holding has ended');const cap=capReason(h,p,{household:String(b.household)},{timeClass:o.timeClass});if(cap)return refusal(h,cap.reason,p,cap);o.status='taken';o.taker=String(b.household);o.takenAt=now(h);o.takePolicyVersion=p.version;o.priceRef=p.salePriceRef;event(h,'taken',o,p,{taker:o.taker,offerId:o.id});return o;}
 if(action==='withdraw'){if(o.household!==String(b.household)||o.status!=='offered')return refusal(h,'Only an untaken offer may be withdrawn by its original holder before it begins');o.status='withdrawn';event(h,'offer-withdrawn',o);return o;}
 }
 if(section==='queue'){
 if(method==='GET')return (url.searchParams.get('group')?queueEntries(h,url.searchParams.get('group')):h.queue.filter(q=>q.status==='waiting'));
 if(p.route!=='self-service')return refusal(h,`This house uses the ${p.operatorRole}; it has no resident self-service queue`);
 if(!key){if(!eligible(p,b))return refusal(h,'Only the configured booker role may enter the queue');if(!b.household||!p.resources.some(r=>r.group===b.group))fail('Specify a household and an eligible resource group');const existing=h.queue.find(q=>q.status==='waiting'&&q.group===b.group&&q.household===String(b.household));if(existing)return existing;const q={id:id('queue'),sequence:db.seq,group:b.group,household:String(b.household),role:b.role,status:'waiting',acceptedAt:now(h),policyVersion:p.version};h.queue.push(q);event(h,'queue-joined',{id:q.id},p,{queue:copy(q)});return q;}
 const q=h.queue.find(q=>q.id===key)||fail('Queue entry not found');if(action==='withdraw'){if(q.household!==String(b.household))return refusal(h,'Only the queued household may withdraw');q.status='withdrawn';for(const n of h.notices)if(n.pendingQueueId===q.id){n.pendingSuccessor=null;n.pendingQueueId=null;}event(h,'queue-withdrawn',{id:q.id},p,{household:q.household,group:q.group});return q;}
 }
 if(section==='notices'){
 if(method==='GET')return h.notices.map(n=>noticeView(h,n));if(key==='evaluate')return evaluate(h,b.group);
 const n=h.notices.find(n=>n.id===key)||fail('Notice not found');if(n.status!=='active')return refusal(h,'The notice has already lapsed');const v=noticeView(h,n);
 if(action==='choose'){if(String(b.household)!==v.choiceHousehold||n.selectedBookingId)return refusal(h,'This household does not currently have the right to choose');if(!n.eligibleBookingIds.includes(b.bookingId)||!live(h).some(x=>x.id===b.bookingId))return refusal(h,'Select one of the notified household’s eligible holdings');n.selectedBookingId=b.bookingId;event(h,'notice-choice',{id:n.selectedBookingId},p,{noticeId:n.id,chosenBy:String(b.household)});refresh(h);return noticeView(h,n);}
 if(['claim','decline'].includes(action)){if(!n.selectedBookingId||String(b.household)!==v.offeredTo)return refusal(h,'Only the current eligible queue-head may respond to the selected holding');const q=queueEntries(h,n.group).find(q=>q.household===String(b.household));if(action==='claim'){n.pendingSuccessor=q.household;n.pendingQueueId=q.id;}else{n.declined.push(q.household);q.status='declined';n.pendingSuccessor=null;n.pendingQueueId=null;}event(h,action==='claim'?'pending-claim':'claim-declined',{id:n.selectedBookingId},p,{noticeId:n.id,household:String(b.household)});return noticeView(h,n);}
 }
 if(section==='disputes'){
 if(method==='GET')return h.disputes;if(b.role!==p.disputeRole)return refusal(h,`Disputes are opened by the first-stop role: ${p.disputeRole}`);const history=h.events.filter(e=>e.bookingId===b.bookingId);if(!history.length)fail('Booking decision not found');const d={id:id('dispute'),bookingId:b.bookingId,role:b.role,reason:b.reason||'',openedAt:now(h),history:copy(history)};h.disputes.push(d);return d;
 }
 if(section==='history')return h.events;
 fail('Unknown route');}
function save(){const temp=file+'.tmp';fs.writeFileSync(temp,JSON.stringify(db,null,2));fs.renameSync(temp,file);}
if(!db.houses.length){
 const rs=[{id:'8',name:'pukuhuone 8',sauna:'F',group:'ph8',days:['Tuesday'],starts:['17:00','18:30'],duration:90},{id:'9',name:'pukuhuone 9',sauna:'F',group:'ph9',days:['Thursday','Friday','Saturday'],starts:['17:00','18:30'],duration:90}];
 createHouse({id:'soukanvuori',name:'As Oy Soukanvuori · sauna F',resources:rs,policy:{route:'manager',bookerRoles:['shareholder'],operatorRole:'manager',billingRole:'vastikekirjanpitäjä',disputeRole:'manager'}});
 createHouse({id:'demo',name:'Self-service example house',resources:rs,policy:{route:'self-service'}});
 createHouse({id:'masthugget',name:'Masthugget · family-time example',resources:[{id:'family-sauna',name:'Family sauna',sauna:'bastu',group:'family',duration:90,windows:['Saturday','Sunday'].flatMap(weekday=>['17:00','18:30'].map(start=>({weekday,start,timeClass:'family'})))}],policy:{classCaps:{family:1}}});save();
}
const server=http.createServer(async(req,res)=>{
 try{
 const u=new URL(req.url,'http://localhost');
 if(u.pathname.startsWith('/api/')){let b={};if(req.method==='POST'){let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>1000000)fail('Request too large');}try{b=JSON.parse(raw||'{}');}catch{fail('Invalid JSON');}}
 const before=JSON.stringify(db);let result;
 try{const a=u.pathname.split('/').filter(Boolean);if(a[1]==='houses'&&a.length===2)result=req.method==='POST'?createHouse(b):db.houses.map(h=>({id:h.id,name:h.name,now:now(h),policy:policy(h)}));else if(a[1]==='houses'){const h=db.houses.find(h=>h.id===a[2])||fail('House not found');result=handle(h,req.method,a.slice(3),b,u);}else fail('Unknown route');if(result===undefined)fail('Unknown route');if(JSON.stringify(db)!==before)save();}catch(e){db=JSON.parse(before);throw e;}
 res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(result));return;
 }
 const names={'/':'index.html','/app.js':'app.js','/style.css':'style.css','/api-docs':'api.html'};const name=names[u.pathname];if(!name){res.writeHead(404);res.end('Not found');return;}const content=fs.readFileSync(path.join(root,'public',name));res.writeHead(200,{'Content-Type':name.endsWith('js')?'text/javascript; charset=utf-8':name.endsWith('css')?'text/css; charset=utf-8':'text/html; charset=utf-8','Cache-Control':'no-cache','X-Content-Type-Options':'nosniff'});res.end(content);
 }catch(e){res.writeHead(400,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify({status:'error',reason:e.message}));}
});
server.listen(Number(process.argv[2]||8901),'0.0.0.0',()=>console.log(`Löyly sauna server listening on ${server.address().port}`));
