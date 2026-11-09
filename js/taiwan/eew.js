// 地震速報（EEW）計算核心：全部在本機執行
// 1. 地震情境：產生震源、各測站 P/S 波到時與觀測振幅（含隨機誤差）
// 2. 定位：用 ≥4 站 P 波到時做網格搜尋，找走時殘差最小的震源（經度、緯度、深度、發震時間）
// 3. 規模：用各站 P 波初期振幅與定位得到的距離反推
// 4. 預測：以衰減式推算各區塊 PGA / PGV → 震度
import { STATIONS, distKm } from './geo.js';
import { intensity } from '../detector.js';

export const VP = 6.0;  // P 波速度 km/s（地殼平均，簡化）
export const VS = 3.5;  // S 波速度 km/s

// ---- 簡化衰減式（教學用，非中央氣象署正式模型）----
// log10(PGA[gal]) = 1.39 + 0.5·M − 1.5·log10(R + 10) − 0.002·R，R 為震源距離（km）
export function predictPGA(M, R) { return 10 ** (1.39 + 0.5 * M - 1.5 * Math.log10(R + 10) - 0.002 * R); }
// PGV ≈ PGA × 10^(0.2M − 2.1)：規模越大，主頻越低，同樣加速度下速度越大
export function predictPGV(M, R) { return predictPGA(M, R) * 10 ** (0.2 * M - 2.1); }
// 對應的 S 波主頻（給模擬器產生波形用）：PGV = PGA / (2πf)
export function dominantFreq(M) { return 1 / (2 * Math.PI * 10 ** (0.2 * M - 2.1)); }
export const predictIntensity = (M, R) => intensity(predictPGA(M, R), predictPGV(M, R));

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
    const site = 10 ** (0.12 * gauss());                          // 場址效應
    const pga = predictPGA(q.M, R) * site;
    return {
      ...s, R,
      tp: t0 + (R / VP) * 1000 + gauss() * 60,                    // P 波到時 + 挑波誤差 ±60 ms
      ts: t0 + (R / VS) * 1000,
      pAmp: pga * P_RATIO * 10 ** (0.1 * gauss()),                // 觀測到的 P 波初期振幅
      pga, pgv: predictPGV(q.M, R) * site,
    };
  });
  return { q: { ...q, t0 }, stations };
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
        const tt = picks.map(p => (Math.hypot(distKm(lon, lat, p.lon, p.lat), depth) / VP) * 1000);
        // 發震時間的最佳估計 = 平均（到時 − 走時）
        let t0 = 0; for (let i = 0; i < n; i++) t0 += picks[i].tp - tt[i]; t0 /= n;
        let ss = 0; for (let i = 0; i < n; i++) { const r = picks[i].tp - tt[i] - t0; ss += r * r; }
        let cost = Math.sqrt(ss / n);
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

// picks：已觸發測站（依到時排序）；idle：尚未觸發的測站；now：目前時間
export function locate(picks, idle = [], now = picks[picks.length - 1]?.tp) {
  if (!picks.length) return null;
  const many = picks.length >= 4;
  // 粗搜尋：0.1°；4 站以上才同時解深度，少站時固定 10 km
  const coarse = searchGrid(picks, idle, now, [119.0, 123.0], [21.0, 26.5], 0.1, many ? [5, 10, 20, 30, 50, 75, 100] : [10]);
  // 細搜尋：在最佳點附近 0.01°
  const depths = []; if (many) { for (let d = Math.max(2, coarse.depth - 15); d <= coarse.depth + 15; d += 2) depths.push(d); } else depths.push(10);
  const fine = searchGrid(picks, idle, now, [coarse.lon - 0.12, coarse.lon + 0.12], [coarse.lat - 0.12, coarse.lat + 0.12], 0.01, depths);
  // 規模：每站由 P 波振幅反推，取平均
  const Ms = picks.map(p => {
    const R = Math.hypot(distKm(fine.lon, fine.lat, p.lon, p.lat), fine.depth);
    return (Math.log10(p.pAmp / P_RATIO) - 1.39 + 1.5 * Math.log10(R + 10) + 0.002 * R) / 0.5;
  });
  const M = Ms.reduce((a, b) => a + b, 0) / Ms.length;
  return { ...fine, M: Math.round(M * 10) / 10, n: picks.length };
}
