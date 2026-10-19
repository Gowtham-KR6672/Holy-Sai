/** A self-contained Leaflet page (OpenStreetMap tiles by default) used inside a WebView / iframe. */
export interface MapMarker {
  id: string;
  lat: number;
  lng: number;
  label: string;
  tone?: 'brand' | 'success' | 'warning' | 'critical' | 'info' | 'neutral';
  kind?: 'student' | 'bus' | 'stop';
  /** Accuracy radius in metres, drawn as a soft circle. */
  accuracy?: number | null;
}

export interface MapCircle {
  lat: number;
  lng: number;
  radius: number;
  label?: string;
}

export interface MapData {
  markers: MapMarker[];
  circles?: MapCircle[];
  /** A polyline (e.g. a bus trail). */
  path?: [number, number][];
  fit?: boolean;
  labels?: boolean;
}

export const DEFAULT_TILE = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
export const DEFAULT_ATTRIBUTION = '&copy; OpenStreetMap contributors';

/** JSON that is safe to place inside a <script> element. */
export function scriptJson(v: unknown) {
  const LS = String.fromCharCode(0x2028);
  const PS = String.fromCharCode(0x2029);
  return JSON.stringify(v).replace(/</g, '\\u003c').split(LS).join('\\u2028').split(PS).join('\\u2029');
}

export function leafletHtml(data: MapData, tileUrl = DEFAULT_TILE, attribution = DEFAULT_ATTRIBUTION) {
  return `<!doctype html>
<html><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1"/>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
<style>
html,body,#map{margin:0;padding:0;height:100%;width:100%;background:#F3F0EE;font-family:-apple-system,Roboto,sans-serif}
.leaflet-tooltip{font-size:12px;font-weight:600;border-radius:8px;padding:3px 8px}
</style></head>
<body><div id="map"></div>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>
(function(){
  var COLORS={brand:'#990033',success:'#0F7A55',warning:'#E07A1F',critical:'#D21F3A',info:'#8F0A40',neutral:'#5A6070'};
  function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
  var map=L.map('map',{zoomControl:true,attributionControl:true}).setView([20.59,78.96],5);
  L.tileLayer(${scriptJson(tileUrl)},{maxZoom:19,attribution:${scriptJson(attribution)}}).addTo(map);
  var layer=L.layerGroup().addTo(map);
  var first=true;
  window.__setData=function(d){
    layer.clearLayers();
    var pts=[];
    (d.circles||[]).forEach(function(c){
      L.circle([c.lat,c.lng],{radius:c.radius,color:'#990033',weight:1,fillColor:'#990033',fillOpacity:0.06}).addTo(layer);
      if(c.label){L.marker([c.lat,c.lng],{opacity:0}).bindTooltip(esc(c.label),{permanent:true,direction:'center'}).addTo(layer);}
      pts.push([c.lat,c.lng]);
    });
    if(d.path&&d.path.length>1){L.polyline(d.path,{color:'#990033',weight:4,opacity:0.6}).addTo(layer);}
    (d.markers||[]).forEach(function(m){
      if(m.accuracy){L.circle([m.lat,m.lng],{radius:m.accuracy,color:COLORS[m.tone]||COLORS.brand,weight:1,fillOpacity:0.08}).addTo(layer);}
      var mk=L.circleMarker([m.lat,m.lng],{radius:m.kind==='bus'?10:m.kind==='stop'?5:8,color:'#fff',weight:2,fillColor:COLORS[m.tone]||COLORS.brand,fillOpacity:1}).addTo(layer);
      mk.bindTooltip(esc(m.label),{permanent:!!d.labels,direction:'top',offset:[0,-8]});
      pts.push([m.lat,m.lng]);
    });
    if((d.fit!==false||first)&&pts.length){
      if(pts.length===1){map.setView(pts[0],16);}else{map.fitBounds(pts,{padding:[36,36],maxZoom:16});}
    }
    first=false;
  };
  window.__setData(${scriptJson(data)});
})();
</script></body></html>`;
}
