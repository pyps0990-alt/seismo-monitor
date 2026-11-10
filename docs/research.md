# 地震速報演算法：文獻依據與實驗紀錄

本文件記錄 Seismo Monitor 的地震速報（EEW）演算法參考了哪些科學文獻、實際套用了什麼、以及每項改動用資料驗證後的結果（含失敗的嘗試）。
文獻書目資料（標題、年份、引用次數、DOI）由 OpenAlex 學術資料庫查詢取得（2026-11-10）。

## 1. 參考文獻

| # | 文獻 | 期刊 | 被引用 | 本專案用途 |
|---|---|---|---|---|
| 1 | Wu, Y.-M. & Zhao, L. (2006). Magnitude estimation using the first three seconds P-wave amplitude in earthquake early warning. | *Geophys. Res. Lett.* [doi:10.1029/2006GL026871](https://doi.org/10.1029/2006gl026871) | 327 | **Pd 規模**：log10(Pd) = −3.463 + 0.729·M − 1.374·log10(R) ± 0.305 |
| 2 | Hsiao, N.-C., Wu, Y.-M., Shin, T.-C., Zhao, L. (2009). Development of earthquake early warning system in Taiwan. | *Geophys. Res. Lett.* [doi:10.1029/2008GL036596](https://doi.org/10.1029/2008gl036596) | 173 | 氣象署系統：20 秒內發布、規模誤差 < 0.4、Pd 可辨識 M≥6 → 模擬加入 3 秒 P 波視窗與傳輸延遲 |
| 3 | Wu, Y.-M. (2002). A Virtual Subnetwork Approach to Earthquake Early Warning. | *BSSA* [doi:10.1785/0120010217](https://doi.org/10.1785/0120010217) | 171 | 只用震央附近測站快速定位的概念（本專案的「鄰站關聯」） |
| 4 | Wu, Y.-M. & Kanamori, H. (2005). Experiment on an Onsite Early Warning Method for the Taiwan Early Warning System. | *BSSA* [doi:10.1785/0120040097](https://doi.org/10.1785/0120040097) | 300 | 現地型預警（單站 τc、Pd） |
| 5 | Wu, Y.-M. (2005). Rapid Assessment of Damage Potential of Earthquakes in Taiwan from the Beginning of P Waves. | *BSSA* [doi:10.1785/0120040193](https://doi.org/10.1785/0120040193) | 283 | Pd ≥ 0.5 cm 代表可能有破壞性 |
| 6 | Kodera, Y. et al. (2018). The Propagation of Local Undamped Motion (PLUM) Method. | *BSSA* [doi:10.1785/0120170085](https://doi.org/10.1785/0120170085) | 121 | **PLUM**：以 30 km 內測站實測震度預估本地震度 |
| 7 | Minson, S. E. et al. (2019). The Limits of Earthquake Early Warning Accuracy and Best Alerting Strategy. | *Scientific Reports* | 141 | 警報門檻應低於目標震度 → 支持「保守量」設計 |
| 8 | Allen, R. M. & Melgar, D. (2019). Earthquake Early Warning: Advances, Scientific Challenges, and Societal Needs. | *Annu. Rev. Earth Planet. Sci.* [doi:10.1146/annurev-earth-053018-060457](https://doi.org/10.1146/annurev-earth-053018-060457) | 480 | 綜述：點源、有限斷層、地動模型三類方法 |
| 9 | Böse, M., Heaton, T., Hauksson, E. (2012). Real-time Finite Fault Rupture Detector (FinDer) for large earthquakes. | *Geophys. J. Int.* [doi:10.1111/j.1365-246X.2012.05657.x](https://doi.org/10.1111/j.1365-246x.2012.05657.x) | 135 | 有限斷層概念（實驗後停用，見 §3.3） |
| 10 | Wells, D. L. & Coppersmith, K. J. (1994). New empirical relationships among magnitude, rupture length, rupture width, rupture area, and surface displacement. | *BSSA* [doi:10.1785/BSSA0840040974](https://doi.org/10.1785/bssa0840040974) | 7830 | 斷層長度 log10(L) = −2.44 + 0.59·M（係數依論文內容引用，未能從摘要核對） |
| 11 | Zollo, A. et al. (2010). A threshold-based earthquake early warning using dense accelerometer networks. | *Geophys. J. Int.* [doi:10.1111/j.1365-246X.2010.04765.x](https://doi.org/10.1111/j.1365-246x.2010.04765.x) | 216 | 以 Pd、τc 門檻劃定可能受災區（區域警示方框的概念） |
| 12 | Wu, Y.-M. et al. (2016). Performance of a Low-Cost Earthquake Early Warning System (P-Alert) during the 2016 ML 6.4 Meinong Earthquake. | *Seismol. Res. Lett.* | 91 | 低成本 MEMS 感測器做預警的可行性（本專案自製地震儀的依據） |

## 2. 資料來源

| 來源 | 內容 | 數量 | 限制 |
|---|---|---|---|
| USGS ShakeMap | 各測站實測 PGA、PGV | 87 個地震、2476 筆 | 只有較大地震有 ShakeMap；已抓到上限 |
| 中央氣象署開放資料 E-A0015-001、E-A0016-001 | 各測站 IntScaleValue（計算震度用） | 32 個地震、718 筆（持續累積） | API 只保留約一個半月 |
| NGA-West2 資料庫（PEER） | 大量台灣強震紀錄 | — | 原下載網址已失效（404），未取得 |

## 3. 實驗紀錄

評估工具：`tools/replay-real.mjs`（12 個真實地震，各重播 30～50 次）、`tools/bench-random.mjs`（隨機地震）、`tools/train-gmpe.mjs`（依地震 5 折交叉驗證）。

### 3.1 穩健定位（中位數＋L1）— 採用
集集地震因誤觸發被併入而偏離。改用中位數估發震時間、絕對值殘差、逐一剔除最差觸發：
集集震央誤差 2.8±10.6 km → **0.6±0.2 km**；整體 0.8±3.2 km → **0.5±0.4 km**。

### 3.2 Pd 規模＋3 秒視窗＋1 秒傳輸延遲（文獻 1、2）— 採用
原本「P 波振幅＝S 波 PGA×0.3」反推規模，規模誤差 ±0.06，**過度樂觀**。改用 Pd 並加入真實系統限制後：

| 時間點（隨機地震 80 個） | 發震後秒數 | 規模誤差 |
|---|---|---|
| 第一報 | 7.8 秒 | 0.85（Pd 尚未收滿 → 偏低） |
| 至少 3 站收滿 3 秒 P 波 | 10.8 秒 | **0.13** |

與氣象署系統（文獻 2：20 秒內、誤差 < 0.4）的量級一致。前幾報規模偏低時，警示區的規模保守量額外 +0.5。
0403 回放：規模 M6.1（估算中）→ 6.6 → 7.2 → 7.4 逐報上修。

### 3.3 有限斷層距離（文獻 9、10）— 實驗後停用
M≥6.5 改用斷層距離（長度依文獻 10、走向先驗北北東 20°）：

| 地震 | 震度命中（點源 → 有限斷層） | 差 1 級內 |
|---|---|---|
| 1999 集集 M7.7 | 50% → 36% | 92% → 85% |
| 2024 花蓮 M7.4 | 64% → 60% | 95% → 96% |
| 2022 M6.7 | 70% → 71% | 98% → 98% |

整體變差。原因：預估式以震源距離訓練，換成斷層距離高估近處；固定走向不符集集（南北向單側破裂）。
要有效需要用斷層距離重訓預估式，並即時估計走向。

### 3.4 規模×距離交互項、大地震鄉鎮修正 — 前者保留（無害）、後者不採用
0403 北台灣實測 5 弱、預估 4 級（北部 74 站中 29 站低估一級）。兩者都未改善（留一法：0403 命中 58% → 59%，另一地震 72% → 62%）。

### 3.5 模型誤差保守量（文獻 7）— 採用
M≥5.0 時警示區計入預估式 1σ 誤差（約 ×2）。實測 ≥4 級地區的涵蓋率：中型地震 27～64% → **73～100%**，多數地震增加的過度警示 0～4 站。

### 3.6 範圍通知發送標準 — 採用
「3 站確認，或 2 站確認且 P 波振幅 ≥ 3 gal」：400 次模擬誤報率 83.5% → **2.0%**，無漏報。

## 4. 誠實聲明
- 真實地震回放的 P 波到時、Pd 為依物理關係模擬（含文獻的離散度），不是當時的真實波形。
- 震度命中率屬「樣本內」：預估式訓練資料包含這些地震。交叉驗證（§3 工具）才是對新地震的公平估計：震度完全命中約 57%、差 1 級內約 97%。
- 深層地震（> 50 km）資料只佔約 12%，預估較差。
