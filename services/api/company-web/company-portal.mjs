import {readFileSync} from 'node:fs';
const htmlUrl=new URL('../../../apps/company-web/index.html',import.meta.url);
let cached=null;
export function renderCompanyPortalHtml(){
 cached??=readFileSync(htmlUrl,'utf8');
 return cached;
}
