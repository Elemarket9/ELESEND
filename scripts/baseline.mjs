import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,existsSync,mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
const root=resolve(import.meta.dirname,'..');
const file=resolve(import.meta.dirname,'../documentation/source-baseline.json');
const hash=b=>createHash('sha256').update(b).digest('hex');
const paths=execFileSync('git',['ls-files','-z'],{cwd:root}).toString().split('\0').filter(Boolean).filter(p=>!/^Elesend\//i.test(p)).filter(p=>existsSync(resolve(root,p)));
const files=Object.fromEntries(paths.map(p=>[p,hash(readFileSync(resolve(root,p)))]));
if(existsSync(file)) {
 const previous=JSON.parse(readFileSync(file));
 const changed=Object.keys(previous.files).filter(p=>previous.files[p]!==files[p]);
 if(changed.length)throw Error(`Original files changed: ${changed.join(', ')}`);
 console.log(`PASS: ${Object.keys(previous.files).length} original source files unchanged`);
} else {
 mkdirSync(resolve(file,'..'),{recursive:true});
 writeFileSync(file,JSON.stringify({version:JSON.parse(readFileSync(resolve(root,'package.json'))).version,commit:execFileSync('git',['rev-parse','HEAD'],{cwd:root}).toString().trim(),kind:'supplied working tree; latest archive provenance unconfirmed',manifestSha256:hash(JSON.stringify(files)),files},null,2));
 console.log(`Recorded ${paths.length} source hashes`);
}
