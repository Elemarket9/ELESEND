import {createServer} from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

function encodeVarint(value){
 let v=value>>>0;
 const bytes=[];
 while(v>0x7f){bytes.push((v&0x7f)|0x80);v>>>=7;}
 bytes.push(v);
 return Buffer.from(bytes);
}

function encodeSint32(value){
 const zigzag=(value<<1)^(value>>31);
 return encodeVarint(zigzag>>>0);
}

function encodeFieldBytes(fieldNum,buf){
 const tag=(fieldNum<<3)|2;
 return Buffer.concat([encodeVarint(tag),encodeVarint(buf.length),buf]);
}

function encodeFieldVarint(fieldNum,val){
 const tag=(fieldNum<<3)|0;
 return Buffer.concat([encodeVarint(tag),encodeVarint(val)]);
}

function encodeFieldSint32(fieldNum,val){
 const tag=(fieldNum<<3)|0;
 return Buffer.concat([encodeVarint(tag),encodeSint32(val)]);
}

// Compact 5x7 bitmap font definitions for printable ASCII (32..126), scaled 2x to 10x14 + 3px SDF border -> 16x20 SDF
const FONT_5X7={
 32:[0,0,0,0,0,0,0],
 33:[4,4,4,4,4,0,4],
 34:[10,10,4,0,0,0,0],
 35:[10,31,10,10,31,10,0],
 36:[4,15,20,14,5,30,4],
 37:[25,25,2,4,8,19,19],
 38:[12,18,20,8,21,18,13],
 39:[4,4,8,0,0,0,0],
 40:[2,4,8,8,8,4,2],
 41:[8,4,2,2,2,4,8],
 42:[0,4,21,14,21,4,0],
 43:[0,4,4,31,4,4,0],
 44:[0,0,0,0,4,4,8],
 45:[0,0,0,31,0,0,0],
 46:[0,0,0,0,0,4,4],
 47:[1,1,2,4,8,16,16],
 48:[14,17,19,21,25,17,14],
 49:[4,12,4,4,4,4,14],
 50:[14,17,1,6,8,16,31],
 51:[31,2,4,6,1,17,14],
 52:[2,6,10,18,31,2,2],
 53:[31,16,30,1,1,17,14],
 54:[6,8,16,30,17,17,14],
 55:[31,1,2,4,8,8,8],
 56:[14,17,17,14,17,17,14],
 57:[14,17,17,15,1,2,12],
 58:[0,4,4,0,4,4,0],
 59:[0,4,4,0,4,4,8],
 60:[2,4,8,16,8,4,2],
 61:[0,0,31,0,31,0,0],
 62:[8,4,2,1,2,4,8],
 63:[14,17,1,2,4,0,4],
 64:[14,17,23,21,23,16,14],
 65:[14,17,17,31,17,17,17],
 66:[30,17,17,30,17,17,30],
 67:[14,17,16,16,16,17,14],
 68:[28,18,17,17,17,18,28],
 69:[31,16,16,30,16,16,31],
 70:[31,16,16,30,16,16,16],
 71:[14,17,16,23,17,17,15],
 72:[17,17,17,31,17,17,17],
 73:[14,4,4,4,4,4,14],
 74:[7,2,2,2,2,18,12],
 75:[17,18,20,24,20,18,17],
 76:[16,16,16,16,16,16,31],
 77:[17,27,21,21,17,17,17],
 78:[17,25,21,19,17,17,17],
 79:[14,17,17,17,17,17,14],
 80:[30,17,17,30,16,16,16],
 81:[14,17,17,17,21,18,13],
 82:[30,17,17,30,20,18,17],
 83:[15,16,16,14,1,1,30],
 84:[31,4,4,4,4,4,4],
 85:[17,17,17,17,17,17,14],
 86:[17,17,17,17,17,10,4],
 87:[17,17,17,21,21,27,17],
 88:[17,17,10,4,10,17,17],
 89:[17,17,10,4,4,4,4],
 90:[31,1,2,4,8,16,31]
};

function getPatternRows(charCode){
 if(FONT_5X7[charCode])return FONT_5X7[charCode];
 if(charCode>=97&&charCode<=122)return FONT_5X7[charCode-32];
 return [14,17,17,17,17,17,14];
}

const sdfBitmapCache=new Map();

