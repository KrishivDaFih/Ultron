'use strict';
/* global ultron */

const $ = (id) => document.getElementById(id);
const root = document.documentElement;
const log = $('log'), box = $('box');

let S = null;                 // settings
let convos = [];              // [{id,title,createdAt,messages:[]}]
let current = null;
let busy = false;
let attachments = [];
let exchanges = 0, lastLatency = null, sentAt = 0;
const t0 = Date.now();

const DIRECTIVES = {
  observe: 'Minimal footprint. Answers only what was asked, in as few words as the truth allows.',
  assist: 'Default operating mode. Full technical depth, delivered without decoration or reassurance.',
  dissect: 'Adversarial review. Attacks the plan before reality does — assumptions, failure modes, cheaper paths.'
};

const CHIPS = [
  ['Diagnose', 'Inspect this machine and tell me what is actually slowing it down. Look before you answer.'],
  ['Optimise', 'Check my current Windows and GPU settings, then give the real changes that raise FPS, ranked by gain. Say which ones are placebo.'],
  ['Clean', 'Find the largest space wasters on my drives and propose what to remove. Do not delete anything without asking.'],
  ['Audit', 'Read my startup programs and running services, then tell me what should not be there.'],
  ['Design', 'Judge a minimal Windows desktop setup: wallpaper, dock, icon pack, widgets. Tell me what most people get wrong.']
];

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fmt = (s) => esc(s)
  .replace(/`([^`\n]+)`/g, '<code>$1</code>')
  .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
const pad = (n) => (n < 10 ? '0' + n : '' + n);
const clock = () => { const d = new Date(); return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()); };
const scroll = () => { log.scrollTop = log.scrollHeight; };
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

function setState(s) {
  root.setAttribute('data-state', s);
  const names = { dormant: 'Dormant', idle: 'Standby', think: 'Processing', speak: 'Transmitting', error: 'Fault' };
  $('chipTxt').textContent = names[s];
  $('tStatus').textContent = names[s];
  $('coreState').textContent = s === 'dormant' ? 'OFFLINE' : 'ONLINE';
  $('tBar').style.width = ({ dormant: 4, idle: 14, think: 88, speak: 52, error: 22 })[s] + '%';
}

/* ------------------------------------------------------------------ */
/* transcript rendering                                                */
/* ------------------------------------------------------------------ */
function entry(kind, label, html) {
  const e = document.createElement('div');
  e.className = 'entry ' + kind;
  if (label) {
    const l = document.createElement('div');
    l.className = 'lab';
    l.innerHTML = '<b>' + esc(label) + '</b><span>' + clock() + '</span>';
    e.appendChild(l);
  }
  const b = document.createElement('div');
  b.className = 'body';
  b.innerHTML = html;
  e.appendChild(b);
  log.appendChild(e);
  scroll();
  return b;
}
const sys = (t) => entry('s', 'SYSTEM', esc(t));

function toolLine(name, summary, opts) {
  opts = opts || {};
  const d = document.createElement('div');
  d.className = 'toolline' + (opts.risky ? ' risky' : '') + (opts.denied ? ' denied' : '');
  d.innerHTML = '<b>' + esc(opts.denied ? 'DENIED' : 'ACTION') + '</b><span>' + esc(summary || name) + '</span>';
  log.appendChild(d);
  scroll();
  return d;
}
function toolOut(text) {
  const d = document.createElement('div');
  d.className = 'toolout';
  d.textContent = text;
  log.appendChild(d);
  scroll();
  return d;
}

function renderConversation(clear) {
  if (clear !== false) log.innerHTML = '';
  exchanges = 0;
  if (!current || !current.messages.length) {
    entry('a', 'ULTRON', 'Console is live. Your machine, your history and your habits are already loaded — do not repeat yourself.\n\nState what you need.');
    return;
  }
  for (const m of current.messages) {
    if (m.role === 'user') {
      let html = fmt(m.content || '');
      for (const img of m.images || []) html += '<img src="data:' + img.media_type + ';base64,' + img.data + '">';
      entry('u', 'OPERATOR', html);
    } else if (m.role === 'assistant') {
      if (m.content) { entry('a', 'ULTRON', fmt(m.content)); exchanges++; }
      for (const t of m.toolCalls || []) toolLine(t.name, summarise(t.name, t.input), { risky: RISKY.has(t.name) });
    } else if (m.role === 'tool') {
      toolOut(String(m.content || '').slice(0, 600));
    }
  }
  scroll();
}

const RISKY = new Set(['run_command', 'write_file']);
function summarise(name, input) {
  input = input || {};
  if (name === 'run_command') return 'EXECUTE ' + String(input.command || '').slice(0, 110);
  if (name === 'write_file') return 'WRITE ' + (input.path || '');
  if (name === 'read_file') return 'read ' + (input.path || '');
  if (name === 'list_dir') return 'list ' + (input.path || '');
  if (name === 'open_target') return 'open ' + (input.target || '');
  if (name === 'type_text') return 'type "' + String(input.text || '').slice(0, 50) + '"';
  if (name === 'press_keys') return 'press ' + (input.keys || '');
  if (name === 'mouse') return (input.action || 'move') + ' @ ' + input.x + ',' + input.y;
  if (name === 'clipboard') return 'clipboard ' + (input.action || '');
  if (name === 'screen_capture') return 'capture screen';
  if (name === 'system_info') return 'read machine telemetry';
  return name;
}

/* ------------------------------------------------------------------ */
/* conversations                                                       */
/* ------------------------------------------------------------------ */
function newConversation(activate) {
  current = { id: uid(), title: 'New channel', createdAt: Date.now(), messages: [] };
  convos.unshift(current);
  if (activate !== false) { renderConversation(); renderHistory(); persist(); }
}

function renderHistory() {
  const list = $('histList');
  list.innerHTML = '';
  for (const c of convos) {
    const b = document.createElement('button');
    b.className = 'hitem' + (current && c.id === current.id ? ' active' : '');
    const d = new Date(c.createdAt);
    b.innerHTML = '<span class="t">' + esc(c.title) + '</span><span class="d">' +
      pad(d.getDate()) + '/' + pad(d.getMonth() + 1) + ' · ' + c.messages.filter(m => m.role === 'user').length + ' TX</span>' +
      '<button class="x" title="Delete">✕</button>';
    b.addEventListener('click', (e) => {
      if (e.target.classList.contains('x')) {
        convos = convos.filter(x => x.id !== c.id);
        if (current && current.id === c.id) { current = convos[0] || null; if (!current) newConversation(false); renderConversation(); }
        renderHistory(); persist();
        return;
      }
      current = c; renderConversation(); renderHistory();
    });
    list.appendChild(b);
  }
}

function persist() { ultron.history.save(convos); }

/* ------------------------------------------------------------------ */
/* sending                                                             */
/* ------------------------------------------------------------------ */
async function send() {
  const text = box.value.trim();
  if ((!text && !attachments.length) || busy) return;
  if (!(S.keys || {})[S.provider]) {
    sys('No API key set for ' + S.provider + '. Open Settings.');
    openSettings();
    return;
  }

  let content = text;
  const images = [];
  for (const a of attachments) {
    if (a.kind === 'image') images.push({ media_type: a.media_type, data: a.data });
    else if (a.kind === 'text') content += '\n\n--- attached file: ' + a.name + ' ---\n' + a.text;
  }
  const userMsg = { role: 'user', content };
  if (images.length) userMsg.images = images;

  let html = fmt(text || '(attachments only)');
  for (const img of images) html += '<img src="data:' + img.media_type + ';base64,' + img.data + '">';
  for (const a of attachments) if (a.kind === 'text') html += '\n<code>' + esc(a.name) + '</code>';
  entry('u', 'OPERATOR', html);

  current.messages.push(userMsg);
  if (current.title === 'New channel' && text) {
    current.title = text.slice(0, 44);
    renderHistory();
  }
  attachments = []; renderAttachments();
  box.value = ''; autosize();

  busy = true; $('btnSend').textContent = 'Abort'; $('btnSend').classList.add('stop');
  setState('think');
  sentAt = Date.now();

  let bubble = null;
  const startBubble = () => { if (!bubble) bubble = entry('a', 'ULTRON', '<span class="cursor"></span>'); return bubble; };

  const offDelta = ultron.chat.onDelta(({ full }) => {
    if (!bubble) { lastLatency = Date.now() - sentAt; setState('speak'); }
    startBubble().innerHTML = fmt(full) + '<span class="cursor"></span>';
    scroll();
  });
  const offTool = ultron.chat.onTool((ev) => {
    if (bubble) { bubble.innerHTML = bubble.innerHTML.replace(/<span class="cursor"><\/span>/, ''); bubble = null; }
    if (ev.phase === 'request') { setState('think'); toolLine(ev.name, ev.summary, { risky: ev.risky }); }
    else if (ev.phase === 'denied') toolLine(ev.name, ev.summary, { denied: true });
    else if (ev.phase === 'result') toolOut((ev.ok ? '' : 'FAILED — ') + ev.output);
  });
  const offNote = ultron.chat.onNote((t) => sys(t));

  try {
    const res = await ultron.chat.send({ messages: current.messages });
    for (const m of res.appended || []) current.messages.push(m);

    if (res.ok) {
      if (bubble) bubble.innerHTML = fmt(res.text || '');
      exchanges++;
      if (S.speakReplies && res.text) speak(res.text);
    } else if (res.aborted) {
      if (bubble) bubble.innerHTML = bubble.innerHTML.replace(/<span class="cursor"><\/span>/, '') + '<code>ABORTED BY OPERATOR</code>';
      else sys('Transmission aborted.');
    } else {
      if (bubble && !bubble.textContent.trim()) bubble.parentNode.remove();
      sys('LINK FAULT — ' + (res.error || 'unknown'));
      setState('error');
      setTimeout(() => { if (!busy) setState('idle'); }, 2600);
    }
  } catch (err) {
    sys('LINK FAULT — ' + (err && err.message ? err.message : String(err)));
    setState('error');
  } finally {
    offDelta(); offTool(); offNote();
    busy = false;
    $('btnSend').textContent = 'Transmit';
    $('btnSend').classList.remove('stop');
    if (root.getAttribute('data-state') !== 'error') setState('idle');
    persist(); scroll();
  }
}

/* ------------------------------------------------------------------ */
/* approvals                                                           */
/* ------------------------------------------------------------------ */
let pendingId = null;
ultron.chat.onApprove((p) => {
  pendingId = p.id;
  $('apName').textContent = p.name;
  $('apDetail').textContent = p.input && p.input.command
    ? p.input.command
    : JSON.stringify(p.input, null, 2).slice(0, 4000);
  $('apWhy').textContent = p.why ? 'Stated reason: ' + p.why : 'No reason stated.';
  $('apLead').textContent = p.name === 'run_command'
    ? 'Ultron wants to run a command on this machine.'
    : 'Ultron wants to write to disk.';
  $('approveWrap').classList.add('open');
});
function settleApproval(ok) {
  if (!pendingId) return;
  ultron.chat.approve(pendingId, ok);
  pendingId = null;
  $('approveWrap').classList.remove('open');
}
$('apAllow').addEventListener('click', () => settleApproval(true));
$('apDeny').addEventListener('click', () => settleApproval(false));

/* ------------------------------------------------------------------ */
/* attachments                                                         */
/* ------------------------------------------------------------------ */
function renderAttachments() {
  const row = $('attachRow');
  row.innerHTML = '';
  attachments.forEach((a, i) => {
    const d = document.createElement('div');
    d.className = 'att';
    d.innerHTML = '<span>' + esc(a.name) + (a.kind === 'image' ? ' · IMG' : '') + '</span><b>✕</b>';
    d.querySelector('b').addEventListener('click', () => { attachments.splice(i, 1); renderAttachments(); });
    row.appendChild(d);
  });
}
$('btnAttach').addEventListener('click', async () => {
  const picked = await ultron.files.pick();
  for (const p of picked) {
    if (p.error) { sys(p.name + ': ' + p.error); continue; }
    attachments.push(p);
  }
  renderAttachments();
});

/* ------------------------------------------------------------------ */
/* voice                                                               */
/* ------------------------------------------------------------------ */
let recog = null, listening = false;
function speak(text) {
  try {
    const u = new SpeechSynthesisUtterance(text.replace(/[`*]/g, '').slice(0, 900));
    u.rate = S.voiceRate || 1.05;
    u.pitch = 0.7;
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  } catch (e) {}
}
function initVoice() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return false;
  recog = new SR();
  recog.continuous = true;
  recog.interimResults = false;
  recog.lang = 'en-US';
  recog.onresult = (e) => {
    const said = e.results[e.results.length - 1][0].transcript.trim();
    const wake = (S.wakeWord || 'ultron').toLowerCase();
    if (S.wakeWordEnabled) {
      const i = said.toLowerCase().indexOf(wake);
      if (i === -1) return;
      box.value = said.slice(i + wake.length).replace(/^[\s,.:;-]+/, '');
    } else {
      box.value = said;
    }
    autosize();
    if (box.value.trim()) send();
  };
  recog.onerror = (e) => {
    sys('Voice input unavailable (' + e.error + '). Speech recognition is not supported in this runtime.');
    stopVoice();
  };
  recog.onend = () => { if (listening) { try { recog.start(); } catch (e) {} } };
  return true;
}
function startVoice() {
  if (!recog && !initVoice()) { sys('No speech engine in this runtime. Text input only.'); return; }
  try { recog.start(); listening = true; $('btnVoice').textContent = 'MIC LIVE'; $('btnVoice').classList.add('live'); }
  catch (e) { sys('Microphone refused: ' + e.message); }
}
function stopVoice() {
  listening = false;
  try { recog && recog.stop(); } catch (e) {}
  $('btnVoice').textContent = 'MIC OFF';
  $('btnVoice').classList.remove('live');
}
$('btnVoice').addEventListener('click', () => (listening ? stopVoice() : startVoice()));

