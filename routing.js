// routing.js — stateless routing utilities and shared constants.
// Imported by app.js; no mutable state of its own.

import { t } from './i18n.js';

// ── API credentials and endpoints ─────────────────────────────────────────
export const ORS_KEY    = 'eyJvcmciOiI1YjNjZTM1OTc4NTExMTAwMDFjZjYyNDgiLCJpZCI6IjcyN2U3ZmQ0NDNhMzQwNTQ5N2FjNGY1MjZmODA1M2IxIiwiaCI6Im11cm11cjY0In0=';
export const ORS_BASE   = 'https://api.openrouteservice.org/v2/directions/foot-walking';
export const ORS_MATRIX = 'https://api.openrouteservice.org/v2/matrix/foot-walking';
export const OSRM_BASE  = 'https://routing.openstreetmap.de/routed-foot/route/v1/foot/';

// Haversine pre-filter pool size for ORS matrix reordering.
// Wide enough so containers just across a canal are always included.
export const PRE_FILTER_N = 50;

export const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// Colors and lateral offsets for up to 5 route polylines
export const ROUTE_COLORS  = ['#c0392b', '#7d3c98', '#148f77', '#d4ac0d', '#2471a3'];
export const ROUTE_OFFSETS = [-8, -4, 0, 4, 8];

// ── Haversine distance (metres) ────────────────────────────────────────────
export function haversine(lat1, lng1, lat2, lng2) {
  const R  = 6371000;
  const φ1 = lat1 * Math.PI / 180;
  const φ2 = lat2 * Math.PI / 180;
  const Δφ = (lat2 - lat1) * Math.PI / 180;
  const Δλ = (lng2 - lng1) * Math.PI / 180;
  const a  = Math.sin(Δφ / 2) ** 2 +
             Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ── Reverse geocoding (Nominatim) ──────────────────────────────────────────
export async function reverseGeocode(lat, lng) {
  try {
    const url  = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=18`;
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

// ── Toast notification ─────────────────────────────────────────────────────
export function showToast(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => {
    el.classList.add('fade-out');
    setTimeout(() => el.remove(), 400);
  }, 5000);
}

// ── Polyline lateral offset with miter limit ───────────────────────────────
// Shifts a polyline laterally by offsetPx screen pixels.
// Uses a miter join at corners, capped at MITER_LIMIT × offsetPx to prevent
// spikes on sharp corners. Requires `map` for pixel/latlng conversion.
export function offsetPolyline(latlngs, offsetPx, map) {
  if (offsetPx === 0 || latlngs.length < 2) return latlngs;
  const MITER_LIMIT = 3;

  const pts = latlngs.map(ll => map.latLngToContainerPoint(L.latLng(ll[0], ll[1])));

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
      const n = n1 ?? n2;
      ox = n.x * offsetPx; oy = n.y * offsetPx;
    } else {
      const bx = n1.x + n2.x, by = n1.y + n2.y;
      const denom = bx * n1.x + by * n1.y;
      const bLen  = Math.hypot(bx, by);
      if (bLen < 1e-9 || denom <= 0) {
        ox = n1.x * offsetPx; oy = n1.y * offsetPx;
      } else {
        const miterLen = Math.abs(offsetPx) * bLen / denom;
        const finalLen = Math.min(miterLen, MITER_LIMIT * Math.abs(offsetPx));
        const scale    = Math.sign(offsetPx) * finalLen / bLen;
        ox = bx * scale; oy = by * scale;
      }
    }

    const np = map.containerPointToLatLng(L.point(p.x + ox, p.y + oy));
    result.push([np.lat, np.lng]);
  }
  return result;
}

// ── Icon anchor offsets so coincident markers don't overlap ───────────────
// Returns [[anchorX, anchorY], …] per destination container.
// Increasing anchorY moves the icon UP on screen; increasing anchorX moves LEFT.
export function computeIconAnchors(containers, startLat, startLng, map) {
  const HALF       = 19;  // half of the 38px destination icon
  const SPREAD     = 80;  // px offset when icons would overlap
  const PIN_RADIUS = 11;  // half of the 22px start pin

  const ax = containers.map(() => HALF);
  const ay = containers.map(() => HALF);

  const toPx    = (lat, lng) => map.latLngToContainerPoint(L.latLng(lat, lng));
  const startPx = toPx(startLat, startLng);

  containers.forEach((c, i) => {
    if (startPx.distanceTo(toPx(c.lat, c.lng)) < PIN_RADIUS + HALF) ay[i] += SPREAD;
  });

  for (let i = 0; i < containers.length; i++) {
    for (let j = i + 1; j < containers.length; j++) {
      if (toPx(containers[i].lat, containers[i].lng)
            .distanceTo(toPx(containers[j].lat, containers[j].lng)) < SPREAD) {
        ax[i] += Math.round(SPREAD / 2);
        ax[j] -= Math.round(SPREAD / 2);
      }
    }
  }

  return containers.map((_, i) => [ax[i], ay[i]]);
}

// ── Route fetching  (ORS → OSRM fallback → straight line) ─────────────────
export async function fetchRoute(fromLat, fromLng, toLat, toLng) {
  // 1. ORS (better pedestrian routing)
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

  // 2. OSRM fallback
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

  // 3. Straight-line last resort
  return {
    provider: 'straight',
    geometry: { type: 'LineString', coordinates: [[fromLng, fromLat], [toLng, toLat]] },
    distance: haversine(fromLat, fromLng, toLat, toLng),
    duration: null,
  };
}
