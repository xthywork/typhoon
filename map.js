/* Leaflet 1.9.4 + OpenStreetMap. Weather data is supplied by the page. */
// Display-only easing between quadrant radii. Each quadrant keeps its official
// radius through the middle of its arc; transitions stay between adjacent values.
function windQuadrantPolygon(point, radii) {
  const quadrants = ['NE', 'SE', 'SW', 'NW'];
  if (!radii || !quadrants.every(key => Number.isFinite(radii[key]) && radii[key] > 0)) return null;
  const rad = Math.PI / 180, lat = point.lat * rad, lon = point.lon * rad, outline = [];
  const transition = 14;
  for (let angle = 0; angle < 360; angle += 2) {
    const quadrant = Math.floor(angle / 90), offset = angle % 90;
    let radius = radii[quadrants[quadrant]];
    if (offset < transition || offset > 90 - transition) {
      const boundary = offset < transition ? quadrant : (quadrant + 1) % 4;
      const delta = offset < transition ? offset : offset - 90;
      const t = (delta + transition) / (2 * transition);
      const blend = (1 - Math.cos(Math.PI * t)) / 2;
      const before = radii[quadrants[(boundary + 3) % 4]], after = radii[quadrants[boundary]];
      radius = before + (after - before) * blend;
    }
    const distance = radius / 6371, bearing = angle * rad;
    const y = Math.asin(Math.sin(lat) * Math.cos(distance) + Math.cos(lat) * Math.sin(distance) * Math.cos(bearing));
    const x = lon + Math.atan2(Math.sin(bearing) * Math.sin(distance) * Math.cos(lat), Math.cos(distance) - Math.sin(lat) * Math.sin(y));
    outline.push([y / rad, x / rad]);
  }
  return outline;
}


