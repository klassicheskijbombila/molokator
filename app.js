const map = L.map('map',{zoomControl:true}).setView([55.7558,37.6173],10);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{
  maxZoom:19, attribution:'&copy; OpenStreetMap'
}).addTo(map);

let markers = L.layerGroup().addTo(map);
let radiusKm = 1;
const radii=[1,3,5];
const statusEl=document.getElementById('status');
const resultsEl=document.getElementById('results');
const radiusBtn=document.getElementById('radius');

radiusBtn.addEventListener('click',()=>{
  radiusKm=radii[(radii.indexOf(radiusKm)+1)%radii.length];
  radiusBtn.textContent=`Радиус: ${radiusKm} км`;
});

document.getElementById('search-form').addEventListener('submit',async e=>{
  e.preventDefault();
  const q=document.getElementById('city').value.trim();
  if(!q) return;
  setStatus('Ищу город…');
  try{
    const r=await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&accept-language=ru&q=${encodeURIComponent(q)}`);
    const data=await r.json();
    if(!data.length) return setStatus('Город не найден. Попробуй ещё раз.');
    const {lat,lon}=data[0];
    map.setView([+lat,+lon],13);
    findMilk(+lat,+lon);
  }catch{
    setStatus('Не удалось найти город.');
  }
});

document.getElementById('nearby').addEventListener('click',()=>{
  if(!navigator.geolocation) return setStatus('Геолокация не поддерживается.');
  setStatus('Определяю, где ты…');
  navigator.geolocation.getCurrentPosition(
    p=>{const{latitude:lat,longitude:lon}=p.coords;map.setView([lat,lon],14);findMilk(lat,lon);},
    ()=>setStatus('Не удалось получить геолокацию.'),
    {enableHighAccuracy:true,timeout:10000}
  );
});

async function findMilk(lat,lon){
  setStatus('Ищу молочные точки… Му!');
  markers.clearLayers();
  resultsEl.innerHTML='';
  const q=`[out:json][timeout:25];
(
  nwr["shop"~"supermarket|convenience|grocery|farm|dairy|cheese"](around:${radiusKm*1000},${lat},${lon});
  nwr["amenity"="marketplace"](around:${radiusKm*1000},${lat},${lon});
);
out center 60;`;
  try{
    const r=await fetch('https://overpass-api.de/api/interpreter',{method:'POST',body:'data='+encodeURIComponent(q)});
    const data=await r.json();
    const places=(data.elements||[]).map(e=>({
      id:e.id,
      name:e.tags?.name||'Магазин без названия',
      lat:e.lat??e.center?.lat,
      lon:e.lon??e.center?.lon,
      tags:e.tags||{}
    })).filter(p=>p.lat&&p.lon);
    if(!places.length) return setStatus(`В радиусе ${radiusKm} км молоко пока не найдено. Попробуй увеличить радиус.`);
    places.forEach(p=>{
      const marker=L.circleMarker([p.lat,p.lon],{
        radius:9,color:'#161616',weight:3,fillColor:'#FF7BAC',fillOpacity:1
      }).addTo(markers);
      marker.bindPopup(`<b>${p.name}</b><br>${p.tags['addr:street']||''} ${p.tags['addr:housenumber']||''}`);
      const dist=distance(lat,lon,p.lat,p.lon);
      const card=document.createElement('div');
      card.className='card';
      card.innerHTML=`<h3>${p.name}</h3>
        <p>${[p.tags['addr:street'],p.tags['addr:housenumber']].filter(Boolean).join(', ')||'Адрес не указан'}</p>
        <p>${dist.toFixed(1)} км • ${openNow(p.tags)?'Вероятно открыто':'Часы работы неизвестны'}</p>
        <a target="_blank" rel="noopener" href="https://www.openstreetmap.org/directions?engine=fossgis_osrm_foot&route=${lat},${lon};${p.lat},${p.lon}">Маршрут</a>`;
      resultsEl.appendChild(card);
      card.addEventListener('click',()=>map.setView([p.lat,p.lon],16));
    });
    setStatus(`Найдено точек: ${places.length}. Это продуктовые и фермерские точки из OpenStreetMap.`);
  }catch{
    setStatus('Overpass API не ответил. Попробуй позже.');
  }
}

function openNow(tags){
  return Boolean(tags.opening_hours);
}
function distance(a,b,c,d){
  const R=6371,dLat=(c-a)*Math.PI/180,dLon=(d-b)*Math.PI/180;
  const x=Math.sin(dLat/2)**2+Math.cos(a*Math.PI/180)*Math.cos(c*Math.PI/180)*Math.sin(dLon/2)**2;
  return 2*R*Math.asin(Math.sqrt(x));
}
function setStatus(t){statusEl.textContent=t;}

if('serviceWorker' in navigator){
  window.addEventListener('load',()=>navigator.serviceWorker.register('sw.js').catch(()=>{}));
}
