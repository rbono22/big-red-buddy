import test from 'node:test';
import assert from 'node:assert/strict';
import {employmentProfileField,savedEmploymentProfileAnswer} from '../lib/application-profile-choices.mjs';
import {quickApplicationAnswers} from '../lib/live-applications.mjs';

const authorization={key:'lever_custom_auth',label:'Are you legally authorized to work in the United States?',type:'radio',required:false,options:['Yes','No']};
const sponsorship={key:'lever_custom_sponsor',label:'Will you now or in the future require sponsorship for employment visa status',type:'radio',required:false,options:['Yes','No','Not Applicable']};
test('custom employer choices reuse explicit profile facts without requiring provider-specific control names',()=>{
 const profile={workAuthorizationUS:'yes',sponsorship:'no'};
 assert.equal(employmentProfileField(authorization),'workAuthorizationUS');assert.equal(employmentProfileField(sponsorship),'sponsorship');
 const prepared=quickApplicationAnswers({fields:[authorization,sponsorship]},profile,'Resume.pdf');
 assert.equal(prepared.answers[authorization.key].value,'Yes');assert.equal(prepared.answers[sponsorship.key].value,'No');assert.deepEqual(prepared.missing,[]);
 assert.equal(savedEmploymentProfileAnswer({...sponsorship,type:'select'},profile),'No');
 for(const value of [undefined,'','unanswered','probably',false])assert.equal(savedEmploymentProfileAnswer(sponsorship,{sponsorship:value}),null);
});
test('saved eligibility never answers a different country, time horizon, negative, combined or certification question',()=>{
 const profile={workAuthorizationUS:'yes',sponsorship:'no'};
 const changed=[
  {...authorization,label:'Are you legally authorized to work in Canada?'},
  {...authorization,label:'Are you legally authorized to work in the United Kingdom?'},
  {...authorization,label:'Will you be legally authorized to work in the United States?'},
  {...authorization,label:'Are you not legally authorized to work in the United States?'},
  {...authorization,label:authorization.label+' And can you relocate?'},
  {...authorization,label:'I certify that I am legally authorized to work in the United States'},
  {...sponsorship,label:'Do you currently require sponsorship for employment visa status'},
  {...sponsorship,label:'Do you require a transfer of existing visa sponsorship?'},
  {...sponsorship,label:'Will you now or in the future require sponsorship for employment visa status in Canada'},
  {...authorization,type:'checkbox'},
  {...authorization,multiple:true},
  {...authorization,profileField:'sponsorship'},
  {...authorization,options:['Yes','yes ','No']},
  {...authorization,options:['Yes, without restrictions','No']},
  {...sponsorship,options:['Yes','Not Applicable']}
 ];
 for(const field of changed){assert.equal(savedEmploymentProfileAnswer(field,profile),null,field.label);assert.equal(quickApplicationAnswers({fields:[field]},profile,'Resume.pdf').answers[field.key].value,null,field.label);}
});
