// app.js — application entry point (ES module).
// Imports pure utilities from routing.js and marker factories from markers.js.
// Owns all mutable state and wires up the UI.

import {
  ORS_KEY, ORS_MATRIX, PRE_FILTER_N, CACHE_TTL_MS,
  ROUTE_COLORS, ROUTE_OFFSETS,
  haversine, reverseGeocode, showToast,
  offsetPolyline, computeIconAnchors, fetchRoute,
} from './routing.js';

import { initClusterGroups, buildContainerMarker } from './markers.js';

import { t, currentLang, setLang } from './i18n.js';

// ============================================================
// City adapter registry + active adapter
// (adapters/*.js scripts register on window.CityAdapters before this module runs)
// ============================================================

const _savedCityId = localStorage.getItem('afvalcontainers_city') || 'amsterdam';
let currentAdapter = window.CityAdapters[_savedCityId] || window.CityAdapters.amsterdam;
let FRACTIONS      = currentAdapter.fractions;

// ── i18n helpers ──────────────────────────────────────────────────────────

/** Returns the localised fraction name. */
const fn = frac => t(frac.nameKey);

/** Re-populates the city <select> from the adapter registry. */
function populateCitySelect() {
  const sel = document.getElementById('city-select');
  if (!sel) return;
  sel.innerHTML = '';
  Object.values(window.CityAdapters).forEach(adapter => {
    sel.appendChild(new Option(t(adapter.nameKey), adapter.id));
  });
  sel.value = currentAdapter.id;
}

/** Updates the sidebar data-credit text from the current adapter. */
function updateDataCredit() {
  const el = document.querySelector('.data-credit');
  if (!el) return;
  const credit = currentAdapter.dataCredit;
  if (credit) el.innerHTML = credit[currentLang] || credit.en;
}

/** Re-populates the type <select> based on the current adapter's fractions. */
function populateTypeSelect() {
  const sel = document.getElementById('type-select');
  sel.options[0].textContent = t('typeAll');
  while (sel.options.length > 1) sel.remove(1);
  Object.entries(FRACTIONS).forEach(([code, frac]) => {
    sel.appendChild(new Option(`${frac.emoji}  ${t(frac.nameKey)}`, code));
  });
  sel.value = selectedType;
}

// React to language switches triggered by setLang() in i18n.js
document.addEventListener('langchange', () => {
  populateCitySelect();
  populateTypeSelect();
  updateDataCredit();
  updateInstruction();
});

// ============================================================
// State
// ============================================================

let allContainers       = [];   // flat array of all loaded container objects
let selectedType        = '';   // fractie_code filter, '' = all shown
let selectedPoint       = null; // { lat, lng }
let selectedContainerId = null; // id of the container used as start point, or null
let mode                = 'container'; // 'point' | 'container'
let topN                = 3;    // number of nearest candidates to show

let startMarker      = null;
let nearestMarkers   = [];
let routePolylines   = [];
let clusterGroups    = {};  // fractie_code → L.markerClusterGroup
let containerMarkers = {};  // container id → L.marker (for hiding source dot)
let containerCodes   = {};  // container id → fractie_code (for spiderfy group check)
let _spiderfied      = [];  // {marker, origLatLng}[] — currently spread out
let _unspiderfyTimer = null;

// ============================================================
// Map
// ============================================================

const MAP_VIEW_KEY = 'afvalcontainers_view';

const savedView = (() => {
  try { return JSON.parse(localStorage.getItem(MAP_VIEW_KEY)); } catch { return null; }
})();

const map = L.map('map', {
  center: savedView ? savedView.center : currentAdapter.center,
  zoom:   savedView ? savedView.zoom   : currentAdapter.zoom,
  zoomControl: true,
});

map.on('moveend zoomend', () => {
  try {
    localStorage.setItem(MAP_VIEW_KEY, JSON.stringify({
      center: [map.getCenter().lat, map.getCenter().lng],
      zoom:   map.getZoom(),
    }));
  } catch { /* storage unavailable */ }
});

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
}).addTo(map);

// ============================================================
// Cluster groups (one per fraction, so we can toggle visibility)
// ============================================================

clusterGroups = initClusterGroups(map, FRACTIONS);

// ============================================================
// Cache helpers
// ============================================================

function purgeOldCaches() {
  const validKeys = new Set([
    MAP_VIEW_KEY,
    'afvalcontainers_city',
    ...Object.values(window.CityAdapters).map(a => a.cacheKey),
  ]);
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const k = localStorage.key(i);
    if (k && k.startsWith('afvalcontainers_') && !validKeys.has(k)) {
      localStorage.removeItem(k);
    }
  }
}