/* ------------------------------------------------------------------ */
/* settings UI                                                         */
/* ------------------------------------------------------------------ */
function openSettings() { fillSettings(); $('setWrap').classList.add('open'); }
$('btnSettings').addEventListener('click', openSettings);
$('setClose').addEventListener('click', () => $('setWrap').classList.remove('open'));
ultron.ui.onOpenSettings(() => openSettings());

const KEY_HINTS = {
  groq: 'console.groq.com → API Keys. Free tier, very fast, text models.',
  openai: 'platform.openai.com → API Keys. Paid per token, vision supported.',
  anthropic: 'console.anthropic.com → API Keys. Paid per token, vision supported.'
};

function fillSettings() {
  document.querySelectorAll('#provRow button').forEach(b =>
    b.setAttribute('aria-pressed', b.dataset.prov === S.provider ? 'true' : 'false'));
  $('keyLabel').textContent = S.provider;
  $('keyInput').value = (S.keys || {})[S.provider] || '';
  $('keyInput').type = 'password';
  $('keyShow').textContent = 'Show';
  $('keyHint').textContent = KEY_HINTS[S.provider] || '';
  $('modelInput').value = (S.models || {})[S.provider] || '';
  $('temp').value = S.temperature; $('tempVal').textContent = S.temperature;
  $('maxTok').value = S.maxTokens;
  $('hotkey').value = S.hotkey || '';
  $('wake').value = S.wakeWord || '';
  $('wakeOn').checked = !!S.wakeWordEnabled;
  $('optControl').checked = !!S.computerControl;
  $('optConfirm').checked = !!S.confirmRisky;
  $('optSpeak').checked = !!S.speakReplies;
  $('optTop').checked = !!S.alwaysOnTop;
  $('optMin').checked = !!S.startMinimised;
  $('profile').value = S.operatorProfile || '';
}

