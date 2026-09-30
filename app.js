const STATIC_BASE = "https://bertt.github.io/OVNu/data/";
let stops = [];
let loaded = false;

const $ = id => document.getElementById(id);

function hav(a,b,c,d){
  const R=6371000, p=Math.PI/180, d1=(c-a)*p, d2=(d-b)*p;
  const x=Math.sin(d1/2)**2+Math.cos(a*p)*Math.cos(c*p)*Math.sin(d2/2)**2;
  return R*2*Math.asin(Math.sqrt(x));
}
function fmtDist(m){return m<1000?`${Math.round(m)} m`:`${(m/1000).toFixed(1)} km`}

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

/* OpenStreetMap is used to discover nearby public-transport platform refs.
   Those refs are often the Dutch stop code used by OVapi. */
async function findRefs(lat,lon){
  const q=`[out:json][timeout:8];(node(around:900,${lat},${lon})[highway=bus_stop][ref];node(around:900,${lat},${lon})[public_transport=platform][ref];);out tags center;`;
  const url="https://overpass-api.de/api/interpreter?data="+encodeURIComponent(q);
  const r=await fetch(url);
  if(!r.ok)return [];
  const j=await r.json();
  return j.elements.map(e=>({ref:e.tags?.ref,name:e.tags?.name||"",lat:e.lat||e.center?.lat,lon:e.lon||e.center?.lon}))
    .filter(x=>x.ref);
}

async function liveDepartures(ref){
  // OVapi's realtime endpoint. Some stops are not present in the legacy endpoint;
  // in that case we simply fall back to the static GTFS schedule.
  const r=await fetch(`https://v0.ovapi.nl/tpc/${encodeURIComponent(ref)}`);
  if(!r.ok) return [];
  const j=await r.json();
  const root=j[ref] || Object.values(j)[0];
  if(!root?.Passes)return [];
  const now=Date.now();
  return Object.values(root.Passes).map(p=>({
    line:p.LineName || p.LinePublicNumber || p.Line || "",
    dest:p.DestinationName50 || p.DestinationName || "",
    expected:p.ExpectedDepartureTime || p.TargetDepartureTime || p.DepartureTime,
    planned:p.TargetDepartureTime || p.DepartureTime,
    cancelled:(p.Status||"").toLowerCase().includes("cancel"),
    mode:p.TransportType||""
  })).filter(x=>x.expected).map(x=>{
    const t=new Date(x.expected).getTime();
    return {...x,ms:t,minutes:Math.max(0,Math.round((t-now)/60000))};
  }).filter(x=>x.ms>=now-60000).sort((a,b)=>a.ms-b.ms).slice(0,5);
}

async function staticDepartures(stop){
  const r=await fetch(`${STATIC_BASE}schedules/${encodeURIComponent(stop.id)}.json`);
  if(!r.ok)return [];
  const data=await r.json();
  const now=new Date(); const min=now.getHours()*60+now.getMinutes();
  return data.filter(d=>{
    const [h,m]=d.time.split(":").map(Number); return h*60+m>=min;
  }).slice(0,5).map(d=>({line:d.line,dest:d.headsign,minutes:null,planned:d.time,static:true}));
}

function renderStop(stop, deps, live){
  const el=document.createElement("article"); el.className="stop";
  const rows=deps.length?deps.map((d,i)=>{
    const time=d.static?d.planned.slice(0,5):new Date(d.expected).toLocaleTimeString("nl-NL",{hour:"2-digit",minute:"2-digit"});
    const rel=d.minutes!=null?(d.minutes===0?"nu":`over ${d.minutes} min`):"dienstregeling";
    return `<div class="dep ${i===0?"next":""}">
      <div class="time">${time}</div><div class="line">${esc(d.line)}</div>
      <div class="dest">${esc(d.dest)}<div class="muted">${rel}${d.cancelled?' · geannuleerd':''}${d.delaySeconds?` · <span class="delay">+${Math.round(d.delaySeconds/60)} min</span>`:""}</div></div>
    </div>`;
  }).join(""):`<div class="muted" style="padding-top:12px">Geen komende vertrektijden gevonden.</div>`;
  el.innerHTML=`<div class="stophead"><div><div class="stopname">${esc(stop.name)}</div><div class="mode">${live?"live waar beschikbaar":"dienstregeling"}</div></div><div class="distance">${fmtDist(stop.dist)}</div></div>${rows}`;
  return el;
}
function esc(s){return String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}

async function start(){
  if(!navigator.geolocation){$("status").innerHTML='<span class="error">Deze browser ondersteunt geen locatie.</span>';return}
  $("locate").disabled=true; $("status").textContent="Locatie bepalen…";
  navigator.geolocation.getCurrentPosition(async pos=>{
    try{
      await loadStops();
      const {latitude:lat,longitude:lon}=pos.coords;
      const ns=nearest(lat,lon);
      $("status").textContent=`3 dichtstbijzijnde haltes gevonden. Locatie: ${lat.toFixed(5)}, ${lon.toFixed(5)}`;
      const refs=await findRefs(lat,lon).catch(()=>[]);
      const box=$("stops"); box.innerHTML="";
      for(const s of ns){
        let deps=[], live=false;
        // Match OSM ref to the nearest selected stop by coordinates.
        const candidates=refs.filter(x=>x.lat&&x.lon).sort((a,b)=>hav(s.lat,s.lon,a.lat,a.lon)-hav(s.lat,s.lon,b.lat,b.lon));
        const ref=candidates[0] && hav(s.lat,s.lon,candidates[0].lat,candidates[0].lon)<150 ? candidates[0].ref : null;
        if(ref){ deps=await liveDepartures(ref).catch(()=>[]); live=deps.length>0; }
        if(!deps.length) deps=await staticDepartures(s);
        box.appendChild(renderStop(s,deps,live));
      }
    }catch(e){$("status").innerHTML=`<span class="error">${esc(e.message)}</span>`}
    finally{$("locate").disabled=false}
  },err=>{
    $("locate").disabled=false;
    $("status").innerHTML='<span class="error">Locatie kon niet worden opgehaald. Geef de website toestemming voor locatie.</span>';
  },{enableHighAccuracy:true,timeout:10000,maximumAge:30000});
}
$("locate").addEventListener("click",start);
