// Read-only inspection: no applicant data, uploads or submission.
import {chromium} from 'playwright-core';
import {writeFile} from 'node:fs/promises';
import {readWorkableForm} from '../lib/workable-browser.mjs';
const mockUpload=process.argv.includes('--mock-upload');
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,chromiumSandbox:true});
try {
 const c=await browser.newContext({serviceWorkers:'block',acceptDownloads:false});
 await c.routeWebSocket('**/*',s=>s.close());
 const hosts=new Set();
 await c.route('**/*',r=>{const u=new URL(r.request().url());hosts.add(u.hostname);if(mockUpload&&r.request().method()==='POST'&&u.hostname==='workable-application-form.s3.us-east-1.amazonaws.com')return r.fulfill({status:204});const readOnly=r.request().method()==='GET'||u.origin==='https://apply.workable.com'&&u.pathname==='/api/v3/accounts/valsoft-corp/jobs';if(!readOnly&&u.pathname.includes('/api/'))console.log(JSON.stringify({blockedMethod:r.request().method(),path:u.pathname,contentType:r.request().headers()['content-type'],bodyBytes:r.request().postDataBuffer()?.length}));return readOnly?r.continue():r.abort();});
 const p=await c.newPage();
 p.on('response',async response=>{const u=new URL(response.url());if(u.hostname==='apply.workable.com'&&u.pathname.startsWith('/api/')){console.log(JSON.stringify({readResponsePath:u.pathname,status:response.status()}));}});
 await p.goto('https://apply.workable.com/valsoft-corp/j/4560CF5DD0/apply/',{waitUntil:'networkidle',timeout:45000});
 await p.locator('input').first().waitFor({timeout:20000}).catch(()=>{});
 if(mockUpload){await p.locator('input[data-ui="resume"]').setInputFiles({name:'Synthetic-offline-resume.pdf',mimeType:'application/pdf',buffer:Buffer.from('%PDF-1.7\nOffline synthetic file intercepted locally; never transmitted.')});await p.getByText('Synthetic-offline-resume.pdf',{exact:true}).waitFor({timeout:20000});await p.locator('[data-action=abort]').waitFor({state:'hidden',timeout:15000}).catch(()=>{});console.log(JSON.stringify({mockUpload:true,transmittedFile:false,widget:await p.locator('input[data-ui="resume"]').evaluate(e=>{const w=e.closest('[data-role="dropzone"]');return{hasProgress:!!w.querySelector('[role=progressbar]'),actions:[...w.querySelectorAll('[data-action]')].map(a=>a.dataset.action),viewHost:new URL(w.querySelector('[data-action=view]').href).hostname};})},null,2));}
 console.log(JSON.stringify({adapterForm:await readWorkableForm(p)},null,2));
 console.log(JSON.stringify({url:p.url(),hosts:[...hosts],text:await p.locator('body').innerText(),controls:await p.locator('form input,form select,form textarea,form fieldset').evaluateAll(es=>es.map(e=>({tag:e.tagName,type:e.type,id:e.id,name:e.name,ui:e.dataset.ui,role:e.getAttribute('role'),required:e.required,hidden:e.getAttribute('aria-hidden'),label:e.getAttribute('aria-labelledby')})))},null,2));
 await writeFile('/private/tmp/workable-public-page.html',await p.content());
}finally{await browser.close();}
