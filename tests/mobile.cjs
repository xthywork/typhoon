// Phone behavior and responsive layout, isolated from live API collection.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {chromium}=require('playwright');
const {fixture,T}=require('./browser-fixtures.cjs');
const ROOT=path.resolve(__dirname,'..');
async function main(){
 const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH}:{}),args:['--enable-unsafe-swiftshader']});
 const failures=[],errors=[];
 try{
  const context=await browser.newContext({viewport:{width:390,height:844},hasTouch:true,isMobile:true});
  await context.route('**/*',async route=>{
   const pathname=new URL(route.request().url()).pathname;
   if(pathname==='/api/typhoons')return route.fulfill({json:fixture()});
   if(pathname==='/favicon.ico')return route.fulfill({status:204});
   const file=pathname==='/'?'index.html':pathname.slice(1);
   if(!['index.html','app.js','bootstrap.mjs','map.js','map.css','basemap-style.json'].includes(file)&&!file.startsWith('vendor/')&&!file.startsWith('data/basemap/'))return route.abort();
   return route.fulfill({body:fs.readFileSync(path.join(ROOT,file)),contentType:/\.m?js$/.test(file)?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.html')?'text/html':file.endsWith('.json')?'application/json':'application/octet-stream'});
  });
  const page=await context.newPage();async function resize(size){await page.setViewportSize(size);await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))}page.on('pageerror',e=>errors.push(e.message));
  const link={storm:'storm-A',actual:T,issued:T,syncPlayback:false,playTracks:{actual:false,batch:true}};
  await page.goto('http://typhoon.audit/#'+encodeURIComponent(JSON.stringify(link)));
  await page.waitForFunction(()=>typeof TY==='function'&&!!TY()&&mapView.basemapReady);
  await page.evaluate(()=>clearInterval(updateTimer));
  async function check(name,run){try{await run();console.log('PASS',name)}catch(e){failures.push(name+': '+e.message);console.log('FAIL',name);await page.evaluate(()=>{main.classList.add('cl','cll');syncPanelButtons();stop()})}}
  await check('phone hides refresh, summary, zoom, tick labels and advanced playback',async()=>{
   for(const selector of ['#refresh','#stormSummary','#tools','#playActual','#playBatch','#syncPlayback','.shared-axis','#tgL','#tg','#sourceResize'])assert.equal(await page.locator(selector).isVisible(),false,selector);
  });
  await check('phone forces both tracks and sync even from an independent share',async()=>assert.deepEqual(await page.evaluate(()=>[S.playTracks.actual,S.playTracks.batch,S.syncPlayback]),[true,true,true]));
  await check('phone has one slider with time and speed above it, without footer timezone',async()=>{
   assert.equal(await page.locator('#is').isVisible(),false);
   assert.equal(await page.locator('#radioZone').isVisible(),false);
   assert.equal(await page.locator('#sp').isVisible(),false);
   assert.equal(await page.locator('#phoneTimelineHeading').isVisible(),true);
   assert.match(await page.locator('#phoneTime').innerText(),/^\d{2}\/\d{2} \d{2}:\d{2}$/);
   const heading=await page.locator('#phoneTimelineHeading').boundingBox(),scale=await page.locator('#positionScale').boundingBox();
   assert.ok(heading.y+heading.height<=scale.y+1);
   const play=await page.locator('#pl').boundingBox();assert.ok(play.width>=64&&play.height>=44);
  });
  await check('compact speed selector updates playback and desktop speed buttons',async()=>{
   assert.equal(await page.locator('#phoneSpeed').count(),1);
   await page.locator('#phoneSpeed').selectOption('400');assert.equal(await page.evaluate(()=>S.speed),400);
   assert.equal(await page.locator('#sp [data-speed="400"]').getAttribute('aria-pressed'),'true');
   await page.locator('#phoneSpeed').selectOption('800');
  });
  await check('phone panels start closed and open as full-screen accessible dialogs',async()=>{
   assert.equal(await page.locator('#lside').isVisible(),false);
   assert.equal(await page.locator('#sheet').isVisible(),false);
   for(const [trigger,panel]of [['#mobileSources','#lside'],['#mobileSettings','#sheet']]){
    await page.locator(trigger).click();assert.equal(await page.locator(panel).getAttribute('role'),'dialog');
    const box=await page.locator(panel).boundingBox();assert.deepEqual([box.x,box.y,box.width,box.height],[0,0,390,844]);
    assert.equal(await page.locator('#mapc').evaluate(el=>el.inert),true);
    assert.equal(await page.locator(panel+' .mobile-panel-close').evaluate(el=>el===document.activeElement),true);
    await page.keyboard.press('Shift+Tab');assert.equal(await page.locator(panel).evaluate(el=>el.contains(document.activeElement)),true);
    await page.keyboard.press('Escape');assert.equal(await page.locator(panel).isVisible(),false);
    assert.equal(await page.locator(trigger).evaluate(el=>el===document.activeElement),true);
   }
  });
  await check('source selection works in the full-screen sheet',async()=>{
   assert.equal(await page.locator('#mobileSources').count(),1);await page.locator('#mobileSources').click();await page.locator('#toggleAll').click();
   assert.equal(await page.evaluate(()=>S.on.size),0);await page.locator('#toggleAll').click();
   assert.equal(await page.evaluate(()=>S.on.size),6);await page.locator('#lside .mobile-panel-close').click();
  });
  await check('source keyboard focus survives toggles and background updates',async()=>{
   await page.locator('#mobileSources').click();await page.locator('#ags input[data-k=CWA]').focus();
   await page.keyboard.press('Space');assert.equal(await page.locator('#ags input[data-k=CWA]').evaluate(el=>el===document.activeElement),true);
   await page.keyboard.press('Space');assert.equal(await page.evaluate(()=>S.on.has('CWA')),true);
   await page.locator('#ags button[data-k=CWA]').focus();
   await page.evaluate(async()=>{DS.load=async()=>({...D,version:'focus-new'});await refresh({silent:true})});
   assert.equal(await page.locator('#ags button[data-k=CWA]').evaluate(el=>el===document.activeElement),true);
   await page.locator('#lside .mobile-panel-close').click();
  });
  await check('phone sync uses real timestamps during seeking and play controls',async()=>{
   await page.evaluate(()=>setActual(TY().history.at(-1).time));await page.locator('#pv').click();assert.deepEqual(await page.evaluate(()=>[S.actual,selectedBulletinTime()]),[T+6*3600000,T+6*3600000]);
   await page.locator('#pl').click();assert.equal(await page.locator('#pl').getAttribute('aria-pressed'),'true');await page.locator('#pl').click();
  });
  await check('small phones, landscape and dark theme stay within the viewport',async()=>{
   for(const size of [{width:320,height:568},{width:430,height:932},{width:844,height:390}]){
    await resize(size);await page.emulateMedia({colorScheme:'dark'});
    assert.equal(await page.locator('#mobileSettings').isVisible(),true);
    const box=await page.locator('#dock').boundingBox();assert.ok(box.x>=0&&box.x+box.width<=size.width&&box.y>=0&&box.y+box.height<=size.height);
    assert.equal(await page.evaluate(()=>document.body.scrollWidth<=innerWidth),true);
   }
  });
  await check('changing phone and desktop layout preserves historical time',async()=>{
   await resize({width:390,height:844});await page.evaluate(()=>setActual(TY().history[0].time));
   await resize({width:1440,height:900});
   assert.equal(await page.evaluate(()=>S.actual),T);
   await resize({width:390,height:844});assert.equal(await page.evaluate(()=>S.actual),T);
  });
  await check('landscape forecast details remain readable and closable',async()=>{
   for(const size of [{width:844,height:390},{width:667,height:375},{width:640,height:360},{width:568,height:320}]){
    await resize(size);await page.evaluate(()=>showDet('CWA',pts(AG[0],S.batch)[0].h,S.batch));
    const detail=await page.locator('#det').boundingBox(),close=await page.locator('#dx').boundingBox(),map=await page.locator('#mapc').boundingBox();
    assert.ok(detail.height>=Math.min(200,map.height-16));assert.ok(close.y>=detail.y&&close.y+close.height<=detail.y+detail.height);
    const firstRow=await page.locator('#det tr').first().boundingBox();assert.ok(firstRow.y+firstRow.height<=detail.y+detail.height);
    await page.locator('#dx').click();assert.equal(await page.locator('#det').isVisible(),false);
   }
  });
  await check('phone playback is bounded by genuine CWA forecast releases while history remains complete',async()=>{
   await resize({width:390,height:844});
   const data=fixture('cwa-range');const storm=data.typhoons[0];
   const extra=[-12,-6,9,18].map(h=>({...storm.history[0],time:T+h*3600000}));
   storm.history=[...storm.history,...extra].sort((a,b)=>a.time-b.time);storm.sources.CWA.history=storm.history;
   storm.sources.CWA.batches=storm.sources.CWA.batches.filter(b=>b.issued>=T+6*3600000);
   storm.batchTimes=[T+24*3600000,...storm.batchTimes,T-12*3600000];
   await page.evaluate(async data=>{DS.load=async()=>data;await refresh({silent:true})},data);
   assert.deepEqual(await page.evaluate(()=>timeDomain()),[T+6*3600000,T+12*3600000]);
   assert.deepEqual(await page.evaluate(()=>synchronizedTimes()),[T+6*3600000,T+9*3600000,T+12*3600000]);
   assert.equal(await page.evaluate(()=>mapView.snapshot.history.length),7);
   assert.equal(await page.locator('#sl').getAttribute('min'),String(T+6*3600000));
   assert.equal(await page.locator('#sl').getAttribute('max'),String(T+12*3600000));
   await page.evaluate(()=>setActual(TY().history[0].time));assert.equal(await page.evaluate(()=>S.syncTime),T+6*3600000);
   await page.evaluate(()=>setActual(TY().history.at(-1).time));assert.equal(await page.evaluate(()=>S.syncTime),T+12*3600000);
   assert.equal(await page.evaluate(()=>{for(let i=0;i<12;i++){advancePlayback(1,true);if(S.syncTime<1792735200000||S.syncTime>1792756800000)return false}return true}),true);
   await page.evaluate(()=>S.on.delete('CWA'));await page.evaluate(()=>all());
   assert.deepEqual(await page.evaluate(()=>timeDomain()),[T+6*3600000,T+12*3600000]);
  });
  await check('following the CWA endpoint tracks new releases but preserves historical selections',async()=>{
   await page.evaluate(()=>setActual(timeDomain()[1]));
   await page.evaluate(async when=>{
    const storm=TY(),source=storm.sources.CWA;
    const updated={...storm,batchTimes:[...storm.batchTimes,when].sort((a,b)=>b-a),sources:{...storm.sources,CWA:{...source,batches:[{...source.batches[0],issued:when},...source.batches]}}};
    DS.load=async()=>({...D,version:'range-growth',typhoons:[updated]});await refresh({silent:true});
   },T+15*3600000);
   assert.equal(await page.evaluate(()=>S.syncTime),T+15*3600000);
   await page.evaluate(()=>setActual(timeDomain()[0]));
   await page.evaluate(async when=>{
    const storm=TY(),source=storm.sources.CWA;
    const updated={...storm,batchTimes:[...storm.batchTimes,when].sort((a,b)=>b-a),sources:{...storm.sources,CWA:{...source,batches:[{...source.batches[0],issued:when},...source.batches]}}};
    DS.load=async()=>({...D,version:'range-growth-history',typhoons:[updated]});await refresh({silent:true});
   },T+16*3600000);
   assert.equal(await page.evaluate(()=>S.syncTime),T+6*3600000);
  });
  await check('missing, analysis-only and single CWA batches never enable unrelated playback',async()=>{
   for(const type of ['missing','analysis-only','single']){
    const data=fixture('cwa-'+type),storm=data.typhoons[0];
    if(type==='missing'){delete storm.sources.CWA;storm.historyAgency='JMA'}
    else if(type==='analysis-only')storm.sources.CWA.batches=storm.sources.CWA.batches.map(b=>({...b,points:b.points.filter(p=>p.time<=b.base)}));
    else storm.sources.CWA.batches=storm.sources.CWA.batches.slice(0,1);
    await page.evaluate(async data=>{DS.load=async()=>data;await refresh({silent:true})},data);
    assert.equal(await page.locator('#pl').isDisabled(),true,type);assert.equal(await page.locator('#sl').isDisabled(),true,type);
    assert.equal(await page.evaluate(()=>mapView.snapshot.history.length),3);
    if(type!=='single')assert.match(await page.locator('#phoneTime').innerText(),/CWA.*預報/);
   }
   await page.evaluate(async data=>{DS.load=async()=>data;await refresh({silent:true})},fixture('restored'));
  });
  await check('desktop retains advanced controls and independent playback',async()=>{
   await resize({width:1440,height:900});
   for(const selector of ['#refresh','#stormSummary','#tools','#playActual','#playBatch','#syncPlayback','.shared-axis','#tgL','#tg'])assert.equal(await page.locator(selector).isVisible(),true,selector);
   assert.equal(await page.locator('#mobileSettings').isVisible(),false);
   await page.locator('#playActual').uncheck();assert.equal(await page.evaluate(()=>S.playTracks.actual),false);
   await resize({width:390,height:844});await resize({width:1440,height:900});
   assert.equal(await page.evaluate(()=>S.playTracks.actual),false);
  });
  assert.deepEqual(errors,[],'no browser exceptions');
  if(failures.length)throw Error(failures.join('\n'));
  console.log('Phone: 16 regression checks passed.');
 }finally{await browser.close()}
}
main().catch(e=>{console.error(e);process.exitCode=1});
