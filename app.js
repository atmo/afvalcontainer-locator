'use strict';

// ============================================================
// Config
// ============================================================

const WFS_BASE  = 'https://api.data.amsterdam.nl/v1/wfs/huishoudelijkafval/';
const ORS_KEY  = 'eyJvcmciOiI1YjNjZTM1OTc4NTExMTAwMDFjZjYyNDgiLCJpZCI6IjcyN2U3ZmQ0NDNhMzQwNTQ5N2FjNGY1MjZmODA1M2IxIiwiaCI6Im11cm11cjY0In0='; // paste your key from https://openrouteservice.org/sign-up/
const ORS_BASE  = 'https://api.openrouteservice.org/v2/directions/foot-walking';
const OSRM_BASE = 'https://routing.openstreetmap.de/routed-foot/route/v1/foot/';
const PAGE_SIZE = 1000;

const CACHE_KEY    = 'afvalcontainers_v2';
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
// Only persist the fields actually used by the app
const CACHE_FIELDS = ['lat', 'lng', 'fractie_code', 'id', 'id_nummer',
                      'verwijderd_dp', 'status'];

const FRACTIONS = {
  '1': { color: '#5d5d5d', nameKey: 'fractionRest',     emoji: '♻️'  },
  '2': { color: '#27ae60', nameKey: 'fractionGlas',     emoji: '🫙'  },
  '3': { color: '#2471a3', nameKey: 'fractionPapier',   emoji: '📦'  },
  '5': { color: '#ca6f1e', nameKey: 'fractionTextiel',  emoji: '👕'  },
};

// Colors for the 3 routes (solid, dashed, dotted)
const ROUTE_COLORS   = ['#c0392b', '#7d3c98', '#148f77'];
const ROUTE_OFFSETS  = [-6, 0, 6];  // lateral pixel offsets for overlapping routes

// ============================================================
// App-specific i18n helpers  (t / currentLang / applyTranslations / setLang
// live in i18n.js, loaded before this file)
// ============================================================

/** Returns the localised fraction name (depends on FRACTIONS defined above). */
const fn = frac => t(frac.nameKey);

/** Re-populates the fraction-type <select> with translated option labels. */
function _updateSelectOptions() {
  const sel = document.getElementById('type-select');
  sel.options[0].textContent = t('typeAll');
  sel.options[1].textContent = `♻️  ${t('fractionRest')}`;
  sel.options[2].textContent = `🫙  ${t('fractionGlas')}`;
  sel.options[3].textContent = `📦  ${t('fractionPapier')}`;
  sel.options[4].textContent = `👕  ${t('fractionTextiel')}`;
}

// React to language switches triggered by setLang() in i18n.js
document.addEventListener('langchange', () => {
  _updateSelectOptions();
  updateInstruction();
});

// ============================================================
// State
// ============================================================

let allContainers      = [];   // flat array of all loaded container objects
let selectedType       = '';   // fractie_code filter, '' = all shown
let selectedPoint      = null; // { lat, lng }
let selectedContainerId = null; // id of the container used as start point, or null
let mode               = 'container'; // 'point' | 'container'

let startMarker      = null;
let nearestMarkers   = [];
let routePolylines   = [];
let clusterGroups    = {};  // fractie_code → L.markerClusterGroup
let containerMarkers = {};  // container id → L.marker (for hiding source dot)

// ============================================================
// Map
// ============================================================

const MAP_VIEW_KEY = 'afvalcontainers_view';

const savedView = (() => {
  try { return JSON.parse(localStorage.getItem(MAP_VIEW_KEY)); } catch { return null; }
})();
const map = L.map('map', {
  center: savedView ? savedView.center : [52.3676, 4.9041],
  zoom:   savedView ? savedView.zoom   : 13,
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
  attribution:
    '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors | ' +
    'Data: <a href="https://data.amsterdam.nl">Gemeente Amsterdam</a>',
}).addTo(map);

