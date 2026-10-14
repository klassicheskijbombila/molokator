// молокатор — поиск по категориям и выбор карт
const $ = (id) => document.getElementById(id);
const cityCache = new Map();
let map;
let markers;
let center;
let radius = 1;
let generation = 0;
let activeController;
let lastGeocoderRequest = 0;
let resolvingAddress = false;

function say(message, retry = false) {
  $('status').textContent = message;
  $('retry').hidden = !retry;
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

function isCurrent(task) {
  return task.id === generation;
}

// отличаем таймаут, HTTP-ошибку и некорректный JSON
async function requestJSON(url, options, signal) {
  const controller = new AbortController();
  let timedOut = false;
  const cancel = () => controller.abort();
  signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) cancel();
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, 45000);

  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    if (!response.ok) {
      const error = new Error(`HTTP ${response.status}`);
      error.status = response.status;
      error.details = text.slice(0, 2000);
      throw error;
    }
    try {
      return JSON.parse(text);
    } catch {
      const error = new Error('сервер вернул ответ не в формате JSON');
      error.details = text.slice(0, 2000);
      throw error;
    }
  } catch (error) {
    if (timedOut && !signal.aborted) {
      throw new Error('превышено время ожидания ответа');
    }
    throw error;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', cancel);
  }
}

function errorDescription(error) {
  if (error.status === 429) return 'сервер ограничил частоту запросов · подожди минуту';
  if (error.status === 504) return 'сервер не успел выполнить поиск · попробуй меньший радиус';
  if (error.status === 400) return 'сервер отклонил поисковый запрос · подробности в консоли браузера';
  if (error.status) return `сервер ответил HTTP ${error.status}`;
  if (error.name === 'AbortError') return 'запрос прерван';
  if (/failed to fetch|load failed|networkerror/i.test(error.message)) {
    return 'не удалось связаться с сервером · проверь интернет или повтори позже';
  }
  return error.message || 'неизвестная ошибка';
}

$('search').onsubmit = async (event) => {
  event.preventDefault();
  if (!map) return;
  const query = $('city').value.trim();
  if (!query) return;
  if (!cityCache.has(query) && Date.now() - lastGeocoderRequest < 1500) {
    say('подожди секунду перед следующим поиском');
    return;
  }
  const task = beginSearch();
  say('ищу новое пастбище…');
  try {
    let data = cityCache.get(query);
    if (!data) {
      lastGeocoderRequest = Date.now();
      const params = new URLSearchParams({
        format: 'json', limit: '1', countrycodes: 'ru',
        'accept-language': 'ru', q: query
      });
      data = await requestJSON(
        `https://nominatim.openstreetmap.org/search?${params}`,
        {}, task.signal
      );
      cityCache.set(query, data);
    }
    if (!isCurrent(task)) return;
    if (!Array.isArray(data) || !data.length) {
      say('такого пастбища не нашли · проверь название города');
      return;
    }
    const lat = Number(data[0].lat);
    const lon = Number(data[0].lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      throw new Error('получены неверные координаты города');
    }
    map.setView([lat, lon], 14);
    await findStores(lat, lon, task);
  } catch (error) {
    if (!isCurrent(task)) return;
    console.error('поиск города:', error, error.details || '');
    say(`поиск города забуксовал · ${errorDescription(error)}`);
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
      if (!isCurrent(task)) return;
      const { latitude: lat, longitude: lon } = position.coords;
      map.setView([lat, lon], 14);
      findStores(lat, lon, task);
    },
    () => {
      if (isCurrent(task)) {
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
$('categories').onchange = (event) => {
  if (!$('grocery').checked && !$('farm').checked) {
    event.target.checked = true;
    say('оставь хотя бы одну категорию для поиска');
    return;
  }
  if (center) findStores(center.lat, center.lon, beginSearch());
  else say('категории выбраны · укажи город или своё местоположение');
};

function getAddress(tags) {
  if (tags['addr:full']) return tags['addr:full'];
  return [tags['addr:street'] || tags['addr:place'], tags['addr:housenumber']]
    .filter(Boolean).join(', ');
}

async function findStores(lat, lon, task) {
  center = { lat, lon };
  const currentRadius = radius;
  const around = `(around:${currentRadius * 1000},${lat},${lon})`;
  const clauses = [];
  if ($('grocery').checked) {
    clauses.push(`nwr["shop"~"^(supermarket|convenience|grocery|dairy|cheese)$"]${around};`);
  }
  if ($('farm').checked) {
    clauses.push(`nwr["shop"="farm"]${around};`);
    clauses.push(`nwr["amenity"="marketplace"]${around};`);
  }
  if (!clauses.length) {
    say('выбери хотя бы одну категорию');
    return;
  }
  say('обнюхиваем окрестности…');
  const query = `[out:json][timeout:25];(${clauses.join('\n')});out center;`;
  let data;
  try {
    data = await requestJSON(
      'https://overpass-api.de/api/interpreter',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
        body: new URLSearchParams({ data: query })
      },
      task.signal
    );
    if (data.remark || !Array.isArray(data.elements)) {
      throw new Error(data.remark || 'сервер не прислал список объектов');
    }
  } catch (error) {
    if (!isCurrent(task)) return;
    console.error('поиск магазинов:', error, error.details || '', { query });
    say(`поиск забуксовал · ${errorDescription(error)}`, true);
    return;
  }
  if (!isCurrent(task)) return;

  try {
    const places = data.elements
      .map((element) => ({
        id: `${element.type}/${element.id}`,
        lat: element.lat ?? element.center?.lat,
        lon: element.lon ?? element.center?.lon,
        tags: element.tags || {}
      }))
      .filter((place) => Number.isFinite(place.lat) && Number.isFinite(place.lon))
      .map((place) => ({ ...place, distance: distance(lat, lon, place.lat, place.lon) }))
      .sort((a, b) => a.distance - b.distance);
    const fragment = document.createDocumentFragment();
    const group = L.layerGroup();
    for (const place of places) fragment.append(createCard(place, group));
    markers.clearLayers();
    group.eachLayer((marker) => markers.addLayer(marker));
    $('results').replaceChildren(fragment);
    say(places.length
      ? `муууу рядом: ${places.length} точек · наличие молока не проверено`
      : `в радиусе ${currentRadius} км точки выбранных категорий в OpenStreetMap не найдены`
    );
  } catch (error) {
    console.error('отображение:', error);
    markers.clearLayers();
    $('results').replaceChildren();
    say(`данные получены, но отображение забуксовало · ${errorDescription(error)}`, true);
  }
}

function createCard(place, group) {
  const name = place.tags.name || place.tags.brand || 'магазин без названия';
  const address = getAddress(place.tags);
  const popup = document.createElement('div');
  addText(popup, 'strong', name);
  const popupAddress = addText(popup, 'p', address || 'адрес пока не промычали');
  const popupRoute = document.createElement('button');
  popupRoute.type = 'button';
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
  const category = place.tags.amenity === 'marketplace'
    ? 'рынок' : place.tags.shop === 'farm' ? 'фермерская лавка' : 'продуктовый магазин';
  addText(card, 'p', category);
  const line = addText(card, 'p', address || 'адрес пока не промычали');
  const length = place.distance < 1
    ? `${Math.round(place.distance * 1000)} м` : `${place.distance.toFixed(1)} км`;
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
      resolveAddress(place, line, popupAddress, button);
    };
    card.append(button);
  }
  card.onclick = () => {
    map.setView([place.lat, place.lon], 16);
    marker.openPopup();
  };
  return card;
}

