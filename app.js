const assetRevision=document.currentScript?.src?new URL(document.currentScript.src).search:'';
const $=s=>document.querySelector(s),p2=n=>String(n).padStart(2,'0');
/* ===== Official data service: no generated positions, intensities or bulletin dates. ===== */
const AG=[{k:'CWA',c:'#e5484d',avg:'10 分鐘'},{k:'JMA',c:'#3e63dd',avg:'10 分鐘'},
{k:'KMA',c:'#30a46c',avg:'10 分鐘'},{k:'HKO',c:'#b77a19',avg:'10 分鐘'},
{k:'JTWC',c:'#8e4ec6',avg:'1 分鐘'},{k:'CMA',c:'#12a594',avg:'2 分鐘'}];
const FN={CWA:'台灣中央氣象署',JMA:'日本氣象廳',KMA:'韓國氣象廳',HKO:'香港天文台',JTWC:'美國聯合颱風警報中心',CMA:'中國氣象局'};
const ST={ok:'擷取成功',late:'使用上次成功資料',none:'目前無資料',error:'擷取失敗',unconfigured:'待設定認證'};
const escapeHtml=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const DS={async load(visit=false){const headers=D?.version?{'If-None-Match':'"'+D.version+'"'}:{};const response=await fetch('/api/typhoons'+(visit?'?visit=1':''),{cache:'no-store',headers,signal:AbortSignal.timeout(90000)});if(response.status===304)return null;if(!response.ok)throw new Error('官方資料服務暫時無法更新');const data=await response.json();if(data.schemaVersion!==1||!Array.isArray(data.typhoons))throw new Error('請使用 server.py 啟動官方資料服務');return data}};
let D,S={ty:0,actual:null,hour:0,hor:0,batch:0,ov:false,on:new Set(AG.map(a=>a.k)),hl:null,solo:false,sel:null,tab:{L:'src',R:'lay'},play:null,speed:800,loop:true,forecastOnly:false,playTracks:{actual:true,batch:true},syncPlayback:true,syncTime:null,tz:'8',op:1,ly:{hist:1,trk:1,pt:1,lbl:1,cone:1,r30:1,wind15:1,wind25:1,int:1,grid:1}};
const phoneMedia=matchMedia('(max-width:700px), (max-width:950px) and (max-height:500px) and (pointer:coarse)');
const PHONE=()=>phoneMedia.matches;
const forecastRangeOnly=()=>PHONE()||S.forecastOnly;
// Live playback and GIF export share the same frame timing.
const playbackTiming=()=>({frameDelayMs:S.speed,multiplier:800/S.speed});
let desktopPlaybackSettings=null,mobilePanelReturnFocus=null;
function forcePhonePlayback(){if(PHONE()){S.playTracks={actual:true,batch:true};S.syncPlayback=true}}
const LY=[['hist','歷史分析位置'],['trk','官方預報路徑'],['pt','預測中心位置'],['lbl','預報時間標籤'],['cone','官方中心位置機率圈（非暴風圈）'],['wind15','七級風圈（15 m/s）'],['wind25','十級風圈（25 m/s）'],['r30','其他來源 30 kt 風圈'],['int','颱風強度標記'],['grid','經緯度格線']];
const TY=()=>D?.typhoons?.[S.ty];
const analysisAgency=()=>TY()?.sources.CWA?.history?.length?'CWA':TY()?.historyAgency;
const analysisHistory=()=>TY()?.sources[analysisAgency()]?.history||[];
const latestPositionTime=()=>analysisHistory().at(-1)?.time??null;
const initialClockTime=()=>{const times=[latestPositionTime(),selectedBulletinTime()].filter(Number.isFinite);return times.length?Math.max(...times):D?.synced};
const referenceTime=()=>latestPositionTime()??D?.synced??Date.now();
const selectedBulletinTime=(b=S.batch)=>TY()?.batchTimes[b];
function agencyBatch(a,b=S.batch){const when=selectedBulletinTime(b);return TY()?.sources[a.k]?.batches.find(x=>x.issued<=when)||null}
const bs=()=>[S.batch];
function normalizedPoint(p,a,b,batch){return {...p,a:a.k,b,h:(p.time-referenceTime())/36e5,ld:(p.time-batch.base)/36e5}}
const pts=(a,b)=>{const batch=agencyBatch(a,b);return batch?batch.points.map(p=>normalizedPoint(p,a,b,batch)):[]};
const fc=(t,a,b,h)=>pts(a,b).find(p=>Math.abs(p.h-h)<.00001)||null;
const hist=()=>analysisHistory().map(p=>[p.lon,p.lat]);
const vis=()=>AG.filter(a=>S.on.has(a.k)&&agencyBatch(a));
function availableHorizon(){return Math.max(0,...vis().flatMap(a=>pts(a,S.batch).map(p=>p.h)))}
const issMs=(a,b)=>agencyBatch(a,b)?.issued??null;
const TZ=()=>{const n=Number(S.tz)||0;return 'UTC'+(n>=0?'+':'-')+Math.floor(Math.abs(n))+(Math.abs(n)%1?':30':'')};
const ft=ms=>{if(ms===null||!Number.isFinite(ms))return '—';const d=new Date(ms+(Number(S.tz)||0)*36e5);return `${d.getUTCFullYear()}/${p2(d.getUTCMonth()+1)}/${p2(d.getUTCDate())} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`};
function nearest(items,value,key=x=>x){return items.reduce((best,item)=>Math.abs(key(item)-value)<Math.abs(key(best)-value)?item:best,items[0])}
function cwaForecastRange(){
 const batches=TY()?.sources.CWA?.batches||[];
 const times=batches.filter(b=>Number.isFinite(b.issued)&&b.points.some(p=>p.time>b.base)).map(b=>b.issued);
 return times.length?[Math.min(...times),Math.max(...times)]:null;
}
function timeDomain(){
 if(forecastRangeOnly()){const when=latestPositionTime()??D?.synced??Date.now();return cwaForecastRange()||[when,when]}
 const t=TY(),times=[...analysisHistory().map(p=>p.time),...t.batchTimes];return [Math.min(...times),Math.max(...times)];
}
const synchronizedTracks=()=>S.syncPlayback&&S.playTracks.actual&&S.playTracks.batch&&!!TY()?.batchTimes.length;
function synchronizedTimes(){if(!TY()||(forecastRangeOnly()&&!cwaForecastRange()))return [];const [min,max]=timeDomain();return [...new Set([...analysisHistory().map(p=>p.time),...TY().batchTimes])].filter(time=>time>=min&&time<=max).sort((a,b)=>a-b)}
function applySynchronizedTime(when){if(!TY()||!Number.isFinite(when))return;
 if(forecastRangeOnly()){
  const range=cwaForecastRange();
  if(!range){S.syncTime=null;return}
  when=Math.max(range[0],Math.min(range[1],when));
 }
 S.syncTime=when;S.actual=analysisHistory().filter(p=>p.time<=when).at(-1)?.time??null;S.batch=TY().batchTimes.findIndex(time=>time<=when)}
