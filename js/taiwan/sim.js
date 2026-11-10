// 台灣地震速報模擬：自訂／預設地震 → 測站觸發 → 本機定位 → 發布速報（一般／緊急）→ 鄉鎮震度預測與倒數
import { STATIONS, TOWNS, loadTowns, townAt, describeEpicenter, distKm } from './geo.js';
import { createScenario, locate, locateRobust, noticeCandidates, NOTICE, triggerOf, predictAt, loadModel, loadWorst, worstOf, sourceDist, arrived, pdOf, MODEL, dominantFreq, randomQuake, PRESETS, VP, VS } from './eew.js';
import { siteOf, siteClass } from './site.js';
import { INTENSITY_COLORS, intensity, intensityIndex } from '../detector.js';
import { TaiwanMap, shortInt } from './map.js';

const $ = id => document.getElementById(id);
// 只有內容改變才寫入 DOM（避免每一格畫面都重建 HTML，造成卡頓）
const setHTML = (el, html) => { if (el._html !== html) { el.innerHTML = html; el._html = html; } };
const PROCESS_MS = 300;
const MAX_REPORTS = Infinity;   // 報數無上限：每有新測站或規模更新就發新一報
const END_MS = 75000;
const EMERGENCY_M = 5.5;          // 預估規模 > 5.5
const EMERGENCY_INT = '4';        // 且任一測站實測震度 ≥ 4 級 → 強震即時訊息

const badge = n => `<span class="badge" style="background:${INTENSITY_COLORS[n]}">${n}</span>`;
const hhmmss = t => new Date(t).toLocaleTimeString('zh-TW', { hour12: false });
const hypo = (lon, lat, so) => Math.hypot(distKm(lon, lat, so.lon, so.lat), so.depth);

export class TaiwanEEW {
  constructor({ onQuake, sound }) {
    this.onQuake = onQuake; this.sound = sound;
    this.sc = null; this.mode = 'intensity'; this.hoverTown = null;
    this.map = new TaiwanMap($('twMap'), {
      // 待命時點地圖＝設定震央；地震進行中點地圖＝顯示該鄉鎮的即時資訊（手機沒有滑鼠移過去的功能）
      onClick: (p, e) => { if (!this.sc || this.reveal) this.setEpicenter(p); else if (p && e) this.onHover(p, e); },
      onHover: (p, e) => this.onHover(p, e),
    });
    $('zIn').onclick = () => this.map.zoomBy(1.5);
    $('zOut').onclick = () => this.map.zoomBy(1 / 1.5);
    $('zReset').onclick = () => { this.map.reset(); this.follow(); };
    $('twFollow').onchange = () => { if ($('twFollow').checked) { this.map.userMoved = false; this.follow(); } };
    this.ready = this.init();
  }

  async init() {
    const [, model] = await Promise.all([loadTowns(), loadModel(), loadWorst()]);
    $('twModel').textContent = model
      ? `預估式：USGS 實測訓練（${model.data.events} 個地震、${model.data.records} 筆紀錄）`
      : '預估式：手設教學模型';
    for (const t of TOWNS) Object.assign(t, siteOf(t.c[0], t.c[1]));
    $('twN').textContent = STATIONS.length;
    this.startWorker();   // 先把背景計算執行緒準備好（載入鄉鎮與模型），地震發生時不用再等
    this.cells ??= this.buildCells(); this.cellTowns ??= this.buildCellTowns();   // 區塊網格也先建好
    setInterval(() => this.step(Date.now()), 100);   // 速報邏輯每 0.1 秒執行一次（與畫面繪製分開）
    // 真實地震回放：震源用官方目錄值，結束後用當時各測站實測震度對答案
    try { this.realEvents = await (await fetch('data/real-events.json')).json(); } catch { this.realEvents = []; }
    for (const ev of this.realEvents) for (const st of ev.stations) {
      const t = townAt(st.lon, st.lat);
      st.site = { ...siteOf(st.lon, st.lat), id: t?.id }; st.obs = intensity(st.pga, st.pgv);
    }
    $('twPreset').innerHTML = '<option value="">— 選擇情境 —</option>'
      + `<optgroup label="真實地震回放（含實測對答案）">${this.realEvents.map((e, i) => `<option value="r${i}">${e.name}　M${e.M}・${e.stations.length} 站實測</option>`).join('')}</optgroup>`
      + `<optgroup label="模擬情境">${PRESETS.map((p, i) => `<option value="${i}">${p.name}（M${p.M}）</option>`).join('')}</optgroup>`;
    $('twPreset').onchange = () => {
      const v = $('twPreset').value;
      this.selectedReal = v.startsWith('r') ? this.realEvents[+v.slice(1)] : null;
      const p = this.selectedReal || PRESETS[v];
      if (p) this.fill(p, true);
    };
    $('twRandom').onclick = () => { this.selectedReal = null; $('twPreset').value = ''; this.fill(randomQuake()); };
    ['twLon', 'twLat', 'twDepth', 'twM'].forEach(id => $(id).oninput = () => { $('twPreset').value = ''; this.selectedReal = null; this.syncLabels(); });
    $('twStart').onclick = () => this.start();

    const counties = [...new Set(TOWNS.map(t => t.county))];
    $('twHomeCounty').innerHTML = counties.map(c => `<option${c === '臺北市' ? ' selected' : ''}>${c}</option>`).join('');
    const fillTowns = () => {
      const list = TOWNS.filter(t => t.county === $('twHomeCounty').value);
      $('twHomeTown').innerHTML = list.map(t => `<option value="${t.id}"${t.name === '中正區' ? ' selected' : ''}>${t.name}</option>`).join('');
      this.updateHome();
    };
    $('twHomeCounty').onchange = fillTowns;
    $('twHomeTown').onchange = () => this.updateHome();
    fillTowns();

    document.querySelectorAll('[data-layer]').forEach(b => b.onclick = () => {
      this.mode = b.dataset.layer;
      document.querySelectorAll('[data-layer]').forEach(x => x.classList.toggle('on', x === b));
      $('legendInt').hidden = this.mode !== 'intensity'; $('legendSite').hidden = this.mode !== 'site';
    });
    this.fill(PRESETS[0]); $('twPreset').value = '0';
    this.renderIdle();
  }

  fill(q) {
    $('twLon').value = q.lon.toFixed(2); $('twLat').value = q.lat.toFixed(2);
    $('twDepth').value = Math.round(q.depth); $('twM').value = q.M.toFixed(1);
    this.syncLabels();
  }
  setEpicenter(p) { $('twPreset').value = ''; this.selectedReal = null; $('twLon').value = p.lon.toFixed(2); $('twLat').value = p.lat.toFixed(2); this.syncLabels(); }
  syncLabels() {
    $('twDepthV').textContent = `${$('twDepth').value} km`;
    $('twMV').textContent = `M ${(+$('twM').value).toFixed(1)}`;
    // 超出訓練資料範圍（最大 M7.7、最深 246 km）時提示為外推
    $('twExtrap').hidden = !(+$('twM').value > 7.7 || +$('twDepth').value > 246);
    const d = describeEpicenter(+$('twLon').value, +$('twLat').value);
    $('twWhere').textContent = d.where.replace('位於', '');
  }
  readQuake() {
    const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
    return { lon: clamp(+$('twLon').value, 119, 123), lat: clamp(+$('twLat').value, 21, 26.5), depth: clamp(+$('twDepth').value, 1, 300), M: clamp(+$('twM').value, 3, 10) };
  }