function readCache() {
  purgeOldCaches();
  try {
    const raw = localStorage.getItem(currentAdapter.cacheKey);
    if (!raw) return null;
    const { ts, data } = JSON.parse(raw);
    if (Date.now() - ts > CACHE_TTL_MS) {
      localStorage.removeItem(currentAdapter.cacheKey);
      return null;
    }
    return data; // array of minimal container objects
  } catch {
    return null;
  }
}

function writeCache(containers) {
  try {
    const fields = currentAdapter.cacheFields;
    const data   = containers.map(c => {
      const obj = {};
      fields.forEach(k => { if (c[k] != null) obj[k] = c[k]; });
      return obj;
    });
    localStorage.setItem(currentAdapter.cacheKey, JSON.stringify({ ts: Date.now(), data }));
  } catch (e) {
    console.warn('Cache write failed (storage full?):', e.message);
  }
}

// ============================================================
// Data loading
// ============================================================

/** Add an array of container plain-objects to state + cluster groups. */
function populateMarkers(containers) {
  const handlers = {
    onSelect: container => {
      const code = container.fractie_code;
      if (selectedType !== code) {
        selectedType = code;
        document.getElementById('type-select').value = code;
        applyTypeFilter();
      }
      setStartPoint(container.lat, container.lng, container.id);
    },
    onClear:  () => clearAll(),
    onHover:  marker => spiderfyColocated(marker),
    onLeave:  () => { _unspiderfyTimer = setTimeout(unspiderfy, 250); },
  };

  const batches = {};
  containers.forEach(container => {
    allContainers.push(container);
    const code = container.fractie_code;
    if (!FRACTIONS[code]) return;
    const marker = buildContainerMarker(container, FRACTIONS, handlers);
    containerMarkers[container.id] = marker;
    containerCodes[container.id]   = container.fractie_code;
    if (!batches[code]) batches[code] = [];
    batches[code].push(marker);
  });

  Object.entries(batches).forEach(([code, markers]) => {
    clusterGroups[code].addLayers(markers);
  });
}

function finishLoading() {
  const overlay = document.getElementById('loading-overlay');
  overlay.style.opacity = '0';
  setTimeout(() => { overlay.hidden = true; overlay.style.opacity = ''; }, 600);
  document.getElementById('pdf-btn').style.display = 'flex';
}

async function loadAllContainers() {
  const overlay = document.getElementById('loading-overlay');
  overlay.hidden        = false;
  overlay.style.opacity = '';

  // ── 1. Try cache ──────────────────────────────────────────
  const cached = readCache();
  if (cached) {
    document.getElementById('loading-count').textContent =
      t('loadedCache', { n: cached.length.toLocaleString() });
    populateMarkers(cached);
    finishLoading();
    return;
  }

  // ── 2. Fetch via adapter ───────────────────────────────────
  try {
    const containers = await currentAdapter.load(loaded => {
      document.getElementById('loading-count').textContent =
        t('loaded', { n: loaded.toLocaleString() });
    });
    populateMarkers(containers);
    writeCache(allContainers);
  } catch (err) {
    console.error('Error loading containers:', err);
  }

  finishLoading();
}

// ============================================================
// Hover-spiderfy: spread co-located markers so they're individually clickable
// ============================================================

const SPIDERFY_R       = 38; // px — radius of the spread circle
const SPIDERFY_OVERLAP = 30; // px — icon centres closer than this trigger a spread

function spiderfyColocated(hoveredMarker) {
  clearTimeout(_unspiderfyTimer);
  // Already in the spread group — just prevent the collapse timer
  if (_spiderfied.some(s => s.marker === hoveredMarker)) return;
  unspiderfy();
  // Only spread when markers are shown individually (clustering disabled)
  if (map.getZoom() < 17) return;

  const hPx = map.latLngToContainerPoint(hoveredMarker.getLatLng());

  const nearby = Object.entries(containerMarkers)
    .filter(([id]) => map.hasLayer(clusterGroups[containerCodes[id]]))
    .map(([, m]) => m)
    .filter(m => hPx.distanceTo(map.latLngToContainerPoint(m.getLatLng())) < SPIDERFY_OVERLAP);

  if (nearby.length <= 1) return;

  nearby.forEach((m, i) => {
    const angle  = (2 * Math.PI * i) / nearby.length - Math.PI / 2;
    const spread = map.containerPointToLatLng(L.point(
      hPx.x + SPIDERFY_R * Math.cos(angle),
      hPx.y + SPIDERFY_R * Math.sin(angle),
    ));
    _spiderfied.push({ marker: m, origLatLng: m.getLatLng() });
    m.setLatLng(spread);
  });
}

