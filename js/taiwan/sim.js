// 台灣地震速報模擬：自訂／預設地震 → 測站觸發 → 本機定位 → 發布速報（一般／緊急）→ 鄉鎮震度預測與倒數
import { COUNTIES, STATIONS, TOWNS, loadTowns, townAt, describeEpicenter, distKm } from './geo.js';
import { createScenario, locate, locateRobust, associate, triggerOf, predictAt, loadModel, dominantFreq, randomQuake, PRESETS, VP, VS } from './eew.js';
import { siteOf, siteClass } from './site.js';
import { INTENSITY_COLORS, intensity, intensityIndex } from '../detector.js';
import { TaiwanMap, shortInt } from './map.js';

const $ = id => document.getElementById(id);
const PROCESS_MS = 300;
const MAX_REPORTS = 10;
const END_MS = 75000;
const EMERGENCY_M = 5.5;          // 預估規模 > 5.5
const EMERGENCY_INT = '4';        // 且任一測站實測震度 ≥ 4 級 → 緊急地震速報

const badge = n => `<span class="badge" style="background:${INTENSITY_COLORS[n]}">${n}</span>`;
const hhmmss = t => new Date(t).toLocaleTimeString('zh-TW', { hour12: false });
const hypo = (lon, lat, so) => Math.hypot(distKm(lon, lat, so.lon, so.lat), so.depth);

export class TaiwanEEW {
  constructor({ onQuake, sound }) {
    this.onQuake = onQuake; this.sound = sound;
    this.sc = null; this.mode = 'intensity'; this.hoverTown = null;
    this.map = new TaiwanMap($('twMap'), {
      onClick: p => { if (!this.sc || this.reveal) this.setEpicenter(p); },
      onHover: (p, e) => this.onHover(p, e),
    });
    $('zIn').onclick = () => this.map.zoomBy(1.5);
    $('zOut').onclick = () => this.map.zoomBy(1 / 1.5);
    $('zReset').onclick = () => { this.map.reset(); this.follow(); };
    $('twFollow').onchange = () => { if ($('twFollow').checked) { this.map.userMoved = false; this.follow(); } };
    this.ready = this.init();
  }

