import {haversine} from '../../dispatch-geometry.mjs';
import {check} from '../../security.mjs';

const GHANA_BOUNDS={minLatitude:4.5,maxLatitude:11.4,minLongitude:-3.4,maxLongitude:1.4};

export const GHANA_GAZETTEER=[
 // Greater Accra - Hubs & Landmarks
 {name:'Accra Mall',category:'mall',locality:'Tetteh Quarshie',city:'Accra',region:'Greater Accra',latitude:5.6212,longitude:-0.1748,popularity:100},
 {name:'Kotoka International Airport (Terminal 3)',category:'airport',locality:'Airport',city:'Accra',region:'Greater Accra',latitude:5.6052,longitude:-0.1698,popularity:99},
 {name:'Marina Mall',category:'mall',locality:'Airport City',city:'Accra',region:'Greater Accra',latitude:5.5975,longitude:-0.1764,popularity:85},
 {name:'A&C Mall',category:'mall',locality:'East Legon',city:'Accra',region:'Greater Accra',latitude:5.6378,longitude:-0.1554,popularity:90},
 {name:'Achimota Retail Centre',category:'mall',locality:'Achimota',city:'Accra',region:'Greater Accra',latitude:5.6321,longitude:-0.2312,popularity:80},
 {name:'West Hills Mall',category:'mall',locality:'Weija / Dunkonah',city:'Accra',region:'Greater Accra',latitude:5.5529,longitude:-0.3444,popularity:88},
 {name:'Junction Mall',category:'mall',locality:'Nungua Barrier',city:'Accra',region:'Greater Accra',latitude:5.6144,longitude:-0.0827,popularity:82},
 {name:'Makola Market',category:'market',locality:'Accra Central',city:'Accra',region:'Greater Accra',latitude:5.5428,longitude:-0.2064,popularity:95},
 {name:'Kwame Nkrumah Circle (Circle Interchange)',category:'transit',locality:'Circle',city:'Accra',region:'Greater Accra',latitude:5.5601,longitude:-0.2104,popularity:95},
 {name:'Kaneshie Market Complex',category:'market',locality:'Kaneshie',city:'Accra',region:'Greater Accra',latitude:5.5684,longitude:-0.2396,popularity:92},
 {name:'Korle-Bu Teaching Hospital',category:'hospital',locality:'Korle Bu',city:'Accra',region:'Greater Accra',latitude:5.5372,longitude:-0.2285,popularity:90},
 {name:'37 Military Hospital',category:'hospital',locality:'37',city:'Accra',region:'Greater Accra',latitude:5.5898,longitude:-0.1818,popularity:91},
 {name:'Greater Accra Regional Hospital (Ridge)',category:'hospital',locality:'Ridge',city:'Accra',region:'Greater Accra',latitude:5.5615,longitude:-0.1983,popularity:86},
 {name:'Black Star Square (Independence Square)',category:'landmark',locality:'Osu',city:'Accra',region:'Greater Accra',latitude:5.5489,longitude:-0.1927,popularity:88},
 {name:'National Theatre of Ghana',category:'landmark',locality:'Victoriaborg',city:'Accra',region:'Greater Accra',latitude:5.5539,longitude:-0.1994,popularity:80},

 // Greater Accra - Neighborhoods & Arterials
 {name:'Osu (Oxford Street)',category:'neighborhood',locality:'Osu',city:'Accra',region:'Greater Accra',latitude:5.5562,longitude:-0.1825,popularity:96},
 {name:'East Legon (Lagos Avenue)',category:'neighborhood',locality:'East Legon',city:'Accra',region:'Greater Accra',latitude:5.6354,longitude:-0.1601,popularity:98},
 {name:'Airport Residential Area',category:'neighborhood',locality:'Airport',city:'Accra',region:'Greater Accra',latitude:5.6021,longitude:-0.1834,popularity:92},
 {name:'Cantonments',category:'neighborhood',locality:'Cantonments',city:'Accra',region:'Greater Accra',latitude:5.5786,longitude:-0.1705,popularity:90},
 {name:'Labone',category:'neighborhood',locality:'Labone',city:'Accra',region:'Greater Accra',latitude:5.5678,longitude:-0.1652,popularity:88},
 {name:'Dzorwulu',category:'neighborhood',locality:'Dzorwulu',city:'Accra',region:'Greater Accra',latitude:5.6092,longitude:-0.1963,popularity:87},
 {name:'Roman Ridge',category:'neighborhood',locality:'Roman Ridge',city:'Accra',region:'Greater Accra',latitude:5.5971,longitude:-0.1912,popularity:84},
 {name:'Abelemkpe',category:'neighborhood',locality:'Abelemkpe',city:'Accra',region:'Greater Accra',latitude:5.6033,longitude:-0.2078,popularity:83},
 {name:'Spintex Road (Batsonaa / Manet)',category:'neighborhood',locality:'Spintex',city:'Accra',region:'Greater Accra',latitude:5.6415,longitude:-0.1065,popularity:94},
 {name:'Sakumono Estate',category:'neighborhood',locality:'Sakumono',city:'Accra',region:'Greater Accra',latitude:5.6268,longitude:-0.0573,popularity:80},
 {name:'Tema Community 1 (Center)',category:'town',locality:'Community 1',city:'Tema',region:'Greater Accra',latitude:5.6698,longitude:-0.0166,popularity:88},
 {name:'Tema Community 25',category:'town',locality:'Community 25',city:'Tema',region:'Greater Accra',latitude:5.7312,longitude:0.0245,popularity:78},
 {name:'Madina Zongo Junction',category:'market',locality:'Madina',city:'Accra',region:'Greater Accra',latitude:5.6721,longitude:-0.1661,popularity:90},
 {name:'Adenta Barrier / Frafraha',category:'neighborhood',locality:'Adenta',city:'Accra',region:'Greater Accra',latitude:5.7144,longitude:-0.1583,popularity:85},
 {name:'Haatso (Ecomog / Supermarket)',category:'neighborhood',locality:'Haatso',city:'Accra',region:'Greater Accra',latitude:5.6623,longitude:-0.1845,popularity:82},
 {name:'Dome Pillar 2',category:'neighborhood',locality:'Dome',city:'Accra',region:'Greater Accra',latitude:5.6456,longitude:-0.2198,popularity:81},
 {name:'Lapaz (Abrantie Spot / N1)',category:'neighborhood',locality:'Lapaz',city:'Accra',region:'Greater Accra',latitude:5.6045,longitude:-0.2467,popularity:91},
 {name:'Achimota (Old Station / Neoplan)',category:'transit',locality:'Achimota',city:'Accra',region:'Greater Accra',latitude:5.6189,longitude:-0.2274,popularity:86},
 {name:'Dansoman (Control / Roundabout)',category:'neighborhood',locality:'Dansoman',city:'Accra',region:'Greater Accra',latitude:5.5492,longitude:-0.2643,popularity:89},
 {name:'Tesano (Police Station / Club)',category:'neighborhood',locality:'Tesano',city:'Accra',region:'Greater Accra',latitude:5.5921,longitude:-0.2245,popularity:83},
 {name:'Jamestown (Lighthouse)',category:'landmark',locality:'Jamestown',city:'Accra',region:'Greater Accra',latitude:5.5342,longitude:-0.2078,popularity:80},
 {name:'Kasoa Toll Booth / New Market',category:'market',locality:'Kasoa',city:'Central',region:'Central',latitude:5.5367,longitude:-0.4215,popularity:89},
 {name:'Legon (University of Ghana Main Gate)',category:'education',locality:'Legon',city:'Accra',region:'Greater Accra',latitude:5.6508,longitude:-0.1869,popularity:93},

 // Ashanti Region - Kumasi
 {name:'Kejetia Market (Kumasi Central Market)',category:'market',locality:'Kejetia',city:'Kumasi',region:'Ashanti',latitude:6.6975,longitude:-1.6244,popularity:94},
 {name:'Adum (Commercial Center)',category:'neighborhood',locality:'Adum',city:'Kumasi',region:'Ashanti',latitude:6.6908,longitude:-1.6231,popularity:93},
 {name:'KNUST (Commercial Area / Tech)',category:'education',locality:'KNUST',city:'Kumasi',region:'Ashanti',latitude:6.6745,longitude:-1.5678,popularity:92},
 {name:'Kumasi City Mall',category:'mall',locality:'Asokwa',city:'Kumasi',region:'Ashanti',latitude:6.6741,longitude:-1.6082,popularity:89},
 {name:'Bantama High Street',category:'neighborhood',locality:'Bantama',city:'Kumasi',region:'Ashanti',latitude:6.7025,longitude:-1.6367,popularity:86},
 {name:'Ahodwo Roundabout',category:'neighborhood',locality:'Ahodwo',city:'Kumasi',region:'Ashanti',latitude:6.6712,longitude:-1.6267,popularity:87},
 {name:'Suame Magazine',category:'industrial',locality:'Suame',city:'Kumasi',region:'Ashanti',latitude:6.7214,longitude:-1.6415,popularity:85},

 // Other Major Ghanaian Cities & Regional Capitals (All 16 Regions)
 {name:'Takoradi Market Circle',category:'market',locality:'Market Circle',city:'Takoradi',region:'Western',latitude:4.8872,longitude:-1.7584,popularity:88},
 {name:'Sekondi Commercial Area',category:'town',locality:'Sekondi Central',city:'Sekondi',region:'Western',latitude:4.9392,longitude:-1.7136,popularity:80},
 {name:'Tarkwa Market Circle',category:'market',locality:'Central',city:'Tarkwa',region:'Western',latitude:5.3012,longitude:-1.9961,popularity:79},
 {name:'Cape Coast Castle / Town',category:'landmark',locality:'Cape Coast Central',city:'Cape Coast',region:'Central',latitude:5.1054,longitude:-1.2415,popularity:85},
 {name:'Elmina Castle / Fishing Harbour',category:'landmark',locality:'Elmina Central',city:'Elmina',region:'Central',latitude:5.0844,longitude:-1.3508,popularity:82},
 {name:'Winneba Junction / Roundabout',category:'transit',locality:'Winneba Junction',city:'Winneba',region:'Central',latitude:5.3562,longitude:-0.6247,popularity:80},
 {name:'Gomoa Budumburam (Liberia Camp)',category:'neighborhood',locality:'Budumburam',city:'Kasoa Corridor',region:'Central',latitude:5.5333,longitude:-0.4722,popularity:85},
 {name:'Kasoa Opeikuma Junction',category:'transit',locality:'Opeikuma',city:'Kasoa',region:'Central',latitude:5.5512,longitude:-0.4452,popularity:81},
 {name:'Kasoa Ofaakor Roundabout',category:'neighborhood',locality:'Ofaakor',city:'Kasoa',region:'Central',latitude:5.5684,longitude:-0.4289,popularity:78},
 {name:'Ashaiman Central Market',category:'market',locality:'Ashaiman Central',city:'Ashaiman',region:'Greater Accra',latitude:5.7001,longitude:-0.0333,popularity:88},
 {name:'Ejisu Central Market',category:'market',locality:'Ejisu Central',city:'Ejisu',region:'Ashanti',latitude:6.7134,longitude:-1.4821,popularity:80},
 {name:'Konongo Central',category:'town',locality:'Konongo-Odumase',city:'Konongo',region:'Ashanti',latitude:6.6167,longitude:-1.2167,popularity:79},
 {name:'Tamale Central Market',category:'market',locality:'Central',city:'Tamale',region:'Northern',latitude:9.4072,longitude:-0.8392,popularity:86},
 {name:'Savelugu Main Station',category:'transit',locality:'Central',city:'Savelugu',region:'Northern',latitude:9.6253,longitude:-0.8267,popularity:75},
 {name:'Koforidua Market',category:'market',locality:'Central',city:'Koforidua',region:'Eastern',latitude:6.0945,longitude:-0.2598,popularity:82},
 {name:'Nkawkaw Commercial Center',category:'transit',locality:'Central',city:'Nkawkaw',region:'Eastern',latitude:6.5512,longitude:-0.7678,popularity:78},
 {name:'Akosombo Port / Dam',category:'landmark',locality:'Akosombo',city:'Akosombo',region:'Eastern',latitude:6.2994,longitude:0.0512,popularity:77},
 {name:'Sunyani Main Station',category:'transit',locality:'Central',city:'Sunyani',region:'Bono',latitude:7.3398,longitude:-2.3267,popularity:78},
 {name:'Berekum Market',category:'market',locality:'Central',city:'Berekum',region:'Bono',latitude:7.4533,longitude:-2.5842,popularity:75},
 {name:'Ho Central Market',category:'market',locality:'Central',city:'Ho',region:'Volta',latitude:6.6112,longitude:0.4715,popularity:76},
 {name:'Hohoe Central Market',category:'market',locality:'Central',city:'Hohoe',region:'Volta',latitude:7.1519,longitude:0.4736,popularity:74},
 {name:'Techiman Central Market',category:'market',locality:'Central',city:'Techiman',region:'Bono East',latitude:7.5855,longitude:-1.9395,popularity:84},
 {name:'Kintampo Waterfalls / Town',category:'landmark',locality:'Central',city:'Kintampo',region:'Bono East',latitude:8.0563,longitude:-1.7306,popularity:76},
 {name:'Atebubu Market',category:'market',locality:'Central',city:'Atebubu',region:'Bono East',latitude:7.7561,longitude:-0.9934,popularity:73},
 {name:'Goaso Central Market',category:'market',locality:'Central',city:'Goaso',region:'Ahafo',latitude:6.8042,longitude:-2.5186,popularity:75},
 {name:'Mim Town Center',category:'town',locality:'Central',city:'Mim',region:'Ahafo',latitude:6.9110,longitude:-2.5732,popularity:71},
 {name:'Kenyasi Commercial Center',category:'town',locality:'Central',city:'Kenyasi',region:'Ahafo',latitude:6.9892,longitude:-2.3887,popularity:72},
 {name:'Sefwi Wiawso Central',category:'town',locality:'Central',city:'Sefwi Wiawso',region:'Western North',latitude:6.2162,longitude:-2.4847,popularity:75},
 {name:'Bibiani Commercial Area',category:'town',locality:'Central',city:'Bibiani',region:'Western North',latitude:6.4635,longitude:-2.3321,popularity:74},
 {name:'Dambai Central / Lakeside',category:'market',locality:'Central',city:'Dambai',region:'Oti',latitude:8.0683,longitude:0.1794,popularity:75},
 {name:'Nkwanta Market',category:'market',locality:'Central',city:'Nkwanta',region:'Oti',latitude:8.2589,longitude:0.5204,popularity:72},
 {name:'Jasikan Town Center',category:'town',locality:'Central',city:'Jasikan',region:'Oti',latitude:7.4089,longitude:0.4686,popularity:71},
 {name:'Damongo Central',category:'town',locality:'Central',city:'Damongo',region:'Savannah',latitude:9.0833,longitude:-1.8167,popularity:75},
 {name:'Bole Main Station',category:'transit',locality:'Central',city:'Bole',region:'Savannah',latitude:9.0342,longitude:-2.4831,popularity:73},
 {name:'Salaga Market',category:'market',locality:'Central',city:'Salaga',region:'Savannah',latitude:8.5508,longitude:-0.5186,popularity:72},
 {name:'Nalerigu Town Center',category:'town',locality:'Central',city:'Nalerigu',region:'North East',latitude:10.5312,longitude:-0.3708,popularity:75},
 {name:'Walewale Market',category:'market',locality:'Central',city:'Walewale',region:'North East',latitude:10.3524,longitude:-0.8003,popularity:74},
 {name:'Gambaga Old Town',category:'landmark',locality:'Central',city:'Gambaga',region:'North East',latitude:10.5318,longitude:-0.4439,popularity:71},
 {name:'Bolgatanga Central Market',category:'market',locality:'Central',city:'Bolgatanga',region:'Upper East',latitude:10.7874,longitude:-0.8580,popularity:80},
 {name:'Navrongo Central Market',category:'market',locality:'Central',city:'Navrongo',region:'Upper East',latitude:10.8956,longitude:-1.0921,popularity:77},
 {name:'Bawku Central Market',category:'market',locality:'Central',city:'Bawku',region:'Upper East',latitude:11.0558,longitude:-0.2417,popularity:76},
 {name:'Wa Central Market',category:'market',locality:'Central',city:'Wa',region:'Upper West',latitude:10.0607,longitude:-2.5099,popularity:80},
 {name:'Lawra Town Center',category:'town',locality:'Central',city:'Lawra',region:'Upper West',latitude:10.6433,longitude:-2.8242,popularity:72}
];

