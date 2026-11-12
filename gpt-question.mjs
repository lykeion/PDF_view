export function initGptQuestion({capture,toast,hasDocument}) {
  const $ = id => document.getElementById(id);
  let selecting=false,drag=null,selection=null,blobUrl='',busy=false;
  fetch('/api/gpt/project',{cache:'no-store'}).then(response=>response.json()).then(project=>{if(project.name)$('gptProjectName').value=project.name;if(project.url)$('gptProjectUrl').value=project.url;$('gptProjectLabel').textContent=$('gptProjectName').value;}).catch(()=>{});
  $('gptProjectName').oninput=()=>{$('gptProjectLabel').textContent=$('gptProjectName').value;};
  const box=document.createElement('div');box.className='gpt-selection-box';box.hidden=true;document.body.append(box);
  function stopSelection(){selecting=false;drag=null;box.hidden=true;document.body.classList.remove('gpt-selecting');$('gptSelect').setAttribute('aria-pressed','false');}
  function start(){if(!hasDocument())return;stopSelection();$('gptDialog').close();selecting=true;document.body.classList.add('gpt-selecting');$('gptSelect').setAttribute('aria-pressed','true');toast('질문할 부분을 한 페이지 안에서 드래그하세요. Esc로 취소합니다.');}
  function bounds(event,rect){return{x:Math.max(rect.left,Math.min(rect.right,event.clientX)),y:Math.max(rect.top,Math.min(rect.bottom,event.clientY))};}
  function area(drag){return{x:Math.min(drag.start.x,drag.end.x),y:Math.min(drag.start.y,drag.end.y),width:Math.abs(drag.end.x-drag.start.x),height:Math.abs(drag.end.y-drag.start.y)};}
  $('gptSelect').onclick=start;$('gptReselect').onclick=start;
  document.addEventListener('keydown',event=>{if(selecting&&event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();stopSelection();}},true);
  $('viewport').addEventListener('pointerdown',event=>{
    if(!selecting||event.button!==0)return;
    const frame=event.target.closest('.page-content');if(!frame)return;
    event.preventDefault();event.stopPropagation();
    const rect=frame.getBoundingClientRect(),point=bounds(event,rect);
    drag={frame,rect,start:point,end:point,id:event.pointerId};$('viewport').setPointerCapture(event.pointerId);
  },true);
  $('viewport').addEventListener('pointermove',event=>{
    if(!drag)return;drag.end=bounds(event,drag.rect);const a=area(drag);box.hidden=false;
    Object.assign(box.style,{left:a.x+'px',top:a.y+'px',width:a.width+'px',height:a.height+'px'});
  });
  $('viewport').addEventListener('pointercancel',stopSelection);
  $('viewport').addEventListener('wheel',event=>{if(selecting){event.preventDefault();event.stopImmediatePropagation();}},{capture:true,passive:false});
  document.addEventListener('reader-rendered',()=>{if(selecting)stopSelection();});
  $('viewport').addEventListener('pointerup',async event=>{
    if(!drag)return;const current=drag;current.end=bounds(event,current.rect);const a=area(current);stopSelection();
    if(a.width<12||a.height<12){toast('영역을 조금 더 크게 선택해 주세요.');return;}
    try {
      selection=await capture(current.frame,{x:(a.x-current.rect.x)/current.rect.width,y:(a.y-current.rect.y)/current.rect.height,width:a.width/current.rect.width,height:a.height/current.rect.height});
      if(blobUrl)URL.revokeObjectURL(blobUrl);blobUrl=URL.createObjectURL(selection.blob);$('gptPreview').src=blobUrl;
      $('gptSource').textContent=`${selection.name} · ${selection.page}페이지 · ${selection.width} × ${selection.height}`;
      $('gptStatus').textContent='이미지와 질문을 ChatGPT 입력란에 준비합니다. 전송은 직접 눌러 주세요.';
      $('gptDialog').showModal();$('gptQuestion').focus();
    }catch{toast('선택 영역을 가져오지 못했습니다. 페이지 로딩이 끝난 뒤 다시 선택해 주세요.');}
  });
  for(const button of document.querySelectorAll('[data-gpt-question]'))button.onclick=()=>{$('gptQuestion').value=button.dataset.gptQuestion;$('gptQuestion').focus();};
  $('gptClose').onclick=()=>{if(!busy)$('gptDialog').close();};
  $('gptDialog').addEventListener('cancel',event=>{event.stopPropagation();if(busy)event.preventDefault();});
  async function imageData(){return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=reject;reader.readAsDataURL(selection.blob);});}
  $('gptCopyImage').onclick=async()=>{try{await navigator.clipboard.write([new ClipboardItem({'image/png':selection.blob})]);$('gptStatus').textContent='선택 이미지가 복사됐습니다.';}catch{toast('이미지 복사가 허용되지 않았습니다.');}};
  $('gptCopyQuestion').onclick=async()=>{try{await navigator.clipboard.writeText($('gptQuestion').value);$('gptStatus').textContent='질문이 복사됐습니다.';}catch{toast('질문 복사가 허용되지 않았습니다.');}};
  $('gptOpen').onclick=async()=>{
    if(busy||!selection)return;
    const question=$('gptQuestion').value.trim();if(!question){$('gptQuestion').focus();return;}
    const project={name:$('gptProjectName').value.trim(),url:$('gptProjectUrl').value.trim()};
    if(!project.name||!project.url){document.querySelector('.gpt-project').open=true;$('gptProjectUrl').focus();$('gptStatus').textContent='연결할 ChatGPT 프로젝트 이름과 주소를 입력해 주세요.';return;}
    busy=true;$('gptOpen').disabled=true;$('gptClose').disabled=true;$('gptReselect').disabled=true;
    $('gptStatus').textContent='ChatGPT 창을 열고 입력란을 찾고 있습니다… 창이 열리면 잠시 기다려 주세요.';
    try{
      const response=await fetch('/api/gpt/draft',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({image:await imageData(),question,source:selection.name,page:selection.page,project})});
      const result=await response.json();if(!response.ok)throw new Error(result.error||'연결하지 못했습니다.');
      const reasons={'login-or-composer-unavailable':'프로젝트 입력란을 찾지 못했습니다. Chrome의 로그인 상태와 프로젝트 이름·주소를 확인해 주세요.','draft-not-empty':'프로젝트에 작성 중인 질문이 있어 덮어쓰지 않았습니다. 기존 질문을 전송하거나 비운 뒤 다시 눌러 주세요.','image-unverified':'이미지 첨부가 확인되지 않았습니다. Chrome 화면을 확인한 뒤 이미지 복사를 사용해 주세요.','input-unverified':'입력 결과를 확인하지 못했습니다. Chrome의 질문 내용을 확인해 주세요.'};
      $('gptStatus').textContent=result.prepared?'ChatGPT 프로젝트에 이미지와 질문을 입력했습니다. 내용을 확인하고 전송해 주세요.':reasons[result.reason]||'자동 입력을 완료하지 못했습니다. ChatGPT 창을 확인한 뒤 다시 시도하거나 아래 복사 버튼을 사용해 주세요.';
    }catch(error){$('gptStatus').textContent=error.message+' 뷰어를 다시 실행한 뒤 시도해 주세요.';}
    finally{busy=false;$('gptOpen').disabled=false;$('gptClose').disabled=false;$('gptReselect').disabled=false;}
  };
}