function unspiderfy() {
  clearTimeout(_unspiderfyTimer);
  _spiderfied.forEach(({ marker, origLatLng }) => marker.setLatLng(origLatLng));
  _spiderfied = [];
}

map.on('zoomstart', unspiderfy);

// ============================================================
// Mode & type controls
// ============================================================

window.setMode = function (newMode) {
  mode = newMode;
  document.getElementById('mode-point').classList.toggle('active',     mode === 'point');
  document.getElementById('mode-container').classList.toggle('active', mode === 'container');
  updateInstruction();
};

function updateInstruction(text) {
  document.getElementById('instruction').innerHTML = text ?? (
    mode === 'point' ? t('instrPoint') : t('instrContainer')
  );
}

// Type filter
document.getElementById('type-select').addEventListener('change', e => {
  selectedType = e.target.value;
  applyTypeFilter();
  if (selectedPoint && selectedType) {
    findAndShowNearest();
  } else if (selectedPoint && !selectedType) {
    clearRouteVisuals();
    document.getElementById('results-panel').hidden = true;
    updateInstruction(t('instrTypeNeeded'));
  }
});

function applyTypeFilter() {
  Object.keys(FRACTIONS).forEach(code => {
    const show  = !selectedType || code === selectedType;
    const group = clusterGroups[code];
    if (show !== map.hasLayer(group)) {
      show ? map.addLayer(group) : map.removeLayer(group);
    }
  });
}

// ============================================================
// Map click → set start point (point mode)
// ============================================================

map.on('click', e => {
  if (mode === 'point') {
    setStartPoint(e.latlng.lat, e.latlng.lng);
  }
});

// ============================================================
// Start point
// ============================================================

function setStartPoint(lat, lng, containerId = null) {
  // Restore previous source container dot before switching
  if (selectedContainerId && containerMarkers[selectedContainerId]) {
    containerMarkers[selectedContainerId].setOpacity(1);
  }

  selectedPoint       = { lat, lng };
  selectedContainerId = containerId;

  // Hide the source container's dot so it doesn't show through the start pin
  if (containerId && containerMarkers[containerId]) {
    containerMarkers[containerId].setOpacity(0);
  }

  if (startMarker) map.removeLayer(startMarker);

  startMarker = L.marker([lat, lng], {
    icon: L.divIcon({
      html: `<div style="
        width:22px;height:22px;
        background:#fff;border:3px solid #2c3e50;border-radius:50% 50% 50% 0;
        transform:rotate(-45deg);box-shadow:0 3px 8px rgba(0,0,0,0.4);
      "></div>`,
      className: '',
      iconSize:   [22, 22],
      iconAnchor: [11, 22],
    }),
    // Always on top of everything else
    zIndexOffset: 3000,
  }).addTo(map);

  if (selectedType) {
    findAndShowNearest();
  } else {
    updateInstruction(t('instrTypeNeeded'));
  }
}

// ============================================================
// Find nearest
// ============================================================

async function findAndShowNearest() {
  if (!selectedPoint || !selectedType) return;

  const candidates = allContainers.filter(
    c => c.fractie_code === selectedType && !c.verwijderd_dp
  );

  if (candidates.length === 0) {
    updateInstruction(t('instrNoneFound'));
    return;
  }

  // ── 1. Haversine pre-filter — wide pool to buffer for water / road detours ──
  const seenIds = new Set();
  const preFiltered = candidates
    .map(c => ({ ...c, distM: haversine(selectedPoint.lat, selectedPoint.lng, c.lat, c.lng) }))
    .filter(c => c.id !== selectedContainerId)
    .sort((a, b) => a.distM - b.distM)
    .filter(c => {
      if (seenIds.has(c.id)) return false;
      seenIds.add(c.id);
      return true;
    })
    .slice(0, PRE_FILTER_N);

  updateInstruction(t('instrCalculating'));

  // ── 2. ORS Matrix → reorder by actual walking duration ────────────────────
  let nearest;
  if (ORS_KEY && preFiltered.length > topN) {
    try {
      const locations = [
        [selectedPoint.lng, selectedPoint.lat],
        ...preFiltered.map(c => [c.lng, c.lat]),
      ];
      const resp = await fetch(ORS_MATRIX, {
        method:  'POST',
        headers: { 'Authorization': ORS_KEY, 'Content-Type': 'application/json' },
        body:    JSON.stringify({ locations, sources: [0], metrics: ['duration'] }),
      });
      if (!resp.ok) throw new Error(`ORS matrix HTTP ${resp.status}`);
      const { durations } = await resp.json();
      // durations[0][0] = self (skip); durations[0][i+1] = to preFiltered[i]
      nearest = preFiltered
        .map((c, i) => ({ ...c, walkDuration: durations[0][i + 1] ?? Infinity }))
        .sort((a, b) => a.walkDuration - b.walkDuration)
        .slice(0, topN);
    } catch (err) {
      console.warn('ORS matrix failed, falling back to haversine order:', err.message);
      nearest = preFiltered.slice(0, topN);
    }
  } else {
    nearest = preFiltered.slice(0, topN);
  }

  clearRouteVisuals();
  fetchRoutesAndRender(nearest);
}

