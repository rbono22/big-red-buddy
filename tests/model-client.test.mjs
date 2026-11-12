import test from 'node:test';
import assert from 'node:assert/strict';
import {modelJSON,MODEL_PROFILES,MODEL_LIMITS} from '../lib/model-client.mjs';

const complete=(value={answer:'Synthetic response'},extra={})=>({done:true,done_reason:'stop',message:{role:'assistant',content:JSON.stringify(value)},prompt_eval_count:80,eval_count:20,load_duration:1000000,prompt_eval_duration:3000000,eval_duration:1000000000,total_duration:1004000000,...extra});
function fixture(t,handler){
  const prior={fetch:globalThis.fetch,url:process.env.OLLAMA_URL,model:process.env.OLLAMA_MODEL};
  process.env.OLLAMA_URL='http://127.0.0.1:11434';process.env.OLLAMA_MODEL='synthetic-local';
  globalThis.fetch=handler;
  t.after(()=>{globalThis.fetch=prior.fetch;for(const [key,value] of [['OLLAMA_URL',prior.url],['OLLAMA_MODEL',prior.model]])if(value===undefined)delete process.env[key];else process.env[key]=value;});
}
test('task profiles preserve context capacity and reduce short-answer generation budgets without caller-selected models',async t=>{
  const calls=[];fixture(t,async(url,request)=>{calls.push({url,request,body:JSON.parse(request.body)});return Response.json(complete());});
  for(const profile of Object.keys(MODEL_PROFILES)){
    const result=await modelJSON('SYNTHETIC ONLY',{profile,model:'attacker-cloud',url:'https://untrusted.example'}),call=calls.at(-1);
    assert.equal(call.url,'http://127.0.0.1:11434/api/chat');assert.equal(call.body.model,'synthetic-local');assert.equal(call.request.redirect,'error');
    assert.equal(call.body.options.num_ctx,16384);assert.equal(call.body.options.num_predict,MODEL_PROFILES[profile].outputTokens);
    assert.equal(call.body.keep_alive,'15m');assert.equal(call.body.think,false);assert.equal(call.body.stream,false);assert.ok(!call.body.tools);
    assert.deepEqual(result.value,{answer:'Synthetic response'});assert.equal(result.metrics.profile,profile);
  }
  assert.ok(MODEL_PROFILES.chat.outputTokens<MODEL_PROFILES.extraction.outputTokens);
});
test('the inference boundary rejects public endpoints, credentials, cloud models and oversized prompts before any fetch',async t=>{
  let calls=0;fixture(t,async()=>{calls++;throw Error('must not fetch');});
  for(const endpoint of ['https://public.example','http://169.254.169.254','http://user:password@127.0.0.1:11434','http://127.0.0.1:11434?override=1']){
    process.env.OLLAMA_URL=endpoint;await assert.rejects(modelJSON('text'),error=>error.code==='MODEL_PRIVATE_ENDPOINT_REQUIRED');
  }
  process.env.OLLAMA_URL='http://127.0.0.1:11434';
  for(const model of ['model:cloud','model:8b-cloud','model-cloud:latest','model\nforged']){process.env.OLLAMA_MODEL=model;await assert.rejects(modelJSON('text'),error=>error.code==='MODEL_LOCAL_REQUIRED');}
  process.env.OLLAMA_MODEL='synthetic-local';
  await assert.rejects(modelJSON('x'.repeat(MODEL_LIMITS.promptBytes+1)),error=>error.code==='MODEL_INPUT_TOO_LARGE');
  await assert.rejects(modelJSON('x',{profile:'arbitrary'}),error=>error.code==='MODEL_INVALID_PROFILE');
  await assert.rejects(modelJSON('x',{timeout:Infinity}),error=>error.code==='MODEL_INVALID_TIMEOUT');
  assert.equal(calls,0);
});
test('success requires a complete assistant object even if truncated content happens to parse',async t=>{
  let response;fixture(t,async()=>Response.json(response));
  for(const bad of [complete({}, {done_reason:'length'}),complete({}, {done:false}),complete([],{}),complete(null,{}),complete('text',{}),complete({}, {message:{role:'tool',content:'{}'}}),complete({}, {message:{role:'assistant',content:'{}',tool_calls:[{function:{name:'send'}}]}}),complete({}, {message:{role:'assistant',content:'{"unfinished":'}})]){
    response=bad;await assert.rejects(modelJSON('Synthetic source'),error=>error.code==='MODEL_INVALID_OUTPUT');
  }
});
test('provider JSON is bounded before parsing and oversized streamed output is cancelled',async t=>{
  let reads=0,cancelled=0;fixture(t,async()=>new Response(new ReadableStream({pull(controller){reads++;controller.enqueue(new Uint8Array(128*1024));},cancel(){cancelled++;}})));
  await assert.rejects(modelJSON('Synthetic input'),error=>error.code==='MODEL_RESPONSE_TOO_LARGE');
  assert.ok(reads<=11,`reads ${reads}`);assert.equal(cancelled,1);
});
test('a dishonest content length cannot bypass the streaming cap and a huge declared length is rejected immediately',async t=>{
  let huge=false,reads=0;fixture(t,async()=>new Response(new ReadableStream({pull(controller){reads++;controller.enqueue(new Uint8Array(128*1024));},cancel(){}}),{headers:{'content-length':huge?String(MODEL_LIMITS.responseBytes+1):'10'}}));
  await assert.rejects(modelJSON('source'),error=>error.code==='MODEL_RESPONSE_TOO_LARGE');
  huge=true;reads=0;await assert.rejects(modelJSON('source'),error=>error.code==='MODEL_RESPONSE_TOO_LARGE');assert.ok(reads<=1);
});
test('network, redirect and provider failures never expose provider bodies or private source fragments',async t=>{
  let mode='network';fixture(t,async()=>{if(mode==='network')throw Error('SECRET source at https://private.example/token');return new Response('SECRET provider diagnostic',{status:mode==='redirect'?302:503});});
  for(mode of ['network','redirect','busy'])await assert.rejects(modelJSON('SECRET student source'),error=>error.code==='MODEL_UNAVAILABLE'&&!/SECRET|private\.example/.test(error.message));
});
test('each request has fresh isolated messages and returns only numerical performance metadata',async t=>{
  const calls=[];fixture(t,async(_url,request)=>{calls.push(JSON.parse(request.body));return Response.json(complete({answer:'Done'},{prompt:'PRIVATE SOURCE',thinking:'PRIVATE THOUGHT',load_duration:2000000}));});
  const first=await modelJSON('STUDENT_A_SOURCE',{profile:'chat'});await modelJSON('STUDENT_B_SOURCE',{profile:'draft'});
  assert.equal(calls[0].messages.length,2);assert.equal(calls[1].messages.length,2);assert.doesNotMatch(JSON.stringify(calls[1]),/STUDENT_A_SOURCE/);
  assert.equal(first.metrics.loadMs,2);assert.equal(first.metrics.promptMs,3);assert.equal(first.metrics.generationMs,1000);assert.equal(first.metrics.outputTokensPerSecond,20);
  assert.doesNotMatch(JSON.stringify(first.metrics),/PRIVATE|SOURCE|THOUGHT|answer|messages/);
});
test('a timed-out model request returns a bounded, actionable error rather than provider data',async t=>{
  fixture(t,(_url,{signal})=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('SECRET timeout diagnostic')),{once:true})));
  // AbortSignal.timeout is unref'ed; this timer keeps the synthetic request alive.
  const timer=setTimeout(()=>{},50);try{await assert.rejects(modelJSON('Synthetic',{timeout:10}),error=>error.code==='MODEL_TIMEOUT'&&!error.message.includes('SECRET'));}finally{clearTimeout(timer);}
});
