import test from 'node:test';
import assert from 'node:assert/strict';
import {lookupSocialEvent,parseSocialEventHTML,socialEventURL} from '../lib/social-event-metadata.mjs';

const URL='https://luma.com/test-event';
const event=(patch={})=>({'@context':'https://schema.org','@type':'Event',url:URL,'@id':URL,name:'Campus founder conversation',startDate:'2026-11-12T19:00:00-05:00',endDate:'2026-11-12T20:00:00-05:00',eventStatus:'https://schema.org/EventScheduled',location:{'@type':'Place',name:'Campus Hall',address:{streetAddress:'1 College Street',addressLocality:'Ithaca',addressRegion:'New York'}},...patch});
const html=value=>`<html><head><script type="application/ld+json">${JSON.stringify(value)}</script></head></html>`;
const response=(body,options={})=>new Response(body,{status:200,headers:{'Content-Type':'text/html'},...options});

test('public structured event requires exact registration identity and retains only bounded supporting calendar fields',()=>{
 const result=parseSocialEventHTML(html(event({description:'UNRELATED_PRIVATE_DESCRIPTION',organizer:{name:'UNRELATED_PRIVATE_ORGANIZER'}})),URL);
 assert.equal(result.verified,true);assert.deepEqual(result.warnings,[]);
 assert.equal(result.event.date,'2026-11-12');assert.equal(result.event.time,'19:00');assert.equal(result.event.start,'2026-11-13T00:00:00.000Z');assert.equal(result.event.end,'2026-11-13T01:00:00.000Z');
 assert.equal(result.event.status,'review');assert.equal(result.event.sourceProvider,'luma');assert.match(result.event.location,/Ithaca/);
 assert.doesNotMatch(JSON.stringify(result),/UNRELATED_PRIVATE/);
 assert.equal(parseSocialEventHTML(html(event({url:'https://luma.com/related','@id':'https://luma.com/related'})),URL).event,null);
 assert.equal(parseSocialEventHTML(html(event({url:undefined,'@id':undefined})),URL).event,null);
 assert.equal(parseSocialEventHTML(html(event({url:URL,'@id':'https://luma.com/other'})),URL).event,null);
});

test('Partiful event in a graph normalizes UTC times across midnight and carries its canonical RSVP link',()=>{
 const link='https://partiful.com/e/PublicEvent123',record=event({url:link,'@id':undefined,startDate:'2026-11-13T01:00:00.000Z',endDate:'2026-11-13T04:00:00.000Z'});
 const result=parseSocialEventHTML(html({'@context':'https://schema.org','@graph':[{'@type':'Organization',name:'Campus'},record]}),link+'?tracking=discard#fragment');
 assert.equal(result.verified,true);assert.equal(result.event.sourceProvider,'partiful');assert.equal(result.event.rsvpUrl,link);assert.equal(result.event.date,'2026-11-12');assert.equal(result.event.time,'20:00');
 assert.equal(result.event.end,'2026-11-13T04:00:00.000Z');
});

test('ambiguous, malformed, oversized, deeply nested or mismatched canonical metadata fails closed',()=>{
 for(const body of [html([event(),event()]),html(event())+'<script type="application/ld+json">{broken</script>',html(event())+'<link rel="canonical" href="https://luma.com/another">','x'.repeat(1_000_001),html(event({name:'x'.repeat(256_000)}))])assert.equal(parseSocialEventHTML(body,URL).verified,false);
 let nested=event();for(let i=0;i<20;i++)nested={'@graph':[nested]};assert.equal(parseSocialEventHTML(html(nested),URL).event,null);
});

test('unknown timezone, invalid calendar dates, unsupported dates and incomplete endpoints are never autoeligible',()=>{
 for(const startDate of ['2026-11-12T19:00:00','2026-02-30T19:00:00Z','2026-11-12T25:00:00Z','2026-11-12T19:00:00-00:00','2026-11-12T19:00:00+15:00','2026-11-12','next Thursday'])assert.equal(parseSocialEventHTML(html(event({startDate})),URL).event,null,startDate);
 for(const endDate of [undefined,'2026-11-12T19:00:00-05:00','2026-11-12T17:00:00-05:00','2027-01-01T20:00:00-05:00','2026-11-12T20:00:00']){const result=parseSocialEventHTML(html(event({endDate})),URL);assert.equal(result.verified,false);assert.equal(result.event.end,null);assert.match(result.warnings.join(' '),/end time/);}
 const missingPlace=parseSocialEventHTML(html(event({location:undefined})),URL);assert.equal(missingPlace.verified,false);assert.match(missingPlace.warnings.join(' '),/location/);
 for(const location of ['TBD','Sign in to see location',{name:'Private location'}])assert.equal(parseSocialEventHTML(html(event({location})),URL).verified,false);
});

