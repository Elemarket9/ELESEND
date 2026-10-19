import pg from 'pg';
import {readdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
const base=process.env.TEST_DATABASE_URL;
if(!base||!/^elesend_test(?:_|$)/.test(new URL(base).pathname.slice(1)))throw Error('Dedicated elesend_test* database URL required');
const control=new pg.Pool({connectionString:base,max:1}),run=randomBytes(5).toString('hex');
const selected=process.argv[2];
const files=(await readdir(new URL('../tests/',import.meta.url))).filter(n=>n.endsWith('.test.mjs')&&(!selected||n===selected)).sort();
if(!files.length)throw Error('No matching test files');
const summary={files:0,passed:0,failed:0,skipped:0,databases:0,failedFiles:[]};
try{for(const [index,file] of files.entries()){
 const database=file.includes('-db')||file==='platform.test.mjs';let name;
 const env={...process.env};
 if(database){name=`elesend_test_isolated_${run}_${index}`;await control.query(`CREATE DATABASE "${name}"`);const url=new URL(base);url.pathname='/'+name;env.TEST_DATABASE_URL=url.toString();summary.databases++;}
 try{
  console.log('TEST_FILE '+file);
  const result=spawnSync(process.execPath,['--test','--test-reporter=spec','--test-concurrency=1','--test-timeout=120000','tests/'+file],{cwd:new URL('../',import.meta.url),env,encoding:'utf8',windowsHide:true,timeout:180000,maxBuffer:16*1024*1024});
  process.stdout.write(result.stdout??'');process.stderr.write(result.stderr??'');summary.files++;
  for(const [label,key] of [['pass','passed'],['fail','failed'],['skipped','skipped']])summary[key]+=Number(result.stdout?.match(new RegExp('ℹ '+label+' (\\d+)'))?.[1]??0);
  if(result.status!==0){summary.failedFiles.push(file);if(!result.stdout?.match(/ℹ fail [1-9]/))summary.failed++;}
 }finally{if(name)await control.query(`DROP DATABASE "${name}" WITH (FORCE)`);}
}}finally{await control.end();}
console.log('ISOLATED_TEST_SUMMARY '+JSON.stringify(summary));if(summary.failedFiles.length||summary.failed)process.exitCode=1;
