// Reports repeated code blocks, ignoring whitespace. Usage: node scripts/find-duplicates.mjs [minimum lines]
import {readFileSync,readdirSync,statSync} from 'node:fs';
import {join} from 'node:path';
const skip=/node_modules|\.git$|android|ghana-gazetteer|dist$|\.expo/;
const walk=d=>readdirSync(d).flatMap(n=>{const p=join(d,n);if(skip.test(p))return [];return statSync(p).isDirectory()?walk(p):/\.(mjs|js)$/.test(n)?[p]:[];});
export function findDuplicates(roots,min=8){
 const seen=new Map();
 for(const f of roots.flatMap(walk)){
  const lines=readFileSync(f,'utf8').split(/\r?\n/).map(l=>l.trim());
  const code=lines.map((text,line)=>({text,line:line+1})).filter(l=>l.text.length>3&&!/^(\/\/|\*|\/\*|[})\]];?,?$|<\/)/.test(l.text));
  for(let i=0;i+min<=code.length;i++){
   const key=code.slice(i,i+min).map(l=>l.text).join('\n');
   (seen.get(key)??seen.set(key,[]).get(key)).push({file:f,line:code[i].line});
  }
 }
 return [...seen.values()].filter(v=>v.length>1);
}
if(process.argv[1]?.endsWith('find-duplicates.mjs')){
 const min=Number(process.argv[2])||8;
 const dups=findDuplicates(['services','apps','scripts'],min);
 const pairs=new Map();
 for(const d of dups){const k=[...new Set(d.map(x=>x.file))].sort().join(' <> ');const p=pairs.get(k)??{n:0,first:d[0].line};p.n++;pairs.set(k,p);}
 for(const [k,p] of [...pairs].sort((a,b)=>b[1].n-a[1].n))console.log(String(p.n).padStart(5),k);
 console.log('total repeated windows',dups.length);
}
