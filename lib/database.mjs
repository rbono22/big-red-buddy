import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { isIP } from 'node:net';
import path from 'node:path';

const internals = new WeakMap();
const MAX_RECORD_BYTES = 18 * 1024 * 1024;
const MAX_ALL = 2000;
export const databaseInternals = database => {
  const internal = internals.get(database);
  if (!internal) throw new Error('Unknown database');
  return internal;
};
export function validateId(value, label = 'identifier') {
  if (typeof value !== 'string' || !value.length || value.length > 200 || /[\u0000-\u001f]/.test(value)) throw new Error(`Invalid ${label}`);
  return value;
}
export function postgresPoolOptions(databaseUrl,{max=10}={}) {
  let url;try{url=new URL(databaseUrl);}catch{throw new Error('Invalid PostgreSQL connection URL');}
  if(!['postgres:','postgresql:'].includes(url.protocol))throw new Error('Invalid PostgreSQL connection protocol');
  const host=(url.searchParams.get('host')||url.hostname).replace(/^\[|\]$/g,'').toLowerCase();
  const octets=host.split('.').map(Number);
  const local=['localhost','postgres','db','host.docker.internal','::1'].includes(host)||host.startsWith('/')||(isIP(host)===4&&(octets[0]===127||octets[0]===10||(octets[0]===172&&octets[1]>=16&&octets[1]<=31)||(octets[0]===192&&octets[1]===168)))||(isIP(host)===6&&/^(fc|fd)/.test(host));
  if(!local){
    const mode=url.searchParams.get('sslmode');
    if(['disable','no-verify','prefer','verify-ca'].includes(mode)||['0','false'].includes(url.searchParams.get('ssl'))||process.env.NODE_TLS_REJECT_UNAUTHORIZED==='0')throw new Error('External PostgreSQL requires verified TLS (sslmode=verify-full)');
    url.searchParams.set('sslmode','verify-full');
    url.searchParams.delete('uselibpqcompat');
  }
  return {connectionString:url.toString(),max,connectionTimeoutMillis:10000,idleTimeoutMillis:30000,statement_timeout:30000,lock_timeout:10000,idle_in_transaction_session_timeout:30000};
}
function getKey({dataDir, encryptionKey, production}) {
  if (encryptionKey) {
    const key = Buffer.isBuffer(encryptionKey) ? encryptionKey : Buffer.from(encryptionKey, /^[a-f0-9]{64}$/i.test(encryptionKey) ? 'hex' : 'base64');
    if (key.length !== 32) throw new Error('DATA_ENCRYPTION_KEY must encode exactly 32 bytes');
    return key;
  }
  if (production) throw new Error('DATA_ENCRYPTION_KEY is required in production');
  mkdirSync(dataDir, {recursive: true, mode: 0o700});
  const keyPath = path.join(dataDir, 'tenant.key');
  if (!existsSync(keyPath)) {
    try { writeFileSync(keyPath, randomBytes(32), {flag: 'wx', mode: 0o600}); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  chmodSync(keyPath, 0o600);
  const key = readFileSync(keyPath);
  if (key.length !== 32) throw new Error('Invalid local encryption key');
  return key;
}
export async function openDatabase({dataDir = './data', databaseUrl = process.env.DATABASE_URL, encryptionKey = process.env.DATA_ENCRYPTION_KEY, allowLocal = process.env.NODE_ENV !== 'production', production = process.env.NODE_ENV === 'production'} = {}) {
  if (!databaseUrl && (production || !allowLocal)) throw new Error('DATABASE_URL is required; local storage is development-only');
  const key = getKey({dataDir, encryptionKey, production});
  const aad = (userId, bucket, id) => Buffer.from(JSON.stringify([userId, bucket, id]));
  const seal = (userId, bucket, id, value) => {
    const plaintext = JSON.stringify(value);
    if (plaintext === undefined || Buffer.byteLength(plaintext) > MAX_RECORD_BYTES) throw new Error('Record exceeds storage limit');
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(aad(userId, bucket, id));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
  };
  const unseal = (userId, bucket, id, payload) => {
    const buffer = Buffer.from(payload, 'base64'), decipher = createDecipheriv('aes-256-gcm', key, buffer.subarray(0,12));
    decipher.setAAD(aad(userId, bucket, id)); decipher.setAuthTag(buffer.subarray(12,28));
    return JSON.parse(Buffer.concat([decipher.update(buffer.subarray(28)), decipher.final()]).toString('utf8'));
  };
  let pool, sqlite, mutex = Promise.resolve();
  const kind = databaseUrl ? 'postgres' : 'sqlite-development';
  if (databaseUrl) {
    const {Pool} = await import('pg');
    pool = new Pool(postgresPoolOptions(databaseUrl));
    pool.on('error', () => {}); // Health/operations expose failure without logging credentials or SQL payloads.
    try {
      const role = (await pool.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];
      if (role.rolsuper || role.rolbypassrls) throw new Error('Runtime database role must not be superuser or BYPASSRLS');
      const owned = await pool.query("SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='dabas' AND c.relkind='r' AND pg_has_role(current_user,c.relowner,'MEMBER') LIMIT 1");
      if (owned.rowCount) throw new Error('Runtime database role must not own or inherit ownership of application tables');
      const protection = await pool.query("SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='dabas' AND relname IN ('records','jobs')");
      if (protection.rowCount !== 2 || protection.rows.some(row=>!row.relrowsecurity || !row.relforcerowsecurity)) throw new Error('Database migrations and FORCE ROW LEVEL SECURITY are required');
    } catch (error) { await pool.end(); throw error; }
  } else {
    mkdirSync(dataDir, {recursive: true, mode: 0o700});
    const file = path.join(dataDir, 'tenant.sqlite');
    sqlite = new DatabaseSync(file); chmodSync(file,0o600);
    sqlite.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS tenants (user_id TEXT PRIMARY KEY,deleted_at INTEGER);
      CREATE TABLE IF NOT EXISTS records (user_id TEXT NOT NULL,bucket TEXT NOT NULL,id TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(user_id,bucket,id));
      CREATE TABLE IF NOT EXISTS auth_records (bucket TEXT NOT NULL,id TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(bucket,id));
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY,user_id TEXT NOT NULL,type TEXT NOT NULL,payload TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'queued',priority INTEGER NOT NULL DEFAULT 0,available_at INTEGER NOT NULL,created_at INTEGER NOT NULL,started_at INTEGER,completed_at INTEGER,lease_until INTEGER,lease_token TEXT,worker_id TEXT,attempts INTEGER NOT NULL DEFAULT 0,max_attempts INTEGER NOT NULL DEFAULT 3,retry_safe INTEGER NOT NULL DEFAULT 0,result TEXT,error_code TEXT,idempotency_key TEXT,expires_at INTEGER NOT NULL,UNIQUE(user_id,type,idempotency_key));
      CREATE INDEX IF NOT EXISTS jobs_ready ON jobs(status,available_at,priority);`);
    if(!sqlite.prepare('PRAGMA table_info(tenants)').all().some(column=>column.name==='deleted_at'))sqlite.exec('ALTER TABLE tenants ADD COLUMN deleted_at INTEGER');
  }
  async function transaction(userId, action, {allowDeleted=false}={}) {
    if (pool) {
      const client = await pool.connect();
      try { await client.query('BEGIN'); await client.query("SELECT set_config('app.user_id',$1,true)", [userId || '']);
        if(userId){await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`student:${userId}`]);if(!allowDeleted&&(await client.query('SELECT 1 FROM dabas.tenants WHERE user_id=$1 AND deleted_at IS NOT NULL',[userId])).rowCount)throw new Error('STUDENT_DELETED');}
        const result = await action(client); await client.query('COMMIT'); return result; }
      catch (error) { await client.query('ROLLBACK').catch(()=>{}); throw error; }
      finally { client.release(); }
    }
    let release; const previous = mutex; mutex = new Promise(resolve=>{release=resolve;}); await previous;
    try { sqlite.exec('BEGIN IMMEDIATE');if(userId&&!allowDeleted&&sqlite.prepare('SELECT 1 FROM tenants WHERE user_id=? AND deleted_at IS NOT NULL').get(userId))throw new Error('STUDENT_DELETED');const result = await action(sqlite); sqlite.exec('COMMIT'); return result; }
    catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    finally { release(); }
  }
  function store(userId, auth = false) {
    if (!auth) validateId(userId,'student ID');
    const table = auth ? 'auth_records' : 'records';
    const scope = auth ? '@auth' : userId;
    const keys = (bucket,id) => {validateId(bucket,'bucket'); if(id !== undefined) validateId(id);};
    const where = auth ? 'bucket=$1 AND id=$2' : 'user_id=$1 AND bucket=$2 AND id=$3';
    const params = (bucket,id) => auth ? [bucket,id] : [userId,bucket,id];
    const find = async (connection,bucket,id,lock=false) => pool ? (await connection.query(`SELECT payload FROM dabas.${table} WHERE ${where}${lock?' FOR UPDATE':''}`,params(bucket,id))).rows[0] : connection.prepare(`SELECT payload FROM ${table} WHERE ${where.replaceAll(/\$\d/g,'?')}`).get(...params(bucket,id));
    const write = async (connection,bucket,id,value,onlyAbsent=false) => {
      if(auth && bucket==='users') {
        if(pool){await connection.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`student:${id}`]);if((await connection.query('SELECT 1 FROM dabas.tenants WHERE user_id=$1 AND deleted_at IS NOT NULL',[id])).rowCount)throw new Error('STUDENT_DELETED');}
        else if(connection.prepare('SELECT 1 FROM tenants WHERE user_id=? AND deleted_at IS NOT NULL').get(id))throw new Error('STUDENT_DELETED');
      }
      const payload = seal(scope,bucket,id,value), values = [...params(bucket,id),payload];
      if (pool) {
        if(!auth || bucket==='users') await connection.query('INSERT INTO dabas.tenants(user_id) VALUES($1) ON CONFLICT DO NOTHING',[auth?id:userId]);
        await connection.query(`INSERT INTO dabas.${table}(${auth?'':'user_id,'}bucket,id,payload) VALUES(${values.map((_,i)=>`$${i+1}`).join(',')}) ON CONFLICT (${auth?'':'user_id,'}bucket,id) DO ${onlyAbsent?'NOTHING':'UPDATE SET payload=EXCLUDED.payload'}`,values);
      } else {
        if(!auth || bucket==='users') connection.prepare('INSERT OR IGNORE INTO tenants(user_id) VALUES(?)').run(auth?id:userId);
        connection.prepare(`INSERT INTO ${table}(${auth?'':'user_id,'}bucket,id,payload) VALUES(${values.map(()=>'?').join(',')}) ON CONFLICT (${auth?'':'user_id,'}bucket,id) DO ${onlyAbsent?'NOTHING':'UPDATE SET payload=excluded.payload'}`).run(...values);
      }
    };
    return {
      userId: auth ? null : userId,
      async all(bucket,{limit=MAX_ALL,offset=0}={}) {
        keys(bucket); if(!Number.isInteger(limit)||limit<1||limit>MAX_ALL||!Number.isInteger(offset)||offset<0) throw new Error('Invalid bounded list');
        return transaction(userId,async connection=>{
          const values=auth?[bucket,limit,offset]:[userId,bucket,limit,offset];
          const sql=`SELECT id,payload FROM ${pool?'dabas.':''}${table} WHERE ${auth?'bucket=$1':'user_id=$1 AND bucket=$2'} ORDER BY id LIMIT $${auth?2:3} OFFSET $${auth?3:4}`;
          const rows=pool?(await connection.query(sql,values)).rows:connection.prepare(sql.replaceAll(/\$\d/g,'?')).all(...values);
          return rows.map(row=>unseal(scope,bucket,row.id,row.payload));
        });
      },
      async get(bucket,id) { keys(bucket,id); return transaction(userId,async connection=>{const row=await find(connection,bucket,id);return row?unseal(scope,bucket,id,row.payload):null;}); },
      async put(bucket,id,value) {keys(bucket,id); return transaction(userId,async connection=>{await write(connection,bucket,id,value);return value;});},
      async putIfAbsent(bucket,id,value) {keys(bucket,id);return transaction(userId,async connection=>{await write(connection,bucket,id,value,true);const row=await find(connection,bucket,id);return unseal(scope,bucket,id,row.payload);});},
      async take(bucket,id) {
        keys(bucket,id);return transaction(userId,async connection=>{
          const sql=`DELETE FROM ${pool?'dabas.':''}${table} WHERE ${where} RETURNING payload`;
          const row=pool?(await connection.query(sql,params(bucket,id))).rows[0]:connection.prepare(sql.replaceAll(/\$\d/g,'?')).get(...params(bucket,id));
          return row?unseal(scope,bucket,id,row.payload):null;
        });
      },
      async compareAndSet(bucket,id,expected,value) {
        keys(bucket,id); return transaction(userId,async connection=>{
          // Serialize absent-key creation as well as existing rows.
          if(pool) await connection.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify([scope,bucket,id])]);
          const row=await find(connection,bucket,id,true), current=row?unseal(scope,bucket,id,row.payload):null;
          if(!isDeepStrictEqual(current,expected)) return false;
          await write(connection,bucket,id,value); return true;
        });
      },
      /** Commit a bounded group of tenant records together, or change nothing. */
      async compareAndSetMany(changes,{buckets=[]}={}) {
        if(auth||!Array.isArray(changes)||changes.length>10000||!Array.isArray(buckets)||buckets.length>20)throw new Error('Invalid atomic record batch');
        const seen=new Set();for(const change of changes){keys(change.bucket,change.id);if(Object.hasOwn(change,'delete')&&(change.delete!==true||Object.hasOwn(change,'value')))throw new Error('Invalid atomic deletion');const key=JSON.stringify([change.bucket,change.id]);if(seen.has(key))throw new Error('Duplicate atomic record');seen.add(key);}
        for(const guard of buckets){keys(guard.bucket);if(!Array.isArray(guard.ids)||guard.ids.length>10000)throw new Error('Invalid atomic bucket guard');}
        return transaction(userId,async connection=>{
          for(const guard of buckets){
            const rows=pool?(await connection.query('SELECT id FROM dabas.records WHERE user_id=$1 AND bucket=$2 ORDER BY id',[userId,guard.bucket])).rows:connection.prepare('SELECT id FROM records WHERE user_id=? AND bucket=? ORDER BY id').all(userId,guard.bucket);
            if(!isDeepStrictEqual(rows.map(row=>row.id),[...guard.ids].sort()))return false;
          }
          for(const change of changes){const row=await find(connection,change.bucket,change.id,true),current=row?unseal(scope,change.bucket,change.id,row.payload):null;if(!isDeepStrictEqual(current,change.expected))return false;}
          for(const change of changes){
            if(change.delete===true){const sql=`DELETE FROM ${pool?'dabas.':''}${table} WHERE ${where}`,values=params(change.bucket,change.id);if(pool)await connection.query(sql,values);else connection.prepare(sql.replaceAll(/\$\d/g,'?')).run(...values);}
            else if(Object.hasOwn(change,'value'))await write(connection,change.bucket,change.id,change.value);
          }
          return true;
        });
      },
      async delete(bucket,id) {keys(bucket,id);return transaction(userId,async connection=>{const sql=`DELETE FROM ${pool?'dabas.':''}${table} WHERE ${where}`;return pool?(await connection.query(sql,params(bucket,id))).rowCount:connection.prepare(sql.replaceAll(/\$\d/g,'?')).run(...params(bucket,id)).changes;});},
      async clear(bucket) {keys(bucket);return transaction(userId,async connection=>{const sql=`DELETE FROM ${pool?'dabas.':''}${table} WHERE ${auth?'bucket=$1':'user_id=$1 AND bucket=$2'}`,values=auth?[bucket]:[userId,bucket];return pool?(await connection.query(sql,values)).rowCount:connection.prepare(sql.replaceAll(/\$\d/g,'?')).run(...values).changes;});}
    };
  }
  const auth=store(null,true);
  auth.allEntries=async(bucket,{limit=200,after=null}={})=>{
    validateId(bucket,'bucket');if(after!==null)validateId(after,'cursor');if(!Number.isInteger(limit)||limit<1||limit>MAX_ALL)throw new Error('Invalid bounded list');
    return transaction(null,async connection=>{
      const rows=pool?(await connection.query('SELECT id,payload FROM dabas.auth_records WHERE bucket=$1 AND id>$2 ORDER BY id LIMIT $3',[bucket,after||'',limit])).rows:connection.prepare('SELECT id,payload FROM auth_records WHERE bucket=? AND id>? ORDER BY id LIMIT ?').all(bucket,after||'',limit);
      return rows.map(row=>({id:row.id,value:unseal('@auth',bucket,row.id,row.payload)}));
    });
  };
  const database={kind,forUser:userId=>store(userId),auth,system:auth,
    async listUserIds(){return transaction(null,async connection=>pool?(await connection.query('SELECT user_id FROM dabas.tenants WHERE deleted_at IS NULL ORDER BY user_id LIMIT 10000')).rows.map(row=>row.user_id):connection.prepare('SELECT user_id FROM tenants WHERE deleted_at IS NULL ORDER BY user_id LIMIT 10000').all().map(row=>row.user_id));},
    async isDeleted(userId){validateId(userId);return transaction(null,async connection=>pool?(await connection.query('SELECT 1 FROM dabas.tenants WHERE user_id=$1 AND deleted_at IS NOT NULL',[userId])).rowCount>0:!!connection.prepare('SELECT 1 FROM tenants WHERE user_id=? AND deleted_at IS NOT NULL').get(userId));},
    async deleteStudent(userId){validateId(userId);return transaction(userId,async connection=>{
      if(pool){try{return (await connection.query('SELECT dabas.delete_student($1) AS deleted',[userId])).rows[0].deleted;}catch(error){if(error.message==='STUDENT_JOBS_RUNNING')throw new Error('STUDENT_JOBS_RUNNING');throw error;}}
      if(connection.prepare("SELECT 1 FROM jobs WHERE user_id=? AND status='running' LIMIT 1").get(userId))throw new Error('STUDENT_JOBS_RUNNING');
      connection.prepare('DELETE FROM jobs WHERE user_id=?').run(userId);connection.prepare('DELETE FROM records WHERE user_id=?').run(userId);connection.prepare("DELETE FROM auth_records WHERE bucket='users' AND id=?").run(userId);
      connection.prepare('INSERT INTO tenants(user_id,deleted_at) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET deleted_at=COALESCE(tenants.deleted_at,excluded.deleted_at)').run(userId,Date.now());return true;
    },{allowDeleted:true});},
    async health(){if(pool) await pool.query('SELECT 1');else sqlite.prepare('SELECT 1').get();return {kind,ok:true};},
    async close(){if(pool) await pool.end();else sqlite.close();}
  };
  internals.set(database,{pool,sqlite,transaction,seal,unseal,databaseUrl});
  return database;
}
