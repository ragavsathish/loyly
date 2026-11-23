const {spawn}=require('child_process'), fs=require('fs');
const ids=['01-005','01-006','03-001','03-002','03-003','03-004','03-005','03-014'];
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{for(let ix=0;ix<ids.length;ix++){let id=ids[ix], port=18100+ix, log=[], start=Date.now(); let p=spawn('./start.sh',[String(port)],{cwd:`work/runtime-${id}`,stdio:'ignore'}); let base=`http://127.0.0.1:${port}`;
async function req(method,path,body){let r=await fetch(base+path,{method,headers:{'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});let text=await r.text();log.push(`${method} ${path} ${body?JSON.stringify(body):''}\nHTTP ${r.status} ${text}\n`);try{return JSON.parse(text)}catch{return text}}
try {for(let i=0;i<60;i++){try{await req('GET','/');break}catch(e){await sleep(200)}}
if(id.startsWith('01')){let h='soukanvuori'; let sch=await req('GET',`/api/schedule?house=${h}`); await req('GET',`/api/households?house=${h}`); let slots=sch.slots; let free=slots.filter(s=>!s.held && (s.available!==false)); console.log(id,JSON.stringify(slots).slice(0,1200));
let book=async(hh,s)=>req('POST','/api/bookings',{house:h,household:hh,resource:s.resource,weekday:s.weekday,start:s.start,operator:'manager'});
await book('12',slots[0]);
if(id==='01-005'){await book('12',slots[1]);} else {for(let i=1;i<slots.length;i++) await book('3',slots[i]); await req('GET',`/api/schedule?house=${h}`); await book('12',slots[1]);}
await req('GET',`/api/bookings?house=${h}`); await req('GET',`/api/schedule?house=${h}`);
}else{
let policy={version:'v1',authority:'board',effective:'2020-01-01T00:00:00Z',bookerRoles:['tenant'],route:'self-service',bookingRole:'manager',operationsRole:'caretaker',billingRole:'billing',disputeRole:'caretaker',chooseDays:14,noticeDays:30,caps:{},priceReference:'standing-price',salePriceReference:'resale-price'};
let house={id:'demo',name:'Demo',resources:[{id:'a',name:'Room A',sauna:'Sauna A',group:'A',duration:90,days:{Tuesday:[{start:'17:00',class:'ordinary'},{start:'18:30',class:'ordinary'},{start:'20:00',class:'ordinary'}]}},{id:'b',name:'Room B',sauna:'Sauna B',group:'B',duration:90,days:{Tuesday:[{start:'17:00',class:'ordinary'}]}}],policy};
await req('POST','/api/houses',house); for(let hh of ['12','3','4','5']) await req('POST','/api/households',{house:'demo',id:hh,role:'tenant'}); await req('GET','/api/schedule?house=demo');
let book=async(hh,resource,start)=>req('POST','/api/bookings',{house:'demo',household:hh,resource,weekday:'Tuesday',start,operator:'manager'}); let q=hh=>req('POST','/api/queue',{house:'demo',group:'A',household:hh});
let a=await book('12','a','17:00'); await book('12','a','18:30'); if(id!=='03-001') await book(id==='03-014'?'12':'5','a','20:00');
if(['03-001','03-003','03-005','03-014'].includes(id)) await q('3'); if(id==='03-005') await q('4'); if(id==='03-004') await req('POST','/api/queue',{house:'demo',group:'B',household:'3'});
if(id==='03-003'){let d=new Date();d.setUTCDate(d.getUTCDate()+((9-d.getUTCDay())%7||7));let date=d.toISOString().slice(0,10);await req('POST','/api/releases',{booking:a.booking.id,household:'12',date,mode:'FREE'});await req('GET',`/api/views?house=demo&date=${date}`);}
await req('GET','/api/queue?house=demo&group=A'); await req('GET','/api/queue?house=demo&group=B'); await req('POST','/api/scarcity/evaluate',{house:'demo',group:'A'}); if(id==='03-014') await req('POST','/api/scarcity/evaluate',{house:'demo',group:'A'}); await req('GET','/api/notices?house=demo'); await req('GET','/api/bookings?house=demo'); await req('GET','/api/schedule?house=demo'); if(id==='03-003') await req('GET','/api/releases?house=demo');
}
}catch(e){log.push('ERROR '+e.stack)} finally{p.kill('SIGTERM');await Promise.race([new Promise(r=>p.once('exit',r)),sleep(2000)]);fs.writeFileSync(`work/evidence-${id}.txt`,log.join('\n'));fs.writeFileSync(`work/time-${id}.json`,JSON.stringify({start,stop:Date.now()}));}}
})().catch(console.error);