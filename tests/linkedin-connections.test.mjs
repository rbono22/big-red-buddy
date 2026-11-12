import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openDatabase} from '../lib/database.mjs';
import {importLinkedInConnections,readLinkedInConnections,deleteLinkedInConnections,matchLinkedInConnections,saveLinkedInConnectionSettings,linkedInProfileURL,normalizeConnectionCompany,LINKEDIN_CONNECTION_LIMITS} from '../lib/linkedin-connections.mjs';

const NOW=Date.parse('2026-11-10T18:00:00Z'),DAY=86400000;
const HEADER='First Name,Last Name,URL,Email Address,Company,Position,Connected On';
const cell=value=>`"${String(value??'').replaceAll('"','""')}"`;
const csv=rows=>[HEADER,...rows.map(row=>row.map(cell).join(','))].join('\r\n');
const person=(i=1,company='Acme Inc.')=>[`Person${i}`,'Example',`https://www.linkedin.com/in/example-${i}`,`PRIVATE_EMAIL_${i}@example.edu`,company,'Product Manager','10 Nov 2026'];
async function fixture(t){const dir=await mkdtemp(path.join(tmpdir(),'brf-linkedin-')),db=await openDatabase({dataDir:dir,databaseUrl:null,production:false,allowLocal:true});t.after(async()=>{await db.close();await rm(dir,{recursive:true,force:true});});return {store:db.forUser('alice'),other:db.forUser('bob')};}

test('LinkedIn preamble, BOM, CRLF, quoted commas, escaped quotes, and multiline fields import without retaining CSV or emails',async t=>{
 const {store}=await fixture(t),raw='\uFEFFNotes:\r\n"Your export can contain missing email addresses,\nand this note spans lines."\r\n\r\n'+csv([['Anne','O"Brien','https://linkedin.com/in/anne-ob?trk=PRIVATE_QUERY#fragment','PRIVATE_EMAIL@example.edu','Acme, Inc.','VP,\nProduct','29 Feb 2024']]);
 const metadata=await importLinkedInConnections(store,{csv:raw,name:'PRIVATE_FILENAME@example.edu.csv'},{now:NOW});assert.equal(metadata.connected,true);assert.equal(metadata.count,1);assert.equal(metadata.refreshDays,null);assert.equal(metadata.nextRefreshAt,null);assert.equal(metadata.refreshDue,false);assert.equal(metadata.contacts,undefined);assert.equal(metadata.csv,undefined);
 const record=await store.get('career','linkedinConnections');assert.doesNotMatch(JSON.stringify(record),/PRIVATE_EMAIL|PRIVATE_FILENAME|PRIVATE_QUERY|email addresses|First Name/);assert.equal(record.contacts[0].name,'Anne O"Brien');assert.equal(record.contacts[0].title,'VP, Product');assert.equal(record.contacts[0].url,'https://www.linkedin.com/in/anne-ob');assert.equal(record.contacts[0].connectedOn,'2024-02-29');assert.equal(record.contacts[0].email,undefined);
});

test('only own connections are returned and company matching is exact after conservative legal suffix normalization',async t=>{
 const {store,other}=await fixture(t);await importLinkedInConnections(store,{csv:csv([person(1,'Acme, Inc.'),person(2,'Acme L.L.C.'),person(3,'Acme Bank'),person(4,'Acme Labs'),person(5,'The Acme Company')])},{now:NOW});
 const found=await matchLinkedInConnections(store,'ACME LLC',{now:NOW});assert.equal(found.totalMatches,2);assert.equal(found.matches.length,2);assert.match(found.notice,/not verified current employment/);assert.equal(found.sourceVersion,(await readLinkedInConnections(store,{now:NOW})).sourceVersion);assert.equal((await matchLinkedInConnections(other,'Acme',{now:NOW})).totalMatches,0);assert.equal((await readLinkedInConnections(other,{now:NOW})).connected,false);
 assert.equal(normalizeConnectionCompany('Apple Inc.'),'apple');assert.notEqual(normalizeConnectionCompany('Apple Bank'),normalizeConnectionCompany('Apple Inc.'));assert.notEqual(normalizeConnectionCompany('AT&T'),normalizeConnectionCompany('AT and T'));assert.notEqual(normalizeConnectionCompany('The Acme Company'),normalizeConnectionCompany('Acme'));
});