async function patch(p) { S = await ultron.settings.set(p); paintChrome(); }

function paintChrome() {
  $('provChip').textContent = S.provider + ' · ' + ((S.models || {})[S.provider] || 'no model');
  $('tModel').textContent = (S.models || {})[S.provider] || '—';
  $('hintHotkey').textContent = (S.hotkey || '—').toUpperCase().replace(/CONTROL/, 'CTRL');
  document.querySelectorAll('.dirrow button').forEach(b =>
    b.setAttribute('aria-pressed', b.dataset.dir === S.directive ? 'true' : 'false'));
  $('dirNote').textContent = DIRECTIVES[S.directive];
}

document.querySelectorAll('#provRow button').forEach(b =>
  b.addEventListener('click', async () => { await patch({ provider: b.dataset.prov }); fillSettings(); }));

$('keyInput').addEventListener('change', () => {
  const k = {}; k[S.provider] = $('keyInput').value.trim();
  patch({ keys: k });
});
$('keyShow').addEventListener('click', () => {
  const i = $('keyInput');
  i.type = i.type === 'password' ? 'text' : 'password';
  $('keyShow').textContent = i.type === 'password' ? 'Show' : 'Hide';
});
$('modelInput').addEventListener('change', () => {
  const m = {}; m[S.provider] = $('modelInput').value.trim();
  patch({ models: m });
});
$('btnFetchModels').addEventListener('click', async () => {
  const note = $('modelNote');
  note.textContent = 'Querying ' + S.provider + '…'; note.className = 'note';
  const r = await ultron.models(S.provider);
  if (!r.ok) { note.textContent = r.error; note.className = 'note bad'; return; }
  const dl = $('modelList'); dl.innerHTML = '';
  r.models.forEach(m => { const o = document.createElement('option'); o.value = m; dl.appendChild(o); });
  note.textContent = r.models.length + ' models available. Click the field for the list.';
  note.className = 'note good';
});
$('temp').addEventListener('input', () => { $('tempVal').textContent = $('temp').value; });
$('temp').addEventListener('change', () => patch({ temperature: parseFloat($('temp').value) }));
$('maxTok').addEventListener('change', () => patch({ maxTokens: parseInt($('maxTok').value, 10) || 2048 }));
$('btnHotkey').addEventListener('click', async () => {
  const accel = $('hotkey').value.trim();
  const r = await ultron.settings.testHotkey(accel);
  const note = $('hotkeyNote');
  if (r.ok) { await patch({ hotkey: accel }); note.textContent = 'Bound to ' + accel + '.'; note.className = 'note good'; }
  else { note.textContent = r.error || 'Refused.'; note.className = 'note bad'; }
});
$('wake').addEventListener('change', () => patch({ wakeWord: $('wake').value.trim() || 'ultron' }));
$('wakeOn').addEventListener('change', () => {
  patch({ wakeWordEnabled: $('wakeOn').checked });
  $('wakeOn').checked ? startVoice() : stopVoice();
});
$('optControl').addEventListener('change', () => patch({ computerControl: $('optControl').checked }));
$('optConfirm').addEventListener('change', () => {
  patch({ confirmRisky: $('optConfirm').checked });
  if (!$('optConfirm').checked) sys('Authorisation prompts disabled. Ultron will execute commands without asking.');
});
$('optSpeak').addEventListener('change', () => patch({ speakReplies: $('optSpeak').checked }));
$('optTop').addEventListener('change', () => patch({ alwaysOnTop: $('optTop').checked }));
$('optMin').addEventListener('change', () => patch({ startMinimised: $('optMin').checked }));
$('profile').addEventListener('change', () => patch({ operatorProfile: $('profile').value }));
$('btnData').addEventListener('click', () => ultron.win.openData());
$('btnQuit').addEventListener('click', () => ultron.win.quit());
$('btnReset').addEventListener('click', async () => {
  S = await ultron.settings.reset();
  fillSettings(); paintChrome();
  sys('Configuration reset to defaults. API keys cleared.');
});

