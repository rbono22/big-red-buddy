import test from 'node:test';
import assert from 'node:assert/strict';
import {parseLinkedInJobAlert,linkedinJobLinks,isLinkedInJobAlertSender} from '../lib/linkedin-job-email-parser.mjs';

const sender='LinkedIn Job Alerts <jobalerts-noreply@linkedin.com>';
const card=(id,title='Business Intelligence Analyst',company='ExampleCo',location='New York, NY')=>`${title}\n${company}\n${location}\n\n6 connections\nView job: https://www.linkedin.com/comm/jobs/view/${id}/?trackingId=private&otpToken=private`;
const parse=text=>parseLinkedInJobAlert({sender,text,subject:'You may be a fit for a role',receivedAt:'2026-11-14T15:00:00Z'});

test('parses subscribed alert cards and strips all tracking without inventing posting dates',()=>{
 const result=parse(`Your job alert for data analyst in NYC\n${card('4474587891')}\n------\n${card('4473912516','Senior Data Analyst','AnotherCo','Remote, US')}\nSee all jobs on LinkedIn: https://www.linkedin.com/jobs/search/`);
 assert.equal(result.alertName,'data analyst in NYC');assert.equal(result.jobs.length,2);
 assert.deepEqual(result.jobs[0],{externalId:'4474587891',title:'Business Intelligence Analyst',company:'ExampleCo',location:'New York, NY',url:'https://www.linkedin.com/jobs/view/4474587891'});
 assert.equal(result.jobs[1].title,'Senior Data Analyst');assert.equal(JSON.stringify(result).includes('private'),false);
 assert.equal(result.jobs.some(job=>'publishedAt' in job||'receivedAt' in job||'connections' in job),false);
});

test('deduplicates repeated cards, allowing surrounding invisible email padding',()=>{
 const result=parse(`\u034f\u200bYour job alert for analytics\u00ad\n${card('4474587891')}\n----\n${card('4474587891')}`);
 assert.equal(result.jobs.length,1);assert.equal(result.alertName,'analytics');
});

test('only a single exact alert sender address is accepted',()=>{
 for(const value of ['jobalerts-noreply@linkedin.com','"LinkedIn, Jobs" <JOBALERTS-NOREPLY@LINKEDIN.COM>'])assert.equal(isLinkedInJobAlertSender(value),true);
 for(const value of ['jobs-noreply@linkedin.com','jobalerts-noreply@linkedin.com.evil.test','xjobalerts-noreply@linkedin.com','jobalerts-noreply@linkedin.com, attacker@example.test','Attacker <x@example.test> jobalerts-noreply@linkedin.com','<jobalerts-noreply@linkedin.com> (x@example.test)','LinkedIn\r\nBcc: attacker@example.test <jobalerts-noreply@linkedin.com>','job\u200balerts-noreply@linkedin.com'])assert.equal(isLinkedInJobAlertSender(value),false,value);
 assert.deepEqual(parseLinkedInJobAlert({sender:'attacker@example.test',text:card('123456')}),{jobs:[],alertName:''});
});

test('canonical URLs allow LinkedIn jobs only and discard tracking params',()=>{
 assert.deepEqual(linkedinJobLinks('https://linkedin.com/comm/jobs/view/123456/?secret=x https://www.linkedin.com/jobs/view/growth-analyst-at-example-123456?trk=x https://www.linkedin.com/jobs/view/234567/'),['https://www.linkedin.com/jobs/view/123456','https://www.linkedin.com/jobs/view/234567']);
 const rejected=['http://www.linkedin.com/jobs/view/123456','https://linkedin.com.evil.test/jobs/view/123456','https://evil.test/?next=https%3A%2F%2Flinkedin.com%2Fjobs%2Fview%2F123456','https://user@linkedin.com/jobs/view/123456','https://www.linkedin.com:444/jobs/view/123456','https://www.linkedin.com/jobs/search/123456','https://www.linkedin.com/jobs/view/123456/extra','https://www.linkedin.com/jobs/view/0','https://www.linkedin.com/jobs/view/%31%32%33%34%35%36','https://www.linkedin.com/comm/jobs/view/123456.evil','https://www.linkedin.com/jobs/view/123456789012345678901'];
 for(const value of rejected)assert.deepEqual(linkedinJobLinks(value),[],value);
});

test('ambiguous or unrelated content does not become a job card',()=>{
 for(const text of ['Please review this message\nhttps://www.linkedin.com/jobs/view/123456','Data Analyst\nExampleCo\nView job: https://www.linkedin.com/jobs/view/123456','Extra arbitrary instructions\n'+card('123456'),'Manage your job alerts: https://www.linkedin.com/jobs/view/123456','<html><body>'+card('123456')+'</body></html>',card('123456','https://evil.test/steal'),card('123456','Analyst','x@example.test')])assert.equal(parse(text).jobs.length,0,text);
});

test('understands a bounded HTML-to-text title anchor with clear metadata',()=>{
 const result=parse('Your job alert for analytics\nData Analyst https://www.linkedin.com/jobs/view/123456\nExampleCo\nNew York, NY\nThis company is actively hiring\n------\nSenior Analyst (https://www.linkedin.com/jobs/view/234567)\nSecondCo\nRemote, US\nManage your job alerts');
 assert.deepEqual(result.jobs.map(job=>[job.externalId,job.title,job.company,job.location]),[['123456','Data Analyst','ExampleCo','New York, NY'],['234567','Senior Analyst','SecondCo','Remote, US']]);
 assert.equal(parse('Data Analyst https://www.linkedin.com/jobs/view/123456\nExampleCo\nNew York, NY\nExtra metadata of unknown meaning').jobs.length,0);
});

test('title anchors and trailing View job links produce one card',()=>{
 const result=parse('Your job alert for analytics\nData Analyst https://www.linkedin.com/jobs/view/123456\nExampleCo\nNew York, NY\nView job: https://www.linkedin.com/jobs/view/123456');
 assert.equal(result.jobs.length,1);assert.equal(result.jobs[0].title,'Data Analyst');
});

test('supports View job label on a separate line and rejects crossed card links',()=>{
 assert.equal(parse(card('123456').replace('View job: ','View job\n')).jobs.length,1);
 assert.equal(parse('Analyst https://www.linkedin.com/jobs/view/123456\nExampleCo\nNew York, NY\nView job: https://www.linkedin.com/jobs/view/234567').jobs.some(job=>job.externalId==='234567'),false);
});

test('bounds input, number of roles, and field sizes',()=>{
 assert.equal(parse('x'.repeat(40001)).jobs.length,0);
 assert.equal(parse(Array.from({length:25},(_,i)=>card(String(123456+i))).join('\n----\n')).jobs.length,20);
 assert.equal(linkedinJobLinks(Array.from({length:25},(_,i)=>`https://linkedin.com/jobs/view/${123456+i}`).join(' ')).length,20);
 for(const text of [card('123456','T'.repeat(241)),card('123456','Analyst','C'.repeat(161)),card('123456','Analyst','ExampleCo','L'.repeat(241))])assert.equal(parse(text).jobs.length,0);
});