  updateHome() {
    const t = TOWNS.find(t => t.id === $('twHomeTown').value);
    this.homeTown = t; this.homeIdx = TOWNS.indexOf(t);
    const sc = siteClass(t.vs30);
    $('twHomeSite').textContent = `地盤：${sc.name}（Vs30 約 ${t.vs30} m/s），搖晃放大約 ${t.ampA.toFixed(2)} 倍`;
    $('twHomeName').textContent = `${t.county}${t.name}`;
  }
  get home() { const t = this.homeTown; return t && { name: `${t.county}${t.name}`, short: t.name, lon: t.c[0], lat: t.c[1], site: t }; }

  start() {
    if (!this.homeTown) return;
    // 第一次按「發生地震」時請求系統通知權限（瀏覽器規定必須由使用者操作觸發）
    if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {});
    // 真實地震回放：直接用官方目錄的精確震源值
    this.real = this.selectedReal || null;
    const q = this.real ? { lon: this.real.lon, lat: this.real.lat, depth: this.real.depth, M: this.real.M } : this.readQuake();
    const t0 = Date.now() + 1500;
    this.sc = createScenario(q, t0);
    // 真實地震回放：虛擬測站 6 km 內若有當時的真實測站，就改用真實量到的 PGA／PGV
    // → 測站實測震度（與 PLUM 即時修正）反映真實情況，例如 0403 臺北盆地實測 5 弱
    if (this.real) {
      let replaced = 0;
      for (const s of this.sc.stations) {
        let best = null;
        for (const st of this.real.stations) { const d = distKm(s.lon, s.lat, st.lon, st.lat); if (d < 6 && (!best || d < best.d)) best = { st, d }; }
        if (best) { s.pga = best.st.pga; s.pgv = best.st.pgv; s.pAmp = best.st.pga * 0.3 * 10 ** (0.1 * (Math.random() - 0.5)); s.realObs = true; replaced++; }
      }
      this.realReplaced = replaced;
    }
    Object.assign(this, { sol: null, report: 0, lastN: 0, lastUsed: 0, lastReportN: 0, issued: null, busy: false, job: null, rejected: null, realEval: null, lastSpeech: 0, lastCalc: 0, firstIssued: null, firstNotice: null, prelim: null, cancelled: 0, maxLand: null, region: null, homeAlerted: null, homeInRegion: false, localPick: null, reveal: false,
      townInts: null, lastTick: null, arrived: false, level: null });

    // 本站（我的位置）收到的地震波 → 送進模擬器
    const h = this.home;
    const R = Math.hypot(distKm(h.lon, h.lat, q.lon, q.lat), q.depth);
    const tp = t0 + (R / VP) * 1000, ts = t0 + (R / VS) * 1000;
    this.homeTruth = predictAt(q.M, sourceDist(h.lon, h.lat, q), h.site, q.depth);
    this.homePd = pdOf(q.M, R);   // 本站地震儀的 P 波位移（若由本站先偵測到，也能用來估規模）
    // 回放真實地震時，若你家 10 km 內有實測測站，就用「當時實際量到的」當作你家的真實搖晃
    if (this.real) {
      let best = null;
      for (const st of this.real.stations) { const d = distKm(h.lon, h.lat, st.lon, st.lat); if (d < 10 && (!best || d < best.d)) best = { st, d }; }
      if (best) this.homeTruth = { pga: best.st.pga, pgv: best.st.pgv, n: best.st.obs, real: true, dist: best.d };
    }
    this.onQuake({ t0: tp, sp: ts - tp, peak: this.homeTruth.pga / 100 / 1.15, freq: dominantFreq(q.M), dur: 6000 + (q.M - 4) * 5000 });

    $('twStart').disabled = true;
    document.body.classList.add('quake-on');
    document.body.classList.remove('eew-emergency');
    this.map.userMoved = false; // 新地震重新開始自動追蹤
    $('eewCard').className = 'eew-card idle waiting';
    setHTML($('eewCard'), `<div class="ttl">${this.real ? `回放：${this.real.name}` : '監測中…'}</div><p>等待測站偵測 P 波</p>`);
    // 地震開始：收起設定、展開各地預估；手機上捲回地圖
    $('secSetup').open = false; $('secHome').open = false; $('secTowns').open = true;
    $('mapStatus').hidden = false;
    if (matchMedia('(max-width: 760px)').matches) window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  onLocalTrigger(t) { if (!this.sc || this.localPick || this.reveal) return false; this.localPick = t; return true; }

  // 目前所有觸發（含誤觸發）；本站地震儀偵測到 P 波也算一站
  currentPicks(now) {
    const out = [];
    for (const s of this.sc.stations) { const tr = triggerOf(s); if (arrived(tr, now)) out.push({ ...s, ...tr }); }
    if (this.localPick) out.push({ name: '本站', lon: this.home.lon, lat: this.home.lat, tp: this.localPick, pAmp: this.homeTruth.pga * 0.3, pd: this.homePd, site: this.home.site, local: true });
    return out.sort((a, b) => a.tp - b.tp);
  }

  // 測站目前實測震度：S 波到達前只有 P 波（振幅小），之後為完整地動
  stationInt(s, now) {
    if (s.local || now < s.tp) return null;
    return now >= s.ts ? intensity(s.pga, s.pgv) : intensity(s.pAmp, s.pgv * 0.3);
  }

