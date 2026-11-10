// 海溝型地震序列產生器：前震 → 主震 → 餘震
// 依據的地震學經驗規律：
//   ・Omori–Utsu 定律：餘震發生率 n(t) ∝ 1 / (t + c)^p（c ≈ 0.05 小時、p ≈ 1.1）→ 越接近主震越密集
//   ・古騰堡－芮克特（Gutenberg–Richter）關係：log10 N(≥M) = a − b·M（b ≈ 1）→ 規模每小 1 級，數量約多 10 倍
//   ・Båth 定律：最大餘震約比主震小 1.2 級
//   ・餘震分布在主震破裂面附近：破裂長度用 Wells & Coppersmith (1994) log10(L) = −2.44 + 0.59·M
// 主震位置：琉球海溝西段北側（陸側）的板塊交界面。菲律賓海板塊由南往北隱沒，
// 交界面從海溝往北變深，所以深度 20～40 km 的主震落在海溝線以北約 30～80 km。
// 海溝線依地形圖估計（台灣東南外海 → 石垣島南方 → 宮古島南方），非精確海底地形資料。

const rand = (a, b) => a + Math.random() * (b - a);
const KX = 111.32 * Math.cos(23.7 * Math.PI / 180), KY = 110.57;

// 琉球海溝西段（經度, 緯度），由西往東
export const TRENCH = [
  [121.95, 23.25], [122.5, 23.15], [123.0, 23.15], [123.5, 23.3], [124.0, 23.5], [124.5, 23.75], [125.0, 24.05], [125.5, 24.4],
];

export const SEQ = {
  ZONE: { lon: [122.2, 123.8], depth: [20, 40] },   // 主震沿海溝西段分布
  DOWNDIP_KM: [30, 80],         // 主震位在海溝線以北多遠（交界面往北變深）
  STRIKE_DEG: 80,               // 西段海溝大致呈東西向（略偏東北東）
  OMORI: { c: 0.05, p: 1.1 },   // 小時
  B: 1.0, BATH: 1.2,
  SPAN_H: 2,                    // 模擬主震後 2 小時的餘震
  MAX_AFTER: 12,                // 最多取 12 個餘震（取規模最大的）
  MIN_GAP_S: 25,                // 播放時每個地震至少間隔 25 秒（讓速報系統一次處理一個）
  SCALE: 60,                    // 時間快轉：真實 60 秒 → 播放 1 秒
};

// Omori–Utsu 分布抽樣（反函數法），回傳主震後幾小時
function omoriTime({ c, p }, T) {
  const u = Math.random(), A = c ** (1 - p), B = (T + c) ** (1 - p);
  return (A + u * (B - A)) ** (1 / (1 - p)) - c;
}
// G-R 分布抽樣（截斷在 [mMin, mMax]）
function grMag(b, mMin, mMax) {
  const u = Math.random(), beta = b * Math.LN10;
  return mMin - Math.log(1 - u * (1 - Math.exp(-beta * (mMax - mMin)))) / beta;
}

export function buildSequence(Mmain, { foreshocks = true } = {}) {
  const z = SEQ.ZONE;
  // 主震：先在海溝線上取一點，再往北（陸側、交界面變深的方向）移 30～80 km
  const lon0 = rand(...z.lon);
  let latT = TRENCH[0][1];
  for (let i = 0; i < TRENCH.length - 1; i++) {
    const [x1, y1] = TRENCH[i], [x2, y2] = TRENCH[i + 1];
    if (lon0 >= x1 && lon0 <= x2) { latT = y1 + (y2 - y1) * (lon0 - x1) / (x2 - x1); break; }
  }
  const main = { lon: lon0, lat: latT + rand(...SEQ.DOWNDIP_KM) / KY, depth: Math.round(rand(...z.depth)), M: Mmain };
  const L = 10 ** (-2.44 + 0.59 * Mmain), W = L * 0.4;                // 破裂長度與寬度（km）
  const th = SEQ.STRIKE_DEG * Math.PI / 180, ux = Math.sin(th), uy = Math.cos(th);
  const onRupture = () => {
    const a = rand(-L / 2, L / 2), b = rand(-W / 2, W / 2);
    const x = a * ux + b * uy, y = a * uy - b * ux;
    return { lon: main.lon + x / KX, lat: main.lat + y / KY, depth: Math.max(8, Math.round(main.depth + rand(-12, 12))) };
  };
  const round1 = m => Math.round(m * 10) / 10;

  // 餘震：最大餘震依 Båth 定律；其餘依 G-R 分布；時間依 Omori 定律
  const mMax = Mmain - SEQ.BATH, mMin = Math.max(4.5, Mmain - 3.2);
  const after = [{ ...onRupture(), M: round1(mMax), tH: omoriTime(SEQ.OMORI, SEQ.SPAN_H) }];
  for (let i = 0; i < 60; i++) after.push({ ...onRupture(), M: round1(grMag(SEQ.B, mMin, mMax)), tH: omoriTime(SEQ.OMORI, SEQ.SPAN_H) });
  const kept = after.sort((a, b) => b.M - a.M).slice(0, SEQ.MAX_AFTER).sort((a, b) => a.tH - b.tH);

  const list = [];
  if (foreshocks) {
    const nF = 1 + Math.floor(Math.random() * 2);
    for (let i = 0; i < nF; i++) list.push({ ...onRupture(), M: round1(Mmain - rand(1.8, 2.8)), tH: -rand(0.05, 1.5), kind: '前震' });
  }
  list.push({ ...main, tH: 0, kind: '主震' });
  for (const a of kept) list.push({ ...a, kind: '餘震' });
  list.sort((a, b) => a.tH - b.tH);

  // 播放時間：真實時間快轉 SCALE 倍，但每個地震至少間隔 MIN_GAP_S 秒
  let t = 0;
  list.forEach((e, i) => {
    if (i > 0) t += Math.max(SEQ.MIN_GAP_S, ((e.tH - list[i - 1].tH) * 3600) / SEQ.SCALE);
    e.at = t * 1000;                                            // 播放時間（毫秒，相對序列開始）
    e.realLabel = e.tH === 0 ? '主震' : e.tH < 0 ? `主震前 ${Math.round(-e.tH * 60)} 分` : `主震後 ${e.tH < 1 ? Math.max(1, Math.round(e.tH * 60)) + ' 分' : (e.tH).toFixed(1) + ' 小時'}`;
  });
  return { main, events: list, rupture: { L, W } };
}
