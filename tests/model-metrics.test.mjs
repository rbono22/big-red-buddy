import test from 'node:test';
import assert from 'node:assert/strict';
import {modelTimingMetrics,studentMetrics} from '../lib/metrics.mjs';

test('timing summaries exclude invalid values and never return student content',()=>{
 const result=modelTimingMetrics([{profile:'chat',ms:4000,providerTotalMs:3990,loadMs:3000,promptMs:100,generationMs:890,outputTokensPerSecond:45,prompt:'PRIVATE_SOURCE',answer:'PRIVATE_ANSWER'},{profile:'chat',ms:800,providerTotalMs:790,loadMs:5,promptMs:90,generationMs:695,outputTokensPerSecond:47},{profile:'PRIVATE_PROFILE',ms:500,loadMs:'500',generationMs:Infinity,promptMs:-1}]);
 assert.equal(result.samples,2);assert.equal(result.loadP95Ms,3000);assert.equal(result.loadP50Ms,5);
 assert.equal(result.promptP95Ms,100);assert.equal(result.generationP95Ms,890);
 assert.deepEqual(result.profiles,[{profile:'chat',runs:2,latencyP95Ms:4000}]);
 assert.doesNotMatch(JSON.stringify(result),/PRIVATE/);
 assert.equal(modelTimingMetrics([{ms:2}]).loadP95Ms,null,'legacy runs do not look like zero-millisecond loads');
});
test('student metrics include only the selected student’s recent model timings',async()=>{
 const rows={alice:[{at:new Date().toISOString(),profile:'summary',ms:50,providerTotalMs:45,loadMs:2},{at:'2020-01-01',profile:'chat',ms:9999,loadMs:9999}],bob:[{at:new Date().toISOString(),profile:'review',ms:5000,loadMs:4000}]};
 const database={forUser:id=>({all:async bucket=>bucket==='metrics'?rows[id]:[]})},queue={metrics:async id=>({user:id})};
 const result=await studentMetrics(database,queue,'alice');
 assert.equal(result.model.runs,1);assert.equal(result.model.timing.loadP95Ms,2);
 assert.deepEqual(result.model.timing.profiles,[{profile:'summary',runs:1,latencyP95Ms:50}]);
 assert.equal(result.queue.user,'alice');assert.doesNotMatch(JSON.stringify(result),/bob|review|9999|4000/);
});
