// 模擬資料來源：產生 ICM-42688-P 風格的三軸加速度（單位 m/s²），含重力、雜訊與可注入的模擬地震。
// 所有資料來源都實作同一介面：start(onSamples, onStatus)、stop()；onSamples 接收 [{t, x, y, z}] 陣列。
const G = 9.80665;

export class SimulatorSource {
  constructor({ rate = 100 } = {}) {
    this.rate = rate;
    this.timer = null;
    this.quakes = [];
  }

  start(onSamples, onStatus) {
    const dt = 1000 / this.rate;
    let next = Date.now();
    this.timer = setInterval(() => {
      const now = Date.now();
      const batch = [];
      while (next <= now) { batch.push(this.sample(next)); next += dt; }
      if (batch.length) onSamples(batch);
    }, 20);
    onStatus('on', `模擬中（${this.rate} Hz）`);
  }

  stop() { clearInterval(this.timer); this.timer = null; }

  // 注入一次模擬地震：P 波先到、S 波較強，振幅隨機（gal 數量級 5~120）
  // 也可指定參數（台灣地震模擬用）：t0 = P 波到達時間、sp = S−P 時間差 (ms)、
  // peak = S 波最大加速度 (m/s²)、freq = S 波主頻 (Hz)、dur = 持續時間 (ms)
  injectQuake(opts = {}) {
    const q = {
      t0: Date.now() + 500,
      sp: 2000 + Math.random() * 3000,
      peak: (5 + Math.random() * 115) / 100,
      freq: 2.1,
      dur: 8000 + Math.random() * 8000,
      ...opts,
    };
    this.quakes.push(q);
  }

  sample(t) {
    const n = () => (Math.random() + Math.random() + Math.random() - 1.5) * 0.0012; // 約 0.06 gal 雜訊（接近 ICM-42688-P 規格）
    let x = n() + 0.02, y = n() - 0.01, z = n() + G;
    for (const q of this.quakes) {
      const s = (t - q.t0) / 1000;
      if (s < 0) continue;
      // P 波：高頻、小振幅、垂直為主
      const pEnv = Math.exp(-s / 1.5) * Math.min(1, s * 5);
      z += 0.25 * q.peak * pEnv * Math.sin(2 * Math.PI * 8 * s);
      // S 波：低頻、大振幅、水平為主
      const ss = s - q.sp / 1000;
      if (ss > 0) {
        const sEnv = Math.min(1, ss * 2) * Math.exp(-ss / (q.dur / 4000));
        const f = q.freq;
        x += q.peak * sEnv * Math.sin(2 * Math.PI * f * ss) * (0.8 + 0.2 * Math.sin(ss * 7));
        y += 0.7 * q.peak * sEnv * Math.sin(2 * Math.PI * f * 0.76 * ss + 1);
        z += 0.3 * q.peak * sEnv * Math.sin(2 * Math.PI * f * 1.4 * ss);
      }
    }
    this.quakes = this.quakes.filter(q => t - q.t0 < q.sp + q.dur * 2);
    return { t, x, y, z };
  }
}
