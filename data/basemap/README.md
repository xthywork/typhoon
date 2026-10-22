# 本地海岸與水域資料

© OpenStreetMap contributors. 資料採 [Open Database License 1.0（ODbL）](https://opendatacommons.org/licenses/odbl/1-0/) 授權。
原始資料透過 OpenFreeMap 的 OpenMapTiles 圖磚取得；來源快照與下載量記錄於 `provenance.json`。

此衍生資料庫經下列處理：抽出水域多邊形、移除圖磚緩衝重疊、合併幾何、以詳細區域取代全球概覽對應區域，並簡化座標及移除小型內陸水域。資料不包含地名、行政界線或海上國界線。

機器可讀的完整衍生資料為同目錄的 `water.geojson`；`water.geojson.gz` 為相同資料的 gzip 壓縮版本。兩個檔案均隨網站提供下載，使用相同的 ODbL 1.0 授權。

較詳細的區域：東經 95°–165°、南緯 5°–北緯 55°；其他地區為概覽精度。高倍率放大不會提供新增細節。資料僅用於地圖背景，不適用於航海或測量。

可用 `uv run scripts/build-local-basemap.py` 重新建置。
