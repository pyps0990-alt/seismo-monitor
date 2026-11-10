// 地震速報（EEW）計算核心：全部在本機執行
// 1. 地震情境：產生震源、各測站 P/S 波到時與觀測振幅（含隨機誤差）
// 2. 定位：用 ≥4 站 P 波到時做網格搜尋，找走時殘差最小的震源（經度、緯度、深度、發震時間）
// 3. 規模：用各站 P 波初期振幅與定位得到的距離反推
// 4. 預測：以衰減式推算各區塊 PGA / PGV → 震度
import { STATIONS, distKm } from './geo.js';
import { intensity } from '../detector.js';
import { siteOf } from './site.js';

export const VP = 6.0;  // P 波速度 km/s（地殼平均，簡化）
export const VS = 3.5;  // S 波速度 km/s

// ---- 地震動預估式 ----
// 優先使用以 USGS 實測資料訓練的模型（data/model.json，由 tools/train-gmpe.mjs 產生）：
//   log10(Y) = c0 + c1·M + c2·log10(R + h) + c3·R + c4·深度   （R 為震源距離 km）
// 載入失敗時退回原本的手設教學模型。
export let MODEL = null;
export async function loadModel(url = 'data/model.json') {
  try { MODEL = await (await fetch(url)).json(); } catch { MODEL = null; }
  return MODEL;
}
// c[5]（選用）：規模×距離交互項 (M−6)·log10(R+h)，讓大地震在遠處衰減較慢
const evalModel = (m, M, R, depth) => { const L = Math.log10(R + m.h); return 10 ** (m.c[0] + m.c[1] * M + m.c[2] * L + m.c[3] * R + m.c[4] * depth + (m.c[5] ?? 0) * (M - 6) * L); };
export function predictPGA(M, R, depth = 10) {
  if (MODEL) return evalModel(MODEL.pga, M, R, depth);
  return 10 ** (1.39 + 0.5 * M - 1.5 * Math.log10(R + 10) - 0.002 * R);
}
export function predictPGV(M, R, depth = 10) {
  if (MODEL) return evalModel(MODEL.pgv, M, R, depth);
  return predictPGA(M, R) * 10 ** (0.2 * M - 2.1);
}
// log10(PGA) 對規模的斜率（反推規模用）；有交互項時斜率隨距離改變
const magSlope = R => (MODEL ? MODEL.pga.c[1] + (MODEL.pga.c[5] ?? 0) * Math.log10(R + MODEL.pga.h) : 0.5);
// 對應的 S 波主頻（給模擬器產生波形用）：PGV = PGA / (2πf)，以 30 km 處估算
export function dominantFreq(M) { return predictPGA(M, 30) / (2 * Math.PI * predictPGV(M, 30)); }
export const predictIntensity = (M, R, depth) => intensity(predictPGA(M, R, depth), predictPGV(M, R, depth));
// 加入場址效應：地形推估放大（ampA/ampV）＋ 訓練得到的鄉鎮修正（site.id 為鄉鎮代碼）
export function predictAt(M, R, site, depth = 10) {
  const d = (site.id && MODEL?.siteDelta?.[site.id]) || { a: 0, v: 0 };
  const pga = predictPGA(M, R, depth) * site.ampA * 10 ** d.a;
  const pgv = predictPGV(M, R, depth) * site.ampV * 10 ** d.v;
  return { pga, pgv, n: intensity(pga, pgv) };
}

const P_RATIO = 0.3; // P 波初期振幅約為 S 波 PGA 的比例（簡化）
const gauss = () => { let u = 0; for (let i = 0; i < 6; i++) u += Math.random(); return (u - 3) / Math.SQRT1_2 / 1.73; };

export function hypoDist(lon, lat, q) { return Math.hypot(distKm(lon, lat, q.lon, q.lat), q.depth); }

// 預設情境（參考台灣常見震源區）
export const PRESETS = [
  { name: '花蓮外海', lon: 121.75, lat: 23.85, depth: 15, M: 6.6 },
  { name: '宜蘭外海（深）', lon: 122.0, lat: 24.6, depth: 70, M: 6.0 },
  { name: '嘉義大埔', lon: 120.58, lat: 23.25, depth: 10, M: 5.8 },
  { name: '臺東池上', lon: 121.22, lat: 23.1, depth: 8, M: 6.8 },
  { name: '南投集集', lon: 120.82, lat: 23.85, depth: 8, M: 7.3 },
  { name: '屏東外海', lon: 120.55, lat: 21.9, depth: 25, M: 6.2 },
];