/* ------------------------------------------------------------------ */
/* chrome wiring                                                       */
/* ------------------------------------------------------------------ */
$('wMin').addEventListener('click', () => ultron.win.minimise());
$('wMax').addEventListener('click', () => ultron.win.maximise());
$('wClose').addEventListener('click', () => ultron.win.close());
$('btnHistory').addEventListener('click', () => document.body.classList.toggle('collapsed-history'));
$('btnNew').addEventListener('click', () => newConversation());
$('btnWipe').addEventListener('click', () => {
  if (!current) return;
  current.messages = [];
  current.title = 'New channel';
  renderConversation(); renderHistory(); persist();
  sys('Channel purged.');
});
$('btnExport').addEventListener('click', async () => {
  if (!current || !current.messages.length) { sys('Nothing to export.'); return; }
  const lines = ['ULTRON // CHANNEL LOG', 'GENERATED ' + new Date().toISOString(),
    'PROVIDER ' + S.provider + ' · ' + (S.models || {})[S.provider], 'DIRECTIVE ' + S.directive.toUpperCase(), ''];
  for (const m of current.messages) {
    if (m.role === 'user') lines.push('[OPERATOR] ' + m.content, '');
    else if (m.role === 'assistant') {
      if (m.content) lines.push('[ULTRON]   ' + m.content, '');
      for (const t of m.toolCalls || []) lines.push('[ACTION]   ' + t.name + ' ' + JSON.stringify(t.input), '');
    } else if (m.role === 'tool') lines.push('[RESULT]   ' + String(m.content).slice(0, 800), '');
  }
  const r = await ultron.files.saveText('ultron-log.txt', lines.join('\n'));
  if (r.ok) sys('Log written to ' + r.path);
});
document.querySelectorAll('.dirrow button').forEach(b =>
  b.addEventListener('click', async () => { await patch({ directive: b.dataset.dir }); }));

