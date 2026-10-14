const $ = (id) => document.getElementById(id);
let map, markers, center, activeController;
let radius = 1;
let generation = 0;
let lastGeocoderRequest = 0;
let resolvingAddress = false;
const cities = new Map();

function say(message, retry = false) {
  $('status').textContent = message;
  $('retry').hidden = !retry;
}

// дополнительное оформление без изменения style.css
const extraStyle = document.createElement('style');
extraStyle.textContent = `
  button { color: var(--ink, #201b20); -webkit-appearance: none; appearance: none; }
  .route-dialog {
    width: min(440px, calc(100% - 32px));
    border: 2px solid #201b20;
    border-radius: 24px;
    padding: 24px;
    background: #fff8fc;
    color: #201b20;
    max-height: 85svh;
    overflow: auto;
  }
  .route-dialog::backdrop { background: #201b2066; }
  .route-dialog h2 { margin: 0 0 10px; }
  .route-dialog p { font-size: 13px; line-height: 1.5; }
  .route-links { display: grid; gap: 10px; margin: 18px 0; }
  .route-links a {
    color: #201b20;
    text-decoration: none;
    background: white;
    border: 2px solid #201b20;
    border-radius: 16px;
    padding: 14px;
    font-weight: 650;
  }
  .route-links a:focus-visible { outline: 3px solid #b83288; }
  .route-close { width: 100%; }
  @media (max-width: 700px) {
    .route-dialog {
      margin: auto 0 0;
      width: 100%;
      max-width: none;
      border-radius: 24px 24px 0 0;
      padding-bottom: calc(24px + env(safe-area-inset-bottom));
    }
  }
`;
document.head.append(extraStyle);

// диалог создаётся программно — существующий index.html менять не нужно
const routeDialog = document.createElement('dialog');
routeDialog.className = 'route-dialog';
routeDialog.setAttribute('aria-labelledby', 'route-heading');
routeDialog.innerHTML = `
  <h2 id="route-heading">молочный путь</h2>
  <p>с кем пойдём за молоком?</p>
  <p id="route-destination"></p>
  <nav class="route-links" aria-label="выбор карт"></nav>
  <p>начальную точку определят выбранные карты или предложат ввести её вручную</p>
  <p>на телефоне может открыться приложение, на компьютере — сайт сервиса</p>
  <button class="route-close" type="button">закрыть</button>
`;
document.body.append(routeDialog);
routeDialog.querySelector('.route-close').onclick = () => routeDialog.close();
routeDialog.addEventListener('click', (event) => {
  if (event.target !== routeDialog) return;
  const rect = routeDialog.getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right
      || event.clientY < rect.top || event.clientY > rect.bottom) {
    routeDialog.close();
  }
});

function openRoutes(place) {
  const latLon = `${place.lat},${place.lon}`;
  const destination = place.tags.name || place.tags.brand || 'фермерская лавка';
  routeDialog.querySelector('#route-destination').textContent = destination;

  const providers = [
    {
      name: 'Яндекс Карты',
      url: 'https://yandex.ru/maps/?' + new URLSearchParams({
        rtext: `~${latLon}`,
        rtt: 'pd'
      })
    },
    {
      name: '2ГИС',
      url: 'https://2gis.ru/directions/tab/pedestrian/points/'
        + encodeURIComponent(`|${place.lon},${place.lat}`)
    },
    {
      name: 'Google Maps',
      url: 'https://www.google.com/maps/dir/?' + new URLSearchParams({
        api: '1',
        destination: latLon,
        travelmode: 'walking'
      })
    },
    {
      name: 'Apple Maps',
      url: 'https://maps.apple.com/?' + new URLSearchParams({
        daddr: latLon,
        dirflg: 'w'
      })
    }
  ];

  const container = routeDialog.querySelector('.route-links');
  container.replaceChildren();
  for (const provider of providers) {
    const link = document.createElement('a');
    link.textContent = provider.name;
    link.href = provider.url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    container.append(link);
  }
  routeDialog.showModal();
}

function openMap() {
  $('welcome').hidden = true;
  $('app').hidden = false;
  if (!map) {
    if (!window.L) {
      say('карта не загрузилась · проверь интернет и обнови страницу');
      return false;
    }
    map = L.map('map').setView([55.7558, 37.6173], 11);
    map.attributionControl.setPrefix(
      '<a href="https://leafletjs.com/" target="_blank" rel="noopener">Leaflet</a>'
    );
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    }).addTo(map);
    markers = L.layerGroup().addTo(map);
  }
  requestAnimationFrame(() => map.invalidateSize());
  return true;
}

$('start-near').onclick = () => { if (openMap()) locate(); };
$('start-city').onclick = () => { if (openMap()) $('city').focus(); };
$('home').onclick = () => {
  $('app').hidden = true;
  $('welcome').hidden = false;
};

