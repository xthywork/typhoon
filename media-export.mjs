// Capture the existing WebGL basemap and Leaflet overlays locally. No uploads.
const abort = signal => signal.throwIfAborted();
const pause = () => new Promise(resolve => setTimeout(resolve, 0));

async function basemap(view, signal, pixelRatio = 1) {
  const gl = view.gl;
  if (!gl) throw new Error('地圖尚未準備好，請稍後再試。');
  const start = performance.now();
  while (!view.basemapReady || !gl.isStyleLoaded() || !gl.areTilesLoaded()) {
    abort(signal);
    if (performance.now() - start > 15000) throw new Error('底圖載入逾時，請稍後再試。');
    await new Promise(resolve => setTimeout(resolve, 80));
  }
  view.map.stop();
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); gl.off('render', capture); signal.removeEventListener('abort', cancel); };
    const cancel = () => { cleanup(); reject(signal.reason); };
    const capture = () => {
      try {
        abort(signal);
        const root = view.map.getContainer().getBoundingClientRect(), source = gl.getCanvas();
        const rect = source.getBoundingClientRect(), canvas = document.createElement('canvas');
        canvas.width = Math.round(root.width * pixelRatio); canvas.height = Math.round(root.height * pixelRatio);
        const ctx = canvas.getContext('2d'); ctx.scale(pixelRatio, pixelRatio);
        ctx.fillStyle = getComputedStyle(view.map.getContainer()).backgroundColor;
        ctx.fillRect(0, 0, root.width, root.height);
        // Copy inside the WebGL render event, before its drawing buffer is cleared.
        ctx.drawImage(source, rect.left - root.left, rect.top - root.top, rect.width, rect.height);
        cleanup(); resolve(canvas);
      } catch (error) { cleanup(); reject(error); }
    };
    const timer = setTimeout(() => { cleanup(); reject(new Error('地圖擷取逾時，請再試一次。')); }, 10000);
    signal.addEventListener('abort', cancel, { once: true });
    gl.once('render', capture); gl.triggerRepaint();
  });
}

async function svgImage(svg, signal, scale) {
  abort(signal);
  const clone = svg.cloneNode(true);
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('style', 'overflow:visible');
  clone.setAttribute('width', Number(svg.getAttribute('width')) * scale);
  clone.setAttribute('height', Number(svg.getAttribute('height')) * scale);
  const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(clone)], { type: 'image/svg+xml' }));
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    abort(signal);
    return image;
  } finally { URL.revokeObjectURL(url); }
}

function text(ctx, value, x, y, size, color, weight = 400, maxWidth) {
  ctx.font = `${weight} ${size}px system-ui, sans-serif`; ctx.fillStyle = color;
  ctx.fillText(value, x, y, maxWidth);
}

// The editor footer and output frames use this exact drawing function.
function footerHeight(width) { return width < 520 ? 140 : 116; }
function paintFooter(ctx, width, info) {
  const height = footerHeight(width), compact = width < 520;
  const color = info.dark ? '#edf2f5' : '#273b48', muted = info.dark ? '#a4b3bc' : '#647780';
  ctx.fillStyle = info.dark ? '#17242f' : '#ffffff'; ctx.fillRect(0, 0, width, height);
  const padding = 12, gap = 16, leftWidth = (width - padding * 2 - gap) * .52, rightX = padding + leftWidth + gap;
  text(ctx, info.name, padding, 23, compact ? 14 : 16, color, 600, leftWidth);
  text(ctx, `${info.zone} · ${info.speed}× · ${info.mode}`, rightX, 23, 10, muted, 400, width - rightX - padding);
  text(ctx, `颱風 ${info.actual}`, padding, 44, 11, color, 400, leftWidth);
  text(ctx, `預報 ${info.batch}`, rightX, 44, 11, color, 400, width - rightX - padding);
  const legendColumns = Math.max(1, Math.floor(leftWidth / 64));
  info.agencies.forEach((agency, i) => {
    const x = padding + (i % legendColumns) * 64, y = 64 + Math.floor(i / legendColumns) * 16;
    ctx.fillStyle = agency.c; ctx.fillRect(x, y - 4, 10, 3);
    text(ctx, agency.k, x + 15, y, 10, color);
  });
  text(ctx, '資料更新', rightX, 65, 9, muted, 400, width - rightX - padding);
  text(ctx, info.updated, rightX, 81, 10, muted, 400, width - rightX - padding);
  ctx.strokeStyle = info.dark ? '#34444f' : '#e4eaed'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(padding, height - 22); ctx.lineTo(width - padding, height - 22); ctx.stroke();
  text(ctx, 'Leaflet · OpenFreeMap · © OpenMapTiles · © OpenStreetMap contributors', padding, height - 8, 9, muted, 400, width - padding * 2);
}

