import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import path from 'node:path';
export function openStore(root) {
  mkdirSync(root,{recursive:true,mode:0o700}); chmodSync(root,0o700);
  const keyPath=path.join(root,'local.key');
  if(!existsSync(keyPath)) writeFileSync(keyPath,randomBytes(32),{mode:0o600});
  chmodSync(keyPath,0o600); const key=readFileSync(keyPath);
  const db=new DatabaseSync(path.join(root,'assistant.sqlite'));
  chmodSync(path.join(root,'assistant.sqlite'),0o600);
  db.exec(`PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS records (bucket TEXT NOT NULL,id TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(bucket,id));`);
  const seal=value=>{const iv=randomBytes(12);const c=createCipheriv('aes-256-gcm',key,iv);const body=Buffer.concat([c.update(JSON.stringify(value),'utf8'),c.final()]);return Buffer.concat([iv,c.getAuthTag(),body]).toString('base64');};
  const unseal=value=>{const b=Buffer.from(value,'base64');const d=createDecipheriv('aes-256-gcm',key,b.subarray(0,12));d.setAuthTag(b.subarray(12,28));return JSON.parse(Buffer.concat([d.update(b.subarray(28)),d.final()]).toString());};
  return {
    db,
    all:bucket=>db.prepare('SELECT payload FROM records WHERE bucket=?').all(bucket).map(r=>unseal(r.payload)),
    get:(bucket,id)=>{const r=db.prepare('SELECT payload FROM records WHERE bucket=? AND id=?').get(bucket,id);return r?unseal(r.payload):null;},
    put:(bucket,id,value)=>{db.prepare('INSERT INTO records VALUES (?,?,?) ON CONFLICT(bucket,id) DO UPDATE SET payload=excluded.payload').run(bucket,id,seal(value));return value;},
    delete:(bucket,id)=>db.prepare('DELETE FROM records WHERE bucket=? AND id=?').run(bucket,id),
    clear:bucket=>db.prepare('DELETE FROM records WHERE bucket=?').run(bucket),
    close:()=>db.close()
  };
}
