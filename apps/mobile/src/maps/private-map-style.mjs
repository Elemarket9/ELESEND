export const OSM_ATTRIBUTION='© OpenStreetMap contributors';
export function privateTileUrl(value,{development=false}={}){
 if(!value)return null;
 if(typeof value!=='string'||value.length>1000)throw Error('Invalid private map tile URL');
 const url=new URL(value);
 const local=['localhost','127.0.0.1','10.0.2.2'].includes(url.hostname);
 if(url.username||url.password||url.search||url.hash||!(url.protocol==='https:'||(development&&local&&url.protocol==='http:')))throw Error('Private map tiles require HTTPS outside emulator development');
 if(!value.includes('{z}')||!value.includes('{x}')||!value.includes('{y}'))throw Error('Private map URL requires z/x/y placeholders');
 if(/(^|\.)(googleapis\.com|google\.com|openstreetmap\.org|mapbox\.com|maptiler\.com|maplibre\.org)$/.test(url.hostname))throw Error('Configure your own tile server, not a third-party public service');
 return value;
}
export function privateMapStyle(tileUrl){
 return {version:8,name:'ELESEND Ghana',sources:tileUrl?{ghana:{type:'vector',tiles:[tileUrl],minzoom:0,maxzoom:14,attribution:OSM_ATTRIBUTION}}:{},layers:[
  {id:'background',type:'background',paint:{'background-color':'#f3f1e8'}},
  ...(tileUrl?[
   {id:'landuse',type:'fill',source:'ghana','source-layer':'landuse',paint:{'fill-color':'#dce8d5','fill-opacity':0.65}},
   {id:'water',type:'fill',source:'ghana','source-layer':'water',paint:{'fill-color':'#abd4e5'}},
   {id:'building',type:'fill',source:'ghana','source-layer':'building',minzoom:12,paint:{'fill-color':'#d0c8bc','fill-outline-color':'#bcb4a9'}},
   {id:'roads-casing',type:'line',source:'ghana','source-layer':'roads',layout:{'line-cap':'round','line-join':'round'},paint:{'line-color':'#d0c4ad','line-width':['interpolate',['linear'],['zoom'],6,1,14,6,18,15]}},
   {id:'roads',type:'line',source:'ghana','source-layer':'roads',layout:{'line-cap':'round','line-join':'round'},paint:{'line-color':'#ffffff','line-width':['interpolate',['linear'],['zoom'],6,0.5,14,4,18,12]}},
   {id:'places',type:'circle',source:'ghana','source-layer':'places',paint:{'circle-radius':2,'circle-color':'#526b64'}}
  ]:[])
 ]};
}
export function displayRoadRoute(route){return route?.mapContentFamily==='independent'&&route?.providerId==='osrm'&&Array.isArray(route.points)&&route.points.length>=2?route:null;}