function buildSdfBitmap(charCode){
 if(sdfBitmapCache.has(charCode))return sdfBitmapCache.get(charCode);
 const rows=getPatternRows(charCode);
 const glyphW=10,glyphH=14,pad=3;
 const totalW=glyphW+pad*2,totalH=glyphH+pad*2;
 const inside=[];
 for(let y=0;y<totalH;y++){
  for(let x=0;x<totalW;x++){
   const gx=Math.floor((x-pad)/2),gy=Math.floor((y-pad)/2);
   const on=gx>=0&&gx<5&&gy>=0&&gy<7&&(((rows[gy]>>(4-gx))&1)===1);
   if(on)inside.push([x,y]);
  }
 }
 const buf=Buffer.alloc(totalW*totalH);
 for(let y=0;y<totalH;y++){
  for(let x=0;x<totalW;x++){
   const gx=Math.floor((x-pad)/2),gy=Math.floor((y-pad)/2);
   const on=gx>=0&&gx<5&&gy>=0&&gy<7&&(((rows[gy]>>(4-gx))&1)===1);
   if(inside.length===0){
    buf[y*totalW+x]=0;
    continue;
   }
   let minDistSq=9999;
   for(let sy=0;sy<totalH;sy++){
    for(let sx=0;sx<totalW;sx++){
     const sgx=Math.floor((sx-pad)/2),sgy=Math.floor((sy-pad)/2);
     const son=sgx>=0&&sgx<5&&sgy>=0&&sgy<7&&(((rows[sgy]>>(4-sgx))&1)===1);
     if(son!==on){
      const d=(sx-x)*(sx-x)+(sy-y)*(sy-y);
      if(d<minDistSq)minDistSq=d;
     }
    }
   }
   const dist=Math.sqrt(minDistSq);
   // MapLibre SDF convention: 192 (0.75 * 256) is the glyph edge; >192 is inside, <192 is outside
   const signed=on?(192+Math.min(63,Math.round(dist*18))):(192-Math.min(192,Math.round(dist*24)));
   buf[y*totalW+x]=Math.max(0,Math.min(255,signed));
  }
 }
 sdfBitmapCache.set(charCode,buf);
 return buf;
}

function encodeGlyphMessage(id){
 if(id===32){
  // Space glyph: no bitmap needed, width=0, height=0, left=0, top=0, advance=8
  return Buffer.concat([
   encodeFieldVarint(1,32),
   encodeFieldVarint(3,0),
   encodeFieldVarint(4,0),
   encodeFieldSint32(5,0),
   encodeFieldSint32(6,0),
   encodeFieldVarint(7,8)
  ]);
 }
 const bmp=buildSdfBitmap(id);
 return Buffer.concat([
  encodeFieldVarint(1,id),
  encodeFieldBytes(2,bmp),
  encodeFieldVarint(3,10), // glyph width (excluding 3px SDF buffer on each side -> 10 + 6 = 16)
  encodeFieldVarint(4,14), // glyph height (excluding 3px SDF buffer on each side -> 14 + 6 = 20)
  encodeFieldSint32(5,1),  // left bearing
  encodeFieldSint32(6,12), // top bearing
  encodeFieldVarint(7,12)  // horizontal advance
 ]);
}

const rangePbfCache=new Map();

export function generateGlyphsPbf(fontstack,start,end){
 const cacheKey=`${fontstack}:${start}-${end}`;
 if(rangePbfCache.has(cacheKey))return rangePbfCache.get(cacheKey);
 const glyphFields=[];
 if(start<=255){
  const from=Math.max(32,start),to=Math.min(255,end);
  for(let cp=from;cp<=to;cp++){
   if(cp>=127&&cp<160)continue;
   glyphFields.push(encodeFieldBytes(3,encodeGlyphMessage(cp)));
  }
 }else if(start<=8192&&end>=8192){
  // Punctuation range (e.g. bullets • / dashes —)
  for(const cp of [8211,8212,8226]){
   if(cp>=start&&cp<=end)glyphFields.push(encodeFieldBytes(3,encodeGlyphMessage(cp)));
  }
 }
 const stackInner=Buffer.concat([
  encodeFieldBytes(1,Buffer.from(fontstack,'utf8')),
  encodeFieldBytes(2,Buffer.from(`${start}-${end}`,'utf8')),
  ...glyphFields
 ]);
 const pbf=encodeFieldBytes(1,stackInner);
 if(rangePbfCache.size<256)rangePbfCache.set(cacheKey,pbf);
 return pbf;
}

