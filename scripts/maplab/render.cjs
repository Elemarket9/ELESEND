const {chromium}=require('/tmp/lab/node_modules/playwright'),fs=require('fs');
(async()=>{const {privateMapStyle}=await import(process.env.ROOT+'/apps/mobile/src/maps/private-map-style.mjs');
const T='http://127.0.0.1:3145/tiles/{z}/{x}/{y}.pbf',G='http://127.0.0.1:3145/fonts/{fontstack}/{range}.pbf';
const js=fs.readFileSync('/tmp/lab/node_modules/maplibre-gl/dist/maplibre-gl.js'),css=fs.readFileSync('/tmp/lab/node_modules/maplibre-gl/dist/maplibre-gl.css');
const b=await chromium.launch({args:['--use-angle=swiftshader','--enable-webgl','--ignore-gpu-blocklist','--enable-unsafe-swiftshader']});
const views=[['ghana',7.9,-1.0,6.2],['accra',5.60,-0.19,11],['osu',5.556,-0.182,14],['osu-street',5.5565,-0.1825,16],['accra-mall',5.6221,-0.1735,15.5],['kumasi',6.69,-1.62,13],['makola',5.549,-0.2075,16],['osu-night',5.556,-0.182,14.5,1]];
for(const [n,lat,lon,z,night] of views){const p=await b.newPage({viewport:{width:420,height:760}});const errs=[];p.on('console',m=>{if(m.type()==='error')errs.push(m.text().slice(0,150));});p.on('pageerror',e=>errs.push(e.message.slice(0,150)));
 await p.route('http://lab.test/**',r=>r.fulfill({contentType:'text/html',body:`<!doctype html><style>${css}html,body,#m{margin:0;height:100%}</style><div id=m></div><script>${js}</script>`}));
 await p.goto('http://lab.test/');
 const s=privateMapStyle(T,{glyphsUrl:G,night:!!night});
 const t=Date.now();const ok=await p.evaluate(([s,lat,lon,z])=>new Promise(res=>{const m=new maplibregl.Map({container:'m',style:s,center:[lon,lat],zoom:z,attributionControl:false,canvasContextAttributes:{preserveDrawingBuffer:true},preserveDrawingBuffer:true});m.on('error',e=>console.error(String(e.error&&e.error.message||e)));m.on('idle',()=>res(true));setTimeout(()=>res(false),40000);}),[s,lat,lon,z]);
 await p.waitForTimeout(300);await p.screenshot({path:`/tmp/out/${n}.png`});console.log(n,ok?'idle':'timeout',Date.now()-t,'ms',errs.slice(0,3).join(' | '));await p.close();}
await b.close();})().catch(e=>console.log('render failed',e));
