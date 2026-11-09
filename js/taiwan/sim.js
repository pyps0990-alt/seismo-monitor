// 台灣地震速報模擬：自訂／預設地震 → 測站觸發 → 本機定位 → 發布速報（一般／緊急）→ 鄉鎮震度預測與倒數
import { COUNTIES, STATIONS, TOWNS, loadTowns, townAt, describeEpicenter, distKm } from './geo.js';
import { createScenario, locateRobust, triggerOf, predictAt, dominantFreq, randomQuake, PRESETS, VP, VS } from './eew.js';
import { siteOf, siteClass } from './site.js';
import { INTENSITY_COLORS, intensity, intensityIndex } from '../detector.js';
import { TaiwanMap } from './map.js';

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
    $('zReset').onclick = () => this.map.reset();
    this.ready = this.init();
  }

  async init() {
    await loadTowns();
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
    $('twHomeSite').textContent = `Vs30 ≈ ${t.vs30} m/s · ${sc.name} · 放大 ×${t.ampA.toFixed(2)}`;
  }
  get home() { const t = this.homeTown; return t && { name: `${t.county}${t.name}`, short: t.name, lon: t.c[0], lat: t.c[1], site: t }; }

  start() {
    if (!this.homeTown) return;
    const q = this.readQuake();
    const t0 = Date.now() + 1500;
    this.sc = createScenario(q, t0);
    Object.assign(this, { sol: null, report: 0, lastN: 0, lastUsed: 0, lastReportN: 0, rejected: null, lastSpeech: 0, lastCalc: 0, firstIssued: null, localPick: null, reveal: false,
      townInts: null, lastTick: null, arrived: false, level: null });

    // 本站（我的位置）收到的地震波 → 送進模擬器
    const h = this.home;
    const R = Math.hypot(distKm(h.lon, h.lat, q.lon, q.lat), q.depth);
    const tp = t0 + (R / VP) * 1000, ts = t0 + (R / VS) * 1000;
    this.homeTruth = predictAt(q.M, R, h.site);
    this.onQuake({ t0: tp, sp: ts - tp, peak: this.homeTruth.pga / 100 / 1.15, freq: dominantFreq(q.M), dur: 6000 + (q.M - 4) * 5000 });

    $('twStart').disabled = true;
    document.body.classList.add('quake-on');
    $('eewCard').className = 'eew-card waiting';
    $('eewCard').innerHTML = `<div class="eew-kicker">監測中</div><div class="eew-title">等待測站偵測 P 波…</div>`;
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
    for (const s of sc.stations) { const n = this.stationInt(s, now); if (n) { stationInts.set(s.name, n); if (intensityIndex(n) > intensityIndex(maxObs)) maxObs = n; } }
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
        const prev = this.sol ? this.homePred(this.sol).n : null;
        this.sol = sol;
        this.sol.calcMs = performance.now() - t;
        this.sol.issued = now;
        this.lastUsed = sol.n; this.lastReportN = n; this.report++;
        this.rejected = new Set(sol.rejected.map(p => p.name));
        this.townInts = TOWNS.map(tw => predictAt(this.sol.M, hypo(tw.c[0], tw.c[1], this.sol), tw).n);
        this.announce(now, prev);
      }
    }
    // 速報等級也可能在兩報之間因測站實測震度升級
    if (this.sol && !this.reveal && this.level === 'normal' && this.isEmergency()) this.announce(now, null, true);

    if (!this.reveal && now - sc.q.t0 > END_MS) { this.reveal = true; $('twStart').disabled = false; document.body.classList.remove('quake-on'); }
    this.map.draw({ mode: this.mode, scenario: sc, now, solution: this.sol, townInts: this.townInts, picked, stationInts, rejected: this.rejected,
      home: this.home, homeTown: this.homeIdx, hoverTown: this.hoverTown, reveal: this.reveal, pickPoint: this.reveal ? this.readQuake() : null });
    this.render(now, n);
    if (this.reveal && now - sc.q.t0 > END_MS + 60000) { this.sc = null; this.renderIdle(); }
  }

  isEmergency() { return this.sol.M > EMERGENCY_M && intensityIndex(this.maxObs) >= intensityIndex(EMERGENCY_INT); }

  homePred(so) {
    const h = this.home, R = hypo(h.lon, h.lat, so);
    return { ...predictAt(so.M, R, h.site), ts: so.t0 + (R / VS) * 1000 };
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
    const lead = (hp.ts - this.firstIssued) / 1000;

    if (!this.reveal && sec !== this.lastTick) {
      this.lastTick = sec;
      // 整十秒播報剩餘秒數（避開剛播完速報的 3 秒內）
      if (sec > 0 && sec % 10 === 0 && Date.now() - (this.lastSpeech ?? 0) > 3000) this.say(`${sec}秒`);
      else if (sec > 0 && sec <= 5) this.sound.tick(sec);
      if (sec <= 0 && !this.arrived) { this.arrived = true; this.sound.arrive(); }
    }

    const emergency = this.level === 'emergency';
    const epi = describeEpicenter(so.lon, so.lat);
    const quality = so.n < 4 ? `<span class="eew-q">${so.n} 站速估</span>` : `<span class="eew-q ok">${so.n} 站定位</span>`;
    $('eewCard').className = 'eew-card ' + (emergency ? 'emergency' : 'normal');
    $('eewCard').innerHTML = `
      <div class="eew-head">
        <div><div class="eew-kicker">${emergency ? 'EMERGENCY · 強震即時警報' : 'EARTHQUAKE EARLY WARNING'}</div>
        <div class="eew-title">${emergency ? '緊急地震速報' : '地震速報'}</div></div>
        <span class="eew-no">第 ${this.report} 報</span>
      </div>
      <div class="eew-sub">${hhmmss(so.issued)} 發布 · 發震後 ${((this.firstIssued - this.sc.q.t0) / 1000).toFixed(1)} 秒第一報 · ${quality} · 運算 ${so.calcMs.toFixed(0)} ms<br>
        測站最大實測 ${badge(this.maxObs)}${so.rejected.length ? ` · 已排除 ${so.rejected.length} 個誤觸發／無關觸發` : ''}</div>
      <div class="eew-grid">
        <div><div class="k">預估規模</div><div class="v">M ${so.M.toFixed(1)}</div></div>
        <div><div class="k">深度</div><div class="v">${so.n < 4 ? '—' : so.depth.toFixed(0)}<small>${so.n < 4 ? '待定' : 'km'}</small></div></div>
      </div>
      <div class="eew-epi"><span class="k">震央</span>${epi.text}<br><span class="muted">（${epi.where}）</span></div>
      <div class="eew-home">
        <div>
          <div class="k">${h.name}</div>
          <div class="eew-int" style="color:${INTENSITY_COLORS[hp.n]}">${hp.n}<small>級</small></div>
          <div class="muted">PGA ${hp.pga.toFixed(0)} gal · PGV ${hp.pgv.toFixed(1)} cm/s</div>
        </div>
        <div class="eew-count ${left <= 0 ? 'arrived' : ''}">
          <div class="k">${left > 0 ? '主震波抵達倒數' : '主震波已抵達'}</div>
          <div class="eew-sec">${left > 0 ? sec : (lead <= 0 ? '盲區' : '—')}<small>${left > 0 ? '秒' : ''}</small></div>
          <div class="muted">預警時間 ${lead > 0 ? lead.toFixed(1) + ' 秒' : '無'}</div>
        </div>
      </div>
      <div class="eew-local">${this.localPick ? `● 本站地震儀 ${hhmmss(this.localPick)} 偵測到 P 波` : '○ 本站地震儀尚未偵測到震動'}</div>
      ${this.reveal ? this.truthHtml() : ''}`;

    // 鄉鎮預估（第一報起即顯示所有 1 級以上鄉鎮）；表格每 0.5 秒更新一次即可
    if (now - (this.lastTable ?? 0) < 500 && this.lastTableReport === this.report) return;
    this.lastTable = now; this.lastTableReport = this.report;
    const rows = TOWNS.map((t, i) => ({ t, n: this.townInts[i], s: (so.t0 + (hypo(t.c[0], t.c[1], so) / VS) * 1000 - now) / 1000 }))
      .filter(r => r.n !== '0' || r.t === this.homeTown)
      .sort((a, b) => intensityIndex(b.n) - intensityIndex(a.n) || a.s - b.s);
    $('twCount').textContent = `${rows.length} 個鄉鎮`;
    $('twTable').innerHTML = rows.map(r => `<tr class="${r.t === this.homeTown ? 'me' : ''}"><td>${r.t.county}<b>${r.t.name}</b></td><td>${badge(r.n)}</td>
      <td class="num">${r.s > 0 ? Math.ceil(r.s) + ' 秒' : '<span class="muted">抵達</span>'}</td></tr>`).join('');
  }

  truthHtml() {
    const q = this.sc.q, so = this.sol;
    const err = distKm(q.lon, q.lat, so.lon, so.lat);
    return `<div class="eew-truth"><b>模擬結束 · 與真實震源比較</b>
      <div>震央誤差 ${err.toFixed(1)} km · 深度 ${so.depth.toFixed(0)}／${q.depth.toFixed(0)} km · 規模 M${so.M.toFixed(1)}／M${q.M.toFixed(1)}</div>
      <div>${this.home.name} 實際震度 ${badge(this.homeTruth.n)}（PGA ${this.homeTruth.pga.toFixed(0)} gal、PGV ${this.homeTruth.pgv.toFixed(1)} cm/s）</div></div>`;
  }

  renderIdle() {
    $('twPicks').textContent = ''; $('twElapsed').textContent = '';
    $('twTable').innerHTML = `<tr><td colspan="3" class="muted">尚無速報</td></tr>`;
    $('eewCard').className = 'eew-card';
    $('eewCard').innerHTML = `<div class="eew-kicker">待命</div><div class="eew-title">尚無地震</div>
      <div class="muted">設定震央、深度、規模（可直接點地圖選震央），按「發生地震」。第 1 個測站偵測到 P 波就會開始估算。<br>
      預估規模 &gt; ${EMERGENCY_M} 且有測站實測震度 ≥ ${EMERGENCY_INT} 級時，發布「緊急地震速報」。</div>`;
  }

  onHover(p, e) {
    const tip = $('twTip');
    const t = p && townAt(p.lon, p.lat);
    this.hoverTown = t ? TOWNS.indexOf(t) : null;
    if (!t) { tip.hidden = true; return; }
    const sc = siteClass(t.vs30);
    let pred = '';
    if (this.sol && this.townInts) {
      const r = predictAt(this.sol.M, hypo(t.c[0], t.c[1], this.sol), t);
      pred = `<div>預估震度 ${badge(r.n)} PGA ${r.pga.toFixed(0)} gal · PGV ${r.pgv.toFixed(1)} cm/s</div>`;
    }
    tip.innerHTML = `<b>${t.county} ${t.name}</b><div>Vs30 ≈ ${t.vs30} m/s · ${sc.name}</div><div>地盤放大 PGA ×${t.ampA.toFixed(2)}、PGV ×${t.ampV.toFixed(2)}</div>${pred}`;
    const wrap = $('twMap').parentElement.getBoundingClientRect();
    tip.style.left = Math.min(e.clientX - wrap.left + 14, wrap.width - 230) + 'px';
    tip.style.top = (e.clientY - wrap.top + 14) + 'px';
    tip.hidden = false;
  }
}
