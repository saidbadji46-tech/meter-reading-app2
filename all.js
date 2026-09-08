



/* ====== DATA ====== */
const ANNOTATIONS = [
  {code:'INH', label:'مسكن خالي'},
  {code:'AS', label:'غياب مشترك'},
  {code:'N.F', label:'باب مغلق'},
  {code:'AR', label:'تلف عداد'},
  {code:'FC', label:'تسرب ماء'},
  {code:'VLD', label:'سرقة الماء'},
  {code:'C.cs', label:'زجاج مكسور'},
  {code:'INC', label:'غيرممكن'},
  {code:'ILS', label:'غير مرئي'},
  {code:'TP', label:'رقم أقل'},
  {code:'MLP', label:'تركيب خاطىء'},
  {code:'CO', label:'مقطوع'},
  {code:'RS', label:'محذوف'},
  {code:'INV', label:'اتجاه معكوس'},
];
const LOW_READING_REASONS = [
  {code:'INH', label:'INH'},
  {code:'alonveur', label:'alonveur'},
  {code:'Tp', label:'Tp'},
  {code:'Nouveau compteu', label:'Nouveau compteu'},
  {code:'rtor aziro', label:'rtor aziro'},
  {code:'AR', label:'AR'},
];

let meters = [];
let settings = { price: 25, currency: 'دج', routeNum: 'T00001', worker: '', triplet: '1' };
let currentMeterId = null;
let currentTab = 'tab-all';
let selectedAnnots = [];
let pendingLowReading = null;
let currentMode = 'list';
let formSnapshotAtOpen = null;
let signatureDirty = false;
let barcodeStream = null;
let pinBuffer = '';
let pinMode = 'unlock';
let pinSetupFirst = '';
let pinSetupStep = 0;
let roundArchives = [];
let currentRoundCreatedAt = null;

/* ====== STORAGE (self-contained IndexedDB — works in any browser, no external platform needed) ====== */
const IDB_NAME = 'meterReadingAppDB';
const IDB_STORE = 'kv';
let idbPromise = null;
function openIDB(){
  if(idbPromise) return idbPromise;
  idbPromise = new Promise((resolve, reject)=>{
    try{
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = ()=>{ req.result.createObjectStore(IDB_STORE); };
      req.onsuccess = ()=> resolve(req.result);
      req.onerror = ()=> reject(req.error);
    }catch(e){ reject(e); }
  });
  return idbPromise;
}
function idbGetRaw(key){
  return openIDB().then(db=> new Promise((resolve,reject)=>{
    const tx = db.transaction(IDB_STORE, 'readonly');
    const req = tx.objectStore(IDB_STORE).get(key);
    req.onsuccess = ()=> resolve(req.result===undefined ? null : req.result);
    req.onerror = ()=> reject(req.error);
  }));
}
function idbSetRaw(key, value){
  return openIDB().then(db=> new Promise((resolve,reject)=>{
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(value, key);
    tx.oncomplete = ()=> resolve(true);
    tx.onerror = ()=> reject(tx.error);
  }));
}
function idbDeleteRaw(key){
  return openIDB().then(db=> new Promise((resolve,reject)=>{
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).delete(key);
    tx.oncomplete = ()=> resolve(true);
    tx.onerror = ()=> reject(tx.error);
  }));
}
async function sg(k){ try{ return await idbGetRaw(k); }catch(e){ return null; } }
async function ss(k,v){ try{ await idbSetRaw(k,v); }catch(e){} }
async function safeSet(k,v){ try{ await idbSetRaw(k,v); return true; }catch(e){ return false; } }
async function safeDelete(k){ try{ await idbDeleteRaw(k); }catch(e){} }

async function loadData(){
  const m = await sg('meters'); meters = m ? JSON.parse(m) : [];
  // Restore serials previously extracted during import, even for customers
  // that already existed before the import.
  try{
    const sm = await sg('serialByMeter');
    if(sm){
      const map = JSON.parse(sm) || {};
      let changed = false;
      meters.forEach(x=>{
        const key = String(x.meter||'').trim().toUpperCase();
        if(key && !x.meterSerial && map[key]){ x.meterSerial = String(map[key]); changed = true; }
      });
      if(changed) await saveMeters();
    }
  }catch(e){}
  const s = await sg('settings'); if(s){ settings=Object.assign(settings, JSON.parse(s)); }
  try{ const a=await sg('roundArchives'); roundArchives=a?JSON.parse(a):[]; }catch(e){ roundArchives=[]; }
  if(settings.darkMode) document.body.classList.add('dark');
  currentRoundCreatedAt = settings.currentRoundCreatedAt || Date.now();
  document.getElementById('mRouteNum').value = settings.routeNum;
  document.getElementById('mTriplet').value = String(settings.triplet||'1');
  document.getElementById('mWorkerName').value = settings.worker||'';
  document.getElementById('mPrice').value = settings.price;
  document.getElementById('mCurrency').value = settings.currency;
  document.querySelectorAll('.cur2').forEach(el=>el.textContent=settings.currency);
  document.getElementById('topBadge').textContent = settings.routeNum;
  renderAll();
  setTimeout(()=>{const sp=document.getElementById('splash');if(sp){sp.style.opacity='0';setTimeout(()=>sp.remove(),400);}},700);
  setTimeout(showPinOverlay,750);
}
async function saveMeters(){ await ss('meters', JSON.stringify(meters)); }
async function saveSettings3(){ await ss('settings', JSON.stringify(settings)); }