// ============================================================
// Fetch routes and render results
// ============================================================

async function fetchRoutesAndRender(containers) {
  const frac = FRACTIONS[selectedType];
  updateInstruction(t('instrCalculating'));

  clearRouteVisuals();
  const resultsList  = document.getElementById('results-list');
  const printResults = document.getElementById('print-results');
  resultsList.innerHTML  = '';
  printResults.innerHTML = '';
  document.getElementById('results-panel').hidden = true;

  // Start address fetches — use bundled address if available, else reverse-geocode.
  // Warn once if any container falls back to geocoding (e.g. location join failed).
  const needsGeocode = containers.some(c => !c.loc);
  if (needsGeocode) showToast(t('toastGeocodeFallback'));
  const addressPromises = containers.map(c =>
    c.loc ? Promise.resolve(c.loc) : reverseGeocode(c.lat, c.lng)
  );

  const routes = await Promise.all(
    containers.map(c => fetchRoute(selectedPoint.lat, selectedPoint.lng, c.lat, c.lng))
  );

  // Warn once if ORS was configured but any route fell back to OSRM
  if (ORS_KEY && routes.some(r => r.provider !== 'ors')) {
    showToast(t('toastOsrmFallback'));
  }

  const iconAnchors = computeIconAnchors(containers, selectedPoint.lat, selectedPoint.lng, map);

  containers.forEach((container, i) => {
    const route = routes[i];
    const color = ROUTE_COLORS[i];

    // ── Polyline ──
    if (route?.geometry) {
      const latlngs = route.geometry.coordinates.map(([lng, lat]) => [lat, lng]);
      const offset  = ROUTE_OFFSETS[i];
      const poly    = L.polyline(offsetPolyline(latlngs, offset, map), {
        color, weight: 5, opacity: 0.85,
      }).addTo(map);
      routePolylines.push({ poly, latlngs, offset });
    }

    // ── Numbered marker at destination ──
    const numMarker = L.marker([container.lat, container.lng], {
      icon: L.divIcon({
        html: `<div style="
          width:30px;height:30px;border-radius:50%;
          background:${color};color:#fff;
          border:4px solid #fff;box-shadow:0 2px 8px rgba(0,0,0,0.45);
          display:flex;align-items:center;justify-content:center;
          font-weight:700;font-size:14px;
        ">${i + 1}</div>`,
        className: '',
        iconSize:   [38, 38],
        iconAnchor: iconAnchors[i],
      }),
      zIndexOffset: 2800 - i * 200,
    }).addTo(map);
    nearestMarkers.push(numMarker);

    // ── Format distance & time ──
    const distM   = route?.distance ?? container.distM;
    const distStr = distM < 1000
      ? `${Math.round(distM)} m`
      : `${(distM / 1000).toFixed(1)} km`;
    const mins    = route?.duration
      ? Math.max(1, Math.round(route.duration / 60))
      : Math.max(1, Math.round(distM / 83));

    // ── Sidebar result item (address shimmer shown until resolved) ──
    resultsList.insertAdjacentHTML('beforeend', `
      <div class="result-item" style="border-left-color:${color}">
        <div class="result-rank" style="background:${color}">${i + 1}</div>
        <div class="result-body">
          <div class="result-title">${t('containerLabel', { emoji: frac.emoji, name: fn(frac) })}</div>
          <div class="result-meta">
            <span>🚶 ${distStr}</span>
            <span>${t('walkTime', { min: mins })}</span>
          </div>
          <div class="result-address" id="result-addr-${i}">${container.loc ? container.loc : `<span class="text-shimmer">${t('addressLoading')}</span>`}</div>
        </div>
      </div>
    `);

    // ── Print result (address filled in when resolved) ──
    const _cName = t('containerLabel', { emoji: '', name: fn(frac) }).trim();
    printResults.insertAdjacentHTML('beforeend', `
      <div class="print-result" style="border-left-color:${color}">
        <strong style="color:${color}">${i + 1}.</strong>
        ${_cName} — <span id="print-addr-${i}">…</span> — ${distStr} (${t('printWalkTime', { min: mins })})
      </div>
    `);
  });

  document.getElementById('results-panel').hidden = false;
  document.getElementById('results-count-header').textContent = t('resultsHeader', { n: topN });
  updateInstruction(t('instrFound', { n: topN, name: fn(frac).toLowerCase() }));

  // Update print metadata
  document.getElementById('print-type').textContent = fn(frac);

  // Fit map to show everything
  const layers = [...routePolylines.map(({ poly }) => poly), ...nearestMarkers];
  if (startMarker) layers.push(startMarker);
  if (layers.length) {
    map.fitBounds(L.featureGroup(layers).getBounds().pad(0.05));
  }

  // Fill addresses into sidebar and print as each one resolves
  addressPromises.forEach((promise, i) => {
    promise.then(addr => {
      const sidebarEl = document.getElementById(`result-addr-${i}`);
      if (sidebarEl) sidebarEl.textContent = addr || '—';
      const printEl = document.getElementById(`print-addr-${i}`);
      if (printEl) printEl.textContent = addr || '—';
    });
  });
}

