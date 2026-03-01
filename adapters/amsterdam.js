'use strict';

/**
 * Amsterdam adapter — loads underground waste containers from the city's WFS API.
 *
 * Registers itself on window.CityAdapters so app.js can use it.
 * Must be loaded via <script> before app.js.
 *
 * Adapter interface (all adapters must implement):
 *   id          {string}    unique identifier, used as localStorage key
 *   nameKey     {string}    i18n key for the city display name
 *   center      {[lat,lng]} default map centre
 *   zoom        {number}    default map zoom
 *   cacheKey    {string}    localStorage key for the container cache
 *   cacheFields {string[]}  container fields to persist in the cache
 *   fractions   {object}    fractie_code → { color, nameKey, emoji }
 *   load(onProgress) → Promise<Container[]>
 *     onProgress(n) called after each page with total loaded so far
 *     Container: { id, lat, lng, fractie_code, ...extras }
 */

(function () {
  const WFS_BASE  = 'https://api.data.amsterdam.nl/v1/wfs/huishoudelijkafval/';
  const PAGE_SIZE = 1000;

  const fractions = {
    '1': { color: '#5d5d5d', nameKey: 'fractionRest',    emoji: '♻️' },
    '2': { color: '#27ae60', nameKey: 'fractionGlas',    emoji: '🫙' },
    '3': { color: '#2471a3', nameKey: 'fractionPapier',  emoji: '📦' },
    '5': { color: '#ca6f1e', nameKey: 'fractionTextiel', emoji: '👕' },
  };

  /**
   * Fetches all containerlocatie pages and returns a Map<id → bronadres>.
   * Runs concurrently with the container pagination in load().
   */
  async function loadAllLocations() {
    const locMap = new Map();
    let startIndex = 0;
    let hasMore    = true;
    while (hasMore) {
      const url = new URL(WFS_BASE);
      url.searchParams.set('SERVICE',      'WFS');
      url.searchParams.set('VERSION',      '2.0.0');
      url.searchParams.set('REQUEST',      'GetFeature');
      url.searchParams.set('TYPENAMES',    'containerlocatie');
      url.searchParams.set('OUTPUTFORMAT', 'geojson');
      url.searchParams.set('SRSNAME',      'EPSG:4326');
      url.searchParams.set('count',        PAGE_SIZE);
      url.searchParams.set('STARTINDEX',   startIndex);
      const resp = await fetch(url.toString());
      if (!resp.ok) throw new Error(`Amsterdam WFS containerlocatie error: HTTP ${resp.status}`);
      const { features = [] } = await resp.json();
      for (const f of features) {
        const p = f.properties;
        if (p.id != null && p.bronadres) locMap.set(String(p.id), p.bronadres);
      }
      hasMore     = features.length === PAGE_SIZE;
      startIndex += PAGE_SIZE;
    }
    return locMap;
  }

  window.CityAdapters = window.CityAdapters || {};
  window.CityAdapters.amsterdam = {
    id:          'amsterdam',
    nameKey:     'cityAmsterdam',
    center:      [52.3676, 4.9041],
    zoom:        13,
    cacheKey:    'afvalcontainers_amsterdam_v4',
    cacheFields: ['lat', 'lng', 'fractie_code', 'id', 'id_nummer', 'verwijderd_dp', 'status', 'loc', 'wijzigingsdatum_dp'],
    fractions,
    dataCredit: {
      nl: 'Data: <a href="https://data.amsterdam.nl" target="_blank" rel="noopener">Gemeente Amsterdam</a> (CC BY 4.0)<br>Kaart: <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors<br>Routes: <a href="https://project-osrm.org" target="_blank" rel="noopener">OSRM</a>',
      en: 'Data: <a href="https://data.amsterdam.nl" target="_blank" rel="noopener">City of Amsterdam</a> (CC BY 4.0)<br>Map: <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors<br>Routes: <a href="https://project-osrm.org" target="_blank" rel="noopener">OSRM</a>',
    },

    async load(onProgress) {
      const containers = [];
      const validCodes = new Set(Object.keys(fractions));

      // Kick off location fetching concurrently — it runs in parallel with
      // the container pagination below (JS event loop interleaves the awaits).
      const locPromise = loadAllLocations();

      let startIndex = 0;
      let hasMore    = true;

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

        const resp = await fetch(url.toString());
        if (!resp.ok) throw new Error(`Amsterdam WFS error: HTTP ${resp.status}`);
        const { features = [] } = await resp.json();

        for (const feature of features) {
          if (!feature.geometry) continue;
          const p = feature.properties;
          if (p.verwijderd_dp)  continue;
          if (p.status !== 1)   continue; // 0=inactive, 1=active, 2=planned
          const code = String(p.fractie_code);
          if (!validCodes.has(code)) continue;
          const [lng, lat] = feature.geometry.coordinates;
          containers.push({ lat, lng, ...p, fractie_code: code });
        }

        onProgress(containers.length);
        hasMore     = features.length === PAGE_SIZE;
        startIndex += PAGE_SIZE;
      }

      // Join bundled addresses — locPromise may already be settled by now
      try {
        const locMap = await locPromise;
        containers.forEach(c => {
          if (c.locatie_id == null) return;
          const loc = locMap.get(String(c.locatie_id));
          if (loc) c.loc = loc;
        });
      } catch (err) {
        // Address join is best-effort; containers still usable without it
        console.warn('Amsterdam location data fetch failed:', err.message);
      }

      return containers;
    },
  };
})();
