// 真實地震回放穩定度測試
// 用法：node tools/replay-real.mjs [每個地震重播次數=50]
// 每次回放：震源用官方目錄值（USGS／氣象署），測站 P 波到時依距離計算並加上挑波誤差、隨機誤觸發；
// 系統跑完整速報流程（範圍通知 → 正式速報），再用「當時各測站實測震度」對答案。
// 注意：預估式是用這些地震（含本身）訓練的，震度吻合率屬於樣本內結果，會比對全新地震略好。
import fs from 'node:fs';

globalThis.fetch = async url => ({ json: async () => JSON.parse(fs.readFileSync(url, 'utf8')) });
const G = await import('../js/taiwan/geo.js');
const E = await import('../js/taiwan/eew.js');
const S = await import('../js/taiwan/site.js');
const D = await import('../js/detector.js');
await G.loadTowns('data/towns.json');
await E.loadModel('data/model.json');
const EVENTS = JSON.parse(fs.readFileSync('data/real-events.json', 'utf8'));
const RUNS = +(process.argv[2] || 50);

// 實測測站的場址（地形推估＋鄉鎮修正）
for (const ev of EVENTS) for (const st of ev.stations) { const t = G.townAt(st.lon, st.lat); st.site = { ...S.siteOf(st.lon, st.lat), id: t?.id }; st.obs = D.intensity(st.pga, st.pgv); }

const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
const sd = a => { const m = mean(a); return Math.sqrt(mean(a.map(x => (x - m) ** 2))); };
const rows = [], all = { notice: [], first: [], epi: [], dM: [], exact: [], w1: [], falseNotice: 0, runs: 0 };

for (const ev of EVENTS) {
  const q = { lon: ev.lon, lat: ev.lat, depth: ev.depth, M: ev.M };
  const r = { notice: [], first: [], epi: [], dM: [], dDep: [], exact: [], w1: [], falseNotice: 0 };
  for (let k = 0; k < RUNS; k++) {
    const sc = E.createScenario(q, 0);
    const trig = sc.stations.map(s => ({ ...s, ...E.triggerOf(s) })).sort((a, b) => a.tp - b.tp);
    let noticeT = null, firstT = null, sol = null;
    for (let i = 0; i < trig.length; i++) {
      const now = trig[i].tp + E.PD.LATENCY_MS + 300, picks = trig.filter(p => E.arrived(p, now)), idle = trig.filter(p => !E.arrived(p, now));
      if (noticeT == null) {
        const c = E.noticeCandidates(picks, now);
        if (c) {
          const pv = E.locate(c.picks.slice(0, 3), idle.slice(0, 40), now);
          if (pv.mPartial || pv.M >= E.NOTICE.MIN_M) { noticeT = now; if (c.picks.every(p => p.isFalse)) r.falseNotice++; }
        }
      }
      const s = E.locateRobust(picks, idle, now);
      if (s) { if (firstT == null) firstT = now; sol = s; if (s.n >= 15 && s.nPd >= 5) break; }   // 評分時至少 5 站已收滿 3 秒 P 波（Pd 完整）
    }
    if (noticeT != null) r.notice.push(noticeT / 1000);
    if (!sol) continue;
    r.first.push(firstT / 1000);
    r.epi.push(G.distKm(q.lon, q.lat, sol.lon, sol.lat)); r.dM.push(sol.M - q.M); r.dDep.push(sol.depth - q.depth);
    // 用最後一報的震源解，預估每個實測測站的震度，與實測比較
    let ex = 0, w1 = 0;
    for (const st of ev.stations) {
      const R = E.sourceDist(st.lon, st.lat, sol);   // 大地震用有限斷層距離
      const p = E.predictAt(sol.M, R, st.site, sol.depth).n;
      const d = Math.abs(D.intensityIndex(p) - D.intensityIndex(st.obs));
      if (d === 0) ex++; if (d <= 1) w1++;
    }
    r.exact.push(ex / ev.stations.length * 100); r.w1.push(w1 / ev.stations.length * 100);
  }
  rows.push({
    地震: ev.name, M: ev.M, 深度: ev.depth, 實測站: ev.stations.length,
    範圍通知秒: `${mean(r.notice).toFixed(1)}±${sd(r.notice).toFixed(1)}`,
    正式速報秒: `${mean(r.first).toFixed(1)}±${sd(r.first).toFixed(1)}`,
    震央誤差km: `${mean(r.epi).toFixed(1)}±${sd(r.epi).toFixed(1)}`,
    規模誤差: `${mean(r.dM) >= 0 ? '+' : ''}${mean(r.dM).toFixed(2)}±${sd(r.dM).toFixed(2)}`,
    震度命中: `${mean(r.exact).toFixed(0)}%`, 差1級內: `${mean(r.w1).toFixed(0)}%`,
    假通知: `${r.falseNotice}/${RUNS}`,
  });
  for (const key of ['notice', 'first', 'epi', 'exact', 'w1']) all[key].push(...r[key]);
  all.dM.push(...r.dM); all.falseNotice += r.falseNotice; all.runs += RUNS;
}
console.table(rows);
const summary = `整體（${EVENTS.length} 個真實地震 × ${RUNS} 次）：範圍通知 ${mean(all.notice).toFixed(1)} 秒、正式速報 ${mean(all.first).toFixed(1)} 秒、` +
  `震央誤差 ${mean(all.epi).toFixed(1)}±${sd(all.epi).toFixed(1)} km、規模誤差 ${mean(all.dM).toFixed(2)}±${sd(all.dM).toFixed(2)}、` +
  `測站震度命中 ${mean(all.exact).toFixed(0)}%、差 1 級內 ${mean(all.w1).toFixed(0)}%、範圍通知被雜訊觸發 ${all.falseNotice}/${all.runs}`;
console.log(summary);
fs.writeFileSync('data/replay-report.txt', JSON.stringify(rows, null, 1) + '\n' + summary + '\n');
