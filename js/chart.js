// 以 Canvas 繪製三軸波形（不依賴外部套件，Tauri 離線也能用）
const COLORS = { x: '#fb7185', y: '#4ade80', z: '#60a5fa' };
const NAMES = { x: 'X', y: 'Y', z: 'Z' };
const AXES = ['x', 'y', 'z'];
const scales = { x: 2, y: 2, z: 2 }; // 平滑縮放，避免刻度忽大忽小

function setup(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}

const fmtTime = (t, withSec) => {
  const d = new Date(t), p = n => String(n).padStart(2, '0');
  return withSec ? `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}` : `${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

// data: [{t,x,y,z}]（單位 gal）；tStart/tEnd 為時間範圍
// opts.smooth=true 時縱軸刻度平滑變化（即時圖用），opts.marks=[{t,label}] 會畫垂直標記線
export function drawWaves(canvas, data, tStart, tEnd, { minScale = 2, smooth = false, marks = [] } = {}) {
  const { ctx, w, h } = setup(canvas);
  ctx.clearRect(0, 0, w, h);
  const left = 54, right = 12, bottom = 24, top0 = 8;
  const pw = w - left - right, ph = h - bottom - top0, strip = ph / 3;
  const span = tEnd - tStart;
  const xOf = t => left + ((t - tStart) / span) * pw;
  ctx.font = '11px "Segoe UI", "Microsoft JhengHei", sans-serif';

  // 時間格線
  const stepOpts = [1000, 2000, 5000, 10000, 30000, 60000, 300000, 600000, 1800000, 3600000];
  const step = stepOpts.find(s => pw / (span / s) > 70) || 3600000;
  ctx.textAlign = 'center';
  for (let t = Math.ceil(tStart / step) * step; t <= tEnd; t += step) {
    const x = xOf(t);
    ctx.strokeStyle = 'rgba(148,163,184,.08)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, top0); ctx.lineTo(x, top0 + ph); ctx.stroke();
    ctx.fillStyle = '#64748b';
    ctx.fillText(fmtTime(t, step >= 60000 || span > 120000), x, h - 7);
  }

  for (let a = 0; a < 3; a++) {
    const k = AXES[a], top = top0 + a * strip, mid = top + strip / 2;
    let max = minScale;
    for (const s of data) { const v = Math.abs(s[k]); if (v > max) max = v; }
    max *= 1.1;
    if (smooth) { scales[k] += (max - scales[k]) * (max > scales[k] ? 0.5 : 0.03); max = scales[k]; }
    const sy = (strip / 2 - 6) / max;

    // 背景帶與中線
    if (a % 2 === 1) { ctx.fillStyle = 'rgba(148,163,184,.025)'; ctx.fillRect(left, top, pw, strip); }
    ctx.strokeStyle = 'rgba(148,163,184,.14)'; ctx.setLineDash([3, 4]);
    ctx.beginPath(); ctx.moveTo(left, mid); ctx.lineTo(left + pw, mid); ctx.stroke();
    ctx.setLineDash([]);

    // 軸名稱與刻度
    ctx.textAlign = 'left';
    ctx.fillStyle = COLORS[k]; ctx.font = 'bold 13px "Segoe UI", sans-serif';
    ctx.fillText(NAMES[k], 12, mid + 4);
    ctx.font = '10px "Segoe UI", sans-serif'; ctx.fillStyle = '#64748b';
    ctx.fillText(`+${max.toFixed(1)}`, 8, top + 13);
    ctx.fillText(`−${max.toFixed(1)}`, 8, top + strip - 5);

    // 波形：每個像素畫最小～最大值，避免漏掉尖峰；加光暈
    ctx.save();
    ctx.beginPath(); ctx.rect(left, top, pw, strip); ctx.clip();
    ctx.strokeStyle = COLORS[k]; ctx.lineWidth = 1.4; ctx.lineJoin = 'round';
    ctx.shadowColor = COLORS[k]; ctx.shadowBlur = 8;
    ctx.beginPath();
    let col = -1, lo = 0, hi = 0, first = true;
    const flush = () => {
      if (col < 0) return;
      const x = left + col;
      if (first) { ctx.moveTo(x, mid - hi * sy); first = false; } else ctx.lineTo(x, mid - hi * sy);
      if (lo !== hi) ctx.lineTo(x, mid - lo * sy);
    };
    for (const s of data) {
      const c = Math.floor(((s.t - tStart) / span) * pw);
      if (c < 0 || c > pw) continue;
      if (c !== col) { flush(); col = c; lo = hi = s[k]; }
      else { if (s[k] < lo) lo = s[k]; if (s[k] > hi) hi = s[k]; }
    }
    flush(); ctx.stroke();
    ctx.restore();
  }

  // 事件標記
  for (const m of marks) {
    if (m.t < tStart || m.t > tEnd) continue;
    const x = xOf(m.t);
    ctx.strokeStyle = 'rgba(251,146,60,.8)'; ctx.setLineDash([4, 3]);
    ctx.beginPath(); ctx.moveTo(x, top0); ctx.lineTo(x, top0 + ph); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = '#fb923c'; ctx.textAlign = 'left'; ctx.font = 'bold 11px "Microsoft JhengHei", sans-serif';
    ctx.fillText(m.label, x + 4, top0 + 12);
  }

  // 即時圖右緣「現在」光條
  if (smooth) {
    const g = ctx.createLinearGradient(left + pw - 40, 0, left + pw, 0);
    g.addColorStop(0, 'rgba(129,140,248,0)'); g.addColorStop(1, 'rgba(129,140,248,.18)');
    ctx.fillStyle = g; ctx.fillRect(left + pw - 40, top0, 40, ph);
  }
}

// 迷你走勢圖（PGA 歷史）
export function drawSpark(canvas, values, color = '#818cf8') {
  const { ctx, w, h } = setup(canvas);
  ctx.clearRect(0, 0, w, h);
  if (values.length < 2) return;
  const max = Math.max(2, ...values) * 1.15;
  const x = i => (i / (values.length - 1)) * w, y = v => h - 2 - (v / max) * (h - 4);
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, color + '66'); g.addColorStop(1, color + '00');
  ctx.beginPath(); ctx.moveTo(0, h);
  values.forEach((v, i) => ctx.lineTo(x(i), y(v)));
  ctx.lineTo(w, h); ctx.closePath(); ctx.fillStyle = g; ctx.fill();
  ctx.beginPath(); values.forEach((v, i) => (i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v))));
  ctx.strokeStyle = color; ctx.lineWidth = 1.6; ctx.stroke();
}