export function ghanaSearch(query,{limit=10}={}){
 check(typeof query==='string',400,'Search query must be text');
 const clean=query.trim();
 if(!clean)return [];
 check(clean.length<=100,400,'Search query too long');

 // 1. Direct Coordinate parsing (e.g. "5.6212, -0.1748")
 const coordMatch=/^(-?\d{1,2}(?:\.\d+)?)[,\s]+(-?\d{1,3}(?:\.\d+)?)$/.exec(clean);
 if(coordMatch){
  const lat=Number(coordMatch[1]),lon=Number(coordMatch[2]);
  if(lat>=GHANA_BOUNDS.minLatitude&&lat<=GHANA_BOUNDS.maxLatitude&&lon>=GHANA_BOUNDS.minLongitude&&lon<=GHANA_BOUNDS.maxLongitude){
   return [{
    name:`Location (${lat.toFixed(5)}, ${lon.toFixed(5)})`,
    label:`Custom pin in Ghana`,
    latitude:lat,
    longitude:lon,
    type:'coordinate'
   }];
  }
 }

 // 2. Fuzzy Text Matching against Ghana gazetteer
 const terms=clean.toLowerCase().split(/\s+/).filter(Boolean);
 const scored=[];

 for(const place of GHANA_GAZETTEER){
  const text=`${place.name} ${place.locality} ${place.city} ${place.region}`.toLowerCase();
  let score=0;
  let allMatch=true;

  for(const term of terms){
   if(text.includes(term)){
    score+=term.length*2;
    if(place.name.toLowerCase().startsWith(term))score+=15;
    if(place.locality.toLowerCase().startsWith(term))score+=10;
   }else{
    allMatch=false;
    break;
   }
  }

  if(allMatch){
   score+=place.popularity*0.5;
   scored.push({place,score});
  }
 }

 scored.sort((a,b)=>b.score-a.score);
 return scored.slice(0,Math.max(1,Math.min(limit,20))).map(({place})=>({
  name:place.name,
  label:`${place.locality}, ${place.city}`,
  city:place.city,
  region:place.region,
  category:place.category,
  latitude:place.latitude,
  longitude:place.longitude,
  type:'place'
 }));
}

