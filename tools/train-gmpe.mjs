// 用 USGS ShakeMap 實測資料「訓練」（迴歸校正）地震動預估式，並估算各鄉鎮場址修正
// 用法：node tools/train-gmpe.mjs
// 輸入：data/usgs/records.json、data/towns.json
// 輸出：data/model.json（網頁載入使用）、data/model-report.txt（訓練報告）
//
// 模型：log10(Y) − log10(地形放大) = c0 + c1·M + c2·log10(R + h) + c3·R + c4·深度
//   Y = PGA (gal) 或 PGV (cm/s)，R = 震源距離 (km)
// 驗證：依「地震」隨機分成 80% 訓練、20% 測試（同一地震的測站不會同時出現在兩邊）
import fs from 'node:fs';

// 讓 geo.js 的 loadTowns 能在 Node 讀本機檔
globalThis.fetch = async url => ({ json: async () => JSON.parse(fs.readFileSync(url, 'utf8')) });
const G = await import('../js/taiwan/geo.js');
const S = await import('../js/taiwan/site.js');
const D = await import('../js/detector.js');
await G.loadTowns('data/towns.json');

// 資料來源：USGS ShakeMap（M5 以上為主）＋ 中央氣象署地震報告（含 M3～4 小地震，累積保存）
const records = JSON.parse(fs.readFileSync('data/usgs/records.json', 'utf8')).records.map(r => ({ ...r, src: 'USGS' }));
if (fs.existsSync('data/cwa/records.json')) records.push(...JSON.parse(fs.readFileSync('data/cwa/records.json', 'utf8')).records);
const nSrc = s => records.filter(r => r.src === s).length;
for (const r of records) {
  const s = S.siteOf(r.sLon, r.sLat);
  r.ampA = s.ampA; r.ampV = s.ampV;
  r.town = G.townAt(r.sLon, r.sLat)?.id ?? null;
}

// ---- 依地震做 5 折交叉驗證（固定亂數種子，結果可重現）----
let seed = 20261109; const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
const evIds = [...new Set(records.map(r => r.ev))];
const shuffled = evIds.map(e => [rand(), e]).sort((a, b) => a[0] - b[0]).map(x => x[1]);
const FOLDS = 5, foldOf = {}; shuffled.forEach((e, i) => foldOf[e] = i % FOLDS);

// 每筆權重 = 1 / √(該地震測站數)：避免 2024 花蓮 M7.4（347 站）一個地震主導整個模型
const nPerEv = {}; records.forEach(r => nPerEv[r.ev] = (nPerEv[r.ev] || 0) + 1);
const weight = r => 1 / Math.sqrt(nPerEv[r.ev]);

// ---- 加權最小平方法（正規方程式＋高斯消去）----
function lstsq(X, y, w) {
  const k = X[0].length, A = Array.from({ length: k }, () => new Array(k).fill(0)), b = new Array(k).fill(0);
  for (let i = 0; i < X.length; i++) for (let a = 0; a < k; a++) { b[a] += w[i] * X[i][a] * y[i]; for (let c = 0; c < k; c++) A[a][c] += w[i] * X[i][a] * X[i][c]; }
  for (let a = 0; a < k; a++) A[a][a] += 1e-9;
  for (let p = 0; p < k; p++) {
    let m = p; for (let r = p + 1; r < k; r++) if (Math.abs(A[r][p]) > Math.abs(A[m][p])) m = r;
    [A[p], A[m]] = [A[m], A[p]]; [b[p], b[m]] = [b[m], b[p]];
    for (let r = p + 1; r < k; r++) { const f = A[r][p] / A[p][p]; for (let c = p; c < k; c++) A[r][c] -= f * A[p][c]; b[r] -= f * b[p]; }
  }
  const x = new Array(k).fill(0);
  for (let p = k - 1; p >= 0; p--) { let s = b[p]; for (let c = p + 1; c < k; c++) s -= A[p][c] * x[c]; x[p] = s / A[p][p]; }
  return x;
}