function beginSearch() {
  activeController?.abort();
  activeController = new AbortController();
  markers?.clearLayers();
  $('results').replaceChildren();
  return { id: ++generation, signal: activeController.signal };
}

async function requestJSON(url, options, task) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  task.signal.addEventListener('abort', cancel, { once: true });
  if (task.signal.aborted) cancel();
  const timer = setTimeout(cancel, 40000);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
    task.signal.removeEventListener('abort', cancel);
  }
}

$('search').onsubmit = async (event) => {
  event.preventDefault();
  if (!map) return;
  const query = $('city').value.trim();
  if (!query) return;
  if (!cities.has(query) && Date.now() - lastGeocoderRequest < 1500) {
    say('подожди секунду перед следующим поиском');
    return;
  }
  const task = beginSearch();
  say('ищу новое пастбище…');
  try {
    let data = cities.get(query);
    if (!data) {
      lastGeocoderRequest = Date.now();
      const params = new URLSearchParams({
        format: 'json', limit: '1', countrycodes: 'ru',
        'accept-language': 'ru', q: query
      });
      data = await requestJSON(
        `https://nominatim.openstreetmap.org/search?${params}`, {}, task
      );
      cities.set(query, data);
    }
    if (task.id !== generation) return;
    if (!data.length) {
      say('такого пастбища не нашли · проверь название города');
      return;
    }
    const lat = Number(data[0].lat);
    const lon = Number(data[0].lon);
    map.setView([lat, lon], 14);
    await findStores(lat, lon, task);
  } catch (error) {
    if (task.id !== generation) return;
    console.error(error);
    say('поиск города забуксовал · проверь интернет и повтори позже');
  }
};

function locate() {
  if (!map) return;
  const task = beginSearch();
  if (!navigator.geolocation) {
    say('геолокация недоступна · выбери город');
    return;
  }
  say('выясняем, на каком ты пастбище…');
  navigator.geolocation.getCurrentPosition(
    (position) => {
      if (task.id !== generation) return;
      const { latitude: lat, longitude: lon } = position.coords;
      map.setView([lat, lon], 14);
      findStores(lat, lon, task);
    },
    () => {
      if (task.id === generation) {
        say('потеряли след копыт · разреши геолокацию или выбери город');
      }
    },
    { timeout: 15000, maximumAge: 60000 }
  );
}

$('near').onclick = locate;
$('radius').onclick = () => {
  radius = radius === 1 ? 3 : radius === 3 ? 5 : 1;
  $('radius').textContent = `выпас: ${radius} км`;
  if (center) findStores(center.lat, center.lon, beginSearch());
};
$('area').onclick = () => {
  if (!map) return;
  const point = map.getCenter();
  findStores(point.lat, point.lng, beginSearch());
};
$('retry').onclick = () => {
  if (center) findStores(center.lat, center.lon, beginSearch());
};

function getAddress(tags) {
  if (tags['addr:full']) return tags['addr:full'];
  return [tags['addr:street'] || tags['addr:place'], tags['addr:housenumber']]
    .filter(Boolean).join(', ');
}

async function findStores(lat, lon, task) {
  center = { lat, lon };
  const currentRadius = radius;
  say('ищу фермерские лавки…');

  // строго фермерские магазины по тегу OpenStreetMap
  const query = `
    [out:json][timeout:25];
    nwr["shop"="farm"](around:${currentRadius * 1000},${lat},${lon});
    out center;
  `;
  let data;
  try {
    data = await requestJSON(
      'https://overpass-api.de/api/interpreter',
      { method: 'POST', body: new URLSearchParams({ data: query }) },
      task
    );
    if (data.remark || !Array.isArray(data.elements)) {
      throw new Error(data.remark || 'неверный ответ');
    }
  } catch (error) {
    if (task.id !== generation) return;
    console.error(error);
    say('поиск забуксовал копытами · сервер занят или нет связи · попробуй позже', true);
    return;
  }
  if (task.id !== generation) return;

  try {
    const places = data.elements
      .map((element) => ({
        id: `${element.type}/${element.id}`,
        lat: element.lat ?? element.center?.lat,
        lon: element.lon ?? element.center?.lon,
        tags: element.tags || {}
      }))
      .filter((place) => place.tags.shop === 'farm'
        && Number.isFinite(place.lat) && Number.isFinite(place.lon))
      .map((place) => ({ ...place, distance: distance(lat, lon, place.lat, place.lon) }))
      .sort((a, b) => a.distance - b.distance);

    const fragment = document.createDocumentFragment();
    const group = L.layerGroup();
    for (const place of places) fragment.append(createCard(place, group));
    markers.clearLayers();
    group.eachLayer((marker) => markers.addLayer(marker));
    $('results').replaceChildren(fragment);
    say(places.length
      ? `муууу рядом: ${places.length} фермерских точек · наличие молока не проверено`
      : `в радиусе ${currentRadius} км фермерские лавки в OpenStreetMap не найдены · расширь радиус выпаса`
    );
  } catch (error) {
    console.error(error);
    markers.clearLayers();
    $('results').replaceChildren();
    say('данные получены, но отображение забуксовало', true);
  }
}