function trackCursor(key){return synchronizedTracks()&&Number.isFinite(S.syncTime)?S.syncTime:(key==='actual'?S.actual:selectedBulletinTime())}
function updateAgencies(){AG.forEach(a=>{const source=D.sources[a.k],batch=agencyBatch(a),archive=TY()?.sources[a.k];a.max=batch?Math.max(1,...batch.points.map(p=>(p.time-batch.base)/36e5)):0;a.st=Object.hasOwn(ST,source.status)?source.status:'error';a.note=source.message;if(archive?.storedHistory){a.st=batch?'ok':'none';a.note=`已儲存歷史資料，非即時預報；${archive.history.length} 筆分析位置、${archive.batches.length} 組發布批次${batch?'':'；所選時間之前沒有預報批次'}`}else if(archive?.historical){if(!TY()?.active)a.st='ok';a.note=(TY()?.active?source.message+'；':'')+'已匯入官方歷史資料；'+archive.history.length+' 筆分析位置'+(archive.batches.length?'，'+archive.batches.length+' 組預報批次':'，無歷史預報批次')}if(!archive?.historical&&!archive?.storedHistory&&!batch&&['ok','late'].includes(a.st)){a.st='none';a.note=TY()?.sources[a.k]?'所選時間之前沒有已儲存的預報批次':'此颱風沒有該來源資料'}})}
const cls=w=>w<17.2?'熱帶性低氣壓':w<32.7?'輕度颱風':w<51?'中度颱風':'強烈颱風';
const dist=(a,b)=>{const R=6371,r=Math.PI/180,x=(b.lat-a.lat)*r,y=(b.lon-a.lon)*r,h=Math.sin(x/2)**2+Math.cos(a.lat*r)*Math.cos(b.lat*r)*Math.sin(y/2)**2;return 2*R*Math.asin(Math.sqrt(h))};
const D8=['北','東北','東','東南','南','西南','西','西北'];
const mv=(a,b)=>{const r=Math.PI/180,y=Math.sin((b.lon-a.lon)*r)*Math.cos(b.lat*r),x=Math.cos(a.lat*r)*Math.sin(b.lat*r)-Math.sin(a.lat*r)*Math.cos(b.lat*r)*Math.cos((b.lon-a.lon)*r);return D8[Math.round(((Math.atan2(y,x)/r+360)%360)/45)%8]};
/* ===== OpenStreetMap / Leaflet 渲染層 ===== */
const mapView=new TyphoonMap('map',(agency,hour,batch)=>{S.hour=hour;showDet(agency,hour,batch);all()});
const summaryObserver=new ResizeObserver(()=>{const box=$('#stormSummary');$('#mapc').style.setProperty('--summary-bottom',`${box.offsetTop+box.offsetHeight+8}px`)});
summaryObserver.observe($('#stormSummary'));
function weatherContext(){return {agency:AG.find(a=>a.k===analysisAgency()),point:Number.isFinite(S.actual)?analysisHistory().filter(p=>p.time<=S.actual).at(-1)||null:null,forecast:false}}
function updateWeatherSummary(context){if($('#mockT')&&TY())$('#mockT').textContent=(TY()?.active===false?'已儲存歷史｜分析來源：':'官方資料｜分析來源：')+analysisAgency();const box=$('#stormSummary');box.classList.toggle('hide',!context);if(!context)return;const {agency,point:p}=context;if(!p){box.innerHTML=`<div class="storm-summary-title">${agency.k}</div><div class="mu">此時段未提供分析資料</div>`;return}const n=(value,unit='')=>value==null?'未提供':(Number.isInteger(value)?value:+value.toFixed(1))+unit,fields=[['最大風速',n(p.w,' m/s')],['最大陣風',n(p.gust,' m/s')],['中心氣壓',n(p.p,' hPa')],['移動速度',n(p.movingSpeed,' km/h')]];box.innerHTML=`<div class="storm-summary-title"><b>${agency.k} 分析</b><span>${ft(p.time).slice(5)}</span></div><dl>${fields.map(([label,value])=>`<div><dt>${label}</dt><dd>${value}</dd></div>`).join('')}</dl><div class="wind-legend"><span class="wind15-key">七級風 ${n(p.windRadius15ms,' km')}</span><span class="wind25-key">十級風 ${n(p.windRadius25ms,' km')}</span></div><div class="summary-note">風速為 ${agency.avg} 平均；風圈輪廓為平滑示意，半徑依官方資料</div>${S.ly.cone?'<div class="summary-note cone-key">虛線圈：官方中心位置機率範圍，非暴風圈</div>':''}`}
function drawMap(){if(!TY())return;const context=weatherContext();updateWeatherSummary(context);mapView.render({
 typhoon:TY(),history:hist(),historyRecords:analysisHistory(),historyAgency:analysisAgency(),formatTime:when=>ft(when)+' '+TZ(),actual:context.point?[context.point.lon,context.point.lat]:null,hour:S.hour,
 layers:S.ly,opacity:S.op,highlight:S.hl,selected:S.sel,weather:context,
 series:vis().flatMap(agency=>bs().map(batch=>({agency,batch,previous:batch!==S.batch,points:pts(agency,batch)})))
})}

/* ===== 面板 ===== */
const TABS=[['lay','圖層設定','R'],['exp','匯出','R']];
function updTabs(){$('#tabs').innerHTML=TABS.map(t=>`<button data-t="${t[0]}" class="${S.tab.R===t[0]?'on':''}">${t[1]}</button>`).join('');TABS.forEach(t=>$('#p_'+t[0]).classList.toggle('hide',S.tab.R!==t[0]))}
const accuracyData=(agency,scope)=>D?.accuracy?.byStorm?.[TY()?.id]?.[scope]?.[agency];
function accuracySummary(agency){return '<div class="accuracy-summary" aria-label="路徑命中率">'+[['history','歷史'],['current','本颱風']].map(([scope,label])=>{
 const score=accuracyData(agency,scope),rate=score?.rate;
 const value=Number.isFinite(rate)?(Number.isInteger(rate)?rate:rate.toFixed(1))+'%':scope==='history'?'累積中':'待驗證';
 const note=Number.isFinite(rate)&&(score.provisional||score.sampleCount<10)?'<span class="accuracy-estimate" aria-hidden="true">*</span>':'';
 return `<button type="button" class="accuracy-value" data-accuracy="${agency}" data-scope="${scope}" aria-label="${label}命中率 ${value}，查看計算細節"><span>${label}</span><strong>${value}</strong>${note}</button>`;
}).join('')+'</div>'}
function updAgs(){
 const active=document.activeElement,list=$('#ags');
 const focusedKey=list.contains(active)?active.closest('.ag')?.querySelector('input')?.dataset.k:null;
 const focusedControl=active.matches('input')?'input':active.matches('[data-accuracy]')?`[data-scope="${active.dataset.scope}"]`:active.matches('button')?'button':active.matches('.status-light')?'.status-light':null;
 const available=AG,allSelected=available.every(a=>S.on.has(a.k));$('#toggleAll').disabled=false;$('#toggleAll').textContent=allSelected?'取消全選':'全選';$('#ags').innerHTML=AG.map(a=>`<div class="ag"><input type="checkbox" data-k="${a.k}" ${S.on.has(a.k)?'checked':''} aria-label="${FN[a.k]}"><i style="background:${a.c}"></i><button class="nm ${S.hl===a.k?'on':''}" data-k="${a.k}" title="聚焦此提供商，再點一次恢復" aria-pressed="${S.hl===a.k}">${FN[a.k]} <span>${a.k}</span></button><span class="status-light ${a.st}" role="img" tabindex="0" aria-label="${escapeHtml(a.note||ST[a.st])}" title="${escapeHtml(a.note||ST[a.st])}"></span>${accuracySummary(a.k)}</div>`).join('');fitSourceWidth();
 if(focusedKey&&focusedControl)list.querySelector(`input[data-k="${focusedKey}"]`)?.closest('.ag')?.querySelector(focusedControl)?.focus({preventScroll:true});
}

