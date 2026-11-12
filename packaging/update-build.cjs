'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),output=path.join(root,'releases'),release=require('../app-release.json'),files=[];
function walk(relative){const absolute=path.join(root,relative),stat=fs.lstatSync(absolute);if(stat.isSymbolicLink())throw new Error('Linked source');if(stat.isDirectory()){for(const name of fs.readdirSync(absolute))walk(relative+'/'+name);}else{const data=fs.readFileSync(absolute);files.push({path:relative,size:data.length,sha256:crypto.createHash('sha256').update(data).digest('hex')});}}
for(const file of require('../app-files.cjs'))walk(file);fs.mkdirSync(output,{recursive:true});
const records=path.join(output,'update-records.json');fs.writeFileSync(records,JSON.stringify(files));
const bundled=path.join(process.env.USERPROFILE||'', '.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe');
const python=fs.existsSync(bundled)?bundled:'python3';
const result=spawnSync(python,['-B',path.join(__dirname,'update_zip.py'),root,records,path.join(output,'PDFViewer-update.zip')],{encoding:'utf8',windowsHide:true});if(result.status!==0)throw new Error(result.stderr||result.stdout);
const archive=fs.readFileSync(path.join(output,'PDFViewer-update.zip'));
const manifest={version:release.version,repository:release.repository,asset:'PDFViewer-update.zip',size:archive.length,sha256:crypto.createHash('sha256').update(archive).digest('hex'),files};
require('../updater.cjs').validateManifest(manifest);fs.writeFileSync(path.join(output,'PDFViewer-update.json'),JSON.stringify(manifest,null,2));fs.unlinkSync(records);
console.log(JSON.stringify({version:release.version,files:files.length,bytes:archive.length,sha256:manifest.sha256}));
