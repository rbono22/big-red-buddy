// Bundle only synthetic demo assets. Does not read configuration, databases, or student records.
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..');
const output=path.resolve(process.argv[2]||path.join(root,'output','public-demo.html'));
const read=name=>readFile(path.join(root,'public',name),'utf8');
const [html,baseCSS,demoCSS,data,js]=await Promise.all(['demo.html','style.css','demo.css','demo-data.js','demo.js'].map(read));
const bundled=html
  .replace('<link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/demo.css">',`<style>${baseCSS}\n${demoCSS}</style>`)
  .replace('<script type="module" src="/demo.js"></script>',`<script>\n${data.replace(/^export /gm,'')}\n${js.replace(/^import .*;\n/,'')}\n</script>`)
  .replaceAll('href="/"','href="https://app.bigredbuddy.com/"');
await mkdir(path.dirname(output),{recursive:true});
await writeFile(output,bundled);
console.log(output);
