import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {openDatabase} from '../lib/database.mjs';
import {syncSlack} from '../lib/integrations.mjs';

test('Slack verifies membership, retains pagination, and queues new updates after the initial import',async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),'dabas-slack-sync-')),db=await openDatabase({dataDir:dir,databaseUrl:null}),store=db.forUser('student');
  let membership=true,page={messages:[{ts:'1000.0001',text:'Important: please read the latest Miro feedback.'}],has_more:true,response_metadata:{next_cursor:'second'}};
  const calls=[],notices=[];
  t.mock.method(globalThis,'fetch',async(url,options)=>{calls.push({method:url.split('/').at(-1),body:JSON.parse(options.body)});return {ok:true,json:async()=>url.endsWith('conversations.info')?{ok:true,channel:{is_member:membership}}:{ok:true,...page}};});
  try {
    await store.put('secrets','slack',{userToken:'xoxp-fixture',channel:'CTEST',teamURL:'https://workspace.slack.com/'});
    await store.put('secrets','telegram',{chatId:1});
    const queueNotification=async value=>notices.push(value);
    await syncSlack(store,{queueNotification});
    assert.equal(notices.length,0);assert.equal((await store.get('settings','slackHealth')).initialImportComplete,false);
    assert.equal((await store.get('settings','slackHealth')).latest,undefined);
    page={messages:[{ts:'900.0001',text:'Important: feedback has been posted.'}],has_more:false};
    await syncSlack(store,{queueNotification});
    assert.equal(calls.at(-1).body.cursor,'second');assert.equal(notices.length,0);
    assert.equal((await store.get('settings','slackHealth')).latest,'1000.0001');
    page={messages:[{ts:'1100.0001',text:'Important: please read the new team feedback.'}],has_more:false};
    await syncSlack(store,{queueNotification});assert.equal(notices.length,1);assert.match(notices[0].text,/workspace.slack.com\/archives\/CTEST/);
    await syncSlack(store,{queueNotification});assert.equal(notices.length,1);
    membership=false;const oldCount=calls.length;await assert.rejects(syncSlack(store,{queueNotification}),/not a member/);assert.equal(calls.length,oldCount+1);
    await store.put('secrets','slack',{userToken:'expired',channel:'CTEST',expiresAt:Date.now()-1});
    await assert.rejects(syncSlack(store,{queueNotification}),/expired/);
  }finally{await db.close();await rm(dir,{recursive:true,force:true});}
});