  // 速報邏輯與畫面繪製分開：
  //   step()：由計時器每 0.1 秒執行（觸發、定位、發報、聲音、速報卡），不受畫面快慢影響
  //   tick()：由瀏覽器畫面更新呼叫，只負責畫地圖
  step(now) {
    if (!TOWNS.length || !this.sc) return;
    const sc = this.sc;
    const picks = this.currentPicks(now);
    const picked = new Set(picks.map(p => p.name));
    const stationInts = new Map();
    let maxObs = '0';
    for (const s of sc.stations) {
      const n = this.stationInt(s, now);
      if (!n) continue;
      stationInts.set(s.name, n);
      // 最大震度只採計陸上測站（海底站不代表有人居住地區的搖晃）
      if (s.type === 'land' && intensityIndex(n) > intensityIndex(maxObs)) maxObs = n;
    }
    this.maxObs = maxObs;
    // PLUM 用的陸上測站實測震度（只取已達 1 級以上）
    this.obsInts = new Map();
    for (const s of sc.stations) { const v = stationInts.get(s.name); if (v && v !== '0' && s.type === 'land') this.obsInts.set(s.name, v); }
    if (this.sol && !this.reveal && now - (this.lastPlum ?? 0) > 1000) { this.lastPlum = now; if (this.lastCalc !== now) this.refreshForecast(now); }

    // 每有新觸發就做「關聯＋定位」；至少 3 站互相確認才發布第一報，之後 8 站內每站更新、再來每 3 站更新
    const n = picks.length;
    const step = 1;   // 震央每多一站就重新修正（報數無上限）
    // 有新觸發時每 PROCESS_MS 計算一次（測站密集時觸發是連續進來的，不能等「安靜」才算）
    // 規模還在估算（Pd 未收滿）時，即使沒有新觸發也每秒重算一次：P 波視窗收滿後規模會變準，要即時更新
    const pdPending = this.sol && !this.sol.prelim && this.sol.nPd < 5 && now - (this.lastCalc ?? 0) >= 1000;
    // 計算交給背景執行緒（Web Worker）：送出工作後畫面照常繪製，結果回來再套用 → 計算再久也不卡畫面
    if (!this.reveal && !this.busy && n && now - (this.lastCalc ?? 0) >= PROCESS_MS && this.report < MAX_REPORTS
        && ((n > this.lastN && (this.report === 0 || n - this.lastReportN >= step)) || pdPending)) {
      this.lastN = n; this.lastCalc = now;
      const idle = sc.stations.filter(s => !picked.has(s.name));
      // 接續搜尋：沿用上一個正式解縮小搜尋範圍；每 3 秒做一次完整搜尋避免卡在錯誤位置
      const fullSearch = !this.sol || this.sol.prelim || now - (this.lastFullSearch ?? 0) > 3000;
      if (fullSearch) this.lastFullSearch = now;
      this.solveAsync(picks, idle, now, fullSearch ? null : this.sol, n);
    }
    // 範圍通知 5 秒內沒有其他測站確認 → 判定為雜訊，取消通知
    if (this.prelim && this.report === 0 && now - this.prelim.since > 5000) this.cancelPrelim(now);
    this.follow(now); // 每一幀更新追蹤目標（跟著 S 波擴散縮小）
    // 速報等級也可能在兩報之間因測站實測震度升級
    if (this.sol && !this.reveal && this.level === 'normal' && this.isEmergency()) { this.report++; this.snapshotIssue(now); this.announce(now, null, true); }   // 升級為強震即時訊息也算新的一報

    if (!this.reveal && now - sc.q.t0 > END_MS) { this.reveal = true; $('twStart').disabled = false; document.body.classList.remove('quake-on'); }
    // 範圍通知階段：地圖只畫正方形警示區域（尚未確認，不逐鄉鎮上色）；正式速報後才逐鄉鎮上色
    // 鄉鎮震度上色：正式速報後才上色（範圍通知階段未確認，不上色）
    // 區塊方框：只亮在「已偵測到 P 波」的區域（見 pBlocks），對這些區塊做預警
    this.pRegion = this.reveal ? null : this.pBlocks(picks);
    this.frame = { picked, stationInts };
    this.render(now, n);
    this.updateTip(now);   // 滑鼠停著不動時，資訊框也跟著震度更新
    if (this.reveal) document.body.classList.remove('eew-emergency');
    if (this.reveal && now - sc.q.t0 > END_MS + 60000) { this.sc = null; this.frame = null; this.renderIdle(); }
  }

  tick(now) {
    if (!TOWNS.length) return;
    if (!this.sc || !this.frame) { this.map.draw({ mode: this.mode, now, home: this.home, homeTown: this.homeIdx, hoverTown: this.hoverTown, pickPoint: this.readQuake() }); return; }
    const sc = this.sc, { picked, stationInts } = this.frame;
    this.map.draw({ mode: this.mode, scenario: sc, now, solution: this.sol, townInts: this.sol?.prelim ? null : this.townInts,
      region: this.pRegion, picked, stationInts, rejected: this.rejected,
      realStations: this.reveal && this.real ? this.real.stations : null,
      level: this.sol?.prelim ? null : this.level,
      home: this.home, homeTown: this.homeIdx, hoverTown: this.hoverTown, reveal: this.reveal, pickPoint: this.reveal ? this.readQuake() : null });
  }

  // 自動追蹤：每一報把地圖飛到推算震央；規模越大顯示範圍越廣（倍率越小）
  // 並隨 S 波擴散逐漸縮小，讓整個 S 波圓保持在畫面內；縮得越小，中心越往台灣本島中央移
  follow(now = Date.now()) {
    if (!$('twFollow').checked || this.map.userMoved || !this.sol || this.reveal) return;
    const so = this.sol;
    const zMag = Math.min(4, Math.max(1.6, 4.5 - (so.M - 5) * 1.2));
    const el = Math.max(0, (now - so.t0) / 1000);
    const rs = Math.sqrt(Math.max(0, (VS * el) ** 2 - so.depth ** 2));      // S 波地表半徑（km）
    const c = this.map.canvas, fitPx = 0.42 * Math.min(c.clientWidth, c.clientHeight);
    const zFit = rs > 0 && this.map.baseKmPx ? fitPx / (rs * this.map.baseKmPx) : zMag;
    const z = Math.max(1, Math.min(zMag, zFit));
    const k = zMag > 1 ? (zMag - z) / (zMag - 1) : 1;                      // 0＝震央置中，1＝台灣置中
    this.map.flyTo(so.lon + (120.95 - so.lon) * k, so.lat + (23.65 - so.lat) * k, z);
  }

  // ---- PLUM（Propagation of Local Undamped Motion）----
  // 日本氣象廳 2018 年起、美國 ShakeAlert 也採用的方法：不靠震源參數，直接把「附近測站已經實測到的震度」
  // 當作該地即將遭遇的震度（30 km 內取最大值，不做距離衰減）。
  // 優點：大地震（斷層破裂很長）、同時發生多個地震時，震源模型容易低估，PLUM 仍能正確預警。
  // 最終預估 = max(震源模型預估, PLUM 預估)
  static PLUM_KM = 30;
  plumMax(n, town) {
    if (!this.obsInts?.size) return n;
    this.plumNb ??= new Map();
    let nb = this.plumNb.get(town.id);
    if (!nb) { nb = STATIONS.filter(s => s.type === 'land' && distKm(s.lon, s.lat, town.c[0], town.c[1]) <= TaiwanEEW.PLUM_KM).map(s => s.name); this.plumNb.set(town.id, nb); }
    let best = n;
    for (const name of nb) { const o = this.obsInts.get(name); if (o && intensityIndex(o) > intensityIndex(best)) best = o; }
    return best;
  }

  // 每秒用最新的測站實測（PLUM）更新各鄉鎮預估與警示區，震源解不變
  refreshForecast(now) {
    const sol = this.sol; if (!sol) return;
    this.townInts = TOWNS.map(tw => this.plumMax(predictAt(sol.M, sourceDist(tw.c[0], tw.c[1], sol), tw, sol.depth).n, tw));
    this.townWorst = this.calcWorst(sol);
    let mi = 0; this.townInts.forEach((v, i) => { if (intensityIndex(v) > intensityIndex(this.townInts[mi])) mi = i; });
    this.maxLand = { n: this.townInts[mi], town: TOWNS[mi] };
    this.region = this.computeRegion(sol);
    this.checkHomeAlert(now);
  }