/* ====== TOAST ====== */
function toast(msg){
  const t=document.getElementById('toast');
  t.textContent=msg; t.classList.add('show');
  clearTimeout(window._tt);
  window._tt=setTimeout(()=>t.classList.remove('show'),2000);
}

/* ====== NAV ====== */
function navSwitch(mode){
  currentMode = mode;
  document.getElementById('manageScreen').style.display = mode==='manage'?'block':'none';
  document.getElementById('tabsBar').style.display = mode==='list'?'flex':'none';
  document.getElementById('fabAdd').style.display = mode==='list'?'flex':'none'; /* handled by FAB id */
  document.getElementById('topTitle').textContent = mode==='manage'?'الإعدادات والإدارة':'قراءات العدادات';
  document.getElementById('topBadge').textContent = mode==='manage'?'⚙️':settings.routeNum;
  document.getElementById('backBtn').style.display='none';
  document.querySelectorAll('.nav-btn').forEach((b,i)=>b.classList.toggle('active', (i===0&&mode==='list')||(i===1&&mode==='manage')));
}
const fabEl = document.querySelector('.fab');
function navSwitchVisible(){
  fabEl.style.display = (currentMode==='list' && currentTab!=='tab-stats') ? 'flex' : 'none';
}

function switchTab(tabId, btn){
  currentTab = tabId;
  document.querySelectorAll('.view').forEach(v=>v.classList.remove('active'));
  document.getElementById(tabId).classList.add('active');
  document.querySelectorAll('.tab-btn').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
  navSwitchVisible();
  if(tabId === 'tab-map') renderMapList();
  else renderAll();
}

function goBack(){
  if(document.getElementById('view-releve').classList.contains('active') && formSnapshotAtOpen!==null){
    const dirty = currentFormSnapshot() !== formSnapshotAtOpen;
    if(dirty && !confirm('عندك معلومات لم تُحفظ لهذا الزبون. تريد الخروج بدون حفظ؟')) return;
  }
  document.getElementById('view-releve').classList.remove('active');
  document.getElementById(currentTab).classList.add('active');
  document.getElementById('backBtn').style.display='none';
  document.getElementById('topTitle').textContent='قراءات العدادات';
  document.getElementById('topBadge').textContent=settings.routeNum;
  fabEl.style.display='flex';
  document.querySelector('.bottom-nav').style.display='flex';
  formSnapshotAtOpen = null;
}

