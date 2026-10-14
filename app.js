const $=id=>document.getElementById(id);
let map,markers,center,radius=1,serial=0,controller,lastGeo=0;
const cities=new Map();
function say(message,retry=false){$('status').textContent=message;$('retry').hidden=!retry;}
function openMap(){
 $('welcome').hidden=true;$('app').hidden=false;
 if(!map){if(!window.L){say('Карта не загрузилась. Проверь интернет и обнови страницу.');return false;}
 map=L.map('map').setView([55.7558,37.6173],11);
 map.attributionControl.setPrefix('<a href="https://leafletjs.com/" target="_blank" rel="noopener">Leaflet</a>');
 L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'}).addTo(map);
 markers=L.layerGroup().addTo(map);}
 requestAnimationFrame(()=>map.invalidateSize());return true;
}
$('start-near').onclick=()=>{if(openMap())locate();};
$('start-city').onclick=()=>{if(openMap())$('city').focus();};
$('home').onclick=()=>{$('app').hidden=true;$('welcome').hidden=false;};
function begin(){controller?.abort();controller=new AbortController();markers?.clearLayers();$('results').replaceChildren();return {id:++serial,signal:controller.signal};}
async function json(url,options,t){const c=new AbortController(),stop=()=>c.abort();t.signal.addEventListener('abort',stop,{once:true});if(t.signal.aborted)stop();const timer=setTimeout(stop,40000);try{const r=await fetch(url,{...options,signal:c.signal});if(!r.ok)throw Error('HTTP '+r.status);return await r.json();}finally{clearTimeout(timer);t.signal.removeEventListener('abort',stop);}}
$('search').onsubmit=async e=>{e.preventDefault();if(!map)return;const q=$('city').value.trim();if(!q)return;if(!cities.has(q)&&Date.now()-lastGeo<1500){say('Подожди секунду перед следующим поиском.');return;}const t=begin();say('Ищу новое пастбище…');try{let d=cities.get(q);if(!d){lastGeo=Date.now();d=await json('https://nominatim.openstreetmap.org/search?'+new URLSearchParams({format:'json',limit:'1',countrycodes:'ru','accept-language':'ru',q}),{},t);cities.set(q,d);}if(t.id!==serial)return;if(!d.length){say('Такого пастбища не нашли. Проверь название города.');return;}const lat=+d[0].lat,lon=+d[0].lon;map.setView([lat,lon],14);await find(lat,lon,t);}catch(e){if(t.id===serial){console.error(e);say('Поиск города забуксовал. Проверь интернет и повтори позже.');}}};
function locate(){if(!map)return;const t=begin();if(!navigator.geolocation){say('Геолокация недоступна. Выбери город.');return;}say('Выясняем, на каком ты пастбище…');navigator.geolocation.getCurrentPosition(p=>{if(t.id!==serial)return;const {latitude:lat,longitude:lon}=p.coords;map.setView([lat,lon],14);find(lat,lon,t);},()=>{if(t.id===serial)say('Потеряли след копыт. Разреши геолокацию или выбери город.');},{timeout:15000,maximumAge:60000});}
$('near').onclick=locate;
$('radius').onclick=()=>{radius=radius===1?3:radius===3?5:1;$('radius').textContent='Выпас: '+radius+' км';if(center)find(center.lat,center.lon,begin());};
$('area').onclick=()=>{if(map){const p=map.getCenter();find(p.lat,p.lng,begin());}};
$('retry').onclick=()=>{if(center)find(center.lat,center.lon,begin());};
function address(tags){if(tags['addr:full'])return tags['addr:full'];const a=[tags['addr:street']||tags['addr:place'],tags['addr:housenumber']].filter(Boolean);return a.join(', ');}
async function find(lat,lon,t){center={lat,lon};const km=radius;say('Обнюхиваем окрестности…');let data;try{const query=`[out:json][timeout:25];(nwr["shop"~"^(supermarket|convenience|grocery|farm|dairy|cheese)$"](around:${km*1000},${lat},${lon});nwr["amenity"="marketplace"](around:${km*1000},${lat},${lon}););out center;`;data=await json('https://overpass-api.de/api/interpreter',{method:'POST',body:new URLSearchParams({data:query})},t);if(data.remark||!Array.isArray(data.elements))throw Error(data.remark||'Неверный ответ');}catch(e){if(t.id===serial){console.error(e);say('Поиск забуксовал копытами. Сервер занят или нет связи. Попробуй позже либо уменьши радиус выпаса.',true);}return;}if(t.id!==serial)return;
try{const places=data.elements.map(e=>({id:e.type+'/'+e.id,lat:e.lat??e.center?.lat,lon:e.lon??e.center?.lon,tags:e.tags||{}})).filter(p=>Number.isFinite(p.lat)&&Number.isFinite(p.lon)).map(p=>({...p,d:dist(lat,lon,p.lat,p.lon)})).sort((a,b)=>a.d-b.d);const fragment=document.createDocumentFragment(),group=L.layerGroup();
for(const p of places){const name=p.tags.name||p.tags.brand||'Магазин без названия',addr=address(p.tags),popup=document.createElement('div');text(popup,'strong',name);const popupAddress=text(popup,'p',addr||'Адрес пока не промычали');const marker=L.marker([p.lat,p.lon],{icon:L.divIcon({className:'',html:'<div class="pin"></div>',iconSize:[28,28],iconAnchor:[14,28]})}).bindPopup(popup).addTo(group);
const card=document.createElement('article');card.className='card';text(card,'h3',name);const addressLine=text(card,'p',addr||'Адрес пока не промычали');text(card,'p',(p.d<1?Math.round(p.d*1000)+' м':p.d.toFixed(1)+' км')+' по прямой');text(card,'p',p.tags.opening_hours?'Часы работы: '+p.tags.opening_hours:'Расписание пока не промычали');
const a=document.createElement('a');a.textContent='Молочный путь';a.title='Построить маршрут';a.target='_blank';a.rel='noopener noreferrer';a.href=`https://www.openstreetmap.org/directions?engine=fossgis_osrm_foot&route=${lat},${lon};${p.lat},${p.lon}`;a.onclick=e=>e.stopPropagation();card.append(a);
if(!addr){const button=document.createElement('button');button.textContent='Адрес, отзовись!';button.title='Уточнить приблизительный адрес по координатам';button.onclick=e=>{e.stopPropagation();resolveAddress(p,addressLine,popupAddress,button);};card.append(button);}
card.onclick=()=>{map.setView([p.lat,p.lon],16);marker.openPopup();};fragment.append(card);}
markers.clearLayers();group.eachLayer(l=>markers.addLayer(l));$('results').replaceChildren(fragment);say(places.length?`Му рядом: ${places.length} точек. Наличие молока не проверено.`:`Здесь пока не мычит. В радиусе ${km} км точки в OpenStreetMap не найдены.`);
}catch(e){console.error(e);markers.clearLayers();$('results').replaceChildren();say('Данные получены, но отображение забуксовало.',true);}}
let resolving=false;
async function resolveAddress(p,line,popup,button){const key='molokator-address-v1:'+p.id;let cached;try{cached=JSON.parse(localStorage.getItem(key));}catch{}
function show(value){line.textContent=value;popup.textContent=value;button.hidden=true;}
if(cached&&Date.now()-cached.time<30*86400000){show(cached.value);return;}
if(resolving||Date.now()-lastGeo<1500){line.textContent='Подожди секунду и нажми уточнение ещё раз.';return;}
resolving=true;lastGeo=Date.now();button.disabled=true;line.textContent='Уточняем адрес…';
try{const t={signal:new AbortController().signal};const d=await json('https://nominatim.openstreetmap.org/reverse?'+new URLSearchParams({format:'jsonv2',lat:p.lat,lon:p.lon,zoom:'18','accept-language':'ru'}),{},t);if(d.error)throw Error(d.error);const a=d.address||{},street=a.road||a.pedestrian||a.residential||a.square,parts=[street,a.house_number].filter(Boolean);if(!parts.length)throw Error('Адрес не найден');const value='Примерно: '+parts.join(', ');show(value);try{localStorage.setItem(key,JSON.stringify({value,time:Date.now()}));}catch{}}
catch(e){console.error(e);line.textContent='Адрес уточнить не удалось. Маршрут доступен по координатам.';}
finally{button.disabled=false;resolving=false;}}
function text(parent,tag,value){const el=document.createElement(tag);el.textContent=value;parent.append(el);return el;}
function dist(a,b,c,d){const r=Math.PI/180,x=Math.sin((c-a)*r/2)**2+Math.cos(a*r)*Math.cos(c*r)*Math.sin((d-b)*r/2)**2;return 12742*Math.asin(Math.sqrt(Math.min(1,Math.max(0,x))));}
if('serviceWorker' in navigator)window.addEventListener('load',()=>navigator.serviceWorker.register('./sw.js').then(r=>r.update()).catch(console.warn));
