import {createServer} from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

function emptyGlyphsPbf(fontstack,start,end){
 const nameBuf=Buffer.from(fontstack),rangeBuf=Buffer.from(`${start}-${end}`);
 const stackInner=Buffer.concat([
  Buffer.from([0x0a,nameBuf.length]),nameBuf,
  Buffer.from([0x12,rangeBuf.length]),rangeBuf
 ]);
 return Buffer.concat([Buffer.from([0x0a,stackInner.length]),stackInner]);
}

export function tileServer(filename){
 const db=new DatabaseSync(filename,{readOnly:true});
 const tile=db.prepare('SELECT tile_data FROM tiles WHERE zoom_level=? AND tile_column=? AND tile_row=?');
 const metadata=Object.fromEntries(db.prepare('SELECT name,value FROM metadata').all().map(r=>[r.name,r.value]));
 if(metadata.format!=='pbf'){db.close();throw Error('Only vector PBF MBTiles supported');}
 const server=createServer({requestTimeout:10000,headersTimeout:8000,maxHeaderSize:8192},(req,res)=>{
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Content-Security-Policy',"default-src 'none'; frame-ancestors 'none'");
  if(!['GET','HEAD'].includes(req.method)){res.writeHead(405,{Allow:'GET, HEAD'}).end();return;}
  let path;try{path=decodeURIComponent(new URL(req.url,'http://localhost').pathname);}catch{res.writeHead(400).end();return;}
  if(path==='/health'){res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(req.method==='HEAD'?undefined:JSON.stringify({status:'alive',source:'OpenStreetMap',format:'pbf',maxzoom:metadata.maxzoom}));return;}
  const fontMatch=/^\/fonts\/([a-zA-Z0-9_, -]{1,100})\/(\d{1,5})-(\d{1,5})\.pbf$/.exec(path);
  if(fontMatch){
   const [fontstack,startStr,endStr]=fontMatch.slice(1);
   const start=Number(startStr),end=Number(endStr);
   if(start<0||end>65535||start>=end){res.writeHead(400).end();return;}
   const body=emptyGlyphsPbf(fontstack,start,end);
   res.writeHead(200,{'Content-Type':'application/x-protobuf','Cache-Control':'public,max-age=86400','Content-Length':body.length});
   res.end(req.method==='HEAD'?undefined:body);
   return;
  }
  const match=/^\/tiles\/(\d{1,2})\/(\d{1,6})\/(\d{1,6})\.pbf$/.exec(path);
  if(!match){res.writeHead(404).end();return;}
  const [z,x,y]=match.slice(1).map(Number);
  if(z>14||x>=2**z||y>=2**z){res.writeHead(400).end();return;}
  try{
   const row=tile.get(z,x,2**z-1-y);
   if(!row){res.writeHead(204,{'Cache-Control':'public,max-age=3600'}).end();return;}
   if(row.tile_data.length>4*1024*1024)throw Error('Tile too large');
   const body=Buffer.from(row.tile_data);
   const headers={'Content-Type':'application/vnd.mapbox-vector-tile','Cache-Control':'public,max-age=3600','Content-Length':body.length};
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