// ============================================================
// Cluster groups (one per fraction, so we can toggle visibility)
// ============================================================

Object.keys(FRACTIONS).forEach(code => {
  const frac = FRACTIONS[code];

  const group = L.markerClusterGroup({
    maxClusterRadius: 55,
    disableClusteringAtZoom: 17,
    chunkedLoading: true,
    iconCreateFunction: cluster => {
      const n    = cluster.getChildCount();
      const size = n < 10 ? 30 : n < 100 ? 36 : 42;
      return L.divIcon({
        html: `<div style="
          width:${size}px;height:${size}px;
          background:${frac.color};
          color:#fff;border-radius:50%;
          display:flex;align-items:center;justify-content:center;
          font-weight:700;font-size:${size < 36 ? 11 : 13}px;
          border:2px solid rgba(255,255,255,0.85);
          box-shadow:0 2px 6px rgba(0,0,0,0.3);
        ">${n}</div>`,
        className: '',
        iconSize:   [size, size],
        iconAnchor: [size / 2, size / 2],
      });
    },
  });

  group.addTo(map);
  clusterGroups[code] = group;
});

// ============================================================
// Cache helpers
// ============================================================

function purgeOldCaches() {
  // Remove any previous cache versions to free space before writing the current one
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const k = localStorage.key(i);
    if (k && k.startsWith('afvalcontainers_') && k !== CACHE_KEY && k !== MAP_VIEW_KEY) {
      localStorage.removeItem(k);
    }
  }
}

function readCache() {
  purgeOldCaches();
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const { ts, data } = JSON.parse(raw);
    if (Date.now() - ts > CACHE_TTL_MS) {
      localStorage.removeItem(CACHE_KEY);
      return null;
    }
    return data; // array of minimal container objects
  } catch {
    return null;
  }
}

function writeCache(containers) {
  try {
    const data = containers.map(c => {
      const obj = {};
      CACHE_FIELDS.forEach(k => { if (c[k] != null) obj[k] = c[k]; });
      return obj;
    });
    localStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), data }));
  } catch (e) {
    console.warn('Cache write failed (storage full?):', e.message);
  }
}

// ============================================================
// Data loading
// ============================================================

/** Add an array of container plain-objects to state + cluster groups. */
function populateMarkers(containers) {
  const batches = {};
  containers.forEach(container => {
    allContainers.push(container);
    const code = container.fractie_code;
    if (!FRACTIONS[code]) return;
    if (!batches[code]) batches[code] = [];
    batches[code].push(buildContainerMarker(container));
  });
  Object.entries(batches).forEach(([code, markers]) => {
    clusterGroups[code].addLayers(markers);
  });
}

function finishLoading() {
  const overlay = document.getElementById('loading-overlay');
  overlay.style.opacity = '0';
  setTimeout(() => overlay.remove(), 600);
  document.getElementById('pdf-btn').style.display = 'flex';
}

