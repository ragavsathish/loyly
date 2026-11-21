import os,subprocess,time,json,urllib.request,urllib.error,uuid,datetime
W='/workspace/work'; os.chdir('/workspace'); os.makedirs(W+'/allure-results',exist_ok=True)
items=json.load(open('checklist.json'))['items']; outcomes={}
def clock(s,log):
 p=subprocess.run(['date','-u','-s',s],text=True,capture_output=True); log.append('$ date -u -s '+s+'\n'+p.stdout+p.stderr+'exit='+str(p.returncode)); return p.returncode==0
for item in items:
 if item['id'] not in ['05-005']: continue
 id=item['id']; log=[]; start=int(time.time()*1000); runtime=W+'/runtime-'+id
 if not os.path.exists(runtime): subprocess.run(['cp','-R','impl',runtime],check=True)
 deadline=id in ['02-003','05-005']; clockok=True
 if deadline: clockok=clock(datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%d %H:%M:00'),log)
 server=open(W+'/server-'+id+'.log','w'); p=subprocess.Popen(['./start.sh','18081'],cwd=runtime,stdout=server,stderr=subprocess.STDOUT)
 def req(method,path,data=None):
  payload=json.dumps(data).encode() if data is not None else None
  r=urllib.request.Request('http://127.0.0.1:18081'+path,data=payload,method=method,headers={'Content-Type':'application/json'})
  try:
   with urllib.request.urlopen(r,timeout=5) as x: status=x.status; body=x.read().decode()
  except urllib.error.HTTPError as e: status=e.code; body=e.read().decode()
  log.append(method+' '+path+' '+(json.dumps(data) if data is not None else '')+'\nHTTP '+str(status)+'\n'+body)
  try: return status,json.loads(body)
  except: return status,body
 try:
  for n in range(60):
   try: status,house=req('GET','/api/houses'); break
   except Exception: time.sleep(.25)
  else: raise Exception('server not ready')
  if id=='01-011':
   s,r=req('POST','/api/bookings',{'house':'soukanvuori','household':'12','resource':'ph9','weekday':'Tuesday','start':'17:00','operator':'manager'})
   text=r.get('reason','') if isinstance(r,dict) else ''
   open(W+'/blind-review-011.txt','w').write(text)
   outcomes[id]=('skipped','not reached: blind subagent review required; closed-day request returned HTTP %s; exact refusal attached.'%s)
  elif id.startswith('02'):
   if deadline and not clockok: raise Exception('baseline clock command failed')
   s,b=req('POST','/api/bookings',{'house':'soukanvuori','household':'12','resource':'ph8','weekday':'Tuesday','start':'17:00','operator':'manager'}); assert s==201, str(b)
   bid=b['booking']['id']; req('GET','/api/bookings?house=soukanvuori')
   # choose future Tuesday based on actual guest clock
   today=datetime.datetime.now(datetime.timezone.utc).date(); d=today+datetime.timedelta(days=(1-today.weekday())%7 or 7); ds=str(d); following=str(d+datetime.timedelta(days=7))
   s,r=req('POST','/api/releases',{'booking':bid,'household':'12','date':ds,'mode':'FREE'}); assert s==201,str(r)
   rid=r['release']['id']; req('GET','/api/releases?house=soukanvuori'); req('GET','/api/views?house=soukanvuori&date='+ds)
   if id in ['02-001','02-002']:
    s,t=req('POST','/api/releases/'+rid+'/take',{'household':'3'}); assert s==200,str(t)
    _,v=req('GET','/api/views?house=soukanvuori&date='+ds); _,later=req('GET','/api/views?house=soukanvuori&date='+following); _,books=req('GET','/api/bookings?house=soukanvuori'); log.append('CHECK selected='+ds+' following='+following)
    outcomes[id]=('review','Inspect selected and later views')
   else:
    end=ds+' 18:31:00'; assert clock(end,log),'advance clock failed'; req('GET','/api/state'); req('GET','/api/releases?house=soukanvuori'); req('GET','/api/bookings?house=soukanvuori'); req('GET','/api/views?house=soukanvuori&date='+ds); req('GET','/api/views?house=soukanvuori&date='+following)
    outcomes[id]=('review','Inspect expired release and views')
  else:
   if deadline and not clockok: raise Exception('baseline clock command failed')
   def config(h,cap):
    return {'id':h,'name':h,'resources':[{'id':'room','name':'Room','sauna':'Sauna A','group':'A','duration':1,'days':{datetime.datetime.now(datetime.timezone.utc).strftime('%A'):[{'start':(datetime.datetime.now(datetime.timezone.utc)+datetime.timedelta(minutes=1)).strftime('%H:%M'),'class':'family'},{'start':(datetime.datetime.now(datetime.timezone.utc)+datetime.timedelta(minutes=4)).strftime('%H:%M'),'class':'family'}]}}], 'policy':{'version':'v1','authority':'board','effective':'2020-01-01T00:00:00Z','bookerRoles':['tenant'],'route':'self-service','bookingRole':'manager','operationsRole':'caretaker','billingRole':'billing','disputeRole':'caretaker','chooseDays':14,'noticeDays':30,'caps':{'family':1} if cap else {},'priceReference':'standing-price','salePriceReference':'resale-price'}}
   def setup(h,cap):
    s,r=req('POST','/api/houses',config(h,cap)); assert s==201,str(r)
    s,r=req('POST','/api/households',{'house':h,'id':'12','role':'tenant'}); assert s==201,str(r)
   def booking(h,d,t): return req('POST','/api/bookings',{'house':h,'household':'12','resource':'room','date':d,'start':t,'operator':'manager'})
   setup('house-a',True)
   if id=='05-004': setup('house-b',False); h='house-b'
   else: h='house-a'
   today=datetime.datetime.now(datetime.timezone.utc).date(); d=today; ds=str(d)
   if id=='05-002': first='20:00'; second='17:00'
   elif id=='05-003': first='17:00'; second='20:00'
   else: first=(datetime.datetime.now(datetime.timezone.utc)+datetime.timedelta(minutes=1)).strftime('%H:%M'); second=(datetime.datetime.now(datetime.timezone.utc)+datetime.timedelta(minutes=4)).strftime('%H:%M')
   s,b=booking(h,ds,first); assert s==201,str(b); req('GET','/api/bookings?house='+h)
   if id=='05-005':
    assert clock((datetime.datetime.strptime(ds+' '+first, '%Y-%m-%d %H:%M')+datetime.timedelta(minutes=2)).strftime('%Y-%m-%d %H:%M:%S'),log),'advance clock failed'; req('GET','/api/state')
   s,r=booking(h,ds,second); req('GET','/api/bookings?house='+h); req('GET','/api/views?house='+h+'&date='+ds)
   if id=='05-001': ok=s==409 and 'cap' in json.dumps(r).lower() and 'existingBooking' in r
   else: ok=s==201
   outcomes[id]=('passed' if ok else 'failed','Second dated request returned HTTP %s: %s; booking and views reread.'%(s,json.dumps(r)))
 except Exception as e:
  outcomes[id]=('skipped' if id=='01-011' else 'failed',('not reached: blind subagent review required; ' if id=='01-011' else 'not reached: ')+str(e)); log.append('EXCEPTION '+repr(e))
 finally:
  p.terminate()
  try:p.wait(timeout=5)
  except: p.kill();p.wait()
  server.close()
  subprocess.run(['rm','-rf',runtime])
  open(W+'/evidence-'+id+'.txt','w').write('\n\n'.join(log)+'\n')
  outcomes[id]+=(start,int(time.time()*1000))
json.dump(outcomes,open(W+'/outcomes-005.json','w'),indent=2)
