// 訊號處理：去除重力（高通）、PGA、PGV、STA/LTA 觸發、震度。
// 單位：輸入 m/s²；輸出加速度 gal（cm/s²）、速度 cm/s。

// ---- 中央氣象署 2020 年新制震度 ----
// 0～4 級：依最大地動加速度 PGA（gal）
// 4 級以上：再看最大地動速度 PGV（cm/s），PGV ≥ 15 才升為 5 弱以上，否則維持 4 級
const PGA_LEVELS = [[0.8, '0'], [2.5, '1'], [8, '2'], [25, '3'], [Infinity, '4']];
const PGV_LEVELS = [[15, '4'], [30, '5弱'], [50, '5強'], [80, '6弱'], [140, '6強'], [Infinity, '7']];
export const INTENSITY_NAMES = ['0', '1', '2', '3', '4', '5弱', '5強', '6弱', '6強', '7'];

// 中央氣象署震度圖例配色
export const INTENSITY_COLORS = {
  '0': '#e2e8f0', '1': '#33ffdd', '2': '#34ff32', '3': '#fefd32', '4': '#fe8532',
  '5弱': '#fd5233', '5強': '#c43745', '6弱': '#9d4646', '6強': '#9a4c86', '7': '#b51fea',
};

const pick = (table, v) => table.find(([lim]) => v < lim)[1];

export function intensity(pga, pgv = 0) {
  const a = pick(PGA_LEVELS, pga);
  if (a !== '4') return a;
  return pick(PGV_LEVELS, pgv);
}
export const intensityIndex = name => INTENSITY_NAMES.indexOf(name);

// 一階高通（約 0.1 Hz）去除重力與感測器偏移
class HighPass {
  constructor(rate, fc = 0.1) { const rc = 1 / (2 * Math.PI * fc); this.a = rc / (rc + 1 / rate); this.prevIn = null; this.prevOut = 0; }
  step(v) {
    if (this.prevIn === null) { this.prevIn = v; return 0; }
    const out = this.a * (this.prevOut + v - this.prevIn);
    this.prevIn = v; this.prevOut = out; return out;
  }
}

// 加速度積分成速度，並以 0.1 Hz 洩漏避免積分漂移
class Integrator {
  constructor(rate, fc = 0.1) { this.dt = 1 / rate; this.leak = Math.exp(-2 * Math.PI * fc / rate); this.v = 0; }
  step(a) { this.v = (this.v + a * this.dt) * this.leak; return this.v; }
}

export class Detector {
  constructor({ rate = 100, staSec = 1, ltaSec = 30, threshold = 3, offRatio = 1.5 } = {}) {
    this.rate = rate; this.staSec = staSec; this.ltaSec = ltaSec;
    this.threshold = threshold; this.offRatio = offRatio;
    this.hp = [0, 1, 2].map(() => new HighPass(rate));
    this.int = [0, 1, 2].map(() => new Integrator(rate));
    this.sta = [0, 0, 0]; this.lta = [0, 0, 0];
    this.count = 0; this.ratio = 0;
    this.triggered = false; this.event = null;
    this.onTrigger = () => {}; this.onEnd = () => {};
  }

  // 回傳 {t, x, y, z (gal), pga (gal), pgv (cm/s)}
  process(s) {
    const v = [s.x, s.y, s.z].map((a, i) => this.hp[i].step(a) * 100);
    const vel = v.map((a, i) => this.int[i].step(a));
    const aS = 1 / (this.staSec * this.rate), aL = 1 / (this.ltaSec * this.rate);
    let ratio = 0;
    this.count++;
    for (let i = 0; i < 3; i++) {
      const e = v[i] * v[i];
      this.sta[i] += aS * (e - this.sta[i]);
      if (!this.triggered) this.lta[i] += aL * (e - this.lta[i]); // 觸發期間凍結背景值
      const r = this.lta[i] > 1e-6 ? this.sta[i] / this.lta[i] : 0;
      if (r > ratio) ratio = r;
    }
    const warm = this.count > this.ltaSec * this.rate * 0.5;
    const pga = Math.hypot(v[0], v[1], v[2]);
    const pgv = Math.hypot(vel[0], vel[1], vel[2]);
    this.ratio = ratio;

    if (warm && !this.triggered && ratio > this.threshold) {
      this.triggered = true;
      this.event = { start: s.t, pga: 0, pgv: 0 };
      this.onTrigger(this.event);
    }
    if (this.triggered) {
      this.event.pga = Math.max(this.event.pga, pga);
      this.event.pgv = Math.max(this.event.pgv, pgv);
      if (ratio < this.offRatio && s.t - this.event.start > 3000) {
        this.triggered = false;
        this.event.end = s.t;
        this.onEnd(this.event);
        this.event = null;
      }
    }
    return { t: s.t, x: v[0], y: v[1], z: v[2], pga, pgv };
  }
}
