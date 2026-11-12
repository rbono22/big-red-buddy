import {randomUUID} from 'node:crypto';
import {databaseInternals,validateId,postgresPoolOptions} from './database.mjs';

const SAFE_TYPES = new Set(['pdf','studio','telegram-chat','jobs-search','job-alerts','extract','syllabus_extract','resume_extract','draft','application_draft','chat','job_search','extract_syllabus','extract_resume','draft_application','campus-daily-sync','event-email-import','academic-refresh','canvas-sync','news-import']);
const MODEL_TYPES=['telegram-upload-suggest','telegram-invitation','telegram-syllabus','pdf','studio','draft','chat','telegram-chat','slack-sync','enrollment','telegram-enrollment','resume-review','career-answer','career-experience','telegram-resume','event-email-sync','event-email-import','news-sync','news-import'];
const dateMs = value => value == null ? null : value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value);
function bound(value,fallback,min,max) {value=value??fallback;if(!Number.isInteger(value)||value<min||value>max) throw new Error('Invalid queue option');return value;}

export async function createQueue(database,{workerDatabaseUrl=process.env.WORKER_DATABASE_URL,concurrency=2,maxPendingPerUser=120,maxPendingModelPerUser=10}={}) {
  concurrency=bound(concurrency,2,1,32);maxPendingPerUser=bound(maxPendingPerUser,120,1,1000);maxPendingModelPerUser=bound(maxPendingModelPerUser,10,1,100);
  const {pool,sqlite,transaction,seal,unseal}=databaseInternals(database);
  let workerPool;
  if(pool && workerDatabaseUrl) {
    const {Pool}=await import('pg');workerPool=new Pool(postgresPoolOptions(workerDatabaseUrl,{max:4}));
    workerPool.on('error',()=>{});
    try {
      const role=(await workerPool.query("SELECT rolsuper,rolbypassrls,pg_has_role(current_user,'dabas_worker','MEMBER') AS worker FROM pg_roles WHERE rolname=current_user")).rows[0];
      if(role.rolsuper||role.rolbypassrls||!role.worker) throw new Error('Worker must use a nonprivileged dabas_worker role');
      if((await workerPool.query("SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='dabas' AND c.relkind='r' AND pg_has_role(current_user,c.relowner,'MEMBER') LIMIT 1")).rowCount)throw new Error('Worker runtime role must not inherit table ownership');
    }catch(error){await workerPool.end();throw error;}
  }
  const decode=(row,includePayload=true)=>{
    if(!row)return null;
    const result={id:row.id,userId:row.user_id,type:row.type,status:row.status,priority:row.priority,attempts:row.attempts,maxAttempts:row.max_attempts,retrySafe:!!row.retry_safe,createdAt:dateMs(row.created_at),availableAt:dateMs(row.available_at),startedAt:dateMs(row.started_at),completedAt:dateMs(row.completed_at),expiresAt:dateMs(row.expires_at),leaseUntil:dateMs(row.lease_until),leaseToken:row.lease_token,workerId:row.worker_id,errorCode:row.error_code||null};
    if(includePayload) result.payload=unseal(row.user_id,'@queue',row.id,row.payload);
    if(includePayload) result.idempotencyKey=row.idempotency_key||null;
    if(row.result)result.result=unseal(row.user_id,'@queue-result',row.id,row.result);
    return result;
  };
  function lease(job){if(!job||!job.id||!job.userId||!job.leaseToken||!job.workerId)throw new Error('A claimed job including its lease token is required');return job;}
  async function transition(job,action,{result=null,code='JOB_FAILED',retryable=false,leaseMs=60000}={}) {
    lease(job);leaseMs=bound(leaseMs,60000,1000,900000);
    if(!/^[A-Z0-9_]{1,80}$/.test(code))code='JOB_FAILED';
    const sealed=action==='complete'?seal(job.userId,'@queue-result',job.id,result):null;
    if(pool){
      if(!workerPool)throw new Error('WORKER_DATABASE_URL is required for worker operations');
      const row=(await workerPool.query('SELECT * FROM dabas.transition_job($1,$2,$3,$4,$5,$6,$7,$8)',[job.id,job.leaseToken,job.workerId,action,sealed,code,!!retryable,leaseMs])).rows[0];
      if(!row)throw new Error('JOB_LEASE_LOST');return decode(row,false);
    }
    return transaction(job.userId,async connection=>{
      const now=Date.now(),row=connection.prepare("SELECT * FROM jobs WHERE id=? AND user_id=? AND lease_token=? AND worker_id=? AND status='running' AND lease_until>?").get(job.id,job.userId,job.leaseToken,job.workerId,now);
      if(!row)throw new Error('JOB_LEASE_LOST');
      const retry=action==='fail'&&retryable&&row.retry_safe&&row.attempts<row.max_attempts&&row.expires_at>now;
      const status=action==='heartbeat'?'running':action==='complete'?'completed':retry?'queued':!row.retry_safe?'needs_review':'failed';
      connection.prepare('UPDATE jobs SET status=?,lease_until=?,lease_token=?,worker_id=?,result=?,error_code=?,available_at=?,completed_at=? WHERE id=?').run(status,action==='heartbeat'?now+leaseMs:null,action==='heartbeat'?job.leaseToken:null,action==='heartbeat'?job.workerId:null,action==='complete'?sealed:row.result,action==='fail'?code:null,retry?now+Math.min(300,2**row.attempts)*1000:row.available_at,action==='heartbeat'||retry?null:now,job.id);
      return decode(connection.prepare('SELECT * FROM jobs WHERE id=?').get(job.id),false);
    });
  }
  return {
    async enqueue(userId,type,payload,{idempotencyKey=null,priority=0,availableAt=Date.now(),maxAttempts=3,retrySafe=SAFE_TYPES.has(type),ttlMs=24*60*60*1000}={}) {
      validateId(userId,'student ID');validateId(type,'job type');if(idempotencyKey!==null)validateId(idempotencyKey,'idempotency key');
      priority=bound(priority,0,-100,100);maxAttempts=bound(maxAttempts,3,1,10);ttlMs=bound(ttlMs,86400000,60000,7*86400000);
      availableAt=dateMs(availableAt);if(!Number.isFinite(availableAt))throw new Error('Invalid job schedule');
      // Only pure work and explicitly idempotent source reconciliation may be repeated.
      retrySafe=!!retrySafe&&SAFE_TYPES.has(type);
      const id=randomUUID(),now=Date.now(),encrypted=seal(userId,'@queue',id,payload);
      return transaction(userId,async connection=>{
        if(pool){
          await connection.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`queue:${userId}`]);
          if(idempotencyKey){const existing=(await connection.query('SELECT * FROM dabas.jobs WHERE user_id=$1 AND type=$2 AND idempotency_key=$3',[userId,type,idempotencyKey])).rows[0];if(existing)return decode(existing,false);}
          const count=Number((await connection.query("SELECT count(*) AS count FROM dabas.jobs WHERE user_id=$1 AND status IN('queued','running')",[userId])).rows[0].count);
          if(count>=maxPendingPerUser)throw new Error('STUDENT_QUEUE_FULL');
          if(MODEL_TYPES.includes(type) && Number((await connection.query("SELECT count(*) AS count FROM dabas.jobs WHERE user_id=$1 AND status IN('queued','running') AND type=ANY($2::text[])",[userId,MODEL_TYPES])).rows[0].count)>=maxPendingModelPerUser)throw new Error('STUDENT_MODEL_QUEUE_FULL');
          await connection.query('INSERT INTO dabas.tenants(user_id) VALUES($1) ON CONFLICT DO NOTHING',[userId]);
          const row=(await connection.query('INSERT INTO dabas.jobs(id,user_id,type,payload,priority,available_at,created_at,max_attempts,retry_safe,idempotency_key,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *',[id,userId,type,encrypted,priority,new Date(availableAt),new Date(now),maxAttempts,retrySafe,idempotencyKey,new Date(now+ttlMs)])).rows[0];return decode(row,false);
        }
        if(idempotencyKey){const existing=connection.prepare('SELECT * FROM jobs WHERE user_id=? AND type=? AND idempotency_key=?').get(userId,type,idempotencyKey);if(existing)return decode(existing,false);}
        if(connection.prepare("SELECT count(*) AS count FROM jobs WHERE user_id=? AND status IN('queued','running')").get(userId).count>=maxPendingPerUser)throw new Error('STUDENT_QUEUE_FULL');
        if(MODEL_TYPES.includes(type) && connection.prepare(`SELECT count(*) AS count FROM jobs WHERE user_id=? AND status IN('queued','running') AND type IN(${MODEL_TYPES.map(()=>'?').join(',')})`).get(userId,...MODEL_TYPES).count>=maxPendingModelPerUser)throw new Error('STUDENT_MODEL_QUEUE_FULL');
        connection.prepare('INSERT OR IGNORE INTO tenants(user_id) VALUES(?)').run(userId);
        connection.prepare('INSERT INTO jobs(id,user_id,type,payload,priority,available_at,created_at,max_attempts,retry_safe,idempotency_key,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id,userId,type,encrypted,priority,availableAt,now,maxAttempts,Number(retrySafe),idempotencyKey,now+ttlMs);
        return decode(connection.prepare('SELECT * FROM jobs WHERE id=?').get(id),false);
      });
    },
    async claim(workerId,{types=null,leaseMs=60000,concurrency:claimConcurrency=concurrency}={}) {
      claimConcurrency=bound(claimConcurrency,concurrency,1,32);
      validateId(workerId,'worker ID');leaseMs=bound(leaseMs,60000,1000,900000);if(types!==null){if(!Array.isArray(types)||types.length>30)throw new Error('Invalid job type filter');types.forEach(type=>validateId(type,'job type'));}
      const token=randomUUID();
      if(pool){if(!workerPool)throw new Error('WORKER_DATABASE_URL is required for worker operations');return decode((await workerPool.query('SELECT * FROM dabas.claim_job($1,$2,$3,$4,$5)',[workerId,types,leaseMs,claimConcurrency,token])).rows[0]);}
      return transaction(null,async connection=>{
        const now=Date.now();
        connection.prepare("DELETE FROM jobs WHERE expires_at<? AND status<>'running'").run(now);
        connection.prepare("UPDATE jobs SET status=CASE WHEN retry_safe=1 AND attempts<max_attempts AND expires_at>? THEN 'queued' WHEN retry_safe=1 THEN 'failed' ELSE 'needs_review' END,available_at=?,completed_at=CASE WHEN retry_safe=1 AND attempts<max_attempts AND expires_at>? THEN NULL ELSE ? END,error_code='LEASE_EXPIRED',lease_until=NULL,lease_token=NULL,worker_id=NULL WHERE status='running' AND lease_until<?").run(now,now,now,now,now);
        const filter=types?` AND type IN(${types.map(()=>'?').join(',')})`:'';
        const values=types||[];
        if(connection.prepare(`SELECT count(*) AS count FROM jobs WHERE status='running'${filter}`).get(...values).count>=claimConcurrency)return null;
        const row=connection.prepare(`SELECT * FROM jobs WHERE status='queued' AND available_at<=? AND expires_at>?${filter} ORDER BY priority DESC,available_at,created_at LIMIT 1`).get(now,now,...values);
        if(!row)return null;
        connection.prepare("UPDATE jobs SET status='running',worker_id=?,lease_token=?,lease_until=?,attempts=attempts+1,started_at=? WHERE id=?").run(workerId,token,now+leaseMs,now,row.id);
        return decode(connection.prepare('SELECT * FROM jobs WHERE id=?').get(row.id));
      });
    },
    heartbeat:(job,options={})=>transition(job,'heartbeat',typeof options==='number'?{leaseMs:options}:options),
    complete:(job,result=null)=>transition(job,'complete',{result}),
    fail:(job,options={})=>transition(job,'fail',options),
    async get(userId,id) {validateId(userId);validateId(id);return transaction(userId,async connection=>decode(pool?(await connection.query('SELECT * FROM dabas.jobs WHERE user_id=$1 AND id=$2',[userId,id])).rows[0]:connection.prepare('SELECT * FROM jobs WHERE user_id=? AND id=?').get(userId,id),false));},
    async list(userId,{limit=100}={}) {validateId(userId);limit=bound(limit,100,1,500);return transaction(userId,async connection=>{const rows=pool?(await connection.query('SELECT * FROM dabas.jobs WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2',[userId,limit])).rows:connection.prepare('SELECT * FROM jobs WHERE user_id=? ORDER BY created_at DESC LIMIT ?').all(userId,limit);return rows.map(row=>decode(row,false));});},
    // Best-effort historical provenance only: queue rows expire, and completed means
    // draft preparation completed, never that an employer received an application.
    // Do not expose decrypted queue payloads through the normal list/get APIs.
    async listDraftOrigins(userId,{limit=100}={}) {
      validateId(userId,'student ID');limit=bound(limit,100,1,500);
      return transaction(userId,async connection=>{
        const columns='id,payload,status,created_at,started_at,completed_at';
        const rows=pool?(await connection.query(`SELECT ${columns} FROM dabas.jobs WHERE user_id=$1 AND type='draft' ORDER BY created_at DESC,id DESC LIMIT $2`,[userId,limit])).rows:connection.prepare(`SELECT ${columns} FROM jobs WHERE user_id=? AND type='draft' ORDER BY created_at DESC,id DESC LIMIT ?`).all(userId,limit);
        const origins=[];
        for(const row of rows){
          const payload=unseal(userId,'@queue',row.id,row.payload);
          if(!payload||typeof payload!=='object'||Array.isArray(payload)||payload.replyTo!=='telegram'||typeof payload.id!=='string'||!/^[-a-zA-Z0-9._:]{1,200}$/.test(payload.id))continue;
          origins.push({taskId:row.id,jobId:payload.id,source:'telegram',status:row.status,createdAt:dateMs(row.created_at),startedAt:dateMs(row.started_at),completedAt:dateMs(row.completed_at)});
        }
        return origins;
      });
    },
    async hasRunning(userId) {validateId(userId);return transaction(userId,async connection=>pool?(await connection.query("SELECT 1 FROM dabas.jobs WHERE user_id=$1 AND status='running' LIMIT 1",[userId])).rowCount>0:!!connection.prepare("SELECT 1 FROM jobs WHERE user_id=? AND status='running' LIMIT 1").get(userId));},
    async cancelPending(userId) {validateId(userId);return transaction(userId,async connection=>pool?(await connection.query("DELETE FROM dabas.jobs WHERE user_id=$1 AND status='queued'",[userId])).rowCount:connection.prepare("DELETE FROM jobs WHERE user_id=? AND status='queued'").run(userId).changes);},
    async cancelUser(userId) {validateId(userId);return transaction(userId,async connection=>{
      const rows=pool?(await connection.query('SELECT status FROM dabas.jobs WHERE user_id=$1 FOR UPDATE',[userId])).rows:connection.prepare('SELECT status FROM jobs WHERE user_id=?').all(userId);
      if(rows.some(row=>row.status==='running'))throw new Error('STUDENT_JOBS_RUNNING');
      return pool?(await connection.query('DELETE FROM dabas.jobs WHERE user_id=$1',[userId])).rowCount:connection.prepare('DELETE FROM jobs WHERE user_id=?').run(userId).changes;
    });},
    async clear(userId) {return this.cancelUser(userId);},
    async metrics(userId) {
      validateId(userId,'student ID');
      return transaction(userId,async connection=>{
        const rows=pool?(await connection.query('SELECT status,created_at,available_at,started_at,completed_at FROM dabas.jobs WHERE user_id=$1 AND created_at>$2 ORDER BY created_at DESC LIMIT 10000',[userId,new Date(Date.now()-86400000)])).rows:connection.prepare('SELECT status,created_at,available_at,started_at,completed_at FROM jobs WHERE user_id=? AND created_at>? ORDER BY created_at DESC LIMIT 10000').all(userId,Date.now()-86400000);
        const counts={queued:0,running:0,completed:0,failed:0,needs_review:0},delays=[],latencies=[];
        for(const row of rows){counts[row.status]++;if(row.started_at)delays.push(Math.max(0,dateMs(row.started_at)-dateMs(row.available_at)));if(row.completed_at&&row.started_at)latencies.push(Math.max(0,dateMs(row.completed_at)-dateMs(row.started_at)));}
        const quantile=(values,q)=>values.length?values.sort((a,b)=>a-b)[Math.min(values.length-1,Math.floor(values.length*q))]:null;
        return {windowHours:24,sampledJobs:rows.length,counts,queueDelayP50Ms:quantile(delays,.5),queueDelayP95Ms:quantile(delays,.95),processingP50Ms:quantile(latencies,.5),processingP95Ms:quantile(latencies,.95),failureRate:rows.length?(counts.failed+counts.needs_review)/rows.length:0,concurrency};
      });
    },
    async close(){if(workerPool)await workerPool.end();}
  };
}
