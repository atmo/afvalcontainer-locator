// markers.js — Leaflet cluster groups and container marker factory.
// Stateless: all mutable references are owned by app.js.

import { t } from './i18n.js';
import { reverseGeocode } from './routing.js';

// ── Cluster groups ─────────────────────────────────────────────────────────
// Creates one L.markerClusterGroup per fraction, adds each to the map,
// and returns { [code]: group }.
export function initClusterGroups(map, fractions) {
  const groups = {};

  Object.entries(fractions).forEach(([code, frac]) => {
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
    groups[code] = group;
  });

  return groups;
}

// ── Container marker factory ───────────────────────────────────────────────
// handlers: { onSelect(container), onClear(), onHover(marker), onLeave() }
// Returns the L.marker — caller is responsible for storing it in
// containerMarkers[container.id] and containerCodes[container.id].
export function buildContainerMarker(container, fractions, handlers) {
  const frac = fractions[container.fractie_code];

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
      <div class="popup-header">
        <strong>${frac.emoji} ${t(frac.nameKey)}</strong>
        <button class="popup-clear-btn" title="${t('clearBtn')}">×</button>
      </div>
      <div class="popup-address" style="color:#555;margin-top:2px">${container.loc || t('addressLoading')}</div>
    `;
    div.querySelector('.popup-clear-btn').addEventListener('click', e => {
      L.DomEvent.stopPropagation(e);
      marker.closePopup();
      handlers.onClear();
    });
    if (!container.loc) {
      reverseGeocode(container.lat, container.lng).then(addr => {
        const el = div.querySelector('.popup-address');
        if (el) el.textContent = addr || '—';
      });
    }
    return div;
  }, { closeButton: false });

  marker.on('mouseover', () => handlers.onHover(marker));
  marker.on('mouseout',  handlers.onLeave);
  marker.on('click', e => {
    L.DomEvent.stopPropagation(e);
    handlers.onSelect(container);
  });

  return marker;
}
