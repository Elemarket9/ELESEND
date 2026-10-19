'use strict';
// Metro 0.83.3 still passes a filename to image-size in getAssetData.
// image-size 2 fixes image-parser advisories but requires a Buffer. Apply only
// this audited compatibility edit, before Metro creates transform workers.
const fs=require('node:fs');
const path=require('node:path');
const {createRequire}=require('node:module');
module.exports=function patchMobileMetro(){
 const requireMobile=createRequire(path.resolve(__dirname,'../apps/mobile/package.json'));
 const root=path.dirname(requireMobile.resolve('metro/package.json'));
 const version=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).version;
 if(version!=='0.83.3')throw Error('Reassess the Metro image-size compatibility patch for '+version);
 const file=path.join(root,'src/Assets.js'),source=fs.readFileSync(file,'utf8');
 const before=': assetInfo.files[0];';
 const after=': _fs.default.readFileSync(assetInfo.files[0]);';
 if(source.includes(after))return;
 if(source.split(before).length!==2)throw Error('Unexpected Metro Assets source; refusing an unreviewed patch');
 fs.writeFileSync(file,source.replace(before,after));
};
