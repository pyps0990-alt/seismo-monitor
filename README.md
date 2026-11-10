# Seismo Monitor 地震監測

以 ICM-42688-P 加速度計 + ESP32（Wi-Fi）自製地震儀的電腦端程式。
目前為 **v0.1 模擬版**：網頁介面，用模擬資料開發；之後以 Tauri 包成 Windows App。

**線上展示：https://pyps0990-alt.github.io/seismo-monitor/** （模擬模式；線上版因 HTTPS 限制無法連 ESP32 的 `ws://`，接儀器請用本機版）

## 功能（v0.1）

- 三軸即時波形（最近 20 秒，自動去除重力，單位 gal）
- STA/LTA 震動偵測：畫面警示 + 提示音，自動存下事件前後 30 秒的 CSV
- 長時間記錄成 CSV（Chrome/Edge 會直接寫入你選的檔案，每秒寫一次）
- 載入 CSV 回看波形、計算最大 PGA
- 即時 PGA、PGV 與震度：中央氣象署 2020 新制，0～4 級依 PGA；達 4 級時再依 PGV（加速度積分）判定是否為 5 弱以上
- **台灣地震速報模擬**：虛擬測站網偵測 P 波 → 本機網格搜尋定位震源、由 P 波振幅估算規模 → 發布速報（逐報更新）
  → 以 0.1° 區塊顯示全台預估震度、各縣市 S 波抵達倒數；你的地震儀也會同步收到該次地震的波形。
  衰減式為教學用簡化模型，非中央氣象署正式模型。
- 「模擬地震」按鈕：產生 P 波 + S 波的測試訊號

## 用真實資料訓練地震動預估式

```bash
node tools/fetch-usgs.mjs 4.0 1990   # 下載 USGS ShakeMap 台灣測站實測資料 → data/usgs/records.json
node tools/fetch-cwa.mjs             # 下載中央氣象署地震報告各測站實測值（累積保存）→ data/cwa/records.json
node tools/train-gmpe.mjs            # 迴歸校正 PGA/PGV 預估式＋鄉鎮場址修正 → data/model.json
```

氣象署 API 只保留最近約一個半月的報告，`fetch-cwa.mjs` 會把每次下載的資料累積起來，定期執行資料就會越來越多。
授權碼放在專案根目錄的 `cwa-key.txt`（已列入 `.gitignore`，不會上傳）。

模型：`log10(Y) = c0 + c1·M + c2·log10(R+h) + c3·R + c4·深度 + 地形放大 + 鄉鎮修正`，
以「依地震 5 折交叉驗證」評估（每筆紀錄都用沒看過該地震的模型預測），結果見 `data/model-report.txt`。

## 執行

需要 Node.js（不需安裝任何套件）：

```bash
node server.js
```

用 Chrome 或 Edge 打開 http://localhost:5173 ，按「開始」，等約 15 秒（背景值穩定）後按「模擬地震」。

## 架構

```
index.html, css/        介面
js/sources/simulator.js 模擬資料來源
js/sources/websocket.js ESP32 網路資料來源
js/detector.js          去重力高通、PGA、STA/LTA、震度
js/recorder.js          CSV 長時間記錄、事件記錄、CSV 解析
js/chart.js             Canvas 波形繪製
js/main.js              串接與 UI
```

所有資料來源介面相同：`start(onSamples, onStatus)` / `stop()`，樣本格式 `{t: Unix 毫秒, x, y, z: m/s²}`。
之後加 Tauri 版時，只要多一個資料來源（由 Rust 接收網路資料），其他程式不用改。

## ESP32 傳輸格式（規劃）

ESP32 開 WebSocket 伺服器（例如 port 81），每則訊息一行或多行：

```
時間戳毫秒,ax,ay,az
```

加速度單位為 g。時間戳可用 NTP 校時後的 Unix 毫秒；若用 `millis()`，程式會以第一筆資料對齊電腦時間。
（注意：Arduino Uno 沒有 Wi-Fi，網路傳輸需用 ESP32。）

## CSV 格式

```
time_iso,unix_ms,ax_ms2,ay_ms2,az_ms2
```

存原始值（含重力），方便日後用其他工具（Python、Excel）重新分析。

## 路線圖

- [x] v0.1 模擬版：波形、偵測、記錄、回看、PGA
- [ ] v0.2 ESP32 韌體 + 接真實 ICM-42688-P 資料、校正
- [ ] v0.3 Tauri Windows App：開機自動執行、背景記錄、自動分檔
- [ ] 之後：頻譜分析、與中央氣象署地震報告比對
