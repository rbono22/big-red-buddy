import test from 'node:test';
import assert from 'node:assert/strict';
import {savedDemographicSuggestion as suggest} from '../lib/application-suggestions.mjs';
const field=(label,options,extra={})=>({label,options,type:'select',...extra});
const saved=values=>({values,revision:'r4.p1'});
test('Saved preferences are unreviewed suggestions and leave inputs unchanged',()=>{
 const f=field('Gender',['Male','Female','Non-binary','Prefer not to answer']),d=saved({gender:'male'}),original=structuredClone({f,d});
 const result=suggest(f,d);assert.equal(result.value,'Male');assert.equal(result.reviewed,false);assert.equal(result.source,'saved demographic preference');assert.equal(result.preferenceRevision,'r4.p1');assert.deepEqual({f,d},original);
});
test('Gender never supplies sex, sex at birth, pronouns, transgender status or medical questions',()=>{
 for(const label of ['Sex','Sex assigned at birth','Gender assigned at birth','Biological sex','Pronouns','Are you transgender','Gender or sex'])assert.equal(suggest(field(label,['Male','Female']),saved({gender:'male'})),null,label);
 assert.equal(suggest(field('Gender',['Non-binary / gender non-conforming']),saved({gender:'non_binary'})),null);
 assert.equal(suggest(field('Gender',['Other']),saved({gender:'other'})),null);
});
test('Veteran and protected veteran preferences are separate, including generic employer headings',()=>{
 const d=saved({veteranStatus:'veteran',protectedVeteranStatus:'not_protected'});
 assert.equal(suggest(field('Veteran status',['Veteran','Not a veteran']),d).value,'Veteran');
 assert.equal(suggest(field('Protected veteran status',['I am a protected veteran','I am not a protected veteran']),d).value,'I am not a protected veteran');
 assert.equal(suggest(field('Veteran status',['I am a protected veteran','I am not a protected veteran','Prefer not to answer']),d).value,'I am not a protected veteran');
 assert.equal(suggest(field('Protected veteran status',['Yes','No']),saved({veteranStatus:'veteran'})),null);
 assert.equal(suggest(field('Veteran status',['I am a protected veteran','I am not a protected veteran']),saved({veteranStatus:'non_veteran'})),null);
 assert.equal(suggest(field('Veteran status',['Disabled veteran','Recently separated veteran','Other protected veteran']),saved({protectedVeteranStatus:'protected'})),null);
});
test('Disability history is not a current disability diagnosis or specific disability',()=>{
 const d=saved({disabilityStatus:'yes'});
 assert.equal(suggest(field('Disability status',['Yes, I have a disability, or have had one in the past','No','Prefer not to answer']),d).value,'Yes, I have a disability, or have had one in the past');
 for(const label of ['Do you currently have a disability','Are you disabled','Which disability do you have','Do you need accommodations'])assert.equal(suggest(field(label,['Yes','No']),d),null);
 assert.equal(suggest(field('Disability status',['Yes, I have a disability','No']),d),null);
 assert.equal(suggest(field('Disability status',['Yes','No']),d),null);
 assert.equal(suggest(field('Do you have a disability or a history of one?',['Yes','No']),d).value,'Yes');
});
test('Race and ethnicity stay separate; combined or qualified options are not inferred',()=>{
 assert.equal(suggest(field('Are you Hispanic or Latino?',['Yes','No']),saved({ethnicity:'hispanic'})).value,'Yes');
 assert.equal(suggest(field('Ethnicity',['Hispanic or Latino','Not Hispanic or Latino']),saved({ethnicity:'not_hispanic'})).value,'Not Hispanic or Latino');
 assert.equal(suggest(field('Are you Hispanic or Latino?',['Yes','No']),saved({race:['white']})),null);
 assert.equal(suggest(field('Race / ethnicity',['White','Hispanic or Latino']),saved({race:['white'],ethnicity:'hispanic'})),null);
 assert.equal(suggest(field('Race',['White (Not Hispanic or Latino)']),saved({race:['white'],ethnicity:'not_hispanic'})),null);
 assert.equal(suggest(field('Race',['Asian or Pacific Islander']),saved({race:['asian']})),null);
 assert.equal(suggest(field('Ethnicity',['Yes','No']),saved({ethnicity:'hispanic'})),null);
});
test('Multiple race categories require a matching multiple-choice control without dropping selections',()=>{
 const d=saved({race:['white','asian']});
 const result=suggest(field('Race',['Asian','Black or African American','White'],{multiple:true}),d);assert.equal(result.value,'Asian\nWhite');assert.equal(result.reviewed,false);
 assert.equal(suggest(field('Race',['Asian','White','Two or more races']),d),null);
 assert.equal(suggest(field('Race',['White'],{multiple:true}),d),null);
 assert.equal(suggest(field('Race',['Asian','White'],{multiple:true}),saved({race:['white','decline']})),null);
 assert.equal(suggest(field('Race',['Another category']),saved({race:['other']})),null);
 for(const value of ['__proto__','constructor','prototype',null])assert.equal(suggest(field('Race',['White']),saved({race:[value]})),null);
});
test('Explicit declines can be suggested; skips, missing or ambiguous choices never become declines',()=>{
 assert.equal(suggest(field('Gender',['Male','Female',"I don't wish to answer"]),saved({gender:'decline'})).value,"I don't wish to answer");
 assert.equal(suggest(field('Race',['White','Decline to self-identify'],{multiple:true}),saved({race:['decline']})).value,'Decline to self-identify');
 for(const value of ['unanswered','unknown',undefined])assert.equal(suggest(field('Gender',['Male','Prefer not to answer']),saved({gender:value})),null);
 assert.equal(suggest(field('Gender',['Male','Man']),saved({gender:'male'})),null);
 assert.equal(suggest(field('Gender',['Male','male']),saved({gender:'male'})),null);
 assert.equal(suggest(field('Gender',['Male']),{gender:'male'}),null);
});
test('Only recognized choice questions read saved enums, with no model or resume inference',()=>{
 assert.equal(suggest(field('Are you authorized to work in the US?',['Yes','No']),saved({gender:'male',veteranStatus:'veteran'})),null);
 assert.equal(suggest(field('Gender',['Male'],{type:'textarea'}),saved({gender:'male'})),null);
 assert.equal(suggest(field('Gender',['Male'],{multiple:true}),saved({gender:'male'})),null);
 assert.equal(suggest(field('Gender',['Male']),saved({resume:'Male, US citizen'})),null);
});