async function loadAllContainers() {
  // ── 1. Try cache ──────────────────────────────────────────
  const cached = readCache();
  if (cached) {
    document.getElementById('loading-count').textContent =
      t('loadedCache', { n: cached.length.toLocaleString(t('dateLocale')) });
    populateMarkers(cached);
    finishLoading();
    return;
  }

  // ── 2. Fetch from API ─────────────────────────────────────
  let totalLoaded = 0;
  let startIndex  = 0;
  let hasMore     = true;

  while (hasMore) {
    const url = new URL(WFS_BASE);
    url.searchParams.set('SERVICE',      'WFS');
    url.searchParams.set('VERSION',      '2.0.0');
    url.searchParams.set('REQUEST',      'GetFeature');
    url.searchParams.set('TYPENAMES',    'container');
    url.searchParams.set('OUTPUTFORMAT', 'geojson');
    url.searchParams.set('SRSNAME',      'EPSG:4326');
    url.searchParams.set('count',        PAGE_SIZE);
    url.searchParams.set('STARTINDEX',   startIndex);

    try {
      const resp = await fetch(url.toString());
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const geojson  = await resp.json();
      const features = geojson.features || [];

      const batch = [];
      features.forEach(feature => {
        if (!feature.geometry)   return;
        const props = feature.properties;
        if (props.verwijderd_dp) return;
        if (props.status !== 1)  return; // 0=inactive, 1=active, 2=planned
        const code = props.fractie_code;
        if (!FRACTIONS[code])    return;

        const [lng, lat] = feature.geometry.coordinates;
        batch.push({ lat, lng, ...props });
      });

      populateMarkers(batch);

      totalLoaded += features.length;
      document.getElementById('loading-count').textContent =
        t('loaded', { n: totalLoaded.toLocaleString(t('dateLocale')) });

      hasMore = features.length === PAGE_SIZE;
      startIndex += PAGE_SIZE;
    } catch (err) {
      console.error('Error loading page:', err);
      hasMore = false;
    }
  }

  // ── 3. Persist to cache for next visit ───────────────────
  writeCache(allContainers);
  finishLoading();
}

// ============================================================
// Container marker
// ============================================================

function buildContainerMarker(container) {
  const frac = FRACTIONS[container.fractie_code];

  const icon = L.divIcon({
    html: `<div style="
      width:30px;height:30px;border-radius:50%;
      background:${frac.color};
      border:2px solid rgba(255,255,255,0.9);
      box-shadow:0 1px 4px rgba(0,0,0,0.35);
    "></div>`,
    className: '',
    iconSize:   [34, 34],
    iconAnchor: [17, 17],
  });

  const marker = L.marker([container.lat, container.lng], { icon });

  marker.bindPopup(() => {
    const div = document.createElement('div');
    div.className = 'popup-content';
    div.innerHTML = `
      <strong>${frac.emoji} ${fn(frac)}</strong>
      <div class="popup-address" style="color:#555;margin-top:2px">${t('addressLoading')}</div>
    `;
    reverseGeocode(container.lat, container.lng).then(addr => {
      const el = div.querySelector('.popup-address');
      if (el) el.textContent = addr || '—';
    });
    return div;
  });

  marker.on('click', e => {
    L.DomEvent.stopPropagation(e);
    // Auto-select this container's type in the dropdown
    const code = container.fractie_code;
    if (selectedType !== code) {
      selectedType = code;
      document.getElementById('type-select').value = code;
      applyTypeFilter();
    }
    setStartPoint(container.lat, container.lng, container.id);
  });

  containerMarkers[container.id] = marker;
  return marker;
}

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

function findAndShowNearest() {
  if (!selectedPoint || !selectedType) return;

  const candidates = allContainers.filter(
    c => c.fractie_code === selectedType && !c.verwijderd_dp
  );

  if (candidates.length === 0) {
    updateInstruction(t('instrNoneFound'));
    return;
  }

  const seenIds = new Set();
  const nearest = candidates
    .map(c => ({ ...c, distM: haversine(selectedPoint.lat, selectedPoint.lng, c.lat, c.lng) }))
    .filter(c => c.id !== selectedContainerId)  // exclude the source container by ID
    .sort((a, b) => a.distM - b.distM)
    .filter(c => {
      // Deduplicate by container ID (guard against duplicate entries in API data)
      if (seenIds.has(c.id)) return false;
      seenIds.add(c.id);
      return true;
    })
    .slice(0, 3);

  clearRouteVisuals();
  fetchRoutesAndRender(nearest);
}

// ============================================================
// Compute iconAnchor offsets so coincident markers don't overlap
// ============================================================

/**
 * Returns an array of [anchorX, anchorY] per destination container.
 * - Destinations at the same spot as the start pin are shifted upward.
 * - Pairs of destinations at the same spot are spread horizontally.
 * Base anchor for a 38×38 icon is [19, 19] (centre).
 * Increasing anchorY moves the icon UP on screen; increasing anchorX moves it LEFT.
 */
