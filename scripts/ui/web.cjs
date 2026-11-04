const {chromium}=require('playwright'),fs=require('fs');const R=process.env.ROOT;
const pages={restaurant:{file:R+'/apps/restaurant-web/index.html',token:'elesend_merchant_token'},company:{file:R+'/apps/company-web/index.html',token:'elesend_company_token'},admin:{file:'/tmp/ui/admin.html'}};
const me={id:'m',kind:'company',phone:'+233241234567',phoneVerified:true};
const api={'/api/v1/me':me,'/api/v1/me/phone':{phone:'+233241234567',verified:true},'/api/v1/company/profile':{id:'c1',name:'Volta Logistics',status:'active',services:['parcel','cargo']},'/api/v1/restaurants/mine':{restaurants:[{id:'r1',name:'Auntie Ama Chop Bar',address:'Osu, Accra',status:'approved'}]}};
(async()=>{const b=await chromium.launch();
 for(const [name,p] of Object.entries(pages))for(const [vp,w,h] of [['phone',360,740],['desk',1280,800]])for(const signed of p.token?[0,1]:[0]){
  const c=await b.newContext({viewport:{width:w,height:h}});const pg=await c.newPage();const errs=[];pg.on('pageerror',e=>errs.push(e.message.slice(0,120)));
  await pg.route('**/*',r=>{const u=new URL(r.request().url());if(u.pathname==='/')return r.fulfill({contentType:'text/html',body:fs.readFileSync(p.file)});
   if(api[u.pathname])return r.fulfill({json:api[u.pathname]});if(u.pathname.startsWith('/api/'))return signed?r.fulfill({json:u.pathname.endsWith('s')?[]:{}}):r.fulfill({status:401,json:{error:'Sign in'}});return r.abort();});
  if(signed)await pg.addInitScript(k=>localStorage.setItem(k,'x'),p.token);
  await pg.goto('http://ui.test/');await pg.waitForTimeout(800);
  const over=await pg.evaluate(()=>{const W=innerWidth;const bad=[...document.querySelectorAll('body *')].filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.right>W+1&&getComputedStyle(e).position!=='fixed'&&!e.closest('pre,table,[style*=overflow]')}).slice(0,5).map(e=>e.tagName+'.'+e.className);return{sw:document.documentElement.scrollWidth,W,bad,small:[...document.querySelectorAll('button,input,select,a')].filter(e=>{const r=e.getBoundingClientRect();return r.height>0&&r.height<36}).length};});
  console.log(name,vp,signed?'in':'out',JSON.stringify(over),errs.slice(0,2).join('|'));
  await pg.screenshot({path:`/tmp/screens/web-${name}-${vp}-${signed?'in':'out'}.png`});await c.close();}
 await b.close();})();
