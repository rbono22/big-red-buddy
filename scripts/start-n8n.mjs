import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { mkdirSync, existsSync } from 'node:fs';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const userFolder=path.join(root,'data','n8n');mkdirSync(userFolder,{recursive:true,mode:0o700});
const binary=path.join(root,'.tools','node_modules','n8n','bin','n8n');
if(!existsSync(binary)){console.error('Run npm install --prefix .tools --no-audit --no-fund n8n@2.48.0 first.');process.exit(1);}
const env={...process.env,N8N_USER_FOLDER:userFolder,N8N_LISTEN_ADDRESS:'127.0.0.1',N8N_HOST:'127.0.0.1',N8N_PORT:'5678',N8N_PROTOCOL:'http',N8N_EDITOR_BASE_URL:'http://127.0.0.1:5678',N8N_SECURE_COOKIE:'false',N8N_DIAGNOSTICS_ENABLED:'false',N8N_VERSION_NOTIFICATIONS_ENABLED:'false',N8N_TEMPLATES_ENABLED:'false',EXECUTIONS_DATA_SAVE_ON_ERROR:'none',EXECUTIONS_DATA_SAVE_ON_SUCCESS:'none',EXECUTIONS_DATA_SAVE_ON_PROGRESS:'false',EXECUTIONS_DATA_SAVE_MANUAL_EXECUTIONS:'false',EXECUTIONS_DATA_PRUNE:'true',EXECUTIONS_DATA_MAX_AGE:'24',GENERIC_TIMEZONE:'America/New_York',TZ:'America/New_York'};
if(process.argv.includes('execute'))env.N8N_RUNNERS_BROKER_PORT='5689';
const child=spawn(process.execPath,[binary,...process.argv.slice(2)],{cwd:root,env,stdio:'inherit'});
process.on('SIGINT',()=>child.kill('SIGINT'));process.on('SIGTERM',()=>child.kill('SIGTERM'));child.on('exit',code=>process.exit(code||0));
