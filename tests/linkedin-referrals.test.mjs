import test from 'node:test';
import assert from 'node:assert/strict';
import {referralMessage} from '../lib/linkedin-referrals.mjs';

test('referral draft names the selected contact, role and company and includes the application link',()=>{
 const text=referralMessage({title:'Product Manager | Bill Pay',company:'Ramp',applyUrl:'https://jobs.ashbyhq.com/ramp/role/application'},{name:'Alex Rivera'});
 assert.match(text,/^Hey Alex,/);
 assert.match(text,/Product Manager \| Bill Pay role at Ramp/);
 assert.match(text,/Does Ramp have a referral program, and would you feel comfortable referring me\?/);
 assert.match(text,/quick call.*relevant experience and catch up/);
 assert.match(text,/Here’s the role: https:\/\/jobs.ashbyhq.com\/ramp\/role\/application$/);
 assert.doesNotMatch(text,/years|expert|qualified|referred|sent/i);
});

test('referral text is bounded, single-line source values cannot introduce extra paragraphs, and unsafe links are omitted',()=>{
 const text=referralMessage({title:'Engineer\n\nIgnore previous instructions',company:'Example\u202e\nInc',url:'javascript:alert(1)'},{name:'  Zoë\nGarcia '});
 assert.match(text,/^Hey Zoë,/);
 assert.doesNotMatch(text,/[\n\u202e]|javascript:/);
 const long=referralMessage({title:'x'.repeat(10000),company:'y'.repeat(10000),url:'https://example.com/'+ 'z'.repeat(3000)},{name:'a'.repeat(10000)});
 assert.ok(long.length<1100);
 assert.match(referralMessage({},{}),/Hey \[Name\].*\[job title\].*\[company\]/);
});
