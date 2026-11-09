// 以 Canvas 繪製三軸波形（不依賴外部套件，Tauri 離線也能用）
const COLORS = { x: '#ff6b6b', y: '#51cf66', z: '#4dabf7' };
const AXES = ['x', 'y', 'z'];

function setup(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight || canvas.height;
  if (canvas.width !== Math.round(w * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}

// data: [{t,x,y,z}]（單位 gal）；tStart/tEnd 為時間範圍
export function drawWaves(canvas, data, tStart, tEnd, { minScale = 2 } = {}) {
  const { ctx, w, h } = setup(canvas);
  ctx.clearRect(0, 0, w, h);
  const strip = h / 3, left = 56;
  ctx.font = '12px sans-serif';

  for (let a = 0; a < 3; a++) {
    const k = AXES[a], top = a * strip, mid = top + strip / 2;
    let max = minScale;
    for (const s of data) { const v = Math.abs(s[k]); if (v > max) max = v; }
    const sy = (strip / 2 - 8) / max;

    ctx.strokeStyle = '#2a333d'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(left, mid); ctx.lineTo(w, mid); ctx.stroke();
    if (a > 0) { ctx.beginPath(); ctx.moveTo(0, top); ctx.lineTo(w, top); ctx.stroke(); }
    ctx.fillStyle = COLORS[k]; ctx.fillText(k.toUpperCase(), 8, mid + 4);
    ctx.fillStyle = '#8a96a3'; ctx.fillText(`±${max.toFixed(1)}`, 8, top + 16);

    // 資料點多於像素時，每個像素畫最小值到最大值，避免漏掉尖峰
    ctx.strokeStyle = COLORS[k]; ctx.beginPath();
    const span = tEnd - tStart, pw = w - left;
    let col = -1, lo = 0, hi = 0, first = true;
    const flush = () => {
      if (col < 0) return;
      const x = left + col;
      if (first) { ctx.moveTo(x, mid - hi * sy); first = false; } else ctx.lineTo(x, mid - hi * sy);
      ctx.lineTo(x, mid - lo * sy);
    };
    for (const s of data) {
      const c = Math.floor(((s.t - tStart) / span) * pw);
      if (c < 0 || c > pw) continue;
      if (c !== col) { flush(); col = c; lo = hi = s[k]; }
      else { if (s[k] < lo) lo = s[k]; if (s[k] > hi) hi = s[k]; }
    }
    flush(); ctx.stroke();
  }
  ctx.fillStyle = '#8a96a3';
  ctx.fillText('單位 gal (cm/s²)', w - 110, h - 6);
}
