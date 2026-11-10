// 從中央氣象署開放資料平台下載地震報告的各測站實測值，並「累積」保存（API 只保留最近約一個半月，定期執行可讓資料越來越多）
// 用法：node tools/fetch-cwa.mjs
// 授權碼：專案根目錄的 cwa-key.txt（已列入 .gitignore，不會上傳）或環境變數 CWA_API_KEY
// 輸出：data/cwa/records.json  每筆 = 一個地震 × 一個測站
//   { ev, M, depth, eLon, eLat, sLon, sLat, code, pga(gal), pgv(cm/s), rhypo(km), src:'CWA' }
//   pga/pgv 使用氣象署計算震度用的 IntScaleValue（與震度分級一致）
import fs from 'node:fs';
import path from 'node:path';

const KEY = (process.env.CWA_API_KEY || (fs.existsSync('cwa-key.txt') ? fs.readFileSync('cwa-key.txt', 'utf8') : '')).trim();
if (!KEY) { console.error('找不到授權碼：請在專案根目錄建立 cwa-key.txt'); process.exit(1); }

const OUT = 'data/cwa', CACHE = path.join(OUT, 'cache');
fs.mkdirSync(CACHE, { recursive: true });
const KX = 111.32 * Math.cos(23.7 * Math.PI / 180), KY = 110.57;
const dist = (a, b, c, d) => Math.hypot((a - c) * KX, (b - d) * KY);

const file = path.join(OUT, 'records.json');
const db = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { records: [] };
const seen = new Set(db.records.map(r => `${r.ev}|${r.code}`));
let added = 0, evNew = new Set();

for (const ds of ['E-A0015-001', 'E-A0016-001']) {          // 顯著有感、小區域有感
  const url = `https://opendata.cwa.gov.tw/api/v1/rest/datastore/${ds}?Authorization=${KEY}&format=JSON&limit=1000`;
  const r = await fetch(url);
  if (!r.ok) { console.error(`${ds} 下載失敗 HTTP ${r.status}`); continue; }
  const j = await r.json();
  fs.writeFileSync(path.join(CACHE, `${ds}-${new Date().toISOString().slice(0, 10)}.json`), JSON.stringify(j)); // 原始資料備份
  for (const e of j.records?.Earthquake ?? []) {
    const info = e.EarthquakeInfo;
    const ev = `CWA-${info.OriginTime}`, M = info.EarthquakeMagnitude.MagnitudeValue, depth = info.FocalDepth;
    const eLon = info.Epicenter.EpicenterLongitude, eLat = info.Epicenter.EpicenterLatitude;
    for (const area of e.Intensity?.ShakingArea ?? []) for (const st of area.EqStation ?? []) {
      const pga = Number(st.pga?.IntScaleValue), pgv = Number(st.pgv?.IntScaleValue);
      if (!(pga > 0) || !(pgv > 0)) continue;
      const key = `${ev}|${st.StationID}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const sLon = st.StationLongitude, sLat = st.StationLatitude;
      db.records.push({ ev, M, depth, eLon, eLat, sLon, sLat, code: st.StationID, pga, pgv,
        rhypo: +Math.hypot(dist(sLon, sLat, eLon, eLat), depth).toFixed(2), src: 'CWA' });
      added++; evNew.add(ev);
    }
  }
}
db.source = '中央氣象署開放資料平台 E-A0015-001／E-A0016-001（各測站 IntScaleValue）';
db.updated = new Date().toISOString();
fs.writeFileSync(file, JSON.stringify(db));
const evAll = new Set(db.records.map(r => r.ev)).size;
console.log(`新增 ${evNew.size} 個地震、${added} 筆；累積共 ${evAll} 個地震、${db.records.length} 筆 → ${file}`);
