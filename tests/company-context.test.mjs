import test from 'node:test';
import assert from 'node:assert/strict';
import {officialCompanyContext,companyContextText} from '../lib/company-context.mjs';

const NOW=Date.parse('2026-11-13T04:00:00.000Z');
test('only exact known employers receive bounded attributed official context',()=>{
 for(const [name,canonical,host] of [['  SPLUNK  ','Splunk','careers.cisco.com'],['Ramp','Ramp','ramp.com'],['Stripe Inc.','Stripe','stripe.com']]){
  const context=officialCompanyContext(name,{now:NOW});assert.equal(context.company,canonical);assert.ok(context.sources.length>0);
  for(const source of context.sources){assert.equal(new URL(source.url).hostname,host);assert.ok(Date.parse(source.checkedAt)<=NOW);assert.ok(source.summaries.every(summary=>summary.length>=20&&summary.length<400));}
  assert.ok(companyContextText(context).length<2000);
 }
});
test('similar names, sibling companies and source mismatches receive no cached claims',()=>{
 for(const name of ['Ramp Network','OnRamp','Stripey','Blue Stripe','Splunk Labs','Cisco','Ramp / Splunk','Stripe and Ramp',{},null,''])assert.equal(officialCompanyContext(name,{now:NOW}),null);
 const ramp=companyContextText(officialCompanyContext('Ramp',{now:NOW}));assert.doesNotMatch(ramp,/Splunk|Stripe|cisco\.com|stripe\.com/);
});
test('future-dated or expired snapshots are excluded and callers cannot change the cache',()=>{
 assert.equal(officialCompanyContext('Ramp',{now:Date.parse('2026-01-01T00:00:00Z')}),null);
 assert.equal(officialCompanyContext('Ramp',{now:Date.parse('2027-06-01T00:00:00Z')}),null);
 assert.equal(officialCompanyContext('Ramp',{now:NaN}),null);
 const context=officialCompanyContext('Ramp',{now:NOW});context.sources[0].summaries[0]='Tampered';assert.notEqual(officialCompanyContext('Ramp',{now:NOW}).sources[0].summaries[0],'Tampered');assert.equal(companyContextText(null),'');
});
