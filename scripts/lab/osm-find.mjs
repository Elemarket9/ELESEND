// LAB ONLY: find RAPID Courier, GTBank Kasoa and the Kotoka domestic terminal in an OpenStreetMap GeoJSONSeq export.
import {createReadStream,writeFileSync} from 'node:fs';import readline from 'node:readline';
const [,,file,outFile]=process.argv;const hits={rapid:[],gtb:[],domestic:[]};
const centre=g=>{const c=[];(function w(a){if(typeof a[0]==='number')c.push(a);else a.forEach(w);})(g.coordinates);return {longitude:c.reduce((s,p)=>s+p[0],0)/c.length,latitude:c.reduce((s,p)=>s+p[1],0)/c.length};};
for await(const raw of readline.createInterface({input:createReadStream(file)})){
 const line=raw.replace(/^\x1e/,'');if(!line)continue;let f;try{f=JSON.parse(line);}catch{continue;}
 const t=f.properties||{},text=[t.name,t.brand,t.operator,t['name:en'],t.official_name].filter(Boolean).join(' | ');if(!text)continue;
 const p={...centre(f.geometry),name:t.name,brand:t.brand,amenity:t.amenity,office:t.office,aeroway:t.aeroway,shop:t.shop,addr:t['addr:street']};
 if(/rapid/i.test(text)&&/courier|express|logistic|parcel/i.test(text+' '+(t.office||'')+(t.shop||'')))hits.rapid.push(p);
 if(/g\.?\s?t\.?\s?bank|guaranty/i.test(text))hits.gtb.push(p);
 if(/domestic/i.test(text)&&(t.aeroway||/terminal|airport/i.test(text)))hits.domestic.push(p);
}
const d=(a,b)=>Math.hypot((a.latitude-b.latitude)*111,(a.longitude-b.longitude)*111*Math.cos(a.latitude*Math.PI/180));
const kasoa={latitude:5.5367,longitude:-0.4215};
const gtbKasoa=hits.gtb.filter(p=>d(p,kasoa)<4).sort((a,b)=>d(a,kasoa)-d(b,kasoa));
const result={allRapid:hits.rapid,domestic:hits.domestic,gtbNearKasoa:gtbKasoa,gtbCount:hits.gtb.length,
 rapidCourier:hits.rapid[0]||null,gtbankKasoa:gtbKasoa[0]||null,domesticTerminal:hits.domestic[0]||null};
console.log(JSON.stringify(result,null,1));writeFileSync(outFile,JSON.stringify(result));
