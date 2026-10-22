/* Leaflet 1.9.4 + OpenStreetMap. Weather data is supplied by the page. */
class TyphoonMap {
  constructor(id, onSelect) {
    this.onSelect = onSelect;
    this.map = L.map(id, {
      zoomControl: false, attributionControl: true, minZoom: 2, maxZoom: 18,
      zoomSnap: 0.5, zoomDelta: 0.5, scrollWheelZoom: true,
      maxBounds: [[-80, -180], [80, 180]], maxBoundsViscosity: 0.8
    });
    this.map.attributionControl.setPrefix('<a href="https://leafletjs.com/">Leaflet</a>');
    // All coastlines are local, simplified OSM geometry; no remote tile requests.
    // No symbol/label layers or administrative/maritime boundary source layers.
    this.coastlines = this.loadCoastlines();
    this.coastlines.catch(() => {}); // Report preparation errors when the style is ready.
    this.tiles = L.maplibreGL({ style: 'basemap-style.json', attributionControl: false });
    this.tiles.addTo(this.map);
    this.map.attributionControl.addAttribution('<a href="https://openfreemap.org/" target="_blank" rel="noopener">OpenFreeMap</a> · <a href="https://openmaptiles.org/" target="_blank" rel="noopener">© OpenMapTiles</a> · <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap contributors</a>');
    const status = document.querySelector('#mapStatus');
    this.map.whenReady(() => {
      this.gl = this.tiles.getMaplibreMap();
      this.gl.on('style.load', async () => {
        this.setStyle(this.style || 'light');
        try {
          const geometry = await this.coastlines;
          this.basemapReady = true;
          this.gl.getSource('coastlines').setData(geometry);
        } catch (_) {
          status.textContent = '本地底圖無法載入，請重新整理頁面。';
          status.classList.remove('hide');
        }
      });
      this.gl.on('idle', () => { if (this.basemapReady && this.gl.isSourceLoaded('coastlines') && this.gl.areTilesLoaded()) status.classList.add('hide'); });
      this.gl.on('error', () => {
        status.textContent = '本地底圖無法載入，請重新整理頁面。';
        status.classList.remove('hide');
      });
    });
    L.control.scale({ position: 'bottomleft', imperial: false, maxWidth: 100 }).addTo(this.map);
    ['grid', 'history', 'areas', 'tracks', 'points', 'center'].forEach((name, i) => {
      this.map.createPane(name).style.zIndex = 350 + i * 20;
    });
    this.group = L.layerGroup().addTo(this.map);
    this.map.on('moveend zoomend', () => this.updateView());
    this.resizeObserver = new ResizeObserver(() => {
      cancelAnimationFrame(this.resizeFrame);
      this.resizeFrame = requestAnimationFrame(() => this.map.invalidateSize({ pan: false }));
    });
    this.resizeObserver.observe(document.getElementById(id));
    this.setStyle('light');
  }

  async loadCoastlines() {
    const compressed = 'DecompressionStream' in window;
    const response = await fetch(compressed ? 'data/basemap/water.geojson.gz' : 'data/basemap/water.geojson');
    if (!response.ok) throw new Error('Local coastline data unavailable');
    if (!compressed || response.headers.get('Content-Encoding') === 'gzip') return response.json();
    const decoded = response.body.pipeThrough(new DecompressionStream('gzip'));
    return new Response(decoded).json();
  }

  updateView() {
    const center = this.map.getCenter();
    this.view = { center: [center.lat, center.lng], zoom: this.map.getZoom() };
  }

  restoreView(view) {
    if (Array.isArray(view?.center) && view.center.length === 2 &&
        view.center.every(Number.isFinite) && Number.isFinite(view.zoom)) {
      this.map.setView(view.center, Math.max(2, Math.min(18, view.zoom)), { animate: false });
    }
  }

  setStyle(style) {
    this.style = style;
    document.getElementById('map').dataset.bm = style;
    if (!this.gl?.getLayer('water')) return;
    const palettes = {
      light: ['#f5f5ef', '#e1e8da', '#dce9ed', '#b5ced5', '#e1dfd6'],
      standard: ['#f5f2e8', '#d6e5c5', '#bcdde9', '#8dbfce', '#e1dac7'],
      dark: ['#27333c', '#304139', '#17242f', '#3e5866', '#3a4852']
    };
    const c = palettes[style] || palettes.light;
    this.gl.setPaintProperty('land', 'background-color', c[0]);
    
    this.gl.setPaintProperty('water', 'fill-color', c[2]);
    this.gl.setPaintProperty('water', 'fill-outline-color', c[3]);
    
    
  }

  reset() {
    if (!this.snapshot) return;
    const { history, series } = this.snapshot;
    // Keep Taiwan visible as geographical context, including with all sources hidden.
    const bounds = L.latLngBounds([[21.8, 120], [25.5, 122.3]]);
    history.forEach(p => bounds.extend([p[1], p[0]]));
    series.forEach(s => s.points.forEach(p => bounds.extend([p.lat, p.lon])));
    const dockHeight = document.getElementById('dock').getBoundingClientRect().height;
    const height = this.map.getSize().y;
    this.map.fitBounds(bounds, {
      paddingTopLeft: [56, 64],
      paddingBottomRight: [36, Math.min(dockHeight + 52, height * 0.45)],
      maxZoom: 6, animate: false
    });
  }