let tickCache='';
function updateRadioScales(){const [min,max]=timeDomain(),span=max-min||1,tickWidth=Math.max(90,$('#positionScale').clientWidth-14),tickCount=Math.max(2,Math.floor(tickWidth/62)),key=[TY().id,min,max,S.tz,tickCount,PHONE()].join('|');if(key!==tickCache){tickCache=key;const step=[1,3,6,12,24,48,72,96,168,336,720].find(h=>span/36e5/h<=tickCount)||720,offset=Number(S.tz)*36e5,interval=step*36e5,first=Math.ceil((min+offset)/interval)*interval-offset,times=[];for(let time=first;time<=max;time+=interval)times.push(time);if(!times.length)times.push(min);const phoneMarks=[];
 if(PHONE()&&max>min){
  const minorInterval=interval/4,minorStart=Math.ceil((min+offset)/minorInterval)*minorInterval-offset;
  for(let time=minorStart;time<=max;time+=minorInterval){
   const major=Math.abs((time+offset)/interval-Math.round((time+offset)/interval))<1e-6;
   phoneMarks.push(`<span class="phone-scale-mark${major?' major':''}" style="left:${(time-min)/span*100}%"></span>`);
  }
  phoneMarks.push('<span class="phone-scale-mark endpoint" style="left:0%"></span><span class="phone-scale-mark endpoint" style="left:100%"></span>');
 }
 $('#phoneScaleTicks').innerHTML=phoneMarks.join('');
 const days=new Set();$('#positionTicks').innerHTML=times.map((time,i)=>{const date=ft(time),[day,hour]=date.split(' '),firstDay=!days.has(day);days.add(day);const pos=(time-min)/span*100;return `${firstDay?`<span class="axis-date ${pos<3?'date-start':pos>97?'date-end':''}" style="left:${pos}%">${day.slice(5)}</span>`:''}<span class="time-tick major  ${pos<3?'tick-start':''}" style="left:${pos}%" title="${date} ${TZ()}"><span class="tick-label"><span>${hour}</span></span></span>`}).join('')}
 for(const [key,id,input]of [['actual','positionScale','sl'],['batch','batchScale','is']]){const cursor=trackCursor(key),scale=$('#'+id);scale.style.setProperty('--position',Number.isFinite(cursor)?Math.max(0,Math.min(1,(cursor-min)/span)):0);scale.classList.toggle('outside-domain',!Number.isFinite(cursor)||cursor<min||cursor>max);const original=key==='actual'?S.actual:selectedBulletinTime();$('#'+input).setAttribute('aria-valuetext',`${synchronizedTracks()?'截至 ':''}${ft(cursor)} ${TZ()}；${key==='actual'?'官方分析':'發布批次'}：${ft(original)}`)}$('#radioZone').textContent=TZ()}

function updTl(){updateLoopButtons();$('#forecastOnly').setAttribute('aria-pressed',String(forecastRangeOnly()));$('#forecastOnly').title=forecastRangeOnly()&&!cwaForecastRange()?'目前沒有 CWA 預報資料':'將兩個時間軸限制在有 CWA 預報資料的發布範圍';if(!TY())return;const [min,max]=timeDomain(),t=TY();for(const id of ['sl','is']){$('#'+id).min=min;$('#'+id).max=max;$('#'+id).step=1}$('#sl').value=trackCursor('actual')??min;$('#is').value=trackCursor('batch')??min;const sync=synchronizedTracks(),syncEvents=sync?synchronizedTimes():[];$('#sl').disabled=sync?syncEvents.length<2:positionPlaybackTimes().length<2;$('#is').disabled=sync?syncEvents.length<2:batchPlaybackTimes().length<2;const tracks=playbackTracks();$('#pv').disabled=!tracks.length||tracks.every(track=>track.index<=0);$('#nx').disabled=!tracks.length||tracks.every(track=>track.index>=track.times.length-1);$('#pl').disabled=!tracks.some(track=>track.times.length>1);if($('#pl').disabled&&S.play)stop();$('#playActual').checked=S.playTracks.actual;$('#playActual').disabled=PHONE();$('#playBatch').checked=S.playTracks.batch;$('#playBatch').disabled=PHONE()||!t.batchTimes.length;$('#syncPlayback').disabled=PHONE()||!t.batchTimes.length;$('#syncPlayback').setAttribute('aria-pressed',S.syncPlayback);$('#sl').title=sync?'依共同時間游標顯示截至該時刻的官方分析':'';
 const prefix=sync&&!PHONE()?'截至 ':'';$('#ilab').textContent=t.batchTimes.length?prefix+ft(trackCursor('batch')).slice(5):'無預報批次';$('#ilab').title='最新已發布批次：'+ft(selectedBulletinTime())+' '+TZ()+'；各來源實際發布時間見預報節點詳情';$('#tlab').textContent=prefix+ft(trackCursor('actual')).slice(5);$('#tlab').title='最新官方分析時間：'+ft(S.actual)+' '+TZ();updateRadioScales();$('#pl').setAttribute('aria-label',S.play?'暫停所選時間軸':'播放所選時間軸');$('#pl').title=S.play?'暫停':'播放';$('#pl').setAttribute('aria-pressed',!!S.play);
 const range=cwaForecastRange();
 $('#phoneTime').textContent=range?ft(S.syncTime??range[1]).slice(5):'無 CWA 預報資料';
 $('#phoneSpeed').value=String(S.speed);$('#phoneSpeed').disabled=!range;
 $('#sl').setAttribute('aria-label',PHONE()?'CWA 預報範圍同步時間軸':'颱風官方分析位置時間軸');
}
function clampForecastCursors(){
 if(!TY()||!forecastRangeOnly()||synchronizedTracks())return;
 const positions=positionPlaybackTimes(),batches=batchPlaybackTimes();
 S.actual=positions.length?nearest(positions,S.actual??timeDomain()[1]):null;
 S.batch=batches.length?TY().batchTimes.indexOf(nearest(batches,selectedBulletinTime()??timeDomain()[1])):-1;
}
function all(){forcePhonePlayback();for(const button of document.querySelectorAll('[data-media-export]'))button.disabled=!TY()||mediaExportLoading;if(!D){updAgs();return;}if(TY()&&synchronizedTracks())applySynchronizedTime(S.syncTime??initialClockTime());clampForecastCursors();if(!updateFailed)showSyncTime();updateAgencies();updAgs();if(!TY())return;S.hor=availableHorizon();drawMap();updTl();if(S.sel)showDet(S.sel.a,S.sel.h,S.sel.b,1)}
function showDet(k,h,b,keep){const a=AG.find(x=>x.k===k),p=fc(TY(),a,b,h);if(!p){$('#det').classList.add('hide');return}S.sel={a:k,h,b};if(!keep)drawMap();const points=pts(a,b),index=points.findIndex(x=>x.h===h),prev=points[index-1],movement=prev?`向${mv(prev,p)}，${(dist(prev,p)/((p.time-prev.time)/36e5)).toFixed(0)} km/h`:'—',n=(v,suffix='')=>v==null?'未提供':v+suffix;
 $('#det').innerHTML=`<div class="row"><b class="sp">${escapeHtml(TY().name)}</b><button id="dx" aria-label="關閉">✕</button></div><table>`+[['預報機構',FN[k]],['發布／產品更新',ft(issMs(a,b))+' '+TZ()],['有效時間',ft(p.time)+' '+TZ()],['預報時效',p.ld+'h'],['中心位置',p.lat.toFixed(2)+'°N / '+p.lon.toFixed(2)+'°E'],['最大持續風速',n(p.w==null?null:+p.w.toFixed(1),' m/s')+'（'+a.avg+'平均）'],['最大陣風',n(p.gust,' m/s')],['中心最低氣壓',n(p.p,' hPa')],['移動',p.movingDirection?`${p.movingDirection} ${n(p.movingSpeed,' km/h')}（官方）`:movement],['30 kt 風圈',n(p.r30,' km')],['七級風半徑（15 m/s）',n(p.windRadius15ms,' km')],['十級風半徑（25 m/s）',n(p.windRadius25ms,' km')],['七級風四象限',p.windRadii15ms?['NE','SE','SW','NW'].map((dir,i)=>['東北','東南','西南','西北'][i]+' '+n(p.windRadii15ms[dir],' km')).join('、'):'未提供'],['強度變化',p.stateTransfer||'未提供'],['官方中心位置機率半徑',n(p.cone,' km')+(p.coneProbability?'（'+p.coneProbability+'%）':'')],['位置分析來源',FN[analysisAgency()]+' '+analysisAgency()],['資料來源',TY().sources[k].url]].map(([label,value])=>`<tr><td>${escapeHtml(label)}</td><td>${escapeHtml(value)}</td></tr>`).join('')+'</table>';$('#det').classList.remove('hide');$('#dx').onclick=()=>{S.sel=null;$('#det').classList.add('hide');drawMap()}}

