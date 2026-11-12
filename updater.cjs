'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {spawn}=require('node:child_process');
const release=require('./app-release.json');
function compareVersions(a,b){const parse=value=>{if(!/^v?\d+(?:\.\d+){2,4}$/.test(value))throw new Error('잘못된 버전 형식입니다.');return value.replace(/^v/,'').split('.').map(Number);};const x=parse(a),y=parse(b);for(let i=0;i<Math.max(x.length,y.length);i++){if((x[i]||0)!==(y[i]||0))return(x[i]||0)>(y[i]||0)?1:-1;}return 0;}
function safeUpdatePath(value){if(typeof value!=='string'||value.includes('\\')||value.split('/').some(part=>!part||part==='.'||part==='..'||part.startsWith('.'))||value.includes(':'))return false;return require('./app-files.cjs').filter(p=>p!=='vendor').includes(value)||/^[a-z][a-z0-9.-]*\.(mjs|cjs|js|ps1|html|css|svg|ico)$/.test(value)||/^vendor\/[A-Za-z0-9_./-]+$/.test(value);}
function validateManifest(data){
 if(!data||compareVersions(data.version,'0.0.0')<=0||data.asset!=='PDFViewer-update.zip'||!/^([a-f0-9]{64})$/.test(data.sha256)||!Number.isSafeInteger(data.size)||data.size<1||data.size>100_000_000||!Array.isArray(data.files)||data.files.length>3000)throw new Error('업데이트 목록을 검증하지 못했습니다.');
 const seen=new Set();let total=0;for(const file of data.files){if(!safeUpdatePath(file.path)||seen.has(file.path.toLowerCase())||!Number.isSafeInteger(file.size)||file.size<0||!/^([a-f0-9]{64})$/.test(file.sha256))throw new Error('허용되지 않은 업데이트 파일입니다.');seen.add(file.path.toLowerCase());total+=file.size;}
 if(total>250_000_000||!['server.cjs','app.js','app-release.json','update-apply.ps1'].every(name=>seen.has(name)))throw new Error('업데이트 필수 파일을 확인하지 못했습니다.');return data;
}
async function githubDownload(value,limit){
 let url=new URL(value);for(let attempt=0;attempt<6;attempt++){
  if(url.protocol!=='https:'||url.username||url.password||!['api.github.com','github.com','release-assets.githubusercontent.com','objects.githubusercontent.com'].includes(url.hostname))throw new Error('GitHub 이외의 다운로드 주소입니다.');
  const response=await fetch(url,{redirect:'manual',headers:{'User-Agent':'PDFViewer-Updater','Accept':'application/vnd.github+json'},signal:AbortSignal.timeout(90000)});
  if([301,302,303,307,308].includes(response.status)){url=new URL(response.headers.get('location'),url);continue;}
  if(!response.ok)throw new Error(response.status===404?'게시된 업데이트가 아직 없습니다.':`GitHub 연결 오류 (${response.status})`);
  if(Number(response.headers.get('content-length'))>limit)throw new Error('업데이트 파일이 너무 큽니다.');
  const chunks=[];let size=0;for await(const chunk of response.body){size+=chunk.length;if(size>limit)throw new Error('다운로드 크기를 초과했습니다.');chunks.push(chunk);}return Buffer.concat(chunks);
 }throw new Error('다운로드 주소가 너무 많이 변경됐습니다.');
}
function createUpdater(appRoot,{download=githubDownload,apply=launchApply}={}){
 let latest=null,busy=false,state={phase:'idle',message:''};
 const reply=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
 async function lastFailure(){try{const root=path.join(appRoot,'.updates'),items=[];for(const name of await fs.readdir(root)){if(!/^[a-f0-9]{24}$/.test(name))continue;const dir=path.join(root,name),stat=await fs.lstat(dir);if(stat.isDirectory()&&!stat.isSymbolicLink())items.push({dir,time:stat.mtimeMs});}items.sort((a,b)=>b.time-a.time);for(const item of items){try{const result=JSON.parse((await fs.readFile(path.join(item.dir,'result.json'),'utf8')).replace(/^\uFEFF/,''));if(result.success)return null;if(result.version&&compareVersions(result.version,release.version)>0)return{phase:'error',message:'업데이트에 실패해 이전 버전으로 복원했습니다. 다시 확인 후 시도해 주세요.'};return null;}catch{}}}catch{}return null;}
 async function check(){
  const info=JSON.parse((await download(`https://api.github.com/repos/${release.repository}/releases/latest`,2_000_000)).toString());
  const metadata=info.assets?.find(asset=>asset.name==='PDFViewer-update.json');if(!metadata)throw new Error('이 릴리스에 업데이트 파일이 없습니다.');
  const manifest=validateManifest(JSON.parse((await download(metadata.browser_download_url,2_000_000)).toString()));
  if(compareVersions(manifest.version,info.tag_name)!==0)throw new Error('릴리스와 파일 버전이 일치하지 않습니다.');
  const asset=info.assets.find(asset=>asset.name===manifest.asset);if(!asset||asset.size!==manifest.size)throw new Error('업데이트 파일 크기가 일치하지 않습니다.');
  latest={manifest,url:asset.browser_download_url};return{current:release.version,latest:manifest.version,available:compareVersions(manifest.version,release.version)>0,repository:release.repository};
 }
 async function install(){
  if(busy)throw new Error('업데이트를 처리 중입니다.');busy=true;
  try{
   state={phase:'checking',message:'업데이트 확인 중…'};const info=await check();if(!info.available){state={phase:'idle',message:'최신 버전입니다.'};return{scheduled:false,...info};}
   state={phase:'downloading',message:'프로그램 파일을 내려받고 있습니다…'};
   const archive=await download(latest.url,100_000_000);if(archive.length!==latest.manifest.size||crypto.createHash('sha256').update(archive).digest('hex')!==latest.manifest.sha256)throw new Error('업데이트 파일 무결성 검사에 실패했습니다.');
   const root=path.join(appRoot,'.updates');await fs.mkdir(root,{recursive:true});if((await fs.lstat(root)).isSymbolicLink())throw new Error('업데이트 폴더가 링크입니다.');
   const directory=path.join(root,crypto.randomBytes(12).toString('hex'));await fs.mkdir(directory);
   await fs.writeFile(path.join(directory,'update.zip'),archive);await fs.writeFile(path.join(directory,'manifest.json'),JSON.stringify(latest.manifest));
   await fs.copyFile(path.join(appRoot,'update-apply.ps1'),path.join(directory,'apply.ps1'));
   const job={root:appRoot,directory,serverPid:process.pid,node:process.execPath,version:latest.manifest.version,allowed:require('./app-files.cjs')};await fs.writeFile(path.join(directory,'job.json'),JSON.stringify(job));
   await apply(path.join(directory,'apply.ps1'),path.join(directory,'job.json'));
   state={phase:'restarting',message:'파일 검증 후 프로그램을 다시 시작합니다…'};return{scheduled:true,version:latest.manifest.version};
  }catch(error){state={phase:'error',message:error.message};throw error;}finally{busy=false;}
 }
 async function handler(req,res,url){
  if(!url.pathname.startsWith('/api/update'))return false;
  if(req.method==='GET'&&url.pathname==='/api/update/status'){reply(res,200,{...state,...(state.phase==='idle'?await lastFailure():null),current:release.version,repository:release.repository});return true;}
  if(req.method!=='POST'||!['http://127.0.0.1:43187','http://localhost:43187'].includes(req.headers.origin)){req.resume();reply(res,403,{error:'잘못된 업데이트 요청입니다.'});return true;}
  req.resume();try{if(url.pathname==='/api/update/check')reply(res,200,await check());else if(url.pathname==='/api/update/install')reply(res,200,await install());else reply(res,404,{error:'Not found'});}catch(error){reply(res,400,{error:error.message});}return true;
 }
 return{handler,check,install};
}
function launchApply(script,job){return new Promise((resolve,reject)=>{const powershell=path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');const child=spawn(powershell,['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script,'-Job',job],{detached:true,windowsHide:true,stdio:'ignore'});child.once('error',reject);child.once('spawn',()=>{child.unref();resolve();});});}
module.exports={createUpdater,compareVersions,safeUpdatePath,validateManifest};
