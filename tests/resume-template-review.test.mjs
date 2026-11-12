import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openDatabase} from '../lib/database.mjs';
import {reviewResume} from '../lib/career.mjs';
import {resumeReviewTemplate,resumeTemplateContext,compareResumeFormat} from '../lib/resume-template.mjs';

const TEXT='Alex Example\nalex@example.edu\nEDUCATION\nCornell Tech graduate student.\nPROFESSIONAL EXPERIENCE\nBuilt an inventory forecasting tool using Python.\nReduced processing time by 20%.\nPROJECTS\nInterviewed student users about a scheduling prototype.\nADDITIONAL INFORMATION\nEnjoys hiking.';
const measured={status:'measured',pageCount:1,pages:[{widthPt:612,heightPt:792,marginsPt:{left:36,right:36,top:54,bottom:200}}],fonts:[{family:'Calibri',sizePt:12,count:10}],limitations:['Synthetic PDF measurement fixture.']};
async function fixture(t){const dir=await mkdtemp(path.join(tmpdir(),'brf-template-review-')),db=await openDatabase({dataDir:dir,databaseUrl:null,production:false}),store=db.forUser('student');t.after(async()=>{await db.close();await rm(dir,{recursive:true,force:true});});const resume={name:'Synthetic.pdf',text:TEXT,file:'synthetic-pdf-not-for-model',updatedAt:'2026-11-10T12:00:00Z'};await store.put('documents','resume',resume);return {db,store,resume};}
const model=()=>({value:{summary:'Focus each bullet on your action and its supported purpose.',suggestions:[{original:'Built an inventory forecasting tool using Python.',suggested:'Built a Python tool for inventory forecasting.',reason:'Makes the tool and purpose easier to scan.',category:'clarity',priority:'high',needsConfirmation:['What outcome did the tool produce, if you measured one?']}],facts:{},gaps:[]}});

