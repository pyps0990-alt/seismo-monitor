// 台灣地理資料：鄉鎮界（data/towns.json）、縣市代表點、虛擬測站、距離與方位

// 縣市（以縣市政府位置為代表點；震央描述採中央氣象署格式「XX政府 東南方 N 公里」）
export const COUNTIES = [
  { name: '基隆市', lon: 121.742, lat: 25.128 },
  { name: '臺北市', lon: 121.564, lat: 25.037 },
  { name: '新北市', lon: 121.465, lat: 25.012 },
  { name: '桃園市', lon: 121.301, lat: 24.993 },
  { name: '新竹市', lon: 120.969, lat: 24.807 },
  { name: '新竹縣', lon: 121.004, lat: 24.827 },
  { name: '苗栗縣', lon: 120.821, lat: 24.565 },
  { name: '臺中市', lon: 120.647, lat: 24.162 },
  { name: '彰化縣', lon: 120.542, lat: 24.076 },
  { name: '南投縣', lon: 120.684, lat: 23.903 },
  { name: '雲林縣', lon: 120.527, lat: 23.696 },
  { name: '嘉義市', lon: 120.453, lat: 23.481 },
  { name: '嘉義縣', lon: 120.296, lat: 23.459 },
  { name: '臺南市', lon: 120.317, lat: 23.150 },
  { name: '高雄市', lon: 120.312, lat: 22.621 },
  { name: '屏東縣', lon: 120.488, lat: 22.683 },
  { name: '宜蘭縣', lon: 121.753, lat: 24.730 },
  { name: '花蓮縣', lon: 121.602, lat: 23.992 },
  { name: '臺東縣', lon: 121.147, lat: 22.756 },
  { name: '澎湖縣', lon: 119.566, lat: 23.570 },
];

// 海底地震儀（參考東部海域海纜觀測系統的分布，位置為示意）
const OBS = [
  ['宜蘭海纜1', 121.98, 24.82], ['宜蘭海纜2', 122.10, 24.72], ['宜蘭海纜3', 122.25, 24.60], ['宜蘭海纜4', 122.42, 24.48],
  ['和平外海', 121.95, 24.25], ['花蓮外海1', 121.85, 23.95], ['花蓮外海2', 122.10, 23.85], ['花蓮外海3', 121.80, 23.55],
  ['成功外海', 121.62, 23.10], ['臺東外海', 121.40, 22.70], ['蘭嶼北', 121.75, 22.35], ['恆春外海', 120.95, 21.90],
  ['小琉球外海', 120.30, 22.20], ['龜山島外海', 122.10, 25.00], ['北部外海', 121.80, 25.35],
];

// 虛擬地震測站網：陸上站由鄉鎮中心點挑選（間距 ≥ 7 km，約每 7～10 km 一站）＋海底站
export let STATIONS = [];
function buildStations() {
  const land = [];
  const towns = [...TOWNS].sort((a, b) => a.area - b.area); // 小鄉鎮（人口密集區）優先
  for (const t of towns) {
    const [lon, lat] = t.c;
    if (land.every(s => distKm(lon, lat, s.lon, s.lat) >= 7)) land.push({ name: `${t.county.slice(0, 2)}${t.name}`, lon, lat, type: 'land' });
  }
  STATIONS = [...land, ...OBS.map(([name, lon, lat]) => ({ name, lon, lat, type: 'obs' }))];
}

export const BOUNDS = { lonMin: 119.25, lonMax: 122.6, latMin: 21.75, latMax: 25.5 };
const LAT0 = 23.7, KX = 111.32 * Math.cos(LAT0 * Math.PI / 180), KY = 110.57;

// 平面近似距離（公里），台灣尺度誤差 < 1%
export function distKm(lon1, lat1, lon2, lat2) {
  return Math.hypot((lon1 - lon2) * KX, (lat1 - lat2) * KY);
}
// 點到折線距離（公里）
export function distToLineKm(lon, lat, line) {
  let best = Infinity;
  for (let i = 0; i < line.length - 1; i++) {
    const [ax, ay] = [line[i][0] * KX, line[i][1] * KY], [bx, by] = [line[i + 1][0] * KX, line[i + 1][1] * KY];
    const px = lon * KX, py = lat * KY, dx = bx - ax, dy = by - ay;
    const u = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
    best = Math.min(best, Math.hypot(ax + u * dx - px, ay + u * dy - py));
  }
  return best;
}

const DIRS = ['北', '東北', '東', '東南', '南', '西南', '西', '西北'];
export function bearingName(fromLon, fromLat, toLon, toLat) {
  const ang = Math.atan2((toLon - fromLon) * KX, (toLat - fromLat) * KY) * 180 / Math.PI;
  return DIRS[Math.round(((ang + 360) % 360) / 45) % 8];
}

// ring 為扁平陣列 [lon0, lat0, lon1, lat1, ...]
export function pointInRing(lon, lat, r) {
  let inside = false;
  for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
    const xi = r[i], yi = r[i + 1], xj = r[j], yj = r[j + 1];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// ---- 鄉鎮資料 ----
export let TOWNS = [];      // [{id, county, name, c:[lon,lat], area, rings, bbox, vs30, ampA, ampV}]
export let COUNTY_LINES = [], COAST = [];
export async function loadTowns(url = 'data/towns.json') {
  const d = await (await fetch(url)).json();
  TOWNS = d.towns.map(t => {
    let x0 = 999, y0 = 999, x1 = -999, y1 = -999;
    for (const r of t.rings) for (let i = 0; i < r.length; i += 2) { x0 = Math.min(x0, r[i]); x1 = Math.max(x1, r[i]); y0 = Math.min(y0, r[i + 1]); y1 = Math.max(y1, r[i + 1]); }
    return { ...t, bbox: [x0, y0, x1, y1] };
  });
  COUNTY_LINES = d.countyLines; COAST = d.coast;
  buildStations();
  return TOWNS;
}
export function townAt(lon, lat) {
  return TOWNS.find(t => lon >= t.bbox[0] && lon <= t.bbox[2] && lat >= t.bbox[1] && lat <= t.bbox[3]
    && t.rings.some(r => pointInRing(lon, lat, r))) || null;
}

// 中央氣象署格式的震央描述
export function describeEpicenter(lon, lat) {
  let best = null;
  for (const c of COUNTIES) {
    const d = distKm(lon, lat, c.lon, c.lat);
    if (!best || d < best.d) best = { c, d };
  }
  const t = townAt(lon, lat);
  const where = t ? `位於${t.county}${t.name}` : `位於${best.c.name}${lon > 121 ? '近海' : '外海'}`;
  return { text: `${best.c.name}政府${bearingName(best.c.lon, best.c.lat, lon, lat)}方 ${best.d.toFixed(1)} 公里`, where };
}
