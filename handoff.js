'use strict';
(async () => {
  const parameters = new URLSearchParams(location.search);
  const token = parameters.get('token');
  const mode = parameters.get('mode');
  const message = document.getElementById('message');
  const continueLink = document.getElementById('continue');
  if (!/^[a-f0-9]{64}$/.test(token || '') || !['export', 'import'].includes(mode)) { message.textContent = '이어받기 정보가 없습니다.'; continueLink.hidden = false; return; }
  const base = `/api/handoff/${token}`;
  async function request(action, data, pdf = false) {
    const response = await fetch(`${base}/${action}`, data === undefined ? {cache: 'no-store'} : {method: 'POST', headers: {'Content-Type': pdf ? 'application/pdf' : 'application/json', 'X-Viewer-Handoff': '1'}, body: pdf ? data : JSON.stringify(data)});
    if (!response.ok) throw new Error('이어받기 시간이 지났거나 저장 정보를 읽지 못했습니다.');
    return response;
  }
  function database() {
    return new Promise((resolve, reject) => {
      const operation = indexedDB.open('naranhi-reader', 1);
      operation.onupgradeneeded = () => operation.result.createObjectStore('documents');
      operation.onsuccess = () => resolve(operation.result);
      operation.onerror = () => reject(operation.error);
      operation.onblocked = () => reject(new Error('문서 저장소가 사용 중입니다.'));
    });
  }
  async function readFile() {
    const db = await database();
    try { return await new Promise((resolve, reject) => { const operation = db.transaction('documents').objectStore('documents').get('latest'); operation.onsuccess = () => resolve(operation.result); operation.onerror = () => reject(operation.error); }); }
    finally { db.close(); }
  }
  async function writeFile(file, key) {
    const db = await database();
    try { await new Promise((resolve, reject) => { const transaction = db.transaction('documents', 'readwrite'); transaction.objectStore('documents').put({file, key}, 'latest'); transaction.oncomplete = resolve; transaction.onabort = transaction.onerror = () => reject(transaction.error); }); }
    finally { db.close(); }
  }
  try {
    if (mode === 'export') {
      const storage = {};
      for (const key of ['naranhi-history', 'naranhi-last-document']) { const value = localStorage.getItem(key); if (value !== null) storage[key] = value; }
      const last = JSON.parse(storage['naranhi-last-document'] || 'null');
      let file = null;
      if (last?.type === 'local') {
        const record = await readFile();
        if (!record?.file || record.key !== last.key) throw new Error('마지막 PDF를 읽지 못했습니다. 기존 뷰어의 저장 정보는 그대로 유지됩니다.');
        const pdf = record.file;
        if (pdf.size > 256 * 1024 * 1024) throw new Error('256MB보다 큰 외부 PDF는 새 뷰어에서 다시 선택해 주세요.');
        file = {key: record.key, name: pdf.name, type: pdf.type, size: pdf.size, lastModified: pdf.lastModified};
        await request('file', pdf, true);
      }
      await request('state', {storage, file});
      message.textContent = '읽던 위치를 전달했습니다. 이 창은 닫아도 됩니다.';
      window.close();
    } else {
      const state = await (await request('state')).json();
      // An already-used dedicated profile always wins over the old profile.
      if (localStorage.getItem('naranhi-last-document') === null) {
        if (state.file) {
          const blob = await (await request('file')).blob();
          const file = new File([blob], state.file.name, {type: state.file.type, lastModified: state.file.lastModified});
          if (file.size !== state.file.size) throw new Error('PDF를 모두 받지 못했습니다.');
          await writeFile(file, state.file.key);
        }
        for (const [key, value] of Object.entries(state.storage)) if (localStorage.getItem(key) === null) localStorage.setItem(key, value);
      }
      await request('complete', {});
      location.replace('/');
    }
  } catch (error) {
    message.textContent = `${error.message || '읽던 위치를 이어받지 못했습니다.'} 기존 저장 정보는 삭제하지 않았습니다.`;
    continueLink.hidden = false;
    if (mode === 'import') setTimeout(() => location.replace('/'), 2500);
  }
})();
