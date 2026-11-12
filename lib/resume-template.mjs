import {readFileSync} from 'node:fs';

const reference=JSON.parse(readFileSync(new URL('../resources/jct-mba-resume-template.json',import.meta.url),'utf8'));
const clean=(value,max=700)=>String(value||'').replace(/[\u0000-\u001f\u007f]/g,' ').replace(/\s+/g,' ').trim().slice(0,max);
const inch=pt=>`${Number((pt/72).toFixed(2))} in`;
const headingGroups=[
 ['Education',/^(?:education|academic background)$/i],
 ['Technical Proficiency',/^(?:technical proficiency|technical skills|technical expertise)$/i],
 ['Professional Experience',/^(?:(?:professional|work|relevant|employment) )?(?:experience|history)$/i],
 ['Projects',/^(?:(?:selected|academic|relevant|professional) )?projects$/i],
 ['Additional Information',/^(?:additional information|additional|interests(?: and activities)?|skills and interests)$/i]
];

export function resumeReviewTemplate(){
 const t=reference.layout;
 return {id:reference.id,version:reference.version,name:reference.name,sourceName:reference.sourceName,sourceSha256:reference.sourceSha256,sectionOrder:[...reference.sectionOrder],
  styleGuide:[{label:'Page',value:`US Letter · Word metadata reports ${t.observedPageCount} page (not a length rule)`},{label:'Text',value:`${t.bodyFontFamily} ${t.bodyFontSizePt} pt in visible template text`},{label:'Margins',value:`Top ${inch(t.marginsPt.top)}, bottom ${inch(t.marginsPt.bottom)}, left/right ${inch(t.marginsPt.left)}`},{label:'Headings',value:'Centered, bold, uppercase section headings; centered bold name'}],
  note:'These are the supplied template’s layout choices, not a claim about current Cornell requirements. Use only sections and facts that apply to your experience.'};
}

export function resumeTemplateContext(){
 return {template:resumeReviewTemplate(),rules:reference.rules.map(rule=>({id:rule.id,label:rule.label,guidance:rule.guidance,basis:rule.basis}))};
}

