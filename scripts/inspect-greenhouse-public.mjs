// Read-only public Greenhouse markup probe. Never enters applicant data or submits.
import {chromium} from 'playwright-core';
import {writeFile} from 'node:fs/promises';
if(process.argv.includes('--adapter-location')){
 const {greenhouseLocationChoices}=await import('../lib/greenhouse-browser.mjs');
 console.log(JSON.stringify(await greenhouseLocationChoices('https://job-boards.greenhouse.io/reddit/jobs/8023563','New York')));
 process.exit(0);
}
if(process.argv.includes('--adapter')){
 const {inspectGreenhouseApplication}=await import('../lib/greenhouse-browser.mjs');
 const form=await inspectGreenhouseApplication('https://job-boards.greenhouse.io/reddit/jobs/8023563');
 await writeFile('/private/tmp/greenhouse-normalized-public-form.json',JSON.stringify(form,null,2));
 console.log(JSON.stringify({title:form.title,fields:form.fields.map(f=>({key:f.key,type:f.type,required:f.required,multiple:f.multiple,choices:f.options.length}))}));
 process.exit(0);
}
const browser=await chromium.launch({executablePath:process.env.APPLICATION_BROWSER_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,chromiumSandbox:true});
const hosts=new Set();
try{
 const page=await browser.newPage();page.on('request',r=>hosts.add(new URL(r.url()).hostname));
 page.on('response',r=>{if(new URL(r.url()).hostname==='api-geocode-earth-proxy.greenhouse.io')console.log(JSON.stringify({geocodeStatus:r.status()}));});
 await page.goto('https://job-boards.greenhouse.io/reddit/jobs/8023563',{waitUntil:'load'});
 await page.getByRole('button',{name:'Submit application',exact:true}).waitFor({timeout:25000});
 if(process.argv.includes('--country')){
  const input=page.locator('[id="country"]');await input.click();
  console.log(await page.getByRole('option',{name:'United States +1',exact:true}).evaluate(e=>e.outerHTML));
  await page.getByRole('option',{name:'United States +1',exact:true}).click();
  console.log(await input.evaluate(e=>e.closest('.select').outerHTML));
  await browser.close();process.exit(0);
 }
 if(process.argv.includes('--location')){
  await page.locator('[id="candidate-location"]').fill('New York');
  await page.locator('[id="candidate-location"]').press('ArrowDown');
  try{await page.getByRole('option').filter({visible:true}).first().waitFor({timeout:12000});}catch{}
  console.log(JSON.stringify({locations:await page.getByRole('option').filter({visible:true}).allTextContents(),hosts:[...hosts]}));
  await browser.close();process.exit(0);
 }
 if(process.argv.includes('--snapshot')){
  const {greenhouseDOMSnapshot}=await import('../lib/greenhouse-browser.mjs');
  await page.getByTestId('cover_letter-text').click();
  await page.locator('#cover_letter_text').waitFor();
  console.log(JSON.stringify(await page.evaluate(greenhouseDOMSnapshot),null,2));
  await browser.close();process.exit(0);
 }
 const result=await page.evaluate(()=>({url:location.href,title:document.querySelector('h1')?.innerText,forms:[...document.forms].map(f=>({id:f.id,action:f.action,html:f.outerHTML})),controls:[...document.querySelectorAll('input,textarea,select')].map(e=>({tag:e.tagName,id:e.id,name:e.name,type:e.type,role:e.getAttribute('role'),required:e.required,ariaRequired:e.getAttribute('aria-required'),labels:[...e.labels||[]].map(l=>l.innerText),html:e.outerHTML,parent:e.parentElement.outerHTML.slice(0,5000)}))}));
 await writeFile('/private/tmp/greenhouse-public-form.json',JSON.stringify(result,null,2));
 console.log(JSON.stringify({url:result.url,title:result.title,hosts:[...hosts]}));
 const ids=await page.locator('#application-form input[role=combobox]').evaluateAll(es=>es.filter(e=>e.getClientRects().length&&e.id!=='candidate-location').map(e=>e.id));
 for(const id of ids){
  const input=page.locator(`input[id="${id}"]`);
  if(id==='candidate-location')continue;
  await input.click();
  await input.press('ArrowDown');
  try{await page.getByRole('option').first().waitFor({timeout:3000});}catch{await input.click();await page.getByRole('option').first().waitFor({timeout:3000});}
  console.log(JSON.stringify({id,options:await page.getByRole('option').allTextContents()}));
  await input.press('Escape');
 }
 await page.getByTestId('cover_letter-text').click();
 console.log(JSON.stringify({cover:await page.locator('textarea').evaluateAll(es=>es.map(e=>e.outerHTML))}));
 await page.locator('[id="candidate-location"]').fill('New York');
 try{await page.getByRole('option').first().waitFor({timeout:5000});}catch{console.log(JSON.stringify({locationHTML:await page.locator('[id="candidate-location"]').evaluate(e=>e.closest('.select').outerHTML)}));}
 console.log(JSON.stringify({locations:await page.getByRole('option').allTextContents(),hosts:[...hosts]}));
}finally{await browser.close();}