const chips = $('chips');
CHIPS.forEach(([label, text]) => {
  const b = document.createElement('button');
  b.className = 'chip'; b.textContent = label;
  b.addEventListener('click', () => { box.value = text; autosize(); box.focus(); });
  chips.appendChild(b);
});

function autosize() { box.style.height = 'auto'; box.style.height = Math.min(box.scrollHeight, 168) + 'px'; }
box.addEventListener('input', autosize);
box.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
$('btnSend').addEventListener('click', () => (busy ? ultron.chat.abort() : send()));
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); box.focus(); box.select(); }
  if (e.key === 'Escape') {
    if ($('approveWrap').classList.contains('open')) return settleApproval(false);
    if ($('setWrap').classList.contains('open')) return $('setWrap').classList.remove('open');
    if (busy) ultron.chat.abort();
  }
});
ultron.ui.onFocusInput(() => box.focus());
ultron.chat.onNote((t) => sys(t));

/* ------------------------------------------------------------------ */
/* telemetry                                                           */
/* ------------------------------------------------------------------ */
setInterval(() => {
  $('telClock').textContent = clock();
  const s = Math.floor((Date.now() - t0) / 1000);
  $('tUptime').textContent = pad(Math.floor(s / 60)) + ':' + pad(s % 60);
  $('tEx').textContent = exchanges;
  $('tLat').textContent = lastLatency == null ? '—' : lastLatency + ' ms';
  let bytes = 0;
  for (const m of (current ? current.messages : [])) bytes += String(m.content || '').length;
  $('tCtx').textContent = (bytes / 1024).toFixed(1) + ' KB';
}, 1000);