test('profile URLs are constrained to HTTPS LinkedIn /in profiles and never retain tokens or email-bearing paths',()=>{
 assert.equal(linkedInProfileURL('https://linkedin.com/in/Alex-123/?trk=secret#fragment'),'https://www.linkedin.com/in/Alex-123');assert.equal(linkedInProfileURL('https://www.linkedin.com/in/jos%C3%A9-example'),'https://www.linkedin.com/in/jos%C3%A9-example');
 for(const url of ['http://linkedin.com/in/alex','https://linkedin.com.evil.test/in/alex','https://evil.test/in/alex','https://user:password@linkedin.com/in/alex','https://linkedin.com:8443/in/alex','https://linkedin.com/company/acme','https://linkedin.com/in/alex/extra','https://linkedin.com/in/alex%40example.com','https://linkedin.com/in/alex%2Fextra','javascript:alert(1)','https://linkedin.com/in/../company'])assert.equal(linkedInProfileURL(url),'',url);
});

test('duplicate profiles merge, ambiguous company conflicts cannot create false matches, and invalid links/dates are omitted',async t=>{
 const {store}=await fixture(t),a=person(1),same=[...a],conflict=[...a];conflict[4]='Different Corp';const invalid=person(2);invalid[2]='https://evil.test/profile';invalid[6]='31 Feb 2026';const embedded=person(3);embedded[5]='Engineer email PRIVATE_INLINE@example.edu';
 const result=await importLinkedInConnections(store,{csv:csv([a,same,conflict,invalid,embedded])},{now:NOW});assert.equal(result.count,3);assert.match(result.warnings.join(' '),/duplicate/);assert.match(result.warnings.join(' '),/conflicting companies/);const matches=await matchLinkedInConnections(store,'Acme',{now:NOW});assert.equal(matches.totalMatches,2);assert.equal(matches.matches.find(row=>row.name==='Person2 Example').url,'');assert.equal(matches.matches.find(row=>row.name==='Person2 Example').connectedOn,null);assert.doesNotMatch(JSON.stringify(await store.get('career','linkedinConnections')),/PRIVATE_INLINE/);
});

test('successful imports atomically replace prior contacts, explicit identical uploads refresh age, and request retries remain idempotent',async t=>{
 const {store}=await fixture(t),input={csv:csv([person(1)])};const first=await importLinkedInConnections(store,input,{now:NOW,requestId:'upload-1'});const replay=await importLinkedInConnections(store,input,{now:NOW+DAY,requestId:'upload-1'});assert.equal(replay.replayed,true);assert.equal(replay.importedAt,first.importedAt);assert.equal(replay.sourceVersion,first.sourceVersion);
 const refresh=await importLinkedInConnections(store,input,{now:NOW+DAY});assert.equal(refresh.reused,true);assert.equal(refresh.importedAt,new Date(NOW+DAY).toISOString());assert.notEqual(refresh.sourceVersion,first.sourceVersion);
 await importLinkedInConnections(store,{csv:csv([person(2,'Other Inc.')])},{now:NOW+2*DAY});assert.equal((await matchLinkedInConnections(store,'Acme',{now:NOW+2*DAY})).totalMatches,0);assert.equal((await matchLinkedInConnections(store,'Other',{now:NOW+2*DAY})).totalMatches,1);
 await assert.rejects(importLinkedInConnections(store,input,{now:NOW+3*DAY,expectedVersion:first.version}),{status:409});
});

