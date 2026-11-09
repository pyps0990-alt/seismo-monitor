// 台灣地理資料（簡化）：海岸線、縣市（以縣市政府位置代表）、虛擬測站、區塊網格

// 簡化的台灣本島海岸線 [經度, 緯度]，順時針
export const OUTLINE = [
  [121.54, 25.30], [121.66, 25.20], [121.80, 25.13], [122.00, 25.01], [121.86, 24.86],
  [121.83, 24.70], [121.87, 24.58], [121.73, 24.30], [121.62, 24.00], [121.55, 23.70],
  [121.48, 23.42], [121.38, 23.10], [121.20, 22.82], [121.02, 22.62], [120.90, 22.35],
  [120.88, 22.10], [120.84, 21.90], [120.72, 21.94], [120.68, 22.12], [120.60, 22.36],
  [120.43, 22.50], [120.27, 22.62], [120.17, 22.85], [120.08, 23.03], [120.07, 23.18],
  [120.13, 23.40], [120.15, 23.62], [120.22, 23.85], [120.33, 24.08], [120.50, 24.28],
  [120.65, 24.47], [120.80, 24.66], [120.92, 24.83], [121.03, 24.98], [121.18, 25.08],
  [121.38, 25.17], [121.54, 25.30],
];

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

// 虛擬地震測站網（縣市政府＋偏遠地區補點）
export const STATIONS = [
  ...COUNTIES.map(c => ({ ...c, code: c.name.slice(0, 2) })),
  { name: '恆春', code: '恆春', lon: 120.745, lat: 22.004 },
  { name: '成功', code: '成功', lon: 121.373, lat: 23.098 },
  { name: '玉里', code: '玉里', lon: 121.312, lat: 23.333 },
  { name: '阿里山', code: '阿里', lon: 120.813, lat: 23.508 },
  { name: '合歡山', code: '合歡', lon: 121.275, lat: 24.140 },
  { name: '蘇澳', code: '蘇澳', lon: 121.857, lat: 24.596 },
  { name: '綠島', code: '綠島', lon: 121.490, lat: 22.660 },
  { name: '蘭嶼', code: '蘭嶼', lon: 121.548, lat: 22.040 },
  { name: '彭佳嶼', code: '彭佳', lon: 122.080, lat: 25.630 },
  { name: '南澳', code: '南澳', lon: 121.800, lat: 24.462 },
  { name: '和平', code: '和平', lon: 121.752, lat: 24.300 },
  { name: '天祥', code: '天祥', lon: 121.494, lat: 24.180 },
  { name: '光復', code: '光復', lon: 121.423, lat: 23.668 },
  { name: '大武', code: '大武', lon: 120.890, lat: 22.360 },
  { name: '梨山', code: '梨山', lon: 121.250, lat: 24.250 },
];

export const BOUNDS = { lonMin: 119.2, lonMax: 122.4, latMin: 21.6, latMax: 25.8 };
const LAT0 = 23.7, KX = 111.32 * Math.cos(LAT0 * Math.PI / 180), KY = 110.57;

// 平面近似距離（公里），台灣尺度誤差 < 1%
export function distKm(lon1, lat1, lon2, lat2) {
  return Math.hypot((lon1 - lon2) * KX, (lat1 - lat2) * KY);
}

const DIRS = ['北', '東北', '東', '東南', '南', '西南', '西', '西北'];
export function bearingName(fromLon, fromLat, toLon, toLat) {
  const ang = Math.atan2((toLon - fromLon) * KX, (toLat - fromLat) * KY) * 180 / Math.PI;
  return DIRS[Math.round(((ang + 360) % 360) / 45) % 8];
}

export function pointInPolygon(lon, lat, poly = OUTLINE) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// 中央氣象署格式的震央描述
export function describeEpicenter(lon, lat) {
  let best = null;
  for (const c of COUNTIES) {
    const d = distKm(lon, lat, c.lon, c.lat);
    if (!best || d < best.d) best = { c, d };
  }
  const where = pointInPolygon(lon, lat) ? `位於${best.c.name}` : `位於${best.c.name}${lon > 121 ? '近海' : '外海'}`;
  return `${best.c.name}政府${bearingName(best.c.lon, best.c.lat, lon, lat)}方 ${best.d.toFixed(1)} 公里（${where}）`;
}

// 區塊網格：0.1° × 0.1°，只保留中心點在本島內的格子；澎湖另外加幾格
export const BLOCK = 0.1;
export const BLOCKS = (() => {
  const out = [];
  for (let lat = 21.85; lat < 25.35; lat += BLOCK) {
    for (let lon = 120.0; lon < 122.05; lon += BLOCK) {
      if (pointInPolygon(lon, lat)) out.push({ lon: +lon.toFixed(2), lat: +lat.toFixed(2) });
    }
  }
  for (const [lon, lat] of [[119.55, 23.55], [119.65, 23.55], [119.55, 23.65], [119.65, 23.45]]) out.push({ lon, lat });
  return out;
})();
