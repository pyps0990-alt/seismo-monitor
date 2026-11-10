// 速報演算法統計測試（隨機地震）：發布速度、定位誤差、誤報、漏報、運算時間
// 用法：node tools/bench-random.mjs [地震數=80]
import fs from 'node:fs';

globalThis.fetch = async url => ({ json: async () => JSON.parse(fs.readFileSync(url, 'utf8')) });
const G = await import('../js/taiwan/geo.js');
const E = await import('../js/taiwan/eew.js');
await G.loadTowns('data/towns.json');
await E.loadModel('data/model.json');

const N = +(process.argv[2] || 80);
const first = [], six = [], pdOk = [];
let tms = 0, cnt = 0, falseAlarms = 0, missed = 0;
for (let k = 0; k < N; k++) {
  const q = E.randomQuake(), sc = E.createScenario(q, 0);
  const trig = sc.stations.map(s => ({ ...s, ...E.triggerOf(s) })).sort((a, b) => a.tp - b.tp);
  let d1 = false, d6 = false, dp = false;
  for (let i = 0; i < trig.length && !(d6 && dp); i++) {
    const now = trig[i].tp + E.PD.LATENCY_MS + 300, picks = trig.filter(p => E.arrived(p, now)), idle = trig.filter(p => !E.arrived(p, now));
    const t = performance.now(); const s = E.locateRobust(picks, idle, now); tms += performance.now() - t; cnt++;
    if (!s) continue;
    const err = [G.distKm(q.lon, q.lat, s.lon, s.lat), Math.abs(q.M - s.M), now / 1000];
    if (!d1) { first.push(err); d1 = true; }
    if (s.n >= 6 && !d6) { six.push(err); d6 = true; }
    if (s.nPd >= 3 && !dp) { pdOk.push(err); dp = true; }   // 至少 3 站收滿 3 秒 P 波
  }
  if (!d1) missed++;
  // 純雜訊（沒有地震）時是否會誤發速報
  const noise = [];
  for (let j = 0; j < 4; j++) { const s = G.STATIONS[Math.floor(Math.random() * G.STATIONS.length)]; noise.push({ ...s, tp: Math.random() * 20000, pAmp: 1, site: { ampA: 1 } }); }
  noise.sort((a, b) => a.tp - b.tp); if (E.locateRobust(noise, [], 20000)) falseAlarms++;
}
const avg = (a, i) => (a.reduce((s, x) => s + x[i], 0) / a.length).toFixed(2);
const med = (a, i) => { const v = a.map(x => x[i]).sort((x, y) => x - y); return v[v.length >> 1].toFixed(1); };
const mx = (a, i) => Math.max(...a.map(x => x[i])).toFixed(1);
console.log(JSON.stringify({
  地震數: N, 測站: G.STATIONS.length,
  第一報: { 秒: avg(first, 2), 震央中位km: med(first, 0), 最大km: mx(first, 0), 規模誤差: avg(first, 1) },
  六站: { 秒: avg(six, 2), 震央中位km: med(six, 0), 最大km: mx(six, 0), 規模誤差: avg(six, 1) },
  三站Pd完整: { 秒: avg(pdOk, 2), 震央中位km: med(pdOk, 0), 規模誤差: avg(pdOk, 1) },
  純雜訊誤報: `${falseAlarms}/${N}`, 漏報: missed, 每次定位ms: (tms / cnt).toFixed(1),
}, null, 1));