/** Text/PDF evidence describes observations, never a rendered visual certification. */
export function compareResumeFormat(text,layout){
 const t=reference.layout,checks=[],add=(id,label,status,observed,recommendation,basis)=>checks.push({id,label,status,observed:clean(observed),recommendation:clean(recommendation),basis});
 const measured=layout?.status==='measured',pages=measured?(layout.pages||[]):[],fonts=measured?(layout.fonts||[]):[];
 if(Number.isSafeInteger(layout?.pageCount)&&layout.pageCount>0)add('page-count','Length',layout.pageCount===t.observedPageCount?'aligned':'suggestion',`${layout.pageCount} PDF page${layout.pageCount===1?'':'s'} detected.`,`The template’s saved Word metadata reports ${t.observedPageCount} page; this is not an explicit length rule. Prioritize relevant evidence and remove repetition if you want a compact format; a longer resume is not automatically incorrect.`,'measured');
 else add('page-count','Length','check','The uploaded PDF page count could not be measured.','Check the original document against the compact reference template.','template');
 if(pages.length){
  const letter=pages.every(page=>Math.abs(page.widthPt-t.pageWidthPt)<=2&&Math.abs(page.heightPt-t.pageHeightPt)<=2);
  add('page-size','Page size',letter?'aligned':'suggestion',pages.slice(0,3).map((page,i)=>`Page ${i+1}: ${inch(page.widthPt)} × ${inch(page.heightPt)}`).join('; '),'The supplied template uses US Letter (8.5 × 11 in).','measured');
  const sides=['left','right','top','bottom'],mins=Object.fromEntries(sides.map(side=>[side,Math.min(...pages.map(page=>page.marginsPt?.[side]).filter(Number.isFinite))]));
  if(sides.every(side=>Number.isFinite(mins[side]))){
   const close=sides.filter(side=>mins[side]<t.marginsPt[side]-5);
   add('text-bounds','Text position and margins',close.length?'suggestion':'aligned',sides.map(side=>`${side}: about ${inch(mins[side])} clear of text`).join('; '),`${close.length?`Text extends closer to the ${close.join('/')} edge than in the reference. `:'Extracted text clears the reference page gutters. '}Reference margins: top ${inch(t.marginsPt.top)}, bottom ${inch(t.marginsPt.bottom)}, left/right ${inch(t.marginsPt.left)}. Text bounds do not reveal Word margin settings or certify visual spacing.`,'measured');
  }
 }
 const visible=fonts.filter(font=>font.count>0&&!/symbol|wingdings|dingbat/i.test(font.family)),families=new Map(),sizes=new Map();
 for(const font of visible){const family=font.family.replace(/[-, ]?(?:bolditalic|boldoblique|semibold|regular|bold|italic|oblique)$/i,'').trim()||font.family,key=family.toLowerCase(),previous=families.get(key);families.set(key,{family:previous?.family||family,count:(previous?.count||0)+font.count});sizes.set(font.sizePt,(sizes.get(font.sizePt)||0)+font.count);}
 const dominant=[...families.values()].sort((a,b)=>b.count-a.count)[0],size=[...sizes].sort((a,b)=>b[1]-a[1])[0]?.[0];
 if(dominant&&Number.isFinite(size)){
  const matches=dominant.family.toLowerCase().includes(t.bodyFontFamily.toLowerCase());
  add('font-family','Main font',matches?'aligned':'suggestion',`${dominant.family} is the most frequent extracted font family by text-run count.`,`Use ${t.bodyFontFamily} to match the visible template. Font substitutes or PDF aliases may differ; verify the original before changing it.`,'measured');
  add('font-size','Main text size',Math.abs(size-t.bodyFontSizePt)<=0.6?'aligned':'suggestion',`The most frequent extracted text size is approximately ${Number(size.toFixed(1))} pt.`,`The template’s visible text is ${t.bodyFontSizePt} pt. Keep text readable and use consistent emphasis instead of compressing the resume with tiny type.`,'measured');
 }else add('font-family','Font and size','check','Reliable PDF font measurements are unavailable.',`Compare the original to the template’s visible ${t.bodyFontFamily} ${t.bodyFontSizePt} pt text.`,'template');
 const lines=String(text||'').split(/\r?\n/),found=[];
 for(let line=0;line<lines.length;line++){const normalized=lines[line].trim().replace(/:$/,'').replace(/\s+/g,' '),joined=`${normalized} ${lines[line+1]?.trim().replace(/:$/,'')||''}`.replace(/\s+/g,' ');let index=headingGroups.findIndex(([,regex])=>regex.test(normalized));if(index<0&&normalized.length<30)index=headingGroups.findIndex(([,regex])=>regex.test(joined));if(index>=0&&!found.some(item=>item.index===index))found.push({index,name:headingGroups[index][0],line});}
 const inOrder=found.every((entry,i)=>!i||entry.index>found[i-1].index);
 add('section-order','Sections and order',found.length>1&&inOrder?'aligned':found.length>1?'suggestion':'check',found.length?`Recognized headings in extracted order: ${found.map(item=>item.name).join(' → ')}.`:'Section headings could not be confidently recognized in extracted text.',`Reference order: ${reference.sectionOrder.join(' → ')}. Technical Proficiency is optional when relevant. Use only applicable sections; do not add credentials, projects, or achievements you do not have. Reading order may differ in a multi-column PDF.`,'text');
 add('heading-alignment','Headings, dates, and spacing','check','Text extraction cannot reliably certify centered headings, right-aligned dates, bold styling, or visual spacing.','Compare the original visually: centered bold name and section headings, clear employer/role hierarchy, aligned dates, and consistent bullet indentation.','template');
 return {status:measured?'measured':'partial',checks,limitations:[...new Set([...(layout?.limitations||[]),'PDF measurements estimate text bounds and font runs; they do not certify the rendered layout, Word margin settings, or applicant-tracking-system compatibility.'])].slice(0,8)};
}

export function resumeFormatRule(id){return reference.rules.find(rule=>rule.id===id)||null;}
