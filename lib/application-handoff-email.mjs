// Emails the student their own browser-handoff link so they can open it on a laptop.
// The link is a BRB page (/#application-handoff/<id>) that requires BRB sign-in and
// carries no token, so it is safe in an email. Delivery reuses the Gmail send grant
// from Daily email, which only ever sends to the grant owner's own Cornell address.
const BUCKET='applicationHandoffEmails',RESEND_MS=2*60*1000;
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const clean=(value,max)=>String(value??'').replace(/[\u0000-\u001f\u007f]+/g,' ').replace(/\s+/g,' ').trim().slice(0,max);
const time=now=>typeof now==='function'?now():now;

export function handoffEmailMessage(application,url){
 const company=clean(application.company,80)||'the employer',title=clean(application.title,120)||'your application';
 const subject=clean(`Finish your ${company} application in Chrome`,170);
 const steps=['Open this link in desktop Chrome on your laptop.','Sign in to Big Red Buddy if asked.','Click the B helper icon, then “Open and fill application”.','Check the filled form and submit it on the employer page.'];
 const text=[`${title} at ${company}`,'',`BRB couldn’t finish this application automatically. Your saved answers are ready to fill in your browser.`,'',url,'',...steps.map((s,i)=>`${i+1}. ${s}`),'','The helper fills fields; you submit on the employer page. This link works only when you are signed in to BRB.'].join('\n');
 const html=`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="color-scheme" content="light"><title>${esc(subject)}</title></head><body style="margin:0;padding:24px;background:#f7f7f7;font-family:Arial,Helvetica,sans-serif;color:#222"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #dedede;border-radius:10px"><tr><td style="padding:24px 28px;border-top:5px solid #b31b1b"><p style="margin:0 0 6px;font-size:13px;color:#626262">BIG RED BUDDY · APPLICATION HANDOFF</p><h1 style="margin:0 0 12px;font-size:20px;line-height:1.3">${esc(title)} at ${esc(company)}</h1><p style="margin:0 0 18px;font-size:15px;line-height:1.6">BRB couldn’t finish this application automatically. Your saved answers are ready to fill in your browser.</p><p style="margin:0 0 20px"><a href="${esc(url)}" style="display:inline-block;background:#b31b1b;color:#fff;text-decoration:none;font-weight:700;padding:12px 18px;border-radius:7px">Open &amp; fill in Chrome</a></p><ol style="margin:0 0 16px;padding-left:20px;font-size:14px;line-height:1.7">${steps.map(s=>`<li>${esc(s)}</li>`).join('')}</ol><p style="margin:0;font-size:12px;color:#626262">The helper fills fields; you submit on the employer page. This link works only when you are signed in to BRB.<br>${esc(url)}</p></td></tr></table></body></html>`;
 return {subject,text,html};
}

/**
 * reason 'automatic': at most once per application revision.
 * reason 'requested': at most once every two minutes.
 * Returns {sent:true} or {sent:false, reason}. Never throws for delivery problems.
 */
export async function emailApplicationHandoff(store,application,{reason='requested',now=Date.now,origin=process.env.APP_ORIGIN,send}={}){
 if(!application?.id||!/^[A-Za-z0-9:_-]{1,160}$/.test(application.id))return {sent:false,reason:'invalid-application'};
 if(typeof origin!=='string'||!/^https?:\/\/[^/\s]+$/.test(origin))return {sent:false,reason:'no-app-origin'};
 const grant=await store.get('secrets','dailyEmailGoogle');
 if(!grant?.connectionRevision||grant.disconnectedAt||!(grant.access_token||grant.refresh_token))return {sent:false,reason:'gmail-not-connected'};
 const at=time(now),previous=await store.get(BUCKET,application.id);
 if(previous&&reason==='automatic'&&previous.revision===application.revision)return {sent:false,reason:'already-sent'};
 if(previous&&at-Date.parse(previous.sentAt)<RESEND_MS)return {sent:false,reason:'recently-sent'};
 const url=`${origin}/#application-handoff/${application.id}`,message=handoffEmailMessage(application,url);
 const transport=send||(await import('./daily-email.mjs')).sendGmailDailyEmail;
 let result;
 try{result=await transport(store,message,{expectedConnectionRevision:grant.connectionRevision,deliveryId:`handoff:${application.id}:${application.revision}:${at}`,now});}
 catch{return {sent:false,reason:'delivery-uncertain'};}
 if(!result?.accepted)return {sent:false,reason:result?.reason||'gmail-rejected'};
 await store.put(BUCKET,application.id,{id:application.id,revision:application.revision,sentAt:new Date(at).toISOString(),reason});
 return {sent:true};
}
