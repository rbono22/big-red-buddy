import {readFile} from 'node:fs/promises';
import {Pool} from 'pg';
import {postgresPoolOptions} from '../lib/database.mjs';

if(!process.env.MIGRATION_DATABASE_URL) throw new Error('MIGRATION_DATABASE_URL is required (separate owner credential; never use it for web/worker runtime)');
const pool=new Pool(postgresPoolOptions(process.env.MIGRATION_DATABASE_URL,{max:1}));
try {
  const roles=await pool.query("SELECT rolname FROM pg_roles WHERE rolname IN('dabas_app','dabas_worker')");
  if(roles.rowCount!==2) throw new Error('Provision NOLOGIN roles dabas_app and dabas_worker before migrations');
  await pool.query(await readFile(new URL('../migrations/001_tenants_and_queue.sql',import.meta.url),'utf8'));
  console.log('Database schema ready: 001_tenants_and_queue; tenant RLS enabled and forced.');
} catch(error) {
  // Connection strings and provider diagnostics may contain credentials; expose only safe classifications.
  console.error(`Migration failed (${error.code || 'configuration'}). Check roles, owner access, and database reachability.`);
  process.exitCode=1;
} finally {await pool.end();}
