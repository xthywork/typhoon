# 合併說明：官方 API、按需快取與風圈時間對齊

來源分支：`feature/backend-api-adjustments`

基底：`baa30c2`（本地 OpenStreetMap 與雙時間軸合併版本）

本次合併包含這個分支上尚未提交的全部 API 串接及相關畫面修改。其他分支合併 `main` 時，請保留下列資料契約與行為，再套用各自的介面變更。

## 主要改變

1. 移除模擬位置、風速、氣壓與固定五個預報批次，改接後端 `/api/typhoons`。
2. 新增 `server.py`：同時供應前端、官方資料 API、SQLite 批次快取。**正式啟動方式已改變**，純靜態 HTTP server 無法支援氣象資料。
3. 新增 `official_data.py`：CWA 正式授權 XML，以及 JMA／HKO／CMA 官方公開資料的獨立解析器。KMA 尚待認證及 adapter；JTWC 仍受連線及路徑介面驗證限制，狀態明確顯示，不用其他來源冒充。
4. 擷取改成**按需且一小時快取**：啟動不抓、沒有背景排程、網頁不自動輪詢。開啟網頁或按重新整理時才請求；快取過期才啟動新一輪。同時請求共用一輪；有效快取可跨服務重啟保留。
5. 地圖新增七級／十級風圈、官方四象限不對稱半徑、中心位置機率圈與精簡氣象摘要。位置標記與風圈共用同一筆來源、有效時間與座標，避免跨來源／跨批次混用。

## 啟動、憑證與本機資料

```sh
python3 server.py --bind 0.0.0.0 --port 8000
```

- 需要 Python 3.10+、curl；後端使用標準函式庫。
- `.env.example` 僅提供 `CWA_API_KEY=` 的空白範本。實際 `.env` 不加入 Git，也不由 HTTP 公開。
- 環境變數 `CWA_API_KEY` 優先於 `.env`。憑證 URL 經 curl 標準輸入傳送，不放在命令列、前端回應或來源連結。
- `.cache/weather.sqlite3` 保存真實批次、來源狀態及擷取完成時間；不加入 Git。不要因切分支而刪除既有快取。
- 按重新整理不代表強制抓上游：一小時內仍讀取既有結果。失敗來源也不在每次訪問時立即重試。
- API 回覆無活動系統時清空地圖。單一上游失敗保留該來源上次成功紀錄並標示；最後成功超過 48 小時後不再以活動系統顯示。

## 其他分支容易衝突的部分

| 檔案／介面 | 合併時需保留的語意 |
| --- | --- |
| `index.html` 的 `DS.load` | 只向同源 `/api/typhoons` 取資料；不要恢復模擬 DS 或前端直接帶金鑰呼叫官方。 |
| `S.actual` | **UTC Unix 毫秒時間戳**，無共同完整時刻時為 `null`；已不再是 `-48…0` 小時偏移。 |
| 位置滑桿／播放 | 使用 `analysisTimeline()` 的實際離散紀錄。不能用 `S.actual += 6` 或固定六小時步進。鍵盤、拖曳與播放都需停在官方時刻。 |
| `S.batch` | 是所選氣旋的 `batchTimes` 索引；沒有固定五批，也不能用索引乘六小時推算發布時間。 |
| `agencyBatch()` | 各來源選擇所選發布時刻以前最新的已儲存產品；不同機構的批次不按相同索引硬配。 |
| `analysisTimeline()` | 不得超過目前來源所選產品的分析基準時間；風圈稀疏時使用與位置共同可用的官方時刻。缺值不補算。兩層風圈各有資料卻沒有共同完整時刻時，停用位置滑桿／播放並隱藏中心，不得撤銷完整性篩選。 |
| `weatherContext()`／`drawMap()` | 中心位置與風圈從相同來源、時刻及座標取值；不要恢復獨立使用 `base(TY(), S.actual)` 當中心、另一批資料畫風圈的模式。 |
| 點選預報點 | 中心與風圈一起預覽該點，文字標明「預報＋有效時間」。操作分析時間軸時清除預報點選取。 |
| `map.js` 的 `render(snapshot)` | 新增 `weather`（agency、point、forecast）與 `centerLabel`；`actual` 可為 `null`，此時不得索引座標或顯示中心標記。保留原本本地 OSM 底圖，無活動氣旋時也需初始化預設視角。 |
| 圖層設定 | 新增 `wind15`、`wind25`；`cone` 是官方中心位置機率圈。`r30` 僅供確實提供 30 kt 半徑的來源，不等同 CWA 15 m/s。 |
| 播放按鍵 | SVG 透過 `aria-pressed` 切換圖示；不要再以 `textContent` 更新播放／暫停文字。 |
| `server.py` 的快取 | `CACHE_SECONDS=3600`；保留 `collection_state` 與鎖。不要恢復背景 `threading.Thread` 擷取、五分鐘 TTL 或啟動立即下載。 |

## `/api/typhoons` 資料契約摘要

- `schemaVersion: 1`、`mock: false`、`synced`（本機擷取完成時間）。
- `sources[agency]`：狀態、說明、最後嘗試時間、最後成功時間、公開來源連結。
- `typhoons[]`：`id`、名稱、`historyAgency`、`history`、`batchTimes`、各來源 `sources`。
- `typhoons[].sources[agency]`：公開 `url`、`transport`、`history`、`batches`。
- 批次：`issued`、`base`、`points`，時間均為 UTC Unix 毫秒。
- 點：`time`、`lat`、`lon`、`w`（m/s）、`p`（hPa），選填 `gust`、`windRadius15ms`／`25ms`（km）、`windRadii15ms`／`25ms`（NE／SE／SW／NW）、`cone`（km）、`coneProbability`、`movingSpeed`（km/h）、`movingDirection`、`stateTransfer`。
- 官方未提供的值保持 `null`，缺少風圈時不要根據風速自行生成。

## 驗證範圍

不需網路或真實金鑰的後端契約檢查：

```sh
python3 -m unittest discover -s tests -v
node --check map.js
```


- 後端：快取建構不擷取、首次請求擷取、3599 秒仍共用、3601 秒過期、重啟保留、多人同時只抓一輪。
- 解析：CWA 命名空間、分析／預報時刻與風圈欄位、缺值；金鑰不進命令列、授權錯誤不顯示金鑰。
- 已在瀏覽器驗證：真實來源、雙滑桿與離散步進、風圈和中心同座標／同時刻、來源切換、舊批次限制、風圈稀疏時的共同時刻、預報預覽標記、圖層開關、手機版、無活動氣旋清空。

詳細來源限制、註冊入口與欄位說明見 [官方資料說明](../official-data.md)。

## 其他分支同步方式

在該分支既有的工作目錄內，先提交或妥善保留自己的修改，再執行：

```sh
git fetch origin
git merge origin/main
```

若 `index.html`／`map.js` 有衝突，以上表資料契約為基準保留資料與同步邏輯，再合入該分支的排版或播放介面調整。不要把資料服務退回純靜態啟動或恢復固定六小時／五批次假設。

## 時間軸分支合併後的顯示規則

前述聚焦來源或預報點會改變分析中心的描述，已由新版需求取代：中央位置、七級／十級風圈與摘要固定使用 CWA 分析序列；來源勾選與聚焦只控制預報顯示。兩軌勾選時以同一時間游標同步，來源清單始終可選。後端每小時、請求觸發的快取行為保留，頁面不定時自動更新。