// 最後一項是「資料來源修正」：氣象署用計算震度專用的濾波值（IntScaleValue），USGS 用峰值，兩者有系統差。
// 預測時一律加上這一項 → 輸出等同於氣象署震度標準
// 第 7 項「規模 × log 距離」：大地震的長週期波衰減較慢，遠處（如臺北盆地）搖晃比等比例縮放更大
// （2024 花蓮 M7.4 時，距震央約 120 km 的臺北多站實測 5 弱，沒有這項會低估一級）
const feats = (r, h) => [1, r.M, Math.log10(r.rhypo + h), r.rhypo, r.depth, r.src === 'CWA' ? 1 : 0, (r.M - 6) * Math.log10(r.rhypo + h)];
function fit(train, key, ampKey) {
  let best = null;
  for (const h of [0, 1, 3, 5, 8, 10, 15, 20, 30]) {   // h（近震源飽和項）用格點搜尋
    const X = train.map(r => feats(r, h)), y = train.map(r => Math.log10(r[key]) - Math.log10(r[ampKey])), w = train.map(weight);
    const c = lstsq(X, y, w);
    let ss = 0, ws = 0; train.forEach((r, i) => { const e = y[i] - X[i].reduce((s, v, j) => s + v * c[j], 0); ss += w[i] * e * e; ws += w[i]; });
    const rms = Math.sqrt(ss / ws);
    if (!best || rms < best.rms) best = { h, c, rms };
  }
  return best;
}
const pred = (m, r, amp) => 10 ** (m.c[0] + m.c[1] * r.M + m.c[2] * Math.log10(r.rhypo + m.h) + m.c[3] * r.rhypo + m.c[4] * r.depth
  + (r.src === 'CWA' ? m.c[5] : 0) + m.c[6] * (r.M - 6) * Math.log10(r.rhypo + m.h)) * amp;

// ---- 鄉鎮場址修正：該鄉鎮測站平均殘差，並向 0 收縮（測站少就不太相信）----
const K_SHRINK = 3;
function siteTerms(train, mPGA, mPGV) {
  const acc = {};
  for (const r of train) {
    if (!r.town) continue;
    const a = (acc[r.town] ??= { ea: 0, ev: 0, n: 0 });
    a.ea += Math.log10(r.pga) - Math.log10(pred(mPGA, r, r.ampA));
    a.ev += Math.log10(r.pgv) - Math.log10(pred(mPGV, r, r.ampV));
    a.n++;
  }
  const out = {};
  for (const [id, a] of Object.entries(acc)) out[id] = { a: +(a.ea / (a.n + K_SHRINK)).toFixed(3), v: +(a.ev / (a.n + K_SHRINK)).toFixed(3), n: a.n };
  return out;
}
// 大地震專用鄉鎮修正：只用 M ≥ 6.5 的紀錄，計算「扣掉一般修正後」還剩下的殘差。
// 用來捕捉長週期地震波在盆地（如臺北盆地）額外放大的現象；只在預估 M ≥ 6.5 時使用。
const LARGE_M = 6.5, K_LARGE = 2;
function largeSiteTerms(train, mPGA, mPGV, site) {
  const acc = {};
  for (const r of train) {
    if (r.M < LARGE_M || !r.town) continue;
    const d = site[r.town] ?? { a: 0, v: 0 };
    const a = (acc[r.town] ??= { ea: 0, ev: 0, n: 0 });
    a.ea += Math.log10(r.pga) - Math.log10(pred(mPGA, r, r.ampA)) - d.a;
    a.ev += Math.log10(r.pgv) - Math.log10(pred(mPGV, r, r.ampV)) - d.v;
    a.n++;
  }
  const out = {};
  for (const [id, a] of Object.entries(acc)) out[id] = { a: +(a.ea / (a.n + K_LARGE)).toFixed(3), v: +(a.ev / (a.n + K_LARGE)).toFixed(3), n: a.n };
  return out;
}
function trainAll(train) {
  const mPGA = fit(train, 'pga', 'ampA'), mPGV = fit(train, 'pgv', 'ampV');
  const site = siteTerms(train, mPGA, mPGV);
  return { mPGA, mPGV, site, large: largeSiteTerms(train, mPGA, mPGV, site) };
}

