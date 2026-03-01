'use strict';

// ============================================================
// Translations
// ============================================================

const TRANSLATIONS = {
  nl: {
    pageTitle:         'Afvalcontainers Amsterdam',
    loadingLabel:      'Containers laden…',
    loaded:            '{n} geladen',
    loadedCache:       '{n} geladen (cache)',
    sidebarTitle:      'Afvalcontainers',
    cityAmsterdam:     'Amsterdam',
    cityDenHaag:       'Den Haag',
    cityRotterdam:     'Rotterdam',
    typeLabel:         'Container type',
    countLabel:        'Aantal',
    typeAll:           '— Alle types tonen —',
    modeLabel:         'Startpunt kiezen',
    modePoint:         '📍 Punt op kaart',
    modeContainer:     '🗑️ Container',
    instrPoint:        '📍 Klik ergens op de kaart om een startpunt te kiezen.',
    instrContainer:    '🗑️ Klik op een container op de kaart om die als startpunt te kiezen.<br><small style="color:#aaa">Zoom in om individuele containers te zien.</small>',
    instrTypeNeeded:   '✅ Startpunt gekozen! Selecteer nu een <strong>container type</strong> hierboven.',
    instrCalculating:  '🔄 Routes berekenen…',
    instrNoneFound:    '⚠️ Geen containers van dit type gevonden.',
    instrFound:        '✅ {n} dichtstbijzijnde {name}containers gevonden!',
    resultsHeader:     '{n} dichtstbijzijnde containers',
    addressLoading:    'Adres laden…',
    containerLabel:    '{emoji} {name}container',
    walkTime:          '⏱ ~{min} min',
    printWalkTime:     '~{min} min looptijd',
    pdfBtn:            '📄 Download als PDF',
    clearBtn:          'Wissen',
    legendTitle:       'Legenda',
    fractionRest:      'Rest',
    fractionGfe:       'GFT-afval',
    fractionGlas:      'Glas',
    fractionPapier:    'Papier',
    fractionTextiel:   'Textiel',
    fractionPlastic:   'Plastic',
    printModalTitle:   'PDF-instellingen',
    printOrientLabel:  'Oriëntatie',
    printPortrait:     'Staand',
    printLandscape:    'Liggend',
    printShowDetails:  'Routeoverzicht tonen',
    printCancel:       'Annuleren',
    printConfirm:      'Afdrukken',
    previewHint:       '🖨 Pan en zoom om het kaartgebied aan te passen',
    previewTip:        'Schakel in de printdialoog <em>Kopteksten en voetteksten</em> uit om de bestandsnaam te verbergen.',
    previewCancel:     'Annuleren',
    previewPrint:      'Afdrukken',
    printTitle:        '♻️ Afvalcontainers Amsterdam – Looproutes',
    printTypeLabel:    'Container type:',
    printFooter:       'Data: Gemeente Amsterdam Open Data (CC BY 4.0) | Kaart: © OpenStreetMap contributors | Routes: OSRM',
    toastOsrmFallback:     '⚠️ ORS niet beschikbaar — routes via OSRM (minder nauwkeurige looproutes)',
    toastGeocodeFallback:  '⚠️ Adresgegevens niet beschikbaar voor sommige containers — adres via Nominatim opgezocht',
    geocodeLang:       'nl',
    pdfDocTitle:       'Afvalcontainers Amsterdam',
  },
  en: {
    pageTitle:         'Waste Containers Amsterdam',
    loadingLabel:      'Loading containers…',
    loaded:            '{n} loaded',
    loadedCache:       '{n} loaded (cache)',
    sidebarTitle:      'Waste Containers',
    cityAmsterdam:     'Amsterdam',
    cityDenHaag:       'The Hague',
    cityRotterdam:     'Rotterdam',
    typeLabel:         'Container type',
    countLabel:        'Count',
    typeAll:           '— Show all types —',
    modeLabel:         'Choose start point',
    modePoint:         '📍 Point on map',
    modeContainer:     '🗑️ Container',
    instrPoint:        '📍 Click anywhere on the map to choose a start point.',
    instrContainer:    '🗑️ Click on a container on the map to use it as a start point.<br><small style="color:#aaa">Zoom in to see individual containers.</small>',
    instrTypeNeeded:   '✅ Start point set! Now select a <strong>container type</strong> above.',
    instrCalculating:  '🔄 Calculating routes…',
    instrNoneFound:    '⚠️ No containers of this type found.',
    instrFound:        '✅ Found {n} nearest {name} containers!',
    resultsHeader:     '{n} nearest containers',
    addressLoading:    'Loading address…',
    containerLabel:    '{emoji} {name} container',
    walkTime:          '⏱ ~{min} min',
    printWalkTime:     '~{min} min walk',
    pdfBtn:            '📄 Download as PDF',
    clearBtn:          'Clear',
    legendTitle:       'Legend',
    fractionRest:      'Residual',
    fractionGfe:       'Organic waste',
    fractionGlas:      'Glass',
    fractionPapier:    'Paper',
    fractionTextiel:   'Textiles',
    fractionPlastic:   'Plastic',
    printModalTitle:   'PDF settings',
    printOrientLabel:  'Orientation',
    printPortrait:     'Portrait',
    printLandscape:    'Landscape',
    printShowDetails:  'Show route overview',
    printCancel:       'Cancel',
    printConfirm:      'Print',
    previewHint:       '🖨 Pan and zoom to adjust the map area',
    previewTip:        'In the print dialog, uncheck <em>Headers and footers</em> to hide the filename.',
    previewCancel:     'Cancel',
    previewPrint:      'Print',
    printTitle:        '♻️ Waste Containers Amsterdam – Walking routes',
    printTypeLabel:    'Container type:',
    printFooter:       'Data: City of Amsterdam Open Data (CC BY 4.0) | Map: © OpenStreetMap contributors | Routes: OSRM',
    toastOsrmFallback:     '⚠️ ORS unavailable — using OSRM (less accurate pedestrian routing)',
    toastGeocodeFallback:  '⚠️ Address data unavailable for some containers — looked up via Nominatim',
    geocodeLang:       'en',
    pdfDocTitle:       'Waste Containers Amsterdam',
  },
};

