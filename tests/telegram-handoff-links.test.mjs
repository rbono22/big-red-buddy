import test from 'node:test';
import assert from 'node:assert/strict';
import {validateTelegramReplyMarkup} from '../lib/telegram-delivery.mjs';

const markup=url=>({inline_keyboard:[[{text:'Continue in your browser',url}]]});
test('Telegram browser handoffs accept only canonical same-origin application IDs, never secret-bearing links',t=>{
 const previous=process.env.APP_ORIGIN;process.env.APP_ORIGIN='https://app.synthetic.example';t.after(()=>{if(previous===undefined)delete process.env.APP_ORIGIN;else process.env.APP_ORIGIN=previous;});
 for(const id of ['a','application:job_1-example','a'.repeat(160)]){
  const url=`https://app.synthetic.example/#application-handoff/${id}`;
  assert.deepEqual(validateTelegramReplyMarkup(markup(url)),markup(url));
 }
 const blocked=[
  'https://outside.example/#application-handoff/app',
  'https://app.synthetic.example.attacker.example/#application-handoff/app',
  'https://x:y@app.synthetic.example/#application-handoff/app',
  'http://app.synthetic.example/#application-handoff/app',
  'https://app.synthetic.example:8443/#application-handoff/app',
  'https://app.synthetic.example:443/#application-handoff/app',
  'https://%61pp.synthetic.example/#application-handoff/app',
  'https://app.synthetic.example/elsewhere/#application-handoff/app',
  'https://app.synthetic.example/elsewhere/../#application-handoff/app',
  'https://app.synthetic.example/#application-handoff/%61pp',
  'https://app.synthetic.example/#application-handoff/app%2Fsecret',
  'https://app.synthetic.example/?token=private#application-handoff/app',
  'https://app.synthetic.example/#application-handoff/app?token=private',
  'https://app.synthetic.example/#application-handoff/app&secret=private',
  'https://app.synthetic.example/#application-handoff/app/token/private',
  'https://app.synthetic.example/#application-handoff/',
  'https://app.synthetic.example/#application-handoff/'+'a'.repeat(161),
  'https://app.synthetic.example/#application-handoff/app\n'
 ];
 for(const url of blocked)assert.throws(()=>validateTelegramReplyMarkup(markup(url)),/Invalid Telegram event link/,url);
 delete process.env.APP_ORIGIN;assert.throws(()=>validateTelegramReplyMarkup(markup('https://app.synthetic.example/#application-handoff/app')),/Invalid Telegram event link/);
});
