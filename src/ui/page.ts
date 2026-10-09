/**
 * The control room: one self-contained page (no external requests), fed by
 * server-sent snapshots. It follows the same flow as the console: say what you
 * want, watch an agent do it, decide on the result. Written without template
 * literals inside so it can live in String.raw.
 */
export const PAGE = String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AgentBrain Control Room</title>
<style>
 :root{color-scheme:light;--bg:#f7f7f5;--glow:#fff;--card:#ffffff;--soft:#f1f1ef;--ink:#1d1d1f;--muted:#6e6e73;--faint:#9b9ba0;--line:#e4e4e7;--accent:#1677e8;--accent-ink:#ffffff;--ok:#248a4b;--bad:#d0443a;--warn:#a36b00;--blue:#1677e8;--purple:#7457c7;--mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace;--sans:-apple-system,BlinkMacSystemFont,"SF Pro Display","Helvetica Neue",Arial,sans-serif}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){color-scheme:dark;--bg:#161617;--glow:#242426;--card:#242426;--soft:#2c2c2e;--ink:#f5f5f7;--muted:#a1a1a6;--faint:#77777c;--line:#3a3a3c;--accent:#4b9af5;--accent-ink:#101011;--ok:#62c982;--bad:#ff7b70;--warn:#f0bc57;--blue:#4b9af5;--purple:#b99cf4}}
:root[data-theme="dark"]{color-scheme:dark;--bg:#161617;--glow:#242426;--card:#242426;--soft:#2c2c2e;--ink:#f5f5f7;--muted:#a1a1a6;--faint:#77777c;--line:#3a3a3c;--accent:#4b9af5;--accent-ink:#101011;--ok:#62c982;--bad:#ff7b70;--warn:#f0bc57;--blue:#4b9af5;--purple:#b99cf4}
*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 50% -20%,var(--glow) 0,var(--bg) 52%);color:var(--ink);font:14px/1.55 var(--sans);-webkit-font-smoothing:antialiased}
button,select,textarea,input{font:inherit;color:inherit}button{cursor:pointer;border:1px solid var(--line);background:var(--card);border-radius:9px;padding:8px 14px;transition:border-color .15s,background .15s,transform .15s}button:hover{border-color:var(--faint);background:var(--soft)}button:active{transform:scale(.98)}button.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-ink);font-weight:600;box-shadow:0 2px 6px rgba(22,119,232,.18)}button.primary:hover{filter:brightness(1.04);background:var(--accent)}button.ghost{border-color:transparent;background:transparent;color:var(--muted)}button.ghost:hover{background:var(--soft)}button:disabled{opacity:.5;cursor:default}
select{border:1px solid var(--line);background:var(--card);border-radius:9px;padding:7px 11px}
textarea{width:100%;border:0;background:transparent;resize:none;outline:none;min-height:52px;font-size:15px}
header{position:sticky;top:0;z-index:5;background:color-mix(in srgb,var(--bg) 88%,transparent);backdrop-filter:saturate(180%) blur(18px);border-bottom:1px solid color-mix(in srgb,var(--line) 75%,transparent)}
.bar{max-width:1100px;margin:0 auto;padding:15px 24px;display:flex;align-items:center;gap:18px;flex-wrap:wrap}
.brand{display:flex;align-items:center;gap:9px;font-weight:650;font-size:16px;letter-spacing:-.01em}.brand .star{display:grid;place-items:center;width:22px;height:22px;border-radius:7px;background:var(--ink);color:var(--bg);font-size:14px}.repo{color:var(--muted);font-weight:400;font-family:var(--mono);font-size:12px}
nav{display:flex;gap:2px;margin-left:auto}nav button{border:0;background:transparent;color:var(--muted);padding:7px 12px;border-radius:8px}nav button.on{background:var(--ink);color:var(--bg);font-weight:600}
.live{width:8px;height:8px;border-radius:50%;background:var(--ok)}.live.off{background:var(--faint)}
main{max-width:1100px;margin:0 auto;padding:42px 24px 72px}
.composer{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:18px 20px 12px;box-shadow:0 8px 28px rgba(0,0,0,.035)}.composer:focus-within{border-color:var(--accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 14%,transparent)}
.composer .row{display:flex;align-items:center;gap:10px;margin-top:6px;flex-wrap:wrap}.pick{border-radius:999px;padding:5px 12px;font-size:13px;background:var(--soft);border-color:transparent;font-weight:600}.composer .hint{color:var(--muted);font-size:12.5px;margin-right:auto}
.facts{display:flex;gap:18px;flex-wrap:wrap;color:var(--muted);font-size:13px;margin:16px 4px 0}.facts b{color:var(--ink);font-weight:600}
.triage{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:28px 0 8px}.search{flex:1 1 260px;min-width:180px;display:flex;align-items:center;gap:8px;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:0 11px;color:var(--faint)}.search:focus-within{border-color:var(--accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 12%,transparent)}.search input{width:100%;border:0;outline:0;background:transparent;padding:9px 0;font-size:13.5px}.search kbd{border:1px solid var(--line);border-radius:5px;padding:1px 5px;font:11px var(--mono);color:var(--muted)}.filters .chip{background:var(--card)}.triage-note{color:var(--muted);font-size:12px;margin-left:auto}.triage-note b{color:var(--ink)}
h2{font-size:13px;font-weight:650;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:30px 4px 10px;display:flex;align-items:center;gap:8px}h2 .count{background:var(--soft);color:var(--ink);border-radius:999px;padding:0 8px;font-size:12px;letter-spacing:0}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px 18px;margin-bottom:12px;box-shadow:0 2px 8px rgba(0,0,0,.02)}
.card.need{border-left:3px solid var(--purple)}
.title{font-weight:600;font-size:15px}.sub{color:var(--muted);font-size:12.5px}.mono{font-family:var(--mono)}
.steps{display:flex;gap:0;margin:12px 0 8px;font-size:12px;color:var(--faint)}.step{flex:1;position:relative;padding-top:12px;text-align:left}.step:before{content:"";position:absolute;top:3px;left:0;right:0;height:3px;background:var(--line);border-radius:2px}.step:not(:last-child){margin-right:4px}.step.done{color:var(--muted)}.step.done:before{background:var(--ok)}.step.now{color:var(--ink);font-weight:600}.step.now:before{background:var(--accent)}.step.bad:before{background:var(--bad)}
.log{margin-top:6px;border-top:1px solid var(--line);padding-top:8px}.log div{font-size:12.5px;color:var(--muted);display:flex;gap:8px;padding:1px 0}.log .g{width:14px;text-align:center;flex:none;color:var(--faint)}.log .t{font-family:var(--mono);color:var(--faint);flex:none;font-size:11.5px;padding-top:1px}
.check{font-family:var(--mono);font-size:12.5px}.ok{color:var(--ok)}.bad{color:var(--bad)}
.flag{background:color-mix(in srgb,var(--bad) 9%,transparent);border-radius:8px;padding:7px 10px;margin:8px 0;font-size:13px}.flag b{color:var(--bad)}
.actions{display:flex;gap:8px;margin-top:10px;flex-wrap:wrap;align-items:center}
.notes{width:100%;border:1px solid var(--line);border-radius:8px;background:var(--bg);padding:8px 10px;min-height:44px;margin-top:10px;font-size:13.5px;resize:vertical}
.meter{height:6px;border-radius:3px;background:var(--line);position:relative;overflow:hidden;margin:10px 0 4px}.meter .a{position:absolute;left:0;top:0;bottom:0;background:var(--ok)}.meter .c{position:absolute;right:0;top:0;bottom:0;background:var(--bad)}.meter .q{position:absolute;top:0;bottom:0;width:2px;background:var(--ink)}
.empty{color:var(--muted);background:var(--card);border:1px dashed var(--line);border-radius:12px;padding:18px;text-align:center;font-size:13.5px}
details summary{cursor:pointer;color:var(--muted);margin:24px 4px 8px;font-size:13px}details .row{display:flex;gap:10px;padding:7px 4px;border-bottom:1px solid var(--line);font-size:13.5px}details .row .sub{margin-left:auto;white-space:nowrap}
.feed .row{display:grid;grid-template-columns:70px 130px minmax(0,1fr);gap:10px;padding:7px 2px;border-bottom:1px solid var(--line);font-size:13.5px}.feed .t{font-family:var(--mono);font-size:12px;color:var(--faint)}.feed .who{font-weight:600;font-size:13px}
.filters{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px}.chip{border-radius:999px;padding:3px 11px;font-size:12.5px}.chip.on{border-color:var(--accent);color:var(--accent)}
#graphWrap{position:relative;height:calc(100vh - 210px);min-height:440px;background:var(--card);border:1px solid var(--line);border-radius:14px;overflow:hidden}canvas{display:block;width:100%;height:100%;cursor:grab}
.brainbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:12px}.brainbar .filters{margin:0;flex:1 1 auto}.vsearch{border:1px solid var(--line);background:var(--card);border-radius:9px;padding:7px 11px;font-size:13px;min-width:180px}.btn{display:inline-block;border:1px solid var(--line);background:var(--card);border-radius:9px;padding:8px 14px;color:inherit;text-decoration:none;font-size:14px}.btn:hover{background:var(--soft)}
.ghint{position:absolute;left:12px;bottom:10px;font-size:12px;color:var(--faint)}
.nodecard{position:absolute;right:12px;top:12px;bottom:12px;width:min(380px,calc(100% - 24px));overflow:auto;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px;display:none;box-shadow:0 10px 30px rgba(0,0,0,.18)}
.note h3{font-size:17px;margin:4px 0 8px}.note h4{font-size:14px;margin:14px 0 6px}.note h5{font-size:13px;margin:12px 0 4px}.note p{margin:6px 0;font-size:13.5px}.note ul{padding-left:18px;margin:4px 0}.note li{font-size:13.5px;margin:2px 0}.note a{color:var(--accent);text-decoration:none}.note a:hover{text-decoration:underline}.note code{font:12px var(--mono);background:var(--soft);padding:1px 4px;border-radius:4px}
.set{display:grid;grid-template-columns:180px 1fr;gap:14px;padding:14px 0;border-bottom:1px solid var(--line);align-items:start}.set label{font-weight:600}.set .sub{margin-top:3px}
.seg{display:inline-flex;border:1px solid var(--line);border-radius:9px;overflow:hidden}.seg button{border:0;border-radius:0;background:var(--card)}.seg button.on{background:var(--soft);font-weight:600;color:var(--accent)}
.agents{display:flex;gap:6px;flex-wrap:wrap;margin-top:10px}
.detail pre{font:12px/1.5 var(--mono);background:var(--soft);border-radius:8px;padding:10px;overflow:auto;white-space:pre-wrap;max-height:360px}
.toast{position:fixed;left:50%;bottom:22px;transform:translateX(-50%);background:var(--ink);color:var(--bg);padding:9px 16px;border-radius:9px;font-size:13.5px;display:none;z-index:20;max-width:90vw}
.who-dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;vertical-align:0}
@media (max-width:640px){.feed .row{grid-template-columns:56px minmax(0,1fr)}.feed .who{display:none}.set{grid-template-columns:1fr}nav{margin-left:0}.steps{font-size:10.5px}}
</style></head><body>
<header><div class="bar"><div class="brand"><span class="star">✻</span>AgentBrain <span class="repo" id="repo"></span><span class="live" id="live" title="live"></span></div><nav id="nav"></nav></div></header>
<main id="main"></main><div class="toast" id="toast"></div>
<script>
(function(){
var token=location.hash.replace(/^#token=/,'');var S=null;var pick=localGet('pick')||'auto';var view=localGet('view')||'home';var selectedTask=null;var drafts={};var composer='';var agentFilter=null;var settings=null;var taskFilter='all';var taskSearch='';var goKey=false;
function localGet(k){try{return localStorage.getItem('ab.'+k)}catch(e){return null}}function localSet(k,v){try{localStorage.setItem('ab.'+k,v)}catch(e){}}
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
function api(p,o){o=o||{};o.headers=Object.assign({'x-agentbrain-token':token,'content-type':'application/json'},o.headers||{});return fetch(p,o).then(function(r){return r.json()})}
function post(p,b){return api(p,{method:'POST',body:JSON.stringify(b)}).then(function(r){if(r&&r.error)toast(r.error);return r})}
function toast(t){var el=document.getElementById('toast');el.textContent=t;el.style.display='block';clearTimeout(toast.t);toast.t=setTimeout(function(){el.style.display='none'},3500)}
function ago(iso){if(!iso)return '';var s=Math.max(0,(Date.now()-Date.parse(iso))/1000);if(s<60)return 'just now';if(s<3600)return Math.floor(s/60)+'m ago';if(s<86400)return Math.floor(s/3600)+'h ago';return Math.floor(s/86400)+'d ago'}
function hhmm(iso){return new Date(iso).toTimeString().slice(0,5)}
var PALETTE=['#2f7d4f','#2e6bc6','#7b4fc9','#a26b0b','#c2412d','#16808a','#b03a87'];
function color(id){if(id==='developer')return 'var(--ink)';if(id==='agentbrain'||id==='council')return 'var(--accent)';var h=0;for(var i=0;i<id.length;i++)h=(h*31+id.charCodeAt(i))>>>0;return PALETTE[h%PALETTE.length]}
var NAMES={'claude-code':'Claude Code','vscode':'Copilot (VS Code)','codex':'Codex','gemini':'Gemini','cursor':'Cursor','copilot':'Copilot CLI','aider':'Aider','developer':'You','agentbrain':'AgentBrain','council':'Council'};
function name(id){return NAMES[id]||id}
function taskById(id){return S&&S.tasks.filter(function(t){return t.id===id})[0]}
function weight(id){var r=S.reputation[id];return r?r.score:1}
function decides(){var p=S.policy;if(p.mode==='lead')return 'Lead: '+name(p.reviewers[0]);if(p.mode==='council')return 'Council of '+p.reviewers.length+' · survives '+p.tolerates+' bad reviewer'+(p.tolerates===1?'':'s');return 'You decide'}
function workerName(){var w=S.workers.filter(function(x){return x.id===S.worker})[0];return w?w.name:null}

/* ---------- navigation ---------- */
function setTab(t){view=t==='tasks'?'task':t;localSet('view',view==='task'?'home':view);render()}
function renderNav(){var tabs=[['home','Home'],['activity','Activity'],['brain','Brain'],['settings','Settings']];var el=document.getElementById('nav');el.innerHTML=tabs.map(function(t){return '<button data-v="'+t[0]+'" class="'+(view===t[0]?'on':'')+'">'+t[1]+'</button>'}).join('');el.querySelectorAll('[data-v]').forEach(function(b){b.onclick=function(){setTab(b.dataset.v)}})}

/* ---------- home ---------- */
var STEPS=['Delegated','Working','Checks','Review','Done'];
function stage(t){if(t.status==='done')return 4;if(t.status==='review')return (S.policy.checks.length&&!(t.review&&(t.review.checks||[]).length))?2:3;if(t.status==='running'||t.status==='checkpoint')return 1;return 0}
function stepsHtml(t){var n=stage(t);var failed=t.review&&(t.review.checks||[]).some(function(c){return !c.ok});return '<div class="steps">'+STEPS.map(function(s,i){var cls=i<n?'done':i===n?'now':'';if(i===2&&failed)cls='bad';return '<div class="step '+cls+'">'+s+'</div>'}).join('')+'</div>'}
function taskLog(t,n){return S.activity.filter(function(e){return e.task===t.id&&!(e.kind==='tool'&&/^(Read|Grep|Glob) /.test(e.text))}).slice(-n)}
var GLYPH={message:'✉',progress:'✓',edit:'✎',command:'$',commit:'●',decision:'◆',handoff:'⇄',review:'⚖',status:'→',prompt:'›',tool:'·',session:'◎'};
function logHtml(list){if(!list.length)return '';return '<div class="log">'+list.map(function(e){return '<div><span class="t">'+hhmm(e.at)+'</span><span class="g">'+(GLYPH[e.kind]||'·')+'</span><span><b style="color:'+color(e.agent)+';font-weight:600">'+esc(name(e.agent))+'</b> '+esc(e.text)+'</span></div>'}).join('')+'</div>'}
function renderHome(){
  var m=document.getElementById('main');var active=document.activeElement;var refocus=active&&active.id==='prompt';var pos=refocus?active.selectionStart:0;var searching=active&&active.id==='taskSearch';
  m.querySelectorAll('[data-notes]').forEach(function(t){drafts[t.dataset.notes]=t.value});var focusNotes=active&&active.dataset&&active.dataset.notes;
  var ready=S.workers.filter(function(w){return w.available});var auto=ready[0];if(pick!=='auto'&&!ready.some(function(w){return w.id===pick}))pick='auto';
  var chosen=pick==='auto'?auto:ready.filter(function(w){return w.id===pick})[0];var wn=chosen?chosen.name:null;
  var h='<div class="composer"><textarea id="prompt" rows="2" placeholder="What should your agents do? e.g. Add a dark mode toggle to the settings page">'+esc(composer)+'</textarea><div class="row">'+
    '<select id="workerPick" class="pick" title="Which agent takes this task">'+'<option value="auto"'+(pick==='auto'?' selected':'')+'>Auto'+(auto?' · '+esc(auto.name):'')+'</option>'+S.workers.map(function(w){return '<option value="'+esc(w.id)+'"'+(w.id===pick?' selected':'')+(w.available?'':' disabled')+'>'+esc(w.name)+(w.available?'':' · '+esc((w.note||'unavailable').replace(/:.*/,'')))+'</option>'}).join('')+'</select>'+
    '<span class="hint">'+(chosen?(pick==='auto'?esc(chosen.reasons.slice(0,2).join(', ')):'In its own worktree')+' · Enter to send':'No agent ready: open VS Code with Copilot, or sign in to Claude Code or Codex')+'</span>'+'<button class="primary" id="send"'+(wn?'':' disabled')+'>Delegate</button></div></div>';
  var running=S.tasks.filter(function(t){return ['running','checkpoint','handoff','idle','blocked','failed'].indexOf(t.status)>=0});var review=S.tasks.filter(function(t){return t.status==='review'});var done=S.tasks.filter(function(t){return t.status==='done'});
  var live=S.sessions.filter(function(s){return s.state!=='ended'});
  h+='<div class="facts"><span><b>'+review.length+'</b> to review</span><span><b>'+running.filter(function(t){return t.status==='running'}).length+'</b> running</span><span><b>'+live.length+'</b> agent'+(live.length===1?'':'s')+' active</span><span>'+esc(decides())+'</span>'+(S.policy.checks.length?'<span>Checks: <span class="mono">'+S.policy.checks.map(esc).join(' · ')+'</span></span>':'')+'</div>';
  var query=taskSearch.trim().toLowerCase();var matches=function(t){return (!query||(t.objective+' '+t.id+' '+(t.agent||'')).toLowerCase().indexOf(query)>=0)&&(taskFilter==='all'||(taskFilter==='review'&&t.status==='review')||(taskFilter==='active'&&['running','checkpoint','handoff','blocked','idle','failed'].indexOf(t.status)>=0))};
  var visibleReview=review.filter(matches),visibleRunning=running.filter(matches),visibleDone=done.filter(matches);var visibleCount=visibleReview.length+visibleRunning.length+visibleDone.length;
  h+='<div class="triage"><label class="search"><span>⌕</span><input id="taskSearch" value="'+esc(taskSearch)+'" placeholder="Find a task, agent, or ID" aria-label="Find a task, agent, or ID"><kbd>/</kbd></label><div class="filters"><button class="chip'+(taskFilter==='all'?' on':'')+'" data-filter="all">All</button><button class="chip'+(taskFilter==='active'?' on':'')+'" data-filter="active">Active <span class="sub">'+running.length+'</span></button><button class="chip'+(taskFilter==='review'?' on':'')+'" data-filter="review">Review <span class="sub">'+review.length+'</span></button></div><span class="triage-note"><b>'+visibleCount+'</b> shown · <span class="mono">g</span> then view key</span></div>';
  h+='<h2>Needs you <span class="count">'+visibleReview.length+(visibleReview.length!==review.length?' / '+review.length:'')+'</span></h2>';
  if(!visibleReview.length)h+='<div class="empty">'+(review.length?'No review matches "'+esc(taskSearch)+'".':'Nothing to review. Finished work lands here with AgentBrain\'s own checks and any red flags.')+'</div>';
  visibleReview.forEach(function(t){var rv=t.review||{};var ty=t.tally;
    h+='<div class="card need"><div class="title">'+esc(t.objective)+'</div><div class="sub">Finished by <b style="color:'+color(rv.worker||t.agent||'')+'">'+esc(name(rv.worker||t.agent||'?'))+'</b> '+ago(rv.requestedAt||t.updatedAt)+' · <span class="mono">'+esc(t.id)+'</span></div>'+stepsHtml(t);
    if(S.policy.checks.length){if((rv.checks||[]).length)h+=rv.checks.map(function(c){return '<div class="check '+(c.ok?'ok':'bad')+'" title="'+esc(c.tail)+'">'+(c.ok?'✓ passed':'✗ failed')+' · '+esc(c.command)+'</div>'}).join('');else if(t.review)h+='<div class="check sub">Running checks…</div>';else h+='<div class="sub">Checks have not run on this result yet. <button class="ghost" data-verify="'+esc(t.id)+'">Run checks</button></div>'}
    (rv.flags||[]).forEach(function(f){h+='<div class="flag"><b>⚠ '+esc({'no-change':'Nothing changed','false-claim':'False claim','hallucination':'Hallucination','dissent':'Dissent'}[f.kind]||f.kind)+'</b> · '+esc(name(f.agent))+': '+esc(f.text)+'</div>'});
    if(ty&&ty.total>0&&S.policy.mode!=='none'){h+='<div class="meter"><div class="a" style="width:'+(ty.approve/ty.total*100)+'%"></div><div class="c" style="width:'+(ty.changes/ty.total*100)+'%"></div><div class="q" style="left:'+(ty.quorum*100)+'%"></div></div><div class="sub">'+(S.policy.mode==='council'?'Council: '+ty.approve.toFixed(1)+' approve, '+ty.changes.toFixed(1)+' changes of '+ty.total.toFixed(1)+' (needs '+Math.round(ty.quorum*100)+'%)':'Lead: '+((rv.votes||[]).length?'voted':'has not voted yet'))+(function(){var w=ty.eligible.filter(function(x){return !(rv.votes||[]).some(function(v){return v.agent===x})});return w.length?' · <b>waiting for '+w.map(name).map(esc).join(', ')+'</b> (or decide yourself below)':''})()+'</div>';
      (rv.votes||[]).forEach(function(v){h+='<div class="sub"><b style="color:'+color(v.agent)+'">'+esc(name(v.agent))+'</b> '+(v.verdict==='approved'?'<span class="ok">approve</span>':'<span class="bad">changes</span>')+(v.notes?': '+esc(v.notes):'')+'</div>'})}
    h+=logHtml(taskLog(t,3));
    h+='<textarea class="notes" data-notes="'+esc(t.id)+'" placeholder="What should change? (needed to send it back)">'+esc(drafts[t.id]||'')+'</textarea><div class="actions"><button class="primary" data-approve="'+esc(t.id)+'">Approve & merge</button><button data-changes="'+esc(t.id)+'">Send back</button><button class="ghost" data-open="'+esc(t.id)+'">Details</button></div></div>'});
  h+='<h2>In progress <span class="count">'+visibleRunning.length+(visibleRunning.length!==running.length?' / '+running.length:'')+'</span></h2>';
  if(!visibleRunning.length)h+='<div class="empty">'+(running.length?'No active task matches "'+esc(taskSearch)+'".':'No work in progress. Describe a task above and an agent will pick it up.')+'</div>';
  visibleRunning.forEach(function(t){var s=S.sessions.filter(function(x){return x.taskId===t.id&&x.state!=='ended'})[0];
    h+='<div class="card"><div class="title">'+esc(t.objective)+'</div><div class="sub">'+(t.agent?'<span class="who-dot" style="background:'+color(t.agent)+'"></span>'+esc(name(t.agent)):'Unassigned')+' · '+esc(t.status==='handoff'?'handed off, waiting for an agent':t.status)+(t.warning?' · <span class="bad">'+esc(t.warning)+'</span>':'')+' · '+ago(t.updatedAt)+'</div>'+stepsHtml(t)+
      (t.nextAction?'<div class="sub">Next: '+esc(t.nextAction)+'</div>':'')+logHtml(taskLog(t,4))+'<div class="actions">'+(t.status!=='running'?'<button data-continue="'+esc(t.id)+'">Hand to '+esc(wn||'a worker')+'</button>':'')+(t.liveSession&&t.liveSession.alive?'<button data-stop="'+esc(t.liveSession.sessionId)+'">Stop</button>':'')+'<button class="ghost" data-open="'+esc(t.id)+'">Details</button></div></div>'});
  if(visibleDone.length)h+='<details open><summary>Finished ('+visibleDone.length+(visibleDone.length!==done.length?' / '+done.length:'')+')</summary>'+visibleDone.slice().sort(function(a,b){return (b.updatedAt||'').localeCompare(a.updatedAt||'')}).slice(0,30).map(function(t){return '<div class="row" role="button" tabindex="0" data-open="'+esc(t.id)+'" aria-label="Open finished task '+esc(t.objective)+'"><span class="ok">✓</span><span>'+esc(t.objective)+'</span><span class="sub">'+esc(t.agent?name(t.agent):'')+' · '+ago(t.updatedAt)+'</span></div>'}).join('')+'</details>';
  m.innerHTML=h;
  var p=document.getElementById('prompt');p.oninput=function(){composer=p.value};p.onkeydown=function(e){if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send()}};if(refocus){p.focus();p.selectionStart=p.selectionEnd=pos}
  if(searching){var sn=document.getElementById('taskSearch');if(sn){sn.focus();sn.setSelectionRange(sn.value.length,sn.value.length)}}
  if(focusNotes){var f=m.querySelector('[data-notes="'+focusNotes+'"]');if(f){f.focus();f.selectionStart=f.selectionEnd=f.value.length}}
  document.getElementById('send').onclick=send;var wp=document.getElementById('workerPick');if(wp)wp.onchange=function(){pick=wp.value;localSet('pick',pick);renderHome()};
  var search=document.getElementById('taskSearch');search.oninput=function(){taskSearch=search.value;renderHome();var next=document.getElementById('taskSearch');next.focus();next.setSelectionRange(taskSearch.length,taskSearch.length)};m.querySelectorAll('[data-filter]').forEach(function(b){b.onclick=function(){taskFilter=b.dataset.filter;renderHome()}});
  m.querySelectorAll('[data-notes]').forEach(function(t){t.oninput=function(){drafts[t.dataset.notes]=t.value}});
  m.querySelectorAll('[data-approve]').forEach(function(b){b.onclick=function(){b.disabled=true;post('/api/review',{taskId:b.dataset.approve,verdict:'approved',notes:drafts[b.dataset.approve]||''}).then(function(r){if(r.ok)toast(r.conflicts&&r.conflicts.length?'Conflicts in '+r.conflicts.join(', ')+'; still in review':'Approved and merged');delete drafts[b.dataset.approve]})}});
  m.querySelectorAll('[data-changes]').forEach(function(b){b.onclick=function(){var id=b.dataset.changes;var notes=(drafts[id]||'').trim();if(!notes){toast('Write what should change first');var n=m.querySelector('[data-notes="'+id+'"]');if(n)n.focus();return}b.disabled=true;post('/api/review',{taskId:id,verdict:'changes',notes:notes}).then(function(r){if(r.ok)toast('Sent back with your notes');delete drafts[id]})}});
  m.querySelectorAll('[data-verify]').forEach(function(b){b.onclick=function(){b.disabled=true;post('/api/verify',{taskId:b.dataset.verify}).then(function(r){if(r.ok)toast('Running checks')})}});
  m.querySelectorAll('[data-continue]').forEach(function(b){b.onclick=function(){b.disabled=true;post('/api/delegate',{taskId:b.dataset.continue}).then(function(r){if(r.ok)toast('Handed to '+r.worker)})}});
  m.querySelectorAll('[data-stop]').forEach(function(b){b.onclick=function(){post('/api/stop',{sessionId:b.dataset.stop})}});
  m.querySelectorAll('[data-open]').forEach(function(b){b.onclick=function(){selectedTask=b.dataset.open;setTab('tasks')};b.onkeydown=function(e){if(e.key==='Enter'||e.key===' '){e.preventDefault();b.click()}}});
}
function send(){var text=composer.trim();if(!text)return;var b=document.getElementById('send');b.disabled=true;post('/api/delegate',pick==='auto'?{prompt:text}:{prompt:text,worker:pick}).then(function(r){b.disabled=false;if(r.ok){composer='';toast('Delegated to '+r.worker);renderHome()}})}
document.addEventListener('keydown',function(e){if(e.target&&(/INPUT|TEXTAREA|SELECT/.test(e.target.tagName)))return;if(e.key==='/'){e.preventDefault();var search=document.getElementById('taskSearch');if(search){search.focus();search.select()}}else if(e.key==='g'){goKey=true;setTimeout(function(){goKey=false},900)}else if(goKey&&{h:'home',a:'activity',b:'brain',s:'settings'}[e.key]){goKey=false;setTab({h:'home',a:'activity',b:'brain',s:'settings'}[e.key])}});

/* ---------- activity ---------- */
function renderActivity(){
  var agents=[];S.activity.forEach(function(e){if(agents.indexOf(e.agent)<0)agents.push(e.agent)});
  var list=S.activity.slice().reverse().filter(function(e){return (!agentFilter||e.agent===agentFilter)&&!(e.kind==='tool'&&/^(Read|Grep|Glob) /.test(e.text))});
  var h='<div class="filters"><button class="chip'+(agentFilter?'':' on')+'" data-af="">Everyone</button>'+agents.map(function(a){return '<button class="chip'+(agentFilter===a?' on':'')+'" data-af="'+esc(a)+'"><span class="who-dot" style="background:'+color(a)+'"></span>'+esc(name(a))+'</button>'}).join('')+'</div>';
  h+=list.length?'<div class="card feed" style="padding:4px 14px">'+list.slice(0,300).map(function(e){var t=e.task&&taskById(e.task);return '<div class="row"><span class="t">'+hhmm(e.at)+'</span><span class="who" style="color:'+color(e.agent)+'">'+esc(name(e.agent))+'</span><span><span style="color:var(--faint)">'+(GLYPH[e.kind]||'·')+'</span> '+esc(e.text)+(t?' <span class="sub">· '+esc(t.objective.slice(0,60))+'</span>':'')+'</span></div>'}).join('')+'</div>':'<div class="empty">Nothing yet. Prompts, edits, commands, progress, handoffs and verdicts from every agent show up here.</div>';
  var m=document.getElementById('main');m.innerHTML=h;m.querySelectorAll('[data-af]').forEach(function(b){b.onclick=function(){agentFilter=b.dataset.af||null;renderActivity()}});
}

/* ---------- settings ---------- */
function renderSettings(){
  if(!settings||!settings.dirty)settings={mode:S.policy.mode,agents:S.policy.reviewers.slice(),quorum:S.policy.quorum||0.67,checks:S.policy.checks.join('\n'),dirty:false};var d=settings;
  var h='<div class="card"><div class="set"><div><label>New tasks go to</label><div class="sub">The agent that picks up what you type.</div></div><div><select id="worker">'+S.workers.map(function(w){return '<option value="'+esc(w.id)+'"'+(w.id===S.worker?' selected':'')+(w.available?'':' disabled')+'>'+esc(w.name)+(w.available?'':' (not installed)')+'</option>'}).join('')+'</select></div></div>';
  h+='<div class="set"><div><label>Who decides</label><div class="sub">Whose approval finished work needs.</div></div><div><span class="seg">'+[['none','Me'],['lead','A lead agent'],['council','A council']].map(function(x){return '<button data-mode="'+x[0]+'" class="'+(d.mode===x[0]?'on':'')+'">'+x[1]+'</button>'}).join('')+'</span>';
  if(d.mode==='lead')h+='<div class="agents">'+S.knownAgents.map(function(a){return '<button class="chip'+(d.agents[0]===a?' on':'')+'" data-lead="'+esc(a)+'">'+esc(name(a))+'</button>'}).join('')+'</div><div class="sub" style="margin-top:6px">The lead reviews every other agent\'s work. You can always override.</div>';
  if(d.mode==='council'){var f=Math.max(0,Math.floor(d.agents.length*(1-d.quorum)+1e-9));h+='<div class="agents">'+S.knownAgents.map(function(a){return '<button class="chip'+(d.agents.indexOf(a)>=0?' on':'')+'" data-member="'+esc(a)+'">'+esc(name(a))+' <span class="sub">w '+weight(a).toFixed(2)+'</span></button>'}).join('')+'</div><div class="actions"><span class="sub">Quorum</span><select id="quorum">'+[[0.51,'51%'],[0.67,'67%'],[0.75,'75%'],[1,'100%']].map(function(q){return '<option value="'+q[0]+'"'+(Math.abs(d.quorum-q[0])<0.02?' selected':'')+'>'+q[1]+'</option>'}).join('')+'</select><span class="sub">'+d.agents.length+' members · a result survives '+f+' broken, compromised or hallucinating reviewer'+(f===1?'':'s')+'</span></div><div class="sub" style="margin-top:6px">Votes are sealed until each member votes and weighted by reputation; mix vendors so one model\'s blind spot can\'t decide.</div>'}
  h+='</div></div><div class="set"><div><label>Checks</label><div class="sub">AgentBrain runs these itself on every result; failing ones block approval. One per line.</div></div><div><textarea id="checks" class="notes" style="margin:0;font-family:var(--mono)" placeholder="npm test">'+esc(d.checks)+'</textarea></div></div>';
  h+='<div class="actions"><button class="primary" id="save"'+(d.dirty?'':' disabled')+'>Save</button>'+(d.dirty?'<button class="ghost" id="cancel">Cancel</button>':'')+'</div></div>';
  if(Object.keys(S.reputation).length)h+='<h2>Reputation</h2><div class="card">'+Object.keys(S.reputation).map(function(a){var r=S.reputation[a];return '<div class="sub" style="padding:3px 0"><b style="color:'+color(a)+'">'+esc(name(a))+'</b> · weight '+r.score.toFixed(2)+' · agreed '+r.agreed+' · dissented '+r.dissented+' · flagged '+r.flagged+'</div>'}).join('')+'</div>';
  var m=document.getElementById('main');m.innerHTML=h;
  document.getElementById('worker').onchange=function(e){post('/api/settings',{worker:e.target.value}).then(function(r){if(r.ok)toast('New tasks go to '+e.target.selectedOptions[0].text)})};
  m.querySelectorAll('[data-mode]').forEach(function(b){b.onclick=function(){d.mode=b.dataset.mode;if(d.mode==='lead'&&!d.agents.length)d.agents=['claude-code'];if(d.mode==='lead')d.agents=d.agents.slice(0,1);if(d.mode==='council'&&d.quorum>=1)d.quorum=0.67;d.dirty=true;renderSettings()}});
  m.querySelectorAll('[data-lead]').forEach(function(b){b.onclick=function(){d.agents=[b.dataset.lead];d.dirty=true;renderSettings()}});
  m.querySelectorAll('[data-member]').forEach(function(b){b.onclick=function(){var a=b.dataset.member,i=d.agents.indexOf(a);if(i>=0)d.agents.splice(i,1);else d.agents.push(a);d.dirty=true;renderSettings()}});
  var q=document.getElementById('quorum');if(q)q.onchange=function(){d.quorum=Number(q.value);d.dirty=true;renderSettings()};
  var c=document.getElementById('checks');c.oninput=function(){d.checks=c.value;if(!d.dirty){d.dirty=true;var s=document.getElementById('save');s.disabled=false}};
  document.getElementById('save').onclick=function(){Promise.all([post('/api/policy',{mode:d.mode,agents:d.agents,quorum:d.mode==='council'?d.quorum:undefined}),post('/api/settings',{checks:d.checks.split('\n')})]).then(function(r){if(r[0].ok&&r[1].ok){d.dirty=false;toast('Saved')}})};
  var cc=document.getElementById('cancel');if(cc)cc.onclick=function(){d.dirty=false;renderSettings()};
}

/* ---------- task detail ---------- */
var detailKey='';
function renderTask(){
  var t=taskById(selectedTask);var m=document.getElementById('main');if(!t){setTab('home');return}
  var key=t.id+t.updatedAt+S.activity.length;if(key===detailKey&&m.querySelector('.detail'))return;detailKey=key;
  Promise.all([api('/api/diff?task='+encodeURIComponent(t.id)),t.liveSession?api('/api/transcript?session='+encodeURIComponent(t.liveSession.sessionId)):Promise.resolve(null)]).then(function(r){
    function list(a){return a&&a.length?'<ul>'+a.map(function(x){return '<li>'+esc(x)+'</li>'}).join('')+'</ul>':'<div class="sub">None</div>'}
    var h='<div class="detail"><button class="ghost" id="back">← Back</button><div class="card" style="margin-top:8px"><div class="title" style="font-size:18px">'+esc(t.objective)+'</div><div class="sub">'+esc(t.status)+(t.agent?' · '+esc(name(t.agent)):'')+' · <span class="mono">'+esc(t.id)+'</span></div>'+stepsHtml(t)+(t.nextAction?'<div class="sub">Next: '+esc(t.nextAction)+'</div>':'')+'<div class="actions"><button id="openEditor">Open in VS Code</button></div></div>'+
      '<div class="card"><b>Done</b>'+list(t.completed)+'<b>Remaining</b>'+list(t.remaining)+'<b>Decisions</b>'+list(t.decisions)+(t.failures.length?'<b>Known failures</b>'+list(t.failures):'')+'</div>'+
      (t.reviews.length?'<div class="card"><b>Review history</b>'+t.reviews.map(function(v){return '<div class="sub">'+esc(v.at.slice(0,16).replace('T',' '))+' · '+(v.verdict==='approved'?'<span class="ok">approved</span>':'<span class="bad">sent back</span>')+' by '+esc(v.reviewer)+(v.notes?': '+esc(v.notes):'')+'</div>'}).join('')+'</div>':'')+
      '<div class="card"><b>Activity</b>'+logHtml(taskLog(t,40))+'</div>'+
      '<div class="card"><b>Uncommitted changes</b><pre>'+esc(r[0].diff||'(none)')+'</pre></div>'+
      (r[1]?'<div class="card"><b>Live transcript</b><pre>'+esc((r[1].transcript||[]).join('\n'))+'</pre></div>':'')+'<div class="sub mono">'+esc(t.workdir)+'</div></div>';
    m.innerHTML=h;document.getElementById('back').onclick=function(){setTab('home')};document.getElementById('openEditor').onclick=function(){post('/api/open',{taskId:t.id})};
  });
}

function role(id){var p=S.policy;if(p.mode==='lead'&&p.reviewers[0]===id)return ' <span class="sub">· lead</span>';if(p.mode==='council'&&p.reviewers.indexOf(id)>=0)return ' <span class="sub">· council</span>';return ''}
function cssVar(n){return getComputedStyle(document.documentElement).getPropertyValue(n).trim()}
/* ---------- brain: the real vault, drawn like Obsidian's graph view ---------- */
var V={nodes:[],links:[],byId:{},cam:{x:0,y:0,k:1},hover:null,drag:null,pan:null,moved:false,raf:null,alpha:0,data:null,loadedAt:0,hidden:{Daily:true},query:'',canvas:null,fit:true,open:null};
var ROOMS={Home:'#c96442',Agents:'#8b5cf6',Tasks:'#3b82f6',Decisions:'#eab308',Code:'#94a3b8',Memory:'#22c55e',Daily:'#14b8a6'};
var ROOM_ORDER=['Home','Agents','Tasks','Decisions','Code','Memory','Daily'];
function roomColor(r){return ROOMS[r]||'#94a3b8'}
function loadVault(force){if(!force&&V.data&&Date.now()-V.loadedAt<8000)return Promise.resolve(V.data);return api('/api/vault').then(function(d){V.data=d;V.loadedAt=Date.now();return d})}
function renderBrain(fresh){
  var m=document.getElementById('main');
  if(fresh||!document.getElementById('graph')){
    m.innerHTML='<div class="brainbar"><div class="filters" id="rooms"></div><input id="vsearch" class="vsearch" placeholder="Search notes" value="'+esc(V.query)+'"><button id="vfit">Fit</button><button id="vfolder">Open vault folder</button><a class="btn" id="vobs">Open in Obsidian</a></div>'+
      '<div id="graphWrap"><canvas id="graph"></canvas><div class="nodecard" id="nodecard"></div><div class="ghint">scroll to zoom · drag to pan · click a note to read it</div></div><div class="sub" id="vpath" style="margin-top:8px"></div>';
    V.canvas=document.getElementById('graph');V.fit=true;V.touched=false;bindVault();
    // Redraw (and refit until the user moves the view) whenever the graph's box changes size.
    if(window.ResizeObserver)new ResizeObserver(function(){if(!V.touched)fitVault(false);else drawVault();kick()}).observe(V.canvas);
  }
  loadVault(fresh).then(buildVault);
}
function renderRooms(){var counts={};V.data.nodes.forEach(function(n){counts[n.room]=(counts[n.room]||0)+1});var el=document.getElementById('rooms');if(!el)return;
  el.innerHTML=ROOM_ORDER.filter(function(r){return counts[r]}).map(function(r){return '<button class="chip'+(V.hidden[r]?'':' on')+'" data-room="'+r+'"><span class="who-dot" style="background:'+roomColor(r)+'"></span>'+(r==='Home'?'Onboarding & lessons':r)+' <span class="sub">'+counts[r]+'</span></button>'}).join('')+'<button class="chip'+(V.showIndex?' on':'')+'" id="vindex">Index notes</button>';
  document.getElementById('vindex').onclick=function(){V.showIndex=!V.showIndex;V.touched=false;buildVault(V.data)};
  el.querySelectorAll('[data-room]').forEach(function(b){b.onclick=function(){V.hidden[b.dataset.room]=!V.hidden[b.dataset.room];V.fit=true;buildVault(V.data)}})}
function buildVault(d){
  if(!document.getElementById('graph'))return;V.data=d;renderRooms();
  document.getElementById('vpath').innerHTML='This is the real Obsidian vault: <span class="mono">'+esc(d.dir)+'</span> · '+d.nodes.length+' notes. Open that folder as a vault in Obsidian to browse it there.';
  document.getElementById('vobs').href='obsidian://open?path='+encodeURIComponent(d.dir);
  var old=V.byId;V.byId={};var rooms=ROOM_ORDER;
  var isIndex=function(n){return n.id==='Brain'||/\/index$/.test(n.id)};V.nodes=d.nodes.filter(function(n){return !V.hidden[n.room]&&(V.showIndex||!isIndex(n))}).map(function(n,i){var o=old[n.id];var a=(rooms.indexOf(n.room)+1)/rooms.length*Math.PI*2+Math.random()*.6;var r=180+Math.random()*120;
    var node=Object.assign({},n,o?{x:o.x,y:o.y,vx:o.vx,vy:o.vy}:{x:Math.cos(a)*r,y:Math.sin(a)*r,vx:0,vy:0});node.deg=0;V.byId[n.id]=node;return node});
  V.links=[];V.nodes.forEach(function(n){n.links.forEach(function(t){var b=V.byId[t];if(b){V.links.push({a:n,b:b});n.deg++;b.deg++}})});
  V.nodes.forEach(function(n){n.r=2.5+Math.sqrt(n.deg)*1.5});
  V.alpha=1;V.settled=false;if(!V.raf)V.raf=requestAnimationFrame(vtick);
}
function vtick(){
  var c=V.canvas;if(!c||!document.body.contains(c)){V.raf=null;return}
  var dpr=window.devicePixelRatio||1,w=c.clientWidth,h=c.clientHeight;if(c.width!==Math.round(w*dpr)){c.width=Math.round(w*dpr);c.height=Math.round(h*dpr)}
  if(V.alpha>0.004){var N=V.nodes,i,j,a,b,dx,dy,d2,f;
    for(i=0;i<N.length;i++){a=N[i];for(j=i+1;j<N.length;j++){b=N[j];dx=a.x-b.x;dy=a.y-b.y;d2=dx*dx+dy*dy;if(d2>160000)continue;if(d2<1){dx=Math.random()-.5;dy=Math.random()-.5;d2=1}f=Math.min(700/d2,3);dx*=f;dy*=f;a.vx+=dx;a.vy+=dy;b.vx-=dx;b.vy-=dy}}
    V.links.forEach(function(l){dx=l.b.x-l.a.x;dy=l.b.y-l.a.y;var d=Math.sqrt(dx*dx+dy*dy)||1;/* as in d3-force: a link pulls with 1/min(degree) so busy notes can't be yanked by all their links at once, and the lighter end moves more */var k=(d-30)/d*.5/Math.max(1,Math.min(l.a.deg,l.b.deg));var bias=l.a.deg/(l.a.deg+l.b.deg);dx*=k;dy*=k;l.b.vx-=dx*bias;l.b.vy-=dy*bias;l.a.vx+=dx*(1-bias);l.a.vy+=dy*(1-bias)});
    N.forEach(function(n){n.vx-=n.x*.004;n.vy-=n.y*.004;if(n===V.drag)return;n.vx*=.55;n.vy*=.55;var sp=Math.sqrt(n.vx*n.vx+n.vy*n.vy);if(sp>40){n.vx*=40/sp;n.vy*=40/sp}n.x+=n.vx*V.alpha;n.y+=n.vy*V.alpha});/* keep the graph's centre at the origin (d3's forceCenter), so it never drifts away from the view */if(!V.drag){var mx=0,my=0;N.forEach(function(n){mx+=n.x;my+=n.y});mx/=N.length||1;my/=N.length||1;N.forEach(function(n){n.x-=mx;n.y-=my})}
    V.alpha*=.985;if(!V.touched)fitVault(true)}
  var settling=V.alpha>0.004||V.drag;if(!settling&&!V.touched&&!V.settled){V.settled=true;fitVault(false)}drawVault();V.raf=settling?requestAnimationFrame(vtick):null;
}
function kick(){if(!V.raf)V.raf=requestAnimationFrame(vtick)}
function fitVault(smooth){if(!V.nodes.length||!V.canvas)return;var x0=1e9,y0=1e9,x1=-1e9,y1=-1e9;V.nodes.forEach(function(n){x0=Math.min(x0,n.x);y0=Math.min(y0,n.y);x1=Math.max(x1,n.x);y1=Math.max(y1,n.y)});
  var w=V.canvas.clientWidth,h=V.canvas.clientHeight;var k=Math.min(2.5,Math.min(w/((x1-x0)+80),h/((y1-y0)+80))),cx=(x0+x1)/2,cy=(y0+y1)/2;if(smooth){V.cam.k+=(k-V.cam.k)*.15;V.cam.x+=(cx-V.cam.x)*.15;V.cam.y+=(cy-V.cam.y)*.15}else{V.cam.k=k;V.cam.x=cx;V.cam.y=cy;V.touched=false;drawVault()}}
function toScreen(n){var c=V.canvas;return [(n.x-V.cam.x)*V.cam.k+c.clientWidth/2,(n.y-V.cam.y)*V.cam.k+c.clientHeight/2]}
function toWorld(sx,sy){var c=V.canvas;return [(sx-c.clientWidth/2)/V.cam.k+V.cam.x,(sy-c.clientHeight/2)/V.cam.k+V.cam.y]}
function drawVault(){
  var c=V.canvas,ctx=c.getContext('2d'),dpr=window.devicePixelRatio||1,w=c.clientWidth,h=c.clientHeight;ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,w,h);
  var focus=V.hover||(V.open&&V.byId[V.open]);var near={};if(focus){near[focus.id]=1;V.links.forEach(function(l){if(l.a===focus)near[l.b.id]=1;if(l.b===focus)near[l.a.id]=1})}
  var q=V.query.trim().toLowerCase();var match=function(n){return !q||n.title.toLowerCase().indexOf(q)>=0||n.id.toLowerCase().indexOf(q)>=0};
  var line=cssVar('--muted'),ink=cssVar('--ink');ctx.lineWidth=1;
  V.links.forEach(function(l){var on=focus&&(l.a===focus||l.b===focus);var p=toScreen(l.a),r=toScreen(l.b);ctx.strokeStyle=on?roomColor(focus.room):line;ctx.globalAlpha=on?.9:focus||q?.04:.1;ctx.lineWidth=on?1.2:.7;ctx.beginPath();ctx.moveTo(p[0],p[1]);ctx.lineTo(r[0],r[1]);ctx.stroke()});
  var placed=[];var k=V.cam.k;
  V.nodes.slice().sort(function(a,b){return a.deg-b.deg}).forEach(function(n){var p=toScreen(n);if(p[0]<-20||p[1]<-20||p[0]>w+20||p[1]>h+20)return;var dim=(focus&&!near[n.id])||(q&&!match(n));var r=Math.max(2,n.r*Math.min(1.6,Math.sqrt(k)));
    ctx.globalAlpha=dim?.15:1;ctx.fillStyle=roomColor(n.room);ctx.beginPath();ctx.arc(p[0],p[1],r,0,7);ctx.fill();if(n.kept){ctx.strokeStyle=ink;ctx.lineWidth=1.2;ctx.stroke();ctx.lineWidth=1}n.sx=p[0];n.sy=p[1];n.sr=r});
  // Labels like Obsidian: hubs always, the rest as you zoom in, never on top of each other.
  ctx.font='12px ui-sans-serif,system-ui,sans-serif';ctx.textAlign='center';
  V.nodes.slice().sort(function(a,b){return b.deg-a.deg}).forEach(function(n){if(n.sx===undefined)return;var show=n===focus||near[n.id]&&focus||(q&&match(n))||n.deg>=10||k>1.6||(k>1.1&&n.deg>=4);if(!show)return;if((focus&&!near[n.id])||(q&&!match(n)))return;
    var t=n.title.length>40&&n!==focus?n.title.slice(0,38)+'…':n.title;var tw=ctx.measureText(t).width;var x=n.sx,y=n.sy+n.sr+13;var box=[x-tw/2-3,y-11,x+tw/2+3,y+4];
    if(placed.some(function(b){return box[0]<b[2]&&box[2]>b[0]&&box[1]<b[3]&&box[3]>b[1]}))return;placed.push(box);ctx.globalAlpha=n===focus?1:.85;ctx.fillStyle=ink;ctx.fillText(t,x,y)});
  ctx.globalAlpha=1;
}
function vaultNodeAt(x,y){for(var i=V.nodes.length-1;i>=0;i--){var n=V.nodes[i];if(n.sx===undefined)continue;var r=Math.max(6,n.sr+3);if((n.sx-x)*(n.sx-x)+(n.sy-y)*(n.sy-y)<r*r)return n}return null}
function bindVault(){var c=V.canvas;function pos(e){var b=c.getBoundingClientRect();return [e.clientX-b.left,e.clientY-b.top]}
  c.onwheel=function(e){e.preventDefault();V.touched=true;var p=pos(e);var before=toWorld(p[0],p[1]);V.cam.k=Math.max(.15,Math.min(6,V.cam.k*Math.exp(-e.deltaY*.0015)));var after=toWorld(p[0],p[1]);V.cam.x+=before[0]-after[0];V.cam.y+=before[1]-after[1];drawVault()};
  c.onmousedown=function(e){var p=pos(e);var n=vaultNodeAt(p[0],p[1]);V.moved=false;if(n){V.drag=n;V.alpha=Math.max(V.alpha,.3);kick()}else V.pan={x:p[0],y:p[1],cx:V.cam.x,cy:V.cam.y}};
  c.onmousemove=function(e){var p=pos(e);if(V.drag){var wpt=toWorld(p[0],p[1]);V.drag.x=wpt[0];V.drag.y=wpt[1];V.drag.vx=V.drag.vy=0;V.moved=true;return}
    if(V.pan){V.cam.x=V.pan.cx-(p[0]-V.pan.x)/V.cam.k;V.cam.y=V.pan.cy-(p[1]-V.pan.y)/V.cam.k;V.moved=true;V.touched=true;drawVault();return}
    var n=vaultNodeAt(p[0],p[1]);if(n!==V.hover){V.hover=n;c.style.cursor=n?'pointer':'grab';drawVault()}};
  window.addEventListener('mouseup',function(){if(V.drag&&!V.moved)openNote(V.drag.id);V.drag=null;V.pan=null});
  c.onmouseleave=function(){V.hover=null;drawVault()};
  document.getElementById('vfit').onclick=function(){fitVault(false)};
  document.getElementById('vfolder').onclick=function(){post('/api/open-vault',{})};
  var s=document.getElementById('vsearch');s.oninput=function(){V.query=s.value;drawVault()};s.onkeydown=function(e){if(e.key==='Enter'){var q=V.query.toLowerCase();var n=V.nodes.filter(function(x){return x.title.toLowerCase().indexOf(q)>=0})[0];if(n){V.touched=true;V.cam.x=n.x;V.cam.y=n.y;V.cam.k=Math.max(V.cam.k,1.8);openNote(n.id)}}};
}
function mdToHtml(md){
  var body=md.replace(/^---[\s\S]*?---\n/,'');var out=[];var list=false;
  body.split('\n').forEach(function(raw){var l=esc(raw);
    l=l.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g,'<a href="#" data-note="$1">$2</a>').replace(/\[\[([^\]]+)\]\]/g,function(m,t){return '<a href="#" data-note="'+t+'">'+t.split('/').pop()+'</a>'})
      .replace(/\*\*([^*]+)\*\*/g,'<b>$1</b>').replace(/\x60([^\x60]+)\x60/g,'<code>$1</code>');
    var mm;if((mm=/^(#{1,3}) (.*)$/.exec(l))){if(list){out.push('</ul>');list=false}out.push('<h'+(mm[1].length+2)+'>'+mm[2]+'</h'+(mm[1].length+2)+'>');return}
    if(/^\s*- /.test(l)){if(!list){out.push('<ul>');list=true}out.push('<li>'+l.replace(/^\s*- /,'')+'</li>');return}
    if(list){out.push('</ul>');list=false}if(l.trim())out.push('<p>'+l+'</p>')});
  if(list)out.push('</ul>');return out.join('');
}
function openNote(id){
  var n=V.byId[id];var panel=document.getElementById('nodecard');if(!panel)return;V.open=id;drawVault();
  if(!n&&V.data){var d=V.data.nodes.filter(function(x){return x.id===id})[0];if(d&&V.hidden[d.room]){V.hidden[d.room]=false;buildVault(V.data)}}
  api('/api/note?id='+encodeURIComponent(id)).then(function(r){if(r.error){toast(r.error);return}
    panel.innerHTML='<div class="actions" style="margin:0 0 6px;justify-content:space-between"><span class="sub mono">'+esc(id)+'</span><button class="ghost" id="closeNote">✕</button></div><div class="note">'+mdToHtml(r.markdown)+'</div>';panel.style.display='block';
    document.getElementById('closeNote').onclick=function(){panel.style.display='none';V.open=null;drawVault()};
    panel.querySelectorAll('[data-note]').forEach(function(a){a.onclick=function(e){e.preventDefault();var t=a.dataset.note;var target=V.byId[t]||V.nodes.filter(function(x){return x.id.split('/').pop()===t.split('/').pop()})[0];if(target){V.cam.x=target.x;V.cam.y=target.y;openNote(target.id)}else openNote(t)}});
  });
}

function renderBrainView(fresh){renderBrain(fresh)}
function render(){if(!S)return;document.getElementById('repo').textContent=S.root.split('/').pop();renderNav();
  if(view==='home')renderHome();else if(view==='activity')renderActivity();else if(view==='brain')renderBrainView(!document.getElementById('graph'));else if(view==='settings'){if(!(settings&&settings.dirty))renderSettings()}else renderTask()}
api('/api/snapshot').then(function(x){if(x.error){document.getElementById('main').innerHTML='<div class="empty">'+esc(x.error)+'</div>';return}S=x;render()}).catch(function(){document.getElementById('live').classList.add('off')});
var es=new EventSource('/api/events?token='+encodeURIComponent(token));es.addEventListener('snapshot',function(e){S=JSON.parse(e.data);render()});es.onerror=function(){document.getElementById('live').classList.add('off')};es.onopen=function(){document.getElementById('live').classList.remove('off')};
})();
</script></body></html>`;