export function tileServer(filename){
 const db=new DatabaseSync(filename,{readOnly:true});
 const tile=db.prepare('SELECT tile_data FROM tiles WHERE zoom_level=? AND tile_column=? AND tile_row=?');
 const metadata=Object.fromEntries(db.prepare('SELECT name,value FROM metadata').all().map(r=>[r.name,r.value]));
 if(metadata.format!=='pbf'){db.close();throw Error('Only vector PBF MBTiles supported');}
 const server=createServer({requestTimeout:10000,headersTimeout:8000,maxHeaderSize:8192},(req,res)=>{
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type, Range, If-None-Match');
  if(req.method==='OPTIONS'){res.writeHead(204).end();return;}
  if(!['GET','HEAD'].includes(req.method)){res.writeHead(405,{Allow:'GET, HEAD, OPTIONS'}).end();return;}
  let path;try{path=decodeURIComponent(new URL(req.url,'http://localhost').pathname);}catch{res.writeHead(400).end();return;}
  if(path==='/health'){res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(req.method==='HEAD'?undefined:JSON.stringify({status:'alive',source:'OpenStreetMap',format:'pbf',maxzoom:metadata.maxzoom}));return;}
  const fontMatch=/^\/fonts\/([a-zA-Z0-9_, -]{1,100})\/(\d{1,5})-(\d{1,5})\.pbf$/.exec(path);
  if(fontMatch){
   const [fontstack,startStr,endStr]=fontMatch.slice(1);
   const start=Number(startStr),end=Number(endStr);
   if(start<0||end>65535||start>=end||end-start>256){res.writeHead(400).end();return;}
   const etag=`"font-sdf-v2-${fontstack}-${start}-${end}"`;
   if(req.headers['if-none-match']===etag){
     res.writeHead(304,{'ETag':etag,'Cache-Control':'public,max-age=2592000,immutable'}).end();
     return;
   }
   const body=generateGlyphsPbf(fontstack,start,end);
   res.writeHead(200,{'Content-Type':'application/x-protobuf','Cache-Control':'public,max-age=2592000,immutable','ETag':etag,'Content-Length':body.length});
   res.end(req.method==='HEAD'?undefined:body);
   return;
  }
  const match=/^\/tiles\/(\d{1,2})\/(\d{1,6})\/(\d{1,6})\.pbf$/.exec(path);
  if(!match){res.writeHead(404).end();return;}
  const [z,x,y]=match.slice(1).map(Number);
  if(z>14||x>=2**z||y>=2**z){res.writeHead(400).end();return;}
  try{
   const row=tile.get(z,x,2**z-1-y);
   if(!row){res.writeHead(204,{'Cache-Control':'public,max-age=86400'}).end();return;}
   if(row.tile_data.length>4*1024*1024)throw Error('Tile too large');
   const etag=`"${metadata.version||'ghana-v1'}-${z}-${x}-${y}-${row.tile_data.length}"`;
   if(req.headers['if-none-match']===etag){
     res.writeHead(304,{'ETag':etag,'Cache-Control':'public,max-age=604800,stale-while-revalidate=86400'}).end();
     return;
   }
   const body=Buffer.from(row.tile_data);
   const headers={
     'Content-Type':'application/vnd.mapbox-vector-tile',
     'Cache-Control':'public,max-age=604800,stale-while-revalidate=86400',
     'ETag':etag,
     'Content-Length':body.length
   };
   if(body[0]===0x1f&&body[1]===0x8b)headers['Content-Encoding']='gzip';
   res.writeHead(200,headers);res.end(req.method==='HEAD'?undefined:body);
  }catch{res.writeHead(503).end();}
 });
 server.on('close',()=>db.close());return server;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 if(!process.env.GHANA_MBTILES)throw Error('GHANA_MBTILES must name your generated ghana.mbtiles');
 const host=process.env.MAP_HOST??'127.0.0.1',port=Number(process.env.MAP_PORT??3145);
 if(!Number.isInteger(port)||port<1||port>65535)throw Error('Invalid map port');
 const server=tileServer(process.env.GHANA_MBTILES);server.listen(port,host,()=>console.log(`Private Ghana vector tiles listening on ${host}:${port}`));
 for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>server.close());
}
