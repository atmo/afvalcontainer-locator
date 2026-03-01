'use strict';

/**
 * Den Haag adapter — loads waste containers from a bundled static snapshot.
 * Source: https://ckan.dataplatform.nl/dataset/bakken (CC-0)
 * The CKAN API lacks CORS headers so data is bundled as data/denhaag.json.
 *
 * Fraction codes in this dataset:
 *   RES  — Restafval (general waste)
 *   PPR  — Papier
 *   GLB  — Glas bont (mixed glass)  |  GLC (combined glass) → normalised to GLB
 *   TEX  — Textiel
 *   PLA  — Plastic, blik en drankpak
 */

(function () {
  const DATA_URL = 'data/denhaag.json'; // bundled snapshot, same-origin → no CORS

  const fractions = {
    'RES': { color: '#5d5d5d', nameKey: 'fractionRest',    emoji: '♻️' },
    'PPR': { color: '#2471a3', nameKey: 'fractionPapier',  emoji: '📦' },
    'GLB': { color: '#27ae60', nameKey: 'fractionGlas',    emoji: '🫙' },
    'TEX': { color: '#ca6f1e', nameKey: 'fractionTextiel', emoji: '👕' },
    'PLA': { color: '#8e44ad', nameKey: 'fractionPlastic', emoji: '🧴' },
  };

  window.CityAdapters = window.CityAdapters || {};
  window.CityAdapters.denhaag = {
    id:          'denhaag',
    nameKey:     'cityDenHaag',
    center:      [52.0705, 4.3007],
    zoom:        13,
    cacheKey:    'afvalcontainers_denhaag_v1',
    cacheFields: ['id', 'lat', 'lng', 'fractie_code', 'loc'],
    dataDate:    '2026-02-28',
    fractions,
    dataCredit: {
      nl: 'Data: <a href="https://ckan.dataplatform.nl/dataset/bakken" target="_blank" rel="noopener">Gemeente Den Haag</a> (CC-0)<br>Kaart: <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors<br>Routes: <a href="https://project-osrm.org" target="_blank" rel="noopener">OSRM</a>',
      en: 'Data: <a href="https://ckan.dataplatform.nl/dataset/bakken" target="_blank" rel="noopener">City of The Hague</a> (CC-0)<br>Map: <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors<br>Routes: <a href="https://project-osrm.org" target="_blank" rel="noopener">OSRM</a>',
    },

    async load(onProgress) {
      const resp = await fetch(DATA_URL);
      if (!resp.ok) throw new Error(`Den Haag data fetch error: HTTP ${resp.status}`);
      const records = await resp.json();
      // records: [{id, lat, lng, fc, loc}, …] — already filtered & normalised
      const containers = records.map(r => ({
        id:           r.id,
        lat:          r.lat,
        lng:          r.lng,
        fractie_code: r.fc,
        loc:          r.loc,
      }));
      onProgress(containers.length);
      return containers;
    },
  };
})();