/* ===== 互動 ===== */
const main=$('#main');
const stop=()=>{clearInterval(S.play);S.play=null};
const setActual=when=>{if(!TY())return;const times=synchronizedTracks()?synchronizedTimes():positionPlaybackTimes();if(!times.length)return;if(synchronizedTracks())applySynchronizedTime(nearest(times,when));else{S.syncTime=null;S.actual=nearest(times,when)}clearSourceDetail();all()};
function positionPlaybackTimes(){if(!TY()||(forecastRangeOnly()&&!cwaForecastRange()))return [];const [min,max]=timeDomain();return analysisHistory().map(p=>p.time).filter(time=>time>=min&&time<=max)}
function batchPlaybackTimes(){if(!TY()||(forecastRangeOnly()&&!cwaForecastRange()))return [];const [min,max]=timeDomain();return [...TY().batchTimes].reverse().filter(time=>time>=min&&time<=max)}
function playbackTracks(){if(!TY())return [];if(PHONE()||synchronizedTracks()){const times=synchronizedTimes(),cursor=S.syncTime??S.actual??selectedBulletinTime();return times.length?[{key:'sync',times,index:times.filter(time=>time<=cursor).length-1}]:[]}const tracks=[];if(S.playTracks.actual){const times=positionPlaybackTimes();if(times.length)tracks.push({key:'actual',times,index:times.includes(S.actual)?times.indexOf(S.actual):times.filter(time=>time<S.actual).length-1})}if(S.playTracks.batch){const times=batchPlaybackTimes();if(times.length)tracks.push({key:'batch',times,index:times.indexOf(selectedBulletinTime())})}return tracks}
function advancePlayback(direction,wrap=false){const tracks=playbackTracks();if(!tracks.length)return;tracks.forEach(track=>{const next=track.index+direction,index=wrap?(next+track.times.length)%track.times.length:Math.max(0,Math.min(track.times.length-1,next)),when=track.times[index];if(track.key==='sync')applySynchronizedTime(when);else if(track.key==='actual'){S.syncTime=null;S.actual=when}else{S.syncTime=null;S.batch=TY().batchTimes.indexOf(when)}});clearSourceDetail();all()}
function updateLoopButtons(){for(const button of document.querySelectorAll('[data-loop]')){button.setAttribute('aria-pressed',String(S.loop));button.title='循環播放：'+(S.loop?'開啟':'關閉')}}
for(const button of document.querySelectorAll('[data-loop]'))button.onclick=()=>{S.loop=!S.loop;updateLoopButtons()};
const togglePlay=()=>{
 if(S.play){stop();updTl();return}
 const tracks=playbackTracks();if(!tracks.some(track=>track.times.length>1))return;
 if(!S.loop&&tracks.every(track=>track.index>=track.times.length-1))advancePlayback(1,true);
 S.play=setInterval(()=>{
  advancePlayback(1,S.loop);
  if(!S.loop&&playbackTracks().every(track=>track.index>=track.times.length-1)){stop();updTl()}
 },playbackTiming().frameDelayMs);updTl()
};
for(const [id,key]of [['playActual','actual'],['playBatch','batch']])$('#'+id).onchange=e=>{if(PHONE()){all();return}const anchor=key==='actual'?trackCursor('batch'):trackCursor('actual');S.playTracks[key]=e.target.checked;if(synchronizedTracks()&&TY())applySynchronizedTime(anchor??initialClockTime());else S.syncTime=null;clearSourceDetail();all()};
$('#forecastOnly').onclick=()=>{
 if(PHONE())return;
 stop();S.forecastOnly=!S.forecastOnly;
 if(synchronizedTracks())applySynchronizedTime(S.syncTime??initialClockTime());
 clearSourceDetail();all();
};
$('#syncPlayback').onclick=()=>{if(PHONE()){all();return}const anchor=Math.max(...[trackCursor('actual'),trackCursor('batch')].filter(Number.isFinite));S.syncPlayback=!S.syncPlayback;if(synchronizedTracks()&&TY())applySynchronizedTime(Number.isFinite(anchor)?anchor:initialClockTime());else S.syncTime=null;clearSourceDetail();all()};
$('#zi').onclick=()=>mapView.map.zoomIn();$('#zo').onclick=()=>mapView.map.zoomOut();$('#zr').onclick=()=>mapView.reset();
$('#tabs').onclick=e=>{if(e.target.dataset.t){S.tab.R=e.target.dataset.t;updTabs()}};
$('#toggleAll').onclick=()=>{const available=AG,allSelected=available.every(a=>S.on.has(a.k));S.on=new Set(allSelected?[]:available.map(a=>a.k));S.hl=null;S.solo=false;S.sel=null;$('#det').classList.add('hide');all()};
const sourceList=$('#ags');let sourceDrag=null;
function clearSourceDetail(){S.sel=null;$('#det').classList.add('hide')}
function paintSources(y){if(!sourceDrag)return;const lo=Math.min(y,sourceDrag.y),hi=Math.max(y,sourceDrag.y);sourceList.querySelectorAll('.ag').forEach(row=>{const rect=row.getBoundingClientRect(),input=row.querySelector('input'),k=input.dataset.k;if(input.disabled||sourceDrag.visited.has(k)||hi<rect.top||lo>rect.bottom)return;sourceDrag.visited.add(k);sourceDrag.checked?S.on.add(k):S.on.delete(k)});sourceDrag.y=y;if(S.hl&&!S.on.has(S.hl))S.hl=null;clearSourceDetail();all()}
sourceList.addEventListener('pointerdown',e=>{const input=e.target.closest('input[type="checkbox"]');if(!input||input.disabled||e.button!==0)return;e.preventDefault();sourceDrag={id:e.pointerId,checked:!input.checked,y:e.clientY,visited:new Set()};sourceList.setPointerCapture(e.pointerId);paintSources(e.clientY)});
sourceList.addEventListener('pointermove',e=>{if(sourceDrag?.id===e.pointerId)paintSources(e.clientY)});
function endSourceDrag(e){if(sourceDrag?.id!==e.pointerId)return;sourceDrag=null;if(sourceList.hasPointerCapture(e.pointerId))sourceList.releasePointerCapture(e.pointerId)}
sourceList.addEventListener('pointerup',endSourceDrag);sourceList.addEventListener('pointercancel',endSourceDrag);sourceList.addEventListener('lostpointercapture',()=>{sourceDrag=null});
sourceList.addEventListener('click',e=>{const target=e.target.closest('[data-k]');if(!target)return;const k=target.dataset.k,a=AG.find(a=>a.k===k);if(!a)return;if(target.type==='checkbox'){if(e.detail>0){e.preventDefault();return}target.checked?S.on.add(k):S.on.delete(k);if(S.hl===k&&!target.checked)S.hl=null}else{if(!S.on.has(k)||!agencyBatch(a))return;S.hl=S.hl===k?null:k}S.solo=false;clearSourceDetail();all()});
const sourceResize=$('#sourceResize');let resizePointer=null,sourceWidthManual=false,sourceNaturalWidth=0,sourceFitKey='';
function fitSourceWidth(force=false){if(sourceWidthManual)return;const rows=[...sourceList.querySelectorAll('.ag')];if(!rows.length)return;const panel=getComputedStyle($('#lside')),font=getComputedStyle(rows[0].querySelector('.nm')).font,key=[font,panel.paddingLeft,panel.paddingRight,...rows.map(row=>row.querySelector('.nm').textContent)].join('|');if(!force&&key===sourceFitKey)return;sourceFitKey=key;const probe=document.createElement('div');probe.style.cssText='position:fixed;visibility:hidden;pointer-events:none;left:0;top:0;width:max-content;';document.body.append(probe);let width=0;rows.forEach(row=>{const clone=row.cloneNode(true);clone.style.gridTemplateColumns='26px 14px max-content 12px';clone.style.width='max-content';probe.append(clone);width=Math.max(width,clone.getBoundingClientRect().width);clone.remove()});probe.remove();sourceNaturalWidth=Math.ceil(width+parseFloat(panel.paddingLeft)+parseFloat(panel.paddingRight)+parseFloat(panel.borderRightWidth||0));resizeSources(sourceNaturalWidth,false)}
function resizeSources(width,manual=true){if(manual){sourceWidthManual=true;main.classList.add('source-manual-width')}const min=Math.min(260,sourceNaturalWidth||260),max=Math.max(min,Math.min(560,main.clientWidth-(matchMedia('(max-width:1050px)').matches?16:320+(main.classList.contains('cl')?0:350))));const value=Math.round(Math.max(min,Math.min(max,width)));sourceResize.setAttribute('aria-valuemin',min);main.style.setProperty('--source-width',value+'px');sourceResize.setAttribute('aria-valuenow',value);sourceResize.setAttribute('aria-valuemax',max)}
sourceResize.addEventListener('pointerdown',e=>{if(e.button!==0)return;e.preventDefault();resizePointer=e.pointerId;sourceResize.setPointerCapture(e.pointerId);main.classList.add('resizing')});
sourceResize.addEventListener('pointermove',e=>{if(resizePointer===e.pointerId)resizeSources(e.clientX-main.getBoundingClientRect().left)});
function endResize(e){if(resizePointer!==e.pointerId)return;resizePointer=null;main.classList.remove('resizing');if(sourceResize.hasPointerCapture(e.pointerId))sourceResize.releasePointerCapture(e.pointerId)}
sourceResize.addEventListener('pointerup',endResize);sourceResize.addEventListener('pointercancel',endResize);sourceResize.addEventListener('lostpointercapture',()=>{resizePointer=null;main.classList.remove('resizing')});
sourceResize.addEventListener('keydown',e=>{if(e.key==='ArrowLeft'||e.key==='ArrowRight'){e.preventDefault();resizeSources(+sourceResize.getAttribute('aria-valuenow')+(e.key==='ArrowRight'?16:-16))}});
$('#lys').innerHTML=LY.map(l=>`<label><input type="checkbox" data-l="${l[0]}" checked> ${l[1]}</label>`).join('');
$('#lys').onchange=e=>{S.ly[e.target.dataset.l]=e.target.checked?1:0;drawMap()};
$('#op').oninput=e=>{S.op=e.target.value/100;drawMap()};$('#bm').onchange=e=>mapView.setStyle(e.target.value);
$('#is').oninput=e=>{if(synchronizedTracks())applySynchronizedTime(nearest(synchronizedTimes(),+e.target.value));else{S.syncTime=null;const times=batchPlaybackTimes();if(!times.length)return;const when=nearest(times,+e.target.value);S.batch=TY().batchTimes.indexOf(when)}clearSourceDetail();all()};
$('#sl').oninput=e=>setActual(+e.target.value);$('#pv').onclick=()=>advancePlayback(-1);$('#nx').onclick=()=>advancePlayback(1);$('#pl').onclick=togglePlay;$('#sp').onclick=e=>{const button=e.target.closest('[data-speed]');if(button)setPlaybackSpeed(button.dataset.speed)};
$('#phoneSpeed').onchange=e=>setPlaybackSpeed(e.target.value);
function setPlaybackSpeed(value){
 const speed=Number(value);if(![1600,800,400,200].includes(speed))return;
 S.speed=speed;$('#phoneSpeed').value=String(speed);
 $('#sp').querySelectorAll('button').forEach(button=>button.setAttribute('aria-pressed',Number(button.dataset.speed)===speed));
 if(S.play){stop();togglePlay()}
}
for(const id of ['sl','is'])$('#'+id).addEventListener('keydown',e=>{if(!TY()||!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End'].includes(e.key))return;e.preventDefault();e.stopPropagation();const times=synchronizedTracks()?synchronizedTimes():id==='sl'?positionPlaybackTimes():batchPlaybackTimes();if(!times.length)return;const current=trackCursor(id==='sl'?'actual':'batch'),index=times.indexOf(current),next=e.key==='Home'?0:e.key==='End'?times.length-1:Math.max(0,Math.min(times.length-1,index+(['ArrowRight','ArrowUp'].includes(e.key)?1:-1)));if(synchronizedTracks()){applySynchronizedTime(times[next]);clearSourceDetail();all()}else if(id==='sl')setActual(times[next]);else{S.batch=TY().batchTimes.indexOf(times[next]);clearSourceDetail();all()}});
function syncTimezoneLabel(){$('#tzLabel').textContent=TZ()}
$('#tz').onchange=e=>{S.tz=e.target.value;syncTimezoneLabel();if(D&&!updateFailed)showSyncTime();all()};

let activeTyphoon=-1,typhoonQuery='';
function setActiveTyphoon(i){activeTyphoon=i;const opts=[...$('#typOptions').querySelectorAll('[role="option"]')];opts.forEach(o=>o.setAttribute('aria-selected',+o.dataset.index===i));const active=$(`#ty-option-${i}`);if(active){$('#typSel').setAttribute('aria-activedescendant',active.id);active.scrollIntoView({block:'nearest'})}}
function renderTyphoonOptions(query=''){
 if(!D?.typhoons)return;typhoonQuery=query;const q=query.trim().toLocaleLowerCase(),items=D.typhoons.map((t,i)=>({t,i})).filter(({t})=>!q||`${t.name} ${t.id} ${t.active?'活動':'歷史'}`.toLocaleLowerCase().includes(q)),menu=$('#typOptions');menu.innerHTML='';
 if(!items.length){const empty=document.createElement('div');empty.className='picker-empty';empty.textContent='找不到符合的颱風';menu.append(empty);activeTyphoon=-1;$('#typSel').removeAttribute('aria-activedescendant')}
 else{let previousGroup=null;items.forEach(({t,i})=>{const group=t.active?'活動颱風':'已儲存歷史';if(group!==previousGroup){const heading=document.createElement('div');heading.className='picker-group';heading.setAttribute('role','presentation');heading.textContent=group;menu.append(heading);previousGroup=group}const b=document.createElement('button');b.type='button';b.className='picker-option';b.id=`ty-option-${i}`;b.setAttribute('role','option');b.dataset.index=i;b.dataset.storm=t.id;b.title=t.id+'；最後分析 '+ft(t.history?.at(-1)?.time)+' '+TZ();const name=document.createElement('span');name.textContent=t.name;const id=document.createElement('small');id.className=t.active?'storm-active':'storm-historical';id.textContent=(t.active?'活動':'歷史')+' · '+t.id.slice(0,4);b.append(name,id);menu.append(b)});activeTyphoon=items.some(({i})=>i===S.ty)?S.ty:items[0].i;setActiveTyphoon(activeTyphoon)}
 menu.classList.remove('hide');$('#typSel').setAttribute('aria-expanded','true')
}
function closeTyphoonOptions(){const menu=$('#typOptions');menu.classList.add('hide');$('#typSel').setAttribute('aria-expanded','false');$('#typSel').removeAttribute('aria-activedescendant')}
function chooseTyphoon(i){if(!D?.typhoons[i])return;hideAccuracyTip();initialStateRestored=true;stop();S.syncTime=null;S.ty=i;S.actual=latestPositionTime();S.hour=0;S.batch=0;$('#typSel').value=TY().name;S.sel=null;$('#det').classList.add('hide');closeTyphoonOptions();all()}
$('#typSel').addEventListener('focus',()=>renderTyphoonOptions(''));
$('#typSel').addEventListener('input',e=>renderTyphoonOptions(e.target.value));
$('#typSel').addEventListener('keydown',e=>{if(e.key==='Escape'){closeTyphoonOptions();return}if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();if($('#typOptions').classList.contains('hide'))renderTyphoonOptions(e.target.value);const opts=[...$('#typOptions').querySelectorAll('[role="option"]')];if(!opts.length)return;const at=opts.findIndex(o=>+o.dataset.index===activeTyphoon),step=e.key==='ArrowDown'?1:-1,next=at<0?(step>0?0:opts.length-1):Math.max(0,Math.min(opts.length-1,at+step));setActiveTyphoon(+opts[next].dataset.index)}else if(e.key==='Enter'&&!$('#typOptions').classList.contains('hide')){e.preventDefault();if(activeTyphoon>=0)chooseTyphoon(activeTyphoon)}});
$('#typOptions').onmousedown=e=>{if(e.target.closest('[role="option"]'))e.preventDefault()};
$('#typOptions').onclick=e=>{const option=e.target.closest('[role="option"]');if(option)chooseTyphoon(D.typhoons.findIndex(t=>t.id===option.dataset.storm))};
$('#typOptions').onmousemove=e=>{const option=e.target.closest('[role="option"]');if(option)setActiveTyphoon(+option.dataset.index)};
$('#typSel').addEventListener('blur',()=>setTimeout(closeTyphoonOptions,120));
document.addEventListener('click',e=>{if(!e.target.closest('.typhoon-picker'))closeTyphoonOptions()});
const NAR=()=>matchMedia('(max-width:1050px)').matches;
function syncMobilePanels(){
 const panel=PHONE()?(!main.classList.contains('cll')?$('#lside'):!main.classList.contains('cl')?$('#sheet'):null):null;
 for(const item of [$('#lside'),$('#sheet')]){
  if(item===panel){item.setAttribute('role','dialog');item.setAttribute('aria-modal','true')}
  else{item.removeAttribute('role');item.removeAttribute('aria-modal')}
 }
 for(const item of [document.querySelector('header'),$('#mapc'),$('#sourceResize')])item.inert=!!panel;
 $('#mobileSources').setAttribute('aria-expanded',panel===$('#lside'));
 $('#mobileSettings').setAttribute('aria-expanded',panel===$('#sheet'));
 if(panel&&!panel.contains(document.activeElement))panel.querySelector('.mobile-panel-close').focus({preventScroll:true});
 if(!panel&&mobilePanelReturnFocus){if(PHONE())mobilePanelReturnFocus.focus({preventScroll:true});mobilePanelReturnFocus=null}
}
function syncPanelButtons(){
 const l=!main.classList.contains('cll'),r=!main.classList.contains('cl'),lb=$('#tgL'),rb=$('#tg');
 lb.textContent=l?'‹':'›';rb.textContent=r?'›':'‹';lb.setAttribute('aria-expanded',l);rb.setAttribute('aria-expanded',r);
 lb.setAttribute('aria-label',l?'收合來源與設定面板':'展開來源與設定面板');rb.setAttribute('aria-label',r?'收合設定面板':'展開設定面板');
 lb.title=lb.getAttribute('aria-label');rb.title=rb.getAttribute('aria-label');
 (!PHONE()&&NAR()&&l?$('#lside .panelhead'):$('#mapc')).append(lb);
 (!PHONE()&&NAR()&&r?$('#sheet .panelhead'):$('#mapc')).append(rb);
 syncMobilePanels();
}
function setP(s,open){
 const c=s==='L'?'cll':'cl',o=s==='L'?'cl':'cll';
 if(PHONE()&&open)mobilePanelReturnFocus=$(s==='L'?'#mobileSources':'#mobileSettings');
 main.classList.toggle(c,!open);if(open&&NAR())main.classList.add(o);syncPanelButtons();
}
$('#tgL').onclick=()=>setP('L',main.classList.contains('cll'));$('#tg').onclick=()=>setP('R',main.classList.contains('cl'));
$('#mobileSources').onclick=()=>setP('L',true);$('#mobileSettings').onclick=()=>setP('R',true);
for(const button of document.querySelectorAll('[data-close-panel]'))button.onclick=()=>setP(button.dataset.closePanel,false);
function updatePhoneMode(){
 mapView.setCompactControls(PHONE());
 const times=[S.syncTime,S.actual,selectedBulletinTime()].filter(Number.isFinite);
 const anchor=Number.isFinite(S.syncTime)?S.syncTime:times.length?Math.max(...times):null;
 if(PHONE()){
  if(!desktopPlaybackSettings)desktopPlaybackSettings={tracks:{...S.playTracks},sync:S.syncPlayback};
  forcePhonePlayback();S.tab.R='lay';updTabs();
 }else if(desktopPlaybackSettings){
  S.playTracks=desktopPlaybackSettings.tracks;S.syncPlayback=desktopPlaybackSettings.sync;desktopPlaybackSettings=null;
 }
 S.syncTime=anchor;main.classList.add('cl','cll');syncPanelButtons();if(D)all();
}
phoneMedia.addEventListener('change',updatePhoneMode);
main.addEventListener('click',e=>{if(e.target!==main||!NAR())return;if(!main.classList.contains('cll'))setP('L',false);else if(!main.classList.contains('cl'))setP('R',false)});
matchMedia('(max-width:1050px)').onchange=()=>{main.classList.add('cl','cll');syncPanelButtons();fitSourceWidth()};
addEventListener('keydown',e=>{
 if($('#mediaExport').open)return;
 if(PHONE()){
  const panel=!main.classList.contains('cll')?$('#lside'):!main.classList.contains('cl')?$('#sheet'):null;
  if(panel){
   if(e.key==='Escape'){e.preventDefault();setP(panel.id==='lside'?'L':'R',false);return}
   if(e.key==='Tab'){
    const focusable=[...panel.querySelectorAll('button,input,select,[tabindex="0"]')].filter(el=>!el.disabled&&el.getClientRects().length);
    const first=focusable[0],last=focusable.at(-1);
    if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus()}
    else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus()}
   }
   return;
  }
 }
 if(/INPUT|SELECT|TEXTAREA/.test(e.target.tagName)&&e.key!=='Escape')return;
 if(e.key==='ArrowRight')advancePlayback(1);else if(e.key==='ArrowLeft')advancePlayback(-1);else if(e.key===' '&&e.target===document.body){e.preventDefault();togglePlay()}
 else if(e.key==='Escape'){$('#modal').classList.add('hide');S.sel=null;$('#det').classList.add('hide');drawMap()}});