// Recompute pixel-space offsets when zoom level changes
map.on('zoomend', () => {
  routePolylines.forEach(({ poly, latlngs, offset }) => {
    poly.setLatLngs(offsetPolyline(latlngs, offset, map));
  });
});

// ============================================================
// Clear helpers
// ============================================================

function clearRouteVisuals() {
  routePolylines.forEach(({ poly }) => map.removeLayer(poly));
  routePolylines = [];
  nearestMarkers.forEach(m => map.removeLayer(m));
  nearestMarkers = [];
}

window.clearAll = function () {
  unspiderfy();
  clearRouteVisuals();
  if (startMarker) { map.removeLayer(startMarker); startMarker = null; }
  // Restore the source container dot if one was hidden
  if (selectedContainerId && containerMarkers[selectedContainerId]) {
    containerMarkers[selectedContainerId].setOpacity(1);
  }
  selectedPoint       = null;
  selectedContainerId = null;
  // Reset type filter
  selectedType = '';
  document.getElementById('type-select').value = '';
  applyTypeFilter();
  document.getElementById('results-panel').hidden = true;
  document.getElementById('results-list').innerHTML = '';
  document.getElementById('print-results').innerHTML = '';
  updateInstruction();
};

window.setTopN = function (n) {
  topN = Math.min(5, Math.max(1, +n));
  if (selectedPoint && selectedType) findAndShowNearest();
};

// ============================================================
// City switching
// ============================================================

window.setCity = function (adapterId) {
  const adapter = window.CityAdapters[adapterId];
  if (!adapter || adapter === currentAdapter) return;

  clearAll();

  // Remove all container markers / cluster layers
  Object.values(clusterGroups).forEach(g => map.removeLayer(g));
  allContainers    = [];
  containerMarkers = {};
  containerCodes   = {};

  localStorage.setItem('afvalcontainers_city', adapterId);
  currentAdapter = adapter;
  FRACTIONS      = adapter.fractions;

  clusterGroups = initClusterGroups(map, FRACTIONS);
  populateTypeSelect();
  updateDataCredit();
  map.setView(adapter.center, adapter.zoom);
  loadAllContainers();
};

// ============================================================
// PDF download
// ============================================================

let _printBounds  = null;
let _printRestore = null;
let _printMapPx   = null;

// A4 map canvas sizes in CSS px (96 dpi: 1 mm = 3.78 px).
// A4 portrait  usable area: 210 mm − 2×8 mm margins = 194 mm ≈ 733 px wide
//                           297 mm − 2×8 mm margins = 281 mm ≈ 1062 px tall
// A4 landscape usable area: 297 mm − 2×8 mm = 1062 px wide, 210 mm − 2×8 mm = 733 px tall
// "results" height subtracts ~190 px for the print-section strip.
const PRINT_DIMS = {
  portrait:  { results: L.point(733, 870), noResults: L.point(733, 1062) },
  landscape: { results: L.point(1062, 540), noResults: L.point(1062, 733) },
};