// ============================================================
// Runtime state
// ============================================================

// Detect language: saved preference first, then browser locale.
// Dutch only for nl-* locales; everything else defaults to English.
let currentLang = (() => {
  const saved = localStorage.getItem('afval_lang');
  if (saved === 'nl' || saved === 'en') return saved;
  return (navigator.language || '').toLowerCase().startsWith('nl') ? 'nl' : 'en';
})();

// ============================================================
// Public API
// ============================================================

/**
 * Translate a key in the current language.
 * Optionally substitutes {placeholder} tokens from the vars object.
 */
function t(key, vars) {
  let s = (TRANSLATIONS[currentLang] || TRANSLATIONS.en)[key] || key;
  if (vars) Object.entries(vars).forEach(([k, v]) => { s = s.replaceAll('{' + k + '}', v); });
  return s;
}

/**
 * Walk all [data-i18n] / [data-i18n-html] elements and update their text.
 * App-specific selects (fraction dropdown) are NOT touched here —
 * app.js handles those via the 'langchange' event.
 */
function applyTranslations() {
  document.title = t('pageTitle');
  document.querySelectorAll('[data-i18n]').forEach(el => {
    el.textContent = t(el.dataset.i18n);
  });
  document.querySelectorAll('[data-i18n-html]').forEach(el => {
    el.innerHTML = t(el.dataset.i18nHtml);
  });
}

/**
 * Switch to a new language, persist the choice, re-translate the page,
 * and fire a 'langchange' CustomEvent for app.js to react to.
 */
window.setLang = function (lang) {
  currentLang = lang;
  localStorage.setItem('afval_lang', lang);
  document.querySelectorAll('.lang-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.lang === lang);
  });
  applyTranslations();
  document.dispatchEvent(new CustomEvent('langchange'));
};
