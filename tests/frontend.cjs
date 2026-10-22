// Isolated browser regressions. All requests use local assets or fixtures; no API quota is used.
// Requires Playwright (via node resolution/NODE_PATH) and its Chromium, or
// PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH pointing to an installed Chromium.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const ROOT = path.resolve(__dirname, '..');
const T = Date.UTC(2026, 9, 23), H = 3600000;
const AGENCIES = ['CWA', 'JMA', 'KMA', 'HKO', 'JTWC', 'CMA'];
function fixture(version = 'v1') {
  const sources = Object.fromEntries(AGENCIES.map(k => [k, {status: 'ok', message: 'safe', checked: T, succeeded: T}]));
  function storm(id, delta = 0) {
    const history = [0, 6, 12].map(h => ({time: T+h*H, lat: 20+h/10+delta, lon: 130, w: 30, p: 980, windRadius15ms: 100}));
    const batches = [12, 6, 0].map(h => ({issued: T+h*H, base: T+h*H, points: history.map(p => ({...p, time: p.time+h*H}))}));
    return {id, name: id, historyAgency: 'CWA', active: true, history, batchTimes: batches.map(b => b.issued),
      sources: {CWA: {history, batches, url: 'https://example.invalid'}, JMA: {history, batches, url: 'https://example.invalid'}}};
  }
  return {schemaVersion: 1, version, synced: T, sources, typhoons: [storm('storm-A'), storm('storm-B', 10)]};
}
async function main() {
  const browser = await chromium.launch({headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? {executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH} : {}),
    args: ['--enable-unsafe-swiftshader']});
  const errors = [];
  const csp = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; worker-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";
  const assets = new Set(['index.html', 'app.js', 'bootstrap.mjs', 'map.js', 'map.css', 'basemap-style.json', 'data/basemap/water.geojson.gz', 'data/basemap/water.geojson',
    'vendor/leaflet/leaflet.css', 'vendor/leaflet/leaflet.js', 'vendor/maplibre/maplibre-gl.css', 'vendor/maplibre/maplibre-gl.mjs', 'vendor/maplibre/maplibre-gl-shared.mjs', 'vendor/maplibre/maplibre-gl-worker.mjs', 'vendor/maplibre/leaflet-maplibre-gl.js']);
  let cold = false;
  try {
    const page = await browser.newPage({viewport: {width: 1440, height: 900}});
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', msg => {if(msg.type()==='error' && !msg.text().includes('503'))errors.push(msg.text());});
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/api/typhoons') {
        if(cold)return route.fulfill({status:503, json:{error:'initial collection pending'}});
        return route.fulfill({json:fixture()});
      }
      if(url.pathname === '/favicon.ico')return route.fulfill({status:204});
      const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      if(!assets.has(file))return route.abort();
      return route.fulfill({body:fs.readFileSync(path.join(ROOT,file)), headers:{'Content-Security-Policy':csp},
        contentType:(file.endsWith('.js')||file.endsWith('.mjs'))?'application/javascript':file.endsWith('.css')?'text/css':file.endsWith('.html')?'text/html':file.endsWith('.json')||file.endsWith('.geojson')?'application/json':'application/octet-stream'});
    });
    const share = {storm:'storm-A', actual:T, issued:T, a:['CWA'], tz:'8'};
    cold = true;
    await page.goto('http://typhoon.audit/#'+encodeURIComponent(JSON.stringify(share)));
    await page.waitForFunction(() => typeof updateInFlight==='boolean' && !updateInFlight && !D);
    cold = false;
    await page.evaluate(() => refresh({silent:true}));
    await page.waitForFunction(() => !!TY() && mapView.basemapReady && mapView.gl?.isSourceLoaded('coastlines'));
    await page.evaluate(() => clearInterval(updateTimer));
    assert.deepEqual(await page.evaluate(() => [S.actual,selectedBulletinTime(),S.syncTime]), [T,T,T], 'share restores after cold-start 503');
    assert.equal(await page.locator('.storm-center').count(), 1, 'real map works under CSP');
    assert.deepEqual(await page.evaluate(async () => {
      let resolve; DS.load=()=>new Promise(r=>resolve=r);
      const pending=refresh({silent:true}); chooseTyphoon(1);
      resolve({...D,version:'v2'}); await pending;
      return [TY().id,S.actual];
    }), ['storm-B',T+12*H], 'background response preserves a new selection');
    assert.equal(await page.evaluate(async () => {
      DS.load=async()=>{throw Error('offline')};await refresh();
      DS.load=async()=>null;await refresh();return $('#sync').textContent;
    }), '2026/10/23 08:00 UTC+8', '304 clears previous manual-refresh failure');
    assert.equal(await page.evaluate(() => {
      $('#tz').value='0';$('#tz').dispatchEvent(new Event('change'));return $('#sync').textContent;
    }), '2026/10/23 00:00 UTC+0', 'timezone updates the last-update label');
    assert.equal(await page.evaluate(async data => {
      DS.load=async()=>data;await refresh();chooseTyphoon(0);
      showDet('CWA',pts(AG[0],0)[0].h,0);
      DS.load=async()=>({...data,version:'v4',typhoons:[]});await refresh();
      DS.load=async()=>({...data,version:'v5',typhoons:[data.typhoons[1]]});await refresh();
      return $('#det').classList.contains('hide');
    }, fixture('v3')), true, 'empty lifecycle clears stale details');
    assert.deepEqual(await page.evaluate(async data => {
      DS.load=async()=>data;await refresh();chooseTyphoon(0);renderTyphoonOptions('');
      const fresh={...data,version:'v7',typhoons:[{...data.typhoons[0],id:'storm-C',name:'storm-C'},...data.typhoons]};
      DS.load=async()=>fresh;await refresh();
      const options=[...$('#typOptions').querySelectorAll('[role=option]')];
      const option=options.find(o=>o.querySelector('span').textContent==='storm-A');
      const label=option.querySelector('span').textContent;option.click();
      return [label,TY().name,options.length];
    }, fixture('v6')), ['storm-A','storm-A',3], 'open picker keeps filter and stable cyclone identity');
    assert.deepEqual(await page.evaluate(async data => {
      DS.load=async()=>data;await refresh();chooseTyphoon(0);
      const point=pts(AG[0],0)[1],issued=issMs(AG[0],0);showDet('CWA',point.h,0);
      const storm=data.typhoons[0],time=storm.history.at(-1).time+6*3600000;
      const history=[...storm.history,{...storm.history.at(-1),time}];
      const source=storm.sources.CWA,batches=[{issued:time,base:time,points:source.batches[0].points.map(p=>({...p,time:p.time+6*3600000}))},...source.batches];
      const updated={...storm,history,batchTimes:batches.map(b=>b.issued),sources:{...storm.sources,CWA:{...source,history,batches}}};
      DS.load=async()=>({...data,version:'detail-2',typhoons:[updated]});await refresh();
      return [fc(TY(),AG[0],S.sel.b,S.sel.h)?.time,issMs(AG[0],S.sel.b),point.time,issued];
    }, fixture('detail-1')), [T+18*H,T+12*H,T+18*H,T+12*H], 'selected forecast detail retains absolute point and issue when indices shift');
    assert.equal(await page.evaluate(async () => {
      let mutations=0;const observer=new MutationObserver(records=>mutations+=records.length);
      observer.observe(document.body,{subtree:true,childList:true,attributes:true,characterData:true});
      DS.load=async()=>D;await refresh({silent:true});await Promise.resolve();observer.disconnect();return mutations;
    }), 0, 'unchanged content produces no DOM mutations');
    assert.deepEqual(await page.evaluate(async data => {
      const storm=data.typhoons[0];storm.historyAgency='JMA';storm.sources.CWA.history=[storm.history[2]];
      DS.load=async()=>data;await refresh();chooseTyphoon(0);
      return [mapView.snapshot.history.length,mapView.snapshot.historyRecords.length,mapView.snapshot.historyAgency,referenceTime()];
    }, fixture('v8')), [1,1,'CWA',T+12*H], 'center, history, timeline and labels share one analysis source');
    assert.equal(await page.evaluate(() => {
      const tooltip=mapView.nodeTooltip({time:0,w:30,p:'<img src=x onerror=alert(1)>'},'<svg onload=alert(1)>',{formatTime:()=>'<iframe>'});
      return tooltip.querySelectorAll('img,svg,iframe').length;
    }), 0, 'tooltip treats all dynamic values as text');
    assert.equal(await page.evaluate(() => {
      const control=new maplibregl.AttributionControl({customAttribution:'<details open onload="1" ontoggle="globalThis.__injected=1">untrusted</details>'});
      mapView.gl.addControl(control);
      const unsafe=mapView.gl.getContainer().querySelectorAll('.maplibregl-ctrl-attrib [onload],.maplibregl-ctrl-attrib [ontoggle]').length;
      mapView.gl.removeControl(control);return unsafe;
    }), 0, 'MapLibre removes adjacent dangerous attribution attributes (GHSA-jrc7-96c5-q579)');
    // Explicit independent sliders survive export and restore, including mode.
    assert.deepEqual(await page.evaluate(() => {
      S.syncPlayback=false;S.playTracks={actual:true,batch:false};S.actual=analysisHistory()[0].time;S.batch=2;
      $('#xs').click();location.hash=new URL($('#ma').value).hash;
      S.syncPlayback=true;S.playTracks={actual:true,batch:true};S.batch=0;
      restore();all();return [S.syncPlayback,S.playTracks.batch,S.batch];
    }), [false,false,2], 'share preserves independent playback settings');
    assert.deepEqual(await page.evaluate(async data => {
      location.hash=encodeURIComponent(JSON.stringify({storm:'storm-B',actual:data.typhoons[1].history[0].time,
        issued:data.typhoons[1].batchTimes[2],tz:'0',v:{center:[25,125],zoom:5}}));
      initialStateRestored=false;
      DS.load=async()=>({...data,version:'pending-1',typhoons:[data.typhoons[0]]});await refresh();
      const pending=!initialStateRestored;
      DS.load=async()=>({...data,version:'pending-2'});await refresh();
      return [pending,initialStateRestored,TY().id,S.actual,TZ()];
    }, fixture()), [true,true,'storm-B',T,'UTC+0'], 'share target can arrive after the first cached response');
    assert.equal(await page.evaluate(async data => {
      location.hash=encodeURIComponent(JSON.stringify({storm:'storm-B'}));initialStateRestored=false;
      DS.load=async()=>({...data,version:'pending-3',typhoons:[data.typhoons[0]]});await refresh();
      chooseTyphoon(0);
      DS.load=async()=>({...data,version:'pending-4'});await refresh();
      return TY().id;
    }, fixture()), 'storm-A', 'explicit user selection cancels a pending share target');
    await page.clock.install();
    await page.evaluate(() => {
      globalThis.pollCalls=[];
      DS.load=async visit=>{pollCalls.push(visit);return null};startUpdateChecks();
    });
    for(let i=0;i<10;i++)await page.clock.runFor(1000);
    assert.equal(await page.evaluate(() => pollCalls.length), 10, 'first ten checks happen once a second');
    await page.clock.runFor(179999);
    assert.equal(await page.evaluate(() => pollCalls.length), 10, 'steady polling waits three minutes');
    await page.clock.runFor(1);
    assert.deepEqual(await page.evaluate(() => [pollCalls.length,pollCalls.some(Boolean)]), [11,false], 'steady polling only checks cached versions');
    assert.deepEqual(errors, [], 'no browser errors');
    console.log('Frontend: 19 regression checks passed (real map + CSP, isolated fixtures).');
  } finally {await browser.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
