import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';

test('WAL archive retries succeed only when existing copy matches source',()=>{
 const conf=readFileSync(new URL('../deploy/runtime/postgres.conf',import.meta.url),'utf8');
 const line=conf.split('\n').find(line=>/^archive_command\s*=/.test(line));
 assert.ok(line,'production WAL archiving must be configured');
 const command=line.match(/^archive_command\s*=\s*'(.*)'\s*$/)?.[1];
 assert.ok(command,'archive command must be a single SQL-quoted shell command');
 const dir=mkdtempSync(join(tmpdir(),'elesend-wal-archive-'));
 try{
  const source=join(dir,'source-wal');
  const archiveDir=join(dir,'archive');
  writeFileSync(source,'wal-segment-one');
  const run=()=>spawnSync('sh',['-c',command.replaceAll('/var/lib/postgresql/wal-archive',archiveDir).replaceAll('%p',source).replaceAll('%f','000000010000000000000001')],{encoding:'utf8'});
  assert.equal(run().status,0,'first archive must succeed');
  assert.equal(run().status,0,'repeated identical WAL after crash must succeed');
  writeFileSync(join(archiveDir,'000000010000000000000001'),'different WAL');
  assert.notEqual(run().status,0,'conflicting existing WAL must not be overwritten');
 }finally{rmSync(dir,{recursive:true,force:true});}
});
