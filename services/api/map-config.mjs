/** Tells the apps where the map lives, so moving it never needs a new app release. */
export function publicMapConfig(env=process.env){
 const origin=(env.MAPS_PUBLIC_ORIGIN||'').trim().replace(/\/$/,'');
 if(!/^https?:\/\/[^/\s]+$/i.test(origin))return {tileUrl:null,glyphsUrl:null};
 return {tileUrl:`${origin}/tiles/{z}/{x}/{y}.pbf`,glyphsUrl:`${origin}/fonts/{fontstack}/{range}.pbf`};
}
