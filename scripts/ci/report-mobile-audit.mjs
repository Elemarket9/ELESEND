import {readFileSync} from 'node:fs';
const file=process.argv[2]||'mobile-dependency-audit.json';
try {
 const report=JSON.parse(readFileSync(file,'utf8'));
 const counts=report.metadata?.vulnerabilities??{};
 const items=Object.entries(report.vulnerabilities??{}).filter(([,v])=>['critical','high'].includes(v.severity));
 console.log('MOBILE_DEPENDENCY_AUDIT',JSON.stringify({counts,highCriticalPackages:items.length,error:report.error?.message??null}));
 for(const [name,v] of items){
  const advisories=(v.via??[]).filter(x=>x&&typeof x==='object').map(x=>({id:x.source,range:x.range,url:x.url,title:x.title})).slice(0,4);
  console.log('MOBILE_ADVISORY',JSON.stringify({name,severity:v.severity,range:v.range,fixAvailable:v.fixAvailable,advisories}));
 }
} catch(error){
 console.log('MOBILE_DEPENDENCY_AUDIT_UNAVAILABLE',String(error?.message??error));
}
