// 整理「真實地震回放」資料集：從 USGS／氣象署實測紀錄中，挑測站最多的真實地震
// 用法：node tools/build-real-events.mjs
// 輸出：data/real-events.json  [{ id, name, date, M, depth, lon, lat, src, stations:[{lon,lat,pga,pgv}] }]
import fs from 'node:fs';

const usgs = JSON.parse(fs.readFileSync('data/usgs/records.json', 'utf8')).records.map(r => ({ ...r, src: 'USGS' }));
const cwa = fs.existsSync('data/cwa/records.json') ? JSON.parse(fs.readFileSync('data/cwa/records.json', 'utf8')).records : [];
const byEv = {};
for (const r of [...usgs, ...cwa]) (byEv[r.ev] ??= []).push(r);

// 知名地震的中文名稱
const NAMES = { usp0009eq0: '1999 集集地震', us7000m9g4: '2024 花蓮地震（0403）' };
const r1 = v => Math.round(v * 1000) / 1000;

const events = Object.entries(byEv).filter(([, a]) => a.length >= 40).sort((a, b) => b[1].length - a[1].length).slice(0, 12).map(([id, a]) => {
  const e = a[0];
  let date = '', place = '';
  if (e.src === 'USGS') {
    const f = `data/usgs/cache/${id}-detail.json`;
    if (fs.existsSync(f)) {
      const d = JSON.parse(fs.readFileSync(f, 'utf8')).properties;
      date = new Date(d.time + 8 * 3600e3).toISOString().slice(0, 10);   // 台灣時間
      place = d.place;
    }
  } else { date = id.slice(4, 14); place = '中央氣象署地震報告'; }
  return {
    id, name: NAMES[id] || `${date} M${e.M}`, date, place, M: e.M, depth: e.depth, lon: e.eLon, lat: e.eLat, src: e.src,
    stations: a.map(r => ({ lon: r1(r.sLon), lat: r1(r.sLat), pga: +r.pga.toFixed(2), pgv: +r.pgv.toFixed(3) })),
  };
});
fs.writeFileSync('data/real-events.json', JSON.stringify(events));
console.table(events.map(e => ({ name: e.name, date: e.date, M: e.M, depth: e.depth, stations: e.stations.length, place: e.place })));
