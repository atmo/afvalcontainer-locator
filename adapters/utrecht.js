'use strict';

/**
 * Utrecht adapter — loads waste collection points from the municipality's
 * public BGT (Basisregistratie Grootschalige Topografie) GeoServer WFS.
 * Source: https://geodata.utrecht.nl (open data, CC-0)
 *
 * NOTE: Utrecht's BGT data exposes ~4,600 "afval apart plaatsen" —
 * underground multi-fraction container clusters for "Het Nieuwe Inzamelen".
 * The dataset does NOT encode fraction types per point, so all locations
 * are shown as a single "Inzamelpunt" category. Each physical cluster
 * typically serves rest, glas, papier, GFT and PMD waste.
 *
 * Feature type: UtrechtOpen:BGT_BAK_SWC
 *   IMGEO_TYPE_PLUS = "afval apart plaats" (all features in this layer)
 *   VERVAL_TIJDSTIP = null → active; non-null → expired/removed
 */

(function () {
  const WFS_URL = 'https://geodata.utrecht.nl/geoserver/UtrechtOpen/wfs';

  const fractions = {
    'BAK': { color: '#546e7a', nameKey: 'fractionInzamelpunt', emoji: '♻️' },
  };

  window.CityAdapters = window.CityAdapters || {};
  window.CityAdapters.utrecht = {
    id:          'utrecht',
    nameKey:     'cityUtrecht',
    center:      [52.0907, 5.1214],
    zoom:        13,
    cacheKey:    'afvalcontainers_utrecht_v1',
    cacheFields: ['id', 'lat', 'lng', 'fractie_code'],
    dataDate:    null,
    fractions,
    note: {
      nl: 'De BGT-data bevat geen fractionering per locatie. Elk inzamelpunt is een cluster voor meerdere fracties (rest, glas, papier, GFT, PMD).',
      en: 'The BGT dataset does not include fraction types per location. Each collection point is a cluster for multiple fractions (residual, glass, paper, organic, PMD).',
    },
    dataCredit: {
      nl: 'Data: <a href="https://geodata.utrecht.nl" target="_blank" rel="noopener">Gemeente Utrecht</a> (BGT, CC-0)<br>Kaart: <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors<br>Routes: <a href="https://project-osrm.org" target="_blank" rel="noopener">OSRM</a>',
      en: 'Data: <a href="https://geodata.utrecht.nl" target="_blank" rel="noopener">City of Utrecht</a> (BGT, CC-0)<br>Map: <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors<br>Routes: <a href="https://project-osrm.org" target="_blank" rel="noopener">OSRM</a>',
    },

    async load(onProgress) {
      const params = new URLSearchParams({
        service:      'WFS',
        version:      '2.0.0',
        request:      'GetFeature',
        typeName:     'BGT_BAK_SWC',
        outputFormat: 'application/json',
        SRSNAME:      'EPSG:4326',
        count:        '5000',
      });

      const resp = await fetch(`${WFS_URL}?${params}`);
      if (!resp.ok) throw new Error(`Utrecht WFS error: HTTP ${resp.status}`);
      const { features = [] } = await resp.json();

      const containers = [];
      for (const feature of features) {
        if (!feature.geometry) continue;
        const p = feature.properties;
        if (p.VERVAL_TIJDSTIP) continue; // expired/removed
        const [lng, lat] = feature.geometry.coordinates;
        containers.push({
          id:           String(p.ID || p.IMGEO_LOKAALID),
          lat,
          lng,
          fractie_code: 'BAK',
        });
      }

      onProgress(containers.length);
      return containers;
    },
  };
})();