test('refresh notices support biweekly, monthly, quarterly and legacy weekly upload age while preserving the imported source version',async t=>{
 const {store}=await fixture(t);const imported=await importLinkedInConnections(store,{csv:csv([person()])},{now:NOW});assert.equal((await readLinkedInConnections(store,{now:NOW+20*DAY})).refreshDue,false);
 const weekly=await saveLinkedInConnectionSettings(store,{refreshDays:7},{now:NOW});assert.equal(weekly.sourceVersion,imported.sourceVersion);assert.notEqual(weekly.version,imported.version);assert.equal(weekly.nextRefreshAt,new Date(NOW+7*DAY).toISOString());assert.equal((await readLinkedInConnections(store,{now:NOW+7*DAY})).refreshDue,true);
 const biweekly=await saveLinkedInConnectionSettings(store,{refreshDays:14},{now:NOW});assert.equal(biweekly.nextRefreshAt,new Date(NOW+14*DAY).toISOString());assert.equal((await readLinkedInConnections(store,{now:NOW+13*DAY})).refreshDue,false);assert.equal((await readLinkedInConnections(store,{now:NOW+14*DAY})).stale,true);
 for(const days of [30,90]){
  const selected=await saveLinkedInConnectionSettings(store,{refreshDays:days},{now:NOW}),due=NOW+days*DAY;
  assert.equal(selected.refreshDays,days);assert.equal(selected.nextRefreshAt,new Date(due).toISOString());assert.equal(selected.sourceVersion,imported.sourceVersion);assert.notEqual(selected.version,biweekly.version);
  assert.equal((await readLinkedInConnections(store,{now:due-1})).refreshDue,false);assert.equal((await readLinkedInConnections(store,{now:due})).refreshDue,true);
 }
 await saveLinkedInConnectionSettings(store,{refreshDays:null},{now:NOW});assert.equal((await readLinkedInConnections(store,{now:NOW+31*DAY})).refreshDue,false);assert.equal((await readLinkedInConnections(store,{now:NOW+31*DAY})).stale,true);for(const patch of [{refreshDays:1},{refreshDays:29},{refreshDays:91},{refreshDays:'7'},{refreshDays:'30'},{refreshDays:7,csv:'secret'},{},null])await assert.rejects(saveLinkedInConnectionSettings(store,patch),{status:400});
});

test('deletion clears contacts and reminder preference while delayed request retries cannot resurrect them',async t=>{
 const {store,other}=await fixture(t),input={csv:csv([person()])};await importLinkedInConnections(store,input,{now:NOW,requestId:'same-import'});await saveLinkedInConnectionSettings(store,{refreshDays:7},{now:NOW});await importLinkedInConnections(other,input,{now:NOW});
 const deleted=await deleteLinkedInConnections(store,{now:NOW+DAY});assert.equal(deleted.connected,false);assert.equal(deleted.count,0);assert.equal(deleted.refreshDays,null);assert.equal(deleted.importedAt,null);const record=await store.get('career','linkedinConnections');assert.deepEqual(record.contacts,[]);assert.equal(record.contentHash,null);assert.doesNotMatch(JSON.stringify(record),/Person1|Example|linkedin\.com\/in/);
 const replay=await importLinkedInConnections(store,input,{now:NOW+2*DAY,requestId:'same-import'});assert.equal(replay.replayed,true);assert.equal(replay.connected,false);assert.equal((await readLinkedInConnections(other,{now:NOW})).count,1);assert.equal((await deleteLinkedInConnections(store,{now:NOW+3*DAY})).version,deleted.version);
});