// Injected <style> for dynamic @page orientation + optional results suppression
const _pageStyleEl = document.createElement('style');
document.head.appendChild(_pageStyleEl);

function _applyPrintPageCSS(orientation, showResults) {
  let css = `@page { margin: 8mm; size: A4 ${orientation}; }`;
  if (!showResults) {
    css += '\n@media print { #print-section { display: none !important; } }';
  }
  _pageStyleEl.textContent = css;
}

window.addEventListener('beforeprint', () => {
  if (!_printBounds || !_printMapPx) return;
  const mapCtr = document.getElementById('map-container');
  mapCtr.style.flex   = 'none';
  mapCtr.style.width  = _printMapPx.x + 'px';
  mapCtr.style.height = _printMapPx.y + 'px';
  map.invalidateSize({ animate: false });
  map.fitBounds(_printBounds, { animate: false });
});

window.addEventListener('afterprint', () => {
  if (_printRestore) { _printRestore(); _printRestore = null; }
  _printBounds = null;
  _printMapPx  = null;
});

// ── Step 1: open settings modal ──────────────────────────────
window.downloadPDF = function () {
  document.getElementById('print-modal').hidden = false;
};

window.closePrintModal = function () {
  document.getElementById('print-modal').hidden = true;
};

// ── Step 2: user confirmed settings → enter preview mode ─────
window.confirmPrint = function () {
  const orientation = document.querySelector('input[name="print-orient"]:checked').value;
  const showResults = document.getElementById('print-show-details').checked;

  document.getElementById('print-modal').hidden = true;

  _applyPrintPageCSS(orientation, showResults);
  _printMapPx = PRINT_DIMS[orientation][showResults ? 'results' : 'noResults'];

  const body         = document.body;
  const sidebar      = document.getElementById('sidebar');
  const printSection = document.getElementById('print-section');
  const mapCtr       = document.getElementById('map-container');
  const toolbar      = document.getElementById('print-preview-toolbar');
  const prevCenter   = map.getCenter();
  const prevZoom     = map.getZoom();

  body.style.flexDirection   = 'column';
  body.style.alignItems      = 'center';
  body.style.justifyContent  = 'flex-start';
  body.style.height          = '100%';
  body.style.overflow        = 'auto';
  body.style.background      = '#d0d0d0';
  body.style.padding         = '16px 0 24px';

  sidebar.style.display      = 'none';

  mapCtr.style.flex          = 'none';
  mapCtr.style.width         = _printMapPx.x + 'px';
  mapCtr.style.height        = _printMapPx.y + 'px';
  mapCtr.style.boxShadow     = '0 4px 24px rgba(0,0,0,0.35)';

  printSection.style.display = showResults ? 'block' : 'none';
  printSection.style.width   = _printMapPx.x + 'px';

  const layers = [...routePolylines.map(({ poly }) => poly), ...nearestMarkers];
  if (startMarker) layers.push(startMarker);
  _printBounds = layers.length
    ? L.featureGroup(layers).getBounds().pad(0.05)
    : null;

  map.invalidateSize({ animate: false });
  if (_printBounds) map.fitBounds(_printBounds, { animate: false });

  toolbar.hidden = false;

  _printRestore = () => {
    toolbar.hidden             = true;
    body.style.flexDirection   = '';
    body.style.alignItems      = '';
    body.style.justifyContent  = '';
    body.style.height          = '';
    body.style.overflow        = '';
    body.style.background      = '';
    body.style.padding         = '';
    sidebar.style.display      = '';
    printSection.style.display = '';
    printSection.style.width   = '';
    mapCtr.style.flex          = '';
    mapCtr.style.width         = '';
    mapCtr.style.height        = '';
    mapCtr.style.boxShadow     = '';
    map.invalidateSize({ animate: false });
    map.setView(prevCenter, prevZoom, { animate: false });
  };
};

// ── Step 3a: user is happy with the view → print it ──────────
window.startPrintFromPreview = function () {
  _printBounds = map.getBounds();
  window.print();
};

// ── Step 3b: user wants to cancel the preview ─────────────────
window.cancelPrintPreview = function () {
  if (_printRestore) { _printRestore(); _printRestore = null; }
  _printBounds = null;
  _printMapPx  = null;
};

// ============================================================
// Boot
// ============================================================

populateCitySelect();
setLang(currentLang); // marks button, translates, fires langchange → populateTypeSelect + updateInstruction
loadAllContainers();
