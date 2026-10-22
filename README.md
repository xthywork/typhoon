# 多國颱風路徑比較

以 OpenStreetMap 底圖與 Leaflet 1.9.4／MapLibre GL JS 5.6.2 顯示颱風歷史位置、各機構預測路徑、暴風圈及不確定範圍。

**目前所有氣象資料均為模擬資料，非官方預報。**

## 本機啟動

```sh
python3 -m http.server 8001 --bind 0.0.0.0
```

開啟 `http://localhost:8001/`；其他區域網裝置使用主機的 IP 與相同連接埠。
地圖函式庫、樣式與海岸資料都存放在專案內，開啟網站時不需要外部圖磚服務或網際網路連線。區域網裝置仍需連得上提供 HTTP 服務的主機。

本地底圖以全球概覽為基礎，東經 95°–165°、南緯 5°–北緯 55° 使用較詳細的海岸資料，涵蓋台灣與西北太平洋。高倍率縮放沿用本地海岸輪廓，不會下載額外的街道細節。海岸資料採快照，不會自動更新。

## 地圖操作

- 拖曳、滾輪或雙指手勢移動及縮放；「重設」會顯示路徑全貌及台灣。
- 點擊預測點查看詳細資料；名稱聚焦、來源勾選及兩條時間軸保留原操作方式。
- 設定面板可選低彩度淺色、自然色或深色底圖，所有模式均不顯示地名或行政／海上國界線。
- 分享連結包含 Leaflet 地圖中心與縮放比例。

底圖圖層由 `basemap-style.json` 管理，只使用陸地底色及本地海岸／水域資料，不加入地名或邊界圖層；配色與互動由 `map.js` 管理，網頁外觀由 `map.css` 管理。

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