/* ====== RENDER LIST ====== */
function escH(s){ return (s||'').replace(/[<>&"']/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&#39;'}[c])); }

function renderAll(){
  const q=(document.getElementById('searchBox')||{value:''}).value.toLowerCase();
  const qFlat=q.replace(/\s+/g,'');
  const matchQ = m=>{
    if(!q) return true;
    return (m.name||'').toLowerCase().includes(q)
        || (m.meter||'').toLowerCase().includes(q)
        || (m.address||'').toLowerCase().includes(q)
        || (m.meterSerial||'').toLowerCase().replace(/\s+/g,'').includes(qFlat);
  };
  const done=meters.filter(m=>m.status==='done'&&matchQ(m));
  const pending=meters.filter(m=>m.status!=='done'&&m.status!=='anom'&&matchQ(m));
  const anom=meters.filter(m=>m.status==='anom'&&matchQ(m));
  const filtered=meters.filter(matchQ);

  const pct = meters.length ? Math.round(done.length/meters.length*100) : 0;
  const pl = document.getElementById('progressLabel');
  const pf = document.getElementById('progressFill');
  if(pl){ pl.textContent=`${done.length} / ${meters.length}`; }
  if(pf){ pf.style.width=pct+'%'; }

  renderListTo('listAll', filtered);
  renderListTo('listDone', done);
  renderListTo('listPending', pending);
  renderListTo('listAnom', anom);
  renderStats2(done, pending, anom);
  renderDeepDashboard();
  renderArchive();
}


function doSearch(){
  renderAll();
  const q=(document.getElementById('searchBox')||{value:''}).value.trim();
  toast(q ? '🔎 تم تنفيذ البحث' : '🔎 عرض جميع الزبائن');
}

function normalizeAnnotList(value){
  if(Array.isArray(value)) return value.filter(Boolean).map(c=>c==='00'?'INH':(c==='ZC'?'VLD':(c==='GE'?'C.cs':(c==='IV'?'MLP':c))));
  if(!value) return [];
  return String(value).split(/\s*\+\s*|\s*,\s*|\s*\|\s*/).filter(Boolean).map(c=>c==='00'?'INH':(c==='ZC'?'VLD':(c==='GE'?'C.cs':(c==='IV'?'MLP':c))));
}

function renderListTo(containerId, list){
  const el = document.getElementById(containerId);
  if(!el) return;
  if(!meters.length && containerId==='listAll'){
    el.innerHTML=`<div class="empty-state"><div class="ico">🚰</div><p>لا توجد عدادات بعد.<br>اضغط + لإضافة عداد جديد.</p></div>`;
    return;
  }
  if(!list.length){
    el.innerHTML=`<div class="empty-state"><div class="ico">✅</div><p>لا توجد نتائج في هذه الفئة.</p></div>`;
    return;
  }
  el.innerHTML = list.map((m,i)=>{
    const statusCls = m.status==='done'?'status-done':m.status==='anom'?'status-anom':'status-pending';
    const chip = m.status==='done'
      ? `<span class="chip chip-done">مرفوعة</span>`
      : m.status==='anom'
      ? `<span class="chip chip-anom">${escH(m.annot||'إشارة')}</span>`
      : `<span class="chip chip-pending">معلّقة</span>`;
    const idxDisplay = m.status==='done'
      ? `<div class="meter-index done">${m.newIndex}</div>`
      : `<div class="meter-index" style="color:var(--muted);">——</div>`;
    return `
      <div class="meter-row" onclick="openMeter('${m.id}')">
        <div class="meter-status-bar ${statusCls}"></div>
        <div class="meter-body">
          <div class="meter-num">#${escH(m.meter)} &nbsp;·&nbsp; ${escH(m.subType||'10')}</div>
          <div class="meter-addr">${escH(m.name)}</div>
          <div class="meter-meta">
            <span>🔢 ${escH(m.meterSerial||'—')}</span>
            <span>📍 ${escH(m.address||'—')}</span>
            ${m.status==='done' ? `<span>📊 استهلاك ${m.consumption} م³</span>` : ''}
          </div>
          ${chip}
        </div>
        <div class="meter-right">${idxDisplay}</div>
      </div>`;
  }).join('');
}

function renderStats2(done, pending, anom){
  const n=meters.length;
  document.getElementById('sSubs').textContent=n;
  document.getElementById('sDone').textContent=done.length;
  document.getElementById('sPending').textContent=pending.length;
  document.getElementById('sAnom').textContent=anom.length;
  const maxW=100;
  const bar=(el,cnt)=>{ const b=document.getElementById(el); if(b) b.style.width=(n?Math.round(cnt/n*maxW):0)+'%'; };
  const cnt=(el,v)=>{ const b=document.getElementById(el); if(b) b.textContent=v; };
  bar('cDone',done.length); cnt('cDoneCnt',done.length);
  bar('cPending',pending.length); cnt('cPendingCnt',pending.length);
  bar('cAnom',anom.length); cnt('cAnomCnt',anom.length);
}

/* ===== PRO DASHBOARD / ARCHIVE / VALIDATION ===== */
function archiveStats(ms){
  const done=ms.filter(m=>m.status==='done'), anom=ms.filter(m=>m.status==='anom');
  return {total:ms.length,done:done.length,anom:anom.length,pending:ms.length-done.length-anom.length,consumption:done.reduce((s,m)=>s+(Number(m.consumption)||0),0)};
}
function getPreviousRound(){
  const route=getRouteExportName();
  const same=roundArchives.filter(a=>a.route!==route || a.createdAt<currentRoundCreatedAt);
  return same.sort((a,b)=>b.createdAt-a.createdAt)[0] || null;
}
function validateReadingSmart(m,val){
  if(isNaN(val)) return {ok:true};
  if(val < Number(m.prevIndex||0)) return {ok:false,type:'low',msg:'القراءة الجديدة أقل من القراءة السابقة.'};
  const hist=(m.history||[]).map(Number).filter(x=>x>=0);
  const ch=Array.isArray(m.consumptionHistory)?m.consumptionHistory.map(Number).filter(x=>x>=0):[];
  const archived=roundArchives.flatMap(a=>(a.meters||[]).filter(x=>x.meter===m.meter).map(x=>Number(x.consumption)).filter(x=>x>=0));
  const allHist=ch.concat(archived);
  const avg=allHist.length?allHist.reduce((a,b)=>a+b,0)/allHist.length:null;
  const cons=val-Number(m.prevIndex||0);
  if(avg!=null && avg>0 && cons>Math.max(avg*3,avg+30)) return {ok:false,type:'high',msg:`الاستهلاك ${cons} م³ أعلى بكثير من المعدل المعتاد (~${avg.toFixed(1)} م³).`};
  return {ok:true};
}
function renderDeepDashboard(){
  const canvas=document.getElementById('dailyProgressChart'); if(!canvas) return;
  const ctx=canvas.getContext('2d'), w=canvas.clientWidth||330, h=190, dpr=window.devicePixelRatio||1; canvas.width=w*dpr;canvas.height=h*dpr;ctx.setTransform(dpr,0,0,dpr,0,0);
  ctx.clearRect(0,0,w,h);
  const by={}; meters.filter(m=>m.savedAt).forEach(m=>{const k=new Date(m.savedAt).toLocaleDateString('ar-DZ',{day:'2-digit',month:'2-digit'});by[k]=(by[k]||0)+(m.status==='done'?1:0)});
  const keys=Object.keys(by); const vals=keys.map(k=>by[k]); const max=Math.max(1,...vals); const pad=28;
  ctx.strokeStyle=getComputedStyle(document.body).getPropertyValue('--line');ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(pad,15);ctx.lineTo(pad,h-28);ctx.lineTo(w-10,h-28);ctx.stroke();
  if(!keys.length){ctx.fillStyle=getComputedStyle(document.body).getPropertyValue('--muted');ctx.font='12px Tajawal';ctx.fillText('سيظهر التطور هنا بعد حفظ القراءات',pad,80);return;}
  const step=keys.length===1?1:(w-pad-18)/(keys.length-1);ctx.beginPath();
  keys.forEach((k,i)=>{const x=pad+i*step,y=h-28-(vals[i]/max)*(h-55);i?ctx.lineTo(x,y):ctx.moveTo(x,y);});ctx.strokeStyle=getComputedStyle(document.body).getPropertyValue('--blue');ctx.lineWidth=3;ctx.stroke();
  keys.forEach((k,i)=>{const x=pad+i*step,y=h-28-(vals[i]/max)*(h-55);ctx.fillStyle=getComputedStyle(document.body).getPropertyValue('--blue');ctx.beginPath();ctx.arc(x,y,4,0,Math.PI*2);ctx.fill();ctx.fillStyle=getComputedStyle(document.body).getPropertyValue('--muted');ctx.font='10px Tajawal';ctx.textAlign='center';ctx.fillText(k,x,h-10);ctx.fillText(vals[i],x,y-9);});
  const prev=getPreviousRound(); const compare=document.getElementById('compareList');
  if(compare){ if(!prev){compare.innerHTML='<div class="empty-state" style="padding:18px 5px">لا توجد جولة سابقة للمقارنة بعد.</div>';} else {const rows=meters.map(m=>{const pm=prev.meters.find(x=>x.meter===m.meter); if(!pm||m.status!=='done')return null;const cur=Number(m.consumption)||0, old=Number(pm.consumption)||0, delta=cur-old,pct=old?delta/old*100:null;const suspicious=pct!=null&&Math.abs(pct)>=50;return `<div class="compare-row"><div class="compare-info"><div class="compare-name">${escH(m.name)}</div><div class="compare-meta">${escH(m.meter)} · الحالي ${cur} م³ · السابق ${old} م³</div></div><div class="${suspicious?(delta>0?'delta-up':'delta-down'):'delta-ok'}">${delta>0?'+':''}${delta} م³${pct!=null?` (${delta>0?'+':''}${pct.toFixed(0)}%)`:''}</div>${suspicious?'<span class="alert-pill">⚠️</span>':''}</div>`}).filter(Boolean); compare.innerHTML=rows.length?rows.slice(0,25).join(''):'<div class="empty-state" style="padding:18px">لا توجد قراءات مكتملة مشتركة.</div>';}}
  const rank=document.getElementById('rankList'); if(rank){const top=meters.filter(m=>m.status==='done').sort((a,b)=>(b.consumption||0)-(a.consumption||0)).slice(0,10);rank.innerHTML=top.length?top.map((m,i)=>`<div class="rank-row"><div class="rank-num">${i+1}</div><div class="rank-info"><div class="rank-name">${escH(m.name)}</div><div class="rank-meta">${escH(m.meter)}</div></div><div class="pro-value" style="font-size:16px">${m.consumption||0}<small style="font-size:9px"> م³</small></div></div>`).join(''):'<div class="empty-state" style="padding:18px">لا توجد قراءات بعد.</div>';}
  const lab=document.getElementById('dailyChartLabel');if(lab)lab.textContent=keys.length?`${keys.length} أيام`:'—';
}
async function archiveCurrentRound(silent=false){
  if(!meters.length){if(!silent)toast('لا توجد جولة لأرشفتها');return null;}
  const st=archiveStats(meters); if(st.pending>0&&!silent){if(!confirm(`مازال هناك ${st.pending} عداد غير مكتمل. هل تريد أرشفة الجولة رغم ذلك؟`))return null;}
  const route=getRouteExportName(); const existing=roundArchives.find(a=>a.route===route && Math.abs(a.createdAt-currentRoundCreatedAt)<5000); if(existing){if(!silent)toast('الجولة مؤرشفة مسبقاً');return existing;}
  const snap={id:'A'+Date.now(),route,createdAt:currentRoundCreatedAt||Date.now(),completedAt:Date.now(),settings:JSON.parse(JSON.stringify(settings)),meters:JSON.parse(JSON.stringify(meters)),stats:st};
  roundArchives.unshift(snap); if(roundArchives.length>50)roundArchives=roundArchives.slice(0,50); await ss('roundArchives',JSON.stringify(roundArchives)); if(!silent)toast('🗂️ تم حفظ الجولة في الأرشيف'); renderArchive();return snap;
}
function renderArchive(){const el=document.getElementById('archiveList');if(!el)return;if(!roundArchives.length){el.innerHTML='<div class="empty-state"><div class="ico">🗂️</div><p>لا توجد جولات سابقة بعد.</p></div>';return;}el.innerHTML=roundArchives.map(a=>`<div class="archive-card"><div style="display:flex;justify-content:space-between;gap:8px"><div><div style="font-size:15px;font-weight:900;color:var(--blue)">${escH(a.route)}</div><div style="font-size:11px;color:var(--muted);margin-top:3px">${new Date(a.completedAt).toLocaleString('ar-DZ')}</div></div><span class="chip chip-done">${a.stats.done}/${a.stats.total} مرفوعة</span></div><div style="display:grid;grid-template-columns:repeat(3,1fr);gap:7px;margin-top:10px"><div class="stat-box" style="padding:8px"><b>${a.stats.total}</b><div class="lbl">زبون</div></div><div class="stat-box" style="padding:8px"><b>${a.stats.consumption}</b><div class="lbl">م³</div></div><div class="stat-box" style="padding:8px"><b>${a.stats.anom}</b><div class="lbl">إشارات</div></div></div><div class="archive-actions"><button class="btn-prim" onclick="openArchivedReport('${a.id}')">📋 التقرير</button><button class="btn-ghost" onclick="restoreArchive('${a.id}')">♻️ استرجاع</button></div></div>`).join('');}
/* ====== REPORT + FILE EXPORT (robust Android/Chrome) ====== */
function buildRouteReportHtml(){
  const st=archiveStats(meters);
  const totalConsumption=meters.filter(m=>m.status==='done').reduce((s,m)=>s+(Number(m.consumption)||0),0);
  const rows=meters.map((m,i)=>{
    const status=m.status==='done'?'مرفوعة':m.status==='anom'?'إشارة':'معلّقة';
    const loc=(m.lat!=null&&m.lng!=null)?`<a href="https://www.google.com/maps?q=${encodeURIComponent(m.lat+','+m.lng)}" target="_blank">📍 فتح الموقع</a>`:'—';
    return `<tr><td>${i+1}</td><td>${escH(m.meter)}</td><td>${escH(m.name||'')}</td><td>${escH(m.address||'')}</td><td>${m.newIndex!=null?escH(m.newIndex):'—'}</td><td>${escH(m.consumption??'—')}</td><td>${escH(status)}</td><td>${loc}</td></tr>`;
  }).join('');
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>تقرير الجولة ${escH(getRouteExportName())}</title><style>
  *{box-sizing:border-box}body{font-family:Arial,Tahoma,sans-serif;margin:0;background:#f4f6f8;color:#222;padding:18px}.head{background:#1565C0;color:#fff;border-radius:16px;padding:20px;text-align:center}.head h1{margin:0 0 7px;font-size:24px}.meta{font-size:13px;opacity:.9}.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:14px 0}.card{background:#fff;border-radius:12px;padding:14px;text-align:center;box-shadow:0 2px 8px #0001}.num{font-size:23px;font-weight:900;color:#1565C0}.lbl{font-size:12px;color:#777;margin-top:4px}table{width:100%;border-collapse:collapse;background:#fff;border-radius:12px;overflow:hidden}th{background:#1565C0;color:#fff;padding:10px;font-size:12px}td{padding:9px;border-bottom:1px solid #eee;font-size:11px}a{color:#1565C0;font-weight:800;text-decoration:none}.foot{margin-top:15px;color:#777;font-size:11px;text-align:center}@media(max-width:650px){.stats{grid-template-columns:repeat(2,1fr)}body{padding:10px}th,td{padding:7px 5px}}
  @media print{body{background:#fff;padding:0}.head{border-radius:0}.card{box-shadow:none}a{color:#000;text-decoration:none}}
  </style></head><body><section class="head"><h1>📋 تقرير الجولة</h1><div class="meta">الجولة: <b>${escH(getRouteExportName())}</b> · العامل: ${escH(settings.worker||'—')} · ${new Date().toLocaleString('ar-DZ')}</div></section>
  <div class="stats"><div class="card"><div class="num">${st.total}</div><div class="lbl">إجمالي الزبائن</div></div><div class="card"><div class="num">${st.done}</div><div class="lbl">مرفوعة</div></div><div class="card"><div class="num">${st.pending}</div><div class="lbl">معلّقة</div></div><div class="card"><div class="num">${st.anom}</div><div class="lbl">إشارات</div></div><div class="card"><div class="num">${totalConsumption}</div><div class="lbl">الاستهلاك م³</div></div><div class="card"><div class="num">${meters.filter(m=>m.lat!=null&&m.lng!=null).length}</div><div class="lbl">GPS</div></div><div class="card"><div class="num">${meters.filter(m=>m.hasPhoto).length}</div><div class="lbl">صور</div></div><div class="card"><div class="num">${meters.filter(m=>m.signatureData).length}</div><div class="lbl">توقيعات</div></div></div>
  <table><thead><tr><th>#</th><th>الرمز</th><th>الاسم</th><th>العنوان</th><th>القراءة</th><th>الاستهلاك</th><th>الحالة</th><th>الموقع</th></tr></thead><tbody>${rows}</tbody></table><div class="foot">تقرير مولد من تطبيق قراءات العدادات · ${new Date().toLocaleString('ar-DZ')}</div></body></html>`;
}
function showReportHtml(html, printAfter=false){
  const modal=document.getElementById('reportModal'), frame=document.getElementById('reportFrame');
  if(!modal||!frame){toast('تعذر فتح نافذة التقرير');return;}
  modal.style.display='flex';modal.classList.add('show');modal.setAttribute('aria-hidden','false');
  frame.onload=()=>{if(printAfter)setTimeout(()=>{try{frame.contentWindow.focus();frame.contentWindow.print();}catch(e){toast('تعذر تشغيل الطباعة');}},300)};
  frame.srcdoc=html;
}
function closeReportModal(){const modal=document.getElementById('reportModal');if(modal){modal.classList.remove('show');modal.style.display='none';modal.setAttribute('aria-hidden','true')}const f=document.getElementById('reportFrame');if(f)f.srcdoc='';}
function printReportModal(){const f=document.getElementById('reportFrame');if(f&&f.contentWindow){try{f.contentWindow.focus();f.contentWindow.print()}catch(e){toast('تعذر تشغيل الطباعة')}}}
function openArchivedReport(id){const a=roundArchives.find(x=>x.id===id);if(!a)return;const oldM=meters,oldS=settings;meters=a.meters;settings=a.settings;const html=buildRouteReportHtml();meters=oldM;settings=oldS;showReportHtml(html,false)}
function openRouteReport(){if(!meters.length){toast('لا توجد بيانات لإنشاء التقرير');return}showReportHtml(buildRouteReportHtml(),false)}
function printRouteReport(){if(!meters.length){toast('لا توجد بيانات لإنشاء التقرير');return}showReportHtml(buildRouteReportHtml(),true)}

async function getExportDirectory(){
  let h=null;
  try{h=await idbGetRaw('exportDirHandle');}catch(e){}
  if(h){try{const p=await h.queryPermission({mode:'readwrite'});if(p==='granted')return h;const r=await h.requestPermission({mode:'readwrite'});if(r==='granted')return h;}catch(e){}}
  if(window.showDirectoryPicker){
    h=await window.showDirectoryPicker({id:'ADE_EXPORT',mode:'readwrite'});
    await idbSetRaw('exportDirHandle',h);
    return h;
  }
  return null;
}
async function saveExportToCliente(blob,fileName){
  // Preferred: File System Access API. User selects Stockage interne once; ADE is created automatically.
  try{
    const root=await getExportDirectory();
    if(root){
      const ade=await root.getDirectoryHandle('ADE',{create:true});
      const route=await ade.getDirectoryHandle(getRouteExportName(),{create:true});
      const fh=await route.getFileHandle(fileName,{create:true});
      const w=await fh.createWritable();await w.write(blob);await w.close();
      return true;
    }
  }catch(e){console.warn('direct storage export unavailable',e)}
  // Safe fallback when directory access is unavailable.
  try{const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=fileName;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1500);toast('تم تنزيل الملف إلى مجلد التنزيلات');return true}catch(e){console.error(e);return false}
}
async function exportTXT(){
  if(!meters.length){toast('لا توجد بيانات لتصديرها');return false}
  try{
    const headers=['meter','meterSerial','name','address','subType','phone','prevIndex','newIndex','consumption','amount','status','annot','lowReadingReason','obs','hasPhoto','savedAt'];
    const lines=[headers.join('\t')];
    meters.forEach(m=>lines.push([m.meter,m.meterSerial||'',m.name,m.address||'',m.subType||'',m.phone||'',m.prevIndex,m.newIndex!=null?m.newIndex:'',m.consumption||'',m.amount||'',m.status,m.annot||'',m.lowReadingReason||'',(m.obs||'').replace(/\t|\n/g,' '),m.hasPhoto?'1':'0',m.savedAt||''].join('\t')));
    const ok=await saveExportToCliente(new Blob(['\uFEFF'+lines.join('\n')],{type:'text/plain;charset=utf-8'}),`${getRouteExportName()}.txt`);
    if(ok)toast('✅ تم تصدير TXT');return ok;
  }catch(e){console.error(e);toast('⚠️ تعذر تصدير TXT');return false}
}

function setExportProgress(title,pct,text){const box=document.getElementById('exportProgress');if(!box)return;box.classList.add('show');document.getElementById('epTitle').textContent=title||'جاري تجهيز الملف...';document.getElementById('epFill').style.width=Math.max(0,Math.min(100,pct||0))+'%';document.getElementById('epText').textContent=text||Math.round(pct||0)+'%';}
function hideExportProgress(){const box=document.getElementById('exportProgress');if(box)box.classList.remove('show');}
async function exportCompleteRound(){
  if(!meters.length){ toast('لا توجد بيانات لتصديرها'); return; }
  try{
    setExportProgress('جاري تصدير الجولة كاملة...',5,'بدء التجهيز');
    await exportResultsZip();
    setExportProgress('جاري تصدير الجولة كاملة...',90,'تم إنشاء ZIP');
    if(archiveStats(meters).pending===0) await archiveCurrentRound(true);
    await exportTXT();
    setExportProgress('اكتمل التصدير',100,'تم حفظ ZIP وTXT');
    setTimeout(hideExportProgress,1200);
    toast(`✅ تم تصدير الجولة كاملة: ${getRouteExportName()}`);
  }catch(e){console.error(e);setExportProgress('تعذر تصدير الجولة',0,'حدث خطأ: '+(e?.message||e));setTimeout(hideExportProgress,3500);toast('⚠️ تعذر تصدير الجولة — راجع رسالة الخطأ');}
}

/* ====== OFFLINE XLSX BUILDER ====== */
function xlsxEsc(v){return String(v??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');}
function xlsxCol(n){let s='';n++;while(n){let r=(n-1)%26;s=String.fromCharCode(65+r)+s;n=Math.floor((n-1)/26);}return s;}
async function buildOfflineXlsx(rows){
  const zip=new JSZip();
  const headers=Object.keys(rows[0]||{});
  const all=[headers,...rows.map(r=>headers.map(h=>r[h]))];
  let sheet='';
  all.forEach((row,r)=>{sheet+=`<row r="${r+1}">`;row.forEach((v,c)=>{const ref=xlsxCol(c)+(r+1);const val=xlsxEsc(v);sheet+=`<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${val}</t></is></c>`;});sheet+='</row>';});
  const worksheet=`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheet}</sheetData></worksheet>`;
  const workbook=`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="القراءات" sheetId="1" r:id="rId1"/></sheets></workbook>`;
  const rels=`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
  const wbRels=`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`;
  const types=`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`;
  zip.file('[Content_Types].xml',types);zip.folder('_rels').file('.rels',rels);zip.folder('xl').file('workbook.xml',workbook);zip.folder('xl/_rels').file('workbook.xml.rels',wbRels);zip.folder('xl/worksheets').file('sheet1.xml',worksheet);
  return await zip.generateAsync({type:'uint8array',compression:'STORE'});
}

/* ====== EXPORT RESULTS (Excel + Photos ZIP) ====== */
async function exportResultsZip(){
  if(!meters.length){ toast('لا توجد بيانات لتصديرها'); return; }
  try{
    setExportProgress('جاري تجهيز ZIP...',10,'إنشاء جدول القراءات');
    const rows = meters.map(m=>({
      'رمز الزبون':m.meter,'الرقم التسلسلي للعداد':m.meterSerial||'','الاسم':m.name,'العنوان':m.address||'','نوع المشترك':m.subType||'','الهاتف':m.phone||'','رقم التعريف الوطني':m.nationalId||'','القراءة السابقة':m.prevIndex,'القراءة الجديدة':m.newIndex!=null?m.newIndex:'','الاستهلاك (م³)':m.consumption||'','المبلغ':m.amount||'','الحالة':m.status==='done'?'مرفوعة':(m.status==='anom'?'إشارة':'معلّقة'),'كود الإشارات':m.annot||'','سبب القراءة الأقل/المساوية':m.lowReadingReason||'','الملاحظة':m.obs||'','لديه صورة':m.hasPhoto?'نعم':'لا','خط العرض':m.lat||'','خط الطول':m.lng||'','رابط الخريطة':(m.lat&&m.lng)?`https://www.google.com/maps?q=${m.lat},${m.lng}`:'','تاريخ الرفع':m.savedAt?new Date(m.savedAt).toLocaleString('ar'):''
    }));
    setExportProgress('جاري تجهيز ZIP...',25,'إنشاء ملف Excel بدون إنترنت');
    const xlsxOut=await buildOfflineXlsx(rows);
    const zip=new JSZip();
    const txtHeaders=['meter','meterSerial','name','address','subType','phone','prevIndex','newIndex','consumption','amount','status','annot','lowReadingReason','obs','hasPhoto','savedAt'];
    const txtLines=[txtHeaders.join('\t')];
    meters.forEach(m=>txtLines.push([m.meter,m.meterSerial||'',m.name,m.address||'',m.subType||'',m.phone||'',m.prevIndex,m.newIndex!=null?m.newIndex:'',m.consumption||'',m.amount||'',m.status,m.annot||'',m.lowReadingReason||'',(m.obs||'').replace(/\t|\n/g,' '),m.hasPhoto?'1':'0',m.savedAt||''].join('\t')));
    zip.file(`${getRouteExportName()}.txt`,'\uFEFF'+txtLines.join('\n'));zip.file('client.xlsx',xlsxOut);
    setExportProgress('جاري تجهيز ZIP...',40,'إضافة الصور والتوقيعات');
    const photosFolder=zip.folder('الصور');let photoCount=0;
    for(let i=0;i<meters.length;i++){
      const m=meters[i];
      if(m.hasPhoto){try{const dataUrl=await Promise.race([sg('photo:'+m.id),new Promise(r=>setTimeout(()=>r(null),5000))]);if(dataUrl&&String(dataUrl).includes(',')){const b=String(dataUrl).split(',')[1];if(b){photosFolder.file(`${m.meter}.jpg`,b,{base64:true});photoCount++;}}}catch(e){console.warn('photo skipped',m.id,e);}}
      setExportProgress('جاري تجهيز ZIP...',40+Math.round((i+1)/meters.length*20),`الصور ${photoCount}`);
    }
    const sigFolder=zip.folder('التوقيعات');let sigCount=0;meters.forEach(m=>{if(m.signatureData){const b=String(m.signatureData).split(',')[1];if(b){sigFolder.file(`${m.meter}.png`,b,{base64:true});sigCount++;}}});
    setExportProgress('جاري تجهيز ZIP...',65,'إضافة المواقع والتقرير');
    let locRows='';meters.forEach(m=>{if(m.lat&&m.lng){const u=`https://www.google.com/maps?q=${encodeURIComponent(m.lat+','+m.lng)}`;locRows+=`<tr><td>${escH(m.meter)}</td><td>${escH(m.name)}</td><td>${escH(m.address||'—')}</td><td><a href="${u}" target="_blank">📍 ${Number(m.lat).toFixed(6)}, ${Number(m.lng).toFixed(6)}</a></td></tr>`;}});
    const locHtml=`<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>مواقع الزبائن</title><style>body{font-family:Arial,Tahoma,sans-serif;padding:12px;background:#f5f5f5}h2{color:#1565C0}table{width:100%;border-collapse:collapse;background:#fff}th{background:#1565C0;color:#fff;padding:10px}td{padding:9px;border-bottom:1px solid #eee}a{color:#1565C0;font-weight:bold;text-decoration:none}</style></head><body><h2>📍 مواقع الزبائن</h2><table><tr><th>رمز الزبون</th><th>الاسم</th><th>العنوان</th><th>الموقع</th></tr>${locRows}</table></body></html>`;
    zip.file('المواقع.html',locHtml);zip.file('تقرير الجولة.html',buildRouteReportHtml());
    setExportProgress('جاري ضغط ZIP...',75,'ضغط الملفات');
    const blob=await zip.generateAsync({type:'blob',compression:'STORE'},meta=>{const pct=75+Math.round((meta.percent||0)*0.23);setExportProgress('جاري ضغط ZIP...',pct,Math.round(meta.percent||0)+'%');});
    setExportProgress('جاري حفظ ZIP...',99,'حفظ الملف');
    const ok=await saveExportToCliente(blob,`${getRouteExportName()}.zip`);
    if(!ok)throw new Error('لم يتم حفظ ZIP');
    setExportProgress('تم إنشاء ZIP',100,`${photoCount} صورة • ${sigCount} توقيع`);
    setTimeout(hideExportProgress,1000);
    toast(`✅ تم تجهيز ZIP للجولة ${getRouteExportName().replace(/^R/,'')} (${photoCount} صورة)`);
    return true;
  }catch(e){console.error('exportResultsZip failed',e);setExportProgress('تعذر إنشاء ZIP',0,e?.message||'خطأ غير معروف');setTimeout(hideExportProgress,4000);toast('⚠️ تعذر إنشاء ZIP');throw e;}
}

/* ====== EXPORT / IMPORT (JSON backup) ====== */
function exportJSON(){
  const blob=new Blob([JSON.stringify({meters,settings},null,2)],{type:'application/json'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');a.href=url;a.download=`${settings.routeNum}_${new Date().toISOString().slice(0,10)}.json`;a.click();URL.revokeObjectURL(url);
  toast('تم التصدير');
}
function importJSON(input){
  const file=input.files[0]; if(!file) return;
  const r=new FileReader();
  r.onload=async e=>{ try{ const d=JSON.parse(e.target.result); meters=d.meters||[]; if(d.settings) settings=Object.assign(settings,d.settings); settings.currentRoundCreatedAt=Date.now(); currentRoundCreatedAt=settings.currentRoundCreatedAt; await saveMeters(); await saveSettings3(); renderAll(); toast('تم الاستيراد'); }catch(err){ toast('خطأ في قراءة الملف'); } };
  r.readAsText(file);
}
async function confirmClear(){
  if(!confirm('سيتم مسح جميع العدادات والقراءات والصور نهائياً. متابعة?')) return;
  for(const m of meters){
    if(m.hasPhoto){ await safeDelete('photo:'+m.id); }
  }
  meters=[]; await saveMeters(); renderAll(); toast('تم المسح');
}

/* ====== CLOSE MODAL ON OUTSIDE CLICK ====== */
document.getElementById('addModal').addEventListener('click',e=>{ if(e.target.id==='addModal') closeAddModal(); });

/* ===== PIN SECURITY ===== */
function pinRequired(){return !!settings.pinHash}
function simpleHash(s){let h=2166136261;for(let i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,16777619)}return String(h>>>0)}
function showPinOverlay(){if(!pinRequired())return;pinBuffer='';pinMode='unlock';renderPinPad();document.getElementById('pinOverlay').classList.add('show')}
function renderPinPad(){const pad=document.getElementById('pinPad');pad.innerHTML=['1','2','3','4','5','6','7','8','9','⌫','0','✓'].map(k=>`<button class="pin-key" onclick="pinKey('${k}')">${k}</button>`).join('');updatePinDots()}
function updatePinDots(){document.querySelectorAll('.pin-dot').forEach((d,i)=>d.classList.toggle('on',i<pinBuffer.length));}
async function pinKey(k){if(k==='⌫'){pinBuffer=pinBuffer.slice(0,-1);updatePinDots();return;}if(k==='✓'){if(pinBuffer.length!==4){document.getElementById('pinMsg').textContent='أدخل 4 أرقام';return;}if(pinMode==='unlock'){if(simpleHash(pinBuffer)===settings.pinHash){document.getElementById('pinOverlay').classList.remove('show');pinBuffer='';}else{pinBuffer='';updatePinDots();document.getElementById('pinMsg').textContent='رمز PIN غير صحيح';}}else if(pinMode==='setup1'){pinSetupFirst=pinBuffer;pinBuffer='';pinMode='setup2';document.getElementById('pinMsg').textContent='أعد إدخال الرمز للتأكيد';updatePinDots();}else{if(pinBuffer===pinSetupFirst){settings.pinHash=simpleHash(pinBuffer);await saveSettings3();document.getElementById('pinOverlay').classList.remove('show');toast('🔐 تم تفعيل PIN');}else{pinBuffer='';pinMode='setup1';document.getElementById('pinMsg').textContent='الرمزان غير متطابقين';updatePinDots();}}return;}if(/\d/.test(k)&&pinBuffer.length<4){pinBuffer+=k;updatePinDots();}}
function setupPin(){pinBuffer='';pinMode='setup1';document.getElementById('pinMsg').textContent='أدخل رمز PIN جديد من 4 أرقام';renderPinPad();document.getElementById('pinOverlay').classList.add('show')}
async function disablePin(){if(!settings.pinHash){toast('PIN غير مفعّل');return;}if(confirm('إلغاء قفل PIN؟')){delete settings.pinHash;await saveSettings3();toast('🔓 تم إلغاء PIN');}}

/* ====== INIT ====== */
loadData();


if ('serviceWorker' in navigator) {
  let refreshing = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (refreshing) return;
    refreshing = true;
    window.location.reload();
  });

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').then(reg => {
      reg.update().catch(()=>{});
      reg.addEventListener('updatefound', () => {
        const newWorker = reg.installing;
        if(!newWorker) return;
        newWorker.addEventListener('statechange', () => {
          if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
            showUpdateBanner(newWorker);
          }
        });
      });
    }).catch(err => console.error('SW registration failed:', err));
  });
}

function showUpdateBanner(worker){
  if(document.getElementById('updateBar')) return;
  const bar = document.createElement('div');
  bar.id = 'updateBar';
  bar.style.cssText = 'position:fixed;bottom:0;left:0;right:0;background:#1565C0;color:#fff;padding:12px 16px;display:flex;justify-content:space-between;align-items:center;z-index:99999;font-size:13.5px;box-shadow:0 -2px 10px rgba(0,0,0,.2);';
  bar.innerHTML = '<span>🔄 تحديث جديد متوفر للتطبيق</span><button id="updateBtn" style="background:#fff;color:#1565C0;border:none;padding:8px 14px;border-radius:8px;font-weight:700;font-size:13px;">تحديث الآن</button>';
  document.body.appendChild(bar);
  document.getElementById('updateBtn').onclick = () => {
    worker.postMessage({type:'SKIP_WAITING'});
    bar.remove();
  };
}