test('supplied reference uses visible Calibri text and distinguishes observed layout from mandatory policy',()=>{
 const template=resumeReviewTemplate(),context=resumeTemplateContext();assert.equal(template.id,'jct-mba-resume-2026-2027');assert.match(template.sourceSha256,/^[a-f0-9]{64}$/);assert.match(template.styleGuide.find(rule=>rule.label==='Text').value,/Calibri 12 pt/);assert.deepEqual(template.sectionOrder,['Education','Technical Proficiency','Professional Experience','Projects','Additional Information']);assert.match(template.note,/not a claim about current Cornell requirements/);assert.ok(context.rules.some(rule=>rule.basis==='explicit'));assert.ok(context.rules.some(rule=>rule.basis==='observed'));assert.doesNotMatch(JSON.stringify(template),/\/Users\//);
});
test('format checks use PDF evidence without treating trailing whitespace or unseen visual styling as an error',()=>{
 const result=compareResumeFormat(TEXT,measured);assert.equal(result.status,'measured');assert.equal(result.checks.find(check=>check.id==='text-bounds').status,'aligned');assert.equal(result.checks.find(check=>check.id==='font-size').status,'aligned');assert.equal(result.checks.find(check=>check.id==='section-order').status,'aligned');assert.equal(result.checks.find(check=>check.id==='heading-alignment').status,'check');assert.match(result.limitations.join(' '),/do not certify/);
 const different=compareResumeFormat(TEXT,{...measured,pageCount:2,fonts:[{family:'Arial',sizePt:9,count:10}],pages:[{widthPt:595,heightPt:842,marginsPt:{left:10,right:36,top:54,bottom:200}}]});for(const id of ['page-count','page-size','font-size','font-family','text-bounds'])assert.equal(different.checks.find(check=>check.id===id).status,'suggestion');
});
test('unavailable text geometry retains known page count and never invents font, spacing, or margin measurements',()=>{
 const result=compareResumeFormat(TEXT,{status:'unavailable',pageCount:1,limitations:['Scanned PDF.']});assert.equal(result.status,'partial');assert.equal(result.checks.find(check=>check.id==='page-count').basis,'measured');assert.equal(result.checks.find(check=>check.id==='font-family').status,'check');assert.equal(result.checks.some(check=>check.id==='text-bounds'),false);assert.match(result.limitations.join(' '),/Scanned PDF/);
});
test('template-aware review improves wording and asks factual questions without changing the original or consulting private declarations',async t=>{
 const {db,store,resume}=await fixture(t);await store.put('career','demographics',{values:{gender:'PRIVATE_GENDER'}});await store.put('career','profile',{fullName:'PRIVATE_PROFILE'});let prompt;
 const result=await reviewResume(store,{inspectLayout:async()=>measured,generate:async value=>{prompt=value;return model();}});
 assert.match(prompt,/TEMPLATE_REFERENCE/);assert.match(prompt,/Calibri/);assert.match(prompt,/never turn assisted into led/);assert.doesNotMatch(prompt,/synthetic-pdf-not-for-model|PRIVATE_GENDER|PRIVATE_PROFILE/);assert.equal(result.template.id,'jct-mba-resume-2026-2027');assert.equal(result.formatReview.status,'measured');assert.equal(result.suggestions[0].category,'clarity');assert.equal(result.suggestions[0].priority,'high');assert.match(result.suggestions[0].needsConfirmation[0],/outcome/);assert.equal(result.suggestions[0].evidenceVerified,true);assert.deepEqual(await store.get('documents','resume'),resume);assert.equal(await db.forUser('other').get('career','resumeReview'),null);assert.equal(result.source.file,undefined);assert.match(result.note,/rewritten claims still require your confirmation/);
});
test('unsupported passages, invented or changed quantities, placeholders, and sensitive rewrites are omitted',async t=>{
 const {store}=await fixture(t),response=model();response.value.suggestions.push(
  {original:'Managed hundreds of employees.',suggested:'Led a large team.',reason:'Leadership.'},
  {original:'Built an inventory forecasting tool using Python.',suggested:'Built a Python tool that saved 50% of costs.',reason:'More impact.'},
  {original:'Reduced processing time by 20%.',suggested:'Reduced processing time by 20 million.',reason:'Changed units.'},
  {original:'Built an inventory forecasting tool using Python.',suggested:'Built a Python tool with [insert savings] impact.',reason:'Add a metric.'},
  {original:'Cornell Tech graduate student.',suggested:'Cornell Tech graduate student and US citizen.',reason:'Eligibility.'},
  {original:'Reduced processing time by 20%.',suggested:'Cut processing time by 20%.',reason:'More direct wording.',category:'impact'}
 );const result=await reviewResume(store,{inspectLayout:async()=>measured,generate:async()=>response});assert.equal(result.suggestions.length,2);assert.ok(result.suggestions.some(s=>s.suggested==='Cut processing time by 20%.'));assert.doesNotMatch(JSON.stringify(result.suggestions),/50%|million|citizen|insert savings|large team/);assert.ok(result.gaps.some(gap=>/numeric claim/.test(gap)));assert.ok(result.gaps.some(gap=>/matching resume passage/.test(gap)));assert.ok(result.gaps.some(gap=>/placeholder/.test(gap)));
});
test('AI formatting commentary needs both a real template rule and exact source excerpt and cannot override measured checks',async t=>{
 const {store}=await fixture(t),response=model(),rule=resumeTemplateContext().rules[0];response.value.formatting=[{ruleId:rule.id,original:'EDUCATION',recommendation:'Keep the education heading visually distinct.'},{ruleId:'invented-rule',original:'EDUCATION',recommendation:'Use rainbow headings.'},{ruleId:rule.id,original:'A heading not in the resume.',recommendation:'Use this format.'}];response.value.formatReview={status:'measured',checks:[{label:'Invented visual inspection'}]};
 const result=await reviewResume(store,{inspectLayout:async()=>measured,generate:async()=>response}),added=result.formatReview.checks.filter(check=>check.aiSuggested);assert.equal(added.length,1);assert.equal(added[0].basis,'text');assert.equal(added[0].status,'check');assert.equal(added[0].recommendation,rule.guidance.slice(0,700));assert.doesNotMatch(JSON.stringify(result.formatReview),/rainbow|Invented visual inspection/);
});
test('font families and sizes aggregate independently and split section headings are recognized',()=>{
 const result=compareResumeFormat(TEXT.replace('PROFESSIONAL EXPERIENCE','TECHNICAL\nPROFICIENCY\nPython\nPROFESSIONAL\nEXPERIENCE'),{...measured,fonts:[{family:'Arial',sizePt:12,count:6},{family:'Calibri',sizePt:11,count:5},{family:'Calibri-Bold',sizePt:12,count:5}]});assert.equal(result.checks.find(check=>check.id==='font-family').status,'aligned');assert.equal(result.checks.find(check=>check.id==='font-size').status,'aligned');const sections=result.checks.find(check=>check.id==='section-order');assert.equal(sections.status,'aligned');assert.match(sections.observed,/Technical Proficiency → Professional Experience/);
});
test('model-generated mandates and guarantees cannot replace actual reference guidance',async t=>{
 const {store}=await fixture(t),response=model(),rule=resumeTemplateContext().rules.find(rule=>rule.id==='font')||resumeTemplateContext().rules[0];response.value.summary='This resume is certified Cornell compliant and guarantees interviews.';response.value.formatting=[{ruleId:rule.id,original:'EDUCATION',recommendation:'Cornell requires 10 pt Times New Roman.'}];const result=await reviewResume(store,{inspectLayout:async()=>measured,generate:async()=>response});assert.equal(result.summary,'Review the supported edits and template comparison below.');assert.equal(result.formatReview.checks.find(check=>check.aiSuggested).recommendation,rule.guidance.slice(0,700));assert.doesNotMatch(JSON.stringify(result.formatReview),/Cornell requires|Times New Roman/);
});
test('signed, spelled-out, reordered, and duplicated numeric claims are held back',async t=>{
 const {store,resume}=await fixture(t);await store.put('documents','resume',{...resume,text:TEXT+'\nRecorded a -20% change.\nDelivered 10 projects across 5 teams.'});const response=model();response.value.suggestions=[{original:'Recorded a -20% change.',suggested:'Recorded a 20% change.',reason:'Concise.'},{original:'Delivered 10 projects across 5 teams.',suggested:'Delivered fifty projects across 5 teams.',reason:'More impact.'},{original:'Delivered 10 projects across 5 teams.',suggested:'Delivered 5 projects across 10 teams.',reason:'Reordered.'},{original:'Reduced processing time by 20%.',suggested:'Reduced processing time by 20% and costs by 20%.',reason:'Added result.'}];const result=await reviewResume(store,{inspectLayout:async()=>measured,generate:async()=>response});assert.equal(result.suggestions.length,0);assert.match(result.note,/do not establish.*same meaning or units/);
});
test('PDF replacement with unchanged text and timestamp still invalidates a pending format review',async t=>{
 const {store,resume}=await fixture(t);let calls=0;await assert.rejects(reviewResume(store,{inspectLayout:async()=>{await store.put('documents','resume',{...resume,file:'replacement-pdf'});return measured;},generate:async()=>{calls++;return model();}}),{status:409});assert.equal(calls,0);assert.equal(await store.get('career','resumeReview'),null);
});
test('layout processing failure leaves writing review usable and limitations explicit',async t=>{
 const {store}=await fixture(t);const result=await reviewResume(store,{inspectLayout:async()=>{throw new Error('PRIVATE_PROCESS_PATH');},generate:async()=>model()});assert.equal(result.suggestions.length,1);assert.equal(result.formatReview.status,'partial');assert.match(result.formatReview.limitations.join(' '),/unavailable/);assert.doesNotMatch(JSON.stringify(result),/PRIVATE_PROCESS_PATH/);
});
