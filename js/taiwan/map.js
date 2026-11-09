// 台灣地圖繪製：區塊震度、測站、P/S 波前、震央
import { OUTLINE, BLOCKS, BLOCK, BOUNDS, STATIONS, COUNTIES } from './geo.js';
import { INTENSITY_COLORS } from '../detector.js';
import { VP, VS } from './eew.js';

const KX = Math.cos(23.7 * Math.PI / 180);

export class TaiwanMap {
  constructor(canvas) { this.canvas = canvas; }

  setup() {
    const c = this.canvas, dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth, h = c.clientHeight;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
    const ctx = c.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // 等距投影並保持長寬比
    const spanX = (BOUNDS.lonMax - BOUNDS.lonMin) * KX, spanY = BOUNDS.latMax - BOUNDS.latMin;
    const s = Math.min(w / spanX, h / spanY);
    const ox = (w - spanX * s) / 2, oy = (h - spanY * s) / 2;
    this.px = (lon, lat) => [ox + (lon - BOUNDS.lonMin) * KX * s, oy + (BOUNDS.latMax - lat) * s];
    this.kmPx = s / 110.57;
    return { ctx, w, h };
  }

  // st = { scenario, now, solution, blockInts, picked:Set, home }
  draw(st) {
    const { ctx, w, h } = this.setup();
    ctx.clearRect(0, 0, w, h);
    const P = this.px;

    // 經緯網格
    ctx.strokeStyle = 'rgba(148,163,184,.07)'; ctx.lineWidth = 1;
    ctx.fillStyle = '#475569'; ctx.font = '10px "Segoe UI", sans-serif';
    for (let lon = 120; lon <= 122; lon++) { const [x] = P(lon, 0); ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); ctx.fillText(`${lon}°E`, x + 3, h - 6); }
    for (let lat = 22; lat <= 25; lat++) { const [, y] = P(0, lat); ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); ctx.fillText(`${lat}°N`, 4, y - 3); }

    // 區塊
    const [bx0, by0] = P(0, 0), [bx1, by1] = P(BLOCK, BLOCK);
    const bw = Math.abs(bx1 - bx0) - 1.2, bh = Math.abs(by1 - by0) - 1.2;
    BLOCKS.forEach((b, i) => {
      const [x, y] = P(b.lon, b.lat);
      const n = st.blockInts?.[i];
      ctx.fillStyle = n && n !== '0' ? INTENSITY_COLORS[n] : 'rgba(51,65,85,.55)';
      ctx.globalAlpha = n && n !== '0' ? 0.85 : 1;
      ctx.fillRect(x - bw / 2, y - bh / 2, bw, bh);
    });
    ctx.globalAlpha = 1;

    // 海岸線
    ctx.beginPath();
    OUTLINE.forEach(([lon, lat], i) => { const [x, y] = P(lon, lat); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.strokeStyle = 'rgba(226,232,240,.45)'; ctx.lineWidth = 1.2; ctx.stroke();

    // 波前（以真實震源繪製：這是模擬世界的實際物理）
    const sc = st.scenario;
    if (sc) {
      const el = (st.now - sc.q.t0) / 1000;
      const [ex, ey] = P(sc.q.lon, sc.q.lat);
      const ring = (v, color, dash) => {
        const r2 = (v * el) ** 2 - sc.q.depth ** 2;
        if (r2 <= 0) return;
        const r = Math.sqrt(r2) * this.kmPx;
        if (r > w * 2) return;
        ctx.beginPath(); ctx.arc(ex, ey, r, 0, Math.PI * 2);
        ctx.setLineDash(dash); ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.stroke(); ctx.setLineDash([]);
      };
      ring(VP, 'rgba(96,165,250,.9)', [6, 5]);
      ring(VS, 'rgba(244,63,94,.95)', []);
      if (st.reveal) { // 結束後顯示真實震央（空心）作比較
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(ex, ey, 7, 0, Math.PI * 2); ctx.stroke();
        ctx.fillStyle = '#e2e8f0'; ctx.font = '11px "Microsoft JhengHei"'; ctx.fillText('真實', ex + 9, ey + 14);
      }
    }

    // 測站
    for (const s of STATIONS) {
      const [x, y] = P(s.lon, s.lat);
      const hit = st.picked?.has(s.name);
      ctx.beginPath(); ctx.moveTo(x, y - 5); ctx.lineTo(x + 4.5, y + 3.5); ctx.lineTo(x - 4.5, y + 3.5); ctx.closePath();
      ctx.fillStyle = hit ? '#facc15' : '#0f172a'; ctx.fill();
      ctx.strokeStyle = hit ? '#fde68a' : '#94a3b8'; ctx.lineWidth = 1; ctx.stroke();
    }

    // 我的位置
    if (st.home) {
      const [x, y] = P(st.home.lon, st.home.lat);
      ctx.fillStyle = '#5eead4'; ctx.beginPath(); ctx.arc(x, y, 6, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#04121a'; ctx.lineWidth = 2; ctx.stroke();
      ctx.fillStyle = '#5eead4'; ctx.font = 'bold 12px "Microsoft JhengHei"'; ctx.fillText('我', x + 9, y + 4);
    }

    // 推算的震央（星號，脈動）
    const so = st.solution;
    if (so) {
      const [x, y] = P(so.lon, so.lat);
      const pulse = 10 + 6 * Math.abs(Math.sin(st.now / 250));
      ctx.beginPath(); ctx.arc(x, y, pulse, 0, Math.PI * 2); ctx.fillStyle = 'rgba(244,63,94,.25)'; ctx.fill();
      star(ctx, x, y, 9, 4, '#f43f5e');
    }

    // 縣市名稱（小字）
    ctx.fillStyle = 'rgba(226,232,240,.55)'; ctx.font = '10px "Microsoft JhengHei"';
    const skip = new Set(['新北市', '新竹縣', '嘉義縣', '基隆市']); // 太擠的不標
    for (const c of COUNTIES) { if (skip.has(c.name)) continue; const [x, y] = P(c.lon, c.lat); ctx.fillText(c.name.slice(0, 2), x + 6, y - 6); }
  }
}

function star(ctx, x, y, R, r, color) {
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5, rr = i % 2 ? r : R;
    ctx.lineTo(x + rr * Math.cos(a), y + rr * Math.sin(a));
  }
  ctx.closePath(); ctx.fillStyle = color; ctx.fill(); ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke();
}