export function randomQuake() {
  const p = PRESETS[Math.floor(Math.random() * PRESETS.length)];
  return {
    lon: p.lon + (Math.random() - 0.5) * 0.6,
    lat: p.lat + (Math.random() - 0.5) * 0.6,
    depth: Math.max(5, p.depth + (Math.random() - 0.5) * 20),
    M: Math.round((4.8 + Math.random() * 2.4) * 10) / 10,
  };
}

// 建立情境：q = {lon, lat, depth, M}，t0 = 發震時間（ms）
export function createScenario(q, t0) {
  const stations = STATIONS.map(s => {
    const R = hypoDist(s.lon, s.lat, q);
    const site = siteOf(s.lon, s.lat);                            // 地形場址效應
    const scatter = 10 ** (0.12 * gauss());                       // 其餘隨機變異
    const pga = predictPGA(q.M, R, q.depth) * site.ampA * scatter;
    return {
      ...s, R, site,
      tp: t0 + (R / VP) * 1000 + gauss() * 60,                    // P 波到時 + 挑波誤差 ±60 ms
      ts: t0 + (R / VS) * 1000,
      pAmp: pga * P_RATIO * 10 ** (0.1 * gauss()),                // 觀測到的 P 波初期振幅
      pga, pgv: predictPGV(q.M, R, q.depth) * site.ampV * scatter,
    };
  });
  // 誤觸發：隨機 2～4 個測站在地震前後被雜訊（車輛、施工、儀器故障）觸發
  // 振幅：85% 為一般雜訊 0.3～3 gal，15% 為儀器突波 3～20 gal（較難分辨）
  const falseAmp = () => (Math.random() < 0.85 ? 0.3 + Math.random() * 2.7 : 3 + Math.random() * 17);
  const nFalse = 2 + Math.floor(Math.random() * 3);
  for (let k = 0; k < nFalse; k++) {
    const s = stations[Math.floor(Math.random() * stations.length)];
    const tf = t0 - 6000 + Math.random() * 20000;
    if (tf < s.tp - 1500) { s.falseTp = tf; s.falseAmp = falseAmp(); }
  }
  // 20% 機率：相鄰兩站幾乎同時被同一個雜訊源觸發（例如大型車輛經過），最難排除的情況
  if (Math.random() < 0.2) {
    const a = stations[Math.floor(Math.random() * stations.length)];
    const b = stations.filter(s => s !== a && distKm(s.lon, s.lat, a.lon, a.lat) < 15).sort(() => Math.random() - 0.5)[0];
    const tf = t0 - 6000 + Math.random() * 20000;
    if (b && tf < a.tp - 1500 && tf < b.tp - 1500) { a.falseTp = tf; a.falseAmp = falseAmp(); b.falseTp = tf + 300 + Math.random() * 500; b.falseAmp = falseAmp() * 0.6; }
  }
  return { q: { ...q, t0 }, stations };
}

// 測站觸發時間：真的 P 波，或更早的誤觸發
export function triggerOf(s) {
  if (s.falseTp != null && s.falseTp < s.tp) return { tp: s.falseTp, pAmp: s.falseAmp, isFalse: true };
  return { tp: s.tp, pAmp: s.pAmp, isFalse: false };
}

// ---- 關聯（防誤報）----
// 1. 鄰站確認：一個觸發必須在 30 km 內有另一站，且到時差 ≤ 兩站距離 ÷ P 波速度 + 0.5 秒，才算「可信」。
//    真的地震波一定會傳到附近測站；單站雜訊不會。測站越密，確認越快。
// 2. 波前是連續擴散的：從一個可信觸發出發，只吸收「距離群組內某站 60 km 內、且與群組每站到時相容」的觸發，
//    逐步擴張。遠方的雜訊即使時間上說得通，也不會被併入。取最大的群組。
const compatible = (a, b, slack) => Math.abs(a.tp - b.tp) <= (distKm(a.lon, a.lat, b.lon, b.lat) / VP) * 1000 + slack;
export const MIN_ISSUE = 3; // 至少 3 站互相確認才發布（防誤報）
export function associate(picks, { radius = 30, slack = 200, grow = 60 } = {}) {
  const confirmed = picks.filter(p => picks.some(q => q !== p && distKm(p.lon, p.lat, q.lon, q.lat) <= radius && compatible(p, q, slack)));
  if (confirmed.length < 2) return [];
  let best = [];
  for (const seed of confirmed) {
    const group = [seed];
    let added = true;
    while (added) {
      added = false;
      for (const p of confirmed) {
        if (group.includes(p)) continue;
        if (group.some(q => distKm(p.lon, p.lat, q.lon, q.lat) <= grow) && group.every(q => compatible(p, q, 500))) { group.push(p); added = true; }
      }
    }
    if (group.length > best.length || (group.length === best.length && Math.max(...group.map(p => p.tp)) > Math.max(...best.map(p => p.tp)))) best = group;
  }
  return best.sort((a, b) => a.tp - b.tp);
}