// ---- 原本的手設模型（比較用）----
const oldPGA = r => 10 ** (1.39 + 0.5 * r.M - 1.5 * Math.log10(r.rhypo + 10) - 0.002 * r.rhypo) * r.ampA;
const oldPGV = r => oldPGA(r) / r.ampA * 10 ** (0.2 * r.M - 2.1) * r.ampV;

function evaluate(set, fA, fV) {
  let sa = 0, sv = 0, exact = 0, within1 = 0, bias = 0;
  for (const r of set) {
    const pa = fA(r), pv = fV(r);
    const ea = Math.log10(pa) - Math.log10(r.pga), ev = Math.log10(pv) - Math.log10(r.pgv);
    sa += ea * ea; sv += ev * ev; bias += ea;
    const di = Math.abs(D.intensityIndex(D.intensity(pa, pv)) - D.intensityIndex(D.intensity(r.pga, r.pgv)));
    if (di === 0) exact++; if (di <= 1) within1++;
  }
  const n = set.length;
  return { n, pgaRmsLog10: +(Math.sqrt(sa / n)).toFixed(3), pgvRmsLog10: +(Math.sqrt(sv / n)).toFixed(3), pgaBiasLog10: +(bias / n).toFixed(3),
    intensityExact: +(exact / n * 100).toFixed(1), intensityWithin1: +(within1 / n * 100).toFixed(1) };
}
// 交叉驗證：每一折用其他 4 折訓練，預測這一折；收集所有預測後一起評分
const cvPred = { gmpe: new Map(), site: new Map() };
for (let f = 0; f < FOLDS; f++) {
  const tr = records.filter(r => foldOf[r.ev] !== f), te = records.filter(r => foldOf[r.ev] === f);
  const m = trainAll(tr);
  for (const r of te) {
    const d = m.site[r.town] ?? { a: 0, v: 0 };
    const pa = pred(m.mPGA, r, r.ampA), pv = pred(m.mPGV, r, r.ampV);
    cvPred.gmpe.set(r, [pa, pv]); cvPred.site.set(r, [pa * 10 ** d.a, pv * 10 ** d.v]);
  }
}
const res = {
  old: evaluate(records, oldPGA, oldPGV),
  gmpe: evaluate(records, r => cvPred.gmpe.get(r)[0], r => cvPred.gmpe.get(r)[1]),
  gmpeSite: evaluate(records, r => cvPred.site.get(r)[0], r => cvPred.site.get(r)[1]),
};
// ---- 大地震留一法測試：預測某個大地震時，大地震修正只能用「其他」大地震學 ----
const largeEvs = [...new Set(records.filter(r => r.M >= LARGE_M).map(r => r.ev))];
const largeReport = [];
for (const evId of largeEvs) {
  const tr = records.filter(r => r.ev !== evId), te = records.filter(r => r.ev === evId);
  const m = trainAll(tr);
  let hit0 = 0, hit1 = 0, under0 = 0, under1 = 0;
  for (const r of te) {
    const d = m.site[r.town] ?? { a: 0, v: 0 }, L = m.large[r.town] ?? { a: 0, v: 0 };
    const obs = D.intensityIndex(D.intensity(r.pga, r.pgv));
    const p0 = D.intensityIndex(D.intensity(pred(m.mPGA, r, r.ampA) * 10 ** d.a, pred(m.mPGV, r, r.ampV) * 10 ** d.v));
    const p1 = D.intensityIndex(D.intensity(pred(m.mPGA, r, r.ampA) * 10 ** (d.a + L.a), pred(m.mPGV, r, r.ampV) * 10 ** (d.v + L.v)));
    if (p0 === obs) hit0++; if (p1 === obs) hit1++; if (p0 < obs) under0++; if (p1 < obs) under1++;
  }
  const n = te.length;
  largeReport.push(`  ${evId} M${te[0].M}（${n} 站）：命中 ${(hit0 / n * 100).toFixed(0)}% → ${(hit1 / n * 100).toFixed(0)}%，低估 ${(under0 / n * 100).toFixed(0)}% → ${(under1 / n * 100).toFixed(0)}%`);
}

