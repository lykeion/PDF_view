'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {execFile}=require('node:child_process');
function validateProject(data){
 const name=typeof data?.name==='string'?data.name.trim():'';
 const url=new URL(data?.url);
 if(!name||name.length>100||url.origin!=='https://chatgpt.com'||url.username||url.password||!/^\/g\/g-p-[a-zA-Z0-9_-]+\/project\/?$/.test(url.pathname)||url.search||url.hash)throw new Error('Invalid project');
 return{name,url:url.href.replace(/\/$/,'')};
}
function validateDraft(data){
 if(!data||typeof data.question!=='string'||!data.question.trim()||data.question.length>12000||typeof data.source!=='string'||data.source.length>500||!Number.isSafeInteger(data.page)||data.page<1)throw new Error('Invalid question');
 if(typeof data.image!=='string'||data.image.length>16_000_000||!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(data.image))throw new Error('Invalid image');
 const png=Buffer.from(data.image.slice(22),'base64');
 if(png.length<33||png.subarray(0,8).toString('hex')!=='89504e470d0a1a0a'||png.toString('ascii',12,16)!=='IHDR')throw new Error('Invalid PNG');
 const width=png.readUInt32BE(16),height=png.readUInt32BE(20);
 if(!width||!height||width>4096||height>4096||width*height>8_000_000)throw new Error('Image too large');
 return{png,prompt:`[${data.source} · PDF ${data.page}페이지의 선택 영역]\n\n${data.question.trim()}`};
}
function nativeDraft(job){
 const powershell=path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
 return new Promise((resolve,reject)=>execFile(powershell,['-NoLogo','-NoProfile','-NonInteractive','-STA','-ExecutionPolicy','Bypass','-File',path.join(__dirname,'gpt-browser.ps1'),'-Job',job],{windowsHide:true,timeout:65000,maxBuffer:16384,encoding:'utf8'},(error,output)=>{if(error)return reject(error);try{resolve(JSON.parse(output.replace(/^\uFEFF/,'').trim()));}catch{reject(new Error('Invalid response'));}}));
}
function createGptDraftHandler(launch=nativeDraft,root=path.join(__dirname,'.gpt-transfer')){
 let busy=false;
 const reply=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
 return async(req,res,url)=>{
  if(url.pathname==='/api/gpt/project'&&req.method==='GET'){
   try{reply(res,200,validateProject(JSON.parse(await fs.readFile(path.join(root,'..','gpt-project-settings.json'),'utf8'))));}catch{reply(res,200,{name:'유관사 질문',url:''});}return true;
  }
  if(url.pathname!=='/api/gpt/draft')return false;
  if(req.method!=='POST'||!['http://127.0.0.1:43187','http://localhost:43187'].includes(req.headers.origin)||!req.headers['content-type']?.startsWith('application/json')){req.resume();reply(res,403,{error:'Invalid draft request'});return true;}
  if(busy){req.resume();reply(res,409,{error:'이미 다른 질문을 준비하고 있습니다.'});return true;}
  busy=true;let job,image;
  try{
   const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>16_020_000)throw new Error('Too large');chunks.push(chunk);}
   const raw=JSON.parse(Buffer.concat(chunks).toString('utf8'));
   const draft=validateDraft(raw);
   let project=null;
   if(raw.project){project=validateProject(raw.project);}
   else{try{project=validateProject(JSON.parse(await fs.readFile(path.join(root,'..','gpt-project-settings.json'),'utf8')));}catch{}}
   await fs.mkdir(root,{recursive:true});const id=crypto.randomBytes(16).toString('hex');image=path.join(root,id+'.png');job=path.join(root,id+'.json');
   await fs.writeFile(image,draft.png);await fs.writeFile(job,JSON.stringify({imagePath:image,prompt:draft.prompt,project}));
   if(project&&raw.project)await fs.writeFile(path.join(root,'..','gpt-project-settings.json'),JSON.stringify(project));
   reply(res,200,await launch(job));
  }catch{reply(res,400,{error:'ChatGPT에 질문을 준비하지 못했습니다.'});}
  finally{await Promise.all([job,image].filter(Boolean).map(file=>fs.unlink(file).catch(()=>{})));busy=false;}
  return true;
 };
}
module.exports={validateDraft,validateProject,createGptDraftHandler};
