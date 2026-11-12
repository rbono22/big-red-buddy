// Canonical public event links only. Never retain subscription or tracking tokens.
export function partifulRSVP(value){
  const text=typeof value==='string'?value.slice(0,16000).replace(/&amp;/gi,'&').replace(/&#(?:x26|38);/gi,'&'):'';
  for(const match of text.matchAll(/https:\/\/[^\s"'<>]+/gi)){
    try{const url=new URL(match[0].replace(/[),.;!?]+$/,''));if(url.protocol==='https:'&&url.hostname==='partiful.com'&&!url.username&&!url.password&&!url.port&&/^\/e\/[A-Za-z0-9_-]{1,160}\/?$/.test(url.pathname))return `https://partiful.com${url.pathname.replace(/\/$/,'')}`;}catch{}
  }
  return '';
}

export function lumaRSVP(value){
  const text=typeof value==='string'?value.slice(0,16000).replace(/&amp;/gi,'&').replace(/&#(?:x26|38);/gi,'&'):'';
  for(const match of text.matchAll(/https:\/\/[^\s"'<>]+/gi)){
    try{
      const url=new URL(match[0].replace(/[),.;!?]+$/,'')),slug=url.pathname.replace(/^\//,'').replace(/\/$/,'');
      if(url.protocol==='https:'&&['luma.com','lu.ma'].includes(url.hostname)&&!url.username&&!url.password&&!url.port&&/^\/[A-Za-z0-9_-]{1,160}\/?$/.test(url.pathname)&&!RESERVED_ROUTES.has(slug.toLowerCase()))return `https://${url.hostname}/${slug}`;
    }catch{}
  }
  return '';
}
const RESERVED_ROUTES=new Set(['api','ical','ics','calendar','calendars','event','events','settings','login','signin','sign-in','signup','sign-up','register','logout','auth','oauth','account','accounts','profile','profiles','user','users','home','discover','explore','create','new','admin','dashboard','manage','help','support','privacy','privacy-policy','terms','terms-of-service','pricing','about','contact','blog','docs','download','downloads','feed','feeds','private','subscribe','subscription','subscriptions','sitemap','robots','assets','static','cdn','invite','invites','invitation','invitations','ticket','tickets','checkout','payment','payments','unsubscribe','notifications','onboarding','welcome','embed','community','communities','city','cities','sf','nyc','new-york','san-francisco','la','london','berlin','paris','boston','seattle','toronto','singapore','tokyo','austin','miami','dubai','hong-kong']);
