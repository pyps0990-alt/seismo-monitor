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

  // 持續音（警報用）：三角波＋少量方波疊加，帶短起音與釋音，聽起來是「嗶」而不是刺耳噪音
  beep(f, t, dur, vol = 0.18) {
    const ac = this.ac(); if (!ac) return;
    const t0 = ac.currentTime + t;
    for (const [type, v] of [['triangle', 1], ['square', 0.12]]) {
      const o = ac.createOscillator(), g = ac.createGain();
      o.type = type; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(vol * v, t0 + 0.015);
      g.gain.setValueAtTime(vol * v, t0 + dur - 0.03);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      o.connect(g); g.connect(this.master); o.start(t0); o.stop(t0 + dur + 0.02);
    }
  }

  // ---- 警報音設計 ----
  // 參考手機緊急警報的公開規格：美國 WEA／台灣 PWS 等「注意訊號」使用 853 Hz 與 960 Hz 兩個正弦波同時發聲，
  // 這兩個頻率不和諧、穿透力強，一聽就知道是警報；再搭配「長－短－短」的斷續節奏。
  // 這裡只參考頻率與節奏的規格，不使用任何 App 或電視台的音檔。
  dualTone(t, dur, vol = 0.2) {
    const ac = this.ac(); if (!ac) return;
    const t0 = ac.currentTime + t;
    for (const f of [853, 960]) {
      const o = ac.createOscillator(), g = ac.createGain();
      o.type = 'sine'; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(vol, t0 + 0.02);
      g.gain.setValueAtTime(vol, t0 + dur - 0.03);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      o.connect(g); g.connect(this.master); o.start(t0); o.stop(t0 + dur + 0.02);
    }
  }

  // 區域警示（P 波偵測）：在警示區內 → 雙音快速三響（急）；不在區內 → 柔和兩音提示
  regionAlert(inside) {
    if (inside) { [0, 0.32, 0.64].forEach(t => this.dualTone(t, 0.22, 0.24)); return 1.0; }
    this.note(784, 0, 0.14, 0.7); this.note(1047, 0.16, 0.14, 0.9); return 0.9;
  }
  // 一般地震速報：雙音「長－短」一次＋上行提示音（約 1.9 秒）
  eewNormal() {
    this.dualTone(0, 0.8, 0.2); this.dualTone(1.0, 0.4, 0.2);
    this.note(1047, 1.5, 0.12, 0.6);
    return 2.0;
  }
  // 緊急地震速報：雙音「長－短－短」完整節奏（約 2.9 秒），音量較大
  eewEmergency() {
    this.dualTone(0, 1.2, 0.28); this.dualTone(1.45, 0.55, 0.28); this.dualTone(2.25, 0.55, 0.28);
    return 3.0;
  }

  update() { this.note(1175, 0, 0.1, 0.6); }                               // 速報更新
  tick(sec) { this.beep(sec <= 3 ? 1319 : 988, 0, 0.09, sec <= 3 ? 0.2 : 0.13); } // 倒數最後 5 秒
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