// работает и без элемента destination в вашем новом диалоге
function openRoutes(place) {
  const dialog = $('routes');
  const container = $('providers');
  if (!dialog || !container) {
    say('не найдено окно выбора карт · проверь routes и providers в index.html');
    return;
  }
  const point = `${place.lat},${place.lon}`;
  if ($('destination')) {
    $('destination').textContent = place.tags.name || place.tags.brand || 'выбранная точка';
  }
  const providers = [
    ['Яндекс Карты', 'https://yandex.ru/maps/?' + new URLSearchParams({ rtext: `~${point}`, rtt: 'pd' })],
    ['2ГИС', 'https://2gis.ru/directions/tab/pedestrian/points/' + encodeURIComponent(`|${place.lon},${place.lat}`)],
    ['Google Maps', 'https://www.google.com/maps/dir/?' + new URLSearchParams({ api: '1', destination: point, travelmode: 'walking' })],
    ['Apple Maps', 'https://maps.apple.com/?' + new URLSearchParams({ daddr: point, dirflg: 'w' })]
  ];
  container.replaceChildren();
  for (const [name, url] of providers) {
    const link = document.createElement('a');
    link.textContent = name;
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    container.append(link);
  }
  if (!dialog.open) dialog.showModal();
}

$('close-routes')?.addEventListener('click', () => $('routes')?.close());
$('routes')?.addEventListener('click', (event) => {
  const dialog = $('routes');
  if (event.target !== dialog) return;
  const rect = dialog.getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right
      || event.clientY < rect.top || event.clientY > rect.bottom) {
    dialog.close();
  }
});

async function resolveAddress(place, line, popup, button) {
  const key = `molokator-address-v2:${place.id}`;
  let cached;
  try { cached = JSON.parse(localStorage.getItem(key)); } catch {}
  const show = (value) => {
    line.textContent = value;
    popup.textContent = value;
    button.hidden = true;
  };
  if (cached && typeof cached.value === 'string' && Date.now() - cached.time < 30 * 86400000) {
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
      {}, new AbortController().signal
    );
    if (data.error) throw new Error(data.error);
    const address = data.address || {};
    const street = address.road || address.pedestrian || address.residential || address.square;
    const parts = [street, address.house_number].filter(Boolean);
    if (!parts.length) throw new Error('адрес не найден');
    const value = `примерно: ${parts.join(', ')}`;
    show(value);
    try { localStorage.setItem(key, JSON.stringify({ value, time: Date.now() })); } catch {}
  } catch (error) {
    console.error('адрес:', error);
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

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js')
      .then((registration) => registration.update())
      .catch(console.warn);
  });
}