  async init() {
    const [, model] = await Promise.all([loadTowns(), loadModel()]);
    $('twModel').textContent = model
      ? `預估式：USGS 實測訓練（${model.data.events} 個地震、${model.data.records} 筆紀錄）`
      : '預估式：手設教學模型';
    for (const t of TOWNS) Object.assign(t, siteOf(t.c[0], t.c[1]));
    $('twN').textContent = STATIONS.length;
    $('twPreset').innerHTML = '<option value="">— 預設情境 —</option>' + PRESETS.map((p, i) => `<option value="${i}">${p.name}（M${p.M}）</option>`).join('');
    $('twPreset').onchange = () => { const p = PRESETS[$('twPreset').value]; if (p) this.fill(p); };
    $('twRandom').onclick = () => this.fill(randomQuake());
    ['twLon', 'twLat', 'twDepth', 'twM'].forEach(id => $(id).oninput = () => { $('twPreset').value = ''; this.syncLabels(); });
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
  setEpicenter(p) { $('twPreset').value = ''; $('twLon').value = p.lon.toFixed(2); $('twLat').value = p.lat.toFixed(2); this.syncLabels(); }
  syncLabels() {
    $('twDepthV').textContent = `${$('twDepth').value} km`;
    $('twMV').textContent = `M ${(+$('twM').value).toFixed(1)}`;
    const d = describeEpicenter(+$('twLon').value, +$('twLat').value);
    $('twWhere').textContent = d.where.replace('位於', '');
  }
  readQuake() {
    const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
    return { lon: clamp(+$('twLon').value, 119, 123), lat: clamp(+$('twLat').value, 21, 26.5), depth: clamp(+$('twDepth').value, 1, 300), M: clamp(+$('twM').value, 3, 8.5) };
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
    const q = this.readQuake();
    const t0 = Date.now() + 1500;
    this.sc = createScenario(q, t0);
    Object.assign(this, { sol: null, report: 0, lastN: 0, lastUsed: 0, lastReportN: 0, rejected: null, lastSpeech: 0, lastCalc: 0, firstIssued: null, firstNotice: null, prelim: null, cancelled: 0, maxLand: null, localPick: null, reveal: false,
      townInts: null, lastTick: null, arrived: false, level: null });

    // 本站（我的位置）收到的地震波 → 送進模擬器
    const h = this.home;
    const R = Math.hypot(distKm(h.lon, h.lat, q.lon, q.lat), q.depth);
    const tp = t0 + (R / VP) * 1000, ts = t0 + (R / VS) * 1000;
    this.homeTruth = predictAt(q.M, R, h.site, q.depth);
    this.onQuake({ t0: tp, sp: ts - tp, peak: this.homeTruth.pga / 100 / 1.15, freq: dominantFreq(q.M), dur: 6000 + (q.M - 4) * 5000 });

    $('twStart').disabled = true;
    document.body.classList.add('quake-on');
    this.map.userMoved = false; // 新地震重新開始自動追蹤
    $('eewCard').className = 'eew-card idle waiting';
    $('eewCard').innerHTML = `<div class="ttl">監測中…</div><p>等待測站偵測 P 波</p>`;
    // 地震開始：收起設定、展開各地預估；手機上捲回地圖
    $('secSetup').open = false; $('secHome').open = false; $('secTowns').open = true;
    $('mapStatus').hidden = false;
    if (matchMedia('(max-width: 760px)').matches) window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  onLocalTrigger(t) { if (!this.sc || this.localPick || this.reveal) return false; this.localPick = t; return true; }

  // 目前所有觸發（含誤觸發）；本站地震儀偵測到 P 波也算一站
  currentPicks(now) {
    const out = [];
    for (const s of this.sc.stations) { const tr = triggerOf(s); if (tr.tp <= now) out.push({ ...s, ...tr }); }
    if (this.localPick) out.push({ name: '本站', lon: this.home.lon, lat: this.home.lat, tp: this.localPick, pAmp: this.homeTruth.pga * 0.3, site: this.home.site, local: true });
    return out.sort((a, b) => a.tp - b.tp);
  }

  // 測站目前實測震度：S 波到達前只有 P 波（振幅小），之後為完整地動
  stationInt(s, now) {
    if (s.local || now < s.tp) return null;
    return now >= s.ts ? intensity(s.pga, s.pgv) : intensity(s.pAmp, s.pgv * 0.3);
  }

  tick(now) {
    if (!TOWNS.length) return;
    if (!this.sc) { this.map.draw({ mode: this.mode, now, home: this.home, homeTown: this.homeIdx, hoverTown: this.hoverTown, pickPoint: this.readQuake() }); return; }
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

    // 每有新觸發就做「關聯＋定位」；至少 3 站互相確認才發布第一報，之後 8 站內每站更新、再來每 3 站更新
    const n = picks.length;
    const step = this.lastUsed < 8 ? 1 : 3;
    // 有新觸發時每 PROCESS_MS 計算一次（測站密集時觸發是連續進來的，不能等「安靜」才算）
    if (!this.reveal && n && n > this.lastN && now - (this.lastCalc ?? 0) >= PROCESS_MS && this.report < MAX_REPORTS
        && (this.report === 0 || n - this.lastReportN >= step)) {
      this.lastN = n; this.lastCalc = now;
      const idle = sc.stations.filter(s => !picked.has(s.name));
      const t = performance.now();
      const sol = locateRobust(picks, idle, now);
      if (sol && (this.report === 0 || sol.n - this.lastUsed >= step)) {
        // ---- 正式速報：≥3 站互相確認 ----
        const prev = this.sol ? this.homePred(this.sol).n : null;
        this.prelim = null;
        this.setForecast(sol, now, performance.now() - t);
        this.lastUsed = sol.n; this.lastReportN = n; this.report++;
        this.rejected = new Set(sol.rejected.map(p => p.name));
        this.announce(now, prev);
        this.follow();
      } else if (!sol && this.report === 0) {
        // ---- 範圍通知：一偵測到 P 波就用最近 5 秒內的觸發先估震央（尚未確認）----
        const window5 = picks.filter(p => now - p.tp < 5000);
        // 只用彼此吻合的觸發（有鄰站確認的群組）；還沒有群組時只用最早那一站（發出這次通知的站），
        // 避免後來遠處的單站雜訊把初估震央拉走
        const grp = associate(window5);
        const recent = grp.length >= 2 ? grp : window5.slice(0, 1);
        if (recent.length) {
          const near = idle.map(s => [distKm(s.lon, s.lat, recent[0].lon, recent[0].lat), s]).filter(([d]) => d < 150)
            .sort((a, b) => a[0] - b[0]).slice(0, 40).map(([, s]) => s);
          const pv = locate(recent.slice(0, 3), near, now);
          Object.assign(pv, { prelim: true, n: recent.length, used: recent, rejected: [] });
          const first = !this.prelim;
          if (first) this.prelim = { since: recent[0].tp };
          this.setForecast(pv, now, performance.now() - t);
          if (first) this.announcePrelim(now);
          this.follow();
        }
      }
    }
    // 範圍通知 5 秒內沒有其他測站確認 → 判定為雜訊，取消通知
    if (this.prelim && this.report === 0 && now - this.prelim.since > 5000) this.cancelPrelim(now);
    this.follow(now); // 每一幀更新追蹤目標（跟著 S 波擴散縮小）
    // 速報等級也可能在兩報之間因測站實測震度升級
    if (this.sol && !this.reveal && this.level === 'normal' && this.isEmergency()) this.announce(now, null, true);

    if (!this.reveal && now - sc.q.t0 > END_MS) { this.reveal = true; $('twStart').disabled = false; document.body.classList.remove('quake-on'); }
    this.map.draw({ mode: this.mode, scenario: sc, now, solution: this.sol, townInts: this.townInts, picked, stationInts, rejected: this.rejected,
      home: this.home, homeTown: this.homeIdx, hoverTown: this.hoverTown, reveal: this.reveal, pickPoint: this.reveal ? this.readQuake() : null });
    this.render(now, n);
    if (this.reveal && now - sc.q.t0 > END_MS + 60000) { this.sc = null; this.renderIdle(); }
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

  // 套用一個震源解：計算各鄉鎮預估震度與陸地最大震度
  setForecast(sol, now, calcMs) {
    this.sol = sol; sol.calcMs = calcMs; sol.issued = now;
    this.townInts = TOWNS.map(tw => predictAt(sol.M, hypo(tw.c[0], tw.c[1], sol), tw, sol.depth).n);
    let mi = 0; this.townInts.forEach((v, i) => { if (intensityIndex(v) > intensityIndex(this.townInts[mi])) mi = i; });
    this.maxLand = { n: this.townInts[mi], town: TOWNS[mi] };
  }

  announcePrelim(now) {
    this.firstNotice = now;
    this.sound.localP();
    const where = describeEpicenter(this.sol.lon, this.sol.lat).where.replace('位於', '');
    this.say(`偵測到P波，${where}附近，請注意搖晃`, 0.5);
  }

  cancelPrelim(now) {
    this.prelim = null; this.sol = null; this.townInts = null; this.maxLand = null; this.lastTick = null;
    this.cancelled = (this.cancelled || 0) + 1;
    $('eewBanner').hidden = true;
    $('eewCard').className = 'eew-card idle waiting';
    $('eewCard').innerHTML = `<div class="ttl">範圍通知已取消</div><p>5 秒內沒有其他測站確認，判定為單站雜訊（已取消 ${this.cancelled} 次）。持續監測中…</p>`;
    this.say('通知取消');
  }

  isEmergency() { return !this.sol.prelim && this.sol.M > EMERGENCY_M && intensityIndex(this.maxObs) >= intensityIndex(EMERGENCY_INT); }

  homePred(so) {
    const h = this.home, R = hypo(h.lon, h.lat, so);
    return { ...predictAt(so.M, R, h.site, so.depth), ts: so.t0 + (R / VS) * 1000 };
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
      this.say(this.phrase(hp.n, sec), d);
    } else {
      this.sound.update();
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
    const title = prelim ? 'P 波偵測・範圍通知' : emergency ? '緊急地震速報' : '地震速報';
    const sub = prelim ? `未確認 · ${so.n} 站` : `第 ${this.report} 報 · ${hhmmss(so.issued)}`;
    const epi = describeEpicenter(so.lon, so.lat);
    const ml = this.maxLand;
    const cdText = left > 0 ? `${sec}<small>秒後抵達</small>` : (lead <= 0 ? '盲區<small>無預警時間</small>' : '已抵達');
    const advice = left > 0 ? (intensityIndex(hp.n) >= 3 ? '請立即趴下、掩護、穩住' : '可能感到搖晃，請保持冷靜') : '注意安全，留意餘震';
    const t0 = this.sc.q.t0;
    $('eewCard').className = 'eew-card ' + kind;
    $('eewCard').innerHTML = `
      <div class="eew-type"><span>${title}</span><small>${sub}</small></div>
      <div class="eew-you">
        <div class="eew-lv" style="background:${INTENSITY_COLORS[hp.n]}"><b>${shortInt(hp.n)}</b><small>${prelim ? '估計' : '級'}</small></div>
        <div class="eew-cd">
          <span class="k">${h.name}</span>
          <div class="eew-sec ${left <= 0 ? 'arrived' : ''}">${cdText}</div>
          <div class="eew-place">${advice}</div>
        </div>
      </div>
      <div class="eew-facts">
        <div><span class="k">規模</span><b>${prelim ? '估算中' : 'M ' + so.M.toFixed(1)}</b></div>
        <div><span class="k">深度</span><b>${so.n < 4 ? '待定' : so.depth.toFixed(0) + ' km'}</b></div>
        <div><span class="k">最大震度</span><b style="color:${INTENSITY_COLORS[ml.n]}">${ml.n} 級</b></div>
      </div>
      <div class="eew-epi">${prelim ? '初估震央' : '震央'}：${epi.where.replace('位於', '')}（${epi.text}）<br>最大震度地區：${ml.town.county}${ml.town.name}</div>
      <div class="eew-meta">
        ${this.firstNotice ? `發震後 ${((this.firstNotice - t0) / 1000).toFixed(1)} 秒範圍通知 · ` : ''}${this.firstIssued ? `${((this.firstIssued - t0) / 1000).toFixed(1)} 秒正式速報 · ` : ''}預警 ${lead > 0 ? lead.toFixed(1) + ' 秒' : '無'} ·
        <span class="q ${so.n < 4 ? '' : 'ok'}">${so.n} 站</span>${so.rejected.length ? ` · 排除 ${so.rejected.length} 個誤觸發` : ''} · 本站${this.localPick ? '已偵測 P 波' : '未偵測'}
      </div>
      ${this.reveal ? this.truthHtml() : ''}`;
    this.renderBanner(kind, title, h, hp, left, sec);

    // 鄉鎮預估（第一報起即顯示所有 1 級以上鄉鎮）；表格每 0.5 秒更新一次即可
    if (now - (this.lastTable ?? 0) < 500 && this.lastTableReport === this.report) return;
    this.lastTable = now; this.lastTableReport = this.report;
    const rows = TOWNS.map((t, i) => ({ t, n: this.townInts[i], s: (so.t0 + (hypo(t.c[0], t.c[1], so) / VS) * 1000 - now) / 1000 }))
      .filter(r => r.n !== '0' || r.t === this.homeTown)
      .sort((a, b) => intensityIndex(b.n) - intensityIndex(a.n) || a.s - b.s);
    $('twCount').textContent = `${rows.length} 個鄉鎮`;
    $('twTable').innerHTML = rows.map(r => `<div class="town ${r.t === this.homeTown ? 'me' : ''}">
      <span class="lv" style="background:${INTENSITY_COLORS[r.n]}">${shortInt(r.n)}</span>
      <span class="nm"><small>${r.t.county}</small>${r.t.name}</span>
      <span class="tm ${r.s > 0 ? '' : 'done'}">${r.s > 0 ? Math.ceil(r.s) + ' 秒' : '已抵達'}</span></div>`).join('');
  }

  // 全站橫幅：任何頁面都顯示「通知類型｜我這裡幾級｜幾秒」，點一下回到速報頁
  renderBanner(kind, title, h, hp, left, sec) {
    const b = $('eewBanner');
    if (this.reveal || left < -20) { b.hidden = true; return; }
    b.hidden = false;
    b.className = 'eew-banner ' + kind;
    b.innerHTML = `<span class="bn-type">${title}</span>
      <span class="bn-int" style="background:${INTENSITY_COLORS[hp.n]}">${shortInt(hp.n)}</span>
      <span class="bn-place">${h.name}</span>
      <span class="bn-sec">${left > 0 ? `${sec}<small>秒</small>` : '已抵達'}</span>`;
  }

  truthHtml() {
    const q = this.sc.q, so = this.sol;
    const err = distKm(q.lon, q.lat, so.lon, so.lat);
    return `<div class="eew-truth"><b>模擬結束 · 與真實震源比較</b>
      <div>震央誤差 ${err.toFixed(1)} km · 深度 ${so.depth.toFixed(0)}／${q.depth.toFixed(0)} km · 規模 M${so.M.toFixed(1)}／M${q.M.toFixed(1)}</div>
      <div>${this.home.name} 實際震度 ${badge(this.homeTruth.n)}（PGA ${this.homeTruth.pga.toFixed(0)} gal、PGV ${this.homeTruth.pgv.toFixed(1)} cm/s）</div></div>`;
  }

  renderIdle() {
    $('twPicks').textContent = ''; $('twElapsed').textContent = ''; $('mapStatus').hidden = true;
    $('eewBanner').hidden = true;
    $('twTable').innerHTML = `<p class="hint">發生地震後顯示</p>`; $('twCount').textContent = '';
    $('secSetup').open = true; $('secTowns').open = false;
    $('eewCard').className = 'eew-card idle';
    $('eewCard').innerHTML = `<div class="ttl">待命中</div>
      <p>偵測到 P 波就發布範圍通知；3 站確認後發布正式速報。規模 &gt; ${EMERGENCY_M} 且陸上測站實測 ≥ ${EMERGENCY_INT} 級時為緊急地震速報。</p>`;
  }

  onHover(p, e) {
    const tip = $('twTip');
    const t = p && townAt(p.lon, p.lat);
    this.hoverTown = t ? TOWNS.indexOf(t) : null;
    if (!t) { tip.hidden = true; return; }
    const sc = siteClass(t.vs30);
    let pred = '';
    if (this.sol && this.townInts) {
      const r = predictAt(this.sol.M, hypo(t.c[0], t.c[1], this.sol), t, this.sol.depth);
      pred = `<div>預估震度 ${badge(r.n)} PGA ${r.pga.toFixed(0)} gal · PGV ${r.pgv.toFixed(1)} cm/s</div>`;
    }
    tip.innerHTML = `<b>${t.county} ${t.name}</b><div>Vs30 ≈ ${t.vs30} m/s · ${sc.name}</div><div>地盤放大 PGA ×${t.ampA.toFixed(2)}、PGV ×${t.ampV.toFixed(2)}</div>${pred}`;
    const wrap = $('twMap').parentElement.getBoundingClientRect();
    tip.style.left = Math.min(e.clientX - wrap.left + 14, wrap.width - 230) + 'px';
    tip.style.top = (e.clientY - wrap.top + 14) + 'px';
    tip.hidden = false;
  }
}
