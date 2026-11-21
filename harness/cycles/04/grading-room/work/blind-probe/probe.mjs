const base='http://127.0.0.1:8080/api/soukanvuori/';
const request={resource:'pukuhuone-8',weekday:'Tuesday',start:'17:00',role:'shareholder',household:'blind-011'};
const response=await fetch(base+'standing',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(request)});
const body=await response.json();
const views=await (await fetch(base+'views')).json();
const outcome={blindReply:'REQUEST: pukuhuone 8 | Tuesday | 17:00',request,status:response.status,response:body,posted:views.posted,heater:views.heater,billing:views.billing};
console.log(JSON.stringify(outcome));
if(response.status!==201||body.booking?.resource!==request.resource||body.booking?.weekday!==request.weekday||body.booking?.start!==request.start||!views.posted?.some(x=>x.bookingId===body.booking.id))process.exitCode=1;
