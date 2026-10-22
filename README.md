# 多國颱風路徑比較

以 OpenStreetMap 底圖與 Leaflet 1.9.4／MapLibre GL JS 5.6.2 顯示颱風歷史位置、各機構預測路徑、暴風圈及不確定範圍。

目前已接入 CWA 正式會員 API，以及 JMA、HKO、CMA 官方公開產品，並保留來源與真實發布／產品更新時間。KMA 等待認證與正式 adapter，JTWC 在此環境尚無法連線。詳細限制與申請方式見 [官方資料串接說明](docs/official-data.md)。

## 本機啟動

```sh
python3 server.py --port 8000 --bind 0.0.0.0
```

開啟 `http://localhost:8000/`；其他區域網裝置使用主機的 IP 與相同連接埠。
地圖函式庫、樣式與海岸資料都存放在專案內，底圖載入不需要外部圖磚服務；官方氣象資料更新需要由伺服器連上網際網路。區域網裝置仍需連得上提供 HTTP 服務的主機。

本地底圖以全球概覽為基礎，東經 95°–165°、南緯 5°–北緯 55° 使用較詳細的海岸資料，涵蓋台灣與西北太平洋。高倍率縮放沿用本地海岸輪廓，不會下載額外的街道細節。海岸資料採快照，不會自動更新。

資料服務需要 Python 3.10+ 與 `curl`，每五分鐘更新，歷史批次保存在不加入 Git 的 `.cache/weather.sqlite3`。原本的靜態 HTTP server 不支援官方資料 API。

## 地圖操作

- 拖曳、滾輪或雙指手勢移動及縮放；「重設」會顯示路徑全貌及台灣。
- 點擊預測點查看詳細資料；名稱聚焦、來源勾選及兩條時間軸保留原操作方式。
- 設定面板可選低彩度淺色、自然色或深色底圖，所有模式均不顯示地名或行政／海上國界線。
- 分享連結包含 Leaflet 地圖中心與縮放比例。

底圖圖層由 `basemap-style.json` 管理，只使用陸地底色及本地海岸／水域資料，不加入地名或邊界圖層；配色與互動由 `map.js` 管理，網頁外觀由 `map.css` 管理。

## 時間軸與節點提示

- 每條時間軸左側的核取方塊選擇播放對象，可播放位置、發布批次，或兩者同時播放。兩軌勾選時共用同一時間游標，依序經過官方分析與發布時間的聯集；地圖只使用該時刻以前最新的分析與已發布批次，不顯示尚未發布的預報，也不進行位置插值。同步時時間讀值標示「截至」，實際分析／發布時間保留在提示與資料詳情中。單軌播放各自保留操作。全不勾選時播放鍵停用。
- 速度選項旁的「發布範圍」只將共用刻度縮到真實發布批次範圍，不改變兩軌的播放勾選；位置軌仍可播放範圍內的官方分析點。地圖保留全部歷史路徑，關閉後恢復完整刻度。
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
