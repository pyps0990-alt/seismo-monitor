// CSV 記錄：
// 1) 長時間記錄：用 File System Access API 直接寫入使用者選的檔案（Chrome/Edge），每秒寫一次。
//    不支援時改為存在記憶體，停止時下載。
// 2) 事件記錄：保留觸發前 30 秒、觸發後到結束再加 30 秒，自動下載成獨立 CSV。
// CSV 欄位：time_iso,unix_ms,ax,ay,az（m/s²，原始值含重力）

export const CSV_HEADER = 'time_iso,unix_ms,ax_ms2,ay_ms2,az_ms2\n';
const row = s => `${new Date(s.t).toISOString()},${Math.round(s.t)},${s.x.toFixed(5)},${s.y.toFixed(5)},${s.z.toFixed(5)}\n`;

export function stamp(t = Date.now()) {
  const d = new Date(t), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function download(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return url;
}

export class LongRecorder {
  constructor() { this.active = false; this.rows = 0; this.pending = ''; this.mem = null; this.writable = null; }

  async start() {
    const name = `seismo_${stamp()}.csv`;
    this.name = name;
    if (window.showSaveFilePicker) {
      const h = await window.showSaveFilePicker({ suggestedName: name, types: [{ description: 'CSV', accept: { 'text/csv': ['.csv'] } }] });
      this.name = h.name;
      this.writable = await h.createWritable();
      await this.writable.write(CSV_HEADER);
    } else {
      this.mem = [CSV_HEADER];
    }
    this.rows = 0; this.active = true;
    this.timer = setInterval(() => this.flush(), 1000);
  }

  add(s) { if (!this.active) return; this.pending += row(s); this.rows++; }

  async flush() {
    if (!this.pending) return;
    const chunk = this.pending; this.pending = '';
    if (this.writable) await this.writable.write(chunk); else this.mem.push(chunk);
  }

  async stop() {
    this.active = false; clearInterval(this.timer);
    await this.flush();
    if (this.writable) { await this.writable.close(); this.writable = null; }
    else if (this.mem) { download(this.name, this.mem.join('')); this.mem = null; }
  }
}

export class EventRecorder {
  constructor({ preSec = 30, postSec = 30 } = {}) {
    this.preMs = preSec * 1000; this.postMs = postSec * 1000;
    this.ring = []; this.capture = null;
    this.onSaved = () => {};
  }

  add(s) {
    this.ring.push(s);
    while (this.ring.length && s.t - this.ring[0].t > this.preMs) this.ring.shift();
    if (this.capture) {
      this.capture.rows.push(s);
      if (this.capture.endAt && s.t >= this.capture.endAt) this.save();
    }
  }

  begin(ev) {
    if (this.capture) { this.capture.endAt = null; this.capture.ev = ev; return; } // 前一個事件還沒存完，合併
    this.capture = { ev, rows: [...this.ring], endAt: null };
  }

  end(ev) { if (this.capture) this.capture.endAt = ev.end + this.postMs; }

  save() {
    const { ev, rows } = this.capture; this.capture = null;
    const name = `event_${stamp(ev.start)}.csv`;
    const url = download(name, CSV_HEADER + rows.map(row).join(''));
    this.onSaved(ev, name, url);
  }
}

// 解析 CSV（本程式格式），回傳 [{t,x,y,z}]
export function parseCsv(text) {
  const out = [];
  for (const line of text.split(/\r?\n/).slice(1)) {
    const p = line.split(',');
    if (p.length < 5) continue;
    const t = Number(p[1]), x = Number(p[2]), y = Number(p[3]), z = Number(p[4]);
    if ([t, x, y, z].some(Number.isNaN)) continue;
    out.push({ t, x, y, z });
  }
  return out;
}
