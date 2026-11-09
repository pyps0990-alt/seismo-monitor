# Seismo Monitor 地震監測

以 ICM-42688-P 加速度計 + ESP32（Wi-Fi）自製地震儀的電腦端程式。
目前為 **v0.1 模擬版**：網頁介面，用模擬資料開發；之後以 Tauri 包成 Windows App。

**線上展示：https://pyps0990-alt.github.io/seismo-monitor/** （模擬模式；線上版因 HTTPS 限制無法連 ESP32 的 `ws://`，接儀器請用本機版）

## 功能（v0.1）

- 三軸即時波形（最近 20 秒，自動去除重力，單位 gal）
- STA/LTA 震動偵測：畫面警示 + 提示音，自動存下事件前後 30 秒的 CSV
- 長時間記錄成 CSV（Chrome/Edge 會直接寫入你選的檔案，每秒寫一次）
- 載入 CSV 回看波形、計算最大 PGA
- 即時 PGA 與估計震度（中央氣象署分級；5 弱以上官方使用 PGV，此處僅以 PGA 粗估）
- 「模擬地震」按鈕：產生 P 波 + S 波的測試訊號

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
