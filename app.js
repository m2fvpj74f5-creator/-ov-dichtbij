const STATIC_BASE = "https://bertt.github.io/OVNu/data/";
const REALTIME_API = "/api/departures";
const REFRESH_MS = 30000;
const WINDOW_MS = 60 * 60000;
const MAX_DEPARTURES = 8;
let stops = [];
let loaded = false;
let currentStops = [];
let refreshTimer = null;
const scheduleCache = new Map();

const $ = id => document.getElementById(id);

function hav(a,b,c,d){
  const R=6371000, p=Math.PI/180, d1=(c-a)*p, d2=(d-b)*p;
  const x=Math.sin(d1/2)**2+Math.cos(a*p)*Math.cos(c*p)*Math.sin(d2/2)**2;
  return R*2*Math.asin(Math.sqrt(x));
}
function fmtDist(m){return m<1000?`${Math.round(m)} m`:`${(m/1000).toFixed(1)} km`}
const TZ = "Europe/Amsterdam";
function fmtTime(ms){return new Date(ms).toLocaleTimeString("nl-NL",{hour:"2-digit",minute:"2-digit",timeZone:TZ})}
function fmtClock(ms){return new Date(ms).toLocaleTimeString("nl-NL",{hour:"2-digit",minute:"2-digit",second:"2-digit",timeZone:TZ})}

const tzParts = new Intl.DateTimeFormat("en-US",{timeZone:TZ,hourCycle:"h23",year:"numeric",month:"numeric",day:"numeric",hour:"numeric",minute:"numeric",second:"numeric"});
function amsterdamWall(ms){
  const p=Object.fromEntries(tzParts.formatToParts(new Date(ms)).map(x=>[x.type,+x.value]));
  return {y:p.year,m:p.month,d:p.day,wallMs:Date.UTC(p.year,p.month-1,p.day,p.hour,p.minute,p.second)};
}
/* Schedule times are Dutch wall-clock times; convert them to absolute timestamps independent of the device timezone. */
function amsterdamTime(y,m,d,h,mi,s){
  const wall=Date.UTC(y,m-1,d,h,mi,s);
  const offset=amsterdamWall(wall).wallMs-wall;
  return wall-offset;
}

async function loadStops(){
  if(loaded)return;
  $("status").textContent="Haltes laden…";
  const r=await fetch(STATIC_BASE+"stops.json");
  if(!r.ok) throw new Error("Haltegegevens konden niet worden geladen.");
  stops=await r.json();
  loaded=true;
}

function nearest(lat,lon){
  return stops.map(s=>({...s,dist:hav(lat,lon,s.lat,s.lon)}))
    .sort((a,b)=>a.dist-b.dist)
    .filter((s,i,a)=>i===0 || s.name!==a[i-1].name)
    .slice(0,3);
}

/* The static GTFS schedule per stop is fetched once per session and reused on every refresh. */
async function loadSchedule(stop){
  if(!scheduleCache.has(stop.id)){
    const p=fetch(`${STATIC_BASE}schedules/${encodeURIComponent(stop.id)}.json`)
      .then(r=>r.ok?r.json():[]).catch(()=>{scheduleCache.delete(stop.id);return []});
    scheduleCache.set(stop.id,p);
  }
  return scheduleCache.get(stop.id);
}

function scheduleToday(schedule){
  const {y,m:mo,d:day}=amsterdamWall(Date.now());
  return schedule.map(d=>{
    const [h,m,s]=d.time.split(":").map(Number);
    return {line:d.line,dest:d.headsign,routeId:d.route_id,planned:amsterdamTime(y,mo,day,h,m,s||0)};
  });
}

/* Realtime data is fetched for all visible stops at once from our own cached proxy
   (/api/departures), which reads the OVapi GTFS-Realtime TripUpdates feed. */
async function fetchRealtime(ids){
  try{
    const r=await fetch(`${REALTIME_API}?stops=${ids.map(encodeURIComponent).join(",")}`,{cache:"no-store"});
    if(!r.ok) return {available:false,stops:{}};
    return await r.json();
  }catch{
    return {available:false,stops:{}};
  }
}

