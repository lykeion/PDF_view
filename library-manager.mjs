export function initLibraryManager({reloadLibrary,toast}){
 const $=id=>document.getElementById(id);let nodes=[],selected='',busy=false;
 const live=()=>nodes.filter(n=>!n.deleted);
 const children=parent=>live().filter(n=>n.parent===parent).sort((a,b)=>a.order-b.order);
 const descendants=id=>{const found=new Set([id]);for(let i=0;i<24;i++)for(const node of nodes)if(found.has(node.parent))found.add(node.id);return found;};
 async function api(url,options){const response=await fetch(url,options);const result=await response.json();if(!response.ok)throw new Error(result.error||'작업을 완료하지 못했습니다.');return result;}
 function status(message){$('libraryStatus').textContent=message;}
 function render(){
  const list=$('catalogTree');list.replaceChildren();
  function walk(parent,depth){for(const node of children(parent)){const button=document.createElement('button');button.className='catalog-node';button.style.paddingLeft=(12+depth*16)+'px';button.textContent=(node.kind==='folder'?'▸ ':'PDF · ')+node.name;button.setAttribute('aria-pressed',String(selected===node.id));button.onclick=()=>{selected=node.id;render();};list.append(button);if(node.kind==='folder')walk(node.id,depth+1);}}
  walk(null,0);if(!list.children.length)list.textContent='등록된 자료가 없습니다. PDF나 폴더를 추가해 주세요.';
  const node=nodes.find(n=>n.id===selected&&!n.deleted);$('catalogName').value=node?.name||'';
  const select=$('catalogParent');select.replaceChildren(new Option('내 자료 (맨 위)',''));
  const forbidden=node?descendants(node.id):new Set();for(const folder of live().filter(n=>n.kind==='folder'&&!forbidden.has(n.id)))select.add(new Option(folder.name,folder.id));
  select.value=node?.parent||'';
  for(const id of ['catalogSave','catalogUp','catalogDown','catalogRemove'])$(id).disabled=!node||busy;
  $('catalogTrash').replaceChildren();for(const entry of nodes.filter(n=>n.deleted===n.id)){const button=document.createElement('button');button.className='text-button';button.textContent=entry.name+' 복원';button.onclick=()=>edit({action:'restore',id:entry.id});$('catalogTrash').append(button);}
 }
 async function load(){const data=await api('/api/books');nodes=data.nodes;render();}
 async function edit(command){if(busy)return;busy=true;try{await api('/api/books/edit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(command)});await load();await reloadLibrary();status('저장했습니다.');}catch(error){status(error.message);}finally{busy=false;render();}}
 function destination(){const node=nodes.find(n=>n.id===selected&&!n.deleted);return node?.kind==='folder'?node.id:node?.parent||'';}
 async function importFiles(files){if(busy||!files.length)return;busy=true;const parent=destination();let count=0,failed=0;
  try{for(const file of files){if(!/\.pdf$/i.test(file.name))continue;status(`${file.name} 등록 중… (${count+1})`);const query=new URLSearchParams({name:file.name,parent,relative:file.webkitRelativePath||file.name});try{await api('/api/books/import?'+query,{method:'POST',headers:{'Content-Type':'application/pdf'},body:file});count++;}catch(error){failed++;status(error.message);}}await load();await reloadLibrary();status(`PDF ${count}개를 등록했습니다.${failed?` 실패 ${failed}개 — 파일을 확인해 다시 등록해 주세요.`:''}`);}catch(error){status(error.message);}finally{busy=false;render();}}
 $('manageLibrary').onclick=async()=>{$('libraryManager').showModal();try{await load();status('PDF는 전용 자료 폴더에 복사해 보관합니다. 원본 파일은 그대로 유지됩니다.');}catch(error){status(error.message);}};
 $('libraryManagerClose').onclick=()=>{if(!busy)$('libraryManager').close();};$('libraryManager').addEventListener('cancel',event=>{event.stopPropagation();if(busy)event.preventDefault();});
 $('catalogRoot').onclick=()=>{selected='';render();};
 $('catalogAddFolder').onclick=()=>{const name=$('catalogNewFolder').value.trim();if(!name){$('catalogNewFolder').focus();return;}void edit({action:'folder',name,parent:destination()});$('catalogNewFolder').value='';};
 $('catalogSave').onclick=()=>edit({action:'update',id:selected,name:$('catalogName').value,parent:$('catalogParent').value||null});
 $('catalogUp').onclick=()=>edit({action:'move',id:selected,direction:-1});$('catalogDown').onclick=()=>edit({action:'move',id:selected,direction:1});
 $('catalogRemove').onclick=()=>edit({action:'remove',id:selected});
 $('catalogAddPdf').onclick=()=>$('catalogFiles').click();$('catalogAddDirectory').onclick=()=>$('catalogDirectory').click();
 for(const id of ['catalogFiles','catalogDirectory'])$(id).onchange=event=>{const files=[...event.target.files];event.target.value='';void importFiles(files);};
}