test('supporting structured evidence is bounded and does not retain unrelated location fields',()=>{
 const result=parseSocialEventHTML(html(event({name:'A'.repeat(2000),location:{name:'Campus Hall',address:{streetAddress:'1 College Street',privateContact:'DO_NOT_RETAIN'}}})),URL);
 assert.equal(result.verified,true);assert.ok(result.event.evidence.length<2400);assert.doesNotMatch(result.event.evidence,/DO_NOT_RETAIN/);assert.equal(JSON.parse(result.event.evidence).startDate,'2026-11-12T19:00:00-05:00');
});

test('cancelled, postponed, rescheduled and missing status retain review details without automatic eligibility',()=>{
 for(const status of ['EventCancelled','EventPostponed','EventRescheduled',undefined,'UnrecognizedStatus']){
  const result=parseSocialEventHTML(html(event({eventStatus:status?`https://schema.org/${status}`:undefined})),URL);assert.equal(result.verified,false);assert.equal(result.event.status,'review');assert.equal(result.event.evidenceVerified,false);assert.equal(result.event.cancelled,status==='EventCancelled');assert.ok(result.warnings.length);
 }
});

test('direct URL policy rejects credentials, non-HTTPS, local targets, arbitrary routes and embedded link text without fetching',async()=>{
 let calls=0;const fetchImpl=async()=>{calls++;return response(html(event()));};
 for(const url of ['http://luma.com/test-event','https://127.0.0.1/event','https://luma.com@127.0.0.1/event','https://name:password@luma.com/test-event','https://luma.com:444/test-event','https://luma.com/login','https://luma.com/api/event','https://luma.com/%2e%2e/api','https://partiful.com/u/user','Look here: https://luma.com/test-event','https://luma.com/test-event https://example.com','https://luma.com.evil.test/event','https://luma.com\\@evil.test/event']){
  assert.equal(socialEventURL(url),'',url);assert.equal((await lookupSocialEvent(url,{fetchImpl})).verified,false,url);
 }
 assert.equal(calls,0);
});

test('fetch only sends canonical public GET with no credentials or tracking tokens',async()=>{
 const calls=[];const result=await lookupSocialEvent(URL+'?token=PRIVATE_TOKEN&utm=email#details',{fetchImpl:async(url,options)=>{calls.push({url,options});return response(html(event()));}});
 assert.equal(result.verified,true);assert.equal(calls.length,1);assert.equal(calls[0].url,URL);assert.equal(calls[0].options.method,'GET');assert.equal(calls[0].options.credentials,'omit');assert.equal(calls[0].options.redirect,'manual');assert.deepEqual(calls[0].options.headers,{Accept:'text/html'});assert.ok(calls[0].options.signal instanceof AbortSignal);
 assert.doesNotMatch(JSON.stringify(result),/PRIVATE_TOKEN/);
});

test('only the same lu.ma/luma.com event alias can redirect and loops are bounded',async()=>{
 const calls=[];const result=await lookupSocialEvent('https://lu.ma/test-event',{fetchImpl:async url=>{calls.push(url);return calls.length===1?response('',{status:302,headers:{Location:URL}}):response(html(event()));}});
 assert.equal(result.verified,true);assert.deepEqual(calls,['https://lu.ma/test-event',URL]);
 for(const target of ['http://luma.com/test-event','https://127.0.0.1/secret','https://evil.example/secret','https://luma.com/login','https://luma.com/other','https://partiful.com/e/test-event']){
  let n=0;const result=await lookupSocialEvent(URL,{fetchImpl:async()=>{n++;return response('',{status:302,headers:{Location:target}});}});assert.equal(result.verified,false);assert.equal(n,1,target);
 }
 let n=0;const loop=await lookupSocialEvent(URL,{fetchImpl:async url=>{n++;return response('',{status:302,headers:{Location:url.startsWith('https://luma.com')?'https://lu.ma/test-event':URL}});}});assert.equal(loop.verified,false);assert.equal(n,2);
});

test('private, non-HTML, provider errors, oversize headers/body and network failures return safe warnings',async()=>{
 const responses=[()=>response('PRIVATE',{status:403}),()=>response('SECRET_JSON',{headers:{'Content-Type':'application/json'}}),()=>response(html(event()),{headers:{'Content-Type':'text/html','Content-Length':'1000001'}}),()=>response('x'.repeat(1_000_001)),()=>{throw new Error('PRIVATE_PROVIDER_ERROR');}];
 for(const make of responses){const result=await lookupSocialEvent(URL,{fetchImpl:async()=>make()});assert.equal(result.verified,false);assert.equal(result.event,null);assert.doesNotMatch(JSON.stringify(result),/PRIVATE|SECRET_JSON/);}
});