export function ghanaReverseGeocode(lat,lon){
 check(Number.isFinite(lat)&&lat>=GHANA_BOUNDS.minLatitude&&lat<=GHANA_BOUNDS.maxLatitude,400,'Latitude outside Ghana');
 check(Number.isFinite(lon)&&lon>=GHANA_BOUNDS.minLongitude&&lon<=GHANA_BOUNDS.maxLongitude,400,'Longitude outside Ghana');

 const target={latitude:lat,longitude:lon};
 let closest=null,minDist=Infinity;

 for(const place of GHANA_GAZETTEER){
  const d=haversine(target,place);
  if(d<minDist){
   minDist=d;
   closest=place;
  }
 }

 if(!closest)return {address:`Ghana (${lat.toFixed(5)}, ${lon.toFixed(5)})`,latitude:lat,longitude:lon};

 const distKm=minDist/1000;
 const distanceLabel=distKm<0.1?'At':distKm<1?`~${Math.round(minDist)}m from`:`~${distKm.toFixed(1)} km from`;
 const address=`${distanceLabel} ${closest.name}, ${closest.locality}, ${closest.city}`;

 return {
  address,
  nearestPlace:closest.name,
  locality:closest.locality,
  city:closest.city,
  region:closest.region,
  distanceMeters:Math.round(minDist),
  latitude:lat,
  longitude:lon
 };
}
