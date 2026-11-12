import path from 'node:path';
import { openDatabase } from '../lib/database.mjs';
import { openStore } from '../lib/store.mjs';
// Operator-only migration. No old single-user records are assigned to the first person to sign in.
const email=String(process.env.IMPORT_STUDENT_EMAIL||'').trim().toLowerCase();
if(!email)throw new Error('Set IMPORT_STUDENT_EMAIL to the verified owner of the existing local data.');
const database=await openDatabase({dataDir:process.env.ASSISTANT_DATA||'./data'});
let legacy;
try {
  const matches=(await database.auth.all('users')).filter(user=>user.email===email);
  const verified=matches.filter(user=>user.provider==='google');
  const user=verified.length===1?verified[0]:matches.length===1?matches[0]:null;
  if(!user)throw new Error('Sign in as the intended owner before importing legacy data.');
  legacy=openStore(path.resolve(process.env.LEGACY_DATA_DIR||'./data'));
  const target=database.forUser(user.id),buckets=['events','sources','jobs','applications','metrics','documents'];
  let imported=0;
  for(const bucket of buckets) {
    const ids=legacy.db.prepare('SELECT id FROM records WHERE bucket=?').all(bucket);
    for(const {id} of ids){if(await target.get(bucket,id))continue;const value=legacy.get(bucket,id);if(bucket==='events'){value.status='review';delete value.googleId;delete value.googleLink;delete value.syncedAt;}await target.putIfAbsent(bucket,id,value);imported++;}
  }
  // Credentials, chat bindings, delivery states, and approval authority are not transferable connections.
  const profile=legacy.get('settings','profile')||{};
  const current=await target.get('settings','profile')||{};
  await target.put('settings','profile',{...current,name:profile.name||user.name,email:user.email,jobTitles:profile.jobTitles||'',jobLocation:profile.jobLocation||'',model:process.env.OLLAMA_MODEL||'qwen3.5:9b-q4_K_M',paused:true});
  console.log(JSON.stringify({imported,identityProvider:user.provider,connections:'Reconnect separately',reminders:'Paused until student review',originalDatabase:'Preserved'}));
} finally {legacy?.close();await database.close();}
