// 音效：用 Web Audio 合成柔和的鐘琴／木琴音色（不需音檔，Tauri 離線也能用）＋ 中文語音播報
export class Sound {
  constructor(enabled = () => true) { this.enabled = enabled; this.ctx = null; }

  ac() {
    if (!this.enabled()) return null;
    try {
      if (!this.ctx) {
        this.ctx = new AudioContext();
        this.master = this.ctx.createGain(); this.master.gain.value = 0.7;
        const lp = this.ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 5000; // 修掉刺耳高頻
        this.master.connect(lp); lp.connect(this.ctx.destination);
      }
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return this.ctx;
    } catch { return null; }
  }

  // 鐘琴音：正弦基音＋少量泛音，快速起音、自然衰減
  note(f, t = 0, vol = 0.18, dur = 1.0) {
    const ac = this.ac(); if (!ac) return;
    const t0 = ac.currentTime + t;
    for (const [m, v] of [[1, 1], [2, 0.25], [3, 0.08]]) {
      const o = ac.createOscillator(), g = ac.createGain();
      o.type = 'sine'; o.frequency.value = f * m;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(vol * v, t0 + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur / m);
      o.connect(g); g.connect(this.master); o.start(t0); o.stop(t0 + dur + 0.05);
    }
  }

  // 本站偵測到 P 波：兩音上行
  localP() { this.note(784, 0, 0.16, 0.8); this.note(1047, 0.14, 0.16, 1.0); }
  // 一般監測觸發：三音
  trigger() { [659, 784, 988].forEach((f, i) => this.note(f, i * 0.12, 0.14, 0.7)); }

  // 一般地震速報：「叮咚」兩次
  eewNormal() {
    [[880, 0], [698, 0.32], [880, 0.9], [698, 1.22]].forEach(([f, t]) => this.note(f, t, 0.2, 1.0));
    return 2.0;
  }
  // 緊急地震速報：四音上行和弦重複三次，較急促
  eewEmergency() {
    for (let k = 0; k < 3; k++) [523, 659, 784, 1047].forEach((f, i) => this.note(f, k * 0.75 + i * 0.12, 0.2, 0.6));
    return 2.4;
  }

  update() { this.note(1175, 0, 0.1, 0.6); }                               // 速報更新
  tick(sec) { this.note(sec <= 3 ? 1319 : 988, 0, sec <= 3 ? 0.12 : 0.07, 0.25); } // 倒數
  arrive() { [784, 659, 523].forEach((f, i) => this.note(f, i * 0.15, 0.16, 1.2)); } // 主震波抵達（下行）

  speak(text, delay = 0) {
    if (!this.enabled() || !window.speechSynthesis) return;
    setTimeout(() => {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'zh-TW'; u.rate = 1.0; u.pitch = 1.0;
      const v = speechSynthesis.getVoices().find(v => /zh[-_]TW/i.test(v.lang));
      if (v) u.voice = v;
      speechSynthesis.speak(u);
    }, delay * 1000);
  }
}
