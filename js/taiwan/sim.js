// 台灣地震速報模擬：情境時間軸 → 測站觸發 → 本機定位 → 發布速報 → 區塊震度與倒數
import { COUNTIES, BLOCKS, STATIONS, describeEpicenter, distKm } from './geo.js';
import { createScenario, locate, predictIntensity, predictPGA, predictPGV, dominantFreq, randomQuake, PRESETS, VS } from './eew.js';
import { INTENSITY_COLORS, intensity, intensityIndex } from '../detector.js';
import { TaiwanMap } from './map.js';

const $ = id => document.getElementById(id);
const MIN_STATIONS = 4;       // 定位所需最少測站數
const PROCESS_MS = 1500;      // 第 4 站觸發後的運算＋發布延遲
const END_MS = 75000;         // 情境總長

const badge = n => `<span class="badge" style="background:${INTENSITY_COLORS[n]}">${n}</span>`;

export class TaiwanEEW {
  constructor({ onQuake, sound }) {
    this.map = new TaiwanMap($('twMap'));
    this.onQuake = onQuake;   // (參數) => 把本站要收到的地震波送進模擬器
    this.sound = sound;
    this.sc = null; this.sol = null; this.report = 0;
    this.localPick = null;

    $('twN').textContent = STATIONS.length;
    $('twPreset').innerHTML = '<option value="rand">隨機情境</option>' + PRESETS.map((p, i) => `<option value="${i}">${p.name}（M${p.M}）</option>`).join('');
    $('twHome').innerHTML = COUNTIES.map(c => `<option${c.name === '臺北市' ? ' selected' : ''}>${c.name}</option>`).join('');
    $('twHome').onchange = () => { if (!this.sc) this.renderIdle(); };
    $('twStart').onclick = () => this.start();
    this.renderIdle();
  }

  get home() { return COUNTIES.find(c => c.name === $('twHome').value); }

  start() {
    const v = $('twPreset').value;
    const q = v === 'rand' ? randomQuake() : { ...PRESETS[+v] };
    const t0 = Date.now() + 1500;
    this.sc = createScenario(q, t0);
    this.sol = null; this.report = 0; this.lastN = 0; this.firstIssued = null; this.localPick = null; this.reveal = false; this.alarmed = false;
    this.blockInts = null;

    // 把「我的位置」收到的地震波送進本站模擬器（P、S 到時與振幅都依距離計算）
    const h = this.home;
    const R = Math.hypot(distKm(h.lon, h.lat, q.lon, q.lat), q.depth);
    const tp = t0 + (R / 6.0) * 1000, ts = t0 + (R / VS) * 1000;
    this.homeTruth = { pga: predictPGA(q.M, R), pgv: predictPGV(q.M, R), ts };
    this.onQuake({
      t0: tp, sp: ts - tp,
      peak: this.homeTruth.pga / 100 / 1.15,
      freq: dominantFreq(q.M),
      dur: 6000 + (q.M - 4) * 5000,
    });
    $('twStart').disabled = true;
    $('eewCard').className = 'eew-card waiting';
    $('eewCard').innerHTML = `<div class="eew-title">監測中…</div><div class="muted">地震已發生（模擬），等待測站偵測 P 波</div>`;
  }

  // 本站（你的地震儀）偵測到 P 波時由 main.js 呼叫
  onLocalTrigger(t) {
    if (!this.sc || this.localPick) return;
    this.localPick = t;
  }

  tick(now) {
    if (!this.sc) { this.map.draw({ now, home: this.home }); return; }
    const sc = this.sc;
    const picks = sc.stations.filter(s => s.tp <= now).sort((a, b) => a.tp - b.tp);
    const picked = new Set(picks.map(p => p.name));

    // 有新測站觸發，且已達定位門檻 → 重新定位並發布新一報（最多 6 報）
    if (picks.length >= MIN_STATIONS && now >= picks[MIN_STATIONS - 1].tp + PROCESS_MS
        && picks.length > this.lastN && this.report < 6 && (this.report === 0 || picks.length - this.lastN >= 3)) {
      const t = performance.now();
      this.sol = locate(picks);
      this.sol.calcMs = performance.now() - t;
      this.sol.issued = now;
      if (!this.firstIssued) this.firstIssued = now;
      this.lastN = picks.length;
      this.report++;
      this.blockInts = BLOCKS.map(b => predictIntensity(this.sol.M, Math.hypot(distKm(b.lon, b.lat, this.sol.lon, this.sol.lat), this.sol.depth)));
      if (!this.alarmed) { this.alarmed = true; this.alarm(); }
    }

    if (!this.reveal && now - sc.q.t0 > END_MS) { this.reveal = true; $('twStart').disabled = false; }
    this.map.draw({ scenario: sc, now, solution: this.sol, blockInts: this.blockInts, picked, home: this.home, reveal: this.reveal });
    this.render(now, picks.length);
    if (this.reveal && now - sc.q.t0 > END_MS + 60000) { this.sc = null; this.renderIdle(); }
  }

