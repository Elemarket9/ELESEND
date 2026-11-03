import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
const htmlUrl=new URL('../../../apps/company-web/index.html',import.meta.url);
let cached=null;
export function renderCompanyPortalHtml(){
 cached??=readFileSync(htmlUrl,'utf8');
 return cached;
}
const digest=text=>`'sha256-${createHash('sha256').update(text).digest('base64')}'`;
/** This page has no inline event handlers, so only its own script and styles are allowed to run. */
export function companyPortalCsp(){
 const html=renderCompanyPortalHtml();
 const script=/<script>([\s\S]*)<\/script>/.exec(html)[1],style=/<style>([\s\S]*)<\/style>/.exec(html)[1];
 return `default-src 'none'; script-src ${digest(script)}; style-src ${digest(style)}; connect-src 'self'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`;
}
