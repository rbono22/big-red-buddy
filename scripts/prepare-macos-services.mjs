// Prepare per-user launchd jobs. Credentials stay in the existing private env
// files; service definitions contain file paths, never credential values.
import {mkdir, writeFile, chmod, access} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {homedir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

if(process.platform !== 'darwin') throw new Error('These service definitions are for macOS.');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const directory=path.join(homedir(),'Library','LaunchAgents');
const logs=path.join(homedir(),'Library','Logs','BigRedBuddy');
await access(path.join(root,'.env'));
await access(path.join(root,'data','public-demo.env'));
await mkdir(directory,{recursive:true});
await mkdir(logs,{recursive:true,mode:0o700});
await chmod(logs,0o700);
const xml=value=>String(value).replace(/[<>&"']/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&apos;'}[c]));
for(const role of ['web','model','reminders','discovery']){
  const label=`com.bigredbuddy.${role}`;
  const args=[process.execPath,'--env-file=.env','--env-file=data/public-demo.env','--disable-warning=ExperimentalWarning',role==='web'?'server.mjs':'worker.mjs'];
  const environment={PATH:'/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',...(role==='web'?{}:{WORKER_ROLE:role,WORKER_HEARTBEAT_PATH:`/private/tmp/dabas-${role}-heartbeat`})};
  const logfile=path.join(logs,`${role}.log`);
  await writeFile(logfile,'',{flag:'a',mode:0o600});await chmod(logfile,0o600);
  const plist=`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${xml(label)}</string>
<key>ProgramArguments</key><array>${args.map(a=>`<string>${xml(a)}</string>`).join('')}</array>
<key>WorkingDirectory</key><string>${xml(root)}</string>
<key>EnvironmentVariables</key><dict>${Object.entries(environment).map(([k,v])=>`<key>${xml(k)}</key><string>${xml(v)}</string>`).join('')}</dict>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>10</integer>
<key>ExitTimeOut</key><integer>45</integer>
<key>Umask</key><integer>63</integer>
<key>StandardOutPath</key><string>${xml(logfile)}</string>
<key>StandardErrorPath</key><string>${xml(logfile)}</string>
</dict></plist>
`;
  const filename=path.join(directory,`${label}.plist`);
  await writeFile(filename,plist,{mode:0o600});await chmod(filename,0o600);
  execFileSync('/usr/bin/plutil',['-lint',filename],{stdio:'inherit'});
}
console.log('Prepared four private launchd definitions. Bootstrap them in the current user session to activate.');
