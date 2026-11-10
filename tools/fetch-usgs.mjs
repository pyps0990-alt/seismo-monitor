// 從 USGS 下載台灣地區地震的 ShakeMap 測站實測資料，整理成訓練資料集
// 用法：node tools/fetch-usgs.mjs [最小規模=5.0] [起始年=2000]
// 輸出：data/usgs/records.json  每筆 = 一個地震 × 一個測站
//   { ev, M, depth, eLon, eLat, sLon, sLat, code, pga(gal), pgv(cm/s), rhypo(km) }
import fs from 'node:fs';
import path from 'node:path';

// 加上 --deep：擴大到台灣周邊（含宜蘭外海、與那國島附近的隱沒帶）且只抓深度 ≥ 50 km 的地震
// 結果會「合併」到既有的 records.json（同一地震同一測站不重複）
const MINMAG = process.argv[2] || '5.0';
const START = `${process.argv[3] || 2000}-01-01`;
const DEEP = process.argv.includes('--deep');
const BOX = DEEP ? 'minlatitude=20.5&maxlatitude=27&minlongitude=118.5&maxlongitude=124.5&mindepth=50'
                 : 'minlatitude=21&maxlatitude=26.5&minlongitude=119&maxlongitude=123';
const OUT = 'data/usgs';
const CACHE = path.join(OUT, 'cache');
fs.mkdirSync(CACHE, { recursive: true });

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function getJSON(url, cacheName) {
  const f = cacheName && path.join(CACHE, cacheName);
  if (f && fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
  for (let i = 0; i < 3; i++) {
    const r = await fetch(url, { headers: { 'User-Agent': 'seismo-monitor-student-project' } });
    if (r.ok) { const j = await r.json(); if (f) fs.writeFileSync(f, JSON.stringify(j)); await sleep(300); return j; }
    await sleep(2000);
  }
  throw new Error('下載失敗 ' + url);
}

const KX = 111.32 * Math.cos(23.7 * Math.PI / 180), KY = 110.57;
const dist = (a, b, c, d) => Math.hypot((a - c) * KX, (b - d) * KY);

const q = `https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&${BOX}&minmagnitude=${MINMAG}&starttime=${START}&orderby=time-asc`;
const cat = await getJSON(q);
const events = cat.features.filter(f => (f.properties.types || '').includes(',shakemap,'));
console.log(`目錄 ${cat.features.length} 個地震，其中 ${events.length} 個有 ShakeMap`);

const records = [], summary = [];
for (const [i, ev] of events.entries()) {
  const id = ev.id, [eLon, eLat, depth] = ev.geometry.coordinates, M = ev.properties.mag;
  try {
    const detail = await getJSON(ev.properties.detail, `${id}-detail.json`);
    const sm = detail.properties.products.shakemap?.[0];
    const url = sm?.contents?.['download/stationlist.json']?.url;
    if (!url) { summary.push(`${id} M${M} 無 stationlist`); continue; }
    const sl = await getJSON(url, `${id}-stations.json`);
    let n = 0;
    for (const st of sl.features) {
      const p = st.properties;
      // 只用儀器測站（排除 DYFI 民眾回報）
      if (p.station_type && p.station_type !== 'seismic') continue;
      if (p.source === 'DYFI' || p.network === 'DYFI') continue;
      const pgaPctG = Number(p.pga), pgv = Number(p.pgv);
      if (!(pgaPctG > 0) || !(pgv > 0)) continue;
      const [sLon, sLat] = st.geometry.coordinates;
      if (sLon < 119 || sLon > 122.5 || sLat < 21.5 || sLat > 25.6) continue; // 只要台灣境內
      const rhypo = Math.hypot(dist(sLon, sLat, eLon, eLat), depth);
      records.push({ ev: id, M, depth, eLon, eLat, sLon, sLat, code: p.code, pga: pgaPctG * 9.80665, pgv, rhypo: +rhypo.toFixed(2) });
      n++;
    }
    summary.push(`${id} M${M} ${ev.properties.place}：${n} 站`);
  } catch (e) { summary.push(`${id} 錯誤：${e.message}`); }
  if (i % 10 === 0) console.log(`  ${i + 1}/${events.length}`);
}

// 合併到既有資料
const file = path.join(OUT, 'records.json');
const old = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).records : [];
const seen = new Set(old.map(r => `${r.ev}|${r.code}`));
const added = records.filter(r => !seen.has(`${r.ev}|${r.code}`));
const merged = [...old, ...added];
fs.writeFileSync(file, JSON.stringify({ source: 'USGS ShakeMap stationlist (https://earthquake.usgs.gov)', fetched: new Date().toISOString(), records: merged }));
fs.appendFileSync(path.join(OUT, 'events.txt'), '\n' + summary.join('\n'));
const evAdded = new Set(added.map(r => r.ev)).size;
console.log(`本次新增：${evAdded} 個地震、${added.length} 筆；合計 ${new Set(merged.map(r => r.ev)).size} 個地震、${merged.length} 筆 → ${file}`);