  render(snapshot) {
    const changed = this.snapshot?.typhoon.id !== snapshot.typhoon.id;
    this.snapshot = snapshot;
    // Establish the real storm viewport before requesting any map tiles.
    if (changed) this.reset();
    this.group.clearLayers();
    const { history, actual, layers, opacity, highlight, hour, series, selected } = snapshot;
    const add = layer => layer.addTo(this.group);
    const line = (coords, options) => add(L.polyline(coords, {
      interactive: false, lineCap: 'round', lineJoin: 'round', ...options
    }));
    if (layers.grid) {
      for (let lon = 100; lon <= 160; lon += 5)
        line([[0, lon], [50, lon]], { pane: 'grid', color: '#63808a', weight: 0.7, opacity: 0.16, dashArray: '3 7' });
      for (let lat = 0; lat <= 50; lat += 5)
        line([[lat, 100], [lat, 160]], { pane: 'grid', color: '#63808a', weight: 0.7, opacity: 0.16, dashArray: '3 7' });
    }
    if (layers.hist) {
      line(history.map(p => [p[1], p[0]]), { pane: 'history', color: '#647780', weight: 2, opacity: 0.65 * opacity });
      history.forEach(p => add(L.circleMarker([p[1], p[0]], {
        pane: 'history', radius: 2.5, color: '#fff', weight: 1,
        fillColor: '#647780', fillOpacity: opacity, opacity, interactive: false
      })));
    }
    series.forEach(({ agency, batch, previous, points }) => {
      const dim = highlight && highlight !== agency.k ? 0.12 : 1;
      const alpha = dim * opacity;
      const latlngs = ps => ps.map(p => [p.lat, p.lon]);
      if (layers.trk && points.length > 1) {
        // White casing keeps overlapping tracks legible against city labels and coastlines.
        line(latlngs(points), { pane: 'tracks', color: '#fff', weight: 5, opacity: alpha * 0.7 });
        const past = points.filter(p => p.h <= hour), future = points.filter(p => p.h >= hour);
        if (past.length > 1) line(latlngs(past), {
          pane: 'tracks', color: agency.c, weight: highlight === agency.k ? 3.5 : 2.5,
          opacity: alpha, dashArray: previous ? '5 5' : null
        });
        if (future.length > 1) line(latlngs(future), {
          pane: 'tracks', color: agency.c, weight: 2,
          opacity: alpha * 0.75, dashArray: '5 6'
        });
      }
      points.forEach(p => {
        const current = p.h === hour;
        if (layers.cone && !previous && p.h > 0 && p.h <= hour) add(L.circle([p.lat, p.lon], {
          pane: 'areas', radius: p.cone * 1000, stroke: false,
          fillColor: agency.c, fillOpacity: alpha * 0.07, interactive: false
        }));
        if (layers.r30 && current && p.r30) add(L.circle([p.lat, p.lon], {
          pane: 'areas', radius: p.r30 * 1000, color: agency.c,
          weight: 1.2, opacity: alpha, dashArray: '4 5',
          fillColor: agency.c, fillOpacity: alpha * 0.035, interactive: false
        }));
        const pointAlpha = alpha * (p.h <= hour ? 1 : 0.8);
        if (layers.pt) {
          const marker = add(L.circleMarker([p.lat, p.lon], {
            pane: 'points', radius: (layers.int ? 2.3 + p.w / 18 : 4) * (current ? 1.4 : 1),
            color: '#fff', weight: current ? 2 : 1.3,
            fillColor: agency.c, fillOpacity: pointAlpha,
            opacity: pointAlpha, className: 'pt'
          }));
          Object.assign(marker.getElement().dataset, { a: agency.k, h: p.h, b: batch });
          marker.bindTooltip(`${agency.k} +${p.ld}h · ${p.lat.toFixed(1)}°N ${p.lon.toFixed(1)}°E<br>${p.w} m/s · ${p.p} hPa（模擬）`, {
            direction: 'top', offset: [0, -6], className: 'forecast-tooltip'
          });
          marker.on('click', () => this.onSelect(agency.k, p.h, batch));
        }
        if (layers.lbl && p.h > 0 && (current || p.h % 24 === 0)) {
          add(L.marker([p.lat, p.lon], {
            pane: 'points', interactive: false, opacity: alpha,
            icon: L.divIcon({ className: 'forecast-label', html: `+${p.ld}h`, iconSize: [44, 18], iconAnchor: [-8, 15] })
          }));
        }
        if (selected?.a === agency.k && selected.h === p.h && selected.b === batch)
          add(L.circleMarker([p.lat, p.lon], { pane: 'center', radius: 11,
            color: agency.c, weight: 2, fillOpacity: 0, interactive: false }));
      });
    });
    add(L.marker([actual[1], actual[0]], {
      pane: 'center', interactive: false, opacity,
      icon: L.divIcon({ className: 'storm-center', html: '<span></span>', iconSize: [22, 22], iconAnchor: [11, 11] })
    })).bindTooltip('歷史位置（模擬）', { permanent: true, direction: 'right', offset: [12, 0], className: 'center-label', opacity });
  }
}
