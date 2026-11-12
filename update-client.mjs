export function initUpdateClient({beforeRestart,toast}){
 const $=id=>document.getElementById(id);let busy=false;
 const message=text=>$('updateStatus').textContent=text;
 async function request(action){const response=await fetch('/api/update/'+action,{method:'POST'});const data=await response.json();if(!response.ok)throw new Error(data.error||'업데이트를 확인하지 못했습니다.');return data;}
 async function check(){try{const data=await request('check');$('updateCurrent').textContent=data.current;$('updateInstall').disabled=!data.available;message(data.available?`새 버전 ${data.latest}을 받을 수 있습니다.`:'최신 버전입니다.');if(data.available)$('showUpdate').classList.add('update-available');return data;}catch(error){message(error.message);}}
 $('showUpdate').onclick=async()=>{$('updateDialog').showModal();try{const data=await(await fetch('/api/update/status')).json();$('updateCurrent').textContent=data.current;$('updateRepository').textContent=data.repository;}catch{};await check();};
 $('updateClose').onclick=()=>{if(!busy)$('updateDialog').close();};$('updateDialog').addEventListener('cancel',event=>{event.stopPropagation();if(busy)event.preventDefault();});
 $('updateCheck').onclick=check;
 $('updateInstall').onclick=async()=>{
  if(busy)return;busy=true;for(const id of ['updateInstall','updateCheck','updateClose'])$(id).disabled=true;beforeRestart();message('업데이트를 다운로드하고 검증합니다…');
  const timer=setInterval(async()=>{try{const data=await(await fetch('/api/update/status',{cache:'no-store'})).json();if(data.message)message(data.message);}catch{}},1000);
  try{const result=await request('install');if(!result.scheduled){message('최신 버전입니다.');return;}message('프로그램을 다시 시작합니다. 이 창을 닫지 말고 기다려 주세요.');
   for(let i=0;i<100;i++){await new Promise(resolve=>setTimeout(resolve,750));try{const response=await fetch('/api/health',{cache:'no-store'});const health=await response.json();if(health.release===result.version){location.reload();return;}if(i>5){const status=await(await fetch('/api/update/status',{cache:'no-store'})).json();if(status.phase==='error'){message(status.message);return;}}}catch{}}
   message('다시 시작하는 데 시간이 걸리고 있습니다. 뷰어를 닫았다가 다시 실행해 주세요.');
  }catch(error){message(error.message);}finally{clearInterval(timer);busy=false;$('updateCheck').disabled=false;$('updateClose').disabled=false;}
 };
 // Check once at startup, but leave installation to an explicit button press.
 setTimeout(async()=>{try{const data=await request('check');if(data.available){$('showUpdate').classList.add('update-available');$('showUpdate').title=`새 버전 ${data.latest}`;}}catch{}},5000);
}
