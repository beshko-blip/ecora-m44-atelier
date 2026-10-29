const { chromium } = require('playwright');
const fs=require('fs');
(async()=>{
 const b=await chromium.launch(); const p=await b.newPage({viewport:{width:2400,height:2400}});
 for (const [src,out] of [['RGB_base ru.svg','logo_ru'],['RGB_base eng.svg','logo_en'],['RGB_logo mark.svg','mark']]) {
  const svg=fs.readFileSync('/home/user/ecora-m44-atelier/brand/'+src,'utf8');
  await p.setContent(`<html><body style="margin:0;background:transparent"><div id=w style="width:2400px">${svg}</div></body></html>`);
  await p.evaluate(()=>{const s=document.querySelector('svg'); s.setAttribute('width','2400'); s.removeAttribute('height');});
  const el=await p.$('svg'); await el.screenshot({path:out+'.png',omitBackground:true});
 }
 await b.close();
})();
