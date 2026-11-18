import {GHANA_SEA} from './ghana-sea.mjs';
export const OSM_ATTRIBUTION='© OpenStreetMap contributors (ODbL) · Overture Maps places (CDLA-Permissive-2.0)';
export function isLocalOrPrivateMapHost(hostname){
 if(!hostname)return false;
 const h=hostname.toLowerCase();
 return h==='localhost'||h==='127.0.0.1'||h==='10.0.2.2'||/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)||/^192\.168\.\d{1,3}\.\d{1,3}$/.test(h)||/^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(h);
}
export function privateTileUrl(value,{development=false}={}){
 if(!value)return null;
 if(typeof value!=='string'||value.length>1000)throw Error('Invalid private map tile URL');
 const url=new URL(value);
 const local=isLocalOrPrivateMapHost(url.hostname);
 if(url.username||url.password||url.search||url.hash||!(url.protocol==='https:'||(development&&local&&url.protocol==='http:')))throw Error('Private map tiles require HTTPS outside local development');
 if(!value.includes('{z}')||!value.includes('{x}')||!value.includes('{y}'))throw Error('Private map URL requires z/x/y placeholders');
 if(/(^|\.)(googleapis\.com|google\.com|openstreetmap\.org|mapbox\.com|maptiler\.com|maplibre\.org|geoapify\.com)$/.test(url.hostname))throw Error('Configure your own tile server, not a third-party public service');
 return value;
}
const DAY={background:'#f4f3ee',residential:'#efece6',park:'#cdeac0',wood:'#bfe3b4',farm:'#eef0d8',sand:'#f6edc9',hospital:'#fbe3e1',school:'#f4eedb',commercial:'#f4ece2',industrial:'#e9e6e4',airport:'#e2e5ea',water:'#9fd3f0',waterLine:'#7fc1e8',building:'#e3dfd8',buildingLine:'#d3cdc4',casing:'#c9c5bc',minor:'#ffffff',major:'#ffffff',primary:'#fde293',trunk:'#f9c74f',trunkCasing:'#d99a1e',path:'#b5ad9f',rail:'#a8a8a8',text:'#3c4043',textMuted:'#70757a',halo:'#ffffff',water_text:'#2f77a8'};
const NIGHT={background:'#111a2b',residential:'#141f33',park:'#16302a',wood:'#143029',farm:'#172233',sand:'#2a2b2a',hospital:'#2b2030',school:'#1f2233',commercial:'#1c2438',industrial:'#1a2133',airport:'#1c2538',water:'#0d2c4a',waterLine:'#123a60',building:'#1f2a40',buildingLine:'#2a3752',casing:'#0b1220',minor:'#33415c',major:'#46577a',primary:'#7d6a3a',trunk:'#a8853c',trunkCasing:'#4a3b1c',path:'#4b5a78',rail:'#46506a',text:'#dbe3f0',textMuted:'#9aa8bf',halo:'#0b1220',water_text:'#7fb6e0'};
const POI_COLORS={food:'#e8710a',shop:'#1a73e8',health:'#d93025',money:'#188038',fuel:'#5f6368',education:'#9334e6',worship:'#7b5e3b',transport:'#1967d2',stay:'#c5221f',sights:'#12857a',civic:'#5f6368'};
const FONT=['Noto Sans Regular'],BOLD=['Noto Sans Bold'];
const byClass=(zoom,rows,fallback)=>['interpolate',['exponential',1.5],['zoom'],...zoom.flatMap((z,i)=>[z,['match',['get','class'],...rows.flatMap(([names,widths])=>[names,widths[i]]),fallback[i]]])];
const ROAD_ZOOMS=[6,10,14,18];
const ROAD_WIDTHS=[
 [['motorway','trunk'],[1.2,3,8,26]],
 [['primary'],[0.6,2.4,7,22]],
 [['secondary'],[0.2,1.6,6,18]],
 [['tertiary'],[0,1,5,16]],
 [['motorway_link','trunk_link','primary_link','secondary_link','tertiary_link'],[0,0.8,3.5,12]],
 [['residential','unclassified','living_street'],[0,0.3,3,13]]
];
const ROAD_DEFAULT=[0,0,1.6,7];
const casingWidths=ROAD_WIDTHS.map(([names,w])=>[names,w.map((v,i)=>v?v+(i>1?1.6:0.6):0)]);
const SOLID_ROADS=['!',['match',['get','class'],['path','footway','steps','track','pedestrian'],true,false]];
function landFill(id,filter,color,minzoom=8){return {id,type:'fill',source:'ghana','source-layer':'landuse',minzoom,filter,paint:{'fill-color':color}};}
export function privateMapStyle(tileUrl,{glyphsUrl=null,night=false}={}){
 const c=night?NIGHT:DAY;
 const label=(id,layer,extra,paintExtra={})=>({id,type:'symbol',source:'ghana','source-layer':layer,...extra,paint:{'text-color':c.text,'text-halo-color':c.halo,'text-halo-width':1.4,...paintExtra}});
 return {version:8,name:night?'ELESEND Ghana Night':'ELESEND Ghana',
  ...(glyphsUrl?{glyphs:glyphsUrl}:{}),
  sources:tileUrl?{ghana:{type:'vector',tiles:[tileUrl],minzoom:0,maxzoom:14,attribution:OSM_ATTRIBUTION},sea:{type:'geojson',data:{type:'Feature',properties:{},geometry:{type:'Polygon',coordinates:[GHANA_SEA]}}}}:{},
  layers:[
   {id:'background',type:'background',paint:{'background-color':c.background}},
   ...(tileUrl?[
    {id:'sea',type:'fill',source:'sea',paint:{'fill-color':c.water}},
    landFill('land-residential',['in',['get','landuse'],['literal',['residential']]],c.residential,11),
    landFill('land-commercial',['in',['get','landuse'],['literal',['commercial','retail']]],c.commercial,11),
    landFill('land-industrial',['in',['get','landuse'],['literal',['industrial','military']]],c.industrial,11),
    landFill('land-farm',['in',['get','landuse'],['literal',['farmland','orchard','meadow']]],c.farm),
    landFill('land-wood',['any',['in',['get','landuse'],['literal',['forest']]],['in',['get','natural'],['literal',['wood','scrub','wetland']]]],c.wood),
    landFill('land-park',['any',['in',['get','leisure'],['literal',['park','garden','pitch','stadium','golf_course','nature_reserve']]],['in',['get','landuse'],['literal',['grass','recreation_ground','village_green','cemetery']]]],c.park),
    landFill('land-sand',['in',['get','natural'],['literal',['beach','sand']]],c.sand),
    landFill('land-hospital',['==',['get','amenity'],'hospital'],c.hospital,11),
    landFill('land-school',['in',['get','amenity'],['literal',['school','university','college']]],c.school,11),
    landFill('land-airport',['has','aeroway'],c.airport,9),
    {id:'water',type:'fill',source:'ghana','source-layer':'water',paint:{'fill-color':c.water}},
    {id:'waterway',type:'line',source:'ghana','source-layer':'waterway',paint:{'line-color':c.waterLine,'line-width':['interpolate',['linear'],['zoom'],8,0.5,14,2.5]}},
    {id:'building',type:'fill',source:'ghana','source-layer':'building',minzoom:14,paint:{'fill-color':c.building,'fill-outline-color':c.buildingLine}},
    {id:'railway',type:'line',source:'ghana','source-layer':'railway',paint:{'line-color':c.rail,'line-width':1.2,'line-dasharray':[4,3]}},
    {id:'roads-path',type:'line',source:'ghana','source-layer':'roads',minzoom:14,filter:['!',SOLID_ROADS],paint:{'line-color':c.path,'line-width':1.2,'line-dasharray':[2,2]}},
    {id:'roads-casing',type:'line',source:'ghana','source-layer':'roads',filter:SOLID_ROADS,layout:{'line-cap':'round','line-join':'round'},paint:{'line-color':['match',['get','class'],['motorway','trunk','motorway_link','trunk_link'],c.trunkCasing,c.casing],'line-width':byClass(ROAD_ZOOMS,casingWidths,[0,0,2.6,8.6])}},
    {id:'roads',type:'line',source:'ghana','source-layer':'roads',filter:SOLID_ROADS,layout:{'line-cap':'round','line-join':'round'},paint:{'line-color':['match',['get','class'],['motorway','trunk','motorway_link','trunk_link'],c.trunk,['primary','primary_link'],c.primary,['secondary','secondary_link','tertiary','tertiary_link'],c.major,c.minor],'line-width':byClass(ROAD_ZOOMS,ROAD_WIDTHS,ROAD_DEFAULT)}},
    ...(glyphsUrl?[
     label('oneway-arrow','roads',{minzoom:15,filter:['in',['get','oneway'],['literal',['yes','1']]],layout:{'symbol-placement':'line','symbol-spacing':140,'text-field':'›','text-font':BOLD,'text-size':16,'text-keep-upright':false}},{'text-color':c.textMuted,'text-halo-width':0}),
     label('water-label','waterway',{minzoom:11,layout:{'symbol-placement':'line','text-field':['get','name'],'text-font':FONT,'text-size':11}},{'text-color':c.water_text}),
     label('roads-label','roads',{minzoom:13,filter:SOLID_ROADS,layout:{'symbol-placement':'line','text-field':['get','name'],'text-size':['interpolate',['linear'],['zoom'],13,10,17,13],'text-font':FONT,'text-max-angle':30}}),
     label('roads-ref','roads',{minzoom:9,maxzoom:14,filter:['all',['has','ref'],['in',['get','class'],['literal',['motorway','trunk','primary']]]],layout:{'symbol-placement':'line','symbol-spacing':400,'text-field':['get','ref'],'text-font':BOLD,'text-size':10}},{'text-color':c.textMuted}),
     label('poi-label','poi',{minzoom:15,filter:['has','name'],layout:{'text-field':['get','name'],'text-font':FONT,'text-size':11,'text-anchor':'top','text-offset':[0,0.5],'text-max-width':8,'text-optional':true,'icon-optional':true}},{'text-color':['match',['get','group'],...Object.entries(POI_COLORS).flat(),c.textMuted]}),
     label('places-minor','places',{minzoom:12,filter:['in',['get','class'],['literal',['neighbourhood','quarter','hamlet']]],layout:{'text-field':['get','name'],'text-size':11,'text-font':FONT,'text-max-width':8}},{'text-color':c.textMuted}),
     label('places-suburb','places',{minzoom:10,filter:['in',['get','class'],['literal',['suburb','village']]],layout:{'text-field':['get','name'],'text-size':['interpolate',['linear'],['zoom'],10,11,14,14],'text-font':FONT,'text-max-width':8}}),
     label('places-town','places',{minzoom:7,filter:['==',['get','class'],'town'],layout:{'text-field':['get','name'],'text-size':['interpolate',['linear'],['zoom'],7,11,12,16],'text-font':BOLD,'text-max-width':8}}),
     label('places-city','places',{filter:['==',['get','class'],'city'],layout:{'text-field':['get','name'],'text-size':['interpolate',['linear'],['zoom'],5,12,12,20],'text-font':BOLD,'text-max-width':8}})
    ]:[]),
    {id:'poi-dot',type:'circle',source:'ghana','source-layer':'poi',minzoom:15,paint:{'circle-radius':3.5,'circle-color':['match',['get','group'],...Object.entries(POI_COLORS).flat(),c.textMuted],'circle-stroke-color':c.halo,'circle-stroke-width':1}}
   ]:[])
  ]};
}
export function displayRoadRoute(route){return route?.mapContentFamily==='independent'&&route?.providerId==='osrm'&&Array.isArray(route.points)&&route.points.length>=2?route:null;}

/** A plain raster base map, for when the server proxies a hosted tile service. The phone only sees our API address. */
export function rasterMapStyle(tileUrl, {attribution = ''} = {}) {
 return {version: 8, name: 'ELESEND Ghana', sources: {base: {type: 'raster', tiles: [tileUrl], tileSize: 256, minzoom: 0, maxzoom: 20, ...(attribution ? {attribution} : {})}}, layers: [{id: 'base', type: 'raster', source: 'base'}]};
}
