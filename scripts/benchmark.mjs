import { writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../lib/database.mjs';
import { createQueue } from '../lib/queue.mjs';
const email=String(process.env.BENCHMARK_STUDENT_EMAIL||'').trim().toLowerCase();
if(!email)throw new Error('Set BENCHMARK_STUDENT_EMAIL to an existing consenting test student. This queues one real model request.');
const database=await openDatabase({dataDir:process.env.ASSISTANT_DATA||'./data'}),queue=await createQueue(database,{workerDatabaseUrl:null});
try {
  const candidates=(await database.auth.all('users')).filter(u=>u.email===email),user=candidates.find(u=>u.provider==='google')||candidates[0];
  if(!user)throw new Error('Sign in as the test student before benchmarking.');
  const job=await queue.enqueue(user.id,'chat',{question:'When is my NBAY 5300 final exam, what room is it in, and which source establishes the time?'},{idempotencyKey:`benchmark:${randomUUID()}`,retrySafe:true});
  const begin=Date.now();let result;
  while(Date.now()-begin<240000){result=await queue.get(user.id,job.id);if(['completed','failed','needs_review'].includes(result?.status))break;await delay(500);}
  if(result?.status!=='completed')throw new Error('Benchmark did not complete. Check model worker and private Ollama status.');
  const report={at:new Date().toISOString(),scope:'One real queued model request using the consenting local test student context; not a fleet capacity claim',model:process.env.OLLAMA_MODEL||'qwen3.5:9b-q4_K_M',queueDelayMs:result.startedAt-result.availableAt,processingMs:result.completedAt-result.startedAt,endToEndMs:result.completedAt-result.createdAt,answerReturned:typeof result.result?.answer==='string',questionAndAnswerStoredInReport:false,costUSD:null};
  await writeFile('output/model-benchmark.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
} finally {await queue.close();await database.close();}