const MATCH_TOLERANCE_MS = 2 * 60000;
const MATCH_TOLERANCE_NO_DELAY_MS = 20 * 60000;

function dedupeRealtime(realtime){
  const seen=new Map();
  for(const rt of realtime){
    const key=rt.tripId?`${rt.tripId}|${rt.planned}`:`${rt.routeId}|${rt.planned}|${rt.expected}`;
    if(!seen.has(key)) seen.set(key,rt);
  }
  return [...seen.values()];
}

/* Without a delay the planned time is unknown, so we search wider but never beyond half the headway,
   otherwise a late bus could be attached to the next scheduled trip of the same route. */
function toleranceFor(rt, planned, candidateIdx){
  if(rt.hasDelay!==false) return MATCH_TOLERANCE_MS;
  const same=planned.filter(p=>p.routeId===planned[candidateIdx].routeId).map(p=>p.planned).sort((a,b)=>a-b);
  const pos=same.indexOf(planned[candidateIdx].planned);
  const gaps=[same[pos+1]-same[pos],same[pos]-same[pos-1]].filter(g=>g>0);
  const halfHeadway=gaps.length?Math.min(...gaps)/2:Infinity;
  return Math.min(MATCH_TOLERANCE_NO_DELAY_MS,halfHeadway);
}

/* Greedy global assignment: the closest (realtime, planned) pairs are linked first,
   so each realtime update gets the nearest planned trip that is not yet linked. */
function matchRealtime(planned, realtime){
  const pairs=[];
  realtime.forEach((rt,r)=>{
    const rtPlannedMs=rt.planned*1000;
    planned.forEach((p,i)=>{
      if(p.routeId!==rt.routeId) return;
      const lateBy=rtPlannedMs-p.planned;
      const diff=Math.abs(lateBy);
      // Without a delay, a large negative offset would mean a bus running far ahead of schedule, which is implausible.
      if(rt.hasDelay===false && lateBy<-MATCH_TOLERANCE_MS) return;
      if(diff<=toleranceFor(rt,planned,i)) pairs.push({r,i,diff});
    });
  });
  pairs.sort((a,b)=>a.diff-b.diff);
  const byRealtime=new Map(), usedPlanned=new Set();
  for(const {r,i} of pairs){
    if(byRealtime.has(r)||usedPlanned.has(i)) continue;
    byRealtime.set(r,i); usedPlanned.add(i);
  }
  return {byRealtime,usedPlanned};
}

function mergeDepartures(schedule, realtime){
  const planned=scheduleToday(schedule);
  const updates=dedupeRealtime(realtime);
  const {byRealtime,usedPlanned}=matchRealtime(planned,updates);
  const lineByRoute=new Map(planned.map(p=>[p.routeId,p]));
  const out=[];
  updates.forEach((rt,r)=>{
    const idx=byRealtime.get(r);
    const match=idx!=null?planned[idx]:null;
    const ref=match||lineByRoute.get(rt.routeId);
    const expected=rt.expected*1000;
    const plannedMs=match?match.planned:rt.planned*1000;
    out.push({
      line:ref?.line||"",
      dest:ref?.dest||"",
      planned:plannedMs,
      expected,
      delayMin:Math.round((expected-plannedMs)/60000),
      cancelled:rt.cancelled,
      realtime:true,
    });
  });
  planned.forEach((p,i)=>{ if(!usedPlanned.has(i)) out.push({...p,expected:p.planned,delayMin:0,cancelled:false,realtime:false}); });
  const now=Date.now();
  return out
    .filter(d=>d.expected>=now && d.expected<=now+WINDOW_MS)
    .sort((a,b)=>a.expected-b.expected)
    .slice(0,MAX_DEPARTURES);
}

function relative(ms){
  const min=Math.floor((ms-Date.now())/60000);
  return min<1?"over <1 min":`over ${min} min`;
}

