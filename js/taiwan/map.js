// 台灣地圖：鄉鎮區塊（依預估震度或地盤分類上色）、縣市界、P/S 波、測站、震央
import { TOWNS, COUNTY_LINES, COAST, BOUNDS, STATIONS } from './geo.js';
import { INTENSITY_COLORS } from '../detector.js';
import { VP, VS } from './eew.js';

const KX = Math.cos(23.7 * Math.PI / 180);
const VS30_COLORS = [[200, '#b45309'], [260, '#d97706'], [330, '#ca8a04'], [450, '#65a30d'], [600, '#0d9488'], [Infinity, '#0e7490']];
export const vs30Color = v => VS30_COLORS.find(([lim]) => v < lim)[1];

export class TaiwanMap {
  constructor(canvas, { onClick, onHover } = {}) {
    this.canvas = canvas; this.key = '';
    this.hover = null;
    canvas.addEventListener('mousemove', e => { const p = this.toLonLat(e); this.hoverPt = p; onHover?.(p, e); });
    canvas.addEventListener('mouseleave', () => { this.hoverPt = null; onHover?.(null); });
    canvas.addEventListener('click', e => onClick?.(this.toLonLat(e)));
  }

  toLonLat(e) {
    const r = this.canvas.getBoundingClientRect();
    return this.inv ? this.inv(e.clientX - r.left, e.clientY - r.top) : null;
  }

  setup() {
    const c = this.canvas, dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth, h = c.clientHeight;
    if (!w || !h) return null; // 分頁隱藏中
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
    const ctx = c.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const key = `${w}x${h}x${TOWNS.length}`;
    if (key !== this.key) { // 尺寸改變才重算投影與路徑
      this.key = key;
      const spanX = (BOUNDS.lonMax - BOUNDS.lonMin) * KX, spanY = BOUNDS.latMax - BOUNDS.latMin;
      const s = Math.min(w / spanX, h / spanY);
      const ox = (w - spanX * s) / 2, oy = (h - spanY * s) / 2;
      this.px = (lon, lat) => [ox + (lon - BOUNDS.lonMin) * KX * s, oy + (BOUNDS.latMax - lat) * s];
      this.inv = (x, y) => ({ lon: (x - ox) / (KX * s) + BOUNDS.lonMin, lat: BOUNDS.latMax - (y - oy) / s });
      this.kmPx = s / 110.57;
      const path = flat => { const p = new Path2D(); for (let i = 0; i < flat.length; i += 2) { const [x, y] = this.px(flat[i], flat[i + 1]); i ? p.lineTo(x, y) : p.moveTo(x, y); } return p; };
      this.townPaths = TOWNS.map(t => { const p = new Path2D(); t.rings.forEach(r => { p.addPath(path(r)); }); return p; });
      this.countyPath = new Path2D(); COUNTY_LINES.forEach(l => this.countyPath.addPath(path(l)));
      this.coastPath = new Path2D(); COAST.forEach(l => this.coastPath.addPath(path(l)));
    }
    return { ctx, w, h };
  }

