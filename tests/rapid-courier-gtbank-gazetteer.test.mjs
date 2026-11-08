import test from 'node:test';
import assert from 'node:assert/strict';
import {GHANA_GAZETTEER} from '../services/api/infrastructure/maps/ghana-geocoder.mjs';

// Audit source: ELESEND's own private, bundled Ghana gazetteer.
// Search output is evidence of candidates only; it must never be used as proof
// of a business doorstep without selecting and confirming the exact pin.
const QUERIES=[
  {label:'RAPID Courier near Accra Airport',tokens:['rapid','courier']},
  {label:'GTBank Kasoa',tokens:['gtbank','kasoa']},
  {label:'Guaranty Trust Bank Kasoa',tokens:['guaranty','kasoa']}
];
test('ELESEND private gazetteer: airport courier to GTBank Kasoa candidate lookup',()=>{
  const diagnostics=[];
  for(const query of QUERIES){
    const rows=GHANA_GAZETTEER.filter(p=>{
      const name=String(p.name||'').toLowerCase();
      const locality=String([p.locality,p.city,p.region,p.aliases?.join(' ')].join(' ')).toLowerCase();
      return query.tokens.every(token=>(name+' '+locality).includes(token));
    });
    const candidates=rows.slice(0,10).map(p=>({
      name:p.name,locality:p.locality,city:p.city,region:p.region,
      lat:p.latitude,lon:p.longitude,coordinateKind:p.coordinate_kind||null,
      verificationStatus:p.verification_status||null
    }));
    diagnostics.push({query:query.label,candidates:rows.length,examples:candidates});
  }
  console.log('ELESEND_PRIVATE_GAZETTEER_LOOKUP '+JSON.stringify({
    searchedRecords:GHANA_GAZETTEER.length,diagnostics,
    exactDoorstepCoordinatesVerified:false,
    livePrivateOsrmConnected:false
  }));
  assert.ok(GHANA_GAZETTEER.length>100,'ELESEND gazetteer unexpectedly empty');
});
