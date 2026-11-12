'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const id=()=>crypto.randomBytes(12).toString('hex');
const label=value=>{if(typeof value!=='string'||!value.trim()||value.length>180||/[\x00-\x1f\\/]/.test(value))throw new Error('이름은 1~180자로 입력하고 / 또는 \\ 문자는 제외해 주세요.');return value.trim();};
function createCatalog(appRoot){
 const dataRoot=path.join(appRoot,'user-data'),root=path.join(dataRoot,'books'),metadata=path.join(dataRoot,'catalog.json');let queue=Promise.resolve();
 async function ensure(){for(const dir of [dataRoot,root]){await fs.mkdir(dir,{recursive:true});if((await fs.lstat(dir)).isSymbolicLink())throw new Error('자료 폴더에 링크를 사용할 수 없습니다.');}}
 async function read(){try{const data=JSON.parse(await fs.readFile(metadata,'utf8'));if(data.version!==1||!Array.isArray(data.nodes))throw new Error();return data;}catch(error){if(error.code==='ENOENT')return{version:1,nodes:[]};throw new Error('책장 정보를 읽지 못했습니다. catalog.json을 확인해 주세요.');}}
 async function write(data){await ensure();const temp=metadata+'.tmp';await fs.writeFile(temp,JSON.stringify(data,null,2));await fs.rename(temp,metadata);}
 function mutate(action){const result=queue.then(async()=>{const data=await read();const value=await action(data);await write(data);return value;});queue=result.catch(()=>{});return result;}
 function parent(data,value){if(value===null||value==='')return null;const node=data.nodes.find(n=>n.id===value&&!n.deleted&&n.kind==='folder');if(!node)throw new Error('대상 폴더를 찾지 못했습니다.');return node.id;}
 function position(data,parentId){return Math.max(0,...data.nodes.filter(n=>n.parent===parentId&&!n.deleted).map(n=>n.order||0))+1;}
 function depth(data,parentId){let level=0,current=parentId;while(current){if(++level>24)throw new Error('폴더 깊이는 최대 24단계입니다.');current=data.nodes.find(n=>n.id===current)?.parent;}return level;}
 function descendants(data,nodeId){const result=new Set([nodeId]);for(let i=0;i<24;i++){let added=false;for(const n of data.nodes)if(result.has(n.parent)&&!result.has(n.id)){result.add(n.id);added=true;}if(!added)return result;}throw new Error('폴더 깊이는 최대 24단계입니다.');}
 function siblings(data,parentId){return data.nodes.filter(n=>n.parent===parentId&&!n.deleted).sort((a,b)=>a.order-b.order||a.name.localeCompare(b.name,'ko',{numeric:true}));}
 async function list(){const data=await read();return{nodes:data.nodes.map(n=>({...n})),storage:'user-data/books'};}
 async function edit(command){return mutate(async data=>{
  if(data.nodes.length>10000)throw new Error('등록 가능한 항목 수를 초과했습니다.');
  if(command.action==='folder'){const parentId=parent(data,command.parent??null);if(depth(data,parentId)>=24)throw new Error('폴더 깊이는 최대 24단계입니다.');const node={id:id(),kind:'folder',name:label(command.name),parent:parentId,order:position(data,parentId)};data.nodes.push(node);return node;}
  const node=data.nodes.find(n=>n.id===command.id);if(!node)throw new Error('항목을 찾지 못했습니다.');
  if(command.action==='remove'){const affected=descendants(data,node.id);for(const n of data.nodes)if(affected.has(n.id)&&!n.deleted)n.deleted=node.id;return{removed:true};}
  if(command.action==='restore'){for(const n of data.nodes)if(n.deleted===node.id)delete n.deleted;if(node.parent&&data.nodes.find(n=>n.id===node.parent)?.deleted)node.parent=null;return{restored:true};}
  if(node.deleted)throw new Error('삭제된 항목입니다. 먼저 복원해 주세요.');
  if(command.action==='update'){
   const name=label(command.name),target=parent(data,command.parent??null);
   if(target&&descendants(data,node.id).has(target))throw new Error('자기 자신 또는 하위 폴더로 이동할 수 없습니다.');
   const affected=descendants(data,node.id),oldDepth=depth(data,node.parent),extra=Math.max(1,...data.nodes.filter(n=>affected.has(n.id)).map(n=>depth(data,n.parent)-oldDepth+1));if(depth(data,target)+extra>24)throw new Error('폴더 깊이는 최대 24단계입니다.');
   if(target!==node.parent){node.order=position(data,target);node.parent=target;}node.name=name;return node;
  }
  if(command.action==='move'){const items=siblings(data,node.parent),index=items.findIndex(n=>n.id===node.id),next=index+(command.direction===-1?-1:1);if(next>=0&&next<items.length){[items[index],items[next]]=[items[next],items[index]];items.forEach((n,i)=>n.order=i+1);}return{moved:true};}
  throw new Error('지원하지 않는 편집 작업입니다.');
 });}
 async function importFile(req,query){
  await ensure();const fileId=id(),temp=path.join(root,fileId+'.part'),target=path.join(root,fileId+'.pdf');let size=0,head=Buffer.alloc(0),handle;
  const name=label(query.get('name')||''),relative=query.get('relative')||name;
  if(!/\.pdf$/i.test(name)||relative.length>2000)throw new Error('PDF 파일만 등록할 수 있습니다.');
  const folders=relative.split('/').slice(0,-1);if(folders.length>20||folders.some(part=>part==='.'||part==='..'||label(part)!==part))throw new Error('폴더 경로를 확인해 주세요.');
  try{
   handle=await fs.open(temp,'wx');for await(const chunk of req){size+=chunk.length;if(size>1024*1024*1024)throw new Error('파일은 1GB 이하로 등록해 주세요.');if(head.length<1024)head=Buffer.concat([head,chunk]).subarray(0,1024);await handle.write(chunk);}
   await handle.close();handle=null;if(!head.includes(Buffer.from('%PDF-')))throw new Error('유효한 PDF 파일이 아닙니다.');await fs.rename(temp,target);
   return await mutate(async data=>{
    if(data.nodes.length+folders.length>=10000)throw new Error('등록 가능한 항목 수를 초과했습니다.');
    let parentId=parent(data,query.get('parent')||null);
    if(depth(data,parentId)+folders.length>24)throw new Error('폴더 깊이는 최대 24단계입니다.');
    for(const folder of folders){let entry=data.nodes.find(n=>!n.deleted&&n.kind==='folder'&&n.parent===parentId&&n.name===folder);if(!entry){entry={id:id(),kind:'folder',name:folder,parent:parentId,order:position(data,parentId)};data.nodes.push(entry);}parentId=entry.id;}
    const node={id:fileId,kind:'file',name,parent:parentId,order:position(data,parentId),size,modified:Date.now()};data.nodes.push(node);return node;
   });
  }catch(error){await handle?.close().catch(()=>{});await Promise.all([temp,target].map(file=>fs.unlink(file).catch(()=>{})));throw error;}
 }
 async function library(){const data=await read(),files=[],folders=[];function walk(parentId,prefix,depth){if(depth>24)return;for(const node of siblings(data,parentId)){const relativePath=prefix+node.name;if(node.kind==='folder'){folders.push(relativePath);walk(node.id,relativePath+'/',depth+1);}else files.push({id:node.id,name:/\.pdf$/i.test(node.name)?node.name:node.name+'.pdf',relativePath:relativePath+( /\.pdf$/i.test(node.name)?'':'.pdf'),size:node.size,modified:node.modified,group:'내 자료',custom:true});}}walk(null,'',0);return{name:'내 자료',files,folders,custom:true};}
 async function resolve(fileId){if(!/^[a-f0-9]{24}$/.test(fileId||''))return null;const data=await read();if(!data.nodes.some(n=>n.id===fileId&&n.kind==='file'&&!n.deleted))return null;const file=path.join(root,fileId+'.pdf');if((await fs.lstat(file)).isSymbolicLink())return null;return file;}
 const reply=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
 async function handler(req,res,url){
  if(!url.pathname.startsWith('/api/books'))return false;
  if(url.pathname==='/api/books'&&req.method==='GET'){reply(res,200,await list());return true;}
  if(req.method!=='POST'||!['http://127.0.0.1:43187','http://localhost:43187'].includes(req.headers.origin)){req.resume();reply(res,403,{error:'잘못된 책장 요청입니다.'});return true;}
  try{
   if(url.pathname==='/api/books/import'){reply(res,200,await importFile(req,url.searchParams));return true;}
   if(url.pathname!=='/api/books/edit'||!req.headers['content-type']?.startsWith('application/json'))throw new Error('잘못된 책장 요청입니다.');
   let body='';for await(const chunk of req){body+=chunk;if(body.length>8000)throw new Error('요청이 너무 큽니다.');}reply(res,200,await edit(JSON.parse(body)));
  }catch(error){req.resume();reply(res,400,{error:error.message});}return true;
 }
 return{list,edit,library,resolve,handler};
}
module.exports={createCatalog};