async function frame(view, base, info, resolution, signal) {
  abort(signal);
  const root = view.map.getContainer(), bounds = root.getBoundingClientRect();
  const width = Math.round(bounds.width), height = Math.round(bounds.height);
  const footer = footerHeight(width), scale = resolution / Math.max(width, height + footer);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale)); canvas.height = Math.max(1, Math.round((height + footer) * scale));
  const ctx = canvas.getContext('2d'); ctx.scale(scale, scale);
  ctx.fillStyle = info.dark ? '#17242f' : '#ffffff'; ctx.fillRect(0, 0, width, height + footer);
  ctx.drawImage(base, 0, 0, width, height);
  ctx.save(); ctx.beginPath(); ctx.rect(0, 0, width, height); ctx.clip();
  const panes = [...root.querySelectorAll('.leaflet-pane')].sort((a, b) =>
    (parseInt(getComputedStyle(a).zIndex) || 0) - (parseInt(getComputedStyle(b).zIndex) || 0));
  for (const pane of panes) {
    for (const svg of [...pane.children].filter(el => el.tagName.toLowerCase() === 'svg')) {
      const rect = svg.getBoundingClientRect();
      if (rect.width && rect.height) ctx.drawImage(await svgImage(svg, signal, scale), rect.left - bounds.left, rect.top - bounds.top, rect.width, rect.height);
    }
    for (const marker of [...pane.children].filter(el => el.matches('.forecast-label,.storm-center'))) {
      const rect = marker.getBoundingClientRect(), style = getComputedStyle(marker);
      const x = rect.left - bounds.left, y = rect.top - bounds.top;
      ctx.save(); ctx.globalAlpha = Number(style.opacity);
      if (marker.matches('.storm-center')) {
        ctx.beginPath(); ctx.arc(x + rect.width / 2, y + rect.height / 2, rect.width / 2 - 1, 0, Math.PI * 2);
        ctx.fillStyle = '#fff'; ctx.fill(); ctx.strokeStyle = '#c43d3d'; ctx.lineWidth = 2; ctx.stroke();
        ctx.beginPath(); ctx.arc(x + rect.width / 2, y + rect.height / 2, 3, 0, Math.PI * 2); ctx.fillStyle = '#c43d3d'; ctx.fill();
      } else {
        ctx.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
        ctx.strokeStyle = info.dark ? '#152029' : '#fff'; ctx.lineWidth = 3; ctx.lineJoin = 'round';
        ctx.strokeText(marker.textContent, x, y + 13); ctx.fillStyle = style.color; ctx.fillText(marker.textContent, x, y + 13);
      }
      ctx.restore();
    }
  }
  // Keep a scale and the full basemap credit in every exported frame.
  const ruler = root.querySelector('.leaflet-control-scale-line');
  if (ruler) {
    const length = ruler.getBoundingClientRect().width;
    ctx.fillStyle = '#ffffffe6'; ctx.fillRect(10, height - 37, length + 12, 29);
    text(ctx, ruler.textContent, 16, height - 20, 10, '#435964');
    ctx.strokeStyle = '#647780'; ctx.lineWidth = 1; ctx.beginPath();
    ctx.moveTo(16, height - 17); ctx.lineTo(16, height - 12); ctx.lineTo(16 + length, height - 12); ctx.lineTo(16 + length, height - 17); ctx.stroke();
  }
  ctx.restore();
  ctx.save(); ctx.translate(0, height); paintFooter(ctx, width, info); ctx.restore();
  return canvas;
}

