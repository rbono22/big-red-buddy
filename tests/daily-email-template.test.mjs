import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {renderDailyEmail} from '../lib/daily-email-template.mjs';

const fixture=()=>({date:'2026-11-12',timezone:'America/New_York',notificationTopics:['school','events','jobs','news'],counts:{classes:2,deadlines:1,events:1,jobs:1},coverage:['Schedule: imported sources only.','Campus: source changes may be missing.'],emailSections:[
 {sectionKey:'classes',title:'Classes today',items:['10:00 AM · Design studio\nTata L23'],total:2},
 {sectionKey:'deadlines',title:'Due today',items:['5:00 PM · Research presentation\nOnline submission'],total:1},
 {sectionKey:'events',title:'Campus events',items:['6:00 PM · Founder conversations\nTata Center · Available; not on your calendar\nhttps://luma.com/example'],total:1},
 {sectionKey:'jobs24h',title:'New jobs',items:['Product Manager · Example Company\nPosted Nov 11\n/apply internal-job-id\nhttps://example.com/careers/role'],total:1},
 {sectionKey:'news',title:'News',items:['Selected newsletter · received 2026-11-12\nA source-supported summary.\nhttps://example.com/story'],total:1}
]});

test('daily email presents source-backed sections and useful email links without Telegram commands',()=>{
 const email=renderDailyEmail(fixture(),{name:'Maya Student',appOrigin:'https://app.bigredbuddy.com'}),{document}=parseHTML(email.html);
 assert.equal(email.subject,'Your BRB morning briefing · 2026-11-12');assert.match(email.text,/Good morning, Maya/);
 assert.match(email.text,/Thursday, November 12, 2026/);assert.match(email.text,/10:00 AM · Design studio/);assert.match(email.text,/5:00 PM · Research presentation/);
 assert.match(email.text,/1 more in BRB/);assert.doesNotMatch(email.html+email.text,/\/apply internal-job-id/);
 assert.equal(document.querySelector('a[href="https://luma.com/example"]').textContent,'Open event / registration (luma.com)');
 assert.ok(document.querySelector('a[href="https://app.bigredbuddy.com/#connections"]'));
 assert.equal(document.querySelectorAll('img,script,iframe,form').length,0);
 assert.ok([...document.querySelectorAll('table')].every(table=>table.getAttribute('role')==='presentation'));
});

test('source text and name cannot introduce markup, active URI schemes, or header newlines',()=>{
 const f=fixture();f.emailSections[0].items=['<img src=x onerror=alert(1)>\nhttps://user:password@example.com/private\njavascript:alert(1)\nhttps://safe.example/path?x=" onclick="evil'];
 const email=renderDailyEmail(f,{name:'<script>bad()</script>\r\nBcc: victim@example.com'}),{document}=parseHTML(email.html);
 assert.equal(document.querySelectorAll('img,script,[onclick],[onerror]').length,0);assert.match(document.body.textContent,/<img src=x onerror=alert\(1\)>/);
 for(const anchor of document.querySelectorAll('a')){const url=new URL(anchor.getAttribute('href'));assert.equal(url.protocol,'https:');assert.equal(url.username,'');assert.equal(url.password,'');}
 assert.doesNotMatch(email.subject,/\r|\n/);
 for(const appOrigin of ['javascript:alert(1)','http://example.com','https://name:secret@example.com'])assert.throws(()=>renderDailyEmail(f,{appOrigin}),/HTTPS/);
});

test('disabled topics never appear through sections, counts or known coverage notes',()=>{
 const f=fixture();f.notificationTopics=['school'];f.coverage.push('News: PRIVATE_NEWS_COVERAGE','Jobs: PRIVATE_JOBS_COVERAGE');
 f.emailSections.push({sectionKey:'unknown',title:'Unrecognized',items:['PRIVATE_UNKNOWN']});
 const email=renderDailyEmail(f);assert.match(email.text,/Design studio/);
 for(const text of ['Founder conversations','Product Manager','source-supported summary','PRIVATE_NEWS_COVERAGE','PRIVATE_JOBS_COVERAGE','PRIVATE_UNKNOWN','1 recent role'])assert.equal((email.html+email.text).includes(text),false,text);
});

test('empty or unselected topics guide preferences without implying an all-clear schedule',()=>{
 const f=fixture();f.notificationTopics=[];const email=renderDailyEmail(f);assert.match(email.text,/Choose which topics/);assert.doesNotMatch(email.html,/Design studio|Founder conversations|all clear/i);
 f.notificationTopics=['school'];f.emailSections=[];assert.match(renderDailyEmail(f).html,/No selected updates are available from your imported sources/);
});

test('duplicate and oversized data remain bounded with a more-in-BRB indication',()=>{
 const f=fixture();f.emailSections=[{sectionKey:'classes',items:Array.from({length:100},()=>'<&"'.repeat(3000)),total:100},{sectionKey:'classes',items:['DUPLICATE_SECTION']}];
 const email=renderDailyEmail(f);assert.ok(Buffer.byteLength(email.html)<95000);assert.ok(Buffer.byteLength(email.text)<60000);assert.match(email.text,/(?:9[4-9]|100) more in BRB/);assert.doesNotMatch(email.text,/DUPLICATE_SECTION/);
});

test('impossible or header-injected briefing dates fail before rendering',()=>{
 for(const date of ['2026-02-30','2026-11-12\r\nBcc: x@example.com','bad',null])assert.throws(()=>renderDailyEmail({...fixture(),date}),/date/);
});

test('markup expansion cannot push a multi-section email over its size budget',()=>{
 const f=fixture();f.coverage=Array.from({length:16},()=>'&'.repeat(240));
 f.emailSections=['classes','deadlines','academic','events','jobs24h','jobsWeek','news','review'].map(sectionKey=>({sectionKey,items:Array.from({length:6},()=>'https://x.co?a=&&&&&&&&&&&\n'.repeat(80)),total:6}));
 const email=renderDailyEmail(f);assert.ok(Buffer.byteLength(email.html)<95000);assert.match(email.text,/more in BRB/);
});

test('development email previews allow HTTP only on exact loopback origins',()=>{
 for(const appOrigin of ['http://localhost:4384','http://127.0.0.1:4384','http://[::1]:4384']){
  const email=renderDailyEmail(fixture(),{appOrigin}),{document}=parseHTML(email.html);
  assert.ok([...document.querySelectorAll('a')].some(anchor=>anchor.getAttribute('href')===`${appOrigin}/#overview`),appOrigin);
 }
 for(const appOrigin of ['http://example.com','http://127.1:4384','http://2130706433:4384','http://0x7f000001:4384','http://localhost.evil.test','http://localhost.','http://127.0.0.1.evil.test','http://[0:0:0:0:0:0:0:1]','http://user:pass@localhost:4384','https://user:pass@example.com','http://@localhost:4384','https:/example.com','https://example.com\\@localhost','https://example.com\n','not a URL'])assert.throws(()=>renderDailyEmail(fixture(),{appOrigin}),/BRB origin/,appOrigin);
});