// 正式模型：用全部資料訓練
const { mPGA, mPGV, site: siteDelta, large: siteDeltaLarge } = trainAll(records);
const train = records, testEv = { size: 0 };

const round = c => c.map(v => +v.toFixed(5));
const model = {
  source: 'USGS ShakeMap 測站實測資料迴歸（tools/train-gmpe.mjs）',
  trained: new Date().toISOString(),
  data: { events: evIds.length, records: records.length, validation: `依地震 ${FOLDS} 折交叉驗證` },
  form: 'log10(Y) = c0 + c1*M + c2*log10(R+h) + c3*R + c4*depth + log10(地形放大) + 鄉鎮修正',
  // 網頁端只用前 5 個係數；c0 已併入氣象署來源修正（c5），輸出即氣象署震度標準
  // c[5]＝規模×log距離 交互項（對 (M−6)·log10(R+h)）
  pga: { c: round([mPGA.c[0] + mPGA.c[5], ...mPGA.c.slice(1, 5), mPGA.c[6]]), h: mPGA.h, cwaOffset: +mPGA.c[5].toFixed(4) },
  pgv: { c: round([mPGV.c[0] + mPGV.c[5], ...mPGV.c.slice(1, 5), mPGV.c[6]]), h: mPGV.h, cwaOffset: +mPGV.c[5].toFixed(4) },
  siteDelta, siteDeltaLarge, largeM: LARGE_M, test: res,
};
fs.writeFileSync('data/model.json', JSON.stringify(model));

const pct = (a, b) => `${((1 - b / a) * 100).toFixed(0)}%`;
const report = [
  `資料來源：USGS ${nSrc('USGS')} 筆、中央氣象署 ${nSrc('CWA')} 筆；氣象署來源修正 PGA ${mPGA.c[5].toFixed(3)}、PGV ${mPGV.c[5].toFixed(3)}（log10）`,
  `訓練資料：${evIds.length} 個地震、${records.length} 筆測站紀錄；驗證方式：依地震 ${FOLDS} 折交叉驗證（每筆都在「沒看過該地震」的模型下預測）`,
  `PGA 係數：c=${round(mPGA.c).join(', ')}，h=${mPGA.h}`,
  `PGV 係數：c=${round(mPGV.c).join(', ')}，h=${mPGV.h}`,
  `有場址修正的鄉鎮：${Object.keys(siteDelta).length} 個`,
  '',
  '交叉驗證結果（全部紀錄，每筆都用沒看過該地震的模型預測）：',
  '模型                 PGA誤差(log10)  PGV誤差(log10)  震度完全命中  震度差≤1級',
  ...Object.entries({ '原本手設': res.old, '校正衰減式': res.gmpe, '校正＋鄉鎮修正': res.gmpeSite })
    .map(([k, v]) => `${k.padEnd(14, '　')} ${String(v.pgaRmsLog10).padStart(8)}       ${String(v.pgvRmsLog10).padStart(8)}       ${String(v.intensityExact).padStart(6)}%     ${String(v.intensityWithin1).padStart(6)}%`),
  '',
  `PGA 誤差降低 ${pct(res.old.pgaRmsLog10, res.gmpeSite.pgaRmsLog10)}，PGV 誤差降低 ${pct(res.old.pgvRmsLog10, res.gmpeSite.pgvRmsLog10)}`,
  '（log10 誤差 0.3 ≈ 預估值常在實際的 1/2～2 倍之間）',
  '',
  `大地震專用鄉鎮修正（M ≥ ${LARGE_M}，${Object.keys(siteDeltaLarge).length} 個鄉鎮）留一法測試（加修正前 → 加修正後）：`,
  ...largeReport,
].join('\n');
fs.writeFileSync('data/model-report.txt', report);
console.log(report);