// SVG curves avoid the pixel-rounded polygon corners at close zoom levels.
// Keep the original geographic vertices for bounds and Leaflet layer metadata.
function smoothWindArea(outline, options) {
  const shape = L.polygon(outline, options), updatePath = shape._updatePath;
  shape._updatePath = function () {
    // The bundled Leaflet SVG renderer supports path strings; retain its
    // normal polygon rendering if a caller explicitly uses the Canvas renderer.
    if (typeof this._renderer._setPath !== 'function') return updatePath.call(this);
    const origin = this._map.getPixelOrigin();
    const points = this.getLatLngs()[0].map(point => this._map.project(point).subtract(origin));
    const size = points.length;
    if (size < 3) return updatePath.call(this);
    const coordinate = point => `${point.x.toFixed(3)},${point.y.toFixed(3)}`;
    let path = `M${coordinate(points[0])}`;
    for (let i = 0; i < size; i++) {
      const previous = points[(i + size - 1) % size], current = points[i];
      const next = points[(i + 1) % size], after = points[(i + 2) % size];
      const first = L.point(current.x + (next.x - previous.x) / 6, current.y + (next.y - previous.y) / 6);
      const second = L.point(next.x - (after.x - current.x) / 6, next.y - (after.y - current.y) / 6);
      path += `C${coordinate(first)} ${coordinate(second)} ${coordinate(next)}`;
    }
    this._renderer._setPath(this, path + 'Z');
  };
  return shape;
}

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
    // Initialize the local basemap even when no cyclone is active.
    this.map.setView([23.5, 128], 4, { animate: false });
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

  clearWeather() { this.group.clearLayers(); this.snapshot = null; }

  nodeTooltip(point, agency, snapshot) {
    const date=snapshot.formatTime(point.time),wind=point.w==null?'未提供':point.w.toFixed(1)+' m/s',pressure=point.p==null?'未提供':point.p+' hPa';
    const tooltip=document.createElement('span'),title=document.createElement('strong');
    title.textContent=agency;
    tooltip.append(title,document.createElement('br'),document.createTextNode(date),
      document.createElement('br'),document.createTextNode(`風速 ${wind} · 氣壓 ${pressure}`));
    return tooltip;
  }

  render(snapshot) {
    const changed = this.snapshot?.typhoon.id !== snapshot.typhoon.id;
    this.snapshot = snapshot;
    // Establish the real storm viewport before requesting any map tiles.
    if (changed) this.reset();
    this.group.clearLayers();
    const { history, actual, layers, opacity, highlight, hour, series, selected, weather } = snapshot;
    const dark = this.style === 'dark';
    const add = layer => layer.addTo(this.group);
    const line = (coords, options) => add(L.polyline(coords, {
      interactive: false, lineCap: 'round', lineJoin: 'round', ...options
    }));
    if (layers.grid) {
      for (let lon = 100; lon <= 160; lon += 5)
        line([[0, lon], [50, lon]], { pane: 'grid', color: '#63808a', weight: 0.6, opacity: dark ? 0.16 : 0.1, dashArray: '2 8' });
      for (let lat = 0; lat <= 50; lat += 5)
        line([[lat, 100], [lat, 160]], { pane: 'grid', color: '#63808a', weight: 0.6, opacity: dark ? 0.16 : 0.1, dashArray: '2 8' });
    }
    if (layers.hist) {
      line(history.map(p => [p[1], p[0]]), { pane: 'history', color: dark ? '#9aaab4' : '#738791', weight: 1.35, opacity: 0.55 * opacity });
      history.forEach((p,index) => {
        add(L.circleMarker([p[1],p[0]],{pane:'history',radius:1.9,color:dark?'#27333c':'#fff',weight:.8,fillColor:dark?'#a5b3bb':'#738791',fillOpacity:.75*opacity,opacity:.8*opacity,interactive:false}));
        const record=snapshot.historyRecords?.[index];
        if(record){const target=add(L.circleMarker([p[1],p[0]],{pane:'history',radius:12,stroke:false,fillOpacity:0,interactive:true,className:'history-node node-hit'}));
          target.bindTooltip(this.nodeTooltip(record,snapshot.historyAgency,snapshot),{direction:'top',offset:[0,-10],className:'forecast-tooltip',sticky:true});}
      });
    }

    if(weather?.point){
      const p=weather.point;
      for(const [layer,radiusField,quadrantField,color,level] of [
        ['wind15','windRadius15ms','windRadii15ms',dark?'#d3b37d':'#b39158','15'],
        ['wind25','windRadius25ms','windRadii25ms',dark?'#d69b98':'#b97573','25']]){
        if(!layers[layer])continue;
        const radius=p[radiusField],outline=windQuadrantPolygon(p,p[quadrantField]);
        if(!outline&&!(Number.isFinite(radius)&&radius>0))continue;
        const options={pane:'areas',color,weight:1.05,opacity:(dark?.8:.7)*opacity,
          fillColor:color,fillOpacity:(level==='15'?.045:.065)*opacity,
          lineCap:'round',lineJoin:'round',smoothFactor:.25,interactive:false,className:'wind-area wind-'+level};
        const shape=outline?smoothWindArea(outline,options):L.circle([p.lat,p.lon],{...options,radius:radius*1000});
        add(shape);Object.assign(shape.getElement().dataset,{agency:weather.agency.k,
          time:p.time,radius:radius??'',geometry:outline?'quadrants':'circle',rendering:outline?'smoothed':'circle'});
      }
    }
    series.forEach(({ agency, batch, previous, points }) => {
      const dim = highlight && highlight !== agency.k ? 0.12 : 1;
      const alpha = dim * opacity;
      const latlngs = ps => ps.map(p => [p.lat, p.lon]);
      if (layers.trk && points.length > 1) {
        // A narrow casing separates overlapping providers without heavy outlines.
        line(latlngs(points), { pane: 'tracks', color: dark ? '#17242f' : '#fff', weight: 3.2, opacity: alpha * 0.55 });
        line(latlngs(points), {
          pane: 'tracks', color: agency.c, weight: highlight === agency.k ? 2.25 : 1.65,
          opacity: alpha * (dark ? .9 : .82), dashArray: previous ? '3 6' : '5 5'
        });
      }
      points.forEach(p => {
        const current = p.h === hour;
        if (layers.cone && !previous && agency.k===weather?.agency.k && p.ld>0 && p.cone>0 &&
            (!selected || (selected.a===agency.k && selected.h===p.h && selected.b===batch))) {
          const area=add(L.circle([p.lat,p.lon],{
            pane:'areas',radius:p.cone*1000,color:dark?'#9db5cc':'#7c99b4',weight:.85,
            opacity:alpha*(selected?.a===agency.k?.65:.35),dashArray:'2 6',
            fillColor:'#7c99b4',fillOpacity:alpha*(selected?.a===agency.k?.045:.018),
            interactive:false,className:'probability-area'
          }));Object.assign(area.getElement().dataset,{agency:agency.k,lead:p.ld,radius:p.cone});
        }
        if (layers.r30 && current && p.r30) add(L.circle([p.lat, p.lon], {
          pane: 'areas', radius: p.r30 * 1000, color: agency.c,
          weight: 1, opacity: alpha * .65, dashArray: '3 6',
          fillColor: agency.c, fillOpacity: alpha * 0.025, interactive: false
        }));
        const pointAlpha = alpha * (p.h <= hour ? 1 : 0.8);
        if (layers.pt) {
          const radius=(layers.int?2.2+Math.max(0,Math.min(80,p.w??20))/35:3.2)*(current?1.2:1);
          add(L.circleMarker([p.lat,p.lon],{pane:'points',radius,color:dark?'#17242f':'#fff',weight:current?1.3:1,fillColor:agency.c,fillOpacity:pointAlpha,opacity:pointAlpha,interactive:false,className:'forecast-dot'}));
          const marker=add(L.circleMarker([p.lat,p.lon],{pane:'points',radius:Math.max(12,radius+8),stroke:false,fillOpacity:0,interactive:true,className:'pt node-hit'}));
          Object.assign(marker.getElement().dataset,{a:agency.k,h:p.h,b:batch});
          marker.bindTooltip(this.nodeTooltip(p,agency.k,snapshot),{direction:'top',offset:[0,-10],className:'forecast-tooltip',sticky:true});
          marker.on('click', () => this.onSelect(agency.k, p.h, batch));
        }
        if (layers.lbl && p.h > 0 && (current || p.h % 24 === 0)) {
          add(L.marker([p.lat, p.lon], {
            pane: 'points', interactive: false, opacity: alpha,
            icon: L.divIcon({ className: 'forecast-label', html: `+${p.ld}h`, iconSize: [44, 18], iconAnchor: [-8, 15] })
          }));
        }
        if (selected?.a === agency.k && selected.h === p.h && selected.b === batch)
          add(L.circleMarker([p.lat, p.lon], { pane: 'center', radius: 8,
            color: agency.c, weight: 1.2, opacity: .75, fillOpacity: 0, interactive: false }));
      });
    });
    if(actual)add(L.marker([actual[1], actual[0]], {
      pane: 'center', interactive: false, opacity,
      icon: L.divIcon({ className: 'storm-center', html: '<span></span>', iconSize: [12, 12], iconAnchor: [6, 6] })
    }));
  }
}