/* 匯出：發佈頁面不支援直接下載，改以視窗顯示內容並可複製 */
function modal(t,txt){$('#mt').textContent=t;$('#ma').value=txt;$('#modal').classList.remove('hide');$('#ma').select()}
$('#mx').onclick=()=>$('#modal').classList.add('hide');
$('#mcp').onclick=async()=>{const a=$('#ma');a.select();try{await navigator.clipboard.writeText(a.value)}catch(_){try{document.execCommand('copy')}catch(__){}}$('#mcp').textContent='已複製';setTimeout(()=>$('#mcp').textContent='複製',1200)};
const rows=()=>{const o=[];vis().forEach(a=>bs().forEach(b=>pts(a,b).forEach(p=>o.push({a,b,p}))));return o};
$('#xc').onclick=()=>modal('多國路徑比較 CSV（官方資料）',['資料性質,機構,批次,發布時間('+TZ()+'),有效時間('+TZ()+'),預報時效h,經度,緯度,最大風速m/s,風速平均時間,中心氣壓hPa'].concat(rows().map(({a,b,p})=>['官方',a.k,'批次'+b+'（0=最新）',ft(issMs(a,b)),ft(p.time),p.ld,p.lon,p.lat,p.w,a.avg,p.p].join(','))).join('\n'));
$('#xg').onclick=()=>{const f=[];vis().forEach(a=>bs().forEach(b=>{const ps=pts(a,b);if(ps.length>1)f.push({type:'Feature',properties:{agency:a.k,batch:b,issued:issMs(a,b),source:TY().sources[a.k].url,mock:false},geometry:{type:'LineString',coordinates:ps.map(p=>[p.lon,p.lat])}});
 ps.forEach(p=>f.push({type:'Feature',properties:{agency:a.k,batch:b,hour:p.h,valid_time:p.time,issued:issMs(a,b),lead_hours:p.ld,wind_ms:p.w,wind_average:a.avg,pressure_hpa:p.p,mock:false},geometry:{type:'Point',coordinates:[p.lon,p.lat]}}))}));
 modal('預測路徑 GeoJSON（官方資料）',JSON.stringify({type:'FeatureCollection',features:f},null,1))};
