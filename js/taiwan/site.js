// 地形（場址）效應：同樣的地震，軟弱的盆地、平原會搖得比堅硬的山區厲害。
// 常用指標是 Vs30（地表下 30 公尺的平均剪力波速，m/s）：越小代表地盤越軟、放大越多。
//
// 這裡沒有實測 Vs30 資料，以地形「推估」（教學近似）：
//   1. 離山脈主軸越近 → 岩盤 → Vs30 高
//   2. 離山脈越遠的西部平原 → 沖積層 → Vs30 低
//   3. 已知的盆地與平原（臺北盆地、宜蘭平原、花東縱谷、屏東平原、嘉南平原沿海）另外指定較低值
// 放大係數：PGA × (600 / Vs30)^0.45、PGV × (600 / Vs30)^0.65（速度對軟弱地盤更敏感）
import { distToLineKm, distKm } from './geo.js';

// 山脈主軸（經度, 緯度）
const RANGES = [
  // 雪山山脈＋中央山脈
  [[121.85, 24.98], [121.55, 24.75], [121.30, 24.45], [121.22, 24.15], [121.10, 23.75], [120.98, 23.40], [120.90, 23.05], [120.82, 22.70], [120.78, 22.30], [120.80, 22.05]],
  // 玉山山脈／阿里山山脈
  [[120.95, 23.55], [120.85, 23.30], [120.72, 23.05]],
  // 海岸山脈
  [[121.52, 23.80], [121.42, 23.45], [121.32, 23.15], [121.20, 22.90]],
];

// 已知軟弱地盤區：中心、半徑（km）、Vs30
const SOFT = [
  { name: '臺北盆地', lon: 121.50, lat: 25.05, r: 13, vs30: 220 },
  { name: '宜蘭平原', lon: 121.76, lat: 24.70, r: 12, vs30: 230 },
  { name: '屏東平原', lon: 120.52, lat: 22.62, r: 18, vs30: 260 },
  { name: '花蓮平原', lon: 121.60, lat: 23.98, r: 6, vs30: 330 },
  { name: '臺東平原', lon: 121.13, lat: 22.76, r: 6, vs30: 330 },
  { name: '彰化雲林沿海', lon: 120.30, lat: 23.85, r: 25, vs30: 210 },
  { name: '嘉南沿海', lon: 120.15, lat: 23.25, r: 25, vs30: 210 },
];
// 花東縱谷（兩山脈之間的狹長谷地）
const VALLEY = [[121.60, 23.95], [121.40, 23.55], [121.30, 23.25], [121.17, 22.95]];

export function estimateVs30(lon, lat) {
  const d = Math.min(...RANGES.map(r => distToLineKm(lon, lat, r)));
  let vs = 240 + 520 * Math.exp(-d / 20);           // 山脈 ~760（岩盤），遠離 → ~240（沖積層）
  if (distToLineKm(lon, lat, VALLEY) < 5) vs = Math.min(vs, 360);
  for (const s of SOFT) {
    const k = distKm(lon, lat, s.lon, s.lat) / s.r;
    if (k < 1) vs = Math.min(vs, s.vs30 + (vs - s.vs30) * k * k); // 中心最軟，向外漸變
  }
  if (lon < 119.9) vs = 450;                         // 澎湖：玄武岩台地
  return Math.round(vs);
}

export const ampPGA = vs30 => (600 / vs30) ** 0.45;
export const ampPGV = vs30 => (600 / vs30) ** 0.65;

// 地盤分類（參考 NEHRP）
export function siteClass(vs30) {
  if (vs30 >= 760) return { cls: 'B', name: '岩盤' };
  if (vs30 >= 360) return { cls: 'C', name: '堅硬土層／軟岩' };
  if (vs30 >= 180) return { cls: 'D', name: '一般土層' };
  return { cls: 'E', name: '軟弱土層' };
}

export function siteOf(lon, lat) {
  const vs30 = estimateVs30(lon, lat);
  return { vs30, ampA: ampPGA(vs30), ampV: ampPGV(vs30) };
}