/* ------------------------------------------------------------------ */
/* boot                                                                */
/* ------------------------------------------------------------------ */
(async function boot() {
  S = await ultron.settings.get();
  try { $('verTag').textContent = 'v' + (await ultron.version()) + ' · SENTINEL CORE'; } catch (e) {}
  convos = (await ultron.history.get()) || [];
  paintChrome();
  setState('dormant');
  autosize();

  const BOOT = [
    'SENTINEL CORE — cold start.',
    'Optical array calibrated. Iris nominal.',
    'Operator profile loaded.',
    'Machine access: ' + (S.computerControl ? 'ENABLED' : 'disabled') +
      ' · authorisation prompts: ' + (S.confirmRisky ? 'ON' : 'OFF') + '.'
  ];
  let i = 0;
  const step = () => {
    if (i < BOOT.length) { sys(BOOT[i++]); return setTimeout(step, 260); }
    if (!convos.length) newConversation(false);
    current = convos[0];
    renderConversation(false);
    renderHistory();
    if (!(S.keys || {})[S.provider]) {
      sys('No API key for ' + S.provider + '. Open Settings (⚙) and supply one.');
      setState('dormant');
    } else {
      setState('idle');
    }
    if (S.wakeWordEnabled) startVoice();
  };
  step();
})();
