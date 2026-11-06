import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {extname} from 'node:path';

test('report exact tracked ELESEND source line counts',()=>{
 const sourceExt=new Set(['.js','.mjs','.cjs','.ts','.tsx','.jsx','.kt','.lua','.html']);
 const sqlExt=new Set(['.sql']);
 const ancillaryExt=new Set(['.sh','.ps1','.bat','.gradle','.xml']);
 const files=execFileSync('git',['ls-files','-z']).toString('utf8').split('\0').filter(Boolean);
 const summary={commit:execFileSync('git',['rev-parse','HEAD']).toString().trim(),trackedFiles:files.length,
  application:{files:0,lines:0,nonblank:0},tests:{files:0,lines:0,nonblank:0},
  sql:{files:0,lines:0,nonblank:0},ancillary:{files:0,lines:0,nonblank:0},
  sourceTotal:{files:0,lines:0,nonblank:0},sourceAndSql:{files:0,lines:0,nonblank:0},
  allCodeAndConfig:{files:0,lines:0,nonblank:0}};
 const add=(k,lines,nonblank)=>{summary[k].files++;summary[k].lines+=lines;summary[k].nonblank+=nonblank;};
 for(const path of files){
  const ext=extname(path).toLowerCase();
  if(!sourceExt.has(ext)&&!sqlExt.has(ext)&&!ancillaryExt.has(ext))continue;
  const s=readFileSync(path,'utf8');const lines=s===''?[]:s.replace(/\r\n/g,'\n').split('\n');
  if(lines.at(-1)==='')lines.pop();
  const count=lines.length,nonblank=lines.filter(x=>x.trim()).length;
  if(sourceExt.has(ext)){
   if(path.startsWith('tests/')||/\.(test|spec)\.[mc]?[jt]sx?$/.test(path))add('tests',count,nonblank);
   else add('application',count,nonblank);
   add('sourceTotal',count,nonblank);
   add('sourceAndSql',count,nonblank);
  }else if(sqlExt.has(ext)){add('sql',count,nonblank);add('sourceAndSql',count,nonblank);}
  else add('ancillary',count,nonblank);
  add('allCodeAndConfig',count,nonblank);
 }
 assert.ok(summary.application.lines>0);
 console.log('ELESEND_LOC_REPORT='+JSON.stringify(summary));
});