$('#xs').onclick=()=>{if(!TY())return;const st={storm:TY().id,actual:S.actual,h:S.hour,issued:selectedBulletinTime(),syncPlayback:S.syncPlayback,playTracks:{...S.playTracks},syncTime:S.syncTime,a:[...S.on],tz:S.tz,v:mapView.view};modal('分享連結',location.href.split('#')[0]+'#'+encodeURIComponent(JSON.stringify(st)))};
function restore(){
 try{
  const state=JSON.parse(decodeURIComponent(location.hash.slice(1)));
  const index=D.typhoons.findIndex(t=>t.id===state.storm);
  if(index<0)return {pending:true};
  S.ty=index;
  if(Array.isArray(state.a))S.on=new Set(state.a.filter(k=>AG.some(a=>a.k===k)));
  if($('#tz').querySelector(`option[value="${Number(state.tz)}"]`))S.tz=String(Number(state.tz));
  $('#tz').value=S.tz;syncTimezoneLabel();
  if(typeof state.syncPlayback==='boolean')S.syncPlayback=state.syncPlayback;
  if(state.playTracks)for(const key of ['actual','batch'])if(typeof state.playTracks[key]==='boolean')S.playTracks[key]=state.playTracks[key];
  S.actual=Number.isFinite(state.actual)?nearest(analysisHistory(),state.actual,p=>p.time)?.time??null:latestPositionTime();
  S.batch=Number.isFinite(state.issued)?TY().batchTimes.indexOf(nearest(TY().batchTimes,state.issued)):0;
  // Old share links only stored two independent times. Keep both when they
  // cannot represent a single common cursor; new links preserve the exact mode.
  if(state.syncPlayback===undefined&&Number.isFinite(state.actual)&&Number.isFinite(state.issued)&&state.actual!==state.issued)S.syncPlayback=false;
  forcePhonePlayback();
  const times=[state.actual,state.issued].filter(Number.isFinite);
  const anchor=Number.isFinite(state.syncTime)?state.syncTime:times.length?Math.max(...times):initialClockTime();
  S.syncTime=null;
  if(synchronizedTracks())applySynchronizedTime(nearest(synchronizedTimes(),anchor));
  return {view:state.v};
 }catch(_){return {}}
}
let mediaExportBusy=false,mediaExportLoading=false;
let updateInFlight=false,updateFailed=false,initialStateRestored=false;
function showSyncTime(){const historical=TY()?.active===false;$('#mapUpdated').firstChild.textContent=historical?'歷史資料 ':'更新 ';$('#sync').textContent=ft(historical?latestPositionTime():D.synced)+' '+TZ()}
async function refresh({visit=false,silent=false}={}){
 if(updateInFlight||mediaExportBusy)return false;
 updateInFlight=true;
 if(!silent)$('#refresh').disabled=true;
 try{
  const data=await DS.load(visit);
  if(mediaExportBusy)return false;
  if(!data||(D&&D.version===data.version)){
   if(updateFailed&&D){updateFailed=false;showSyncTime()}
   return true;
  }
  // Read selection after the request resolves: a user may have changed it
  // while the network was busy. Preserve that most recent choice.
  const oldId=TY()?.id,oldActual=S.actual,oldBatch=selectedBulletinTime();
  const wasLatestPhone=forecastRangeOnly()&&S.syncTime===cwaForecastRange()?.[1];
  const detailAgency=S.sel&&AG.find(a=>a.k===S.sel.a);
  const detailPoint=detailAgency&&fc(TY(),detailAgency,S.sel.b,S.sel.h);
  const detail=detailPoint?{agency:detailAgency,issued:issMs(detailAgency,S.sel.b),time:detailPoint.time}:null;
  const wasLatestBatch=S.batch===0,wasLatest=!TY()||oldActual===latestPositionTime();
  const pickerOpen=!$('#typOptions').classList.contains('hide'),query=typhoonQuery,inputValue=$('#typSel').value;
  D=data;updateFailed=false;
  const index=D.typhoons.findIndex(t=>t.id===oldId);
  S.ty=index<0?0:index;
  const none=!TY();
  $('#empty').classList.toggle('hide',!none);$('#dock').classList.toggle('hide',none);
  $('#typSel').disabled=none;$('#typSel').value=TY()?.name||'';
  const ok=Object.values(D.sources).some(s=>['ok','none'].includes(s.status));
  $('#empty h2').textContent=ok?'目前沒有可顯示的颱風資料':'暫時無法取得官方資料';
  $('#empty p').textContent='各來源狀態可在左側查看，請稍後重新整理。';
  $('#mock').innerHTML='<span id="mockT"></span>';
  if(none){
   stop();$('#stormSummary').classList.add('hide');mapView.clearWeather();
   S.actual=null;S.syncTime=null;clearSourceDetail();closeTyphoonOptions();
  }else{
   if(index<0){stop();S.syncTime=null;clearSourceDetail()}
   S.actual=wasLatest||index<0?latestPositionTime():nearest(analysisHistory(),oldActual,p=>p.time)?.time??null;
   S.batch=wasLatestBatch||index<0?0:TY().batchTimes.indexOf(nearest(TY().batchTimes,oldBatch));
   if(wasLatest&&wasLatestBatch)S.syncTime=null;
   if(wasLatestPhone)S.syncTime=cwaForecastRange()?.[1]??null;
  }
  let view;
  if(TY()&&!initialStateRestored){const restored=restore();view=restored.view;initialStateRestored=!restored.pending;$('#typSel').value=TY().name}
  if(detail&&TY()?.id===oldId){
   const b=TY().batchTimes.indexOf(detail.issued),batch=b>=0?agencyBatch(detail.agency,b):null;
   if(batch?.issued===detail.issued&&batch.points.some(p=>p.time===detail.time))S.sel={a:detail.agency.k,b,h:(detail.time-referenceTime())/36e5};
   else clearSourceDetail();
  }
  $('#mockT').textContent=TY()?(TY()?.active===false?'已儲存歷史｜分析來源：':'官方資料｜分析來源：')+analysisAgency():'官方資料';
  showSyncTime();all();
  if(view)mapView.restoreView(view);
  if(pickerOpen&&!none){$('#typSel').value=inputValue;renderTyphoonOptions(query)}
  return true;
 }catch(error){
  if(silent&&D)return false;
  updateFailed=true;
  $('#sync').textContent=D?'更新失敗，保留上次資料':'資料服務連線失敗';
  if(!D){$('#empty').classList.remove('hide');$('#empty h2').textContent='官方資料準備中';$('#empty p').textContent='正在等待伺服器取得資料，頁面會自動檢查更新。';$('#dock').classList.add('hide');$('#typSel').disabled=true}
  return false;
 }finally{updateInFlight=false;if(!silent)$('#refresh').disabled=false}
}
new ResizeObserver(()=>{if(TY())updTl()}).observe($('#positionScale'));
document.fonts.ready.then(()=>fitSourceWidth(true));
$('#refresh').onclick=()=>refresh({visit:true});$('#lside').append($('#p_src'));updTabs();syncPanelButtons();AG.forEach(a=>{a.st='none';a.note='等待資料更新'});updAgs();
if(PHONE())updatePhoneMode();
refresh({visit:true});
// Check cached versions only; these requests never trigger upstream collection.
let updateTimer;
function startUpdateChecks(){clearInterval(updateTimer);let quickChecks=0;updateTimer=setInterval(()=>{refresh({silent:true});if(++quickChecks===10){clearInterval(updateTimer);updateTimer=setInterval(()=>refresh({silent:true}),180000)}},1000)}
startUpdateChecks();
window.addEventListener('pagehide',()=>clearInterval(updateTimer));
window.addEventListener('pageshow',event=>{if(event.persisted){refresh({visit:true,silent:true});startUpdateChecks()}});

