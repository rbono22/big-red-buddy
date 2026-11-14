import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

// Exercise the deployment command against copied public example files only.
// An empty PATH deliberately makes Docker unavailable: no daemon, real env,
// private data directory, secret file, or live deployment can be accessed.
test('deployment validation rejects domain widening and pilot bypasses without modifying the allowlist',async t=>{
 const repo=path.resolve(import.meta.dirname,'..'),dir=await mkdtemp(path.join(tmpdir(),'brf-deployment-policy-'));
 t.after(()=>rm(dir,{recursive:true,force:true}));
 const names=['scripts/check-deployment.mjs','lib/security.mjs','compose.pilot.yml','Dockerfile','.dockerignore','requirements-markitdown.txt','deploy/Caddyfile','deploy/pilot.env.example'];
 for(const name of names){await mkdir(path.dirname(path.join(dir,name)),{recursive:true});await writeFile(path.join(dir,name),await readFile(path.join(repo,name)));}
 const configPath=path.join(dir,'deploy/pilot.env.example'),composePath=path.join(dir,'compose.pilot.yml');
 const originalConfig=(await readFile(configPath,'utf8')).replace(/^PILOT_EMAILS=.*$/m,'PILOT_EMAILS=one@cornell.edu,two@cornell.edu,three@cornell.edu,four@cornell.edu,five@cornell.edu'),originalCompose=await readFile(composePath,'utf8');
 const run=()=>spawnSync(process.execPath,[path.join(dir,'scripts/check-deployment.mjs')],{cwd:dir,env:{PATH:'',LANG:'en_US.UTF-8'},encoding:'utf8',timeout:10000});
 await writeFile(configPath,originalConfig);let result=run();assert.equal(result.status,0,result.stdout+result.stderr);assert.match(result.stdout,/domain is fixed to cornell\.edu/);assert.match(result.stdout,/Docker is unavailable/);assert.equal(await readFile(configPath,'utf8'),originalConfig);
 for(const value of ['example.edu','cornell.edu,example.edu']){await writeFile(configPath,originalConfig.replace(/^ALLOWED_GOOGLE_DOMAINS=.*$/m,`ALLOWED_GOOGLE_DOMAINS=${value}`));result=run();assert.equal(result.status,1);assert.match(result.stderr,/cannot broaden the Cornell sign-in domain/);}
 await writeFile(configPath,originalConfig.replace('five@cornell.edu','five@gmail.com'));result=run();assert.equal(result.status,1);assert.match(result.stderr,/only explicit Cornell email addresses/);
 await writeFile(configPath,originalConfig+'\nALLOW_ALL_CORNELL=true\n');result=run();assert.equal(result.status,1);assert.match(result.stderr,/preserves the invited pilot/);
 await writeFile(configPath,originalConfig);await writeFile(composePath,originalCompose.replace('ALLOWED_GOOGLE_DOMAINS: cornell.edu','ALLOWED_GOOGLE_DOMAINS: ${ALLOWED_GOOGLE_DOMAINS:-cornell.edu}'));result=run();assert.equal(result.status,1);assert.match(result.stderr,/domain is fixed to cornell\.edu/);
 await writeFile(composePath,originalCompose.replace('PILOT_EMAILS: ${PILOT_EMAILS:?Set the pilot email allowlist}','PILOT_EMAILS: ${PILOT_EMAILS:-}'));result=run();assert.equal(result.status,1);assert.match(result.stderr,/requires an explicit pilot allowlist/);assert.equal(await readFile(configPath,'utf8'),originalConfig);
});

test('deployment validation distinguishes optional host fallback from required and packaged converters',async t=>{
 const repo=path.resolve(import.meta.dirname,'..'),dir=await mkdtemp(path.join(tmpdir(),'brf-converter-deployment-'));
 t.after(()=>rm(dir,{recursive:true,force:true}));
 for(const name of ['scripts/check-deployment.mjs','lib/security.mjs','compose.pilot.yml','Dockerfile','.dockerignore','requirements-markitdown.txt','deploy/Caddyfile','deploy/pilot.env.example']){await mkdir(path.dirname(path.join(dir,name)),{recursive:true});await writeFile(path.join(dir,name),await readFile(path.join(repo,name)));}
 const run=(args=[])=>spawnSync(process.execPath,[path.join(dir,'scripts/check-deployment.mjs'),...args],{cwd:dir,env:{PATH:'',LANG:'en_US.UTF-8'},encoding:'utf8',timeout:10000});
 let result=run();assert.equal(result.status,0,result.stdout+result.stderr);assert.match(result.stdout,/Host MarkItDown is unavailable/);assert.match(result.stdout,/converter dependencies are pinned/);
 result=run(['--require-markitdown']);assert.equal(result.status,1);assert.match(result.stderr,/Pinned local MarkItDown converter is available/);
 const ignore=path.join(dir,'.dockerignore'),originalIgnore=await readFile(ignore,'utf8');await writeFile(ignore,originalIgnore.replace('!scripts/markitdown_extract.py',''));result=run();assert.equal(result.status,1);assert.match(result.stderr,/bridge and requirements are explicitly packaged/);
 await writeFile(ignore,originalIgnore);const requirements=path.join(dir,'requirements-markitdown.txt'),originalRequirements=await readFile(requirements,'utf8');await writeFile(requirements,originalRequirements.replace(/markitdown\[pdf\]==[\d.]+/,'markitdown[pdf]'));result=run();assert.equal(result.status,1);assert.match(result.stderr,/converter dependencies are pinned/);
 await writeFile(requirements,originalRequirements);const configPath=path.join(dir,'deploy/pilot.env.example'),originalConfig=await readFile(configPath,'utf8');await writeFile(configPath,originalConfig.replace(/^NODE_IMAGE=.*$/m,'NODE_IMAGE=node:24-bookworm-slim'));result=run();assert.equal(result.status,1);assert.match(result.stderr,/trixie-slim for supported Python/);
});