// ---- 定位：網格搜尋（粗 → 細）----
// 代價 = 已觸發測站的走時殘差 RMS
//      + 「尚未觸發」約束：若某格點預測某站 P 波早該到了、但該站還沒觸發，就加罰
//      + 少站時（< 3 站）加一點「靠近第一站」的先驗，讓單站也能給出最合理的位置
// 這樣第 1 個測站偵測到 P 波就能開始估算，之後每多一站，可能的範圍就縮小。
function searchGrid(picks, idle, now, lonR, latR, step, depths) {
  let best = null;
  const n = picks.length, first = picks[0];
  for (let lon = lonR[0]; lon <= lonR[1]; lon += step) {
    for (let lat = latR[0]; lat <= latR[1]; lat += step) {
      for (const depth of depths) {
        // 穩健估計：發震時間取「到時 − 走時」的中位數、殘差取絕對值平均（L1）
        // → 少數誤觸發不會把整個解拉偏（平方誤差會被離群值主導）
        const d0 = new Array(n);
        for (let i = 0; i < n; i++) d0[i] = picks[i].tp - (Math.hypot(distKm(lon, lat, picks[i].lon, picks[i].lat), depth) / VP) * 1000;
        const sorted = n > 2 ? [...d0].sort((a, b) => a - b) : d0;
        const t0 = n > 2 ? (n % 2 ? sorted[n >> 1] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2) : (d0[0] + (d0[1] ?? d0[0])) / 2;
        let sa = 0; for (let i = 0; i < n; i++) sa += Math.abs(d0[i] - t0);
        let cost = sa / n;
        for (const s of idle) {
          const late = now - (t0 + (Math.hypot(distKm(lon, lat, s.lon, s.lat), depth) / VP) * 1000);
          if (late > 0) cost += late;
        }
        if (n < 3) cost += 2 * distKm(lon, lat, first.lon, first.lat);
        if (!best || cost < best.cost) best = { lon, lat, depth, t0, cost };
      }
    }
  }
  return best;
}

// ---- 範圍通知（P 波階段）的發送標準 ----
// 單一測站觸發很容易是雜訊（車輛、施工、儀器故障），所以必須符合下列其一才發送：
//   A. 雙站確認：30 km 內至少 2 站在合理時間差內觸發（associate 群組 ≥ 2），且群組最大 P 波振幅 ≥ 0.8 gal
//   B. 單站強震：單站 P 波振幅 ≥ 8 gal（一般雜訊到不了這麼大，代表附近正在發生較大地震）
// 另外初估規模 < 4.0 不發送（小地震不需要警示）。
export const NOTICE = { GROUP_ANY: 3, PAIR_AMP: 3, SINGLE_AMP: Infinity, MIN_M: 4.0, WINDOW_MS: 5000 };
export function noticeCandidates(picks, now, cfg = NOTICE) {
  const win = picks.filter(p => now - p.tp < cfg.WINDOW_MS && !p.local);
  if (!win.length) return null;
  const grp = associate(win);
  const maxAmp = grp.length ? Math.max(...grp.map(p => p.pAmp)) : 0;
  if (grp.length >= cfg.GROUP_ANY) return { picks: grp, rule: `${grp.length} 站確認` };
  if (grp.length >= 2 && maxAmp >= cfg.PAIR_AMP) return { picks: grp, rule: '雙站＋強振幅' };
  const big = win.filter(p => p.pAmp >= cfg.SINGLE_AMP).sort((a, b) => b.pAmp - a.pAmp);
  if (big.length) return { picks: [big[0]], rule: '單站強震' };
  return null;
}

