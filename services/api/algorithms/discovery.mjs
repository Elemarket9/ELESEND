/** Algorithm 1 — bounded expanding geo-search orchestration.
 * Actual proximity lookup MUST be PostGIS ST_DWithin(geography,...) with GiST index.
 * Never construct SQL with request coordinates; the caller supplies a parameterized query.
 */
export async function discoverByRadii({radiiMeters,limit,queryRadius}){
 if(!Array.isArray(radiiMeters)||!radiiMeters.length||radiiMeters.length>10||
    radiiMeters.some((r,i)=>!Number.isSafeInteger(r)||r<=0||(i>0&&r<=radiiMeters[i-1]))||
    !Number.isSafeInteger(limit)||limit<1||limit>500||typeof queryRadius!=='function')throw Error('Invalid discovery configuration');
 const byId=new Map();let lastRadius=0;
 for(const radius of radiiMeters){
  lastRadius=radius;
  const rows=await queryRadius(radius,limit);
  if(!Array.isArray(rows)||rows.length>limit)throw Error('Geospatial query returned invalid candidate set');
  for(const row of rows){if(row&&typeof row.id==='string'&&row.id.length&& !byId.has(row.id))byId.set(row.id,row);}
  if(byId.size>=limit)break;
 }
 return {candidates:[...byId.values()].slice(0,limit),lastRadiusMeters:lastRadius};
}
