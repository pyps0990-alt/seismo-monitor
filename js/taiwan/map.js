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
    this.view = { z: 1, tx: 0, ty: 0 };   // 縮放倍率與平移（螢幕像素）
    const local = e => { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };

    // 滾輪縮放（以游標為中心）
    // 使用者自己縮放／拖曳時，停止自動追蹤（按 ⟲ 重設後恢復）
    canvas.addEventListener('wheel', e => { e.preventDefault(); this.stopFly(); this.userMoved = true; const [x, y] = local(e); this.zoomAt(x, y, e.deltaY < 0 ? 1.25 : 0.8); }, { passive: false });
    // 拖曳平移；移動很少則視為點擊
    let drag = null;
    canvas.addEventListener('pointerdown', e => { drag = { x: e.clientX, y: e.clientY, tx: this.view.tx, ty: this.view.ty, moved: false }; canvas.setPointerCapture(e.pointerId); });
    canvas.addEventListener('pointermove', e => {
      if (drag) {
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
        if (Math.hypot(dx, dy) > 4) drag.moved = true;
        if (drag.moved) { this.stopFly(); this.userMoved = true; this.view.tx = drag.tx + dx; this.view.ty = drag.ty + dy; canvas.style.cursor = 'grabbing'; onHover?.(null); return; }
      }
      onHover?.(this.toLonLat(e), e);
    });
    canvas.addEventListener('pointerup', e => { if (drag && !drag.moved) onClick?.(this.toLonLat(e)); drag = null; canvas.style.cursor = ''; });
    canvas.addEventListener('pointerleave', () => onHover?.(null));
    canvas.addEventListener('dblclick', e => { const [x, y] = local(e); this.zoomAt(x, y, 2); });
  }

  // 平滑飛到指定經緯度（置中）與倍率；動畫在每次 draw 時推進
  flyTo(lon, lat, z) { this.target = { lon, lat, z }; }
  stopFly() { this.target = null; }
  stepFly(w, h) {
    const t = this.target; if (!t || !this.base) return;
    const [bx, by] = this.base(t.lon, t.lat);
    const v = this.view, k = 0.12;
    const tz = t.z, ttx = w / 2 - bx * tz, tty = h / 2 - by * tz;
    v.z += (tz - v.z) * k; v.tx += (ttx - v.tx) * k; v.ty += (tty - v.ty) * k;
    if (Math.abs(tz - v.z) < 0.005 && Math.abs(ttx - v.tx) < 0.5 && Math.abs(tty - v.ty) < 0.5) { v.z = tz; v.tx = ttx; v.ty = tty; this.target = null; }
  }

  zoomAt(x, y, f) {
    const v = this.view, z = Math.min(16, Math.max(1, v.z * f)), k = z / v.z;
    v.tx = x - (x - v.tx) * k; v.ty = y - (y - v.ty) * k; v.z = z;
    if (z === 1) { v.tx = 0; v.ty = 0; }
  }
  zoomBy(f) { this.stopFly(); this.userMoved = true; this.zoomAt(this.canvas.clientWidth / 2, this.canvas.clientHeight / 2, f); }
  reset() { this.target = null; this.userMoved = false; this.view = { z: 1, tx: 0, ty: 0 }; }

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
      // base：未縮放的投影座標；Path2D 只在尺寸改變時建立一次，縮放平移用 canvas transform
      this.base = (lon, lat) => [ox + (lon - BOUNDS.lonMin) * KX * s, oy + (BOUNDS.latMax - lat) * s];
      this.baseInv = (x, y) => ({ lon: (x - ox) / (KX * s) + BOUNDS.lonMin, lat: BOUNDS.latMax - (y - oy) / s });
      this.baseKmPx = s / 110.57;
      const path = flat => { const p = new Path2D(); for (let i = 0; i < flat.length; i += 2) { const [x, y] = this.base(flat[i], flat[i + 1]); i ? p.lineTo(x, y) : p.moveTo(x, y); } return p; };
      this.townPaths = TOWNS.map(t => { const p = new Path2D(); t.rings.forEach(r => { p.addPath(path(r)); }); return p; });
      this.townBorders = new Path2D(); this.townPaths.forEach(p => this.townBorders.addPath(p)); // 一次畫完所有鄉鎮界
      this.countyPath = new Path2D(); COUNTY_LINES.forEach(l => this.countyPath.addPath(path(l)));
      this.coastPath = new Path2D(); COAST.forEach(l => this.coastPath.addPath(path(l)));
    }
    this.stepFly(w, h);
    const v = this.view;
    this.px = (lon, lat) => { const [x, y] = this.base(lon, lat); return [x * v.z + v.tx, y * v.z + v.ty]; };
    this.inv = (x, y) => this.baseInv((x - v.tx) / v.z, (y - v.ty) / v.z);
    this.kmPx = this.baseKmPx * v.z;
    this.dpr = dpr;
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

    // 鄉鎮區塊（套用縮放平移 transform；線寬除以倍率保持粗細）
    const v = this.view, z = v.z;
    ctx.save();
    ctx.setTransform(this.dpr * z, 0, 0, this.dpr * z, this.dpr * v.tx, this.dpr * v.ty);
    TOWNS.forEach((t, i) => {
      let fill = '#1f2733';
      if (st.mode === 'site') fill = vs30Color(t.vs30);
      else { const n = st.townInts?.[i]; if (n && n !== '0') fill = INTENSITY_COLORS[n]; }
      ctx.fillStyle = fill; ctx.fill(this.townPaths[i]);
    });
    ctx.strokeStyle = 'rgba(10,12,16,.55)'; ctx.lineWidth = 0.5 / z;
    ctx.stroke(this.townBorders);
    ctx.strokeStyle = 'rgba(226,232,240,.55)'; ctx.lineWidth = 1.1 / z; ctx.stroke(this.countyPath);
    ctx.strokeStyle = 'rgba(226,232,240,.75)'; ctx.lineWidth = 1.2 / z; ctx.stroke(this.coastPath);
    if (st.homeTown != null) { ctx.strokeStyle = '#2dd4bf'; ctx.lineWidth = 2.2 / z; ctx.stroke(this.townPaths[st.homeTown]); }
    if (st.hoverTown != null) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.8 / z; ctx.stroke(this.townPaths[st.hoverTown]); }
    ctx.restore();

    // 放大到 3 倍以上時標示鄉鎮名稱
    if (z >= 3) {
      ctx.fillStyle = 'rgba(255,255,255,.75)'; ctx.font = `${Math.min(13, 6 + z)}px "Noto Sans TC"`; ctx.textAlign = 'center';
      for (const t of TOWNS) { const [x, y] = P(t.c[0], t.c[1]); if (x > 0 && x < w && y > 0 && y < h) ctx.fillText(t.name, x, y + 14); }
      ctx.textAlign = 'left';
    }

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

    // 區域警示：固定 5 km × 5 km 正方形，持續閃爍（約每 0.8 秒一次）。
    // 範圍通知階段為黃色；正式速報後依保守估計震度著色
    const rg = st.region;
    if (rg) {
      const on = (Math.sin(st.now / 130) + 1) / 2;              // 0～1 循環
      const fillA = rg.prelim ? 0.15 + 0.5 * on : 0.08 + 0.35 * on;
      const lineA = 0.35 + 0.65 * on;
      for (const c of rg.blocks) {
        const [ax, ay] = P(c.lon - c.hx, c.lat + c.hy), [bx, by] = P(c.lon + c.hx, c.lat - c.hy);
        const w = bx - ax, hgt = by - ay, g = Math.min(1, w * 0.06);   // 格間留一點縫，看得出一格一格
        const col = rg.prelim ? '#facc15' : INTENSITY_COLORS[c.n];
        ctx.fillStyle = col;
        ctx.globalAlpha = fillA; ctx.fillRect(ax + g, ay + g, w - 2 * g, hgt - 2 * g);
        ctx.globalAlpha = lineA; ctx.strokeStyle = col; ctx.lineWidth = 1; ctx.strokeRect(ax + g, ay + g, w - 2 * g, hgt - 2 * g);
      }
      ctx.globalAlpha = 1;
    }

    // 真實地震回放結束後：畫出當時的實測測站（顏色＝實測震度）
    if (st.realStations) {
      for (const s of st.realStations) {
        const [x, y] = P(s.lon, s.lat);
        if (x < -5 || y < -5 || x > w + 5 || y > h + 5) continue;
        ctx.beginPath(); ctx.arc(x, y, 3.2, 0, Math.PI * 2);
        ctx.fillStyle = INTENSITY_COLORS[s.obs] ?? '#e5e7eb'; ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,.7)'; ctx.lineWidth = 0.8; ctx.stroke();
      }
    }

    // 待發生的自訂震央（十字準星）
    if (st.pickPoint) {
      const [x, y] = P(st.pickPoint.lon, st.pickPoint.lat);
      ctx.strokeStyle = '#facc15'; ctx.lineWidth = 1.5; ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.arc(x, y, 12, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
      ctx.beginPath(); ctx.moveTo(x - 18, y); ctx.lineTo(x + 18, y); ctx.moveTo(x, y - 18); ctx.lineTo(x, y + 18); ctx.stroke();
    }

    // 測站：▲ 陸上站、◆ 海底站；實測到震度後陸上站顯示級數（5 弱→5-、5 強→5+…）；被排除的誤觸發畫 ✕
    const sz = Math.min(1.8, 0.8 + z * 0.2);
    for (const s of STATIONS) {
      const [x, y] = P(s.lon, s.lat);
      if (x < -10 || y < -10 || x > w + 10 || y > h + 10) continue;
      const obs = st.stationInts?.get(s.name);
      if (st.rejected?.has(s.name)) {
        ctx.strokeStyle = '#9ca3af'; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(x - 4, y - 4); ctx.lineTo(x + 4, y + 4); ctx.moveTo(x + 4, y - 4); ctx.lineTo(x - 4, y + 4); ctx.stroke();
        continue;
      }
      if (obs && obs !== '0' && s.type === 'land') {
        const label = shortInt(obs), bw = (label.length > 1 ? 15 : 11) * sz, bh = 11 * sz;
        ctx.fillStyle = INTENSITY_COLORS[obs]; ctx.strokeStyle = 'rgba(0,0,0,.6)'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.roundRect(x - bw / 2, y - bh / 2, bw, bh, 3); ctx.fill(); ctx.stroke();
        ctx.fillStyle = '#0b0e13'; ctx.font = `bold ${Math.round(9 * sz)}px "JetBrains Mono", monospace`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(label, x, y + 0.5); ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
        continue;
      }
      const hit = st.picked?.has(s.name), r = 3.6 * sz;
      ctx.beginPath();
      if (s.type === 'obs') { ctx.moveTo(x, y - r - 1); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r + 1); ctx.lineTo(x - r, y); }
      else { ctx.moveTo(x, y - r); ctx.lineTo(x + r, y + r * 0.75); ctx.lineTo(x - r, y + r * 0.75); }
      ctx.closePath();
      ctx.fillStyle = obs ? INTENSITY_COLORS[obs] : hit ? '#facc15' : s.type === 'obs' ? '#0c2a4a' : '#0b0e13'; ctx.fill();
      ctx.strokeStyle = s.type === 'obs' ? '#60a5fa' : hit ? '#fff' : '#6b7280'; ctx.lineWidth = 1; ctx.stroke();
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

// 測站顯示用：5弱→5-、5強→5+、6弱→6-、6強→6+
export const shortInt = n => n.replace('弱', '-').replace('強', '+');

function star(ctx, x, y, R, r, color) {
  ctx.beginPath();
  for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + (i * Math.PI) / 5, rr = i % 2 ? r : R; ctx.lineTo(x + rr * Math.cos(a), y + rr * Math.sin(a)); }
  ctx.closePath(); ctx.fillStyle = color; ctx.fill(); ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke();
}