function createCard(place, group) {
  const name = place.tags.name || place.tags.brand || 'фермерская лавка';
  const address = getAddress(place.tags);
  const popup = document.createElement('div');
  addText(popup, 'strong', name);
  const popupAddress = addText(popup, 'p', address || 'адрес пока не промычали');
  const popupRoute = document.createElement('button');
  popupRoute.textContent = 'молочный путь';
  popupRoute.onclick = () => openRoutes(place);
  popup.append(popupRoute);

  const marker = L.marker([place.lat, place.lon], {
    icon: L.divIcon({
      className: '', html: '<div class="pin"></div>',
      iconSize: [28, 28], iconAnchor: [14, 28]
    })
  }).bindPopup(popup).addTo(group);

  const card = document.createElement('article');
  card.className = 'card';
  addText(card, 'h3', name);
  const addressLine = addText(card, 'p', address || 'адрес пока не промычали');
  const length = place.distance < 1
    ? `${Math.round(place.distance * 1000)} м`
    : `${place.distance.toFixed(1)} км`;
  addText(card, 'p', `${length} по прямой`);
  addText(card, 'p', place.tags.opening_hours
    ? `часы работы: ${place.tags.opening_hours}` : 'расписание пока не промычали');

  const route = document.createElement('button');
  route.type = 'button';
  route.textContent = 'молочный путь';
  route.onclick = (event) => {
    event.stopPropagation();
    openRoutes(place);
  };
  card.append(route);

  if (!address) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'адрес, отзовись!';
    button.onclick = (event) => {
      event.stopPropagation();
      resolveAddress(place, addressLine, popupAddress, button);
    };
    card.append(button);
  }
  card.onclick = () => {
    map.setView([place.lat, place.lon], 16);
    marker.openPopup();
  };
  return card;
}

async function resolveAddress(place, line, popup, button) {
  const key = `molokator-address-v2:${place.id}`;
  let cached;
  try { cached = JSON.parse(localStorage.getItem(key)); } catch {}
  const show = (value) => {
    line.textContent = value;
    popup.textContent = value;
    button.hidden = true;
  };
  if (cached && Date.now() - cached.time < 30 * 86400000) {
    show(cached.value);
    return;
  }
  if (resolvingAddress || Date.now() - lastGeocoderRequest < 1500) {
    line.textContent = 'подожди секунду и нажми уточнение ещё раз';
    return;
  }
  resolvingAddress = true;
  lastGeocoderRequest = Date.now();
  button.disabled = true;
  line.textContent = 'уточняем адрес…';
  try {
    const params = new URLSearchParams({
      format: 'jsonv2', lat: place.lat, lon: place.lon,
      zoom: '18', 'accept-language': 'ru'
    });
    const data = await requestJSON(
      `https://nominatim.openstreetmap.org/reverse?${params}`,
      {}, { signal: new AbortController().signal }
    );
    if (data.error) throw new Error(data.error);
    const address = data.address || {};
    const street = address.road || address.pedestrian || address.residential || address.square;
    const parts = [street, address.house_number].filter(Boolean);
    if (!parts.length) throw new Error('адрес не найден');
    const value = `примерно: ${parts.join(', ')}`;
    show(value);
    try {
      localStorage.setItem(key, JSON.stringify({ value, time: Date.now() }));
    } catch {}
  } catch (error) {
    console.error(error);
    line.textContent = 'адрес уточнить не удалось · маршрут доступен по координатам';
  } finally {
    button.disabled = false;
    resolvingAddress = false;
  }
}

function addText(parent, tag, value) {
  const element = document.createElement(tag);
  element.textContent = value;
  parent.append(element);
  return element;
}

function distance(a, b, c, d) {
  const radians = Math.PI / 180;
  const value = Math.sin((c - a) * radians / 2) ** 2
    + Math.cos(a * radians) * Math.cos(c * radians)
    * Math.sin((d - b) * radians / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(Math.min(1, Math.max(0, value))));
}

// уточняем описание текущего режима в существующем интерфейсе
$('status').textContent = 'ищем только фермерские лавки · выбери город или своё местоположение';
const footer = $('app').querySelector('.footer');
if (footer) {
  footer.textContent = 'фермерские точки из OpenStreetMap · наличие молока не проверено · расстояния по прямой';
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js')
      .then((registration) => registration.update())
      .catch(console.warn);
  });
}