function computeIconAnchors(containers, startLat, startLng) {
  const HALF       = 19;  // half of the 38px destination icon
  const SPREAD     = 80;  // px — offset to apply when icons would overlap
  const PIN_RADIUS = 11;  // half of the 22px start pin

  const ax = containers.map(() => HALF);
  const ay = containers.map(() => HALF);

  // Convert lat/lng → pixel position at the current zoom level
  const toPx  = (lat, lng) => map.latLngToContainerPoint(L.latLng(lat, lng));
  const startPx = toPx(startLat, startLng);

  // Shift destinations whose icon would overlap the start pin upward
  containers.forEach((c, i) => {
    if (startPx.distanceTo(toPx(c.lat, c.lng)) < PIN_RADIUS + HALF) {
      ay[i] += SPREAD;
    }
  });

  // Spread pairs of destinations whose icons would overlap each other
  for (let i = 0; i < containers.length; i++) {
    for (let j = i + 1; j < containers.length; j++) {
      const d = toPx(containers[i].lat, containers[i].lng)
                  .distanceTo(toPx(containers[j].lat, containers[j].lng));
      if (d < SPREAD) {
        ax[i] += Math.round(SPREAD / 2);
        ax[j] -= Math.round(SPREAD / 2);
      }
    }
  }

  return containers.map((_, i) => [ax[i], ay[i]]);
}

// ============================================================
// Reverse geocoding (Nominatim)
// ============================================================