  // st = { mode:'intensity'|'site', townInts, scenario, now, solution, picked:Set, home, homeTown, reveal, hoverTown, pickPoint }
  draw(st) {
    const s = this.setup(); if (!s) return;
    const { ctx, w, h } = s;
    ctx.clearRect(0, 0, w, h);
    const P = this.px;

    // 經緯網格
    ctx.strokeStyle = 'rgba(148,163,184,.06)'; ctx.lineWidth = 1;
    ctx.fillStyle = '#4b5563'; ctx.font = '10px "Noto Sans TC", sans-serif';
    for (let lon = 120; lon <= 122; lon++) { const [x] = P(lon, 0); ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); ctx.fillText(`${lon}°E`, x + 3, h - 6); }
    for (let lat = 22; lat <= 25; lat++) { const [, y] = P(0, lat); ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); ctx.fillText(`${lat}°N`, 4, y - 3); }

    // 鄉鎮區塊
    TOWNS.forEach((t, i) => {
      let fill = '#1f2733';
      if (st.mode === 'site') fill = vs30Color(t.vs30);
      else { const n = st.townInts?.[i]; if (n && n !== '0') fill = INTENSITY_COLORS[n]; }
      ctx.fillStyle = fill; ctx.fill(this.townPaths[i]);
    });
    ctx.strokeStyle = 'rgba(10,12,16,.55)'; ctx.lineWidth = 0.5;
    this.townPaths.forEach(p => ctx.stroke(p));
    ctx.strokeStyle = 'rgba(226,232,240,.55)'; ctx.lineWidth = 1.1; ctx.stroke(this.countyPath);
    ctx.strokeStyle = 'rgba(226,232,240,.75)'; ctx.lineWidth = 1.2; ctx.stroke(this.coastPath);

    // 我的鄉鎮、滑鼠所在鄉鎮
    if (st.homeTown != null) { ctx.strokeStyle = '#2dd4bf'; ctx.lineWidth = 2.2; ctx.stroke(this.townPaths[st.homeTown]); }
    if (st.hoverTown != null) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.8; ctx.stroke(this.townPaths[st.hoverTown]); }

    // P / S 波：實線＋半透明填色。圓心＝目前推算的震央與發震時間；
    // 每次新一報改變震央，圓心就跟著移動（第一報之前不畫）
    const sc = st.scenario;
    const so0 = st.solution;
    if (so0) {
      const el = (st.now - so0.t0) / 1000;
      const [ex, ey] = P(so0.lon, so0.lat);
      const ring = (v, stroke, fill) => {
        const r2 = (v * el) ** 2 - so0.depth ** 2;
        if (r2 <= 0) return;
        const r = Math.sqrt(r2) * this.kmPx;
        if (r > w * 2.5) return;
        ctx.beginPath(); ctx.arc(ex, ey, r, 0, Math.PI * 2);
        ctx.fillStyle = fill; ctx.fill();
        ctx.strokeStyle = stroke; ctx.lineWidth = 2; ctx.stroke();
      };
      ring(VP, 'rgba(250,204,21,.95)', 'rgba(250,204,21,.10)');
      ring(VS, 'rgba(239,68,68,.95)', 'rgba(239,68,68,.16)');
    }
    if (sc && st.reveal) {
      const [ex, ey] = P(sc.q.lon, sc.q.lat);
      {
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(ex - 7, ey - 7); ctx.lineTo(ex + 7, ey + 7); ctx.moveTo(ex + 7, ey - 7); ctx.lineTo(ex - 7, ey + 7); ctx.stroke();
        ctx.fillStyle = '#fff'; ctx.font = '11px "Noto Sans TC"'; ctx.fillText('真實震央', ex + 10, ey + 4);
      }
    }

    // 待發生的自訂震央（十字準星）
    if (st.pickPoint) {
      const [x, y] = P(st.pickPoint.lon, st.pickPoint.lat);
      ctx.strokeStyle = '#facc15'; ctx.lineWidth = 1.5; ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.arc(x, y, 12, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
      ctx.beginPath(); ctx.moveTo(x - 18, y); ctx.lineTo(x + 18, y); ctx.moveTo(x, y - 18); ctx.lineTo(x, y + 18); ctx.stroke();
    }

    // 測站（觸發後依觀測震度上色）
    for (const s of STATIONS) {
      const [x, y] = P(s.lon, s.lat);
      const obs = st.stationInts?.get(s.name);
      ctx.beginPath(); ctx.moveTo(x, y - 5); ctx.lineTo(x + 4.5, y + 3.5); ctx.lineTo(x - 4.5, y + 3.5); ctx.closePath();
      ctx.fillStyle = obs ? (INTENSITY_COLORS[obs] ?? '#e5e7eb') : '#0b0e13'; ctx.fill();
      ctx.strokeStyle = obs ? '#fff' : '#94a3b8'; ctx.lineWidth = 1; ctx.stroke();
    }

    // 我的位置
    if (st.home) {
      const [x, y] = P(st.home.lon, st.home.lat);
      ctx.fillStyle = '#2dd4bf'; ctx.beginPath(); ctx.arc(x, y, 5.5, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#0a0c10'; ctx.lineWidth = 2; ctx.stroke();
    }

    // 推算的震央
    const so = st.solution;
    if (so) {
      const [x, y] = P(so.lon, so.lat);
      const pulse = 10 + 6 * Math.abs(Math.sin(st.now / 300));
      ctx.beginPath(); ctx.arc(x, y, pulse, 0, Math.PI * 2); ctx.fillStyle = 'rgba(239,68,68,.25)'; ctx.fill();
      star(ctx, x, y, 9, 4, '#ef4444');
    }
  }
}

function star(ctx, x, y, R, r, color) {
  ctx.beginPath();
  for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + (i * Math.PI) / 5, rr = i % 2 ? r : R; ctx.lineTo(x + rr * Math.cos(a), y + rr * Math.sin(a)); }
  ctx.closePath(); ctx.fillStyle = color; ctx.fill(); ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke();
}