// 穩健定位：關聯 → 定位 → 剔除殘差 > 1 秒的觸發 → 再定位
// 回傳 { ...解, used: 採用的觸發, rejected: 被排除的觸發 }
export function locateRobust(allPicks, idle, now) {
  let used = associate(allPicks);
  if (used.length < MIN_ISSUE) return null;
  let sol = locate(used.slice(0, 25), nearIdle(idle, used[0]), now);
  // 少站時逐一剔除檢驗：拿掉某個觸發後若明顯更一致（殘差＋「該到未到」懲罰下降一半以上），就視為誤觸發
  if (used.length <= 6 && sol.cost > 300) {
    for (let i = 0; i < used.length && used.length > MIN_ISSUE; i++) {
      const sub = used.filter((_, j) => j !== i);
      const s2 = locate(sub, nearIdle(idle.concat([used[i]]), sub[0]), now);
      if (s2.cost < sol.cost * 0.5 && sol.cost > 300) { used = sub; sol = s2; i = -1; }
    }
  }
  for (let iter = 0; iter < 5; iter++) { // 每次只剔除殘差最大、且 > 0.7 秒的那一個觸發，再重新定位
    const res = used.map(p => Math.abs(p.tp - sol.t0 - (Math.hypot(distKm(sol.lon, sol.lat, p.lon, p.lat), sol.depth) / VP) * 1000));
    let wi = 0; res.forEach((r, i) => { if (r > res[wi]) wi = i; });
    if (res[wi] <= 700 || used.length - 1 < MIN_ISSUE) break;
    used = used.filter((_, i) => i !== wi); sol = locate(used.slice(0, 25), nearIdle(idle, used[0]), now);
  }
  return { ...sol, n: used.length, used, rejected: allPicks.filter(p => !used.includes(p)) };
}
// 「尚未觸發」約束只考慮離第一站最近的 40 個未觸發測站（加快運算）
const nearIdle = (idle, first) => idle.map(s => [distKm(s.lon, s.lat, first.lon, first.lat), s])
  .filter(([d]) => d < 150).sort((a, b) => a[0] - b[0]).slice(0, 40).map(([, s]) => s);

// picks：已觸發測站（依到時排序）；idle：尚未觸發的測站；now：目前時間
export function locate(picks, idle = [], now = picks[picks.length - 1]?.tp) {
  if (!picks.length) return null;
  const many = picks.length >= 4;
  // 粗搜尋：0.1°；4 站以上才同時解深度，少站時固定 10 km
  const f = picks[0], box = 1.4; // 震央一定在第一站附近（P 波最先到），只搜尋 ±1.4°
  const coarse = searchGrid(picks, idle, now, [Math.max(118.5, f.lon - box), Math.min(123.5, f.lon + box)], [Math.max(20.5, f.lat - box), Math.min(26.5, f.lat + box)], 0.1, many ? [5, 10, 20, 30, 50, 75, 100] : picks.length === 3 ? [10, 30, 60] : [10]);
  // 細搜尋：在最佳點附近 0.01°
  const depths = []; if (picks.length === 3) { for (let d = Math.max(4, coarse.depth - 10); d <= coarse.depth + 10; d += 5) depths.push(d); } else if (many) { for (let d = Math.max(2, coarse.depth - 15); d <= coarse.depth + 15; d += 2) depths.push(d); } else depths.push(10);
  const fine = searchGrid(picks, idle, now, [coarse.lon - 0.12, coarse.lon + 0.12], [coarse.lat - 0.12, coarse.lat + 0.12], 0.01, depths);
  // 規模：每站由 P 波振幅反推（先扣掉該站的場址放大），取中位數以排除離群值
  const Ms = picks.map(p => {
    const R = Math.hypot(distKm(fine.lon, fine.lat, p.lon, p.lat), fine.depth);
    // 預估式對規模是線性的：log10(PGA) = log10(PGA@M=0) + 斜率·M → 反解 M
    return (Math.log10(p.pAmp / P_RATIO / (p.site?.ampA ?? 1)) - Math.log10(predictPGA(0, R, fine.depth))) / magSlope(R);
  }).sort((a, b) => a - b);
  const mid = Ms.length >> 1;
  const M = Ms.length % 2 ? Ms[mid] : (Ms[mid - 1] + Ms[mid]) / 2;
  return { ...fine, M: Math.round(M * 10) / 10, n: picks.length };
}