  // 套用一個震源解：計算各鄉鎮預估震度與陸地最大震度，以及區域警示範圍
  setForecast(sol, now, calcMs) {
    this.sol = sol; sol.calcMs = calcMs; sol.issued = now;
    this.townInts = TOWNS.map(tw => this.plumMax(predictAt(sol.M, sourceDist(tw.c[0], tw.c[1], sol), tw, sol.depth).n, tw));
    this.townWorst = this.calcWorst(sol);
    let mi = 0; this.townInts.forEach((v, i) => { if (intensityIndex(v) > intensityIndex(this.townInts[mi])) mi = i; });
    this.maxLand = { n: this.townInts[mi], town: TOWNS[mi] };
    this.region = this.computeRegion(sol);
    this.checkHomeAlert(now);
  }

  // ---- 背景計算 ----
  // 只傳必要欄位給 worker（測站物件很大，複製成本高）
  static slim = p => ({ name: p.name, lon: p.lon, lat: p.lat, tp: p.tp, pAmp: p.pAmp, pd: p.pd, type: p.type, local: p.local, isFalse: p.isFalse, site: p.site ? { ampA: p.site.ampA } : undefined });
  startWorker() {
    if (this.worker) return;
    this.worker = new Worker(new URL('./eew-worker.js', import.meta.url), { type: 'module' });
    this.worker.onmessage = ({ data }) => this.onSolved(data);
    this.jobId = 0;
  }
  solveAsync(picks, idle, now, prev, n) {
    this.startWorker();
    this.busy = true;
    const id = ++this.jobId;
    this.job = { id, n, sc: this.sc };
    const S = TaiwanEEW.slim;
    this.worker.postMessage({ id, type: 'solve', picks: picks.map(S), idle: idle.map(S), now,
      prev: prev && { lon: prev.lon, lat: prev.lat, depth: prev.depth, M: prev.M }, wantNotice: this.report === 0 });
  }

  onSolved({ id, sol, notice, calcMs }) {
    this.busy = false;
    const job = this.job;
    if (!job || job.id !== id || job.sc !== this.sc || !this.sc || this.reveal) return;   // 已過期（地震結束或重新開始）
    const now = Date.now(), n = job.n;
    const morePd = sol && this.sol && sol.nPd > (this.sol.nPd ?? 0);    // 有更多測站收滿 Pd → 規模更新
    if (sol && (this.report === 0 || sol.n - this.lastUsed >= 1 || morePd)) {
      // ---- 正式速報：≥3 站互相確認 ----
      // 震央、規模、地圖每次都即時修正（靜默更新）；只有「明顯變化」才發布新的一報（報號＋聲音）
      const prevHome = this.issued?.home ?? null;
      this.prelim = null;
      this.setForecast(sol, now, calcMs);
      this.lastUsed = sol.n; this.lastReportN = n;
      this.rejected = new Set(sol.rejected.map(p => p.name));
      if (this.isSignificant(sol, now)) {
        this.report++;
        this.snapshotIssue(now);
        this.announce(now, prevHome);
      }
      this.follow();
    } else if (!sol && notice && this.report === 0) {
      // ---- 範圍通知（發送標準見 eew.js noticeCandidates；400 次模擬誤報率 83.5% → 2.0%）----
      const first = !this.prelim;
      if (first) this.prelim = { since: notice.used[0].tp };
      this.setForecast(notice, now, calcMs);
      if (first) this.announcePrelim(now);
      this.follow();
    }
  }

  // ---- 新報發布門檻 ----
  // 震央每多一站就即時修正，但「新的一報」只在有意義的變化時發布，避免報數氾濫：
  //   規模變化 ≥ 0.2、震央移動 ≥ 5 km、深度變化 ≥ 10 km（4 站以上）、你所在地預估震度改變、
  //   陸地最大震度改變、規模由「估算中」轉為「完整 Pd」；且兩報至少間隔 1 秒
  static ISSUE = { DM: 0.2, DKM: 5, DDEP: 10, MIN_GAP_MS: 1000 };
  isSignificant(sol, now) {
    const p = this.issued;
    if (!p || this.report === 0) return true;
    if (now - p.time < TaiwanEEW.ISSUE.MIN_GAP_MS) return false;
    const home = this.homePred(sol).n, max = this.maxLand?.n;
    return Math.abs(sol.M - p.M) >= TaiwanEEW.ISSUE.DM
      || distKm(sol.lon, sol.lat, p.lon, p.lat) >= TaiwanEEW.ISSUE.DKM
      || (sol.n >= 4 && Math.abs(sol.depth - p.depth) >= TaiwanEEW.ISSUE.DDEP)
      || home !== p.home || max !== p.max
      || (p.mPartial && !sol.mPartial);
  }
  snapshotIssue(now) {
    const s = this.sol;
    this.issued = { time: now, M: s.M, lon: s.lon, lat: s.lat, depth: s.depth, mPartial: s.mPartial, home: this.homePred(s).n, max: this.maxLand?.n };
  }

  // 各鄉鎮最嚴重可能震度（95% 信心）：不低於目前預估（含 PLUM）
  calcWorst(sol) {
    return TOWNS.map((tw, i) => {
      const w = worstOf(predictAt(sol.M, sourceDist(tw.c[0], tw.c[1], sol), tw, sol.depth), sol), n = this.townInts[i];
      return w && intensityIndex(w) > intensityIndex(n) ? w : n;
    });
  }

