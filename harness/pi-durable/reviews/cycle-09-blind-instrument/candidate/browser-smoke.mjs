// Optional interactive UI probe. Requires a separately installed Playwright and browser.
import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
const url=process.env.URL||'http://127.0.0.1:8901';
fs.mkdirSync(path.resolve('.tooling/tmp'),{recursive:true});
fs.mkdirSync(path.resolve('evidence'),{recursive:true});
const browser=await chromium.launch({executablePath:process.env.CHROMIUM,headless:true,args:['--no-sandbox','--disable-dev-shm-usage'],env:{...process.env,TMPDIR:path.resolve('.tooling/tmp')}});
const page=await browser.newPage({viewport:{width:1400,height:1000}}),errors=[];
page.on('pageerror',e=>errors.push(e.message));
try{
 await page.goto(url);await page.getByRole('heading',{name:'Make room for a little calm.'}).waitFor();
 await page.selectOption('#house','demo');await page.getByText('Your weekly sauna schedule.').first().waitFor().catch(()=>{});
 await page.waitForTimeout(300);
 await page.getByRole('button',{name:'Request a slot',exact:false}).click();
 await page.selectOption('#request-resource','9');await page.selectOption('#request-weekday','Tuesday');
 await page.getByRole('button',{name:'Request confirmation'}).click();await page.locator('#notice.error').waitFor();
 assert.match(await page.locator('#notice').innerText(),/Thursday/);
 await page.getByRole('button',{name:'Request this alternative'}).click();
 await page.getByRole('button',{name:'Request confirmation'}).click();
 await page.waitForFunction(()=>document.querySelector('#notice').textContent.includes('confirmed'));
 await page.getByRole('button',{name:'My bookings',exact:true}).click();await page.getByText('Every Tuesday',{exact:true}).waitFor();
 await page.getByText("Release one week's occurrence",{exact:true}).click();
 await page.getByRole('button',{name:'Offer this occurrence'}).click();
 await page.waitForFunction(()=>document.querySelector('#notice').textContent.includes('offered'));
 await page.fill('#household','3');await page.locator('#household').dispatchEvent('change');await page.waitForTimeout(100);
 await page.getByRole('button',{name:'One-week offers',exact:true}).click();
 await page.getByRole('button',{name:'Take free as apartment 3'}).click();
 await page.waitForFunction(()=>document.querySelector('#notice').textContent.includes('taken'));
 await page.getByRole('button',{name:'View this date’s list, heat & billing'}).click();
 await page.getByRole('heading',{name:'Posted slot list',exact:true}).waitFor();
 assert.equal(await page.locator('table').first().getByText('Apartment 3',{exact:true}).count(),1);
 assert.equal(await page.locator('table').nth(2).getByText('Apartment 12',{exact:true}).count(),1);
 for(const name of ['Queue & notices','House policy','History & disputes','Weekly schedule']){await page.getByRole('button',{name,exact:true}).click();await page.waitForTimeout(200);}
 await page.screenshot({path:'evidence/ui-desktop.png',fullPage:true});
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:'evidence/ui-mobile.png',fullPage:true});
 assert.deepEqual(errors,[]);
 console.log('Browser workflows passed: refusal, alternative booking, release, free take, derived views, all navigation, mobile render.');
}finally{await browser.close();}
