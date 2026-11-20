import {sampleEvents, approveSample, changeSampleSource, sampleAnswer} from './demo-data.js';
let events = sampleEvents(), filter = 'all', lastQuestion = '';
const $ = selector => document.querySelector(selector);
const esc = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function render() {
  const visible = events.filter(e=>filter==='all'||(filter==='review'?e.status!=='approved':e.status==='approved')).sort((a,b)=>`${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`));
  $('#demo-events').innerHTML = visible.map(e=>`<article class="demo-event"><div class="demo-event-top"><span class="demo-event-time">${esc(e.date)} · ${esc(e.time||'Time not specified')}</span><span class="demo-status ${e.status==='approved'?'':'pending'}">${e.status==='approved'?'Reviewed':'Needs review'}</span></div><h3>${esc(e.title)}</h3><details><summary>Why this date?</summary><p>${esc(e.why)}</p><p><strong>Source:</strong> ${esc(e.source)}</p><blockquote>${esc(e.quote)}</blockquote></details>${e.status==='approved'?'<p class="demo-review-note">Included in the sample calendar preview.</p>':e.time?`<button class="button secondary" type="button" data-approve="${esc(e.id)}">Review &amp; approve sample date</button><p class="demo-review-note">Check “Why this date?” before approving. This only updates the sample calendar preview.</p>`:'<button class="button secondary" type="button" disabled>Time confirmation needed</button><p class="demo-review-note">Keep this deadline on your list. Ask the source for the time before approving it for the calendar.</p>'}</article>`).join('') || '<p>No sample dates match this filter.</p>';
  document.querySelectorAll('[data-filter]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.filter===filter)));
  if(lastQuestion) $('#demo-answer').textContent=sampleAnswer(events,lastQuestion);
}
document.addEventListener('click',event=>{
  const button=event.target.closest('button'); if(!button)return;
  if(button.dataset.filter){filter=button.dataset.filter;render();}
  if(button.dataset.approve){const id=button.dataset.approve;if(approveSample(events,id)){render();$('#demo-change-status').textContent='Sample date approved for the calendar preview. No real calendar was changed.';}}
  if(button.dataset.question){lastQuestion=button.dataset.question;$('#demo-question').value=lastQuestion;$('#demo-answer').textContent=sampleAnswer(events,lastQuestion);}
});
$('#demo-ask').addEventListener('submit',event=>{event.preventDefault();lastQuestion=$('#demo-question').value;$('#demo-answer').textContent=sampleAnswer(events,lastQuestion);});
$('#demo-reimport').addEventListener('click',()=>{changeSampleSource(events);filter='review';render();$('#demo-change-status').textContent='Changed date detected: usability report moved from Nov 24 to Nov 25. Review is required again.';$('#demo-reimport').disabled=true;});
$('#reset-demo').addEventListener('click',()=>{events=sampleEvents();filter='all';lastQuestion='';$('#demo-question').value='';$('#demo-answer').textContent='Demo reset. Try a schedule question.';$('#demo-change-status').textContent='';$('#demo-reimport').disabled=false;render();});
render();
