// Fails if a live credential is committed. Usage: node scripts/secret-scan.mjs
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
const PATTERNS=[
 ['Paystack live key',/\b[sp]k_live_[0-9a-zA-Z]{20,}/],
 ['ELESEND API key',/\bes_live_[a-f0-9]{64}\b/],
 ['ELESEND webhook secret',/\bwhsec_[a-f0-9]{64}\b/],
 ['Private key',/-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/],
 ['AWS key',/\bAKIA[0-9A-Z]{16}\b/],
 ['GitHub token',/\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
 ['Google API key',/\bAIza[0-9A-Za-z_-]{35}\b/],
 ['Database password in a URL',/postgres(?:ql)?:\/\/[^:\s/$'"`{]+:(?!test-only|password|PASSWORD|secret|change|example|\$|<|x+@)[^@\s'"`{$]{8,}@(?!localhost|127\.0\.0\.1|db[:/])/]
];
export function findSecrets(files=execFileSync('git',['ls-files'],{encoding:'utf8'}).split('\n').filter(Boolean)){
 const found=[];
 for(const file of files){
  if(/(^|\/)(package-lock\.json|.*\.(png|jpg|jpeg|gif|webp|ico|pdf|zip|gz|pbf|mbtiles|ttf|otf|woff2?))$/.test(file))continue;
  let text;
  try{text=readFileSync(file,'utf8');}catch{continue;}
  if(text.length>5000000)continue;
  for(const [name,pattern] of PATTERNS)if(pattern.test(text))found.push({file,name});
 }
 return found;
}
if(process.argv[1]?.endsWith('secret-scan.mjs')){
 const found=findSecrets();
 for(const f of found)console.error(`${f.file}: ${f.name}`);
 console.log(found.length?`${found.length} possible secrets`:'No secrets found');
 process.exit(found.length?1:0);
}
