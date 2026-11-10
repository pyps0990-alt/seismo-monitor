// 「最嚴重可能震度」校正：用真實地震回放，量測各速報階段「預估 vs 當時實測」最多低估多少
// 用法：node tools/calibrate-worst.mjs [每個地震重播次數=20]
// 輸出：data/worstcase.json  各階段 PGA、PGV 的 95 百分位低估量（log10），網頁用來算「最嚴重可能震度」
//
// 階段：
//   early ＝ 第一報（Pd 多半還沒收滿 3 秒，規模偏低、位置也還在修正）
//   final ＝ 至少 3 站收滿 3 秒 P 波之後
// 驗證：留一法（每次拿掉一個地震不參與校正，只用來測試），報告實際涵蓋率是否接近 95%
import fs from 'node:fs';

globalThis.fetch = async url => ({ json: async () => JSON.parse(fs.readFileSync(url, 'utf8')) });
const G = await import('../js/taiwan/geo.js');
const E = await import('../js/taiwan/eew.js');
const S = await import('../js/taiwan/site.js');
const D = await import('../js/detector.js');
await G.loadTowns('data/towns.json');
await E.loadModel('data/model.json');
const EVENTS = JSON.parse(fs.readFileSync('data/real-events.json', 'utf8'));
const RUNS = +(process.argv[2] || 20);
const Q = 0.95;

for (const ev of EVENTS) for (const st of ev.stations) {
  const t = G.townAt(st.lon, st.lat);
  st.site = { ...S.siteOf(st.lon, st.lat), id: t?.id };
  st.obs = D.intensity(st.pga, st.pgv);
}

// 收集殘差：r = log10(實測) − log10(預估)，正值代表低估
const res = {};   // res[evId][stage] = { a: [], v: [] }
for (const ev of EVENTS) {
  const q = { lon: ev.lon, lat: ev.lat, depth: ev.depth, M: ev.M };
  res[ev.id] = { early: { a: [], v: [] }, final: { a: [], v: [] } };
  for (let k = 0; k < RUNS; k++) {
    const sc = E.createScenario(q, 0);
    const trig = sc.stations.map(s => ({ ...s, ...E.triggerOf(s) })).sort((a, b) => a.tp - b.tp);
    let early = null, final = null;
    for (let i = 0; i < trig.length && !final; i++) {
      const now = trig[i].tp + E.PD.LATENCY_MS + 300, picks = trig.filter(p => E.arrived(p, now)), idle = trig.filter(p => !E.arrived(p, now));
      const s = E.locateRobust(picks, idle, now);
      if (!s) continue;
      if (!early) early = s;
      if (s.nPd >= 3) final = s;
    }
    for (const [stage, sol] of [['early', early], ['final', final]]) {
      if (!sol) continue;
      for (const st of ev.stations) {
        const p = E.predictAt(sol.M, E.sourceDist(st.lon, st.lat, sol), st.site, sol.depth);
        res[ev.id][stage].a.push(Math.log10(st.pga / p.pga));
        res[ev.id][stage].v.push(Math.log10(st.pgv / p.pgv));
      }
    }
  }
}

const quant = (arr, q) => { const s = [...arr].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
// 每個地震權重相同（測站多的地震不主導）：從每個地震各取同樣數量的樣本
const pooled = (ids, stage, key) => {
  const out = [];
  for (const id of ids) { const a = res[id][stage][key]; if (!a.length) continue; for (let i = 0; i < 400; i++) out.push(a[Math.floor(i * a.length / 400)]); }
  return out;
};
const ids = Object.keys(res);
const cal = {};
for (const stage of ['early', 'final']) cal[stage] = { a: +quant(pooled(ids, stage, 'a'), Q).toFixed(3), v: +quant(pooled(ids, stage, 'v'), Q).toFixed(3) };

// 留一法驗證：用其他地震校正的邊際，看這個地震有多少比例的測站「實測 ≤ 最嚴重可能震度」
const lines = [];
const cover = { early: [], final: [] };
for (const ev of EVENTS) {
  const others = ids.filter(id => id !== ev.id);
  const row = [];
  for (const stage of ['early', 'final']) {
    const ma = quant(pooled(others, stage, 'a'), Q), mv = quant(pooled(others, stage, 'v'), Q);
    const ra = res[ev.id][stage].a, rv = res[ev.id][stage].v;
    if (!ra.length) { row.push('-'); continue; }
    // 以震度判斷：實測震度 ≤ 用（預估×邊際）算出的震度
    let ok = 0, okBest = 0;
    for (let i = 0; i < ra.length; i++) {
      const st = ev.stations[i % ev.stations.length];
      const predA = st.pga / 10 ** ra[i], predV = st.pgv / 10 ** rv[i];
      const worst = D.intensity(predA * 10 ** ma, predV * 10 ** mv), best = D.intensity(predA, predV);
      if (D.intensityIndex(st.obs) <= D.intensityIndex(worst)) ok++;
      if (D.intensityIndex(st.obs) <= D.intensityIndex(best)) okBest++;
    }
    cover[stage].push(ok / ra.length);
    row.push(`${(okBest / ra.length * 100).toFixed(0)}% → ${(ok / ra.length * 100).toFixed(0)}%`);
  }
  lines.push(`  ${ev.name.padEnd(18, '　')} 第一報：${row[0]}　Pd 收滿後：${row[1]}`);
}
const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
const report = [
  `最嚴重可能震度校正（${EVENTS.length} 個真實地震 × ${RUNS} 次回放，${Q * 100}% 信心）`,
  `  第一報：PGA ×${(10 ** cal.early.a).toFixed(2)}、PGV ×${(10 ** cal.early.v).toFixed(2)}`,
  `  Pd 收滿後：PGA ×${(10 ** cal.final.a).toFixed(2)}、PGV ×${(10 ** cal.final.v).toFixed(2)}`,
  '',
  '留一法驗證：實測震度「不超過」預估的測站比例（最佳估計 → 最嚴重可能震度）',
  ...lines,
  `  平均涵蓋率：第一報 ${(mean(cover.early) * 100).toFixed(0)}%、Pd 收滿後 ${(mean(cover.final) * 100).toFixed(0)}%`,
].join('\n');
fs.writeFileSync('data/worstcase.json', JSON.stringify({ q: Q, ...cal, note: 'log10 安全邊際；由 tools/calibrate-worst.mjs 產生' }));
fs.writeFileSync('data/worstcase-report.txt', report + '\n');
console.log(report);
