import * as pdfjs from './vendor/pdf.min.mjs';
import {spreadStart, spreadPages, calculateViewportLayout} from './layout.mjs';
import {DisplayRasterizer} from './display-raster.mjs';
import {detectPageMargins, resolveMargins} from './margin-crop.mjs';
import {WheelPageNavigator} from './wheel-navigation.mjs';
import {initGptQuestion} from './gpt-question.mjs';
import {initLibraryManager} from './library-manager.mjs';
import {initUpdateClient} from './update-client.mjs';

pdfjs.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdf.worker.min.mjs', import.meta.url).href;
const $ = id => document.getElementById(id);
const wheelNavigation = new WheelPageNavigator();
let readerWindowTitle = 'PDF 뷰어', nativeTitlePending = false;
function setDocumentTitle(name = '') {
  readerWindowTitle = name ? `${name} — PDF 뷰어` : 'PDF 뷰어';
  if (!nativeTitlePending) document.title = readerWindowTitle;
}
const readerPanels = ['color','fit','more'];
const panelTrigger = name => $(name+'Toggle');
function closeReaderPanels() {
  for (const name of readerPanels) { $(name+'Panel').hidden = true; panelTrigger(name).setAttribute('aria-expanded','false'); }
}
function openReaderPanel(name) {
  closeReaderPanels(); $(name+'Panel').hidden = false;
  panelTrigger(name).setAttribute('aria-expanded','true');
  positionReaderPanel(name);
}
function positionReaderPanel(name) {
  const panel = $(name+'Panel'), button = panelTrigger(name);
  const anchor = button.getBoundingClientRect(), bar = button.closest('.reader-toolbar').getBoundingClientRect();
  const top = Math.min(bar.bottom + 8, window.innerHeight - 100);
  panel.style.top = `${Math.max(8,top)}px`;
  panel.style.maxHeight = `${window.innerHeight - Math.max(8,top) - 10}px`;
  panel.style.left = `${Math.max(8,Math.min(window.innerWidth - panel.offsetWidth - 8,anchor.right - panel.offsetWidth))}px`;
  panel.style.right = 'auto';
}
const colorPresets = {dim: {background:'#2d3035', text:'#c4c6cc', strength:45}, warm: {background:'#35312d', text:'#ccc4b8', strength:40}};
function validPalette(value) {
  if (!value || !/^#[0-9a-f]{6}$/i.test(value.background) || !/^#[0-9a-f]{6}$/i.test(value.text) || !Number.isFinite(value.strength)) return null;
  return {background:value.background,text:value.text,strength:Math.min(80,Math.max(0,value.strength))};
}
let readerColors = {preset:'dim', ...colorPresets.dim};
try {
  const saved = JSON.parse(localStorage.getItem('naranhi-colors') || 'null');
  const palette = validPalette(saved);
  if (palette && ['original','dim','warm','custom'].includes(saved.preset)) {
    readerColors = {preset:saved.preset,...palette};
  }
} catch {}
// Keep the user's palette separate from the active preset. Seed older installs
// before a preset switch can replace their currently saved manual colors.
let customColors = validPalette(readerColors);
try {
  const saved = validPalette(JSON.parse(localStorage.getItem('naranhi-custom-colors') || 'null'));
  if (saved) customColors = saved;
  else localStorage.setItem('naranhi-custom-colors',JSON.stringify(customColors));
} catch {}
if (readerColors.preset === 'custom') readerColors = {preset:'custom',...customColors};
const rgb = hex => [1,3,5].map(index => parseInt(hex.slice(index,index+2),16) / 255);
function applyReaderColors(save = true) {
  const enabled = readerColors.preset !== 'original';
  const background = rgb(readerColors.background), foreground = rgb(readerColors.text);
  const luminance = [.2126,.7152,.0722], saturation = readerColors.strength / 100;
  // Map white paper and black ink to the selected colors. Keep a muted share of
  // the original chroma, so colored headings/highlights retain their hue family.
  const rows = foreground.flatMap((value, row) => [
    ...luminance.map((weight, column) => (background[row] - value) * weight + saturation * ((row === column ? 1 : 0) - weight)), 0, value
  ]);
  $('readerColorMatrix').setAttribute('values', [...rows,0,0,0,1,0].join(' '));
  document.body.classList.toggle('soft-colors', enabled);
  document.documentElement.style.setProperty('--reader-paper', readerColors.background);
  document.documentElement.style.setProperty('--reader-text', readerColors.text);
  $('colorPreset').value = readerColors.preset;
  $('colorQuickPreset').value = readerColors.preset;
  $('colorQuickPreset').title = '문서 색상 선택';
  $('paperColor').value = readerColors.background; $('textColor').value = readerColors.text;
  $('accentStrength').value = readerColors.strength; $('accentValue').textContent = `${readerColors.strength}%`;
  $('colorSettings').disabled = false;
  $('colorPreview').style.background = enabled ? readerColors.background : '#fff';
  $('colorPreview').style.color = enabled ? readerColors.text : '#222';
  const sourceAccent = [.2,.42,.7];
  const accent = foreground.map((_, row) => Math.round(255 * Math.min(1, Math.max(0, rows[row * 5 + 4] + sourceAccent.reduce((sum, channel, column) => sum + channel * rows[row * 5 + column],0)))));
  $('colorPreview').querySelector('b').style.color = enabled ? `rgb(${accent.join(',')})` : '#336bb3';
  if (save) {
    if (readerColors.preset === 'custom') {
      customColors = validPalette(readerColors);
      try { localStorage.setItem('naranhi-custom-colors',JSON.stringify(customColors)); } catch {}
    }
    try { localStorage.setItem('naranhi-colors', JSON.stringify(readerColors)); } catch {}
  }
}
applyReaderColors(false);
const state = {pdf: null, loadingTask: null, documentId: 0, renderId: 0, page: 1, mode: 'spread',
  normalize: 'frame', cover: false, zoom: 1, fit: 'page', rotation: 0,
  reference: {width: 730, height: 1000}, key: '', name: '', library: [], fileId: '',
  cache: new Map(), tasks: new Set(), textLayers: new Set(), pages: new Map(),
  prefetchTimer: 0, renderTimer: 0, currentLayout: null, pendingPassword: null};
try {
  const saved=JSON.parse(localStorage.getItem('naranhi-viewing-settings')||'null');
  if(saved){
    if(['single','spread'].includes(saved.mode))state.mode=saved.mode;
    if(['frame','height','original'].includes(saved.normalize))state.normalize=saved.normalize;
    if(typeof saved.cover==='boolean')state.cover=saved.cover;
  }
}catch{}
function saveViewingSettings(){
  try{localStorage.setItem('naranhi-viewing-settings',JSON.stringify({mode:state.mode,normalize:state.normalize,cover:state.cover}));}catch{}
}
const MAX_CACHE_PIXELS = 48_000_000;
const MAX_PAGE_PIXELS = 24_000_000;
const displayRasterizer = new DisplayRasterizer();
const displayViews = new Map(), refinedCache = new Map();
const MAX_REFINED_PIXELS = 8_000_000;
let refinementTimer, refinementRevision = 0, sharpness = 25;
try {
  const saved = JSON.parse(localStorage.getItem('naranhi-sharpness') || '25');
  if (Number.isFinite(saved)) sharpness = Math.min(100, Math.max(0, Math.round(saved)));
} catch {}
function syncSharpness() {
  $('sharpness').value = sharpness; $('sharpnessValue').textContent = `${sharpness}`;
  for (const button of document.querySelectorAll('button[data-sharpness]')) button.setAttribute('aria-pressed',String(Number(button.dataset.sharpness) === sharpness));
}
syncSharpness();
const readingControls = {strokeEnabled:false,thinStroke:30,inkEnabled:false,inkDensity:30,cleanupEnabled:false,backgroundCleanup:25,
  cropEnabled:false,cropAmount:100,cropFooter:false,trimLeft:0,trimTop:0,trimRight:0,trimBottom:0};
try {
  const saved = JSON.parse(localStorage.getItem('naranhi-reading-controls') || 'null');
  if (saved && typeof saved === 'object') for (const key of Object.keys(readingControls)) {
    if (typeof readingControls[key] === 'boolean') { if (typeof saved[key] === 'boolean') readingControls[key] = saved[key]; }
    else if (Number.isFinite(saved[key])) readingControls[key] = key.startsWith('trim') ? Math.max(-15,Math.min(15,Math.round(saved[key]*2)/2)) : Math.max(0,Math.min(100,Math.round(saved[key])));
  }
} catch {}
const marginCache = new Map();
const noMargins = {left:0,top:0,right:0,bottom:0};
function effectiveTones() { return {stroke:readingControls.strokeEnabled ? readingControls.thinStroke : 0,density:readingControls.inkEnabled ? readingControls.inkDensity : 0,cleanup:readingControls.cleanupEnabled ? readingControls.backgroundCleanup : 0}; }
function syncReadingControls() {
  for (const [key,value] of Object.entries(readingControls)) {
    if (typeof value === 'boolean') $(key).checked = value;
    else { $(key).value = value; $(key+'Value').textContent = key.startsWith('trim') ? `${value > 0 ? '+' : ''}${value}%` : `${value}`; }
  }
  $('thinStroke').disabled = !readingControls.strokeEnabled;
  $('inkDensity').disabled = !readingControls.inkEnabled; $('backgroundCleanup').disabled = !readingControls.cleanupEnabled;
  for (const key of ['cropAmount','cropFooter','trimLeft','trimTop','trimRight','trimBottom']) $(key).disabled = !readingControls.cropEnabled;
}
syncReadingControls();
function setReadingControl(key,value) {
  readingControls[key] = typeof readingControls[key] === 'boolean' ? !!value : key.startsWith('trim') ? Math.max(-15,Math.min(15,Number(value)||0)) : Math.max(0,Math.min(100,Math.round(Number(value)||0)));
  syncReadingControls();
  try { localStorage.setItem('naranhi-reading-controls',JSON.stringify(readingControls)); } catch {}
  if (key.startsWith('crop') || key.startsWith('trim')) {
    if (!state.pdf) return;
    wheelNavigation.reset(performance.now());
    cancelRenders(); ++state.renderId; $('spread').setAttribute('aria-busy','true');
    state.renderTimer = setTimeout(() => renderCurrent({resetScroll:true}),120);
  } else { ++refinementRevision; scheduleRefinement(); }
}
const pageQuality = new WeakMap();
const treeOpen = new Map();
let libraryQuery = '';
let documentStore;
let localSaveQueue = Promise.resolve();
let startupCancelled = false;
let practiceCatalog = [];
function closePracticeMenu() { $('practicePopover').hidden = true; $('practiceToggle').setAttribute('aria-expanded', 'false'); }
let practiceOpening = false;
$('practiceDock').addEventListener('click', async event => {
  const link = event.target.closest('a[href]');
  if (!link || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  if (practiceOpening) return;
  practiceOpening = true;
  const url = link.href;
  try {
    const response = await fetch('/api/practice/open',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url})});
    if (!response.ok || !(await response.json()).opened) throw new Error();
    closePracticeMenu();
  } catch {
    window.open(url,'_blank','noopener,noreferrer');
    toast('앱으로 열지 못해 브라우저로 연결했습니다. 열리지 않으면 Ctrl 키를 누른 채 링크를 클릭해 주세요.');
  } finally { practiceOpening = false; }
});
function togglePracticeMenu() { const open = $('practicePopover').hidden; $('practicePopover').hidden = !open; $('practiceToggle').setAttribute('aria-expanded', String(open)); }
function syncPractice() {
  const files = state.library.flatMap(group => group.files);
  const source = files.find(file => !file.custom && (file.id === state.fileId || (!state.fileId && state.key.startsWith(`local:${file.name}:${file.size}:`))));
  $('practiceDock').hidden = !state.pdf || !source;
  if (!state.pdf || !source) { closePracticeMenu(); return; }
  const entry = practiceCatalog.find(file => file.group === source.group && file.relativePath === source.relativePath);
  const visiblePages = spreadPages(state.page, state.pdf.numPages, state.mode, state.cover);
  const active = entry?.links.filter(link => link.kind === 'chapter' && visiblePages.some(page => page >= link.pageStart && page <= link.pageEnd)) || [];
  const direct = active.length === 1 ? active[0] : null;
  const anchor = $('currentPractice');
  anchor.textContent = entry ? (direct ? '기출 풀기 ↗' : '장별 기출') : '레일노트 ↗';
  anchor.title = direct ? direct.label : entry ? '이 교재의 장별 기출 선택' : '유통관리사 문제 전체 — 회차는 레일노트에서 선택';
  if (direct || !entry) anchor.href = direct?.url || 'https://railnote.web.app/?exam=distribution-2';
  else anchor.removeAttribute('href');
  anchor.tabIndex = 0;
  if (anchor.hasAttribute('href')) anchor.removeAttribute('role'); else anchor.setAttribute('role', 'button');
  anchor.onkeydown = event => { if (!anchor.hasAttribute('href') && ['Enter', ' '].includes(event.key)) { event.preventDefault(); togglePracticeMenu(); } };
  anchor.onclick = event => { if (entry && !direct) { event.preventDefault(); togglePracticeMenu(); } else closePracticeMenu(); };
  $('practiceToggle').hidden = !entry;
  $('practiceTitle').textContent = entry?.label || '유통관리사 기출';
  $('practiceLinks').replaceChildren();
  for (const link of entry?.links || []) {
    const item = document.createElement('a'); item.href = link.url; item.target = '_blank'; item.rel = 'noopener noreferrer';
    item.textContent = link.label + ' ↗'; item.classList.toggle('current', active.includes(link));
    if (active.includes(link)) item.setAttribute('aria-current', 'true');
    item.onclick = closePracticeMenu; $('practiceLinks').append(item);
  }
  if (!entry) closePracticeMenu();
}
function rememberDocument(document) {
  try { localStorage.setItem('naranhi-last-document', JSON.stringify(document)); } catch {}
}
function getDocumentStore() {
  if (!documentStore) documentStore = new Promise((resolve, reject) => {
    const request = indexedDB.open('naranhi-reader', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('documents');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return documentStore;
}
async function storeLocalDocument(file, key, documentId) {
  const db = await getDocumentStore();
  if (state.documentId !== documentId) return;
  await new Promise((resolve, reject) => {
    const transaction = db.transaction('documents', 'readwrite');
    transaction.objectStore('documents').put({file, key}, 'latest');
    transaction.oncomplete = resolve;
    transaction.onerror = transaction.onabort = () => reject(transaction.error);
  });
  if (state.documentId === documentId) rememberDocument({type: 'local', key, name: file.name});
}
async function readLocalDocument() {
  const db = await getDocumentStore();
  return new Promise((resolve, reject) => {
    const request = db.transaction('documents').objectStore('documents').get('latest');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
let toastTimer, dragDepth = 0;
let clockTimer;
const readingTimeFormat = new Intl.DateTimeFormat('ko-KR', {timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'});
function updateReadingClock() {
  clearTimeout(clockTimer);
  if (!document.body.classList.contains('reading-focus') || document.hidden) return;
  const now = new Date();
  $('readingClock').textContent = readingTimeFormat.format(now);
  $('readingClock').dateTime = now.toISOString();
  clockTimer = setTimeout(updateReadingClock, 60_000 - (now.getTime() % 60_000) + 25);
}
const formatSize = size => size > 1024 ** 2 ? `${(size / 1024 ** 2).toFixed(1)} MB` : `${Math.ceil(size / 1024)} KB`;
const fileIcon = '<svg viewBox="0 0 24 24"><path d="M14 3H5v18h14V8zM14 3v5h5M8 12h8M8 16h6"/></svg>';

function toast(message) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, 4500); }
function readHistory() {
  try {
    const history = JSON.parse(localStorage.getItem('naranhi-history') || '{}');
    return history && typeof history === 'object' && !Array.isArray(history) ? history : {};
  } catch { return {}; }
}
function savedViewing(history, key) {
  // Keep each document's own magnification. A newly opened document inherits
  // the last used setting, including the page/width basis of the percentage.
  const latest = Object.values(history).reverse().find(item => Number.isFinite(item?.zoom));
  const saved = Number.isFinite(history[key]?.zoom) ? history[key] : latest;
  return {zoom: saved ? Math.min(4, Math.max(.25, Math.round(saved.zoom * 100) / 100)) : 1,
    fit: saved?.fit === 'width' ? 'width' : 'page'};
}
function savePosition() {
  if (!state.pdf || !state.key) return;
  const history = readHistory(); delete history[state.key]; history[state.key] = {page: state.page, zoom: state.zoom, fit: state.fit};
  try { localStorage.setItem('naranhi-history', JSON.stringify(Object.fromEntries(Object.entries(history).slice(-40)))); } catch {}
}
function isCurrent(documentId, renderId) { return state.documentId === documentId && state.renderId === renderId && !!state.pdf; }
function cancelRenders() {
  clearTimeout(state.prefetchTimer); clearTimeout(state.renderTimer);
  clearTimeout(refinementTimer); ++refinementRevision;
  for (const task of state.tasks) task.cancel(); state.tasks.clear();
  for (const layer of state.textLayers) layer.cancel(); state.textLayers.clear();
}
function clearCache() {
  marginCache.clear();
  displayRasterizer.clear(); displayViews.clear();
  for (const entry of refinedCache.values()) { entry.canvas.width = 0; entry.canvas.height = 0; } refinedCache.clear();
  for (const entry of state.cache.values()) { entry.canvas.width = 0; entry.canvas.height = 0; } state.cache.clear();
}
function trimCache(protectedKeys = []) {
  const protectedSet = new Set(protectedKeys);
  let pixels = [...state.cache.values()].reduce((sum, item) => sum + item.pixels, 0);
  for (const [key, entry] of state.cache) {
    if (pixels <= MAX_CACHE_PIXELS) break;
    if (protectedSet.has(key)) continue;
    pixels -= entry.pixels; entry.canvas.width = 0; entry.canvas.height = 0; state.cache.delete(key);
  }
}
async function getPage(number, documentId) {
  const pdf = state.pdf;
  if (!pdf || documentId !== state.documentId) throw new Error('stale');
  let page = state.pages.get(number);
  if (!page) { page = await pdf.getPage(number); if (documentId !== state.documentId) throw new Error('stale'); state.pages.set(number, page); }
  await inspectQuality(page);
  if (documentId !== state.documentId) throw new Error('stale');
  return page;
}
async function inspectQuality(page) {
  if (pageQuality.has(page)) return pageQuality.get(page);
  const job = (async () => {
    const ops = await page.getOperatorList();
    const pageArea = (page.view[2] - page.view[0]) * (page.view[3] - page.view[1]);
    let matrix = [1, 0, 0, 1, 0, 0], nativeScale = 0;
    const stack = [];
    for (let i = 0; i < ops.fnArray.length; i++) {
      const op = ops.fnArray[i], args = ops.argsArray[i];
      if (op === pdfjs.OPS.save) stack.push([...matrix]);
      else if (op === pdfjs.OPS.restore) matrix = stack.pop() || [1, 0, 0, 1, 0, 0];
      else if (op === pdfjs.OPS.transform) matrix = pdfjs.Util.transform(matrix, args);
      else if (op === pdfjs.OPS.paintFormXObjectBegin) {
        stack.push([...matrix]); if (args[0]) matrix = pdfjs.Util.transform(matrix, args[0]);
      } else if (op === pdfjs.OPS.paintFormXObjectEnd) matrix = stack.pop() || [1, 0, 0, 1, 0, 0];
      else if (op === pdfjs.OPS.paintImageXObject || op === pdfjs.OPS.paintInlineImageXObject) {
        const width = op === pdfjs.OPS.paintImageXObject ? args[1] : args[0]?.width;
        const height = op === pdfjs.OPS.paintImageXObject ? args[2] : args[0]?.height;
        const area = Math.abs(matrix[0] * matrix[3] - matrix[1] * matrix[2]);
        const x = Math.hypot(matrix[0], matrix[1]), y = Math.hypot(matrix[2], matrix[3]);
        if (area >= pageArea * .2 && width > 0 && height > 0 && x > 0 && y > 0) {
          nativeScale = Math.max(nativeScale, width / x / (page.userUnit || 1), height / y / (page.userUnit || 1));
        }
      }
    }
    return {nativeScale};
  })().catch(() => ({nativeScale: 0}));
  pageQuality.set(page, job);
  const quality = await job;
  pageQuality.set(page, quality);
  return quality;
}
function viewportFor(page, scale = 1) { return page.getViewport({scale, rotation: (page.rotate + state.rotation) % 360}); }
initGptQuestion({toast,hasDocument:()=>!!state.pdf,capture:async(frame,rect)=>{
  const paper=frame.closest('.paper'),view=displayViews.get(paper);
  if(!view||!isCurrent(view.documentId,view.renderId))throw new Error('stale');
  const source=view.entry.canvas,m=view.layout.crop||noMargins,name=state.name,page=Number(paper.dataset.page);
  const x=source.width*(m.left+rect.x*(1-m.left-m.right)),y=source.height*(m.top+rect.y*(1-m.top-m.bottom));
  const width=source.width*rect.width*(1-m.left-m.right),height=source.height*rect.height*(1-m.top-m.bottom);
  const ratio=Math.min(1,4096/Math.max(width,height),Math.sqrt(8_000_000/(width*height)));
  const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(width*ratio));canvas.height=Math.max(1,Math.round(height*ratio));
  canvas.getContext('2d',{alpha:false}).drawImage(source,x,y,width,height,0,0,canvas.width,canvas.height);
  const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
  const result={blob,name,page,width:canvas.width,height:canvas.height};
  canvas.width=0;canvas.height=0;return result;
}});
async function prepareMargins(pages,documentId,renderId) {
  if (!readingControls.cropEnabled) return;
  for (const page of pages) {
    if (marginCache.has(page.pageNumber)) continue;
    if (!isCurrent(documentId,renderId)) return;
    const natural = page.getViewport({scale:1}), scale = Math.min(1,900 / Math.max(natural.width,natural.height));
    const viewport = page.getViewport({scale}), canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
    const context = canvas.getContext('2d',{alpha:false,willReadFrequently:true});
    const task = page.render({canvasContext:context,viewport,background:'#fff'}); state.tasks.add(task);
    try {
      await task.promise;
      if (!isCurrent(documentId,renderId)) return;
      const pixels = context.getImageData(0,0,canvas.width,canvas.height).data;
      marginCache.set(page.pageNumber,{normal:detectPageMargins(pixels,canvas.width,canvas.height),
        footer:detectPageMargins(pixels,canvas.width,canvas.height,{excludeFooter:true})});
    } finally { state.tasks.delete(task); canvas.width = 0; canvas.height = 0; }
  }
}
function marginsFor(page) {
  if (!readingControls.cropEnabled) return {...noMargins};
  const detected = marginCache.get(page.pageNumber)?.[readingControls.cropFooter ? 'footer' : 'normal'] || noMargins;
  let rotated = {...detected};
  for (let rotation=0;rotation<state.rotation;rotation+=90) rotated = {...rotated,left:rotated.bottom,top:rotated.left,right:rotated.top,bottom:rotated.right};
  return resolveMargins(rotated,{amount:readingControls.cropAmount,...readingControls});
}
let scrollbarMetrics;
function viewportScrollbarSize(css) {
  const key = `${css.scrollbarWidth}:${window.devicePixelRatio || 1}`;
  if (scrollbarMetrics?.key === key) return scrollbarMetrics;
  const probe = document.createElement('div');
  probe.style.cssText = 'position:fixed;left:-10000px;top:0;width:100px;height:100px;padding:0;border:0;overflow:scroll;visibility:hidden;pointer-events:none';
  probe.style.scrollbarWidth = css.scrollbarWidth;
  document.body.append(probe);
  scrollbarMetrics = {key,width:probe.offsetWidth-probe.clientWidth,height:probe.offsetHeight-probe.clientHeight};
  probe.remove();
  return scrollbarMetrics;
}
function layoutFor(pages) {
  const el = $('viewport'), css = getComputedStyle(el);
  const dpr = window.devicePixelRatio || 1;
  const box = el.getBoundingClientRect(), scrollbars = viewportScrollbarSize(css);
  const gap = Math.round((parseFloat(css.getPropertyValue('--page-gap')) || 20) * dpr) / dpr;
  const margins = pages.map(marginsFor), natural = pages.map(page => viewportFor(page));
  const cropped = natural.map((size,i) => ({width:size.width*(1-margins[i].left-margins[i].right),height:size.height*(1-margins[i].top-margins[i].bottom)}));
  const hasCrop = margins.some(m => m.left || m.top || m.right || m.bottom);
  const reference = hasCrop ? {width:1000*cropped[0].width/cropped[0].height,height:1000} : state.reference;
  const aligned = calculateViewportLayout(cropped, {mode: state.normalize, fit: state.fit, zoom: state.zoom,
    availableWidth: Math.max(20, box.width - parseFloat(css.borderLeftWidth) - parseFloat(css.borderRightWidth) - parseFloat(css.paddingLeft) - parseFloat(css.paddingRight)),
    availableHeight: Math.max(20, box.height - parseFloat(css.borderTopWidth) - parseFloat(css.borderBottomWidth) - parseFloat(css.paddingTop) - parseFloat(css.paddingBottom)),
    scrollbarWidth:scrollbars.width,scrollbarHeight:scrollbars.height,pixelRatio:dpr,reference,gap});
  aligned.pages.forEach((item,i) => {
    item.crop = margins[i];
    item.fullWidth = item.contentWidth/(1-margins[i].left-margins[i].right);
    item.fullHeight = item.contentHeight/(1-margins[i].top-margins[i].bottom);
  });
  return aligned;
}
function renderSpec(page, layout) {
  const cssViewport = viewportFor(page, layout.scale);
  const natural = viewportFor(page);
  const nativeScale = pageQuality.get(page)?.nativeScale || 0;
  const desiredScale = Math.max(nativeScale, layout.scale * Math.max(2, window.devicePixelRatio || 1));
  const scale = Math.min(desiredScale, Math.sqrt(MAX_PAGE_PIXELS / (natural.width * natural.height)), 16384 / Math.max(natural.width, natural.height));
  const viewport = viewportFor(page, scale);
  const key = `${page.pageNumber}:${viewport.rotation}:${scale.toFixed(5)}`;
  return {key, viewport, cssViewport};
}
async function rasterize(page, layout, documentId, renderId) {
  const spec = renderSpec(page, layout);
  const cached = state.cache.get(spec.key);
  if (cached) { state.cache.delete(spec.key); state.cache.set(spec.key, cached); return {...cached, cached: true, spec}; }
  if (!isCurrent(documentId, renderId)) throw new Error('stale');
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.ceil(spec.viewport.width)); canvas.height = Math.max(1, Math.ceil(spec.viewport.height));
  const task = page.render({canvasContext: canvas.getContext('2d', {alpha: false}), viewport: spec.viewport, background: '#ffffff'});
  state.tasks.add(task);
  try { await task.promise; }
  catch (error) { canvas.width = 0; canvas.height = 0; throw error; }
  finally { state.tasks.delete(task); }
  if (!isCurrent(documentId, renderId)) { canvas.width = 0; canvas.height = 0; throw new Error('stale'); }
  const entry = {canvas, pixels: canvas.width * canvas.height, page: page.pageNumber, rotation: spec.viewport.rotation, key: spec.key};
  state.cache.set(spec.key, entry);
  return {...entry, cached: false, spec};
}
function displaySpec(entry, layout) {
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.round(layout.contentWidth * dpr)), height = Math.max(1, Math.round(layout.contentHeight * dpr));
  const m = layout.crop || noMargins, sw = entry.canvas.width, sh = entry.canvas.height;
  const x = Math.floor(sw*m.left), y = Math.floor(sh*m.top);
  const crop = {x,y,width:Math.max(1,Math.ceil(sw*(1-m.right))-x),height:Math.max(1,Math.ceil(sh*(1-m.bottom))-y)};
  const {stroke,density,cleanup} = effectiveTones();
  return {width,height,crop,stroke,density,cleanup,key:`${state.documentId}:${entry.key}:${width}x${height}:${sharpness}:${stroke}:${density}:${cleanup}:${x},${y},${crop.width},${crop.height}`};
}
function contentFrame(paper,layout) {
  let frame = paper.querySelector('.page-content');
  if (!frame) { frame = document.createElement('div'); frame.className = 'page-content'; paper.prepend(frame); }
  frame.style.cssText = `left:${layout.offsetX}px;top:${layout.offsetY}px;width:${layout.contentWidth}px;height:${layout.contentHeight}px`;
  return frame;
}
function placeCanvas(paper, canvas, layout, source, refined = false) {
  const frame = contentFrame(paper,layout), m = layout.crop || noMargins;
  const previous = paper.querySelector('canvas');
  if (previous && previous !== canvas) previous.remove();
  if (canvas.parentElement !== frame) frame.prepend(canvas);
  canvas.style.cssText = refined ? `left:0;top:0;width:${layout.contentWidth}px;height:${layout.contentHeight}px` :
    `left:${-m.left*layout.fullWidth}px;top:${-m.top*layout.fullHeight}px;width:${layout.fullWidth}px;height:${layout.fullHeight}px`;
  canvas.dataset.refined = String(refined);
  canvas.dataset.sourceWidth = source.canvas.dataset.sourceWidth || source.canvas.width;
  canvas.dataset.sourceHeight = source.canvas.dataset.sourceHeight || source.canvas.height;
  paper.classList.remove('pending');
}
function drawRaster(paper, entry, layout) {
  const spec = displaySpec(entry,layout), refined = entry.key && refinedCache.get(spec.key);
  placeCanvas(paper, refined?.canvas || entry.canvas, layout, entry,!!refined);
  paper.dataset.quality = refined ? 'refined' : 'preview';
  paper.dataset.sharpness = sharpness;
  paper.dataset.stroke = spec.stroke; paper.dataset.density = spec.density; paper.dataset.cleanup = spec.cleanup;
  paper.dataset.crop = JSON.stringify(layout.crop || noMargins);
  if (refined) paper.dataset.displayKey = spec.key;
}
function alignSpreadToPixels() {
  const spread = $('spread'), dpr = window.devicePixelRatio || 1;
  spread.style.left = '0px'; spread.style.top = '0px';
  const rect = spread.getBoundingClientRect();
  spread.style.left = `${Math.round(rect.left * dpr) / dpr - rect.left}px`;
  spread.style.top = `${Math.round(rect.top * dpr) / dpr - rect.top}px`;
}
function trimRefinedCache() {
  let pixels = [...refinedCache.values()].reduce((sum,item) => sum + item.canvas.width * item.canvas.height,0);
  for (const [key,item] of refinedCache) {
    if (pixels <= MAX_REFINED_PIXELS && refinedCache.size <= 6) break;
    if (item.canvas.isConnected) continue;
    pixels -= item.canvas.width * item.canvas.height;
    item.canvas.width = 0; item.canvas.height = 0; refinedCache.delete(key);
  }
}
async function refineView(view, revision) {
  const {paper,entry,layout,documentId,renderId} = view;
  const amount = sharpness, spec = displaySpec(entry,layout);
  const current = () => isCurrent(documentId,renderId) && refinementRevision === revision && sharpness === amount && paper.isConnected && displayViews.get(paper) === view;
  if (!current()) return;
  // At very large zoom the source is already clear; avoid another huge raster.
  paper.dataset.stroke = spec.stroke; paper.dataset.density = spec.density; paper.dataset.cleanup = spec.cleanup;
  if (spec.width * spec.height > 4_000_000 || spec.crop.width * spec.crop.height > 16_000_000 || spec.width > spec.crop.width || spec.height > spec.crop.height) {
    placeCanvas(paper,entry.canvas,layout,entry);
    paper.dataset.quality = 'original'; paper.dataset.sharpness = amount; return;
  }
  const cached = refinedCache.get(spec.key);
  paper.dataset.quality = 'processing';
  try {
    const result = cached || await displayRasterizer.render(entry.canvas,spec.width,spec.height,amount,{isCurrent:current,stroke:spec.stroke,density:spec.density,cleanup:spec.cleanup,crop:spec.crop});
    if (!current()) { if (!cached) { result.canvas.width = 0; result.canvas.height = 0; } return; }
    if (!cached) refinedCache.set(spec.key,result);
    placeCanvas(paper,result.canvas,layout,entry,true);
    paper.dataset.quality = 'refined'; paper.dataset.sharpness = amount; paper.dataset.displayKey = spec.key;
    trimRefinedCache();
    document.dispatchEvent(new CustomEvent('reader-refined',{detail:{page:entry.page,width:spec.width,height:spec.height,sharpness:amount,stroke:spec.stroke,density:spec.density,cleanup:spec.cleanup,crop:spec.crop,elapsed:cached ? 0 : result.elapsed,cached:!!cached,method:result.method}}));
  } catch (error) {
    if (current()) { placeCanvas(paper,entry.canvas,layout,entry); paper.dataset.quality = 'original'; paper.dataset.sharpness = amount; }
    if (error.name !== 'AbortError' && current()) console.debug('Display refinement unavailable',error.message);
  }
}
function scheduleRefinement() {
  clearTimeout(refinementTimer);
  const revision = refinementRevision;
  refinementTimer = setTimeout(() => { for (const view of displayViews.values()) void refineView(view,revision); },70);
}
function setSharpness(value) {
  if (!Number.isFinite(Number(value))) return;
  sharpness = Math.min(100,Math.max(0,Math.round(Number(value)))); syncSharpness();
  try { localStorage.setItem('naranhi-sharpness',JSON.stringify(sharpness)); } catch {}
  ++refinementRevision; scheduleRefinement();
}
async function drawText(paper, page, layout, documentId, renderId) {
  try {
    const content = await page.getTextContent();
    if (!isCurrent(documentId, renderId) || !content.items.length) return;
    const layerElement = document.createElement('div'); layerElement.className = 'textLayer';
    const m = layout.crop || noMargins;
    layerElement.style.left = `${-m.left*layout.fullWidth}px`; layerElement.style.top = `${-m.top*layout.fullHeight}px`;
    layerElement.style.setProperty('--total-scale-factor', layout.scale * (page.userUnit || 1));
    const textViewport = viewportFor(page,layout.scale);
    layerElement.style.transformOrigin = '0 0';
    layerElement.style.transform = `scale(${layout.fullWidth / textViewport.width},${layout.fullHeight / textViewport.height})`;
    const layer = new pdfjs.TextLayer({textContentSource: content, container: layerElement, viewport: textViewport});
    contentFrame(paper,layout).append(layerElement); state.textLayers.add(layer);
    try { await layer.render(); } finally { state.textLayers.delete(layer); }
    if (!isCurrent(documentId, renderId)) layerElement.remove();
  } catch (error) { if (isCurrent(documentId, renderId)) console.debug('Text selection unavailable on this page', error.message); }
}
function syncControls() {
  const total = state.pdf?.numPages || 0;
  $('singleMode').setAttribute('aria-pressed', state.mode === 'single');
  $('spreadMode').setAttribute('aria-pressed', state.mode === 'spread');
  $('cover').disabled = state.mode === 'single';
  $('normalize').value = state.normalize;
  $('pageNumber').value = state.page; $('pageNumber').max = total;
  $('pageTotal').textContent = `/ ${total}`;
  const nums = spreadPages(state.page, total, state.mode, state.cover);
  const pageIndicator = total ? `${nums.join('–')} / ${total}` : '문서 여는 중';
  if ($('readingPage').textContent !== pageIndicator) $('readingPage').textContent = pageIndicator;
  $('readingPage').setAttribute('aria-label', total ? `전체 ${total}페이지 중 ${nums.join('–')}페이지` : pageIndicator);
  $('previous').disabled = !total || state.page === 1;
  $('next').disabled = !total || nums.at(-1) >= total;
  $('zoomValue').value = Math.round(state.zoom * 100);
  $('fitPage').classList.toggle('active', state.fit === 'page' && state.zoom === 1);
  $('fitWidth').classList.toggle('active', state.fit === 'width' && state.zoom === 1);
  $('fitPage').setAttribute('aria-pressed',String(state.fit === 'page' && state.zoom === 1));
  $('fitWidth').setAttribute('aria-pressed',String(state.fit === 'width' && state.zoom === 1));
  syncPractice();
}
async function renderCurrent({resetScroll = false, scrollEdge = 'top'} = {}) {
  if (!state.pdf) return;
  cancelRenders(); const documentId = state.documentId, renderId = ++state.renderId;
  const startTime = performance.now();
  state.page = spreadStart(state.page, state.pdf.numPages, state.mode, state.cover);
  const numbers = spreadPages(state.page, state.pdf.numPages, state.mode, state.cover);
  syncControls(); savePosition();
  $('loadingText').textContent = '페이지를 준비하고 있어요'; $('loading').hidden = false;
  $('spread').setAttribute('aria-busy', 'true');
  try {
    const pages = await Promise.all(numbers.map(n => getPage(n, documentId)));
    await prepareMargins(pages,documentId,renderId);
    if (!isCurrent(documentId, renderId)) return;
    const layout = layoutFor(pages); state.currentLayout = layout; displayViews.clear();
    const papers = pages.map((page, i) => {
      const l = layout.pages[i];
      const paper = document.createElement('article'); paper.className = 'paper pending';
      paper.dataset.page = page.pageNumber; paper.setAttribute('aria-label', `${page.pageNumber} 페이지`);
      paper.style.width = `${l.width}px`; paper.style.height = `${l.height}px`;
      const spec = renderSpec(page, l);
      const fallback = state.cache.get(spec.key) || [...state.cache.values()].reverse().find(item => item.page === page.pageNumber && item.rotation === spec.viewport.rotation);
      if (fallback) drawRaster(paper, fallback, l);
      paper.dataset.rotation = spec.viewport.rotation;
      return paper;
    });
    $('spread').replaceChildren(...papers);
    $('spread').style.gap = `${layout.gap}px`;
    $('spread').style.minHeight = `${layout.height}px`;
    if (resetScroll) $('viewport').scrollTo({top: scrollEdge === 'bottom' ? $('viewport').scrollHeight : 0, left: 0, behavior:'instant'});
    alignSpreadToPixels();
    const entries = await Promise.all(pages.map(async (page, i) => {
      const entry = await rasterize(page, layout.pages[i], documentId, renderId);
      if (!isCurrent(documentId, renderId)) return null;
      drawRaster(papers[i], entry, layout.pages[i]);
      displayViews.set(papers[i],{paper:papers[i],entry,layout:layout.pages[i],documentId,renderId});
      void drawText(papers[i], page, layout.pages[i], documentId, renderId);
      return entry;
    }));
    if (!isCurrent(documentId, renderId)) return;
    $('loading').hidden = true; $('spread').setAttribute('aria-busy', 'false');
    const elapsed = performance.now() - startTime;
    const allCached = entries.every(entry => entry?.cached);
    const keys = entries.map(entry => entry.key); trimCache(keys);
    trimRefinedCache(); scheduleRefinement();
    // Release resources of distant pages; PDF.js retains only light page proxies.
    for (const [n, page] of state.pages) if (Math.abs(n - state.page) > 6) { page.cleanup(); state.pages.delete(n); }
    state.prefetchTimer = setTimeout(() => prefetch(numbers.at(-1) + 1, documentId, renderId, keys), 180);
    document.dispatchEvent(new CustomEvent('reader-rendered', {detail: {pages: numbers, elapsed, cached: allCached}}));
  } catch (error) {
    if (!isCurrent(documentId, renderId) || error.name === 'RenderingCancelledException' || error.message === 'stale') return;
    $('loading').hidden = true; $('spread').setAttribute('aria-busy', 'false');
    toast(`페이지를 표시하지 못했습니다. ${error.message}`);
    console.error(error);
  }
}
async function prefetch(start, documentId, renderId, protectedKeys) {
  if (!isCurrent(documentId, renderId) || start > state.pdf.numPages) return;
  try {
    const nums = spreadPages(start, state.pdf.numPages, state.mode, state.cover);
    const pages = await Promise.all(nums.map(n => getPage(n, documentId)));
    await prepareMargins(pages,documentId,renderId);
    if (!isCurrent(documentId, renderId)) return;
    const layout = layoutFor(pages);
    for (let i = 0; i < pages.length; i++) {
      if (!isCurrent(documentId, renderId)) return;
      const {viewport} = renderSpec(pages[i], layout.pages[i]);
      const protectedPixels = protectedKeys.reduce((sum, key) => sum + (state.cache.get(key)?.pixels || 0), 0);
      // At very high zoom, prioritize the visible pages over speculative canvases.
      if (protectedPixels + Math.ceil(viewport.width) * Math.ceil(viewport.height) > MAX_CACHE_PIXELS) return;
      const entry = await rasterize(pages[i], layout.pages[i], documentId, renderId);
      trimCache([...protectedKeys, entry.key]);
    }
  } catch { /* Prefetch is optional; the visible-page renderer reports real errors. */ }
}

async function openPdf(source, name, key, fileId = '') {
  closePracticeMenu();
  closeReaderPanels(); wheelNavigation.reset(performance.now());
  clearTimeout(toastTimer); $('toast').hidden = true;
  savePosition(); const documentId = ++state.documentId; ++state.renderId; cancelRenders();
  const history = readHistory(), viewing = savedViewing(history, key);
  const oldTask = state.loadingTask; state.loadingTask = null; state.pdf = null; state.pages.clear(); clearCache();
  if ($('passwordDialog').open) $('passwordDialog').close(); state.pendingPassword = null;
  state.key = key; state.name = name; state.fileId = fileId; state.rotation = 0; state.zoom = viewing.zoom; state.fit = viewing.fit;
  $('welcome').hidden = true; $('reader').hidden = false; $('spread').replaceChildren();
  setDocumentTitle(name);
  $('loadingText').textContent = '문서를 여는 중…'; $('loading').hidden = false;
  syncControls(); highlightFile(true);
  try {
    if (oldTask) await oldTask.destroy();
    const options = typeof source === 'function' ? await source() : source;
    if (documentId !== state.documentId) return;
    const task = pdfjs.getDocument({...options, cMapUrl: './vendor/cmaps/', cMapPacked: true,
      standardFontDataUrl: './vendor/standard_fonts/', wasmUrl: './vendor/wasm/', iccUrl: './vendor/iccs/',
      disableAutoFetch: true, disableStream: true, rangeChunkSize: 262144, isEvalSupported: false});
    state.loadingTask = task;
    task.onProgress = progress => { if (documentId === state.documentId && !state.pdf) $('loadingText').textContent = `문서 읽는 중 · ${formatSize(progress.loaded)}`; };
    task.onPassword = (callback, reason) => {
      if (documentId !== state.documentId) return;
      state.pendingPassword = callback; $('passwordInput').value = '';
      $('passwordMessage').textContent = reason === pdfjs.PasswordResponses.INCORRECT_PASSWORD ? '암호가 맞지 않습니다. 다시 입력하세요.' : '문서 암호를 입력하세요.';
      if (!$('passwordDialog').open) $('passwordDialog').showModal(); $('passwordInput').focus();
    };
    const pdf = await task.promise;
    if (documentId !== state.documentId) { await task.destroy(); return; }
    state.pdf = pdf;
    const firstPage = await getPage(1, documentId);
    if (documentId !== state.documentId) return;
    const firstViewport = viewportFor(firstPage);
    state.reference = {width: 1000 * firstViewport.width / firstViewport.height, height: 1000};
    state.page = spreadStart(history[key]?.page || 1, pdf.numPages, state.mode, state.cover);
    await renderCurrent({resetScroll: true});
    if (documentId !== state.documentId) return false;
    if (fileId) rememberDocument({type: 'library', id: fileId, name});
    return true;
  } catch (error) {
    if (documentId !== state.documentId) return;
    $('loading').hidden = true; state.pdf = null; $('reader').hidden = true; $('welcome').hidden = false; leaveReading();
    setDocumentTitle();
    toast(error.name === 'InvalidPDFException' ? '올바른 PDF 파일이 아닙니다.' : `PDF를 열지 못했습니다. ${error.message}`);
  }
}
async function openLocalFile(file, {restore = false} = {}) {
  if (!file || !/\.pdf$/i.test(file.name)) { toast('PDF 파일을 선택해 주세요.'); return; }
  if (!restore) startupCancelled = true;
  if (restore && matchMedia('(display-mode: fullscreen)').matches) enterReading({requestFullscreen:false});
  const key = `local:${file.name}:${file.size}:${file.lastModified}`;
  const opening = openPdf(async () => {
    const initial = new Uint8Array(await file.slice(0, 65536).arrayBuffer());
    const transport = new pdfjs.PDFDataRangeTransport(file.size, initial, true);
    let aborted = false;
    transport.requestDataRange = (begin, end) => {
      file.slice(begin, end).arrayBuffer().then(bytes => { if (!aborted) transport.onDataRange(begin, new Uint8Array(bytes)); }).catch(() => { if (!aborted) toast('파일을 읽을 수 없습니다. 다시 열어 주세요.'); });
    };
    transport.abort = () => { aborted = true; };
    return {range: transport};
  }, file.name, key);
  const documentId = state.documentId;
  const opened = await opening;
  if (opened && !restore && state.documentId === documentId) {
    localSaveQueue = localSaveQueue.then(() => storeLocalDocument(file, key, documentId)).catch(() => {
      if (state.documentId === documentId) toast('문서는 열었지만 자동 재개용 보관에 실패했습니다. 다음에는 파일을 다시 선택해 주세요.');
    });
  }
  return opened;
}
function openLibraryFile(file, {restore = false} = {}) {
  if (!restore) startupCancelled = true;
  if (restore && matchMedia('(display-mode: fullscreen)').matches) enterReading({requestFullscreen:false});
  return openPdf({url: `${file.custom?'/api/books/pdf':'/api/pdf'}?id=${encodeURIComponent(file.id)}`}, file.name, `library:${file.id}:${file.modified}`, file.id);
}
function highlightFile(reveal = false) {
  document.querySelectorAll('.library summary').forEach(summary => summary.classList.remove('current'));
  for (const button of document.querySelectorAll('.file-item')) {
    const selected = button.dataset.id === state.fileId;
    button.classList.toggle('selected', selected);
    if (selected) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
    if (!selected) continue;
    let parent = button.parentElement.closest('details');
    while (parent) {
      parent.querySelector(':scope > summary')?.classList.add('current');
      if (reveal) { parent.open = true; treeOpen.set(parent.dataset.key, true); }
      parent = parent.parentElement.closest('details');
    }
  }
}
function renderLibrary() {
  const query = $('librarySearch').value.trim().toLowerCase();
  if (!libraryQuery) $('library').querySelectorAll('details').forEach(details => treeOpen.set(details.dataset.key, details.open));
  libraryQuery = query; $('library').replaceChildren();
  let matches = 0;
  for (const group of state.library) {
    const files = group.files.filter(file => `${file.relativePath} ${file.name}`.toLowerCase().includes(query));
    if (!files.length && !(group.custom&&!query)) continue; matches += files.length;
    function branch(label, key, className) {
      const details = document.createElement('details'); details.className = className; details.dataset.key = key;
      details.open = Boolean(query || treeOpen.get(key));
      const summary = document.createElement('summary'); summary.textContent = label; details.append(summary);
      details.addEventListener('toggle', () => { if (!query && details.isConnected) treeOpen.set(key, details.open); });
      return details;
    }
    const details = branch(`${group.name.replace('유관사 ', '').replace(' pdf', '')} · ${files.length}`, group.name, 'toc-group');
    if(group.custom&&group.tree){
      const included=new Set(files.map(file=>file.id));
      function addNodes(nodes,parent){let count=0;for(const node of nodes){if(node.kind==='folder'){const nested=branch(node.name,group.name+'/'+node.id,'toc-folder'),children=addNodes(node.children,nested);if(children||!query){parent.append(nested);count+=children;}}else if(included.has(node.file.id)){const file=node.file,button=document.createElement('button');button.className='file-item';button.dataset.id=file.id;button.title=file.relativePath;button.innerHTML=fileIcon;const info=document.createElement('span'),title=document.createElement('span'),size=document.createElement('span');title.className='name';title.textContent=file.name.replace(/\.pdf$/i,'');size.className='size';size.textContent=formatSize(file.size);info.append(title,size);button.append(info);button.onclick=()=>{void openLibraryFile(file);};parent.append(button);count++;}}return count;}
      addNodes(group.tree,details);$('library').append(details);continue;
    }
    const folders = new Map([['', details]]);
    if(group.custom&&!query)for(const fullPath of group.folders||[]){let parent=details,folderPath='';for(const folder of fullPath.split('/')){folderPath+='/'+folder;if(!folders.has(folderPath)){const nested=branch(folder,group.name+folderPath,'toc-folder');parent.append(nested);folders.set(folderPath,nested);}parent=folders.get(folderPath);}}
    for (const file of files) {
      let parent = details, folderPath = '';
      for (const folder of file.relativePath.split('/').slice(0, -1)) {
        folderPath += '/' + folder;
        if (!folders.has(folderPath)) {
          const nested = branch(folder, group.name + folderPath, 'toc-folder');
          parent.append(nested); folders.set(folderPath, nested);
        }
        parent = folders.get(folderPath);
      }
      const button = document.createElement('button'); button.className = 'file-item'; button.dataset.id = file.id; button.title = file.relativePath;
      button.innerHTML = fileIcon; const info = document.createElement('span'), title = document.createElement('span'), size = document.createElement('span');
      title.className = 'name'; title.textContent = file.name.replace(/\.pdf$/i, ''); size.className = 'size'; size.textContent = formatSize(file.size); info.append(title, size); button.append(info);
      button.onclick = () => { void openLibraryFile(file); };
      parent.append(button);
    }
    $('library').append(details);
  }
  if (!matches) { const message = document.createElement('p'); message.className = 'muted'; message.textContent = query ? '일치하는 파일이 없습니다.' : 'PDF 열기로 파일을 선택해 주세요.'; $('library').append(message); }
  highlightFile();
}
async function loadLibrary() {
  try { const response = await fetch('/api/library'); if (!response.ok) throw new Error(); state.library = (await response.json()).groups; renderLibrary(); }
  catch { $('library').innerHTML = '<p class="muted">책장을 불러오지 못했습니다.<br>PDF 열기로 파일을 선택할 수 있어요.</p>'; }
}
initLibraryManager({reloadLibrary:loadLibrary,toast});
initUpdateClient({beforeRestart:savePosition,toast});
async function restoreLastDocument() {
  try {
    let last = JSON.parse(localStorage.getItem('naranhi-last-document') || 'null');
    if (!last) {
      const recentLibrary = Object.keys(readHistory()).at(-1)?.match(/^library:([a-f0-9]{24}):/);
      if (recentLibrary) last = {type: 'library', id: recentLibrary[1]};
    }
    if (!last || startupCancelled) return;
    if (last.type === 'library') {
      const file = state.library.flatMap(group => group.files).find(file => file.id === last.id);
      if (file) await openLibraryFile(file, {restore: true});
      else toast('마지막 문서를 찾을 수 없습니다. 책장에서 다시 선택해 주세요.');
    } else if (last.type === 'local') {
      const saved = await readLocalDocument();
      if (startupCancelled) return;
      if (saved?.key === last.key && saved.file) await openLocalFile(saved.file, {restore: true});
      else toast('마지막 문서의 보관본이 없습니다. PDF 열기로 다시 선택해 주세요.');
    }
  } catch { if (!startupCancelled) toast('마지막 문서를 자동으로 열지 못했습니다. PDF를 다시 선택해 주세요.'); }
}
function navigate(direction, {wheel = false} = {}) {
  if (!state.pdf) return;
  if (!wheel) wheelNavigation.reset(performance.now());
  const numbers = spreadPages(state.page, state.pdf.numPages, state.mode, state.cover);
  const target = direction > 0 ? numbers.at(-1) + 1 : state.page - 1;
  if (target < 1 || target > state.pdf.numPages) return;
  state.page = spreadStart(target, state.pdf.numPages, state.mode, state.cover);
  // Coalesce rapid key repeats before decoding scans the reader has already skipped.
  cancelRenders(); ++state.renderId; syncControls();
  $('spread').setAttribute('aria-busy', 'true');
  state.renderTimer = setTimeout(() => renderCurrent({resetScroll: true,scrollEdge:wheel && direction < 0 ? 'bottom' : 'top'}), 40);
}
function setZoom(value, immediate = false) {
  if (!state.pdf || !Number.isFinite(Number(value))) return;
  wheelNavigation.reset(performance.now());
  state.zoom = Math.min(4, Math.max(.25, Math.round(Number(value) * 100) / 100)); syncControls();
  savePosition();
  cancelRenders(); ++state.renderId;
  $('spread').setAttribute('aria-busy','true');
  // Resize already drawn pixels immediately, then refine at the requested resolution.
  const pages = spreadPages(state.page, state.pdf.numPages, state.mode, state.cover).map(n => state.pages.get(n));
  if (pages.every(Boolean)) {
    const layout = layoutFor(pages);
    [...$('spread').children].forEach((paper, i) => {
      const l = layout.pages[i]; if (!l) return;
      paper.dataset.quality = 'preview';
      paper.style.width = `${l.width}px`; paper.style.height = `${l.height}px`;
      const canvas = paper.querySelector('canvas'); if (canvas) placeCanvas(paper,canvas,l,{canvas},canvas.dataset.refined === 'true');
      paper.querySelector('.textLayer')?.remove();
    });
    $('spread').style.minHeight = `${layout.height}px`;
    $('spread').style.gap = `${layout.gap}px`; alignSpreadToPixels();
  }
  state.renderTimer = setTimeout(() => renderCurrent(), immediate ? 0 : 130);
}
function toggleSidebar(open) {
  const visible = open ?? document.body.classList.contains('sidebar-hidden');
  document.body.classList.toggle('sidebar-hidden', !visible); $('readerSidebarToggle').setAttribute('aria-expanded', visible);
  closeReaderPanels();
}
async function toggleFullscreen() {
  if (!state.pdf) return;
  if (document.body.classList.contains('reading-focus') && (document.fullscreenElement || matchMedia('(display-mode: fullscreen)').matches)) leaveReading(); else enterReading();
}
function enterReading({requestFullscreen = true} = {}) {
  closeReaderPanels(); wheelNavigation.reset(performance.now());
  document.body.classList.add('reading-focus'); document.body.classList.remove('tools-visible');
  updateReadingClock();
  $('readerTools').setAttribute('aria-expanded', 'false'); toggleSidebar(false);
  // Invoke synchronously from the fullscreen button or keyboard gesture.
  if (requestFullscreen && !document.fullscreenElement && !matchMedia('(display-mode: fullscreen)').matches && document.fullscreenEnabled) {
    // Some app windows report DOM fullscreen without changing the Windows
    // frame after a native restore. Confirm the actual display mode as well.
    document.documentElement.requestFullscreen().catch(() => {}).then(() => {
      if (document.body.classList.contains('reading-focus')) void setNativeWindow(true);
    });
  }
}
let nativeWindowRestore;
function setNativeWindow(fullscreen) {
  return updateNativeWindow(fullscreen ? 'fullscreen' : 'restore');
}
function updateNativeWindow(action) {
  if (nativeWindowRestore) return nativeWindowRestore.then(() => updateNativeWindow(action));
  if (action !== 'icon' && matchMedia('(display-mode: fullscreen)').matches === (action === 'fullscreen')) return Promise.resolve();
  nativeWindowRestore = (async () => {
    let temporaryTitle;
    try {
      const response = await fetch('/api/window/session', {cache:'no-store'});
      if (!response.ok) throw new Error();
      const {token} = await response.json();
      if (!/^[a-f0-9]{32}$/.test(token)) throw new Error();
      temporaryTitle = `PDF Viewer [${token}]`; nativeTitlePending = true; document.title = temporaryTitle;
      const result = await fetch('/api/window/' + action, {method:'POST',headers:{'X-Viewer-Window':token}});
      if (!result.ok || !(await result.json()).restored) throw new Error();
      if (action === 'icon') document.body.dataset.windowIcon = 'ready';
    } catch {
      if (action === 'icon') document.body.dataset.windowIcon = 'unavailable';
      else toast(action === 'fullscreen' ? '전체보기로 전환하지 못했습니다. 뷰어를 다시 실행해 주세요.' : '창을 복원하지 못했습니다. 뷰어를 다시 실행해 주세요.');
    }
    finally { nativeTitlePending = false; document.title = readerWindowTitle; }
  })().finally(() => { nativeWindowRestore = null; });
  return nativeWindowRestore;
}
function restoreNativeWindow() { return setNativeWindow(false); }
function leaveReading() {
  document.body.classList.remove('reading-focus', 'tools-visible'); toggleSidebar(true);
  clearTimeout(clockTimer);
  closePracticeMenu();
  closeReaderPanels(); wheelNavigation.reset(performance.now());
  // Exit the web fullscreen layer first, then Chrome's startup fullscreen layer.
  // The helper only targets the nonce-marked window in this viewer's profile.
  const exit = document.fullscreenElement ? document.exitFullscreen().catch(() => {}) : Promise.resolve();
  void exit.then(restoreNativeWindow);
}
function cancelPassword() {
  ++state.documentId; state.loadingTask?.destroy().catch(() => {}); state.loadingTask = null; state.pendingPassword = null;
  $('passwordDialog').close(); $('loading').hidden = true; $('reader').hidden = true; $('welcome').hidden = false;
  setDocumentTitle(); leaveReading();
}
$('passwordForm').onsubmit = event => { event.preventDefault(); const callback = state.pendingPassword; state.pendingPassword = null; $('passwordDialog').close(); callback?.($('passwordInput').value); $('passwordInput').value = ''; };
$('passwordCancel').onclick = cancelPassword; $('passwordDialog').addEventListener('cancel', event => { event.preventDefault(); cancelPassword(); });
$('openFile').onclick = $('dropOpen').onclick = () => { startupCancelled = true; $('fileInput').click(); };
$('fileInput').onchange = event => { const file = event.target.files[0]; event.target.value = ''; if (file) void openLocalFile(file); };
$('welcomeLibrary').onclick = () => toggleSidebar(true);
$('readerSidebarToggle').onclick = () => toggleSidebar();
$('readerTools').onclick = () => { const visible = document.body.classList.toggle('tools-visible'); $('readerTools').setAttribute('aria-expanded', visible); if (!visible) closeReaderPanels(); };
for (const name of readerPanels) {
  panelTrigger(name).onclick = () => {
    const open = $(name+'Panel').hidden; closeReaderPanels();
    if (open) openReaderPanel(name);
  };
  $(name+'Close').onclick = () => { closeReaderPanels(); panelTrigger(name).focus(); };
}
$('sharpness').oninput = event => setSharpness(event.target.value);
for (const button of document.querySelectorAll('button[data-sharpness]')) button.onclick = () => setSharpness(button.dataset.sharpness);
for (const key of Object.keys(readingControls)) $(key).addEventListener(typeof readingControls[key] === 'boolean' ? 'change' : 'input',event => setReadingControl(key,typeof readingControls[key] === 'boolean' ? event.target.checked : event.target.value));
$('trimReset').onclick = () => { for (const key of ['trimLeft','trimTop','trimRight','trimBottom']) readingControls[key] = 0; setReadingControl('cropAmount',100); };
for (const id of ['colorPreset','colorQuickPreset']) $(id).onchange = event => {
  const preset = event.target.value;
  readerColors = {preset,...(preset === 'custom' ? customColors : colorPresets[preset] || validPalette(readerColors))};
  applyReaderColors();
  if (id === 'colorQuickPreset') closeReaderPanels();
};
for (const [id, key] of [['paperColor','background'],['textColor','text'],['accentStrength','strength']]) {
  $(id).oninput = event => { readerColors.preset = 'custom'; readerColors[key] = key === 'strength' ? Number(event.target.value) : event.target.value; applyReaderColors(); };
}
document.addEventListener('pointerdown', event => { if (!readerPanels.some(name => $(name+'Panel').contains(event.target) || panelTrigger(name).contains(event.target))) closeReaderPanels(); });
window.addEventListener('resize', () => { for (const name of readerPanels) if (!$(name+'Panel').hidden) positionReaderPanel(name); });
$('exitReading').onclick = leaveReading;
$('practiceToggle').onclick = togglePracticeMenu;
$('practiceClose').onclick = closePracticeMenu;
document.addEventListener('pointerdown', event => { if (!$('practiceDock').contains(event.target)) closePracticeMenu(); });
$('librarySearch').oninput = renderLibrary;
$('singleMode').onclick = () => { wheelNavigation.reset(performance.now()); state.mode = 'single'; saveViewingSettings(); void renderCurrent({resetScroll: true}); };
$('spreadMode').onclick = () => { wheelNavigation.reset(performance.now()); state.mode = 'spread'; saveViewingSettings(); void renderCurrent({resetScroll: true}); };
$('normalize').onchange = event => { wheelNavigation.reset(performance.now()); state.normalize = event.target.value; saveViewingSettings(); void renderCurrent(); };
$('cover').onchange = event => { wheelNavigation.reset(performance.now()); state.cover = event.target.checked; saveViewingSettings(); void renderCurrent({resetScroll: true}); };
$('previous').onclick = () => navigate(-1); $('next').onclick = () => navigate(1);
$('pageNumber').onchange = event => { if (!state.pdf) return; wheelNavigation.reset(performance.now()); state.page = spreadStart(event.target.value, state.pdf.numPages, state.mode, state.cover); void renderCurrent({resetScroll: true}); };
$('pageNumber').onkeydown = event => { if (event.key === 'Enter') event.target.blur(); };
$('zoomValue').onchange = event => setZoom(Number(event.target.value) / 100);
$('zoomValue').onkeydown = event => { if (event.key === 'Enter') event.target.blur(); };
$('fitPage').onclick = () => { state.fit = 'page'; setZoom(1, true); };
$('fitWidth').onclick = () => { state.fit = 'width'; setZoom(1, true); };
$('rotate').onclick = () => { wheelNavigation.reset(performance.now()); state.rotation = (state.rotation + 90) % 360; state.reference = {width: state.reference.height, height: state.reference.width}; void renderCurrent({resetScroll: true}); };
$('fullscreen').onclick = toggleFullscreen; $('help').onclick = () => { closeReaderPanels(); $('helpDialog').showModal(); };
$('viewport').addEventListener('wheel', event => {
  if (!state.pdf || !event.deltaY || $('helpDialog').open || $('passwordDialog').open) return;
  if (event.ctrlKey || event.metaKey) return;
  const viewport = $('viewport'), maxScroll = Math.max(0,viewport.scrollHeight - viewport.clientHeight);
  const busy = $('spread').getAttribute('aria-busy') === 'true';
  const numbers = spreadPages(state.page,state.pdf.numPages,state.mode,state.cover);
  const direction = wheelNavigation.consume({time:performance.now(),deltaY:event.deltaY,deltaX:event.deltaX,deltaMode:event.deltaMode,
    top:viewport.scrollTop,maxScroll,canNext:numbers.at(-1) < state.pdf.numPages,canPrevious:state.page > 1,busy,shiftKey:event.shiftKey});
  const vertical = !event.shiftKey && Math.abs(event.deltaY) > Math.abs(event.deltaX);
  const atEdge = event.deltaY > 0 ? viewport.scrollTop >= maxScroll - 1 : viewport.scrollTop <= 1;
  if (vertical && (direction || busy || atEdge || wheelNavigation.blocksScroll)) event.preventDefault();
  if (direction) navigate(direction,{wheel:true});
}, {passive: false});
// Keep Ctrl-wheel a 1% PDF adjustment over the tools as well; never let Chrome
// zoom the whole interface while the reader is open.
window.addEventListener('wheel', event => {
  if (!state.pdf || !event.deltaY || (!event.ctrlKey && !event.metaKey)) return;
  event.preventDefault(); setZoom((Math.round(state.zoom * 100) + (event.deltaY < 0 ? 1 : -1)) / 100);
}, {passive:false});
window.addEventListener('keydown', event => {
  if (event.key === 'F11') {
    // Use the explicit immersive PDF view rather than Chrome's independent
    // fullscreen toggle that leaves the reader UI visible.
    event.preventDefault(); event.stopImmediatePropagation();
    if (!event.repeat && !document.querySelector('dialog[open]')) void toggleFullscreen();
  }
}, {capture: true});
window.addEventListener('keydown', event => {
  if (document.querySelector('dialog[open]')) return;
  if (event.key === 'Escape' && (document.body.classList.contains('reading-focus') || matchMedia('(display-mode: fullscreen)').matches)) { event.preventDefault(); leaveReading(); return; }
  if (event.key === 'Escape') {
    const panel = readerPanels.find(name => !$(name+'Panel').hidden);
    if (panel) { event.preventDefault(); closeReaderPanels(); panelTrigger(panel).focus(); return; }
  }
  if (event.key === 'Escape' && !$('practicePopover').hidden) { event.preventDefault(); closePracticeMenu(); return; }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'o') { event.preventDefault(); startupCancelled = true; $('fileInput').click(); return; }
  if (event.target.matches('input,select,textarea') || event.ctrlKey || event.metaKey || event.altKey || !state.pdf) return;
  if (['ArrowLeft','PageUp'].includes(event.key)) { event.preventDefault(); navigate(-1); }
  else if (['ArrowRight','PageDown'].includes(event.key)) { event.preventDefault(); navigate(1); }
  else if (event.key === 'Home' || event.key === 'End') { event.preventDefault(); wheelNavigation.reset(performance.now()); state.page = event.key === 'Home' ? 1 : state.pdf.numPages; void renderCurrent({resetScroll: true}); }
  else if (['+', '='].includes(event.key)) { event.preventDefault(); setZoom(state.zoom + .1); }
  else if (event.key === '-') { event.preventDefault(); setZoom(state.zoom - .1); }
  else if (event.key === '0') $('fitPage').click();
  else if (event.key.toLowerCase() === 'r') $('rotate').click();
  else if (event.key.toLowerCase() === 'f') void toggleFullscreen();
});
window.addEventListener('dragenter', event => { if (event.dataTransfer?.types.includes('Files')) { event.preventDefault(); dragDepth++; $('dropOverlay').hidden = false; } });
window.addEventListener('dragover', event => { if (event.dataTransfer?.types.includes('Files')) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; } });
window.addEventListener('dragleave', event => { if (--dragDepth <= 0) { dragDepth = 0; $('dropOverlay').hidden = true; } });
window.addEventListener('drop', event => { event.preventDefault(); dragDepth = 0; $('dropOverlay').hidden = true; const file = event.dataTransfer?.files[0]; if (file) void openLocalFile(file); });
let resizeTimer;
// Scrollbars alter the content box, but are not a window/sidebar resize.
new ResizeObserver(() => { clearTimeout(resizeTimer); if (state.pdf) resizeTimer = setTimeout(() => renderCurrent(), 160); }).observe($('viewport'), {box:'border-box'});
let alignmentFrame;
$('viewport').addEventListener('scroll', () => { cancelAnimationFrame(alignmentFrame); alignmentFrame = requestAnimationFrame(alignSpreadToPixels); }, {passive:true});
function watchPixelRatio() {
  matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`).addEventListener('change', () => {
    watchPixelRatio(); if (state.pdf) void renderCurrent();
  }, {once:true});
}
watchPixelRatio();
window.matchMedia('(max-width: 800px)').addEventListener('change', event => { if (event.matches) toggleSidebar(false); });
document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement && document.body.classList.contains('reading-focus')) leaveReading();
});
window.addEventListener('beforeunload', savePosition);
document.addEventListener('visibilitychange', updateReadingClock);
if (window.innerWidth < 800) toggleSidebar(false);
void Promise.all([
  loadLibrary(),
  fetch('./practice-links.json').then(response => response.ok ? response.json() : {files: []}).then(data => { practiceCatalog = data.files || []; }).catch(() => {}),
]).then(restoreLastDocument).finally(() => updateNativeWindow('icon'));
