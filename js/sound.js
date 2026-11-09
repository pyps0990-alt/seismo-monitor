// 音效：全部用 Web Audio 即時合成（不需音檔，Tauri 離線也能用）＋ 語音播報（speechSynthesis）
export class Sound {
  constructor(enabled = () => true) {
    this.enabled = enabled;
    this.ctx = null;
  }

  // 共用一個 AudioContext；第一次使用者點擊後才能發聲
  ac() {
    if (!this.enabled()) return null;
    try {
      if (!this.ctx) {
        this.ctx = new AudioContext();
        this.master = this.ctx.createGain(); this.master.gain.value = 0.8;
        // 簡易殘響：短延遲回授，讓聲音不那麼「乾」
        const d = this.ctx.createDelay(); d.delayTime.value = 0.09;
        const fb = this.ctx.createGain(); fb.gain.value = 0.22;
        const wet = this.ctx.createGain(); wet.gain.value = 0.25;
        this.master.connect(this.ctx.destination);
        this.master.connect(d); d.connect(fb); fb.connect(d); d.connect(wet); wet.connect(this.ctx.destination);
      }
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return this.ctx;
    } catch { return null; }
  }

  // 基本音：type 波形、f 頻率、t 開始、dur 長度、vol 音量、slide 結束頻率
  tone({ f, t = 0, dur = 0.2, vol = 0.2, type = 'sine', slide = null, attack = 0.005 }) {
    const ac = this.ac(); if (!ac) return;
    const t0 = ac.currentTime + t;
    const o = ac.createOscillator(), g = ac.createGain();
    o.type = type; o.frequency.setValueAtTime(f, t0);
    if (slide) o.frequency.exponentialRampToValueAtTime(slide, t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g); g.connect(this.master);
    o.start(t0); o.stop(t0 + dur + 0.05);
  }

  // 鐘聲：基音＋泛音，柔和
  bell(f, t = 0, vol = 0.15, dur = 1.2) {
    [[1, 1], [2.01, 0.4], [3.02, 0.18], [4.2, 0.08]].forEach(([m, v]) => this.tone({ f: f * m, t, dur: dur / m ** 0.3, vol: vol * v, attack: 0.004 }));
  }

  // 測站觸發（地圖上）：輕柔短音
  stationPing() { this.tone({ f: 1760, dur: 0.08, vol: 0.04, type: 'sine' }); }

  // 本站偵測到 P 波：兩聲上行鐘聲
  localP() { this.bell(1046.5, 0, 0.14); this.bell(1568, 0.16, 0.14); }

  // 本站震動觸發（監測面板）：三短聲
  trigger() { [0, 0.18, 0.36].forEach(t => this.tone({ f: 1318, t, dur: 0.14, vol: 0.16, type: 'triangle' })); }

  // 地震速報警報：上下掃頻的警笛（三輪），之後由語音播報內容
  eewAlarm(severe) {
    const rounds = severe ? 4 : 3;
    for (let i = 0; i < rounds; i++) {
      const t = i * 0.55;
      this.tone({ f: 740, slide: 1480, t, dur: 0.26, vol: 0.13, type: 'sawtooth', attack: 0.01 });
      this.tone({ f: 1480, slide: 740, t: t + 0.27, dur: 0.26, vol: 0.13, type: 'sawtooth', attack: 0.01 });
      this.tone({ f: 370, t, dur: 0.53, vol: 0.07, type: 'square' });
    }
    return rounds * 0.55;
  }

  // 速報更新：單一提示音
  update() { this.bell(1318.5, 0, 0.1, 0.6); }

  // 倒數滴答：最後 3 秒較高、較響
  tick(sec) { this.tone({ f: sec <= 3 ? 1500 : 1000, dur: 0.06, vol: sec <= 3 ? 0.2 : 0.11, type: 'square' }); }

  // S 波抵達：低頻轟隆聲（濾波雜訊＋低音）
  rumble() {
    const ac = this.ac(); if (!ac) return;
    const t0 = ac.currentTime, len = 2.5;
    const buf = ac.createBuffer(1, ac.sampleRate * len, ac.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    const src = ac.createBufferSource(); src.buffer = buf;
    const lp = ac.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 160;
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(0.9, t0 + 0.3); g.gain.exponentialRampToValueAtTime(0.0001, t0 + len);
    src.connect(lp); lp.connect(g); g.connect(this.master); src.start(t0);
    this.tone({ f: 55, slide: 40, dur: 2, vol: 0.3, type: 'sine', attack: 0.2 });
  }

  // 語音播報（繁體中文）
  speak(text, delay = 0) {
    if (!this.enabled() || !window.speechSynthesis) return;
    setTimeout(() => {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'zh-TW'; u.rate = 1.05;
      const v = speechSynthesis.getVoices().find(v => v.lang === 'zh-TW' || v.lang === 'zh_TW');
      if (v) u.voice = v;
      speechSynthesis.speak(u);
    }, delay * 1000);
  }
}
