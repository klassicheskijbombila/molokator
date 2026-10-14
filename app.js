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

// сообщения приложения, не данные магазинов
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

$('start-near').addEventListener('click', () => {
  if (openMap()) locate();
});

$('start-city').addEventListener('click', () => {
  if (openMap()) $('city').focus();
});

$('home').addEventListener('click', () => {
  $('app').hidden = true;
  $('welcome').hidden = false;
});

// каждый новый поиск отменяет предыдущий
function beginSearch() {
  activeController?.abort();
  activeController = new AbortController();
  markers?.clearLayers();
  $('results').replaceChildren();

  return {
    id: ++generation,
    signal: activeController.signal
  };
}

async function requestJSON(url, options, task) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  task.signal.addEventListener('abort', cancel, { once: true });
  if (task.signal.aborted) cancel();

  const timer = setTimeout(cancel, 40000);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
    task.signal.removeEventListener('abort', cancel);
  }
}

$('search').addEventListener('submit', async (event) => {
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
        format: 'json',
        limit: '1',
        countrycodes: 'ru',
        'accept-language': 'ru',
        q: query
      });

      data = await requestJSON(
        `https://nominatim.openstreetmap.org/search?${params}`,
        {},
        task
      );
      cityCache.set(query, data);
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
});

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

$('near').addEventListener('click', locate);

$('radius').addEventListener('click', () => {
  radius = radius === 1 ? 3 : radius === 3 ? 5 : 1;
  $('radius').textContent = `выпас: ${radius} км`;
  if (center) findStores(center.lat, center.lon, beginSearch());
});

$('area').addEventListener('click', () => {
  if (!map) return;
  const point = map.getCenter();
  findStores(point.lat, point.lng, beginSearch());
});

$('retry').addEventListener('click', () => {
  if (center) findStores(center.lat, center.lon, beginSearch());
});

// регистр и пунктуация адресов из источника сохраняются
function getAddress(tags) {
  if (tags['addr:full']) return tags['addr:full'];
  return [
    tags['addr:street'] || tags['addr:place'],
    tags['addr:housenumber']
  ].filter(Boolean).join(', ');
}

async function findStores(lat, lon, task) {
  center = { lat, lon };
  const currentRadius = radius;
  say('обнюхиваем окрестности…');

  const query = `
    [out:json][timeout:25];
    (
      nwr["shop"~"^(supermarket|convenience|grocery|farm|dairy|cheese)$"]
        (around:${currentRadius * 1000},${lat},${lon});
      nwr["amenity"="marketplace"]
        (around:${currentRadius * 1000},${lat},${lon});
    );
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
    say(
      'поиск забуксовал копытами · сервер занят или нет связи · попробуй позже либо уменьши радиус выпаса',
      true
    );
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
      .filter((place) => Number.isFinite(place.lat) && Number.isFinite(place.lon))
      .map((place) => ({
        ...place,
        distance: distance(lat, lon, place.lat, place.lon)
      }))
      .sort((a, b) => a.distance - b.distance);

    const fragment = document.createDocumentFragment();
    const group = L.layerGroup();

    for (const place of places) {
      fragment.append(createCard(place, lat, lon, group));
    }

    markers.clearLayers();
    group.eachLayer((marker) => markers.addLayer(marker));
    $('results').replaceChildren(fragment);

    say(places.length
      ? `муууу рядом: ${places.length} точек · наличие молока не проверено`
      : `здесь пока не мычит · в радиусе ${currentRadius} км точки в OpenStreetMap не найдены`
    );
  } catch (error) {
    console.error(error);
    markers.clearLayers();
    $('results').replaceChildren();
    say('данные получены, но отображение забуксовало', true);
  }
}

function createCard(place, lat, lon, group) {
  // названия магазинов не переводятся в нижний регистр
  const name = place.tags.name || place.tags.brand || 'магазин без названия';
  const address = getAddress(place.tags);
  const popup = document.createElement('div');
  addText(popup, 'strong', name);
  const popupAddress = addText(popup, 'p', address || 'адрес пока не промычали');

  const marker = L.marker([place.lat, place.lon], {
    icon: L.divIcon({
      className: '',
      html: '<div class="pin"></div>',
      iconSize: [28, 28],
      iconAnchor: [14, 28]
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
    ? `часы работы: ${place.tags.opening_hours}`
    : 'расписание пока не промычали'
  );

  const route = document.createElement('a');
  route.textContent = 'молочный путь';
  route.title = 'построить маршрут';
  route.target = '_blank';
  route.rel = 'noopener noreferrer';
  route.href = 'https://www.openstreetmap.org/directions'
    + `?engine=fossgis_osrm_foot&route=${lat},${lon};${place.lat},${place.lon}`;
  route.addEventListener('click', (event) => event.stopPropagation());
  card.append(route);

  if (!address) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'адрес, отзовись!';
    button.title = 'уточнить приблизительный адрес по координатам';
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      resolveAddress(place, addressLine, popupAddress, button);
    });
    card.append(button);
  }

  card.addEventListener('click', () => {
    map.setView([place.lat, place.lon], 16);
    marker.openPopup();
  });

  return card;
}

// обратное геокодирование только по нажатию, с локальным кэшем
async function resolveAddress(place, line, popup, button) {
  const key = `molokator-address-v2:${place.id}`;
  let cached;

  try {
    cached = JSON.parse(localStorage.getItem(key));
  } catch {}

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
      format: 'jsonv2',
      lat: place.lat,
      lon: place.lon,
      zoom: '18',
      'accept-language': 'ru'
    });

    const data = await requestJSON(
      `https://nominatim.openstreetmap.org/reverse?${params}`,
      {},
      { signal: new AbortController().signal }
    );

    if (data.error) throw new Error(data.error);

    const address = data.address || {};
    const street = address.road || address.pedestrian
      || address.residential || address.square;
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

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js')
      .then((registration) => registration.update())
      .catch(console.warn);
  });
}