/* Image exports use the same time events and selection rules as live playback. */
async function openMapExport(event){
 if(!TY()||mediaExportBusy||mediaExportLoading)return;
 mediaExportLoading=true;
 const opener=event.currentTarget;
 opener.disabled=true;
 try{
  const {openMediaExport}=await import('./media-export.mjs'+assetRevision);
  if(PHONE())setP('R',false);
  await openMediaExport({
   view:mapView,timing:playbackTiming(),loop:S.loop,
   filename:('typhoon-'+TY().id+'-'+ft(trackCursor('actual')).replace(/[^0-9A-Za-z-]/g,'-')),
   begin(){
    const saved={actual:S.actual,batch:S.batch,hour:S.hour,hor:S.hor,syncTime:S.syncTime,sel:S.sel,playing:!!S.play};
    mediaExportBusy=true;stop();updTl();return saved;
   },
   tracks:()=>playbackTracks().map(track=>({...track,times:[...track.times]})),
   setFrame(tracks,index){
    for(const track of tracks){
     const when=track.times[S.loop?index%track.times.length:Math.min(index,track.times.length-1)];
     if(track.key==='sync')applySynchronizedTime(when);
     else if(track.key==='actual'){S.syncTime=null;S.actual=when}
     else{S.syncTime=null;S.batch=TY().batchTimes.indexOf(when)}
    }
    clearSourceDetail();all();
   },
   info:()=>({name:TY().name,actual:ft(trackCursor('actual')).slice(5),batch:ft(trackCursor('batch')).slice(5),zone:TZ(),
    mode:forecastRangeOnly()?'僅預測範圍':'完整時間範圍',speed:playbackTiming().multiplier,updated:ft(D.synced)+' '+TZ(),
    dark:$('#bm').value==='dark',agencies:AG.filter(a=>S.on.has(a.k)&&TY().sources[a.k]?.batches.length).map(a=>({k:a.k,c:a.c}))}),
   restore(saved){const {playing,...cursor}=saved;Object.assign(S,cursor);all()},
   end(saved){
    this.restore(saved);mediaExportBusy=false;
    if(saved.playing)togglePlay();
    (PHONE()?$('#mobileSettings'):opener).focus({preventScroll:true});
   }
  });
 }catch(error){
  mediaExportBusy=false;
  modal('無法開啟匯出',error.message);
 }finally{mediaExportLoading=false;for(const button of document.querySelectorAll('[data-media-export]'))button.disabled=!TY()}
}
for(const button of document.querySelectorAll('[data-media-export]')){button.onclick=openMapExport;button.disabled=!TY()}

