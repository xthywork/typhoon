// MapLibre 6 ships ES modules. Load its Leaflet integration before the classic
// application script so the map and UI share the existing global interfaces.
import * as maplibregl from './vendor/maplibre/maplibre-gl.mjs';

window.maplibregl = maplibregl;
await import('./vendor/maplibre/leaflet-maplibre-gl.js');

const application = document.createElement('script');
const applicationURL = new URL('./app.js', import.meta.url);
// Carry the HTML asset revision into the dynamically loaded application.
applicationURL.search = new URL(import.meta.url).search;
application.src = applicationURL.href;
document.body.append(application);
