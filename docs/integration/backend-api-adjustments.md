# 合併說明：官方資料、更新排程與安全修正

更新日期：2026-10-23。整合基底為 `7f08150`；本文件記錄目前 main 的行為，供其他分支合併時使用。

## 更新機制

- `server.py` 同時提供前端與 `/api/typhoons`，以 `python3 server.py --bind 0.0.0.0 --port 8000` 啟動。
- 台灣時間每小時 **05、20、25、50 分**背景抓取，即使沒有訪客也執行。啟動本身不立即抓取。
- 開啟網站／手動重新整理使用 `/api/typhoons?visit=1`，若距離上輪完成超過 **300 秒**或沒有快照，才啟動背景抓取。有效快照立即回傳；完全沒有快照時立即回覆 503 與 `Retry-After: 1`，頁面會繼續檢查。
- 一般 `/api/typhoons` 只讀快照。前端先每秒檢查一次，共 10 次，再每 180 秒檢查一次。
- `version`／ETag 依內容計算，排除單純的擷取完成／嘗試／成功時間。相同版本回覆 304，正常背景檢查不改 DOM、不重畫地圖。
- 整輪擷取共用鎖，排程與訪客觸發不重複下載同一輪。整輪資料、來源狀態及完成時間在單一 SQLite 交易中發布；建構快照失敗會回滾。
- 上游失敗保留上次成功資料並標示 `late`；超過回退期限則移除該來源的活動清單。每個氣旋最新活動產品的發布及分析時間須在 48 小時內；JTWC 另有較嚴格的概況／警報期限。CMA 同一產品內的舊批次仍可保留。

## 來源與歷史資料

- CWA：正式授權 XML；JMA／HKO／CMA：官方公開產品。CWA 分析可比預報起算時間更新：完整保留分析歷史，`base` 與預報起點取自原始 `InitialTime` 及對應官方分析，不能再要求兩個時計相同。
- JTWC：NOAA/NWS 官方轉送的 JTWC PGTW 概況與警報文字，`transport=noaa-nws-jtwc-bulletin`。保留實際分析、發布及預報有效時間，排除最終警報、過期警報、早於概況引用的舊警報；34／50／64 kt 四象限半徑保留原有門檻語意。
- KMA：尚待認證與 adapter，明確顯示 `unconfigured`。
- 無名低壓以提供商與原始編號識別，JMA 沒有正式颱風編號時使用唯一 TC code。跨年使用官方季年；缺少季年時，只延續相近時段的相同系統，無名系統必須同來源、同編號。
- `import_history.py` 僅供明確執行的單次匯入。先前匯入的 2026 歷史資料已依使用者要求移除，這次不重新匯入。
- 歷史檔空白、解析失敗或覆蓋範圍縮減時，拒絕覆寫既有年度；依指定年份處理兩位數世紀，接受合理的跨年路徑。

## 前端合併重點

| 檔案／介面 | 必須保留的行為 |
| --- | --- |
| `index.html`／`bootstrap.mjs`／`app.js` | UI 邏輯已由 HTML 抽到 `app.js`。MapLibre 6 以 ES module 載入，再初始化 Leaflet 整合與應用程式；三個檔案須一併合併。 |
| `DS.load()`／`refresh()` | 同源讀取、條件式 ETag、一般檢查不抓上游；回應到達後才讀取當下選擇，避免覆蓋使用者等待期間的操作。 |
| `S.actual`／`S.batch` | 分別為 UTC Unix 毫秒時間戳與 `batchTimes` 索引；不假設六小時固定間隔或固定五批次。 |
| `agencyBatch()` | 每個來源使用所選發布時刻以前最新的已儲存產品，不按來源間相同索引硬配。 |
| `analysisAgency()`／`analysisHistory()` | 有 CWA 分析就優先使用 CWA，否則使用後端選定的實際分析來源；中心、歷史線、時間軸及提示必須共用同一序列。來源勾選與聚焦只控制預報圖層。 |
| `weatherContext()` | 分析中心與風圈使用同一筆位置及時間；不插值位置、不依風速補造風圈，不因點選預報點而移動中央分析紅點。紅點不顯示永久 CWA Tag。 |
| 播放 | 兩軌與「同步播放」預設選取；同步時使用分析與發布時間的聯集。關閉同步後可獨立調整。按鍵使用 SVG icon。 |
| 分享／搜尋 | 保存同步模式、兩軌勾選、游標與視角；分享目標尚未進入快取時保留待還原狀態，使用者主動切換後取消待還原。搜尋選項使用穩定氣旋 ID。 |
| 畫面更新 | 無活動系統時清除地圖與詳情；切換時區同步更新右上更新時間；同版成功回覆可清除先前明確顯示的連線錯誤。 |
| `map.js` | 提示內容使用 DOM 文字節點；中心與風圈同座標。保留本地 OSM、離線底圖及無活動氣旋時的預設視角。 |

## HTTP 與憑證

- 靜態檔案使用固定白名單，GET／HEAD 共用檢查；拒絕符號連結、目錄列表與私人檔案。新增前端資產時必須同步更新 `PUBLIC_FILES`。
- CSP 只允許同源腳本；不要恢復 inline script、`eval` 或外部 CDN。MapLibre 的主模組、共用模組與 worker 模組都保存在 `vendor/maplibre/`。
- MapLibre 已從 5.6.2 更新至 6.11.2，修正 GHSA-jrc7-96c5-q579；來源與檔案雜湊記錄在 `vendor/maplibre/provenance.json`。
- HTTP 連線有 15 秒 I/O 期限及 64 個處理工作上限；跨網站 API 請求受阻擋。
- `.env` 與 `.cache/` 不加入 Git、不經 HTTP 公開。CWA 授權 URL 經 curl 標準輸入傳送，不放入命令列、來源 URL、錯誤回應或快取。

## 資料契約

- `schemaVersion: 1`、`mock: false`、`synced`、內容 `version`。
- `sources[agency]`：狀態、說明、最後嘗試／成功時間、公開來源連結。
- `typhoons[]`：穩定 `id`、名稱、`historyAgency`、`history`、`batchTimes`、各來源 `sources`。
- 批次：`issued`、`base`、`points`；時間均為 UTC Unix 毫秒。
- 點：`time`、`lat`、`lon`、`w`（m/s）、`p`（hPa），缺少值保持 `null`。風圈半徑為 km；15／25 m/s、30 kt、JTWC 34／50／64 kt 的門檻不可混用。

## 驗證與其他分支同步

```sh
python3 -m unittest discover -s tests -v
node --check app.js
node --check bootstrap.mjs
node --check map.js
```

瀏覽器測試見 `tests/frontend.cjs`，執行方式見 README。安全與邏輯修正摘要見 [檢查紀錄](../security-review-2026-10-23.md)。

其他分支先妥善提交或保留自己的修改，再執行 `git fetch origin` 與 `git merge origin/main`。有衝突時以本文件的排程、資料與同步語意保留邏輯，再合入各分支的排版。
