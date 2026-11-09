// 訊號處理：去除重力（高通）、PGA、STA/LTA 觸發、震度估計。
// 單位：輸入 m/s²，輸出 gal（cm/s²）。

// 中央氣象署 2020 新制震度：0~4 級以 PGA 分級；5 弱以上官方改用 PGV，
// 這裡沒有速度資料，5 弱以上用 PGA 參考值粗估，僅供參考。
const LEVELS = [
  [0.8, '0'], [2.5, '1'], [8, '2'], [25, '3'], [80, '4'],
  [140, '5弱'], [250, '5強'], [440, '6弱'], [800, '6強'], [Infinity, '7'],
];
export function intensity(gal) {
  for (const [lim, name] of LEVELS) if (gal < lim) return name;
  return '7';
}

// 一階高通（約 0.1 Hz）去除重力與感測器偏移
class HighPass {
  constructor(rate, fc = 0.1) { this.setRate(rate, fc); this.prevIn = null; this.prevOut = 0; }
  setRate(rate, fc = 0.1) { const rc = 1 / (2 * Math.PI * fc); this.a = rc / (rc + 1 / rate); }
  step(v) {
    if (this.prevIn === null) { this.prevIn = v; return 0; }
    const out = this.a * (this.prevOut + v - this.prevIn);
    this.prevIn = v; this.prevOut = out; return out;
  }
}

export class Detector {
  constructor({ rate = 100, staSec = 1, ltaSec = 30, threshold = 3, offRatio = 1.5 } = {}) {
    this.rate = rate; this.staSec = staSec; this.ltaSec = ltaSec;
    this.threshold = threshold; this.offRatio = offRatio;
    this.hp = ['x', 'y', 'z'].map(() => new HighPass(rate));
    this.sta = [0, 0, 0]; this.lta = [0, 0, 0];
    this.count = 0;
    this.triggered = false;
    this.event = null;
    this.onTrigger = () => {}; this.onEnd = () => {};
  }

  // 回傳去除重力後的樣本（gal），並更新狀態
  process(s) {
    const v = [s.x, s.y, s.z].map((a, i) => this.hp[i].step(a) * 100);
    const aS = 1 / (this.staSec * this.rate), aL = 1 / (this.ltaSec * this.rate);
    let ratio = 0;
    this.count++;
    for (let i = 0; i < 3; i++) {
      const e = v[i] * v[i];
      this.sta[i] += aS * (e - this.sta[i]);
      // 觸發期間凍結 LTA，避免地震本身把背景值拉高
      if (!this.triggered) this.lta[i] += aL * (e - this.lta[i]);
      const r = this.lta[i] > 1e-6 ? this.sta[i] / this.lta[i] : 0;
      if (r > ratio) ratio = r;
    }
    // 開機前 LTA 長度內不觸發（背景值尚未穩定）
    const warm = this.count > this.ltaSec * this.rate * 0.5;
    const pga = Math.hypot(v[0], v[1], v[2]);
    this.ratio = ratio;

    if (warm && !this.triggered && ratio > this.threshold) {
      this.triggered = true;
      this.event = { start: s.t, pga: 0 };
      this.onTrigger(this.event);
    }
    if (this.triggered) {
      this.event.pga = Math.max(this.event.pga, pga);
      if (ratio < this.offRatio && s.t - this.event.start > 3000) {
        this.triggered = false;
        this.event.end = s.t;
        this.onEnd(this.event);
        this.event = null;
      }
    }
    return { t: s.t, x: v[0], y: v[1], z: v[2], pga };
  }
}
