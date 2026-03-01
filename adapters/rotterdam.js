'use strict';

/**
 * Rotterdam adapter — loads waste containers from the city's ArcGIS WFS API.
 * Source: https://rotterdam.dataplatform.nl (CC0-1.0)
 * CORS is supported; all ~9 K containers fit in a single request (no pagination).
 *
 * Fraction codes in this dataset:
 *   REST    — Restafval (general waste)
 *   GFE     — Groente, Fruit en Etensresten (organic / food waste)
 *   PAPIER  — Papier
 *   GLAS    — Glas  (also appears as 'Glas' — normalised to uppercase)
 *   TEXTIEL — Textiel
 *
 * Container types (SOORT): Ondergronds, Halfverdiept, Bovengronds (all included).
 * Removed containers: STATUS === 'Tijdelijk verwijderd' → excluded.
 */

(function () {
  const WFS_URL = 'https://diensten.rotterdam.nl/arcgis/services/SB_Infra/Container/MapServer/WFSServer';

  const fractions = {
    'REST':    { color: '#5d5d5d', nameKey: 'fractionRest',    emoji: '♻️' },
    'GFE':     { color: '#795548', nameKey: 'fractionGfe',     emoji: '🌿' },
    'PAPIER':  { color: '#2471a3', nameKey: 'fractionPapier',  emoji: '📦' },
    'GLAS':    { color: '#27ae60', nameKey: 'fractionGlas',    emoji: '🫙' },
    'TEXTIEL': { color: '#ca6f1e', nameKey: 'fractionTextiel', emoji: '👕' },
  };

  window.CityAdapters = window.CityAdapters || {};
  window.CityAdapters.rotterdam = {
    id:          'rotterdam',
    nameKey:     'cityRotterdam',
    center:      [51.9225, 4.4792],
    zoom:        13,
    cacheKey:    'afvalcontainers_rotterdam_v1',
    cacheFields: ['id', 'lat', 'lng', 'fractie_code', 'loc'],
    dataDate:    null, // set to 'YYYY-MM-DD' of the dataset's publication date
    fractions,
    dataCredit: {
      nl: 'Data: <a href="https://rotterdam.dataplatform.nl" target="_blank" rel="noopener">Gemeente Rotterdam</a> (CC0-1.0)<br>Kaart: <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors<br>Routes: <a href="https://project-osrm.org" target="_blank" rel="noopener">OSRM</a>',
      en: 'Data: <a href="https://rotterdam.dataplatform.nl" target="_blank" rel="noopener">City of Rotterdam</a> (CC0-1.0)<br>Map: <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors<br>Routes: <a href="https://project-osrm.org" target="_blank" rel="noopener">OSRM</a>',
    },

    async load(onProgress) {
      const params = new URLSearchParams({
        service:      'WFS',
        version:      '2.0.0',
        request:      'GetFeature',
        typeName:     'Container:Container',
        outputFormat: 'geojson',
        count:        '10000',  // all ~9 K containers fit in one request
      });

      const resp = await fetch(`${WFS_URL}?${params}`);
      if (!resp.ok) throw new Error(`Rotterdam WFS error: HTTP ${resp.status}`);
      const { features = [] } = await resp.json();

      const containers = [];
      for (const feature of features) {
        if (!feature.geometry) continue;
        const p = feature.properties;
        if (p.STATUS === 'Tijdelijk verwijderd') continue;
        // Normalise mixed-case codes (e.g. 'Glas' → 'GLAS')
        const code = p.FRACTIE ? p.FRACTIE.toUpperCase() : null;
        if (!code || !fractions[code]) continue;
        const [lng, lat] = feature.geometry.coordinates;
        containers.push({
          id:           p.ID,
          lat,
          lng,
          fractie_code: code,
          loc:          p.LOCATIE || null,
        });
      }

      onProgress(containers.length);
      return containers;
    },
  };
})();
