const id=process.argv[2], base='http://127.0.0.1:18080'; let house='soukanvuori', role='shareholder';
async function req(path, body){let r=await fetch(base+path,body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{});let j=await r.json(); console.log(JSON.stringify({request:path,body,response:j}));return j}
async function act(action, data={}, hh='12'){return req('/api/actions',{action,house,household:hh,role,...data})}
async function state(date){return req('/api/state?house='+house+(date?'&date='+date:''))}
async function book(resource,weekday,start,hh='12',date){return act('book',{resource,weekday,start,operatorRole:'manager',...(date?{date}:{})},hh)}
async function main(){
 await req('/api/houses'); await state();
 if(id.startsWith('01-')){
  if(id==='01-003'||id==='01-004'){await book('8','Tuesday','17:00'); if(id==='01-004')await book('8','Tuesday','17:00','3');await state();}
  else {let counts={one:0,both:0,neither:0};for(let i=0;i<(id==='01-010'?100:1);i++){let rs=await Promise.all([book('8','Tuesday','17:00','12'),book('8','Tuesday','17:00','3')]);let n=rs.filter(x=>x.ok).length;counts[n===1?'one':n===2?'both':'neither']++;let s=await state();if(i<99&&id==='01-010'){let h=s.holdings.find(x=>x.resource==='8'&&x.start==='17:00');if(!h){console.log('missing holding, cannot reset');break} await act('giveUp',{holding:h.id},h.household)}}console.log('COUNTS '+JSON.stringify(counts));}
 }else if(id.startsWith('02-')){let b=await book('8','Tuesday','17:00');let h=b.booking?.id;let o=await act('release',{holding:h,date:'2026-11-24',mode:'FREE'});let oid=o.offer?.id; if(id==='02-009'){await act('take',{offer:oid},'3');await act('take',{offer:oid},'4')}else await Promise.all([act('take',{offer:oid},'3'),act('take',{offer:oid},'4')]); await state('2026-11-24');await state('2026-12-01');await state();
 }else if(id.startsWith('03-')){house='self-service';role='tenant';await state();
  if(id==='03-001'){await book('9','Thursday','17:00');await book('9','Thursday','18:30');await act('joinQueue',{group:'9'},'3');await act('evaluateScarcity',{group:'9'});}
  if(id==='03-002'){await book('8','Tuesday','17:00');await book('8','Tuesday','18:30');await act('evaluateScarcity',{group:'8'});}
  if(id==='03-003'){let b=await book('8','Tuesday','17:00');await book('8','Tuesday','18:30');await act('joinQueue',{group:'8'},'3');await act('release',{holding:b.booking?.id,date:'2026-11-24',mode:'FREE'});await act('evaluateScarcity',{group:'8'});}
  if(id==='03-004'){await book('8','Tuesday','17:00');await book('8','Tuesday','18:30');await act('joinQueue',{group:'9'},'3');await act('evaluateScarcity',{group:'8'});}
  if(id==='03-005'){await book('8','Tuesday','17:00');await book('8','Tuesday','18:30');await act('joinQueue',{group:'8'},'3');await act('joinQueue',{group:'8'},'4');}
  if(id==='03-014'){for(let [d,t] of [['Thursday','17:00'],['Thursday','18:30'],['Friday','17:00'],['Friday','18:30'],['Saturday','17:00'],['Saturday','18:30']])await book('9',d,t, ['Thursday17:00','Thursday18:30','Friday17:00'].includes(d+t)?'12':'5');await act('joinQueue',{group:'9'},'3');await act('evaluateScarcity',{group:'9'});await act('evaluateScarcity',{group:'9'});}
  await state();
 }else {house='family-times';role='tenant';await state();
  if(id==='05-001'){await book('family','Saturday','17:00','12','2026-11-21');await book('family','Sunday','17:00','12','2026-11-22');}
  if(id==='05-002'){await book('general','Tuesday','17:00','12','2026-11-24');await book('family','Sunday','17:00','12','2026-11-22');}
  if(id==='05-003'){await book('family','Saturday','17:00','12','2026-11-21');await book('general','Tuesday','17:00','12','2026-11-24');}
  if(id==='05-004'){house='self-service';await state();let res=[{id:'fam',name:'Family',sauna:'A',group:'A',starts:['17:00','18:30'],duration:90,timeClass:'family',days:['Sunday']}];await act('createHouse',{id:'house-b',name:'House B',resources:res,policy:{version:'v1',authority:'board',bookerRoles:['tenant'],route:'self-service',bookingOperator:'manager',billingRole:'billing',disputeRole:'manager',classCaps:{}}});house='house-b';await state();await book('fam','Sunday','17:00','12','2026-11-22');await book('fam','Sunday','18:30','12','2026-11-22');}
  if(id==='05-005'){await book('family','Saturday','17:00','12','2026-11-21');console.log('BOUNDARY 2026-11-21T18:30:00Z');require('child_process').execSync('date -u -s 2026-11-21T19:00:00Z',{stdio:'inherit'});await state();await book('family','Sunday','17:00','12','2026-11-22');}await state();
 }
}main().catch(e=>{console.error(e);process.exitCode=1});
