// 把 taiwan-atlas 的 towns TopoJSON 轉成精簡格式（不需在網頁端載入 topojson 函式庫）
// 用法：node convert.js <towns.json> <out.json>
const fs = require('fs');
const topo = require('topojson-client');
const [, , src, out] = process.argv;
const t = JSON.parse(fs.readFileSync(src, 'utf8'));

const EXCLUDE = new Set(['金門縣', '連江縣']);  // 太遠，不在地圖範圍內
const TOL = 0.0015;                              // 簡化容許誤差（度，約 150 m）

function dp(pts, tol) { // Douglas–Peucker
  if (pts.length < 4) return pts;
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = pts[a], [bx, by] = pts[b];
    let md = 0, mi = -1;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = pts[i];
      const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
      const u = L ? ((px - ax) * dx + (py - ay) * dy) / L : 0;
      const qx = ax + u * dx - px, qy = ay + u * dy - py;
      const d = Math.sqrt(qx * qx + qy * qy);
      if (d > md) { md = d; mi = i; }
    }
    if (md > tol) { keep[mi] = 1; stack.push([a, mi], [mi, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}
const r3 = v => Math.round(v * 1000) / 1000;
const ringArea = r => { let s = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) s += (r[j][0] + r[i][0]) * (r[j][1] - r[i][1]); return Math.abs(s / 2); };
const ringCentroid = r => {
  let a = 0, x = 0, y = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const f = r[j][0] * r[i][1] - r[i][0] * r[j][1];
    a += f; x += (r[j][0] + r[i][0]) * f; y += (r[j][1] + r[i][1]) * f;
  }
  return [x / (3 * a), y / (3 * a)];
};
const simplifyLine = line => dp(line, TOL).map(([x, y]) => [r3(x), r3(y)]);

const towns = topo.feature(t, t.objects.towns).features
  .filter(f => !EXCLUDE.has(f.properties.COUNTYNAME))
  .map(f => {
    const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
    const rings = [];
    let big = null, area = 0;
    for (const poly of polys) {
      const outer = poly[0];
      const a = ringArea(outer); area += a;
      if (!big || a > big.a) big = { a, r: outer };
      const s = simplifyLine(outer);
      if (s.length >= 4 || a > 1e-5) rings.push(s.length >= 4 ? s : outer.map(([x, y]) => [r3(x), r3(y)]));
    }
    const [cx, cy] = ringCentroid(big.r);
    return {
      id: f.properties.TOWNCODE,
      county: f.properties.COUNTYNAME.replace('台', '臺'),
      name: f.properties.TOWNNAME.replace('台', '臺'),
      c: [r3(cx), r3(cy)],
      area: Math.round(area * 1e4) / 1e4,
      rings: rings.map(r => r.flat()),
    };
  });

// 縣市界（相鄰縣市共用的邊）與海岸線
const countyFilter = (a, b) => a !== b && !EXCLUDE.has(a.properties.COUNTYNAME) && !EXCLUDE.has(b.properties.COUNTYNAME);
const countyLines = topo.mesh(t, t.objects.counties, countyFilter).coordinates.map(l => simplifyLine(l).flat());
const coast = topo.mesh(t, t.objects.counties, (a, b) => a === b && !EXCLUDE.has(a.properties.COUNTYNAME)).coordinates.map(l => simplifyLine(l).flat());

const data = {
  source: 'taiwan-atlas 2021.9.20 (MIT, Daniel Kao)；原始資料：內政部國土測繪中心 鄉鎮市區界線（政府資料開放授權）',
  towns, countyLines, coast,
};
fs.writeFileSync(out, JSON.stringify(data));
const pts = towns.reduce((s, t) => s + t.rings.reduce((a, r) => a + r.length / 2, 0), 0);
console.log(`towns ${towns.length}, points ${pts}, size ${(fs.statSync(out).size / 1024).toFixed(0)} KB`);
