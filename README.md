# 多國颱風路徑比較

以 OpenStreetMap 底圖與 Leaflet 1.9.4／MapLibre GL JS 6.11.2 顯示颱風歷史位置、各機構預測路徑、暴風圈及不確定範圍。

目前已接入 CWA 正式會員 API、JMA／HKO／CMA 官方公開產品，以及 NOAA/NWS 官方轉送的 JTWC 警報，並保留來源與真實發布／產品更新時間。KMA 等待認證與正式 adapter。詳細限制與申請方式見 [官方資料串接說明](docs/official-data.md)。

## 本機啟動

```sh
python3 server.py --port 18765 --bind 0.0.0.0
```

開啟 `http://localhost:18765/`；其他區域網裝置使用主機的 IP 與相同連接埠。
地圖函式庫、樣式與海岸資料都存放在專案內，底圖載入不需要外部圖磚服務；官方氣象資料更新需要由伺服器連上網際網路。區域網裝置仍需連得上提供 HTTP 服務的主機。

本地底圖以全球概覽為基礎，東經 95°–165°、南緯 5°–北緯 55° 使用較詳細的海岸資料，涵蓋台灣與西北太平洋。高倍率縮放沿用本地海岸輪廓，不會下載額外的街道細節。海岸資料採快照，不會自動更新。

資料服務需要 Python 3.10+ 與 `curl`，依台灣時間每小時 05、20、25、50 分背景更新，啟動時等待下一個排程時間，即使無人訪問也持續排程。有人開啟網頁時，若距離上輪完成超過 5 分鐘，另觸發一次背景擷取；一般版本檢查只讀快取。網頁前 10 秒每秒檢查，其後每 3 分鐘檢查，只有資料內容改變才更新畫面。歷史批次保存在不加入 Git 的 `.cache/weather.sqlite3`。原本的靜態 HTTP server 不支援官方資料 API。

## systemd 使用者服務

專案位於 `~/typhoon` 時，可安裝使用者服務：

```sh
install -Dm644 systemd/typhoon.service "$HOME/.config/systemd/user/typhoon.service"
systemctl --user daemon-reload
systemctl --user enable --now typhoon.service
```

服務監聽 `0.0.0.0:18765`，異常退出後 5 秒自動重啟；停止時使用 SIGINT，讓背景擷取與資料庫正常結束。授權碼仍由後端讀取專案 `.env`。本機使用者已啟用 linger，因此重新開機後、尚未登入時也會啟動使用者服務。

```sh
systemctl --user status typhoon.service
systemctl --user restart typhoon.service
journalctl --user -u typhoon.service -n 50 --no-pager
```

本機區域網網址：`http://192.168.17.109:18765/`。更新程式碼後執行上述 restart 指令；舊的 8000 埠已停用。

## 地圖操作

- 拖曳、滾輪或雙指手勢移動及縮放；「重設」會顯示路徑全貌及台灣。
- 點擊預測點查看詳細資料；名稱聚焦、來源勾選及兩條時間軸保留原操作方式。
- 設定面板可選低彩度淺色、自然色或深色底圖，所有模式均不顯示地名或行政／海上國界線。
- 分享連結包含 Leaflet 地圖中心與縮放比例。

前端由 `bootstrap.mjs` 載入本地 MapLibre 模組與 `app.js`。底圖圖層由 `basemap-style.json` 管理，只使用陸地底色及本地海岸／水域資料，不加入地名或邊界圖層；配色與互動由 `map.js` 管理，網頁外觀由 `map.css` 管理。

## 手機基本模式

寬度 700px 以下，以及較矮的觸控橫向螢幕，使用精簡操作：

- 頂部保留颱風搜尋與時區；標題左側開啟全螢幕來源清單，右側開啟全螢幕圖層設定，透過關閉按鈕或 Escape 返回地圖。
- 隱藏重新整理、分析摘要、縮放／重設工具、匯出分頁及側邊展開箭頭。地圖使用拖曳與雙指縮放，資料仍自動檢查更新。
- 合併為單一同步時間軸，上方顯示 `MM/DD HH:mm` 與精簡速度選單；不顯示「截至」、刻度文字、核取方塊、同步切換或右下角時區。
- 手機可播放範圍限於含實際預報點的 CWA 批次最早至最新發布時間；不受來源勾選影響。拖曳、步進、循環、分享與新資料更新均限制於此範圍，地圖仍保留完整分析歷史。沒有 CWA 預報或僅一個批次時停用播放，不使用其他來源時段代替。
- 加寬播放鍵，保留前後步進；速度選單與電腦版速度按鈕同步。橫向螢幕將播放器與時間軸並排，減少遮擋。停在 CWA 最新端點時隨新批次前進；歷史檢視保持原時間。返回電腦版後恢復原有播放模式。
- 全螢幕面板包含觸控間距、焦點管理與安全區域；橫向預報詳情仍可閱讀、捲動及關閉。

