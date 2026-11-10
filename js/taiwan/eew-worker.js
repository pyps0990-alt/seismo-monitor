// 地震速報計算的背景執行緒（Web Worker）
// 定位、規模、範圍通知判斷都在這裡算，算完再把結果推回主畫面 → 計算再久，畫面也不會卡
// 訊息格式：
//   主畫面 → worker：{ id, type: 'solve', picks, idle, now, prev, wantNotice }
//   worker → 主畫面：{ id, sol, notice, calcMs }
import { loadTowns } from './geo.js';
import { loadModel, locate, locateRobust, noticeCandidates, NOTICE } from './eew.js';
import { distKm } from './geo.js';

const ready = Promise.all([loadTowns('../../data/towns.json'), loadModel('../../data/model.json')]);

self.onmessage = async ({ data: m }) => {
  await ready;
  if (m.type !== 'solve') return;
  const t = performance.now();
  const sol = locateRobust(m.picks, m.idle, m.now, m.prev);
  let notice = null;
  // 還沒有正式解時，判斷是否要發「範圍通知」（3 站確認，或 2 站確認且 P 波振幅 ≥ 3 gal；初估規模 ≥ 4.0）
  if (!sol && m.wantNotice) {
    const cand = noticeCandidates(m.picks, m.now);
    if (cand) {
      const recent = cand.picks;
      const near = m.idle.map(s => [distKm(s.lon, s.lat, recent[0].lon, recent[0].lat), s]).filter(([d]) => d < 150)
        .sort((a, b) => a[0] - b[0]).slice(0, 40).map(([, s]) => s);
      const pv = locate(recent.slice(0, 3), near, m.now);
      if (pv.mPartial || pv.M >= NOTICE.MIN_M) notice = { ...pv, prelim: true, n: recent.length, used: recent, rejected: [], rule: cand.rule };
    }
  }
  self.postMessage({ id: m.id, sol, notice, calcMs: performance.now() - t });
};