let active = false;
export async function openMediaExport(api) {
  if (active) return;
  active = true;
  const dialog = document.querySelector('#mediaExport'), format = dialog.querySelector('[name=format]');
  const resolution = dialog.querySelector('[name=resolution]'), mapHeight = dialog.querySelector('[name=mapHeight]');
  const status = dialog.querySelector('[role=status]'), progress = dialog.querySelector('progress');
  const generate = dialog.querySelector('[data-generate]'), close = dialog.querySelector('[data-close]');
  const download = dialog.querySelector('[data-download]'), preview = dialog.querySelector('img');
  const host = dialog.querySelector('#exportMapHost'), footer = dialog.querySelector('#exportFooter');
  const result = dialog.querySelector('[data-result]'), dimensions = dialog.querySelector('[data-dimensions]');
  let controller = null, resultURL = null, running = false;
  const saved = api.begin(), root = api.view.map.getContainer();
  const placeholder = document.createComment('export-map-return'); root.before(placeholder);
  const originalPixelRatio = api.view.gl?.getPixelRatio() || devicePixelRatio;
  const initialBounds = api.view.map.getBounds(), scalePosition = api.view.scaleControl.getPosition();
  const initialView = {center: [api.view.map.getCenter().lat, api.view.map.getCenter().lng], zoom: api.view.map.getZoom()};
  const { frameDelayMs, multiplier } = api.timing;
  const tracks = api.tracks(), count = Math.max(0, ...tracks.map(track => track.times.length));
  const interactions = ['dragging','touchZoom','doubleClickZoom','scrollWheelZoom','boxZoom','keyboard'];
  const enabledInteractions = interactions.filter(key => api.view.map[key]?.enabled());
  const lock = locked => enabledInteractions.forEach(key => locked ? api.view.map[key].disable() : api.view.map[key].enable());
  const clearResult = () => {
    if (resultURL) URL.revokeObjectURL(resultURL);
    resultURL = null; download.hidden = true; result.hidden = true; preview.removeAttribute('src');
  };
  const edited = () => {if (!running) clearResult();};
  api.view.map.on('dragstart zoomstart', edited);
  const layout = () => {
    const width = Math.round(host.getBoundingClientRect().width);
    if (!width) return;
    host.style.height = `${Math.round(width * Number(mapHeight.value) / 100)}px`;
    dialog.querySelector('[data-map-height]').textContent = `${mapHeight.value}%`;
    const h = footerHeight(width), ratio = Number(resolution.value) / Math.max(width, Math.round(width * Number(mapHeight.value) / 100) + h);
    footer.width = Math.round(width * devicePixelRatio); footer.height = Math.round(h * devicePixelRatio);
    footer.style.height = `${h}px`;
    const ctx = footer.getContext('2d'); ctx.scale(devicePixelRatio, devicePixelRatio); paintFooter(ctx, width, api.info());
    dimensions.textContent = `${Math.round(width * ratio)} × ${Math.round((Math.round(width * Number(mapHeight.value) / 100) + h) * ratio)} px`;
    if (!running) {const center = api.view.map.getCenter(), zoom = api.view.map.getZoom(); api.view.map.invalidateSize({pan: true, animate: false}); api.view.map.setView(center, zoom, {animate: false, reset: true});}
  };
  const describe = () => {
    if (running) return;
    generate.disabled = format.value === 'gif' && count < 2;
    status.textContent = format.value === 'gif' ? (count < 2 ? '目前勾選的時間軸沒有足夠資料可製作動圖。' : `${multiplier}× · 每格 ${frameDelayMs / 1000} 秒 · ${count} 格，共 ${(count * frameDelayMs / 1000).toFixed(1)} 秒 · ${api.loop ? '循環播放' : '播放一次'}`) : '匯出預覽中的地圖與資訊欄，時間位置沿用目前選取。';
  };
  const resize = () => {
    if (running) controller.abort(new DOMException('畫面尺寸已改變，請重新匯出。', 'AbortError'));
    else layout();
  };
  let observedWidth = 0;
  const observer = new ResizeObserver(() => {const width = Math.round(host.getBoundingClientRect().width); if (width !== observedWidth) {observedWidth = width; resize();}});
  const controls = [...dialog.querySelectorAll('select,input,[data-map-zoom],[data-reset-view]')];
  window.addEventListener('resize', resize);
  dialog.oncancel = event => { if (running) { event.preventDefault(); controller.abort(); } };
  dialog.onclose = () => {
    controller?.abort(); clearResult(); api.view.map.off('dragstart zoomstart', edited); observer.disconnect(); window.removeEventListener('resize', resize);
    lock(false); api.view.gl?.setPixelRatio(originalPixelRatio);
    placeholder.replaceWith(root); api.view.map.invalidateSize({pan: true, animate: false});
    api.view.scaleControl.setPosition(scalePosition);
    api.view.map.setView(initialView.center, initialView.zoom, {animate: false, reset: true}); api.end(saved); active = false;
  };
  close.onclick = () => running ? controller.abort() : dialog.close();
  format.onchange = () => { clearResult(); describe(); };
  resolution.onchange = () => { clearResult(); layout(); };
  mapHeight.oninput = () => { clearResult(); layout(); };
  for (const button of dialog.querySelectorAll('[data-map-zoom]')) button.onclick = () => api.view.map.setZoom(api.view.map.getZoom() + Number(button.dataset.mapZoom), {animate: false});
  dialog.querySelector('[data-reset-view]').onclick = () => api.view.map.fitBounds(initialBounds, {animate: false});
  generate.onclick = async () => {
    if (running) return;
    running = true; controller = new AbortController(); const { signal } = controller;
    const outputResolution = Number(resolution.value);
    generate.disabled = true; controls.forEach(el => el.disabled = true); lock(true); close.textContent = '取消匯出';
    clearResult(); progress.hidden = false; progress.value = 0; progress.max = format.value === 'gif' ? count : 1;
    try {
      status.textContent = '正在準備高解析度地圖…';
      api.view.map.stop();
      const bounds = root.getBoundingClientRect();
      const pixelRatio = outputResolution / Math.max(Math.round(bounds.width), Math.round(bounds.height) + footerHeight(Math.round(bounds.width)));
      api.view.gl?.setPixelRatio(pixelRatio);
      const base = await basemap(api.view, signal, pixelRatio);
      let blob;
      if (format.value === 'gif') {
        const { GIFEncoder, quantize, applyPalette } = await import('./vendor/gifenc/gifenc.mjs');
        const encoder = GIFEncoder();
        for (let i = 0; i < count; i++) {
          abort(signal); api.setFrame(tracks, i);
          status.textContent = `正在產生高畫質動圖 ${i + 1} / ${count}`; await pause();
          const canvas = await frame(api.view, base, api.info(), outputResolution, signal);
          const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
          const palette = quantize(data, 256);
          encoder.writeFrame(applyPalette(data, palette), canvas.width, canvas.height, { palette, delay: frameDelayMs, repeat: api.loop ? 0 : -1 });
          progress.value = i + 1;
        }
        abort(signal); encoder.finish(); blob = new Blob([encoder.bytes()], { type: 'image/gif' });
      } else {
        const canvas = await frame(api.view, base, api.info(), outputResolution, signal);
        blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
        if (!blob) throw new Error('圖片產生失敗，請再試一次。');
        progress.value = 1;
      }
      abort(signal);
      resultURL = URL.createObjectURL(blob); download.href = resultURL;
      download.download = `${api.filename}.${format.value}`; download.hidden = false;
      preview.src = resultURL; result.hidden = false;
      status.textContent = `已完成 · ${dimensions.textContent}${format.value === 'gif' ? ` · ${multiplier}×` : ''} · ${(blob.size / 1024 / 1024).toFixed(1)} MB，若未自動下載，請按下載按鈕。`;
      download.click();
    } catch (error) {
      status.textContent = error.name === 'AbortError' ? '已取消匯出，可重新產生。' : `匯出失敗：${error.message}`;
    } finally {
      api.view.gl?.setPixelRatio(originalPixelRatio);
      api.restore(saved); running = false; controls.forEach(el => el.disabled = false); lock(false);
      generate.disabled = format.value === 'gif' && count < 2; close.textContent = '關閉'; progress.hidden = true; layout();
    }
  };
  clearResult(); progress.hidden = true; controls.forEach(el => el.disabled = false); close.textContent = '關閉';
  dialog.showModal(); host.append(root); api.view.scaleControl.setPosition('bottomleft'); layout(); api.view.map.fitBounds(initialBounds, {animate: false}); observedWidth = Math.round(host.getBoundingClientRect().width); observer.observe(host);
  describe();
}