## 時間軸與節點提示

- 每條時間軸左側的核取方塊選擇播放對象，可播放位置、發布批次，或兩者同時播放。兩軌勾選時共用同一時間游標，依序經過官方分析與發布時間的聯集；地圖只使用該時刻以前最新的分析與已發布批次，不顯示尚未發布的預報，也不進行位置插值。同步時時間讀值標示「截至」，實際分析／發布時間保留在提示與資料詳情中。單軌播放各自保留操作。全不勾選時播放鍵停用。
- 速度選項旁的「同步播放」預設開啟；關閉後兩軌可獨立調整，刻度仍共用實際時間範圍。分享連結保留同步狀態、兩軌勾選、時間與地圖視角。
- 左側所有來源均可選取；沒有資料時保留勾選狀態與狀態燈，地圖只顯示當時有資料的已勾選來源。全選／取消全選包含暫時無資料的來源。
- 節點保留原本視覺大小，透明感應區至少直徑 24px；歷史與預報節點的 hover 顯示來源、日期時間、風速及氣壓，不顯示座標。時間會跟隨頁面時區。

## 本地底圖資料

- `data/basemap/water.geojson.gz`：一般瀏覽器下載的壓縮底圖，約 1.09 MB，由瀏覽器串流解壓。
- `data/basemap/water.geojson`：未壓縮資料，亦供不支援串流解壓的瀏覽器使用。
- `data/basemap/provenance.json`：來源快照、詳細資料範圍、建置方式與 SHA-256。

重新整理資料需要網際網路及 [uv](https://docs.astral.sh/uv/)，執行：

```sh
uv run scripts/build-local-basemap.py
```

建置工具最多使用 4 個並行請求，並限制下載數量與總量；正常開啟網頁不會執行這個工具。

## 地圖來源與授權

底圖資料為 [© OpenStreetMap contributors](https://www.openstreetmap.org/copyright)，由 [OpenFreeMap](https://openfreemap.org/quick_start/) 提供的 [OpenMapTiles](https://openmaptiles.org/) 向量圖磚整理、合併及簡化成本地海岸資料，保留可見來源標示。整理後的底圖資料以 [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/) 授權公開，詳見 [資料說明](data/basemap/README.md)。

[Leaflet](https://leafletjs.com/) 採 BSD 2-Clause 授權，完整授權見 `vendor/leaflet/LICENSE`。
[MapLibre GL JS](https://maplibre.org/) 與 Leaflet 整合套件的授權見 `vendor/maplibre/`。

## 本次 API 合併與驗證

其他開發分支合併前請閱讀 [API 與時間軸整合說明](docs/integration/backend-api-adjustments.md)，其中列出啟動方式、毫秒時間戳、快取與風圈同步的相容性要求。

執行不需網路或真實金鑰的後端檢查：

```sh
python3 -m unittest discover -s tests -v
```


瀏覽器回歸檢查使用 Playwright 與 Chromium；所有氣象請求均由測試資料回應，不消耗官方 API 額度。可在專案外安裝測試工具：

```sh
npm install --prefix /tmp/typhoon-browser-check playwright
/tmp/typhoon-browser-check/node_modules/.bin/playwright install chromium
NODE_PATH=/tmp/typhoon-browser-check/node_modules node tests/frontend.cjs
NODE_PATH=/tmp/typhoon-browser-check/node_modules node tests/mobile.cjs
```

已有 Chromium 時可設定 `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` 指向執行檔。檢查涵蓋真實地圖與 CSP、分享還原、背景更新、資料清空、搜尋與輪詢時序。安全修正與驗證範圍見 [檢查紀錄](docs/security-review-2026-10-23.md)。


### 匯出圖片與動圖

電腦版按鈕在「重新整理」右側；手機版在設定面板內。

- PNG 匯出目前時間位置，保留地圖視角、勾選來源、圖層與時間資訊。
- GIF 依勾選的時間軸走完目前範圍，使用播放倍率與循環設定；「僅預測範圍」也適用。
- 匯出過程可取消，結束後還原時間位置；開啟匯出視窗時暫停播放與前端資料套用，關閉後恢復。
- 圖檔在瀏覽器內產生，不上傳；若手機未自動下載，可使用匯出視窗內的下載連結。
- PNG／GIF 提供最長邊 1280、1920（預設）、2560 像素選項，底圖與路線依選定解析度重新繪製；保留地圖出處與比例尺。
- 匯出前可在預覽內拖曳、縮放地圖，調整地圖高度與分欄資訊區的比例；預覽資訊欄與實際輸出使用同一繪圖流程。關閉後還原網站視角。

GIF 編碼使用 [gifenc 1.0.3](https://github.com/mattdesl/gifenc)，MIT 授權見 `vendor/gifenc/LICENSE.md`。