/* One shared tooltip: hover/focus on desktop, tap to pin on touch screens. */
const accuracyTip=document.createElement('div');accuracyTip.id='accuracyTooltip';accuracyTip.className='accuracy-tooltip hide';accuracyTip.setAttribute('role','tooltip');document.body.append(accuracyTip);
let accuracyAnchor=null,accuracyPinned=false,accuracyHideTimer;
function hideAccuracyTip(){clearTimeout(accuracyHideTimer);accuracyAnchor?.removeAttribute('aria-describedby');accuracyAnchor=null;accuracyPinned=false;accuracyTip.classList.add('hide')}
function showAccuracyTip(button,pinned=false){
 clearTimeout(accuracyHideTimer);accuracyAnchor?.removeAttribute('aria-describedby');accuracyAnchor=button;accuracyPinned=pinned;button.setAttribute('aria-describedby',accuracyTip.id);
 const agency=button.dataset.accuracy,scope=button.dataset.scope,score=accuracyData(agency,scope),history=scope==='history',n=score?.sampleCount||0;
 const reasons={no_finalized_history:'尚無已結束且具 JMA 定稿軌跡的合格歷史預報。',no_reference:'尚無同一颱風的 JMA 分析位置可供驗證。',waiting:'預報有效時間尚未到達，或仍待參考位置發布。',no_matching_reference:'已有到期預報，但缺少同時刻或可安全插值的參考位置。',no_forecasts:'尚無符合共同時次與 24h 時效的已儲存預報。'};
 const rate=Number.isFinite(score?.rate)?score.rate.toFixed(1)+'%':'尚無可驗證樣本';
 const fields=n?[['命中比例',`${score.hits} / ${n} 筆（${rate}）`],['平均／中位誤差',`${score.meanKm} / ${score.medianKm} km`],['涵蓋颱風',`${score.stormCount} 個`],['資料截止',ft(D.synced)+' '+TZ()],['樣本有效時間',`${ft(score.firstValid)} ～ ${ft(score.lastValid)} ${TZ()}`],['參考資料',`${score.reference} · ${score.provisional?'暫估':'定稿'}`],['比較口徑',score.comparable?'各參與來源的共同案例':'本來源可驗證案例，非公平排名'],['插值樣本',`${score.interpolated} 筆（官方分析間隔不超過 6h）`],['待驗證／缺參考',`${score.waitingCount} / ${score.unmatchedCount} 筆`]]:[];
 accuracyTip.innerHTML=`<b>${escapeHtml(FN[agency])} · ${history?'歷史':'本颱風'}命中率</b><p class="accuracy-definition">24 小時預報位置誤差 ≤100 km 的比例。${history?'最近 365 天已收集的定稿歷史，排除本颱風。':'本颱風截至目前已能驗證的預報，不隨播放游標改變。'}</p>${n?'<dl>'+fields.map(([k,v])=>`<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`).join('')+'</dl>':`<p>${escapeHtml(reasons[score?.reason]||'資料累積中，尚未產生評分。')}</p>`}${n&&score.sampleCount<10?'<p class="accuracy-caution">樣本少於 10 筆，僅供初步參考；此門檻為顯示提醒，不代表統計可靠程度。</p>':''}${score?.provisional&&n?'<p class="accuracy-caution">* 暫估：事後最佳路徑可能修訂結果。</p>':''}<p class="accuracy-footnote">同一起算與有效時間僅計一次，採最早已儲存的合格版本。百分比描述過往表現，不是下次預報成功的機率。</p>`;
 accuracyTip.classList.remove('hide');
 const rect=button.getBoundingClientRect(),box=accuracyTip.getBoundingClientRect();
 const left=rect.right+10+box.width<=innerWidth-8?rect.right+10:Math.max(8,Math.min(rect.left,innerWidth-box.width-8));
 const top=rect.bottom+box.height+8<=innerHeight-8?rect.bottom+8:Math.max(8,rect.top-box.height-8);
 accuracyTip.style.left=left+'px';accuracyTip.style.top=top+'px';
}
sourceList.addEventListener('pointerover',e=>{const button=e.target.closest('[data-accuracy]');if(button&&e.pointerType==='mouse'&&!accuracyPinned)showAccuracyTip(button)});
sourceList.addEventListener('pointerout',e=>{if(e.target.closest('[data-accuracy]')&&!accuracyPinned&&!accuracyTip.contains(e.relatedTarget))accuracyHideTimer=setTimeout(hideAccuracyTip,180)});
sourceList.addEventListener('focusin',e=>{const button=e.target.closest('[data-accuracy]');if(button&&button.matches(':focus-visible'))showAccuracyTip(button)});
sourceList.addEventListener('focusout',e=>{if(e.target.closest('[data-accuracy]')&&!accuracyPinned)hideAccuracyTip()});
sourceList.addEventListener('click',e=>{const button=e.target.closest('[data-accuracy]');if(!button)return;if(accuracyPinned&&accuracyAnchor===button)hideAccuracyTip();else showAccuracyTip(button,true)});
accuracyTip.onpointerenter=()=>clearTimeout(accuracyHideTimer);
accuracyTip.onpointerleave=()=>{if(!accuracyPinned)hideAccuracyTip()};
document.addEventListener('pointerdown',e=>{if(!e.target.closest('[data-accuracy]')&&!accuracyTip.contains(e.target))hideAccuracyTip()});
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!accuracyTip.classList.contains('hide')){e.preventDefault();e.stopImmediatePropagation();hideAccuracyTip()}},true);
document.addEventListener('scroll',e=>{if(!accuracyTip.contains(e.target))hideAccuracyTip()},true);
addEventListener('resize',hideAccuracyTip);
