const id=process.argv[2], base='http://127.0.0.1:8123';
async function req(path,data){let r=await fetch(base+path,{method:data?'POST':'GET',headers:{'Content-Type':'application/json'},body:data?JSON.stringify(data):undefined}); let t=await r.text();console.log(JSON.stringify({path,data,status:r.status,response:t}));try{return JSON.parse(t)}catch{return {}}}
const book=(house='soukanvuori',household='12',role='shareholder',resource='8',day='Tuesday',start='17:00')=>req('/api/bookings',{house,household,role,resource,day,start});
const views=(date='2026-11-24')=>req('/api/views?house=soukanvuori&date='+date);
(async()=>{
await req('/api/state');
if(id==='01-001'){await req('/api/schedule?house=soukanvuori');return}
if(id==='01-002'){await book('soukanvuori','12','shareholder','9');return}
if(id.startsWith('01-')){await book();await views();if(id==='01-008'){await req('/api/bookings/b1/give-up',{household:'12'});await views()}return}
if(id.startsWith('02-')){await book();await req('/api/releases',{bookingId:'b1',date:'2026-11-24',mode:id==='02-005'?'SALE':'FREE',household:'12'});await views();if(id==='02-006'){await req('/api/releases/r2/withdraw',{household:'12'});await req('/api/releases/r2/take',{household:'3'})}else if(id==='02-008'){console.log('CLOCK_BOUNDARY 2026-11-24T17:00:00Z');}else{await req('/api/releases/r2/take',{household:'3'});if(id==='02-007')await req('/api/releases/r2/withdraw',{household:'12'})}await views();await views('2026-12-01');await req('/api/state');return}
const B={id:'house-b',name:'House B',route:'self-service',bookerRoles:['tenant'],bookingOperator:'caretaker',operationsRole:'caretaker',billingRole:'billing clerk',disputeRole:'caretaker',authorityRole:'board',resources:[{id:'family',name:'Family',days:['Saturday'],starts:['17:00'],group:'family',timeClass:'family'}]};
if(['04-001','04-002','04-003'].includes(id)){await req('/api/houses',B);await req('/api/houses');await req('/api/schedule?house=soukanvuori');await req('/api/schedule?house=house-b');if(id==='04-002'){await book();await book('house-b','3','tenant','family','Saturday');await book('soukanvuori','4','tenant','8','Tuesday','18:30');await book('house-b','4','shareholder','family','Saturday')}return}
if(id==='04-005'){await book();await req('/api/bookings/b1/give-up',{household:'12'});await req('/api/disputes',{bookingId:'b1',actor:'manager',reason:'Review'});return}
if(id==='04-006')await book('soukanvuori','12','tenant');
let policy={actor:'board',authority:'Board resolution',version:'v2',effectiveAt:'2026-11-23T00:00:00Z',chooseDays:7,noticeDays:20,bookerRoles:['tenant'],caps:{}};
if(id==='04-007'){await req('/api/houses',B);await req('/api/scarcity',{house:'house-b',household:'12',role:'tenant',group:'family'})}
await req('/api/houses/soukanvuori/policies',policy);await req('/api/state');if(id==='04-004')await book();
})().catch(e=>{console.log('ERROR '+e.stack);process.exitCode=1});
