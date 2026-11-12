import test from 'node:test';
import assert from 'node:assert/strict';
import {jobApplicationURL,jobApplicationLink} from '../lib/job-messages.mjs';
test('application links preserve source query and prefer the application URL',()=>{
 const url='https://job-boards.greenhouse.io/reddit/jobs/8023563?gh_src=ullc7kwv1us';
 assert.equal(jobApplicationURL({applyUrl:url,url:'https://example.com/jobs'}),url);
 assert.match(jobApplicationLink({url}),/opens in your browser/);
});
test('unsafe or missing links are omitted without fabricating an application endpoint',()=>{
 for(const url of ['javascript:alert(1)','file:///etc/passwd','http://example.com','https://u:p@example.com','https://localhost/x','https://127.0.0.1/x','https://[::1]/x','https://host.internal/x','https://example.com:8443/x','https://example.com/\nwrong'])assert.equal(jobApplicationURL({applyUrl:url}),'');
 assert.equal(jobApplicationURL({applyUrl:'javascript:bad',url:'https://example.com/job'}),'https://example.com/job');
 assert.match(jobApplicationLink({}),/No usable application link/);
});
