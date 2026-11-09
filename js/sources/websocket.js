// 網路資料來源：連到 ESP32 上的 WebSocket 伺服器。
// 每則訊息可含多行，每行格式：  毫秒時間戳,ax,ay,az   （加速度單位 g）
// 若 ESP32 的時間戳不是 Unix 時間（例如 millis()），會以收到第一筆時的電腦時間對齊。
const G = 9.80665;

export class WebSocketSource {
  constructor(url) { this.url = url; this.ws = null; this.offset = null; }

  start(onSamples, onStatus) {
    onStatus('', `連線中 ${this.url}…`);
    this.ws = new WebSocket(this.url);
    this.ws.onopen = () => onStatus('on', `已連線 ${this.url}`);
    this.ws.onclose = () => onStatus('err', '連線中斷');
    this.ws.onerror = () => onStatus('err', '連線錯誤');
    this.ws.onmessage = (ev) => {
      const batch = [];
      for (const line of String(ev.data).split('\n')) {
        const p = line.trim().split(',').map(Number);
        if (p.length < 4 || p.some(Number.isNaN)) continue;
        let t = p[0];
        if (t < 1e12) { // 非 Unix 毫秒 → 對齊電腦時間
          if (this.offset === null) this.offset = Date.now() - t;
          t += this.offset;
        }
        batch.push({ t, x: p[1] * G, y: p[2] * G, z: p[3] * G });
      }
      if (batch.length) onSamples(batch);
    };
  }

  stop() { if (this.ws) this.ws.close(); this.ws = null; this.offset = null; }
}