  render(now, nPicks) {
    $('twPicks').textContent = `${nPicks} / ${this.sc.stations.length} 站觸發`;
    $('twElapsed').textContent = `發震後 ${((now - this.sc.q.t0) / 1000).toFixed(1)} 秒`;
    const so = this.sol;
    if (!so) return;
    const h = this.home;
    const hR = Math.hypot(distKm(h.lon, h.lat, so.lon, so.lat), so.depth);
    const hInt = predictIntensity(so.M, hR);
    const hS = so.t0 + (hR / VS) * 1000;
    const left = (hS - now) / 1000;
    const lead = (hS - this.firstIssued) / 1000; // 預警時間：第一報發布到 S 波抵達
    const big = intensityIndex(hInt) >= intensityIndex('4');

    $('eewCard').className = 'eew-card ' + (big ? 'severe' : 'notice');
    $('eewCard').innerHTML = `
      <div class="eew-head"><span class="eew-title">地震速報</span><span class="eew-no">第 ${this.report} 報</span></div>
      <div class="eew-sub">${new Date(so.issued).toLocaleTimeString('zh-TW', { hour12: false })} 發布 · ${so.n} 站定位 · 本機運算 ${so.calcMs.toFixed(0)} ms</div>
      <div class="eew-grid">
        <div><div class="k">預估規模</div><div class="v">M ${so.M.toFixed(1)}</div></div>
        <div><div class="k">深度</div><div class="v">${so.depth.toFixed(0)} <small>km</small></div></div>
      </div>
      <div class="eew-epi">震央：${describeEpicenter(so.lon, so.lat)}</div>
      <div class="eew-home">
        <div>
          <div class="k">${h.name} 預估震度</div>
          <div class="eew-int" style="color:${INTENSITY_COLORS[hInt]}">${hInt}<small>級</small></div>
        </div>
        <div class="eew-count ${left <= 0 ? 'arrived' : ''}">
          <div class="k">${left > 0 ? '主震波（S 波）抵達倒數' : '主震波已抵達'}</div>
          <div class="eew-sec">${left > 0 ? Math.ceil(left) : (lead <= 0 ? '盲區' : '0')}<small>${left > 0 ? '秒' : ''}</small></div>
          <div class="muted">預警時間 ${lead > 0 ? lead.toFixed(1) + ' 秒' : '無（位於盲區）'}</div>
        </div>
      </div>
      <div class="eew-local">${this.localPick ? `✔ 本站地震儀於 ${new Date(this.localPick).toLocaleTimeString('zh-TW', { hour12: false })} 偵測到 P 波` : '本站地震儀尚未偵測到震動'}</div>
      ${this.reveal ? this.truthHtml() : ''}`;

    // 縣市預估表
    const rows = COUNTIES.map(c => {
      const R = Math.hypot(distKm(c.lon, c.lat, so.lon, so.lat), so.depth);
      return { c, n: predictIntensity(so.M, R), s: (so.t0 + (R / VS) * 1000 - now) / 1000 };
    }).sort((a, b) => intensityIndex(b.n) - intensityIndex(a.n) || a.s - b.s);
    $('twTable').innerHTML = rows.map(r => `<tr class="${r.c.name === h.name ? 'me' : ''}"><td>${r.c.name}</td><td>${badge(r.n)}</td>
      <td>${r.s > 0 ? Math.ceil(r.s) + ' 秒' : '<span class="muted">已抵達</span>'}</td></tr>`).join('');
  }

  truthHtml() {
    const q = this.sc.q, so = this.sol;
    const err = distKm(q.lon, q.lat, so.lon, so.lat);
    const trueInt = intensity(this.homeTruth.pga, this.homeTruth.pgv);
    return `<div class="eew-truth"><b>模擬結束 · 與真實震源比較</b>
      <div>震央誤差 ${err.toFixed(1)} km · 深度 ${so.depth.toFixed(0)} / 真實 ${q.depth.toFixed(0)} km · 規模 M${so.M.toFixed(1)} / 真實 M${q.M.toFixed(1)}</div>
      <div>${this.home.name} 真實震度 ${badge(trueInt)}（PGA ${this.homeTruth.pga.toFixed(1)} gal、PGV ${this.homeTruth.pgv.toFixed(1)} cm/s）</div></div>`;
  }

  renderIdle() {
    $('twPicks').textContent = ''; $('twElapsed').textContent = '';
    $('twTable').innerHTML = `<tr><td colspan="3" class="muted">尚無速報</td></tr>`;
    $('eewCard').className = 'eew-card';
    $('eewCard').innerHTML = `<div class="eew-title">待命中</div><div class="muted">選擇情境與你的位置，按「發生地震」開始模擬。<br>
      至少 ${MIN_STATIONS} 個測站偵測到 P 波後，本機會計算震央並發布速報。</div>`;
  }

  alarm() {
    if (!this.sound()) return;
    try {
      const ac = new AudioContext();
      for (let i = 0; i < 6; i++) {
        const o = ac.createOscillator(), g = ac.createGain(), t = ac.currentTime + i * 0.32;
        o.type = 'square'; o.frequency.value = i % 2 ? 660 : 990;
        o.connect(g); g.connect(ac.destination);
        g.gain.setValueAtTime(0.12, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
        o.start(t); o.stop(t + 0.3);
      }
    } catch { /* 尚未允許音效 */ }
  }
}