function renderDeparture(d,i){
  const differs=d.realtime && !d.cancelled && fmtTime(d.planned)!==fmtTime(d.expected);
  const badge=d.cancelled
    ?'<span class="badge cancel">GEANNULEERD</span>'
    :d.realtime?'<span class="badge rt">REALTIME</span>':'<span class="badge sched" title="Realtime zodra de bus onderweg is">GEPLAND</span>';
  const delay=d.realtime && !d.cancelled && d.delayMin!==0
    ?` · <span class="${d.delayMin>0?"delay":"early"}">${d.delayMin>0?"+":""}${d.delayMin} min</span>`:"";
  return `<div class="dep ${i===0&&!d.cancelled?"next":""} ${d.cancelled?"cancelled":""}">
    <div class="time">${fmtTime(d.cancelled?d.planned:d.expected)}${differs?`<div class="planned" aria-label="Gepland ${fmtTime(d.planned)}">${fmtTime(d.planned)}</div>`:""}</div>
    <div class="line">${esc(d.line)}</div>
    <div class="dest">${esc(d.dest)}<div class="meta">${badge}<span class="muted">${d.cancelled?"rit vervalt":relative(d.expected)}${delay}</span></div></div>
  </div>`;
}

function renderStop(stop, deps, live){
  const el=document.createElement("article"); el.className="stop";
  const rows=deps.length?deps.map(renderDeparture).join("")
    :`<div class="muted" style="padding-top:12px">Geen vertrektijden in de komende 60 minuten.</div>`;
  el.innerHTML=`<div class="stophead"><div><div class="stopname">${esc(stop.name)}</div>${live?"":`<div class="mode">gepland</div>`}</div><div class="distance">${fmtDist(stop.dist)}</div></div>${rows}`;
  return el;
}
function esc(s){return String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}

function renderUpdated(rt){
  const el=$("updated");
  if(rt.available){
    const stale=rt.stale?" (laatst beschikbare gegevens)":"";
    el.innerHTML=`<span class="dot ${rt.stale?"":"live"}" aria-hidden="true"></span>Realtime bijgewerkt om ${fmtClock(rt.feedTimestamp*1000)}${stale} · vernieuwt elke 30 s`;
  }else{
    el.innerHTML=`<span class="dot" aria-hidden="true"></span>Realtime tijdelijk niet beschikbaar — geplande tijden getoond · opnieuw proberen over 30 s`;
  }
  el.hidden=false;
}

async function refreshDepartures(){
  if(!currentStops.length)return;
  const [rt,schedules]=await Promise.all([
    fetchRealtime(currentStops.map(s=>s.id)),
    Promise.all(currentStops.map(loadSchedule)),
  ]);
  const box=$("stops"); box.innerHTML="";
  currentStops.forEach((s,i)=>{
    const realtime=rt.stops?.[s.id]||[];
    box.appendChild(renderStop(s,mergeDepartures(schedules[i],realtime),realtime.length>0));
  });
  renderUpdated(rt);
}

function scheduleRefresh(){
  clearInterval(refreshTimer);
  refreshTimer=setInterval(()=>{ if(!document.hidden) refreshDepartures(); },REFRESH_MS);
}
document.addEventListener("visibilitychange",()=>{
  if(!document.hidden && currentStops.length){ refreshDepartures(); scheduleRefresh(); }
});

async function start(){
  if(!navigator.geolocation){$("status").innerHTML='<span class="error">Deze browser ondersteunt geen locatie.</span>';return}
  $("locate").disabled=true; $("status").textContent="Locatie bepalen…";
  navigator.geolocation.getCurrentPosition(async pos=>{
    try{
      await loadStops();
      const {latitude:lat,longitude:lon}=pos.coords;
      currentStops=nearest(lat,lon);
      $("status").textContent=`3 dichtstbijzijnde haltes gevonden. Locatie: ${lat.toFixed(5)}, ${lon.toFixed(5)}`;
      await refreshDepartures();
      scheduleRefresh();
    }catch(e){$("status").innerHTML=`<span class="error">${esc(e.message)}</span>`}
    finally{$("locate").disabled=false}
  },err=>{
    $("locate").disabled=false;
    $("status").innerHTML='<span class="error">Locatie kon niet worden opgehaald. Geef de website toestemming voor locatie.</span>';
  },{enableHighAccuracy:true,timeout:10000,maximumAge:30000});
}
$("locate").addEventListener("click",start);
