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
 :root{color-scheme:light;--bg:#fcfcfc;--side:#f4f4f5;--glow:#fcfcfc;--card:#ffffff;--raised:#e7e7e9;--soft:#f0f0f1;--ink:#18181b;--muted:#5f5f66;--faint:#9b9ba1;--line:#e4e4e7;--accent:#18181b;--accent-soft:#ececee;--accent-ink:#fafafa;--review:#b7830b;--ok:#15803d;--bad:#d1352b;--warn:#c4620f;--blue:#0f8f8a;--purple:#7c4dd6;--teal:#0f8f8a;--diff-bg:#ffffff;--diff-head:#f4f4f5;--diff-ink:#18181b;--add-bg:#d7f5df;--add-ln:#b4ebc3;--add-ink:#0b5a26;--del-bg:#fde2e0;--del-ln:#f9c3bf;--del-ink:#8f1610;--hunk-bg:#f0f0f1;--mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace;--sans:-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",system-ui,sans-serif;--glass:rgba(255,255,255,.46);--glass-tint:rgba(255,255,255,.55);--glass-line:rgba(15,15,20,.09);--glass-hi:rgba(255,255,255,.95);--glass-pick:rgba(15,15,20,.05);--glass-shadow:0 18px 50px -12px rgba(15,15,25,.22),0 2px 8px rgba(15,15,25,.06)}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){color-scheme:dark;--bg:#0a0a0a;--side:#0f0f0f;--glow:#0a0a0a;--card:#141414;--raised:#242424;--soft:#1b1b1b;--ink:#ededed;--muted:#a1a1a1;--faint:#6b6b6b;--line:#232323;--accent:#ededed;--accent-soft:#242424;--accent-ink:#111111;--review:#e8b84a;--ok:#3fb968;--bad:#f2564c;--warn:#f0883e;--blue:#3cc7bd;--purple:#b48cf2;--teal:#3cc7bd;--diff-bg:#070707;--diff-head:#121212;--diff-ink:#e6e6e6;--add-bg:#0f2e1a;--add-ln:#16422a;--add-ink:#8af0ab;--del-bg:#3a1214;--del-ln:#541a1d;--del-ink:#ffa39c;--hunk-bg:#111111;--glass:rgba(28,28,30,.3);--glass-tint:rgba(255,255,255,.07);--glass-line:rgba(255,255,255,.13);--glass-hi:rgba(255,255,255,.16);--glass-pick:rgba(255,255,255,.08);--glass-shadow:0 24px 60px -14px rgba(0,0,0,.85),0 2px 10px rgba(0,0,0,.4)}}
:root[data-theme="dark"]{color-scheme:dark;--bg:#0a0a0a;--side:#0f0f0f;--glow:#0a0a0a;--card:#141414;--raised:#242424;--soft:#1b1b1b;--ink:#ededed;--muted:#a1a1a1;--faint:#6b6b6b;--line:#232323;--accent:#ededed;--accent-soft:#242424;--accent-ink:#111111;--review:#e8b84a;--ok:#3fb968;--bad:#f2564c;--warn:#f0883e;--blue:#3cc7bd;--purple:#b48cf2;--teal:#3cc7bd;--diff-bg:#070707;--diff-head:#121212;--diff-ink:#e6e6e6;--add-bg:#0f2e1a;--add-ln:#16422a;--add-ink:#8af0ab;--del-bg:#3a1214;--del-ln:#541a1d;--del-ink:#ffa39c;--hunk-bg:#111111;--glass:rgba(28,28,30,.3);--glass-tint:rgba(255,255,255,.07);--glass-line:rgba(255,255,255,.13);--glass-hi:rgba(255,255,255,.16);--glass-pick:rgba(255,255,255,.08);--glass-shadow:0 24px 60px -14px rgba(0,0,0,.85),0 2px 10px rgba(0,0,0,.4)}
*{box-sizing:border-box}html,body{height:100%}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.55 var(--sans);-webkit-font-smoothing:antialiased}
button,select,textarea,input{font:inherit;color:inherit}button{cursor:pointer;border:1px solid var(--line);background:var(--card);border-radius:9px;padding:8px 14px;transition:border-color .15s,background .15s,transform .15s}button:hover{border-color:var(--faint);background:var(--soft)}button:active{transform:scale(.98)}button.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-ink);font-weight:600;box-shadow:none}button.primary:hover{filter:brightness(1.04);background:var(--accent)}button.ghost{border-color:transparent;background:transparent;color:var(--muted)}button.ghost:hover{background:var(--soft)}button:disabled{opacity:.5;cursor:default}
select{border:1px solid var(--line);background:var(--card);border-radius:9px;padding:7px 11px}
textarea{width:100%;border:0;background:transparent;resize:none;outline:none;min-height:52px;font-size:15px}
header{position:sticky;top:0;z-index:5;background:color-mix(in srgb,var(--bg) 88%,transparent);backdrop-filter:saturate(180%) blur(18px);border-bottom:1px solid color-mix(in srgb,var(--line) 75%,transparent)}
.bar{max-width:1100px;margin:0 auto;padding:15px 24px;display:flex;align-items:center;gap:18px;flex-wrap:wrap}
.brand{display:flex;align-items:center;gap:9px;font-weight:650;font-size:16px;letter-spacing:-.01em}.brand .star{display:grid;place-items:center;width:22px;height:22px;border-radius:7px;background:var(--ink);color:var(--bg);font-size:14px}.repo{color:var(--muted);font-weight:400;font-family:var(--mono);font-size:12px}
nav{display:flex;gap:2px;margin-left:auto}nav button{border:0;background:transparent;color:var(--muted);padding:7px 12px;border-radius:8px}nav button.on{background:var(--ink);color:var(--bg);font-weight:600}
.live{width:8px;height:8px;border-radius:50%;background:var(--ok)}.live.off{background:var(--faint)}

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
.check{font-family:var(--mono);font-size:12.5px}.ok{color:var(--ok)}.row.closed>span:nth-child(2){color:var(--faint);text-decoration:line-through}.x{color:var(--faint)}button.more{display:block;margin:8px auto;background:none;border:0;color:var(--accent);cursor:pointer;font:inherit}.bad{color:var(--bad)}
.flag{background:color-mix(in srgb,var(--bad) 9%,transparent);border-radius:8px;padding:7px 10px;margin:8px 0;font-size:13px}.flag b{color:var(--bad)}
.actions{display:flex;gap:8px;margin-top:10px;flex-wrap:wrap;align-items:center}
.notes{width:100%;border:1px solid var(--line);border-radius:8px;background:var(--bg);padding:8px 10px;min-height:44px;margin-top:10px;font-size:13.5px;resize:vertical}
.meter{height:6px;border-radius:3px;background:var(--line);position:relative;overflow:hidden;margin:10px 0 4px}.meter .a{position:absolute;left:0;top:0;bottom:0;background:var(--ok)}.meter .c{position:absolute;right:0;top:0;bottom:0;background:var(--bad)}.meter .q{position:absolute;top:0;bottom:0;width:2px;background:var(--ink)}
.empty{color:var(--muted);background:var(--card);border:1px dashed var(--line);border-radius:12px;padding:18px;text-align:center;font-size:13.5px}
details summary{cursor:pointer;color:var(--muted);margin:24px 4px 8px;font-size:13px}details .row{display:flex;gap:10px;padding:7px 4px;border-bottom:1px solid var(--line);font-size:13.5px}details .row .sub{margin-left:auto;white-space:nowrap}
.feed .row{display:grid;grid-template-columns:70px 130px minmax(0,1fr);gap:10px;padding:7px 2px;border-bottom:1px solid var(--line);font-size:13.5px}.feed .t{font-family:var(--mono);font-size:12px;color:var(--faint)}.feed .who{font-weight:600;font-size:13px}
.filters{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px}.chip{border-radius:999px;padding:3px 11px;font-size:12.5px}.chip.on{border-color:var(--accent);color:var(--accent)}
#graphWrap{position:relative;height:calc(100vh - 130px);min-height:440px;background:var(--card);border:1px solid var(--line);border-radius:14px;overflow:hidden}canvas{display:block;width:100%;height:100%;cursor:grab}
.brainbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:12px}.brainbar .filters{margin:0;flex:1 1 auto}.vsearch{border:1px solid var(--line);background:var(--card);border-radius:9px;padding:7px 11px;font-size:13px;min-width:180px}.btn{display:inline-block;border:1px solid var(--line);background:var(--card);border-radius:9px;padding:8px 14px;color:inherit;text-decoration:none;font-size:14px}.btn:hover{background:var(--soft)}
.ghint{position:absolute;left:12px;bottom:10px;font-size:12px;color:var(--faint)}
.nodecard{position:absolute;right:12px;top:12px;bottom:12px;width:min(380px,calc(100% - 24px));overflow:auto;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px;display:none;box-shadow:0 10px 30px rgba(0,0,0,.18)}
.note h3{font-size:17px;margin:4px 0 8px}.note h4{font-size:14px;margin:14px 0 6px}.note h5{font-size:13px;margin:12px 0 4px}.note p{margin:6px 0;font-size:13.5px}.note ul{padding-left:18px;margin:4px 0}.note li{font-size:13.5px;margin:2px 0}.note a{color:var(--accent);text-decoration:none}.note a:hover{text-decoration:underline}.note code{font:12px var(--mono);background:var(--soft);padding:1px 4px;border-radius:4px}
.set{display:grid;grid-template-columns:180px 1fr;gap:14px;padding:14px 0;border-bottom:1px solid var(--line);align-items:start}.set label{font-weight:600}.set .sub{margin-top:3px}
.seg{display:inline-flex;border:1px solid var(--line);border-radius:9px;overflow:hidden}.seg button{border:0;border-radius:0;background:var(--card)}.seg button.on{background:var(--soft);font-weight:600;color:var(--accent)}
.agents{display:flex;gap:6px;flex-wrap:wrap;margin-top:10px}
.connectorbar{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:16px}.toggle{display:flex;align-items:center;gap:8px;color:var(--muted);font-size:13px}.toggle input{accent-color:var(--accent)}
.connector-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px}.connector-grid .card{margin:0}.connector-head{display:flex;flex-wrap:wrap;justify-content:space-between;gap:6px 10px;align-items:flex-start}.connector-head>:first-child{min-width:0;flex:1 1 160px;overflow-wrap:anywhere}.connector-grid .card{min-width:0;overflow-wrap:anywhere}.connector-chip{border:1px solid var(--line);border-radius:999px;padding:2px 9px;font-size:12px;color:var(--muted);white-space:nowrap}.connector-chip.start{color:var(--blue);border-color:color-mix(in srgb,var(--blue) 35%,var(--line))}.connector-chip.pickup{color:var(--teal);border-color:color-mix(in srgb,var(--teal) 35%,var(--line))}.connector-chip.review{color:var(--purple);border-color:color-mix(in srgb,var(--purple) 35%,var(--line))}
.connector-status{margin-top:8px;font-size:13px}.connector-path{margin-top:8px;font-size:12px;color:var(--muted);overflow-wrap:anywhere}.connector-manual{margin-top:8px;border-left:2px solid var(--line);padding-left:10px;color:var(--muted);font-size:13px}.connector-note{margin-top:8px;color:var(--faint);font-size:12.5px}.connector-off{opacity:.72}
.prmeta{margin:2px 0 4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.title.link{cursor:pointer}.title.link:hover{color:var(--accent)}.prhead{margin:10px 0 14px}.prhead h1{font-size:24px;font-weight:600;letter-spacing:-.01em;margin:0 0 6px;line-height:1.25}.faint{color:var(--faint);font-weight:400}
.prmeta{color:var(--muted);font-size:13px;display:flex;flex-wrap:wrap;gap:6px;align-items:center}.branch{background:var(--soft);border-radius:6px;padding:1px 6px;font-size:12px}
.pill{border-radius:999px;padding:3px 10px;font-size:12px;font-weight:600;color:#fff;background:var(--muted)}.pill.s-done{background:var(--purple)}.pill.s-closed{background:var(--faint)}.step.skip{text-decoration:line-through}.step.skip:before{background:repeating-linear-gradient(90deg,var(--line) 0 6px,transparent 6px 10px)}.pill.s-review,.pill.s-running{background:var(--ok)}.pill.s-failed,.pill.s-blocked{background:var(--bad)}.pill.s-handoff{background:var(--warn)}
.label{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;margin-bottom:6px}.summary{font-size:15px;line-height:1.5;margin-bottom:8px}.ctx{max-height:none!important;white-space:pre-wrap}.objective{color:var(--muted);font-size:13px;line-height:1.5;margin-bottom:14px;white-space:pre-wrap}
.prtabs{display:flex;gap:4px;align-items:center;border-bottom:1px solid var(--line);margin:18px 0 12px}.prtabs button{background:none;border:0;border-bottom:2px solid transparent;border-radius:0;padding:8px 12px;color:var(--muted);font:inherit;cursor:pointer}.prtabs button.on{color:var(--ink);border-bottom-color:var(--accent);font-weight:600}.count{background:var(--soft);border-radius:999px;padding:0 7px;font-size:12px}.grow{flex:1}
.dstat{font:12px var(--mono);display:inline-flex;gap:4px;align-items:center}.dbar{display:inline-flex;gap:1px;margin-left:4px}.dbar i{width:8px;height:8px;border-radius:1px;background:var(--line)}.dbar i.g{background:var(--ok)}.dbar i.r{background:var(--bad)}.dstat .ok{color:var(--ok)}
.filelist{padding:6px 0}.filelist a{display:flex;gap:10px;align-items:center;padding:5px 16px;color:var(--ink);text-decoration:none;font-size:13px}.filelist a:hover{background:var(--soft)}.fs{width:18px;text-align:center;font:600 11px var(--mono);border-radius:4px}.fs.added{color:var(--ok)}.fs.deleted{color:var(--bad)}.fs.modified{color:var(--warn)}.fs.renamed{color:var(--blue)}
.dfile{border:1px solid var(--line);border-radius:10px;margin-bottom:12px;overflow:hidden;background:var(--diff-bg)}.dhead{display:flex;gap:10px;align-items:center;padding:8px 14px;background:var(--diff-head);border-bottom:1px solid var(--line);cursor:pointer;font-size:13px;position:sticky;top:0}.dhead .dstat{margin-left:auto}.caret{color:var(--muted);width:10px}
table.diff{width:100%;border-collapse:collapse;font:12.5px/1.6 var(--mono);table-layout:fixed;background:var(--diff-bg);color:var(--diff-ink)}table.diff td{padding:0 8px;vertical-align:top}table.diff col.lnc{width:52px}table.diff td.ln{text-align:right;color:var(--faint);user-select:none;border-right:1px solid var(--line)}table.diff td.code{white-space:pre-wrap;word-break:break-all}.sign{display:inline-block;width:14px;color:var(--faint);user-select:none}
tr.add td{background:var(--add-bg);color:var(--add-ink)}tr.add td.ln{background:var(--add-ln);color:var(--add-ink)}tr.add .sign{color:var(--add-ink)}tr.del td{background:var(--del-bg);color:var(--del-ink)}tr.del td.ln{background:var(--del-ln);color:var(--del-ink)}tr.del .sign{color:var(--del-ink)}tr.hunk td{background:var(--hunk-bg);color:var(--faint);padding:4px 10px;border-block:1px solid var(--line)}
.commit{display:flex;justify-content:space-between;gap:12px;padding:10px 0;border-bottom:1px solid var(--line)}.commit:last-child{border-bottom:0}.csub{font-weight:600;font-size:14px}.cbody{white-space:pre-wrap;margin:4px 0}.sha{color:var(--muted);font-size:12px}
@media (max-width:640px){.prhead h1{font-size:20px}table.diff col.lnc{width:36px}table.diff td.ln{padding:0 4px}.prtabs{overflow-x:auto}}
.detail pre{font:12px/1.5 var(--mono);background:var(--soft);border-radius:8px;padding:10px;overflow:auto;white-space:pre-wrap;max-height:360px}
.toast{position:fixed;left:50%;bottom:22px;transform:translateX(-50%);background:var(--ink);color:var(--bg);padding:9px 16px;border-radius:9px;font-size:13.5px;display:none;z-index:20;max-width:90vw}
.who-dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;vertical-align:0}
@media (max-width:640px){.feed .row{grid-template-columns:56px minmax(0,1fr)}.feed .who{display:none}.set{grid-template-columns:1fr}nav{margin-left:0}.steps{font-size:10.5px}}
/* ---------- shell: sidebar · view · live rail ---------- */
.app{--sw:264px;--rw:320px;display:grid;grid-template-columns:var(--sw) minmax(0,1fr) var(--rw);height:100%;position:relative}.app.side-min{--sw:60px}.app.rail-off{--rw:0px}.app.rail-off .rail{display:none}
.side{background:var(--side);border-right:1px solid var(--line);display:flex;flex-direction:column;min-height:0;padding:14px 10px 10px;gap:2px;overflow:hidden}
.side .brand{display:flex;align-items:center;gap:9px;padding:4px 8px 12px;font-weight:650;font-size:15px;letter-spacing:-.01em}
.side .brand .mark{display:grid;place-items:center;width:24px;height:24px;border-radius:7px;background:var(--accent);color:var(--accent-ink);font-size:14px;flex:none}
.side .brand .proj{font:12px var(--mono);color:var(--muted);background:var(--soft);border-radius:6px;padding:1px 7px;font-weight:400;max-width:110px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.live{width:7px;height:7px;border-radius:50%;background:var(--ok);margin-left:auto;flex:none;box-shadow:0 0 0 3px color-mix(in srgb,var(--ok) 22%,transparent)}.live.off{background:var(--faint);box-shadow:none}
.newtask{display:flex;align-items:center;gap:8px;width:100%;border:1px solid var(--line);background:var(--card);border-radius:9px;padding:7px 10px;margin:0 0 8px;font-weight:550;color:var(--ink)}
.newtask:hover{border-color:var(--accent)}.newtask kbd{margin-left:auto;font:11px var(--mono);color:var(--faint)}
.navi{display:flex;align-items:center;gap:10px;width:100%;border:0;background:transparent;border-radius:8px;padding:6px 10px;color:var(--muted);text-align:left}
.navi svg{width:16px;height:16px;flex:none;stroke:currentColor;fill:none;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}
.navi:hover{background:var(--soft);color:var(--ink)}.navi.on{background:var(--raised);color:var(--ink);font-weight:600}
.navi .n{margin-left:auto;font-size:11.5px;font-variant-numeric:tabular-nums;color:var(--faint)}.navi .n.hot{color:var(--accent-ink);background:var(--accent);border-radius:999px;padding:0 7px;font-weight:650}
.sgroup{font-size:11px;font-weight:650;letter-spacing:.07em;text-transform:uppercase;color:var(--faint);padding:14px 10px 4px;display:flex;justify-content:space-between}
.slist{overflow:auto;min-height:0;flex:1;margin:0 -4px;padding:0 4px}
.titem{display:flex;align-items:center;gap:9px;width:100%;border:0;background:transparent;border-radius:8px;padding:5px 10px;text-align:left;color:var(--ink);font-size:13px}
.titem:hover{background:var(--soft)}.titem.on{background:var(--raised)}
.titem .tt{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.titem .ta{font-size:11px;color:var(--faint);font-variant-numeric:tabular-nums;flex:none}
.sdot{width:8px;height:8px;border-radius:50%;flex:none;background:var(--faint)}
.sdot.rev{background:var(--review);box-shadow:0 0 0 3px color-mix(in srgb,var(--review) 22%,transparent)}
.sdot.run{background:var(--blue);animation:beat 1.6s ease-in-out infinite}.sdot.wait{background:var(--warn)}.sdot.bad{background:var(--bad);border-radius:2px}
.sdot.done{background:transparent;border:1.5px solid var(--ok)}.sdot.closed{background:transparent;border:1.5px dashed var(--faint)}
@keyframes beat{50%{box-shadow:0 0 0 4px color-mix(in srgb,var(--blue) 28%,transparent)}}
.team{border-top:1px solid var(--line);padding:10px 6px 2px;margin-top:6px;display:flex;flex-direction:column;gap:3px}
.agent{display:flex;align-items:center;gap:8px;font-size:12.5px;color:var(--muted);padding:2px 4px}.agent .sdot{width:7px;height:7px}
.agent .sdot{background:var(--faint)}.agent.up .sdot{background:var(--ok)}.agent.down{opacity:.6}.agent .role{margin-left:auto;font-size:10.5px;font-weight:650;letter-spacing:.05em;text-transform:uppercase;color:var(--accent)}
main{min-width:0;max-width:none;margin:0;overflow:auto;padding:28px clamp(16px,4vw,48px) 28px}
main>*{max-width:900px;margin-left:auto;margin-right:auto}
main.brain>*,main.connectors>*{max-width:1200px}main.home{display:flex;flex-direction:column}main.home>*{width:100%}
main.home .composer{order:99;position:sticky;bottom:0;margin-top:auto;padding-bottom:10px;box-shadow:0 -22px 22px -6px var(--bg),0 28px 0 0 var(--bg)}main.home{padding-bottom:16px}
.pagehead{display:flex;align-items:baseline;gap:12px;margin:0 4px 2px}.pagehead h1{font-size:22px;font-weight:650;letter-spacing:-.02em;margin:0;text-wrap:balance}.pagehead .sub{font-family:var(--mono)}
.rail{border-left:1px solid var(--line);background:var(--side);display:flex;flex-direction:column;min-height:0}
.railhead{display:flex;align-items:center;gap:8px;padding:16px 16px 10px;font-size:11px;font-weight:650;letter-spacing:.07em;text-transform:uppercase;color:var(--faint)}
.stream{overflow:auto;flex:1;padding:0 8px 16px}
.ev{display:grid;grid-template-columns:3px minmax(0,1fr);gap:10px;padding:7px 8px;border-radius:8px;cursor:default}.ev[data-open]{cursor:pointer}.ev[data-open]:hover{background:var(--soft)}
.ev .lane{border-radius:2px}.ev .who{font-size:12px;font-weight:600}.ev .when{font:11px var(--mono);color:var(--faint);margin-left:6px;font-weight:400}
.ev .what{font-size:12.5px;color:var(--muted);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}
.card{border-radius:12px;box-shadow:none}.composer{border-radius:14px}
button.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-ink);font-weight:600}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.nowlist{display:flex;flex-direction:column;gap:6px;padding:0 10px 6px}
.now{display:flex;flex-direction:column;gap:3px;text-align:left;width:100%;border:1px solid var(--line);background:var(--card);border-radius:10px;padding:9px 11px}.now[data-open]:hover{border-color:var(--accent)}.now:disabled{cursor:default;opacity:.85}
.now .who{display:flex;align-items:center;gap:7px;font-size:12.5px;font-weight:600}.now .who .when{margin-left:auto;font:11px var(--sans);color:var(--faint);font-weight:400}.now .tk{font-size:13px}.now .what{font-size:12px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ev .evtask{font-size:11.5px;color:var(--faint);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px}
@media (max-width:1360px){.app{--sw:248px;--rw:0px}.app.side-min{--sw:60px}.rail{display:none}#railBtn{display:none}}
@media (max-width:860px){.app{display:block;height:auto}.side{position:sticky;top:0;z-index:5;flex-direction:row;flex-wrap:wrap;align-items:center;padding:10px 12px;border-right:0;border-bottom:1px solid var(--line);gap:4px}
.side .brand{padding:0 8px 0 0}.side .newtask,.side .sgroup,.side .slist,.side .team{display:none}.navi{width:auto;padding:5px 9px}.navi span:not(.n){display:none}main{overflow:visible}}
@media (prefers-reduced-motion:reduce){.sdot.run{animation:none}}
.pill.s-done{background:var(--purple)}.pill.s-review{background:var(--review);color:#1a1405}.pill.s-running{background:var(--blue)}.pill.s-closed{background:transparent;color:var(--muted);border:1px dashed var(--faint)}
.card.need{border-left:3px solid var(--review)}.navi .n.hot{background:var(--review);color:#1a1405}
.composer{background:linear-gradient(160deg,var(--glass-tint),transparent 55%),var(--glass);-webkit-backdrop-filter:blur(28px) saturate(190%);backdrop-filter:blur(28px) saturate(190%);border:1px solid var(--glass-line);border-radius:20px;box-shadow:inset 0 1px 0 var(--glass-hi),inset 0 0 0 1px rgba(255,255,255,.02),var(--glass-shadow)}.composer:focus-within{border-color:color-mix(in srgb,var(--ink) 28%,var(--glass-line));box-shadow:inset 0 1px 0 var(--glass-hi),0 0 0 4px color-mix(in srgb,var(--ink) 7%,transparent),var(--glass-shadow)}.composer textarea,.composer textarea:focus-visible{outline:none;background:transparent}.composer .pick,.composer select{background:var(--glass-pick);border:1px solid var(--glass-line);border-radius:999px;-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px)}.composer .pick:hover,.composer select:hover{background:color-mix(in srgb,var(--ink) 10%,transparent)}.composer button.primary{border-radius:999px;padding:8px 18px;box-shadow:inset 0 1px 0 rgba(255,255,255,.35),0 4px 14px -4px rgba(0,0,0,.35)}main.home .composer{box-shadow:inset 0 1px 0 var(--glass-hi),var(--glass-shadow);margin-bottom:6px}main.home .composer:focus-within{box-shadow:inset 0 1px 0 var(--glass-hi),0 0 0 4px color-mix(in srgb,var(--ink) 7%,transparent),var(--glass-shadow)}@supports not ((backdrop-filter:blur(1px)) or (-webkit-backdrop-filter:blur(1px))){.composer{background:var(--card)}}
.gitbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:10px 4px 16px}.gitbar .btn,.gitbar button{display:inline-flex;align-items:center;gap:6px;font-size:13px;padding:6px 12px}.gi{stroke:currentColor;fill:none;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round;flex:none;vertical-align:-2px}.gstat{display:inline-flex;align-items:center;gap:6px;font-size:12.5px;color:var(--muted);background:var(--soft);border:1px solid var(--line);border-radius:999px;padding:4px 11px}.gstat.up{color:var(--review);border-color:color-mix(in srgb,var(--review) 40%,var(--line))}.gstat.down{color:var(--teal);border-color:color-mix(in srgb,var(--teal) 40%,var(--line))}.gitcols{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,300px),1fr));gap:12px}.gcard{margin:0;min-width:0;max-height:260px;display:flex;flex-direction:column}.gcard>.gwts,.gcard>.gchanges{overflow:auto;min-height:0}.gchanges{overflow:auto}.gch{display:flex;gap:8px;align-items:center;font-size:12.5px;padding:2px 0;min-width:0}.gch .mono{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.gwt{display:flex;gap:10px;align-items:flex-start;padding:7px 6px;border-radius:8px;min-width:0}.gwt[data-open]{cursor:pointer}.gwt[data-open]:hover{background:var(--soft)}.gwt .sdot{margin-top:6px}.gwtb{min-width:0}.gwtn{font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.gwt .sub{font-size:11.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.glegend{margin-left:auto;display:inline-flex;align-items:center;gap:5px;text-transform:none;letter-spacing:0;font-weight:400;font-size:12px;color:var(--faint)}.ggraph{background:var(--diff-bg);border:1px solid var(--line);border-radius:12px;padding:4px 0;overflow-x:auto}.gr{display:grid;grid-template-columns:auto minmax(0,1fr) auto auto auto auto;align-items:center;gap:10px;padding-right:12px;min-height:32px;font-size:13px}.gr:hover{background:var(--soft)}.gr.head .gs{font-weight:600}.gg{display:block;flex:none}.gg path{fill:none;stroke-width:2}.gmsg{display:flex;align-items:center;gap:5px;min-width:0}.gs{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.gauth{color:var(--muted);font-size:12px;white-space:nowrap;max-width:140px;overflow:hidden;text-overflow:ellipsis}.gwhen{color:var(--faint);font-size:12px;white-space:nowrap;font-variant-numeric:tabular-nums}.gwhere{color:var(--faint);display:inline-flex}.gwhere.local{color:var(--review)}.gsha{font:11.5px var(--mono);color:var(--faint);text-decoration:none}a.gsha:hover{color:var(--ink);text-decoration:underline}.ref{display:inline-flex;align-items:center;gap:4px;flex:none;font:11px var(--mono);padding:1px 7px;border-radius:999px;border:1px solid var(--line);background:var(--card);color:var(--muted);white-space:nowrap;max-width:240px;overflow:hidden;text-overflow:ellipsis}.ref[data-open]{cursor:pointer}.ref[data-open]:hover{border-color:var(--faint);color:var(--ink)}.ref.head{background:var(--ink);color:var(--bg);border-color:var(--ink);font-weight:600}.ref.remote{color:var(--teal);border-color:color-mix(in srgb,var(--teal) 35%,var(--line))}.ref.tag{color:var(--review);border-color:color-mix(in srgb,var(--review) 35%,var(--line))}@media (max-width:760px){.gr{grid-template-columns:auto minmax(0,1fr) auto}.gauth,.gwhere,.gsha{display:none}}
.ptog{display:grid;place-items:center;width:30px;height:30px;padding:0;border:0;border-radius:8px;background:transparent;color:var(--faint);flex:none}.ptog:hover{background:var(--soft);color:var(--ink)}.ptog svg{stroke:currentColor;fill:none;stroke-width:1.7}.ptog.on{color:var(--muted)}.side .brand .ptog{margin-left:auto}.ptog.float{position:absolute;top:12px;right:calc(var(--rw) + 12px);z-index:6;background:color-mix(in srgb,var(--bg) 70%,transparent);-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);border:1px solid var(--line)}.app.side-min .side{padding:14px 8px 10px;align-items:center}.app.side-min .side .brand{flex-direction:column;gap:10px;padding:0}.app.side-min .side .brand .bname,.app.side-min .side .brand .proj,.app.side-min .side .brand .live,.app.side-min .slist,.app.side-min .team,.app.side-min .navi span:not(.n),.app.side-min .newtask kbd{display:none}.app.side-min .side .brand .ptog{margin:0}.app.side-min .newtask{width:40px;height:36px;padding:0;justify-content:center;font-size:0;gap:0}.app.side-min .navi{width:40px;height:36px;padding:0;justify-content:center;position:relative}.app.side-min .navi .n{position:absolute;top:2px;right:0;margin:0;font-size:10px;padding:0 5px}main.chatmode>*{max-width:780px}.chathead{display:flex;align-items:center;gap:8px}.msgs{display:flex;flex-direction:column;gap:18px;padding:18px 0 28px}.chatempty{margin:12vh auto 0;text-align:center;display:flex;flex-direction:column;gap:10px;align-items:center;max-width:560px}.chatempty .hello{font-size:26px;font-weight:600;letter-spacing:-.02em;text-wrap:balance}.sugg{display:flex;flex-wrap:wrap;gap:8px;justify-content:center;margin-top:10px}.sugg .chip{padding:7px 14px;font-size:13px;background:var(--card)}.msg.me{display:flex;justify-content:flex-end}.msg.me .bubble{max-width:78%;background:var(--raised);border-radius:18px 18px 4px 18px;padding:10px 15px;font-size:14.5px;line-height:1.55;overflow-wrap:anywhere}.msg.ai .who{display:flex;align-items:center;gap:7px;font-size:12.5px;font-weight:600;color:var(--muted);margin-bottom:6px}.msg.ai .body{font-size:14.5px;line-height:1.65;overflow-wrap:anywhere}.msg.ai.err .body{color:var(--bad)}.msg code{font:12.5px var(--mono);background:var(--soft);border:1px solid var(--line);border-radius:5px;padding:1px 5px}.msg pre.cb{background:var(--diff-bg);border:1px solid var(--line);border-radius:10px;padding:12px 14px;overflow-x:auto;margin:8px 0;font:12.5px/1.6 var(--mono)}.msg pre.cb code{background:none;border:0;padding:0}.typing{display:inline-flex;gap:5px;padding:8px 2px}.typing i{width:7px;height:7px;border-radius:50%;background:var(--faint);animation:blink 1.2s infinite ease-in-out}.typing i:nth-child(2){animation-delay:.15s}.typing i:nth-child(3){animation-delay:.3s}@keyframes blink{0%,80%,100%{opacity:.25;transform:translateY(0)}40%{opacity:1;transform:translateY(-3px)}}main.chatmode .composer{margin-top:auto}@media (max-width:860px){.ptog{display:none}}
.app.side-min main>*,.app.rail-off main>*{max-width:1160px}.app.side-min.rail-off main>*{max-width:1320px}.app.side-min main.chatmode>*,.app.rail-off main.chatmode>*{max-width:960px}.app.side-min.rail-off main.chatmode>*{max-width:1080px}.app.side-min main.brain>*,.app.side-min main.connectors>*,.app.rail-off main.brain>*,.app.rail-off main.connectors>*{max-width:1400px}
main.home>.composer{max-width:720px!important;width:100%;align-self:center;margin-left:auto;margin-right:auto;margin-bottom:14px;padding:12px 14px 9px;border-radius:18px}main.home>.composer textarea{min-height:40px;font-size:14.5px}main.home>.composer .row{gap:7px;margin-top:4px}main.home>.composer .pick,main.home>.composer select{flex:0 1 auto;max-width:230px;font-size:12.5px;padding:4px 10px;text-overflow:ellipsis}main.home>.composer .hint{font-size:11.5px;color:var(--faint);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;flex:1 1 0}main.home>.composer button.primary{padding:6px 15px;font-size:13px}
.scrim{display:none;position:absolute;left:var(--sw);right:var(--rw);bottom:0;height:150px;pointer-events:none;z-index:5;background:linear-gradient(to top,var(--bg) 0,var(--bg) 38%,color-mix(in srgb,var(--bg) 0%,transparent) 100%)}.app.on-home .scrim{display:block}main.home>.composer{z-index:7;box-shadow:inset 0 1px 0 var(--glass-hi),0 0 0 1px color-mix(in srgb,var(--ink) 4%,transparent),0 24px 60px -16px rgba(0,0,0,.55),0 6px 18px -8px rgba(0,0,0,.35)}main.home>.composer .hint{display:none}main.home>.composer .row{justify-content:flex-start}main.home>.composer #send{margin-left:auto}main.home>.composer .pick,main.home>.composer select{field-sizing:content;min-width:0;max-width:220px}main.home>.composer textarea{padding:2px 2px 0}@media (max-width:860px){.scrim{left:0;right:0}}
.themebtn{display:flex;align-items:center;gap:8px;width:100%;border:0;background:transparent;border-radius:8px;padding:6px 10px;margin-top:4px;color:var(--muted);font-size:12.5px;text-align:left}.themebtn:hover{background:var(--soft);color:var(--ink)}.themebtn svg{stroke:currentColor;fill:none;stroke-width:1.7;stroke-linecap:round;flex:none}.app.side-min .themebtn{width:40px;height:36px;padding:0;justify-content:center}.app.side-min .themebtn span{display:none}@media (max-width:860px){.side .themebtn{width:auto;margin:0 0 0 auto}.side .themebtn span{display:none}}
</style></head><body>
<div class="app"><aside class="side" id="side" aria-label="AgentBrain"></aside><main id="main"></main><div class="scrim" aria-hidden="true"></div><button class="ptog float" id="railBtn" aria-label="Toggle live activity"><svg viewBox="0 0 24 24" width="16" height="16"><rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M14.5 4.5v15"/></svg></button><aside class="rail" id="rail" aria-label="Live activity"></aside></div><div class="toast" id="toast"></div>
<script>
(function(){
var token=location.hash.replace(/^#token=/,'');var S=null;var pick=localGet('pick')||'auto';var mode=localGet('mode')||'chat';var chatLog=(function(){try{var c=JSON.parse(localGet('chat')||'[]');return Array.isArray(c)?c:[]}catch(e){return []}})();var chatPending=null;var chatStream='';var lastChatLen=-1;var view=localGet('view')||'home';var selectedTask=null;var drafts={};var composer='';var agentFilter=null;var settings=null;var taskFilter='all';var taskSearch='';var goKey=false;var connectors=null;var connectorsAll=localGet('connectorsAll')==='1';var connectorsLoadedAll=null;var connectorsLoading=false;
function localGet(k){try{return localStorage.getItem('ab.'+k)}catch(e){return null}}function localSet(k,v){try{localStorage.setItem('ab.'+k,v)}catch(e){}}
var THEME_ICON={system:'<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',light:'<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',dark:'<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>'};
var THEME_NAME={system:'System',light:'Light',dark:'Dark'};
function theme(){var t=localGet('theme');return t==='light'||t==='dark'?t:'system'}
function applyTheme(){var t=theme();if(t==='system')document.documentElement.removeAttribute('data-theme');else document.documentElement.setAttribute('data-theme',t);var b=document.getElementById('themeBtn');if(b){b.innerHTML='<svg viewBox="0 0 24 24" width="15" height="15">'+THEME_ICON[t]+'</svg><span>'+THEME_NAME[t]+'</span>';b.title='Theme: '+THEME_NAME[t]+' (click to change)'}}
function setTheme(t){localSet('theme',t);applyTheme();if(view==='settings'&&!(settings&&settings.dirty))renderSettings()}
function cycleTheme(){var order=['system','light','dark'];setTheme(order[(order.indexOf(theme())+1)%3])}
applyTheme();
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
function api(p,o){o=o||{};o.headers=Object.assign({'x-agentbrain-token':token,'content-type':'application/json'},o.headers||{});return fetch(p,o).then(function(r){return r.json()})}
function post(p,b){return api(p,{method:'POST',body:JSON.stringify(b)}).then(function(r){if(r&&r.error)toast(r.error);return r})}
function toast(t){var el=document.getElementById('toast');el.textContent=t;el.style.display='block';clearTimeout(toast.t);toast.t=setTimeout(function(){el.style.display='none'},3500)}
function ago(iso){if(!iso)return '';var s=Math.max(0,(Date.now()-Date.parse(iso))/1000);if(s<60)return 'just now';if(s<3600)return Math.floor(s/60)+'m ago';if(s<86400)return Math.floor(s/3600)+'h ago';return Math.floor(s/86400)+'d ago'}
function hhmm(iso){var d=new Date(iso);var t=d.toTimeString().slice(0,5);return d.toDateString()===new Date().toDateString()?t:d.toLocaleDateString(undefined,{month:'short',day:'numeric'})+' '+t}
var PALETTE=['#a1a1aa','#3fb968','#b48cf2','#e8b84a','#f2564c','#3cc7bd','#f07ab4'];
function color(id){if(id==='developer')return 'var(--ink)';if(id==='agentbrain'||id==='council')return 'var(--accent)';var h=0;for(var i=0;i<id.length;i++)h=(h*31+id.charCodeAt(i))>>>0;return PALETTE[h%PALETTE.length]}
var NAMES={'claude-code':'Claude Code','vscode':'Copilot (VS Code)','codex':'Codex','gemini':'Gemini','cursor':'Cursor','copilot':'Copilot CLI','aider':'Aider','developer':'You','agentbrain':'AgentBrain','council':'Council','ollama':'Local model'};
function name(id){return NAMES[id]||id}
function taskById(id){return S&&S.tasks.filter(function(t){return t.id===id})[0]}
function weight(id){var r=S.reputation[id];return r?r.score:1}
function decides(){var p=S.policy;if(p.mode==='lead')return 'Lead: '+name(p.reviewers[0]);if(p.mode==='council')return 'Council of '+p.reviewers.length+' · survives '+p.tolerates+' bad reviewer'+(p.tolerates===1?'':'s');return 'You decide'}
function workerName(){var w=S.workers.filter(function(x){return x.id===S.worker})[0];return w?w.name:null}

/* ---------- navigation ---------- */
function setTab(t){view=t==='tasks'?'task':t;localSet('view',view==='task'?'home':view);render()}
var ICONS={git:'<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="7" r="2"/><path d="M6 7v10M18 9c0 5-12 3-12 8"/>',home:'<path d="M4 6h16M4 12h10M4 18h7"/><path d="m15 17 2 2 4-4"/>',activity:'<path d="M3 12h4l3-8 4 16 3-8h4"/>',brain:'<circle cx="6" cy="7" r="2"/><circle cx="18" cy="7" r="2"/><circle cx="12" cy="17" r="2"/><path d="M8 7h8M7 9l4 6.5M17 9l-4 6.5"/>',connectors:'<path d="M9 7V3M15 7V3M7 7h10v4a5 5 0 0 1-10 0z"/><path d="M12 16v5"/>',settings:'<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>'};
var liveOff=false,lastSide='',lastRail='';
function dotClass(t){var st=t.status;if(st==='review')return 'rev';if(st==='running'||st==='checkpoint')return 'run';if(st==='handoff'||st==='idle')return 'wait';if(st==='blocked'||st==='failed')return 'bad';return /^Closed/.test(t.nextAction||'')?'closed':'done'}
function sideItem(t){return '<button class="titem'+(view==='task'&&selectedTask===t.id?' on':'')+'" data-open="'+esc(t.id)+'" title="'+esc(t.objective)+'"><span class="sdot '+dotClass(t)+'"></span><span class="tt">'+esc(shortTitle(t.objective))+'</span><span class="ta">'+esc(ago(t.updatedAt).replace(' ago',''))+'</span></button>'}
var sideKeys={};
function renderSide(){
  var el=document.getElementById('side');
  var review=S.tasks.filter(function(t){return t.status==='review'});var active=S.tasks.filter(function(t){return ['running','checkpoint','handoff','idle','blocked','failed'].indexOf(t.status)>=0});
  var recent=S.tasks.filter(function(t){return t.status==='done'}).sort(function(a,b){return (b.updatedAt||'').localeCompare(a.updatedAt||'')}).slice(0,8);
  var tabs=[['home','Tasks'],['activity','Activity'],['brain','Brain'],['git','Git'],['connectors','Connectors'],['settings','Settings']];
  // Built once; afterwards only classes and text change, so nothing is replaced under the pointer.
  if(!el.querySelector('.navs')){
    el.innerHTML='<div class="brand"><span class="mark">✻</span><span class="bname">AgentBrain</span><span class="proj"></span><span class="live" id="live"></span><button class="ptog" id="sideBtn" aria-label="Toggle sidebar"><svg viewBox="0 0 24 24" width="16" height="16"><rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M9.5 4.5v15"/></svg></button></div>'+
      '<button class="newtask" id="newTask"><svg viewBox="0 0 24 24" width="14" height="14" style="stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round"><path d="M12 5v14M5 12h14"/></svg>New task<kbd>N</kbd></button>'+
      '<div class="navs">'+tabs.map(function(t){return '<button class="navi" data-v="'+t[0]+'"><svg viewBox="0 0 24 24">'+ICONS[t[0]]+'</svg><span>'+t[1]+'</span><span class="n hot" hidden></span></button>'}).join('')+'</div>'+
      '<div class="slist"></div><div class="team"></div><button class="themebtn" id="themeBtn" aria-label="Change theme"></button>';
    el.querySelectorAll('[data-v]').forEach(function(b){b.onclick=function(){setTab(b.dataset.v)}});document.getElementById('sideBtn').onclick=toggleSide;document.getElementById('themeBtn').onclick=cycleTheme;applyTheme();document.getElementById('railBtn').onclick=toggleRail;
    document.getElementById('newTask').onclick=newTask;
    el.querySelector('.slist').onclick=function(e){var b=e.target.closest('[data-open]');if(!b)return;selectedTask=b.dataset.open;detailTab='changes';detailKey='';setTab('tasks')};
  }
  var proj=el.querySelector('.proj');proj.textContent=S.root.split('/').pop();proj.title=S.root;
  var lv=document.getElementById('live');lv.className='live'+(liveOff?' off':'');lv.title=liveOff?'Disconnected':'Live';
  el.querySelectorAll('.navi').forEach(function(b){var v=b.dataset.v;b.classList.toggle('on',view===v||(v==='home'&&view==='task'));var n=b.querySelector('.n');if(v==='home'){n.hidden=!review.length;n.textContent=review.length;n.title=review.length+' waiting for review'}});
  var listKey=JSON.stringify([review,active,recent].map(function(g){return g.map(function(t){return t.id+dotClass(t)+t.objective.length})}))+(view==='task'?selectedTask:'');
  var sl=el.querySelector('.slist');
  if(sideKeys.list!==listKey){sideKeys.list=listKey;var keep=sl.scrollTop;var h='';
    if(review.length)h+='<div class="sgroup">Needs you<span>'+review.length+'</span></div>'+review.map(sideItem).join('');
    if(active.length)h+='<div class="sgroup">In progress<span>'+active.length+'</span></div>'+active.map(sideItem).join('');
    h+='<div class="sgroup">Recent</div>'+recent.map(sideItem).join('');sl.innerHTML=h;sl.scrollTop=keep}
  else sl.querySelectorAll('.titem').forEach(function(b){var t=taskById(b.dataset.open);if(t)b.querySelector('.ta').textContent=ago(t.updatedAt).replace(' ago','')});
  var lead=S.policy.mode==='lead'?S.policy.reviewers[0]:null;
  var team=S.workers.filter(function(w){return w.installed&&w.how!=='pull'}).map(function(w){return '<div class="agent '+(w.available?'up':'down')+'" title="'+esc(w.available?(w.reasons||[]).slice(0,2).join(', '):(w.note||'unavailable'))+'"><span class="sdot"></span>'+esc(w.name)+(w.id===lead?'<span class="role">Lead</span>':S.policy.mode==='council'&&S.policy.reviewers.indexOf(w.id)>=0?'<span class="role">Council</span>':'')+'</div>'}).join('');
  if(sideKeys.team!==team){sideKeys.team=team;el.querySelector('.team').innerHTML=team}
}
/* The view scrolls in its own column on wide screens, the window on phones. */
function scroller(){var m=document.getElementById('main');return m.scrollHeight>m.clientHeight&&getComputedStyle(m).overflowY!=='visible'?m:document.scrollingElement}
function newTask(){mode='task';localSet('mode',mode);setTab('home');setTimeout(function(){var p=document.getElementById('prompt');if(p)p.focus()},0)}
var RAIL_KINDS={review:1,status:1,commit:1,handoff:1,decision:1,message:1,progress:1};
function railTask(id){var t=id&&taskById(id);return t&&t.status!=='done'?t:null}
function renderRail(){
  var rail=document.getElementById('rail');if(!rail||getComputedStyle(rail).display==='none')return;
  var live=S.sessions.filter(function(x){return x.state!=='ended'});
  // Working now: one card per running agent, with its task and its latest step.
  var cards=live.map(function(x){var t=railTask(x.taskId);var last=S.activity.filter(function(e){return e.session===x.sessionId&&e.kind!=='prompt'&&e.kind!=='session'}).slice(-1)[0];
    return '<button class="now"'+(t?' data-open="'+esc(t.id)+'"':' disabled')+'><span class="who"><span class="sdot run" style="background:'+color(x.agentId)+'"></span>'+esc(name(x.agentId))+'<span class="when">'+esc(x.mode==='interactive'?'in its own window':'in the background')+'</span></span><span class="tk">'+(t?esc(shortTitle(t.objective)):'<i>Not on a task</i>')+'</span>'+(last?'<span class="what">'+esc(last.text)+'</span>':'')+'</button>'}).join('');
  var evs=S.activity.filter(function(e){return RAIL_KINDS[e.kind]}).slice(-40).reverse();
  var h='<div class="railhead">Working now<span style="margin-left:auto;letter-spacing:0;text-transform:none;font-weight:400">'+live.length+'</span></div><div class="nowlist">'+(cards||'<div class="sub" style="padding:4px 8px">No agent is working right now.</div>')+'</div>'+
    '<div class="railhead">Recent</div><div class="stream">'+evs.map(function(e){var t=e.task&&taskById(e.task);return '<div class="ev"'+(t?' data-open="'+esc(t.id)+'" role="button" tabindex="0"':'')+'><span class="lane" style="background:'+color(e.agent)+'"></span><div><div class="who">'+esc(name(e.agent))+'<span class="when">'+hhmm(e.at)+'</span></div><div class="what">'+esc(e.text)+'</div>'+(t?'<div class="evtask">'+esc(shortTitle(t.objective))+'</div>':'')+'</div></div>'}).join('')+'</div>';
  if(h===lastRail)return;lastRail=h;
  var st=rail.querySelector('.stream');var keep=st?st.scrollTop:0;rail.innerHTML=h;var ns=rail.querySelector('.stream');if(ns)ns.scrollTop=keep;
  if(!rail.onclick){rail.onclick=function(e){var b=e.target.closest('[data-open]');if(!b||b.disabled)return;selectedTask=b.dataset.open;detailTab='changes';detailKey='';setTab('tasks')};rail.onkeydown=function(e){if(e.key==='Enter'&&e.target.closest('[data-open]')){e.preventDefault();e.target.click()}}}
}


/* ---------- home ---------- */
var STEPS=['Delegated','Working','Checks','Review','Done'];
function stage(t){if(t.status==='done')return 4;if(t.status==='review')return (S.policy.checks.length&&!(t.review&&(t.review.checks||[]).length))?2:3;if(t.status==='running'||t.status==='checkpoint')return 1;return 0}
function stepsHtml(t){var n=stage(t);var failed=t.review&&(t.review.checks||[]).some(function(c){return !c.ok});var skipped=t.status==='done'&&!(t.reviews&&t.reviews.length)&&!t.review;return '<div class="steps">'+STEPS.map(function(s,i){var cls=i<n?'done':i===n?'now':'';if(i===2&&failed)cls='bad';if(skipped&&(i===2||i===3))cls='skip';return '<div class="step '+cls+'"'+(cls==='skip'?' title="Skipped: finished without a review"':'')+'>'+s+'</div>'}).join('')+'</div>'}
function taskLog(t,n){return S.activity.filter(function(e){return e.task===t.id&&!(e.kind==='tool'&&/^(Read|Grep|Glob) /.test(e.text))}).slice(-n)}
function nextAction(t){if(t.status==='review')return 'Decide: approve or send back with notes';if(t.status==='running')return t.liveSession&&t.liveSession.alive?'Open the live head to watch progress':'Agent is working; wait for its next update';if(t.status==='handoff'||t.status==='idle')return 'Continue: hand this task to an agent';if(t.status==='blocked'||t.status==='failed')return 'Needs attention before it can continue';return 'AgentBrain is tracking this task'}
function metaHtml(t){var c=t.changes,p=S.policy,si=t.review&&t.review.standIn,lead=p.mode==='lead'&&p.reviewers[0],parts=[];
  if(c&&(c.commits||c.files))parts.push('<span class="mono">'+c.commits+' commit'+(c.commits===1?'':'s')+' · '+c.files+' file'+(c.files===1?'':'s')+' · <span class="ok">+'+c.added+'</span> <span class="bad">−'+c.removed+'</span></span>');
  parts.push('Review: '+(si?'<b style="color:'+color(si.agent)+'">'+esc(name(si.agent))+'</b> standing in · '+esc(si.why):lead?'<b style="color:'+color(lead)+'">'+esc(name(lead))+'</b> (lead)':p.mode==='council'?'council of '+p.reviewers.length:'you'));
  return '<div class="sub prmeta" title="'+esc(si?'Stand-in reviewer: '+si.why:'')+'">'+parts.join(' · ')+'</div>'}
var GLYPH={message:'✉',progress:'✓',edit:'✎',command:'$',commit:'●',decision:'◆',handoff:'⇄',review:'⚖',status:'→',prompt:'›',tool:'·',session:'◎'};
function logHtml(list){if(!list.length)return '';return '<div class="log">'+list.map(function(e){return '<div><span class="t">'+hhmm(e.at)+'</span><span class="g">'+(GLYPH[e.kind]||'·')+'</span><span><b style="color:'+color(e.agent)+';font-weight:600">'+esc(name(e.agent))+'</b> '+esc(e.text)+'</span></div>'}).join('')+'</div>'}
var lastHome='';var showAllDone=false;var doneOpen=true;
function fmt(t){var parts=String(t||'').split(/\x60\x60\x60/);return parts.map(function(p,i){if(i%2){var nl=p.indexOf('\n');var code=nl>=0&&/^[\w+#.-]*$/.test(p.slice(0,nl).trim())?p.slice(nl+1):p;return '<pre class="cb"><code>'+esc(code.replace(/\n$/,''))+'</code></pre>'}return esc(p).replace(/\x60([^\x60\n]+)\x60/g,'<code>$1</code>').replace(/\*\*([^*\n]+)\*\*/g,'<b>$1</b>').replace(/^#{1,4} (.+)$/gm,'<b>$1</b>').replace(/^\s*[-*] (.+)$/gm,'• $1').replace(/\n/g,'<br>')}).join('')}
function saveChat(){try{localSet('chat',JSON.stringify(chatLog.slice(-60)))}catch(e){}}
function chatView(wn){
  var proj=S.root.split('/').pop();
  var h='<div class="chathead"><div class="pagehead"><h1>Chat</h1><span class="sub">'+(wn?esc(wn)+(pick==='ollama'||(!chatPending&&wn&&/Local model/.test(wn))?' · answers from the brain':' · reads the whole project'):'no agent ready')+'</span></div><span class="grow"></span>'+(chatLog.length?'<button class="ghost" id="newChat">New chat</button>':'')+'</div><div class="msgs">';
  if(!chatLog.length&&!chatPending)h+='<div class="chatempty"><div class="hello">What do you want to know about '+esc(proj)+'?</div><div class="sub">Answers come from an agent that reads the code, the tasks and the shared memory. Switch to Task to have the work done in its own worktree.</div><div class="sugg">'+['What changed today?','What is each agent working on?','Where is the review logic?','Summarize the open tasks'].map(function(x){return '<button class="chip" data-sugg="'+esc(x)+'">'+esc(x)+'</button>'}).join('')+'</div></div>';
  chatLog.forEach(function(x){
    if(x.role==='user')h+='<div class="msg me"><div class="bubble">'+fmt(x.text)+'</div></div>';
    else h+='<div class="msg ai'+(x.error?' err':'')+'"><div class="who"><span class="sdot" style="background:'+color(x.worker||'')+'"></span>'+esc(name(x.worker||'agent'))+'</div><div class="body">'+fmt(x.text)+'</div></div>'});
  if(chatPending)h+='<div class="msg ai"><div class="who"><span class="sdot run" style="background:'+color(chatPending)+'"></span>'+esc(name(chatPending))+'</div>'+(chatStream?'<div class="body" id="streamBody">'+fmt(chatStream)+'</div>':'<div class="typing" id="streamBody"><i></i><i></i><i></i></div>')+'</div>';
  return h+'</div>';
}
function renderHome(){
  var m=document.getElementById('main');var active=document.activeElement;var refocus=active&&active.id==='prompt';var pos=refocus?active.selectionStart:0;var searching=active&&active.id==='taskSearch';
  m.querySelectorAll('[data-notes]').forEach(function(t){drafts[t.dataset.notes]=t.value});var focusNotes=active&&active.dataset&&active.dataset.notes;
  var ready=S.workers.filter(function(w){return w.available&&(mode!=='chat'||w.how==='print')});var auto=ready[0];if(pick!=='auto'&&!ready.some(function(w){return w.id===pick}))pick='auto';
  var chosen=pick==='auto'?auto:ready.filter(function(w){return w.id===pick})[0];var wn=chosen?chosen.name:null;
  var h='<div class="composer"><textarea id="prompt" rows="2" placeholder="'+(mode==='chat'?'Ask anything about this project…':'What should your agents do? e.g. Add a dark mode toggle to the settings page')+'">'+esc(composer)+'</textarea><div class="row">'+
    '<select id="workerPick" class="pick" title="Which agent takes this task">'+'<option value="auto"'+(pick==='auto'?' selected':'')+'>Auto'+(auto?' · '+esc(auto.name):'')+'</option>'+S.workers.map(function(w){return '<option value="'+esc(w.id)+'"'+(w.id===pick?' selected':'')+(ready.indexOf(w)>=0?'':' disabled')+'>'+esc(w.name)+(w.available?(ready.indexOf(w)>=0?'':' · can\'t chat'):' · '+esc((w.note||'unavailable').replace(/: .*/,'')))+'</option>'}).join('')+'</select><select id="modePick" class="pick" title="Chat with a model or delegate a task"><option value="chat"'+(mode==='chat'?' selected':'')+'>Chat · root access</option><option value="task"'+(mode==='task'?' selected':'')+'>Task · isolated worktree</option></select>'+
    '<span class="hint">'+(chosen?(mode==='chat'?(chosen&&chosen.id==='ollama'?'Answers from AgentBrain\'s memory, without opening files':'Answers here, reading the whole project'):pick==='auto'?esc(chosen.reasons.slice(0,2).join(', ')):'In its own worktree')+' · Enter to send':'No agent ready: open VS Code with Copilot, or sign in to Claude Code or Codex')+'</span>'+'<button class="primary" id="send" title="'+esc(chosen?(mode==='chat'?(chosen.id==='ollama'?'Answers from AgentBrain\'s memory':'Answers here, reading the whole project'):pick==='auto'?chosen.reasons.slice(0,2).join(', '):'In its own worktree')+' · Enter to send':'')+'"'+(wn&&!chatPending?'':' disabled')+'>'+(mode==='chat'?'Send':'Delegate')+'</button></div></div>';
  if(mode==='chat')h+=chatView(wn);else{
  var running=S.tasks.filter(function(t){return ['running','checkpoint','handoff','idle','blocked','failed'].indexOf(t.status)>=0});var review=S.tasks.filter(function(t){return t.status==='review'});var done=S.tasks.filter(function(t){return t.status==='done'});
  var live=S.sessions.filter(function(s){return s.state!=='ended'});
  h+='<div class="pagehead"><h1>Tasks</h1><span class="sub">'+esc(S.root.split('/').pop())+'</span></div><div class="facts"><span><b>'+review.length+'</b> to review</span><span><b>'+running.filter(function(t){return t.status==='running'}).length+'</b> running</span><span><b>'+live.length+'</b> agent'+(live.length===1?'':'s')+' active</span><span>'+esc(decides())+'</span>'+(S.policy.checks.length?'<span>Checks: <span class="mono">'+S.policy.checks.map(esc).join(' · ')+'</span></span>':'')+'</div>';
  var query=taskSearch.trim().toLowerCase();var matches=function(t){return (!query||(t.objective+' '+t.id+' '+(t.agent||'')).toLowerCase().indexOf(query)>=0)&&(taskFilter==='all'||(taskFilter==='review'&&t.status==='review')||(taskFilter==='active'&&['running','checkpoint','handoff','blocked','idle','failed'].indexOf(t.status)>=0))};
  var visibleReview=review.filter(matches),visibleRunning=running.filter(matches),visibleDone=done.filter(matches);var visibleCount=visibleReview.length+visibleRunning.length+visibleDone.length;
  h+='<div class="triage"><label class="search"><span>⌕</span><input id="taskSearch" value="'+esc(taskSearch)+'" placeholder="Find a task, agent, or ID" aria-label="Find a task, agent, or ID"><kbd>/</kbd></label><div class="filters"><button class="chip'+(taskFilter==='all'?' on':'')+'" data-filter="all">All</button><button class="chip'+(taskFilter==='active'?' on':'')+'" data-filter="active">Active <span class="sub">'+running.length+'</span></button><button class="chip'+(taskFilter==='review'?' on':'')+'" data-filter="review">Review <span class="sub">'+review.length+'</span></button></div><span class="triage-note"><b>'+visibleCount+'</b> shown · <span class="mono">g</span> then view key</span></div>';
  h+='<h2>Needs you <span class="count">'+visibleReview.length+(visibleReview.length!==review.length?' / '+review.length:'')+'</span></h2>';
  if(!visibleReview.length)h+='<div class="empty">'+(review.length?'No review matches "'+esc(taskSearch)+'".':'Nothing to review. Finished work lands here with AgentBrain\'s own checks and any red flags.')+'</div>';
  visibleReview.forEach(function(t){var rv=t.review||{};var ty=t.tally;
    h+='<div class="card need"><div class="title link" data-open="'+esc(t.id)+'" title="'+esc(t.objective)+'">'+esc(shortTitle(t.objective))+'</div>'+metaHtml(t)+'<div class="sub">Finished by <b style="color:'+color(rv.worker||t.agent||'')+'">'+esc(name(rv.worker||t.agent||'?'))+'</b> '+ago(rv.requestedAt||t.updatedAt)+' · <span class="mono">'+esc(t.id)+'</span></div><div class="sub"><b>Next:</b> '+esc(nextAction(t))+'</div>'+stepsHtml(t);
    if(S.policy.checks.length){if((rv.checks||[]).length)h+=rv.checks.map(function(c){return '<div class="check '+(c.ok?'ok':'bad')+'" title="'+esc(c.tail)+'">'+(c.ok?'✓ passed':'✗ failed')+' · '+esc(c.command)+'</div>'}).join('');else if(t.review)h+='<div class="check sub">Running checks…</div>';else h+='<div class="sub">Checks have not run on this result yet. <button class="ghost" data-verify="'+esc(t.id)+'">Run checks</button></div>'}
    (rv.flags||[]).forEach(function(f){h+='<div class="flag"><b>⚠ '+esc({'no-change':'Nothing changed','false-claim':'False claim','hallucination':'Hallucination','dissent':'Dissent'}[f.kind]||f.kind)+'</b> · '+esc(name(f.agent))+': '+esc(f.text)+'</div>'});
    if(ty&&ty.total>0&&S.policy.mode!=='none'){h+='<div class="meter"><div class="a" style="width:'+(ty.approve/ty.total*100)+'%"></div><div class="c" style="width:'+(ty.changes/ty.total*100)+'%"></div><div class="q" style="left:'+(ty.quorum*100)+'%"></div></div><div class="sub">'+(S.policy.mode==='council'?'Council: '+ty.approve.toFixed(1)+' approve, '+ty.changes.toFixed(1)+' changes of '+ty.total.toFixed(1)+' (needs '+Math.round(ty.quorum*100)+'%)':'Lead: '+((rv.votes||[]).length?'voted':'has not voted yet'))+(function(){var w=ty.eligible.filter(function(x){return !(rv.votes||[]).some(function(v){return v.agent===x})});return w.length?' · <b>waiting for '+w.map(name).map(esc).join(', ')+'</b> (or decide yourself below)':''})()+'</div>';
      (rv.votes||[]).forEach(function(v){h+='<div class="sub"><b style="color:'+color(v.agent)+'">'+esc(name(v.agent))+'</b> '+(v.verdict==='approved'?'<span class="ok">approve</span>':'<span class="bad">changes</span>')+(v.notes?': '+esc(v.notes):'')+'</div>'})}
    h+=logHtml(taskLog(t,3));
    h+='<textarea class="notes" data-notes="'+esc(t.id)+'" placeholder="What should change? (needed to send it back)">'+esc(drafts[t.id]||'')+'</textarea><div class="actions"><button class="primary" data-approve="'+esc(t.id)+'">Approve & merge</button><button data-changes="'+esc(t.id)+'">Send back</button><button class="ghost" data-open="'+esc(t.id)+'">Details</button></div></div>'});
  h+='<h2>In progress <span class="count">'+visibleRunning.length+(visibleRunning.length!==running.length?' / '+running.length:'')+'</span></h2>';
  if(!visibleRunning.length)h+='<div class="empty">'+(running.length?'No active task matches "'+esc(taskSearch)+'".':'No work in progress. Describe a task above and an agent will pick it up.')+'</div>';
  visibleRunning.forEach(function(t){var s=S.sessions.filter(function(x){return x.taskId===t.id&&x.state!=='ended'})[0];
    h+='<div class="card"><div class="title link" data-open="'+esc(t.id)+'" title="'+esc(t.objective)+'">'+esc(shortTitle(t.objective))+'</div>'+metaHtml(t)+'<div class="sub">'+(t.agent?'<span class="who-dot" style="background:'+color(t.agent)+'"></span>'+esc(name(t.agent)):'Unassigned')+' · '+esc(t.status==='handoff'?'handed off, waiting for an agent':t.status)+(t.warning?' · <span class="bad">'+esc(t.warning)+'</span>':'')+' · '+ago(t.updatedAt)+'</div>'+stepsHtml(t)+
      '<div class="sub"><b>Next:</b> '+esc(nextAction(t))+(t.nextAction?' · '+esc(t.nextAction):'')+'</div>'+logHtml(taskLog(t,4))+'<div class="actions">'+(t.status!=='running'?'<button data-continue="'+esc(t.id)+'">Hand to '+esc(wn||'a worker')+'</button>':'')+(t.liveSession&&t.liveSession.alive?'<button data-stop="'+esc(t.liveSession.sessionId)+'">Stop</button>':'')+'<button class="ghost" data-open="'+esc(t.id)+'">'+(t.liveSession&&t.liveSession.alive?'Open live head':'Details')+'</button></div></div>'});
  if(visibleDone.length)h+='<details id="doneList"'+(doneOpen?' open':'')+'><summary>Finished ('+visibleDone.length+(visibleDone.length!==done.length?' / '+done.length:'')+')</summary>'+visibleDone.slice().sort(function(a,b){return (b.updatedAt||'').localeCompare(a.updatedAt||'')}).slice(0,showAllDone?1e9:30).map(function(t){var closed=/^Closed/.test(t.nextAction||'');return '<div class="row'+(closed?' closed':'')+'" role="button" tabindex="0" data-open="'+esc(t.id)+'" aria-label="Open finished task '+esc(t.objective)+'"><span class="'+(closed?'x':'ok')+'" title="'+(closed?esc(t.nextAction):'Done')+'">'+(closed?'×':'✓')+'</span><span>'+esc(shortTitle(t.objective))+'</span><span class="sub">'+(closed?esc(t.nextAction.replace(/^Closed /,'closed '))+' · ':esc(t.agent?name(t.agent):'')+' · ')+ago(t.updatedAt)+'</span></div>'}).join('')+(visibleDone.length>30?'<button class="link more" id="moreDone">'+(showAllDone?'Show fewer':'Show all '+visibleDone.length)+'</button>':'')+'</details>';
  }
  // Agents add activity every few seconds: rebuilding identical markup would eat clicks and selections.
  if(h===lastHome&&m.querySelector('.composer'))return;lastHome=h;
  m.innerHTML=h;m.classList.toggle('chatmode',mode==='chat');
  if(mode==='chat'){var n=chatLog.length+(chatPending?1:0);if(n!==lastChatLen){lastChatLen=n;m.scrollTop=m.scrollHeight}}else lastChatLen=-1;
  var nc=document.getElementById('newChat');if(nc)nc.onclick=function(){chatLog=[];saveChat();lastHome='';renderHome();var q=document.getElementById('prompt');if(q)q.focus()};
  m.querySelectorAll('[data-sugg]').forEach(function(b){b.onclick=function(){composer=b.dataset.sugg;send()}});
  var p=document.getElementById('prompt');p.oninput=function(){composer=p.value};p.onkeydown=function(e){if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send()}};if(refocus){p.focus();p.selectionStart=p.selectionEnd=pos}
  if(searching){var sn=document.getElementById('taskSearch');if(sn){sn.focus();sn.setSelectionRange(sn.value.length,sn.value.length)}}
  if(focusNotes){var f=m.querySelector('[data-notes="'+focusNotes+'"]');if(f){f.focus();f.selectionStart=f.selectionEnd=f.value.length}}
  var md=document.getElementById('moreDone');if(md)md.onclick=function(e){e.stopPropagation();showAllDone=!showAllDone;lastHome='';renderHome()};var dl=document.getElementById('doneList');if(dl)dl.ontoggle=function(){doneOpen=dl.open};
  document.getElementById('send').onclick=send;var wp=document.getElementById('workerPick');if(wp)wp.onchange=function(){pick=wp.value;localSet('pick',pick);renderHome()};var mp=document.getElementById('modePick');if(mp)mp.onchange=function(){mode=mp.value;localSet('mode',mode);render()};
  var search=document.getElementById('taskSearch');if(search)search.oninput=function(){taskSearch=search.value;renderHome();var next=document.getElementById('taskSearch');next.focus();next.setSelectionRange(taskSearch.length,taskSearch.length)};m.querySelectorAll('[data-filter]').forEach(function(b){b.onclick=function(){taskFilter=b.dataset.filter;renderHome()}});
  m.querySelectorAll('[data-notes]').forEach(function(t){t.oninput=function(){drafts[t.dataset.notes]=t.value}});
  m.querySelectorAll('[data-approve]').forEach(function(b){b.onclick=function(){b.disabled=true;post('/api/review',{taskId:b.dataset.approve,verdict:'approved',notes:drafts[b.dataset.approve]||''}).then(function(r){if(r.ok)toast(r.conflicts&&r.conflicts.length?'Conflicts in '+r.conflicts.join(', ')+'; still in review':'Approved and merged');delete drafts[b.dataset.approve]})}});
  m.querySelectorAll('[data-changes]').forEach(function(b){b.onclick=function(){var id=b.dataset.changes;var notes=(drafts[id]||'').trim();if(!notes){toast('Write what should change first');var n=m.querySelector('[data-notes="'+id+'"]');if(n)n.focus();return}b.disabled=true;post('/api/review',{taskId:id,verdict:'changes',notes:notes}).then(function(r){if(r.ok)toast('Sent back with your notes');delete drafts[id]})}});
  m.querySelectorAll('[data-verify]').forEach(function(b){b.onclick=function(){b.disabled=true;post('/api/verify',{taskId:b.dataset.verify}).then(function(r){if(r.ok)toast('Running checks')})}});
  m.querySelectorAll('[data-continue]').forEach(function(b){b.onclick=function(){b.disabled=true;post('/api/delegate',{taskId:b.dataset.continue}).then(function(r){if(r.ok)toast('Handed to '+r.worker)})}});
  m.querySelectorAll('[data-stop]').forEach(function(b){b.onclick=function(){post('/api/stop',{sessionId:b.dataset.stop})}});
  m.querySelectorAll('[data-open]').forEach(function(b){b.onclick=function(){selectedTask=b.dataset.open;setTab('tasks')};b.onkeydown=function(e){if(e.key==='Enter'||e.key===' '){e.preventDefault();b.click()}}});
}
function send(){var text=composer.trim();if(!text||chatPending)return;var b=document.getElementById('send');if(b)b.disabled=true;var chatWorker=pick==='auto'?S.workers.filter(function(w){return w.available&&w.how==='print'})[0]:S.workers.filter(function(w){return w.id===pick})[0];
  if(mode==='chat'){if(!chatWorker){toast('No agent can chat right now');if(b)b.disabled=false;return}var history=chatLog.filter(function(x){return !x.error}).slice(-12).map(function(x){return {role:x.role,text:x.text}});chatLog.push({role:'user',text:text});chatPending=chatWorker.id;composer='';saveChat();lastHome='';renderHome();
    var done=function(msg){chatPending=null;chatStream='';chatLog.push(msg);saveChat();lastHome='';renderHome();var q=document.getElementById('prompt');if(q)q.focus()};
    var worker=chatWorker.id,failed=null,buf='';
    var paint=function(){var el=document.getElementById('streamBody');var m=document.getElementById('main');var atBottom=m.scrollHeight-m.scrollTop-m.clientHeight<120;if(el){if(el.className!=='body'){el.className='body'}el.innerHTML=fmt(chatStream)}else{lastHome='';renderHome()}if(atBottom)m.scrollTop=m.scrollHeight};
    var onLine=function(line){if(!line.trim())return;var ev;try{ev=JSON.parse(line)}catch(e){return}if(ev.text){chatStream+=ev.text;paint()}if(ev.error)failed=ev.error;if(ev.worker)worker=ev.worker};
    fetch('/api/chat',{method:'POST',headers:{'x-agentbrain-token':token,'content-type':'application/json',accept:'application/x-ndjson'},body:JSON.stringify({prompt:text,worker:chatWorker.id,history:history})}).then(function(res){
      if(!res.ok||!res.body)return res.json().then(function(j){failed=(j&&j.error)||('The chat failed ('+res.status+')')});
      var reader=res.body.getReader(),dec=new TextDecoder();
      var pump=function(){return reader.read().then(function(r){if(r.done){onLine(buf);return}buf+=dec.decode(r.value,{stream:true});var parts=buf.split('\n');buf=parts.pop();parts.forEach(onLine);return pump()})};
      return pump();
    }).then(function(){if(chatStream.trim())done({role:'assistant',worker:worker,text:chatStream+(failed?'\n\n(Stopped: '+failed+')':'')});else if(failed)done({role:'assistant',worker:worker,error:true,text:failed});else done({role:'assistant',worker:worker,text:'(No response text returned.)'})}).catch(function(e){done({role:'assistant',worker:worker,error:true,text:(chatStream?chatStream+'\n\n':'')+'The chat failed: '+e.message})});return}
  post('/api/delegate',pick==='auto'?{prompt:text}:{prompt:text,worker:pick}).then(function(r){if(b)b.disabled=false;if(r.ok){composer='';toast('Delegated to '+r.worker);renderHome()}})}
document.addEventListener('keydown',function(e){if(e.target&&(/INPUT|TEXTAREA|SELECT/.test(e.target.tagName)))return;if(e.key==='['&&!e.metaKey&&!e.ctrlKey){e.preventDefault();toggleSide();return}if(e.key===']'&&!e.metaKey&&!e.ctrlKey){e.preventDefault();toggleRail();return}if(e.key==='/'){e.preventDefault();var search=document.getElementById('taskSearch');if(search){search.focus();search.select()}}else if(e.key==='g'){goKey=true;setTimeout(function(){goKey=false},900)}else if(goKey&&{h:'home',a:'activity',b:'brain',c:'connectors',s:'settings'}[e.key]){goKey=false;setTab({h:'home',a:'activity',b:'brain',c:'connectors',s:'settings'}[e.key])}});

/* ---------- activity ---------- */
function renderActivity(){
  var agents=[];S.activity.forEach(function(e){if(agents.indexOf(e.agent)<0)agents.push(e.agent)});
  var list=S.activity.slice().reverse().filter(function(e){return (!agentFilter||e.agent===agentFilter)&&!(e.kind==='tool'&&/^(Read|Grep|Glob) /.test(e.text))});
  var h='<div class="filters"><button class="chip'+(agentFilter?'':' on')+'" data-af="">Everyone</button>'+agents.map(function(a){return '<button class="chip'+(agentFilter===a?' on':'')+'" data-af="'+esc(a)+'"><span class="who-dot" style="background:'+color(a)+'"></span>'+esc(name(a))+'</button>'}).join('')+'</div>';
  h+=list.length?'<div class="card feed" style="padding:4px 14px">'+list.slice(0,300).map(function(e){var t=e.task&&taskById(e.task);return '<div class="row"><span class="t">'+hhmm(e.at)+'</span><span class="who" style="color:'+color(e.agent)+'">'+esc(name(e.agent))+'</span><span><span style="color:var(--faint)">'+(GLYPH[e.kind]||'·')+'</span> '+esc(e.text)+(t?' <span class="sub">· '+esc(t.objective.slice(0,60))+'</span>':'')+'</span></div>'}).join('')+'</div>':'<div class="empty">Nothing yet. Prompts, edits, commands, progress, handoffs and verdicts from every agent show up here.</div>';
  var m=document.getElementById('main');m.innerHTML=h;m.querySelectorAll('[data-af]').forEach(function(b){b.onclick=function(){agentFilter=b.dataset.af||null;renderActivity()}});
}

/* ---------- connectors ---------- */
var CONNECTOR_GROUPS=[['terminal','Terminal agents'],['app','Desktop apps'],['ide','IDEs'],['extension','IDE extensions']];
var CAPABILITY={start:'Can start tasks',pickup:'Picks up tasks',review:'Plans & reviews',none:"Can't connect"};
function loadConnectors(){
  var all=connectorsAll;connectorsLoading=true;api('/api/connectors'+(all?'?all=1':'')).then(function(d){connectorsLoading=false;connectorsLoadedAll=all;if(d&&d.error){toast(d.error);connectors=[]}else connectors=d;if(view==='connectors')renderConnectors()}).catch(function(){connectorsLoading=false;connectorsLoadedAll=all;connectors=[];toast('Could not load connectors');if(view==='connectors')renderConnectors()});
}
function connectorStatus(c){
  if(c.installed&&c.signedIn===false)return '<span class="bad">Not signed in</span>'+(c.hint?' <span class="sub">· '+esc(c.hint)+'</span>':'');
  if(c.connected)return '<span class="ok">Connected</span>';
  if(c.installed&&c.capability==='none')return '<span class="sub">Installed</span>';
  if(c.installed)return '<span>Not connected</span>';
  return '<span class="sub">Not installed</span>'+(c.hint?' <span class="sub">· '+esc(c.hint)+'</span>':'');
}
function connectorCard(c){
  var cls='card'+(c.installed?'':' connector-off');var h='<div class="'+cls+'"><div class="connector-head"><div><div class="title">'+esc(c.name)+'</div><div class="sub">'+esc(c.location||c.id)+'</div></div><span class="connector-chip '+esc(c.capability)+'">'+esc(CAPABILITY[c.capability]||c.capability)+'</span></div>';
  h+='<div class="connector-status">'+connectorStatus(c)+'</div>';
  if(c.connect&&c.connect.file){h+='<div class="connector-path">Connect writes the '+esc(c.connect.scope)+' config: <span class="mono">'+esc(c.connect.file)+'</span></div><div class="actions">'+(c.connected?'<button data-disconnect="'+esc(c.id)+'">Disconnect</button>':'<button class="primary" data-connect="'+esc(c.id)+'"'+(!c.installed||c.signedIn===false?' disabled':'')+'>Connect</button>')+'</div>'}
  else if(c.connect&&c.connect.manual)h+='<div class="connector-manual">'+esc(c.connect.manual)+'</div>';
  if(c.note)h+='<div class="connector-note">'+esc(c.note)+'</div>';
  return h+'</div>';
}
function renderConnectors(){
  var m=document.getElementById('main');if(!connectors||connectorsLoadedAll!==connectorsAll){if(!connectorsLoading)loadConnectors();m.innerHTML='<div class="empty">Loading connectors...</div>';return}
  var h='<div class="connectorbar"><div class="sub">Connect tools to AgentBrain so they can start, pick up, or review work.</div><label class="toggle"><input type="checkbox" id="showAllConnectors"'+(connectorsAll?' checked':'')+'> Show tools that aren\'t installed</label></div>';
  CONNECTOR_GROUPS.forEach(function(g){var items=connectors.filter(function(c){return c.kind===g[0]});if(!items.length)return;h+='<h2>'+g[1]+' <span class="count">'+items.length+'</span></h2><div class="connector-grid">'+items.map(connectorCard).join('')+'</div>'});
  if(!connectors.length)h+='<div class="empty">No installed connector tools found. Turn on the toggle to see every known tool AgentBrain can connect.</div>';
  m.innerHTML=h;var show=document.getElementById('showAllConnectors');show.onchange=function(){connectorsAll=show.checked;localSet('connectorsAll',connectorsAll?'1':'0');connectors=null;renderConnectors()};
  m.querySelectorAll('[data-connect]').forEach(function(b){b.onclick=function(){var id=b.dataset.connect;var c=connectors.filter(function(x){return x.id===id})[0];b.disabled=true;post('/api/connectors/connect',{id:id}).then(function(r){if(r.ok){toast('Restart '+(c?c.name:id)+' so it loads AgentBrain');connectors=null;loadConnectors()}else{b.disabled=false}})}});
  m.querySelectorAll('[data-disconnect]').forEach(function(b){b.onclick=function(){var id=b.dataset.disconnect;b.disabled=true;post('/api/connectors/disconnect',{id:id}).then(function(r){if(r.ok){toast('Disconnected');connectors=null;loadConnectors()}else{b.disabled=false}})}});
}

/* ---------- settings ---------- */
function renderSettings(){
  if(!settings||!settings.dirty)settings={mode:S.policy.mode,agents:S.policy.reviewers.slice(),quorum:S.policy.quorum||0.67,checks:S.policy.checks.join('\n'),dirty:false};var d=settings;
  var h='<div class="card"><div class="set"><div><label>Appearance</label><div class="sub">System follows your computer\'s light or dark setting.</div></div><div><span class="seg">'+['system','light','dark'].map(function(t){return '<button data-theme-pick="'+t+'" class="'+(theme()===t?'on':'')+'">'+THEME_NAME[t]+'</button>'}).join('')+'</span></div></div><div class="set"><div><label>New tasks go to</label><div class="sub">The agent that picks up what you type.</div></div><div><select id="worker"><option value="auto"'+(S.worker?'':' selected')+'>Auto: the best-placed agent each time</option>'+S.workers.map(function(w){return '<option value="'+esc(w.id)+'"'+(w.id===S.worker?' selected':'')+(w.available?'':' disabled')+'>'+esc(w.name)+(w.available?'':' ('+esc((w.note||'unavailable').replace(/: .*/,''))+')')+'</option>'}).join('')+'</select></div></div>';
  h+='<div class="set"><div><label>Agent permissions</label><div class="sub">'+(S.permissions==='all'?'Agents run any tool or command without asking, including Copilot in VS Code (this project only).':'Each agent asks before running commands.')+'</div></div><div><span class="seg">'+[['ask','Ask'],['all','Allow all']].map(function(x){return '<button data-perm="'+x[0]+'" class="'+(S.permissions===x[0]?'on':'')+'">'+x[1]+'</button>'}).join('')+'</span></div></div>';
  h+='<div class="set"><div><label>Who decides</label><div class="sub">Whose approval finished work needs.</div></div><div><span class="seg">'+[['none','Me'],['lead','A lead agent'],['council','A council']].map(function(x){return '<button data-mode="'+x[0]+'" class="'+(d.mode===x[0]?'on':'')+'">'+x[1]+'</button>'}).join('')+'</span>';
  if(d.mode==='lead')h+='<div class="agents">'+S.knownAgents.map(function(a){return '<button class="chip'+(d.agents[0]===a?' on':'')+'" data-lead="'+esc(a)+'">'+esc(name(a))+'</button>'}).join('')+'</div><div class="sub" style="margin-top:6px">The lead reviews every other agent\'s work. You can always override.</div>';
  if(d.mode==='council'){var f=Math.max(0,Math.floor(d.agents.length*(1-d.quorum)+1e-9));h+='<div class="agents">'+S.knownAgents.map(function(a){return '<button class="chip'+(d.agents.indexOf(a)>=0?' on':'')+'" data-member="'+esc(a)+'">'+esc(name(a))+' <span class="sub">w '+weight(a).toFixed(2)+'</span></button>'}).join('')+'</div><div class="actions"><span class="sub">Quorum</span><select id="quorum">'+[[0.51,'51%'],[0.67,'67%'],[0.75,'75%'],[1,'100%']].map(function(q){return '<option value="'+q[0]+'"'+(Math.abs(d.quorum-q[0])<0.02?' selected':'')+'>'+q[1]+'</option>'}).join('')+'</select><span class="sub">'+d.agents.length+' members · a result survives '+f+' broken, compromised or hallucinating reviewer'+(f===1?'':'s')+'</span></div><div class="sub" style="margin-top:6px">Votes are sealed until each member votes and weighted by reputation; mix vendors so one model\'s blind spot can\'t decide.</div>'}
  h+='</div></div><div class="set"><div><label>Checks</label><div class="sub">AgentBrain runs these itself on every result; failing ones block approval. One per line.</div></div><div><textarea id="checks" class="notes" style="margin:0;font-family:var(--mono)" placeholder="npm test">'+esc(d.checks)+'</textarea></div></div>';
  h+='<div class="actions"><button class="primary" id="save"'+(d.dirty?'':' disabled')+'>Save</button>'+(d.dirty?'<button class="ghost" id="cancel">Cancel</button>':'')+'</div></div>';
  if(Object.keys(S.reputation).length)h+='<h2>Reputation</h2><div class="card">'+Object.keys(S.reputation).map(function(a){var r=S.reputation[a];return '<div class="sub" style="padding:3px 0"><b style="color:'+color(a)+'">'+esc(name(a))+'</b> · weight '+r.score.toFixed(2)+' · agreed '+r.agreed+' · dissented '+r.dissented+' · flagged '+r.flagged+'</div>'}).join('')+'</div>';
  var m=document.getElementById('main');m.innerHTML=h;
  document.getElementById('worker').onchange=function(e){post('/api/settings',{worker:e.target.value}).then(function(r){if(r.ok)toast('New tasks go to '+e.target.selectedOptions[0].text)})};
  m.querySelectorAll('[data-perm]').forEach(function(b){b.onclick=function(){var p=b.dataset.perm;if(p==='all'&&!confirm('Let every agent AgentBrain starts run any tool or command in this project without asking?'))return;post('/api/settings',{permissions:p}).then(function(r){if(r.ok){S.permissions=p;toast(r.warning||(p==='all'?'Agents no longer ask for approval':'Agents ask for approval again'));renderSettings()}})}});
  m.querySelectorAll('[data-theme-pick]').forEach(function(b){b.onclick=function(){setTheme(b.dataset.themePick)}});m.querySelectorAll('[data-mode]').forEach(function(b){b.onclick=function(){d.mode=b.dataset.mode;if(d.mode==='lead'&&!d.agents.length)d.agents=['claude-code'];if(d.mode==='lead')d.agents=d.agents.slice(0,1);if(d.mode==='council'&&d.quorum>=1)d.quorum=0.67;d.dirty=true;renderSettings()}});
  m.querySelectorAll('[data-lead]').forEach(function(b){b.onclick=function(){d.agents=[b.dataset.lead];d.dirty=true;renderSettings()}});
  m.querySelectorAll('[data-member]').forEach(function(b){b.onclick=function(){var a=b.dataset.member,i=d.agents.indexOf(a);if(i>=0)d.agents.splice(i,1);else d.agents.push(a);d.dirty=true;renderSettings()}});
  var q=document.getElementById('quorum');if(q)q.onchange=function(){d.quorum=Number(q.value);d.dirty=true;renderSettings()};
  var c=document.getElementById('checks');c.oninput=function(){d.checks=c.value;if(!d.dirty){d.dirty=true;var s=document.getElementById('save');s.disabled=false}};
  document.getElementById('save').onclick=function(){Promise.all([post('/api/policy',{mode:d.mode,agents:d.agents,quorum:d.mode==='council'?d.quorum:undefined}),post('/api/settings',{checks:d.checks.split('\n')})]).then(function(r){if(r[0].ok&&r[1].ok){d.dirty=false;toast('Saved')}})};
  var cc=document.getElementById('cancel');if(cc)cc.onclick=function(){d.dirty=false;renderSettings()};
}

/* ---------- task detail: reads like a pull request ---------- */
var detailKey='',detailTab='changes',openFiles={},detailCache={};
function shortTitle(o){var first=String(o).split(/(?<=[.!?])\s|:\s|\n/)[0];if(first.length>90)first=first.slice(0,87).replace(/\s+\S*$/,'')+'…';return first}
function parseDiff(patch){
  var files=[],cur=null,oldN=0,newN=0;
  (patch||'').split('\n').forEach(function(l){
    if(l.indexOf('diff --git ')===0){var m=/ b\/(.*)$/.exec(l);cur={path:m?m[1]:l.slice(11),rows:[],added:0,removed:0,binary:false};files.push(cur);return}
    if(!cur)return;
    if(/^(index |similarity |rename |new file|deleted file|old mode|new mode)/.test(l))return;
    if(l.indexOf('--- ')===0||l.indexOf('+++ ')===0){if(l.indexOf('+++ b/')===0)cur.path=l.slice(6);return}
    if(l.indexOf('Binary files')===0){cur.binary=true;return}
    var h=/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(l);
    if(h){oldN=+h[1];newN=+h[2];cur.rows.push({t:'hunk',text:l});return}
    if(l[0]==='+'){cur.rows.push({t:'add',n:newN++,text:l.slice(1)});cur.added++}
    else if(l[0]==='-'){cur.rows.push({t:'del',o:oldN++,text:l.slice(1)});cur.removed++}
    else if(l[0]===' '||l===''){if(!cur.rows.length)return;cur.rows.push({t:'ctx',o:oldN++,n:newN++,text:l.slice(1)})}
  });
  return files;
}
function bar(a,r){var t=a+r||1,g=Math.round(5*a/t),b=Math.min(5-g,Math.round(5*r/t));var s='';for(var i=0;i<5;i++)s+='<i class="'+(i<g?'g':i<g+b?'r':'n')+'"></i>';return '<span class="dbar">'+s+'</span>'}
function fileHtml(f,i){
  var open=openFiles[f.path]!==undefined?openFiles[f.path]:f.rows.length<=400;
  var h='<div class="dfile" id="f'+i+'"><div class="dhead" data-file="'+esc(f.path)+'"><span class="caret">'+(open?'▾':'▸')+'</span><span class="mono">'+esc(f.path)+'</span><span class="dstat"><span class="ok">+'+f.added+'</span> <span class="bad">−'+f.removed+'</span> '+bar(f.added,f.removed)+'</span></div>';
  if(open){
    if(f.binary)h+='<div class="sub" style="padding:10px 14px">Binary file</div>';
    else h+='<table class="diff"><colgroup><col class="lnc"><col class="lnc"><col></colgroup>'+f.rows.map(function(r){
      if(r.t==='hunk')return '<tr class="hunk"><td colspan="3">'+esc(r.text)+'</td></tr>';
      return '<tr class="'+r.t+'"><td class="ln">'+(r.o||'')+'</td><td class="ln">'+(r.n||'')+'</td><td class="code"><span class="sign">'+(r.t==='add'?'+':r.t==='del'?'−':' ')+'</span>'+esc(r.text)+'</td></tr>'}).join('')+'</table>';
  }
  return h+'</div>';
}
function renderTask(){
  var t=taskById(selectedTask);var m=document.getElementById('main');if(!t){setTab('home');return}
  var key=t.id+t.updatedAt+detailTab+(detailTab==='activity'||detailTab==='live'?S.activity.length:'');if(key===detailKey&&m.querySelector('.detail'))return;var keepScroll=detailKey.indexOf(t.id)===0?scroller().scrollTop:0;detailKey=key;
  var cached=[detailCache['c'+t.id]||null,detailCache[(detailTab==='activity'?'a':'x')+t.id]||null,t.liveSession?detailCache['l'+t.liveSession.sessionId]||null:null];
  // Draw now from what we have (the snapshot, the last fetch), then again when fresh data arrives.
  draw(cached,true);
  Promise.all([api('/api/changes?task='+encodeURIComponent(t.id)),detailTab==='context'?api('/api/context?task='+encodeURIComponent(t.id)):detailTab==='activity'?api('/api/activity?task='+encodeURIComponent(t.id)):Promise.resolve(null),t.liveSession?api('/api/transcript?session='+encodeURIComponent(t.liveSession.sessionId)):Promise.resolve(null)]).then(function(r){if(r[0]&&!r[0].error)detailCache['c'+t.id]=r[0];if(r[1])detailCache[(detailTab==='activity'?'a':'x')+t.id]=r[1];if(r[2]&&t.liveSession)detailCache['l'+t.liveSession.sessionId]=r[2];if(selectedTask!==t.id||view!=='task'||detailKey!==key)return;draw(r,false)});
  function draw(r,first){
    var loading=first&&!r[0];var c=r[0]||{commits:[],files:[],patch:'',summary:t.completed.slice(-4).join(' · ')};var files=parseDiff(c.patch);
    var add=c.files.reduce(function(s,f){return s+f.added},0),del=c.files.reduce(function(s,f){return s+f.removed},0);
    function list(a){return a&&a.length?'<ul>'+a.map(function(x){return '<li>'+esc(x)+'</li>'}).join('')+'</ul>':'<div class="sub">None</div>'}
    var closed=t.status==='done'&&/^Closed/.test(t.nextAction||'');
    var status=closed?'Closed':t.status==='done'?(t.merged?'Merged':'Done'):t.status==='review'?'In review':t.status[0].toUpperCase()+t.status.slice(1);
    var h='<div class="detail"><button class="ghost" id="back">← All tasks</button>';
    var title=shortTitle(t.objective);h+='<div class="prhead"><h1>'+esc(title)+' <span class="faint mono">'+esc(t.id.replace('task-','#'))+'</span></h1>';
    h+='<div class="prmeta"><span class="pill s-'+esc(closed?'closed':t.status)+'">'+esc(status)+'</span>'+(t.agent?'<b style="color:'+color(t.agent)+'">'+esc(name(t.agent))+'</b> ':'')+(c.commits.length?(t.status==='done'?(t.merged?'merged ':'')+c.commits.length+' commit'+(c.commits.length===1?'':'s')+' ':'wants to merge '+c.commits.length+' commit'+(c.commits.length===1?'':'s')+' '):'')+(t.worktree?'from <span class="mono branch">'+esc(t.worktree.branch)+'</span> ':'')+'· updated '+esc(ago(t.updatedAt))+'</div></div>';
    h+='<div class="card">'+(title!==t.objective?'<div class="label">Task</div><div class="objective">'+esc(t.objective)+'</div>':'')+'<div class="label">Summary</div><div class="summary">'+(c.summary?esc(c.summary):'<span class="sub">No summary yet: the agent hasn\'t recorded what it did.</span>')+'</div>'+(closed?'<div class="sub">'+esc(t.nextAction)+' without merging anything.</div>':stepsHtml(t))+
      '<div class="actions">'+(t.status==='review'?'<button class="primary" id="approve">Approve and merge</button><button id="sendBack">Send back…</button>':'')+(t.status==='done'?'':'<button class="ghost" id="closeTask">Close task</button>')+(t.worktree||t.status!=='done'?'<button class="ghost" id="openEditor">Open in VS Code</button>':'')+'</div></div>';
    var tabs=[['changes','Files changed',c.files.length],['commits','Commits',c.commits.length],['activity','Activity',null],['notes','Notes',null],['context','Context',null]];if(r[2])tabs.push(['live','Live',null]);
    h+='<div class="prtabs">'+tabs.map(function(x){return '<button data-dtab="'+x[0]+'" class="'+(detailTab===x[0]?'on':'')+'">'+x[1]+(x[2]!==null?' <span class="count">'+x[2]+'</span>':'')+'</button>'}).join('')+'<span class="grow"></span>'+(c.files.length?'<span class="dstat"><span class="ok">+'+add+'</span> <span class="bad">−'+del+'</span> '+bar(add,del)+'</span>':'')+'</div>';
    if(detailTab==='changes'){
      if(!files.length)h+='<div class="empty">'+(loading?'Loading changes…':closed?'Closed without changes.':t.status==='done'&&!t.worktree&&!t.merged?'AgentBrain didn\'t record which commits belong to this task: it was worked on straight on main. Notes has what was done.':t.status==='done'?'This task didn\'t change any files.':'No changes yet.')+'</div>';
      else{
        h+='<div class="card filelist">'+c.files.map(function(f){var i=files.findIndex(function(x){return x.path===f.path});return '<a href="#" data-jump="'+i+'"><span class="fs '+esc(f.status)+'">'+esc(f.status[0].toUpperCase())+'</span><span class="mono">'+esc(f.path)+'</span><span class="grow"></span><span class="ok">+'+f.added+'</span> <span class="bad">−'+f.removed+'</span></a>'}).join('')+'</div>';
        if(c.uncommitted)h+='<div class="sub" style="margin:0 0 8px">Includes edits the agent hasn\'t committed yet.</div>';
        if(c.approximate)h+='<div class="sub" style="margin:0 0 8px">Worked on straight on main: these are the commits made there while the task was open, which can include other work.</div>';
        h+=files.map(fileHtml).join('');
        if(c.truncated)h+='<div class="sub">Diff truncated; open the worktree for the rest.</div>';
      }
    }else if(detailTab==='commits'){
      h+=loading&&!c.commits.length?'<div class="empty">Loading commits…</div>':c.commits.length?'<div class="card commits">'+c.commits.map(function(x){return '<div class="commit"><div><div class="csub">'+esc(x.subject)+'</div>'+(x.body?'<div class="sub cbody">'+esc(x.body)+'</div>':'')+'<div class="sub">'+esc(x.author)+' committed '+esc(ago(x.at))+'</div></div><span class="mono sha">'+esc(x.sha.slice(0,7))+'</span></div>'}).join('')+'</div>':'<div class="empty">No commits yet.</div>';
    }else if(detailTab==='activity'){
      var hist=Array.isArray(r[1])?r[1].filter(function(e){return !(e.kind==='tool'&&/^(Read|Grep|Glob) /.test(e.text))}):taskLog(t,80);
      h+='<div class="card">'+(logHtml(hist.slice(-120))||'<div class="sub">'+(first&&!r[1]?'Loading…':'No activity was recorded for this task.')+'</div>')+'</div>';
    }else if(detailTab==='notes'){
      h+='<div class="card"><b>Next</b><div class="sub" style="margin:6px 0 12px">'+esc(nextAction(t))+(t.nextAction?' · '+esc(t.nextAction):'')+'</div><b>Done</b>'+list(t.completed)+'<b>Remaining</b>'+list(t.remaining)+'<b>Decisions</b>'+list(t.decisions)+(t.failures.length?'<b>Known failures</b>'+list(t.failures):'')+'</div>'+
        (t.reviews.length?'<div class="card"><b>Review history</b>'+t.reviews.map(function(v){return '<div class="sub">'+esc(v.at.slice(0,16).replace('T',' '))+' · '+(v.verdict==='approved'?'<span class="ok">approved</span>':'<span class="bad">sent back</span>')+' by '+esc(v.reviewer)+(v.notes?': '+esc(v.notes):'')+'</div>'}).join('')+'</div>':'')+'<div class="sub mono">'+esc(t.workdir)+'</div>';
    }else if(detailTab==='context'){
      h+='<div class="card"><div class="sub" style="margin-bottom:8px">What every agent gets on this task, whichever tool it is: Claude Code, Codex, Copilot or any MCP agent. It is built live from the project\'s memory (the vault), the team and the review rules.</div><pre class="ctx">'+esc((r[1]&&r[1].context)||(first?'Loading…':'(empty)'))+'</pre></div>';
    }else if(detailTab==='live'&&r[2]){
      h+='<div class="card"><div class="sub">'+esc(name(t.liveSession.agentId))+' · attach with <span class="mono">agentbrain attach '+esc(t.liveSession.sessionId)+'</span></div><pre>'+esc((r[2].transcript||[]).join('\n'))+'</pre></div>';
    }
    m.innerHTML=h+'</div>';if(keepScroll)scroller().scrollTop=keepScroll;else if(first)scroller().scrollTop=0;
    document.getElementById('back').onclick=function(){detailTab='changes';setTab('home')};
    var oe=document.getElementById('openEditor');if(oe)oe.onclick=function(){post('/api/open',{taskId:t.id})};
    var ap=document.getElementById('approve');if(ap)ap.onclick=function(){post('/api/review',{taskId:t.id,verdict:'approved'}).then(function(x){if(x.ok)toast('Approved')})};
    var sb=document.getElementById('sendBack');if(sb)sb.onclick=function(){var n=prompt('What should change?');if(n)post('/api/review',{taskId:t.id,verdict:'changes',notes:n}).then(function(x){if(x.ok)toast('Sent back')})};
    var close=document.getElementById('closeTask');if(close)close.onclick=function(){var choices=['Accidental task','Duplicate task','No longer needed','Already handled'];var answer=prompt('Close task as:\n1. Accidental task\n2. Duplicate task\n3. No longer needed\n4. Already handled','1');if(!answer)return;var index=Number(answer.trim());if(!/^[1-4]$/.test(answer.trim())){toast('Choose 1, 2, 3, or 4');return}close.disabled=true;post('/api/close',{taskId:t.id,reason:choices[index-1]}).then(function(x){if(x.ok){toast('Task closed');setTab('home')}else close.disabled=false})};
    m.querySelectorAll('[data-dtab]').forEach(function(b){b.onclick=function(){detailTab=b.dataset.dtab;detailKey='';renderTask()}});
    m.querySelectorAll('[data-file]').forEach(function(d){d.onclick=function(){var p=d.dataset.file,f=files.find(function(x){return x.path===p});var cur=openFiles[p]!==undefined?openFiles[p]:f.rows.length<=400;openFiles[p]=!cur;detailKey='';renderTask()}});
    m.querySelectorAll('[data-jump]').forEach(function(a){a.onclick=function(e){e.preventDefault();var el=document.getElementById('f'+a.dataset.jump);if(el)el.scrollIntoView({behavior:'smooth',block:'start'})}});
  }
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
var pointerDown=false,pendingRender=false;
document.addEventListener('keydown',function(e){var t=e.target;if(e.key==='n'&&!e.metaKey&&!e.ctrlKey&&!e.altKey&&!(t&&(/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)||t.isContentEditable))){e.preventDefault();newTask()}});
document.addEventListener('pointerdown',function(){pointerDown=true},true);
document.addEventListener('pointerup',function(){setTimeout(function(){pointerDown=false;if(pendingRender){pendingRender=false;render()}},0)},true);
/* ---------- git ---------- */
var gitData=null,gitLoading=false,gitAt=0,lastGit='',gitFetching=false;
var GICON={cloud:'<path d="M7 18h10.5a4 4 0 0 0 .4-7.98A6 6 0 0 0 6.2 9.6 4.2 4.2 0 0 0 7 18z"/>',laptop:'<rect x="4" y="5" width="16" height="11" rx="1.5"/><path d="M2 19h20"/>',branch:'<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="7" r="2"/><path d="M6 7v10M18 9c0 5-12 3-12 8"/>',tag:'<path d="M3 12V4h8l10 10-8 8z"/><circle cx="7.5" cy="8.5" r="1.3"/>',sync:'<path d="M20 11a8 8 0 0 0-14.6-4M4 13a8 8 0 0 0 14.6 4"/><path d="M5 3v4h4M19 21v-4h-4"/>',ext:'<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>'};
function gi(n,s){return '<svg class="gi" viewBox="0 0 24 24" width="'+(s||13)+'" height="'+(s||13)+'">'+GICON[n]+'</svg>'}
function loadGit(){if(gitLoading)return;gitLoading=true;api('/api/git').then(function(d){gitLoading=false;gitAt=Date.now();if(d&&d.error){toast(d.error);return}gitData=d;if(view==='git')renderGit()}).catch(function(){gitLoading=false;gitAt=Date.now()})}
function laneX(j){return 10+j*14}
function laneColor(j){return PALETTE[j%PALETTE.length]}
function graphCell(c,w,isHead){
  var R=c.row,H=32,cy=16,x=laneX(R.lane),W=w*14+8;
  var s='<svg class="gg" width="'+W+'" height="'+H+'" viewBox="0 0 '+W+' '+H+'">';
  R.through.forEach(function(j){s+='<path d="M'+laneX(j)+' 0V'+H+'" stroke="'+laneColor(j)+'"/>'});
  R.into.forEach(function(j){var xj=laneX(j);s+='<path d="M'+xj+' 0'+(xj===x?'V'+cy:'C'+xj+' '+(cy-4)+' '+x+' '+(cy-10)+' '+x+' '+cy)+'" stroke="'+laneColor(j)+'"/>'});
  R.out.forEach(function(k){var xk=laneX(k);s+='<path d="M'+x+' '+cy+(xk===x?'V'+H:'C'+x+' '+(cy+10)+' '+xk+' '+(cy+4)+' '+xk+' '+H)+'" stroke="'+laneColor(k)+'"/>'});
  var col=laneColor(R.lane);
  if(isHead)s+='<circle cx="'+x+'" cy="'+cy+'" r="7" fill="none" stroke="'+col+'" stroke-width="1.5" opacity=".55"/>';
  s+=c.parents.length>1?'<circle cx="'+x+'" cy="'+cy+'" r="4" fill="var(--diff-bg)" stroke="'+col+'" stroke-width="2"/>':'<circle cx="'+x+'" cy="'+cy+'" r="4" fill="'+col+'"/>';
  return s+'</svg>';
}
function refBadges(refs,byBranch){
  return refs.map(function(r){
    if(/^HEAD -> /.test(r)){var b=r.slice(8);return '<span class="ref head"'+(byBranch[b]?' data-open="'+esc(byBranch[b])+'"':'')+'>'+gi('branch',11)+esc(b)+'</span>'}
    if(r==='HEAD')return '<span class="ref head">HEAD</span>';
    if(/^tag: /.test(r))return '<span class="ref tag">'+gi('tag',11)+esc(r.slice(5))+'</span>';
    if(/^origin\//.test(r))return '<span class="ref remote" title="On the remote (as of the last fetch)">'+gi('cloud',11)+esc(r)+'</span>';
    return '<span class="ref"'+(byBranch[r]?' data-open="'+esc(byBranch[r])+'" title="Open the task"':'')+'>'+gi('branch',11)+esc(r)+'</span>';
  }).join('');
}
function renderGit(){
  var m=document.getElementById('main');
  if(!gitData){if(!gitLoading)loadGit();if(!m.querySelector('.gitview'))m.innerHTML='<div class="empty">Reading the repository…</div>';return}
  if(Date.now()-gitAt>8000)loadGit();
  var g=gitData,byBranch={};g.worktrees.forEach(function(w){if(w.task&&w.branch)byBranch[w.branch]=w.task.id});
  var remoteHost=g.web?g.web.replace(/^https:\/\//,'').split('/')[0]:'';var remoteLabel=/github/.test(remoteHost)?'GitHub':remoteHost||'the remote';
  var h='<div class="gitview"><div class="pagehead"><h1>Git</h1><span class="sub">'+esc(g.branch||'detached HEAD')+(g.upstream?' → '+esc(g.upstream):'')+'</span></div>';
  h+='<div class="gitbar">';
  if(g.remoteName){
    h+='<span class="gstat'+(g.ahead?' up':'')+'" title="Commits on this machine that '+remoteLabel+' doesn\'t have">'+gi('laptop')+(g.ahead?g.ahead+' to push':'Nothing to push')+'</span>';
    h+='<span class="gstat'+(g.behind?' down':'')+'" title="Commits on '+remoteLabel+' this machine doesn\'t have (as of the last fetch)">'+gi('cloud')+(g.behind?g.behind+' to pull':'Up to date with '+remoteLabel)+'</span>';
    h+='<span class="grow"></span><button id="gitFetch"'+(gitFetching?' disabled':'')+'>'+gi('sync')+(gitFetching?' Fetching…':' Fetch')+'</button>';
    if(g.web)h+='<a class="btn" href="'+esc(g.web)+'" target="_blank" rel="noopener">'+gi('ext')+' Open on '+esc(remoteLabel)+'</a>';
  }else h+='<span class="gstat">'+gi('laptop')+'Local repository · no remote yet</span>';
  h+='</div>';
  h+='<div class="gitcols"><div class="card gcard"><div class="label">Working tree <span class="count">'+g.changes.length+'</span></div>';
  if(!g.changes.length)h+='<div class="sub">Clean: everything is committed.</div>';
  else{h+='<div class="gchanges">'+g.changes.slice(0,40).map(function(c){var k=c.status==='??'?'U':c.status.charAt(0);var cls={M:'modified',A:'added',D:'deleted',R:'renamed',U:'added'}[k]||'modified';return '<div class="gch"><span class="fs '+cls+'">'+esc(k)+'</span><span class="mono">'+esc(c.path)+'</span></div>'}).join('')+(g.changes.length>40?'<div class="sub">and '+(g.changes.length-40)+' more</div>':'')+'</div>'}
  h+='</div><div class="card gcard"><div class="label">Worktrees <span class="count">'+g.worktrees.length+'</span></div>';
  h+='<div class="gwts">'+g.worktrees.map(function(w,i){var name=i===0?'Main checkout':w.path.split('/').slice(-1)[0];return '<div class="gwt"'+(w.task?' data-open="'+esc(w.task.id)+'"':'')+'><span class="sdot '+(w.task?dotClass(S.tasks.filter(function(t){return t.id===w.task.id})[0]||{status:w.task.status}):'done')+'"></span><div class="gwtb"><div class="gwtn">'+esc(w.task?w.task.title:name)+'</div><div class="sub mono">'+esc(w.branch||'detached')+' · '+esc((w.head||'').slice(0,7))+'</div></div></div>'}).join('')+'</div>';
  h+='</div></div>';
  h+='<h2>History <span class="count">'+g.commits.length+'</span>'+(g.remoteName?'<span class="glegend">'+gi('laptop',12)+' only on this machine · '+gi('cloud',12)+' on '+esc(remoteLabel)+'</span>':'')+'</h2>';
  h+='<div class="ggraph">'+g.commits.map(function(c){
    var where=g.remoteName?(c.local?'<span class="gwhere local" title="Only on this machine: not pushed">'+gi('laptop',12)+'</span>':'<span class="gwhere" title="On '+esc(remoteLabel)+'">'+gi('cloud',12)+'</span>'):'';
    var sha=g.web&&!c.local?'<a class="gsha" href="'+esc(g.web)+'/commit/'+c.hash+'" target="_blank" rel="noopener">'+c.hash.slice(0,7)+'</a>':'<span class="gsha">'+c.hash.slice(0,7)+'</span>';
    return '<div class="gr'+(c.hash===g.head?' head':'')+(c.local?' local':'')+'">'+graphCell(c,g.width,c.hash===g.head)+'<div class="gmsg">'+refBadges(c.refs,byBranch)+'<span class="gs" title="'+esc(c.subject)+'">'+esc(c.subject)+'</span></div><span class="gauth">'+esc(c.author)+'</span><span class="gwhen" title="'+esc(c.at)+'">'+ago(c.at)+'</span>'+where+sha+'</div>'}).join('')+'</div></div>';
  if(h===lastGit&&m.querySelector('.gitview'))return;lastGit=h;
  var top=m.scrollTop;m.innerHTML=h;m.scrollTop=top;
  var f=document.getElementById('gitFetch');if(f)f.onclick=function(){gitFetching=true;lastGit='';renderGit();post('/api/git/fetch',{}).then(function(r){gitFetching=false;if(r&&r.ok)toast('Fetched from '+remoteLabel);else if(r&&r.error)toast(r.error);gitAt=0;lastGit='';loadGit()}).catch(function(){gitFetching=false;lastGit='';renderGit()})};
  m.querySelector('.gitview').onclick=function(e){var b=e.target.closest('[data-open]');if(!b)return;selectedTask=b.dataset.open;detailTab='changes';detailKey='';setTab('tasks')};
}
function applyPanels(){var app=document.querySelector('.app');var chatting=view==='home'&&mode==='chat';var railOff=chatting?localGet('railChat')!=='1':localGet('railOff')==='1';app.classList.toggle('side-min',localGet('sideMin')==='1');app.classList.toggle('rail-off',railOff);app.classList.toggle('on-home',view==='home');var rb=document.getElementById('railBtn');if(rb){rb.title=(railOff?'Show':'Hide')+' live activity  ]';rb.classList.toggle('on',!railOff)}var sb=document.getElementById('sideBtn');if(sb)sb.title=(localGet('sideMin')==='1'?'Expand':'Collapse')+' sidebar  ['}
function toggleSide(){localSet('sideMin',localGet('sideMin')==='1'?'0':'1');applyPanels()}
function toggleRail(){var chatting=view==='home'&&mode==='chat';var key=chatting?'railChat':'railOff';var off=document.querySelector('.app').classList.contains('rail-off');localSet(key,chatting?(off?'1':'0'):(off?'0':'1'));applyPanels()}
function render(){if(!S)return;if(pointerDown){pendingRender=true;return}applyPanels();renderSide();renderRail();var mainEl=document.getElementById('main');mainEl.className=view+(view==='home'&&mode==='chat'?' chatmode':'');
  if(view==='home')renderHome();else if(view==='activity')renderActivity();else if(view==='brain')renderBrainView(!document.getElementById('graph'));else if(view==='connectors')renderConnectors();else if(view==='git')renderGit();else if(view==='settings'){if(!(settings&&settings.dirty))renderSettings()}else renderTask()}
api('/api/snapshot').then(function(x){if(x.error){document.getElementById('main').innerHTML='<div class="empty">'+esc(x.error)+'</div>';return}S=x;render()}).catch(function(){liveOff=true});
var es=new EventSource('/api/events?token='+encodeURIComponent(token));es.addEventListener('snapshot',function(e){S=JSON.parse(e.data);render()});es.onerror=function(){liveOff=true;lastRail='';render()};es.onopen=function(){liveOff=false;lastRail='';render()};
})();
</script></body></html>`;
