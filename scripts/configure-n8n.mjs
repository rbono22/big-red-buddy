import { spawn } from 'node:child_process';
import { writeFile, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { openStore } from '../lib/store.mjs';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const store=openStore(path.join(root,'data'));const credential=store.get('secrets','automation');store.close();
if(!credential){console.error('Start the local assistant once before configuring n8n.');process.exit(1);}
const temp=path.join(root,'data','n8n-credential-import.json');
const run=args=>new Promise((resolve,reject)=>{const child=spawn(process.execPath,[path.join(root,'scripts/start-n8n.mjs'),...args],{cwd:root,stdio:'inherit'});child.on('exit',code=>code===0?resolve():reject(new Error('n8n configuration did not complete. Finish owner setup at localhost:5678, stop n8n, and retry.')));});
try{
 await writeFile(temp,JSON.stringify([{id:'dabasLocalCredential',name:'Dabas local automation',type:'httpHeaderAuth',data:{name:'X-Automation-Key',value:credential.key}}]),{mode:0o600});
 await run(['import:credentials',`--input=${temp}`]);
 await run(['import:workflow',`--input=${path.join(root,'workflows/reminders.json')}`]);
 await run(['publish:workflow','--id=dabasLocalReminderWorkflow']);
 console.log('Local reminder workflow imported and published. Restart n8n to activate.');
}finally{await unlink(temp).catch(()=>{});}