async function reverseGeocode(lat, lng) {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=18`;
    const resp = await fetch(url, { headers: { 'Accept-Language': t('geocodeLang') } });
    if (!resp.ok) return null;
    const data = await resp.json();
    const a    = data.address || {};
    const road = a.road || a.pedestrian || a.footway || a.path || '';
    const num  = a.house_number || '';
    return road ? road + (num ? ' ' + num : '') : null;
  } catch {
    return null;
  }
}

// ============================================================
// Polyline offset with miter limit
// Shifts a polyline laterally by offsetPx screen pixels.
// Uses a miter join at corners, but caps it at MITER_LIMIT × offsetPx
// (bevel fallback) so sharp street corners never produce spikes or loops.
// Must be recomputed on zoom changes because it works in pixel space.
// ============================================================

function offsetPolyline(latlngs, offsetPx) {
  if (offsetPx === 0 || latlngs.length < 2) return latlngs;
  const MITER_LIMIT = 3;

  const pts = latlngs.map(ll => map.latLngToContainerPoint(L.latLng(ll[0], ll[1])));

  // Left-hand unit normal of segment a→b
  const segNormal = (a, b) => {
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    return len < 1e-9 ? null : { x: -dy / len, y: dx / len };
  };

  const result = [];
  for (let i = 0; i < pts.length; i++) {
    const p  = pts[i];
    const n1 = i > 0              ? segNormal(pts[i - 1], p)     : null;
    const n2 = i < pts.length - 1 ? segNormal(p, pts[i + 1])     : null;

    let ox, oy;
    if (!n1 && !n2) {
      result.push(latlngs[i]); continue;
    } else if (!n1 || !n2) {
      // Endpoint: shift perpendicular to the one adjacent segment
      const n = n1 ?? n2;
      ox = n.x * offsetPx; oy = n.y * offsetPx;
    } else {
      // Interior point: miter bisector with limit
      const bx = n1.x + n2.x, by = n1.y + n2.y;
      const denom = bx * n1.x + by * n1.y;  // = 1 + dot(n1,n2)
      const bLen  = Math.hypot(bx, by);

      if (bLen < 1e-9 || denom <= 0) {
        // U-turn or degenerate: bevel using n1
        ox = n1.x * offsetPx; oy = n1.y * offsetPx;
      } else {
        // Miter length = |offsetPx| * bLen / denom; cap at MITER_LIMIT * |offsetPx|
        const miterLen  = Math.abs(offsetPx) * bLen / denom;
        const finalLen  = Math.min(miterLen, MITER_LIMIT * Math.abs(offsetPx));
        const scale     = Math.sign(offsetPx) * finalLen / bLen;
        ox = bx * scale; oy = by * scale;
      }
    }

    const np = map.containerPointToLatLng(L.point(p.x + ox, p.y + oy));
    result.push([np.lat, np.lng]);
  }
  return result;
}

// Recompute pixel-space offsets when zoom level changes
map.on('zoomend', () => {
  routePolylines.forEach(({ poly, latlngs, offset }) => {
    poly.setLatLngs(offsetPolyline(latlngs, offset));
  });
});

// ============================================================
// Fetch OSRM routes and render
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

  // Start address fetches immediately in parallel with routes
  const addressPromises = containers.map(c => reverseGeocode(c.lat, c.lng));

  const routes = await Promise.all(
    containers.map(c => fetchRoute(selectedPoint.lat, selectedPoint.lng, c.lat, c.lng))
  );

  // Warn once if ORS was configured but any route fell back to OSRM
  if (ORS_KEY && routes.some(r => r.provider !== 'ors')) {
    showToast(t('toastOsrmFallback'));
  }

  const iconAnchors = computeIconAnchors(containers, selectedPoint.lat, selectedPoint.lng);

  containers.forEach((container, i) => {
    const route = routes[i];
    const color = ROUTE_COLORS[i];

    // ── Polyline ──
    if (route?.geometry) {
      const latlngs = route.geometry.coordinates.map(([lng, lat]) => [lat, lng]);
      const offset  = ROUTE_OFFSETS[i];
      const poly     = L.polyline(offsetPolyline(latlngs, offset), {
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
          <div class="result-address" id="result-addr-${i}"><span class="text-shimmer">${t('addressLoading')}</span></div>
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
  updateInstruction(t('instrFound', { name: fn(frac).toLowerCase() }));

  // Update print metadata
  document.getElementById('print-type').textContent = fn(frac);
  document.getElementById('print-date').textContent =
    new Date().toLocaleDateString(t('dateLocale'), { dateStyle: 'long' });

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

// ============================================================
// Toast notification
// ============================================================

function showToast(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => {
    el.classList.add('fade-out');
    setTimeout(() => el.remove(), 400);
  }, 5000);
}

// ============================================================
// Routing  (ORS → OSRM fallback → straight line)
// ============================================================

async function fetchRoute(fromLat, fromLng, toLat, toLng) {
  // ── 1. ORS (better pedestrian routing) ───────────────────
  if (ORS_KEY) {
    try {
      const url  = `${ORS_BASE}?api_key=${ORS_KEY}&start=${fromLng},${fromLat}&end=${toLng},${toLat}`;
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      const feat = data.features?.[0];
      if (feat?.geometry) {
        return {
          provider: 'ors',
          geometry: feat.geometry,
          distance: feat.properties.summary.distance,  // metres
          duration: feat.properties.summary.duration,  // seconds
        };
      }
    } catch (err) {
      console.warn('ORS failed, falling back to OSRM:', err.message);
    }
  }

  // ── 2. OSRM fallback ─────────────────────────────────────
  try {
    const url  = `${OSRM_BASE}${fromLng},${fromLat};${toLng},${toLat}?overview=full&geometries=geojson`;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    if (data.code === 'Ok' && data.routes?.[0]) {
      return {
        provider: 'osrm',
        geometry: data.routes[0].geometry,
        distance: data.routes[0].distance,
        duration: data.routes[0].duration,
      };
    }
  } catch (err) {
    console.warn('OSRM failed, using straight line:', err.message);
  }

  // ── 3. Straight-line last resort ─────────────────────────
  return {
    provider: 'straight',
    geometry: { type: 'LineString', coordinates: [[fromLng, fromLat], [toLng, toLat]] },
    distance: haversine(fromLat, fromLng, toLat, toLng),
    duration: null,
  };
}

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

// ============================================================
// Haversine distance (returns metres)
// ============================================================

function haversine(lat1, lng1, lat2, lng2) {
  const R  = 6371000;
  const φ1 = lat1 * Math.PI / 180;
  const φ2 = lat2 * Math.PI / 180;
  const Δφ = (lat2 - lat1) * Math.PI / 180;
  const Δλ = (lng2 - lng1) * Math.PI / 180;
  const a  = Math.sin(Δφ / 2) ** 2 +
             Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

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
// "results" height subtracts the ~120 px print-section strip.
// These exact dimensions are applied as inline styles on the map container so
// the preview and the printed page use the same pixel canvas.
const PRINT_DIMS = {
  portrait:  { results: L.point(733, 942), noResults: L.point(733, 1062) },
  landscape: { results: L.point(1062, 613), noResults: L.point(1062, 733) },
};

// Injected <style> for dynamic @page orientation + optional results suppression
const _pageStyleEl = document.createElement('style');
document.head.appendChild(_pageStyleEl);

function _applyPrintPageCSS(orientation, showResults) {
  // @page must be top-level (not inside @media)
  let css = `@page { margin: 8mm; size: A4 ${orientation}; }`;
  if (!showResults) {
    // Override the @media print { display: block !important } in style.css
    css += '\n@media print { #print-section { display: none !important; } }';
  }
  _pageStyleEl.textContent = css;
}

// beforeprint fires before OR after @media print depending on the browser.
// Either way, we re-assert the paper-sized inline styles (inline > stylesheet,
// even from @media print, as long as the stylesheet rule has no !important).
// The map was already fitted to _printBounds at the correct zoom in confirmPrint,
// so this is mostly a safety re-assert.
window.addEventListener('beforeprint', () => {
  if (!_printBounds || !_printMapPx) return;
  const mapCtr = document.getElementById('map-container');
  mapCtr.style.flex   = 'none';
  mapCtr.style.width  = _printMapPx.x + 'px';
  mapCtr.style.height = _printMapPx.y + 'px';
  map.invalidateSize({ animate: false });
  map.fitBounds(_printBounds, { animate: false });
});

// afterprint fires once the dialog closes — safe to restore screen layout.
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

  // ── Apply preview layout ──────────────────────────────────
  // Body becomes a centred column so the fixed-size "paper" sits in the middle.
  body.style.flexDirection   = 'column';
  body.style.alignItems      = 'center';
  body.style.justifyContent  = 'flex-start';
  body.style.height          = '100%';
  body.style.overflow        = 'auto';
  body.style.background      = '#d0d0d0';
  body.style.padding         = '16px 0 24px';

  sidebar.style.display      = 'none';

  // Fix map container to exact paper canvas dimensions so preview tiles match print.
  // Inline styles beat @media print rules (which have no !important on w/h).
  mapCtr.style.flex          = 'none';
  mapCtr.style.width         = _printMapPx.x + 'px';
  mapCtr.style.height        = _printMapPx.y + 'px';
  mapCtr.style.boxShadow     = '0 4px 24px rgba(0,0,0,0.35)';

  // Show print-section at the same width so the "paper" looks complete.
  printSection.style.display = showResults ? 'block' : 'none';
  printSection.style.width   = _printMapPx.x + 'px';

  // Auto-fit to routes as the default starting view
  const layers = [...routePolylines.map(({ poly }) => poly), ...nearestMarkers];
  if (startMarker) layers.push(startMarker);
  _printBounds = layers.length
    ? L.featureGroup(layers).getBounds().pad(0.05)
    : null;

  map.invalidateSize({ animate: false });
  if (_printBounds) map.fitBounds(_printBounds, { animate: false });

  // Show the toolbar so the user can pan/zoom before confirming
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
  // Capture whatever area the user has panned/zoomed to
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

setLang(currentLang);   // marks button, translates, fires langchange → _updateSelectOptions + updateInstruction
loadAllContainers();