  // ---- P 波偵測區塊（地圖上的方框）----
  // 只有「測站已經偵測到 P 波」的地方才亮框：以觸發測站為中心，10 km 內的區塊亮起，
  // 顏色＝該區塊的預估震度（範圍通知階段未確認，一律黃色），對這些區塊做區塊預警。
  // 觸發要和目前的震源解吻合（P 波到時殘差 ≤ 1.5 秒）才算，誤觸發不會亮框。
  pBlocks(picks) {
    const so = this.sol;
    if (!so || !this.cells || !this.cellLv) return null;
    const keys = new Set();
    for (const p of picks) {
      const tt = (Math.hypot(distKm(p.lon, p.lat, so.lon, so.lat), so.depth) / VP) * 1000;
      if (Math.abs(p.tp - so.t0 - tt) > 1500) continue;            // 與這個地震不吻合 → 視為雜訊
      const [ci, cj] = this.cellKey(p.lon, p.lat).split(',').map(Number);
      for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
        const k = `${ci + di},${cj + dj}`, c = this.cells.get(k);
        if (c && distKm(c.lon, c.lat, p.lon, p.lat) <= TaiwanEEW.SIDE_KM) keys.add(k);
      }
    }
    const hx = TaiwanEEW.DLON / 2, hy = TaiwanEEW.DLAT / 2;
    const blocks = [...keys].map(k => { const c = this.cells.get(k); return { lon: c.lon, lat: c.lat, hx, hy, n: this.cellLv.get(k) ?? '0' }; });
    return blocks.length ? { blocks, prelim: !!so.prelim } : null;
  }

  // ---- 區域警示（正方形區塊）----
  // 全台切成 0.1°×0.1°（約 10 km）的正方形區塊，只保留中心在陸地上的格子，每格帶有所在鄉鎮的場址條件。
  // 測站越少，震央與規模越不確定，所以每格用「最壞情況」保守估計：
  //   震央可能偏差 u 公里 → 格子到震央的距離先減去 u（假設震央其實更靠近它）
  //   規模可能偏差 σ     → 用 M + σ 計算
  // 保守估計達警示門檻（≥ 4 級）的格子就是警示區；都沒有時改用 3 級門檻。
  // 固定大小的正方形網格：邊長 25.00 km（以公里換算經緯度，四邊等長，不是經緯度格）
  //   經度每格 = 25 ÷ (111.32 × cos 23.7°) = 0.24525°，緯度每格 = 25 ÷ 110.57 = 0.22610°
  static SIDE_KM = 25;
  // 達此規模（含規模不確定度）時，警示區加入預估式誤差保守量。
  // 12 個真實地震測試：門檻 M6.5 時中型地震（M5.5～6.1）實測 ≥4 級地區只框到 27～64%；
  // 改為 M5.0 後提升到 73～93%，多出的過度警示多半 0～4 站
  static BIG_M = 5.0;
  static DLON = TaiwanEEW.SIDE_KM / (111.32 * Math.cos(23.7 * Math.PI / 180));
  static DLAT = TaiwanEEW.SIDE_KM / 110.57;
  static O = [119.25, 21.85];
  buildCells() {
    const DX = TaiwanEEW.DLON, DY = TaiwanEEW.DLAT, [ox, oy] = TaiwanEEW.O, cells = new Map();
    for (let j = 0; oy + j * DY < 25.45; j++) for (let i = 0; ox + i * DX < 122.1; i++) {
      const cLon = ox + (i + 0.5) * DX, cLat = oy + (j + 0.5) * DY;
      // 中心在陸地 → 該鄉鎮；中心在海上但靠岸（4 km 內有鄉鎮中心）→ 歸給最近的鄉鎮，避免沿海鄉鎮漏格
      let town = townAt(cLon, cLat);
      if (!town) {
        let best = null;
        for (const t of TOWNS) { const d = distKm(cLon, cLat, t.c[0], t.c[1]); if (d < 4 && (!best || d < best.d)) best = { t, d }; }
        town = best?.t;
      }
      if (town) cells.set(`${i},${j}`, { i, j, lon: cLon, lat: cLat, town });
    }
    return cells;
  }
  // 每個區塊和哪些鄉鎮重疊：區塊內取 49 個取樣點（7×7，約每 3.5 km 一點）判斷所在鄉鎮，再加上中心點落在區塊內的鄉鎮
  // （大鄉鎮如秀林鄉會橫跨好幾個區塊，每個區塊都要算到它）
  buildCellTowns() {
    const m = new Map(), idx = new Map(TOWNS.map((t, i) => [t, i]));
    const hx = TaiwanEEW.DLON / 2, hy = TaiwanEEW.DLAT / 2;
    for (const [k, c] of this.cells) {
      const set = new Set();
      for (let a = -3; a <= 3; a++) for (let b = -3; b <= 3; b++) { const t = townAt(c.lon + (a / 3.2) * hx, c.lat + (b / 3.2) * hy); if (t) set.add(idx.get(t)); }
      m.set(k, set);
    }
    TOWNS.forEach((t, i) => { const k = this.cellKey(t.c[0], t.c[1]); if (m.has(k)) m.get(k).add(i); });
    // 反查：每個鄉鎮屬於哪些區塊（資訊框用）
    this.townCells = new Map();
    for (const [k, set] of m) for (const i of set) { if (!this.townCells.has(i)) this.townCells.set(i, []); this.townCells.get(i).push(k); }
    return m;
  }
  cellKey(lon, lat) {
    const [ox, oy] = TaiwanEEW.O;
    return `${Math.floor((lon - ox) / TaiwanEEW.DLON)},${Math.floor((lat - oy) / TaiwanEEW.DLAT)}`;
  }
  // 警示格 → 繪圖用方塊（大小固定）
  toBlocks(hit) {
    const hx = TaiwanEEW.DLON / 2, hy = TaiwanEEW.DLAT / 2;
    return [...hit].map(([k, n]) => { const c = this.cells.get(k); return { lon: c.lon, lat: c.lat, hx, hy, n }; });
  }

  computeRegion(sol) {
    this.cells ??= this.buildCells();
    const n = sol.n;
    const u = sol.prelim ? (n <= 1 ? 25 : n === 2 ? 15 : 10) : (n < 6 ? 5 : 3);           // 震央不確定度（km）
    // 規模不確定度；Pd 還沒收滿 3 秒時規模必定偏低（Pd 只會越來越大），再多加 0.5
    const sigM = (sol.prelim ? (n <= 1 ? 0.8 : 0.5) : (n < 6 ? 0.3 : 0.15)) + (sol.mPartial ? 0.5 : 0);
    // 模型誤差保守量：M ≥ 5.0 時，預估式本身的誤差（交叉驗證 1 個標準差，約 ×2）也算進去。
    // 例：2024 花蓮 0403，臺北實測 5 弱但預估式只到 4 級，加上這一項後臺北會被框進警示區
    const big = sol.M + sigM >= TaiwanEEW.BIG_M;
    const sA = big ? (MODEL?.test?.gmpeSite?.pgaRmsLog10 ?? 0.3) : 0, sV = big ? (MODEL?.test?.gmpeSite?.pgvRmsLog10 ?? 0.3) : 0;
    const conservative = (lon, lat, site) => {
      const rd = sourceDist(lon, lat, { ...sol, M: sol.M + sigM }), e2 = Math.sqrt(Math.max(0, rd * rd - sol.depth * sol.depth));
      const p = predictAt(sol.M + sigM, Math.hypot(Math.max(0, e2 - u), sol.depth), site, sol.depth);   // 離斷層的水平距離再減去震央誤差
      return big ? intensity(p.pga * 10 ** sA, p.pgv * 10 ** sV) : p.n;
    };
    const lv = new Map();
    for (const [k, c] of this.cells) lv.set(k, this.plumMax(conservative(c.lon, c.lat, c.town), c.town));
    // 畫面上 P 波區塊的震度：用「最佳估計」（和鄉鎮上色、清單、資訊框同一套算法），避免同一地點顯示兩種震度；
    // 保守估計（lv）只在後台用來判斷「你是否在警示區內」
    // 一個 25 km 區塊會涵蓋好幾個鄉鎮 → 區塊震度＝區塊內各鄉鎮（中心點落在區塊內者）預估震度的最大值
    this.cellTowns ??= this.buildCellTowns();
    this.cellLv = new Map();
    for (const [k, c] of this.cells) {
      let best = this.plumMax(predictAt(sol.M, sourceDist(c.lon, c.lat, sol), c.town, sol.depth).n, c.town);
      for (const ti of this.cellTowns.get(k) ?? new Set()) { const v = this.townInts?.[ti]; if (v && intensityIndex(v) > intensityIndex(best)) best = v; }
      this.cellLv.set(k, best);
    }
    // 你所在位置也用同樣的保守估計（不受格子邊界影響）
    const he = this.home;
    const homeLv = he && conservative(he.lon, he.lat, he.site);
    const pick = thr => new Map([...lv].filter(([, n]) => intensityIndex(n) >= intensityIndex(thr)));
    let thr = '4', hit = pick(thr);
    if (!hit.size) { thr = '3'; hit = pick(thr); }
    if (!hit.size) return null;
    const cellKm2 = TaiwanEEW.SIDE_KM ** 2;
    const homeInside = !!he && (intensityIndex(homeLv) >= intensityIndex(thr) || hit.has(this.cellKey(he.lon, he.lat)));
    const blocks = this.toBlocks(hit);
    return { blocks, nBase: hit.size, thr, u, sigM, sigModel: big ? sV : 0, prelim: !!sol.prelim, areaKm2: hit.size * cellKm2, homeInside };
  }

  // 你的位置在警示區內 → 發送通知（每次地震只發一次）
  checkHomeAlert(now) {
    const r = this.region, h = this.home;
    this.homeInRegion = !!r?.homeInside;
    if (!r || this.homeAlerted || !h || !r.homeInside) return;
    this.homeAlerted = now;
    const hp = this.homePred(this.sol), sec = Math.ceil((hp.ts - now) / 1000);
    const body = `${h.name}位於警示區域內，預估 ${hp.n} 級${sec > 0 ? `，約 ${sec} 秒後抵達` : ''}`;
    try {
      if ('Notification' in window && Notification.permission === 'granted')
        new Notification('地震區域警示', { body, tag: 'seismo-eew', requireInteraction: true, renotify: true });
    } catch { /* 部分瀏覽器（如 iOS Safari 分頁）不支援 */ }
    navigator.vibrate?.([400, 150, 400, 150, 800]);
    this.homeInRegion = true;
  }

  announcePrelim(now) {
    this.firstNotice = now;
    const d = this.sound.regionAlert(this.homeInRegion);
    const where = describeEpicenter(this.sol.lon, this.sol.lat).where.replace('位於', '');
    this.say(this.homeInRegion ? `區域警示，你所在的地區可能有強烈搖晃，請注意` : `偵測到P波，${where}附近`, d);
  }

  cancelPrelim(now) {
    this.prelim = null; this.sol = null; this.townInts = null; this.maxLand = null; this.lastTick = null;
    this.region = null; this.homeAlerted = null; this.homeInRegion = false; this.firstNotice = null;
    this.cancelled = (this.cancelled || 0) + 1;
    $('eewBanner').hidden = true;
    $('eewCard').className = 'eew-card idle waiting';
    setHTML($('eewCard'), `<div class="ttl">範圍通知已取消</div><p>5 秒內沒有其他測站確認，判定為單站雜訊（已取消 ${this.cancelled} 次）。持續監測中…</p>`);
    this.say('通知取消');
  }

  isEmergency() { return !this.sol.prelim && this.sol.M > EMERGENCY_M && intensityIndex(this.maxObs) >= intensityIndex(EMERGENCY_INT); }

  homePred(so) {
    const h = this.home, R = hypo(h.lon, h.lat, so), Rr = sourceDist(h.lon, h.lat, so);
    const p = predictAt(so.M, Rr, h.site, so.depth);   // 震度用斷層距離；抵達時間仍用震源距離
    const n = this.plumMax(p.n, h.site), w = worstOf(p, so);
    const worst = w && intensityIndex(w) > intensityIndex(n) ? w : n;   // 最嚴重可能震度（95% 信心），不低於目前預估
    return { ...p, n, worst, ts: so.t0 + (R / VS) * 1000 };   // 你所在地也套用 PLUM
  }

  // 語音格式：「N 級地震，N 秒後抵達」
  phrase(n, sec) {
    const lvl = /[弱強]/.test(n) ? `${n}地震` : `${n}級地震`;
    return sec > 0 ? `${lvl}，${sec}秒後抵達` : `${lvl}，已抵達`;
  }
  say(text, delay = 0) { this.sound.speak(text, delay); this.lastSpeech = Date.now() + delay * 1000; }

  announce(now, prevInt, upgrade = false) {
    const so = this.sol, hp = this.homePred(so);
    const sec = Math.ceil((hp.ts - now) / 1000);
    const emergency = this.isEmergency();
    if (this.report === 1 || upgrade) {
      if (this.report === 1) this.firstIssued = now;
      this.level = emergency ? 'emergency' : 'normal';
      const d = emergency ? this.sound.eewEmergency() : this.sound.eewNormal();
      // 強震即時訊息語音先講類別與行動；一般地震速報只報震度與秒數
      this.say(emergency ? `強震即時訊息，${this.phrase(hp.n, sec)}，請立即避難` : `地震速報，${this.phrase(hp.n, sec)}`, d);
      document.body.classList.toggle('eew-emergency', emergency);
    } else {
      if (now - (this.lastUpdateSound ?? 0) > 3000) { this.lastUpdateSound = now; this.sound.update(); }   // 更新頻繁時提示音至少間隔 3 秒
      if (prevInt && prevInt !== hp.n && sec > 2) this.say(this.phrase(hp.n, sec), 0.2);
    }
  }

  render(now, nPicks) {
    $('twPicks').textContent = `${nPicks} / ${this.sc.stations.length} 站觸發`;
    $('twElapsed').textContent = `發震後 ${((now - this.sc.q.t0) / 1000).toFixed(1)} 秒`;
    const so = this.sol;
    if (!so) return;
    const h = this.home, hp = this.homePred(so);
    const left = (hp.ts - now) / 1000, sec = Math.ceil(left);
    const lead = (hp.ts - (this.firstNotice ?? this.firstIssued)) / 1000; // 預警時間：從第一次通知（範圍通知或第一報）算起

    if (!this.reveal && sec !== this.lastTick) {
      this.lastTick = sec;
      // 整十秒播報剩餘秒數（避開剛播完速報的 3 秒內）
      if (sec > 0 && sec % 10 === 0 && Date.now() - (this.lastSpeech ?? 0) > 3000) this.say(`${sec}秒`);
      else if (sec > 0 && sec <= 5) this.sound.tick(sec);
      if (sec <= 0 && !this.arrived) { this.arrived = true; this.sound.arrive(); }
    }

    // ---- 速報卡：三層資訊 ----
    // 1. 你所在地：震度＋倒數（最大）  2. 地震概況：規模、深度、最大震度、震央  3. 技術細節（一行小字）
    const prelim = !!so.prelim;
    const emergency = this.level === 'emergency';
    const kind = prelim ? 'prelim' : emergency ? 'emergency' : 'normal';
    const title = prelim ? 'P 波偵測・範圍通知' : emergency ? '強震即時訊息' : '一般地震速報';
    const sub = prelim ? `未確認 · ${so.n} 站` : `第 ${this.report} 報 · ${hhmmss(this.issued?.time ?? so.issued)}`;
    const epi = describeEpicenter(so.lon, so.lat);
    const ml = this.maxLand;
    const cdText = left > 0 ? `${sec}<small>秒後抵達</small>` : (lead <= 0 ? '盲區<small>無預警時間</small>' : '已抵達');
    // 用語依速報類別區分：強震即時訊息要求立即避難；一般地震速報提醒注意
    const advice = left > 0
      ? (emergency ? '立即避難：趴下、掩護、穩住' : intensityIndex(hp.n) >= 3 ? '注意搖晃，遠離窗戶與易倒物品' : '可能感到輕微搖晃')
      : '注意安全，留意餘震';
    const t0 = this.sc.q.t0;
    $('eewCard').className = 'eew-card ' + kind;
    if (prelim) {
      // 正式速報之前：只呈現「區域警示方框」與你是否在框內，不顯示任何震度數字（尚未確認，避免誤導）
      const inZone = this.homeInRegion;
      setHTML($('eewCard'), `
        <div class="eew-type"><span>${title}</span><small>${sub}</small></div>
        <div class="eew-you">
          <div class="eew-lv zone ${inZone ? 'in' : ''}"><b>${inZone ? '!' : '—'}</b><small>${inZone ? '警示區內' : '區外'}</small></div>
          <div class="eew-cd">
            <span class="k">${h.name}</span>
            <div class="eew-sec ${inZone ? '' : 'out'}">${inZone ? (left > 0 ? `約 ${sec}<small>秒後搖晃</small>` : '搖晃中') : '不在警示區域'}</div>
            <div class="eew-place">${inZone ? '請立即趴下、掩護、穩住' : '持續注意後續速報'}</div>
          </div>
        </div>
        <div class="eew-epi" style="margin-top:12px">${this.sol.rule}（海底站 ${this.sol.used.filter(p => p.type === 'obs').length}），初估震源：${epi.where.replace('位於', '')}<br>震度數值將於正式速報（≥3 站定位）後公布</div>
        <div class="eew-meta">發震後 ${((this.firstNotice - t0) / 1000).toFixed(1)} 秒範圍通知 · ${this.region ? `${this.region.blocks.length} 個方塊、約 ${Math.round(this.region.areaKm2 / 100) * 100} km²（保守計入震央 ±${this.region.u} km、規模 +${this.region.sigM}）` : '尚未達警示門檻'}</div>`);
      this.renderBanner(kind, title, h, null, left, sec);
      $('twCount').textContent = '正式速報後顯示';
      $('twTable').innerHTML = '<p class="hint">範圍通知階段只顯示警示方框，震度數值待正式速報確認後公布。</p>';
      return;
    }
    setHTML($('eewCard'), `
      <div class="eew-type"><span>${title}</span><small>${sub}</small></div>
      <div class="eew-you">
        <div class="eew-lv" style="background:${INTENSITY_COLORS[hp.n]}"><b>${shortInt(hp.n)}</b><small>${prelim ? '估計' : '級'}</small></div>
        <div class="eew-cd">
          <span class="k">${h.name}</span>
          <div class="eew-sec ${left <= 0 ? 'arrived' : ''}">${cdText}</div>
          <div class="eew-place">${advice}</div>
          ${hp.worst && hp.worst !== hp.n ? `<div class="eew-worst">最嚴重可能 <b style="background:${INTENSITY_COLORS[hp.worst]}">${shortInt(hp.worst)}</b> 級<small>（95% 信心${so.nPd >= 3 ? '' : '・規模仍在估算，範圍較寬'}）</small></div>` : ''}
          ${this.region ? `<div class="eew-zone ${this.homeInRegion ? 'in' : ''}">${this.homeInRegion ? '● 你在警示區域內' : '○ 你不在警示區域內'}</div>` : ''}
        </div>
      </div>
      <div class="eew-facts">
        <div><span class="k">規模</span><b>${prelim ? '估算中' : 'M ' + so.M.toFixed(1)}${!prelim && so.mPartial ? '<small> 估算中</small>' : ''}</b></div>
        <div><span class="k">深度</span><b>${so.n < 4 ? '待定' : so.depth.toFixed(0) + ' km'}</b></div>
        <div><span class="k">最大震度</span><b style="color:${INTENSITY_COLORS[ml.n]}">${ml.n} 級</b></div>
      </div>
      <div class="eew-epi">${prelim ? '初估震央' : '震央'}：${epi.where.replace('位於', '')}（${epi.text}）<br>最大震度地區：${ml.town.county}${ml.town.name}</div>
      <div class="eew-meta">
        ${this.firstNotice ? `發震後 ${((this.firstNotice - t0) / 1000).toFixed(1)} 秒範圍通知 · ` : ''}${this.firstIssued ? `${((this.firstIssued - t0) / 1000).toFixed(1)} 秒正式速報 · ` : ''}預警 ${lead > 0 ? lead.toFixed(1) + ' 秒' : '無'} ·
        ${this.region ? `警示區 ${this.region.blocks.length} 個方塊、約 ${Math.round(this.region.areaKm2 / 100) * 100} km²（≥${this.region.thr} 級，保守計入震央誤差 ±${this.region.u} km、規模 +${this.region.sigM}${this.region.sigModel ? `、模型誤差 ×${(10 ** this.region.sigModel).toFixed(1)}` : ''}）· ` : ''}<span class="q ${so.n < 4 ? '' : 'ok'}">${so.n} 站定位（海底 ${so.used.filter(p => p.type === 'obs').length}）</span>${so.nPd ? ` · 規模由 ${so.nPd} 站完整 Pd 計算` : ' · 規模估算中'}${so.rejected.length ? ` · 排除 ${so.rejected.length} 個誤觸發` : ''} · 本站${this.localPick ? '已偵測 P 波' : '未偵測'}
      </div>
      ${this.reveal ? this.truthHtml() : ''}`);
    this.renderBanner(kind, title, h, hp, left, sec);

    // 鄉鎮預估（第一報起即顯示所有 1 級以上鄉鎮）；表格每 0.5 秒更新一次即可
    if (now - (this.lastTable ?? 0) < 500 && this.lastTableReport === this.report) return;
    this.lastTable = now; this.lastTableReport = this.report;
    const rows = TOWNS.map((t, i) => ({ t, n: this.townInts[i], w: this.townWorst?.[i], s: (so.t0 + (hypo(t.c[0], t.c[1], so) / VS) * 1000 - now) / 1000 }))
      .filter(r => r.n !== '0' || r.t === this.homeTown)
      .sort((a, b) => intensityIndex(b.n) - intensityIndex(a.n) || a.s - b.s);
    $('twCount').textContent = `${rows.length} 個鄉鎮`;
    $('twTable').innerHTML = rows.map(r => `<div class="town ${r.t === this.homeTown ? 'me' : ''}">
      <span class="lv" style="background:${INTENSITY_COLORS[r.n]}">${shortInt(r.n)}</span>
      <span class="nm"><small>${r.t.county}</small>${r.t.name}${r.w && r.w !== r.n ? `<i class="wst" style="background:${INTENSITY_COLORS[r.w]}" title="最嚴重可能震度（95% 信心）">最嚴重 ${shortInt(r.w)}</i>` : ''}</span>
      <span class="tm ${r.s > 0 ? '' : 'done'}">${r.s > 0 ? Math.ceil(r.s) + ' 秒' : '已抵達'}</span></div>`).join('');
  }

  // 全站橫幅：任何頁面都顯示「通知類型｜我這裡幾級｜幾秒」，點一下回到速報頁
  renderBanner(kind, title, h, hp, left, sec) {
    const b = $('eewBanner');
    if (this.reveal || left < -20) { b.hidden = true; return; }
    b.hidden = false;
    b.className = 'eew-banner ' + kind;
    // 範圍通知階段（hp 為 null）：不顯示震度，只顯示是否在警示區
    const tag = hp ? `<span class="bn-int" style="background:${INTENSITY_COLORS[hp.n]}">${shortInt(hp.n)}</span>`
      : `<span class="bn-int" style="background:${this.homeInRegion ? '#facc15' : '#4b5563'}">${this.homeInRegion ? '區內' : '區外'}</span>`;
    const showSec = hp || this.homeInRegion;
    setHTML(b, `<span class="bn-type">${title}</span>${tag}
      <span class="bn-place">${h.name}</span>
      <span class="bn-sec">${showSec ? (left > 0 ? `${sec}<small>秒</small>` : '搖晃中') : ''}</span>`);
  }

  truthHtml() {
    const q = this.sc.q, so = this.sol;
    const err = distKm(q.lon, q.lat, so.lon, so.lat);
    let realHtml = '';
    if (this.real) {
      // 用最後一報的震源解（含 PLUM 無法事後重現，這裡只評震源模型），預估每個實測測站的震度並與當時實測比較
      this.realEval ??= (() => {
        let ex = 0, w1 = 0, under = 0;
        for (const st of this.real.stations) {
          const R = Math.hypot(distKm(st.lon, st.lat, so.lon, so.lat), so.depth);
          const d = intensityIndex(predictAt(so.M, R, st.site, so.depth).n) - intensityIndex(st.obs);
          if (d === 0) ex++; if (Math.abs(d) <= 1) w1++; if (d <= -2) under++;
        }
        const n = this.real.stations.length;
        const mx = this.real.stations.reduce((a, b) => (intensityIndex(b.obs) > intensityIndex(a.obs) ? b : a));
        return { n, ex: ex / n * 100, w1: w1 / n * 100, under: under / n * 100, mx };
      })();
      const e = this.realEval;
      realHtml = `<div>與 ${e.n} 個測站當時實測比較：完全命中 <b>${e.ex.toFixed(0)}%</b>、差 1 級內 <b>${e.w1.toFixed(0)}%</b>、低估 2 級以上 ${e.under.toFixed(0)}%</div>
        <div>當時實測最大 ${badge(e.mx.obs)}（PGA ${e.mx.pga.toFixed(0)} gal）· 地圖上的圓點為實測測站（顏色＝實測震度）</div>
        <div class="muted">註：預估式曾用此地震資料訓練，屬樣本內比較</div>`;
    }
    const ht = this.homeTruth;
    return `<div class="eew-truth"><b>${this.real ? `回放結束 · ${this.real.name}（${this.real.date}）` : '模擬結束 · 與真實震源比較'}</b>
      <div>震央誤差 ${err.toFixed(1)} km · 深度 ${so.depth.toFixed(0)}／${q.depth.toFixed(0)} km · 規模 M${so.M.toFixed(1)}／M${q.M.toFixed(1)}</div>
      ${realHtml}
      <div>${this.home.name} ${ht.real ? `實測（${ht.dist.toFixed(1)} km 內測站）` : '實際'}震度 ${badge(ht.n)}（PGA ${ht.pga.toFixed(0)} gal、PGV ${ht.pgv.toFixed(1)} cm/s）</div></div>`;
  }

  renderIdle() {
    $('twPicks').textContent = ''; $('twElapsed').textContent = ''; $('mapStatus').hidden = true;
    $('eewBanner').hidden = true;
    $('twTable').innerHTML = `<p class="hint">發生地震後顯示</p>`; $('twCount').textContent = '';
    $('secSetup').open = true; $('secTowns').open = false;
    $('eewCard').className = 'eew-card idle';
    setHTML($('eewCard'), `<div class="ttl">待命中</div>
      <p>偵測到 P 波就發布範圍通知；3 站確認後發布正式速報。規模 &gt; ${EMERGENCY_M} 且陸上測站實測 ≥ ${EMERGENCY_INT} 級時為強震即時訊息。</p>`);
  }

  onHover(p, e) {
    const tip = $('twTip');
    const t = p && townAt(p.lon, p.lat);
    this.hoverTown = t ? TOWNS.indexOf(t) : null;
    if (!t) { tip.hidden = true; this.hoverPos = null; return; }
    const wrap = $('twMap').parentElement.getBoundingClientRect();
    this.hoverPos = { x: Math.min(e.clientX - wrap.left + 14, wrap.width - 230), y: e.clientY - wrap.top + 14, lon: p.lon, lat: p.lat };
    this.lastTip = 0;
    this.updateTip(Date.now(), true);
  }

  // 資訊框：使用和地圖完全相同的數值（鄉鎮預估含 PLUM、P 波區塊的震度），並在滑鼠不動時也持續更新
  updateTip(now, force = false) {
    const tip = $('twTip');
    if (this.hoverTown == null || !this.hoverPos) return;
    if (!force && now - (this.lastTip ?? 0) < 300) return;
    this.lastTip = now;
    const i = this.hoverTown, t = TOWNS[i], sc = siteClass(t.vs30);
    let pred = '';
    if (this.sol && this.townInts && !this.sol.prelim) {
      const src = predictAt(this.sol.M, sourceDist(t.c[0], t.c[1], this.sol), t, this.sol.depth);
      const n = this.townInts[i];                                  // 地圖上顯示的同一個值
      const plumUp = intensityIndex(n) > intensityIndex(src.n);
      const s = (this.sol.t0 + (hypo(t.c[0], t.c[1], this.sol) / VS) * 1000 - now) / 1000;
      const w = this.townWorst?.[i];
      pred = `<div>預估震度 ${badge(n)}${plumUp ? '（附近測站實測上修）' : ''} · ${s > 0 ? `${Math.ceil(s)} 秒後抵達` : '已抵達'}</div>
        ${w && w !== n ? `<div>最嚴重可能 ${badge(w)}（95% 信心）</div>` : ''}
        <div>震源模型：PGA ${src.pga.toFixed(0)} gal · PGV ${src.pgv.toFixed(1)} cm/s</div>`;
    } else if (this.sol?.prelim) pred = '<div>範圍通知階段：震度待正式速報後公布</div>';
    // 滑鼠所在位置的 P 波區塊
    const blk = this.pRegion?.blocks.find(b => Math.abs(b.lon - this.hoverPos.lon) <= b.hx && Math.abs(b.lat - this.hoverPos.lat) <= b.hy);
    const blkHtml = blk ? `<div>P 波區塊：已偵測到 P 波${this.sol?.prelim ? '' : `，區塊內最大 ${badge(blk.n)}`}</div>` : '';
    tip.innerHTML = `<b>${t.county} ${t.name}</b>${pred}${blkHtml}<div class="muted">Vs30 ≈ ${t.vs30} m/s · ${sc.name} · 放大 ×${t.ampA.toFixed(2)}</div>`;
    tip.style.left = this.hoverPos.x + 'px';
    tip.style.top = this.hoverPos.y + 'px';
    tip.hidden = false;
  }
}