test('a stale in-flight import cannot undo a concurrent delete',async t=>{
 const {store}=await fixture(t);await importLinkedInConnections(store,{csv:csv([person()])},{now:NOW});let announce,release;const captured=new Promise(resolve=>{announce=resolve;}),resume=new Promise(resolve=>{release=resolve;});let once=true;
 const delayed=new Proxy(store,{get(target,key){if(key==='get')return async(bucket,id)=>{const value=await target.get(bucket,id);if(once&&bucket==='career'&&id==='linkedinConnections'){once=false;announce();await resume;}return value;};return Reflect.get(target,key);}});
 const importing=importLinkedInConnections(delayed,{csv:csv([person(2)])},{now:NOW+1});await captured;await deleteLinkedInConnections(store,{now:NOW+2});release();await assert.rejects(importing,{status:409});assert.equal((await readLinkedInConnections(store,{now:NOW+3})).connected,false);
});

test('malformed and oversized imports preserve existing data and error messages contain no source cells',async t=>{
 const {store}=await fixture(t);const before=await importLinkedInConnections(store,{csv:csv([person()])},{now:NOW});
 for(const raw of ['Not a connections file',HEADER+'\n"PRIVATE_UNFINISHED',HEADER+'\n"PRIVATE_CLOSED"evil',HEADER+'\nshort,row',HEADER+'\n'+cell('x'.repeat(LINKEDIN_CONNECTION_LIMITS.fieldCharacters+1)),HEADER+'\nPRIVATE\0NUL', 'x'.repeat(LINKEDIN_CONNECTION_LIMITS.bytes+1), 'First Name,Last Name,URL,Company,Company,Position,Connected On\nA,B,,,Acme,Role,2026-11-10']){await assert.rejects(importLinkedInConnections(store,{csv:raw},{now:NOW}),error=>error.status===400&&!/PRIVATE/.test(error.message));assert.equal((await readLinkedInConnections(store,{now:NOW})).version,before.version);}
 await assert.rejects(importLinkedInConnections(store,{csv:csv([person()]),userId:'other'},{now:NOW}),{status:400});await assert.rejects(readLinkedInConnections({get:async()=>null}),/student-owned/);
});

test('large imports are bounded at thirty thousand rows and matching returns a small deterministic page',async t=>{
 const {store}=await fixture(t),rows=Array.from({length:30},(_,i)=>person(i));await importLinkedInConnections(store,{csv:csv(rows)},{now:NOW});const result=await matchLinkedInConnections(store,'Acme',{now:NOW});assert.equal(result.totalMatches,30);assert.equal(result.matches.length,20);assert.equal(result.truncated,true);assert.deepEqual(result.matches.map(row=>row.name),[...result.matches.map(row=>row.name)].sort((a,b)=>a.localeCompare(b)));
 const tooMany=HEADER+'\n'+Array.from({length:LINKEDIN_CONNECTION_LIMITS.contacts+1},()=> 'A,B,https://linkedin.com/in/same,,Acme,Role,2026-11-10').join('\n');await assert.rejects(importLinkedInConnections(store,{csv:tooMany},{now:NOW}),{status:400});assert.equal((await readLinkedInConnections(store,{now:NOW})).count,30);
});

test('a valid thirty-thousand-contact export fits one atomic private record while reads remain metadata-only',async t=>{
 const {store}=await fixture(t),raw=csv(Array.from({length:LINKEDIN_CONNECTION_LIMITS.contacts},(_,i)=>person(i,`Employer ${i%100} LLC`)));assert.ok(Buffer.byteLength(raw)<LINKEDIN_CONNECTION_LIMITS.bytes);
 const imported=await importLinkedInConnections(store,{csv:raw},{now:NOW});assert.equal(imported.count,30000);assert.ok(JSON.stringify(imported).length<2000);const found=await matchLinkedInConnections(store,'Employer 5 Inc.',{now:NOW});assert.equal(found.totalMatches,300);assert.equal(found.matches.length,20);assert.equal(found.truncated,true);await deleteLinkedInConnections(store,{now:NOW+1});assert.equal((await readLinkedInConnections(store,{now:NOW+1})).count,0);
});
