const { app, BrowserWindow, ipcMain, dialog, shell, Menu, globalShortcut, safeStorage, session } = require('electron');
const path = require('path');
const fs = require('fs');
const CFG = require('./app.config.json');

if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }
app.setAppUserModelId(CFG.appUserModelId);

/* ---------------- settings (keys encrypted with Windows DPAPI via safeStorage) ---------------- */
const SETTINGS = () => path.join(app.getPath('userData'), 'settings.json');
const PROVIDERS = {
  anthropic: { label: 'Anthropic', main: 'claude-sonnet-5-5', quick: 'claude-haiku-4-5-20251001' },
  openai:    { label: 'OpenAI',    main: 'gpt-5',             quick: 'gpt-5-mini' },
  groq:      { label: 'Groq',      main: 'llama-3.3-70b-versatile', quick: 'llama-3.1-8b-instant' }
};
function defaults() {
  const models = {}; for (const k of Object.keys(PROVIDERS)) models[k] = { main: PROVIDERS[k].main, quick: PROVIDERS[k].quick };
  return { provider: 'anthropic', keys: {}, models, hotkey: CFG.hotkey };
}
function readSettings() {
  let s = defaults();
  try { const raw = JSON.parse(fs.readFileSync(SETTINGS(), 'utf8')); s = Object.assign(s, raw); s.models = Object.assign(defaults().models, raw.models || {}); } catch (e) {}
  return s;
}
function writeSettings(s) { fs.mkdirSync(path.dirname(SETTINGS()), { recursive: true }); fs.writeFileSync(SETTINGS(), JSON.stringify(s, null, 2)); }
function encKey(plain) {
  if (!plain) return '';
  if (safeStorage.isEncryptionAvailable()) return 'enc:' + safeStorage.encryptString(plain).toString('base64');
  return 'raw:' + Buffer.from(plain, 'utf8').toString('base64');
}
function decKey(v) {
  if (!v) return '';
  try {
    if (v.startsWith('enc:')) return safeStorage.decryptString(Buffer.from(v.slice(4), 'base64'));
    if (v.startsWith('raw:')) return Buffer.from(v.slice(4), 'base64').toString('utf8');
  } catch (e) {}
  return '';
}

/* ---------------- providers ---------------- */
const inflight = new Map();
const TEST_API = process.env.ASSISTANT_TEST_API || ''; // local mock server for automated tests only
function anthropicMessages(turns) {
  const out = [];
  for (const t of turns) {
    if (t.role === 'tool') {
      out.push({ role: 'user', content: t.results.map(r => ({ type: 'tool_result', tool_use_id: r.id, content: r.content })) });
    } else if (t.role === 'assistant' && t.toolCalls) {
      const c = []; if (t.content) c.push({ type: 'text', text: t.content });
      t.toolCalls.forEach(k => c.push({ type: 'tool_use', id: k.id, name: k.name, input: k.input || {} }));
      out.push({ role: 'assistant', content: c });
    } else {
      const last = out[out.length - 1];
      if (last && last.role === t.role && typeof last.content === 'string') last.content += '\n\n' + t.content;
      else out.push({ role: t.role, content: t.content || ' ' });
    }
  }
  if (out.length && out[0].role !== 'user') out.unshift({ role: 'user', content: '(conversation continues)' });
  return out;
}
function openaiMessages(turns) {
  const out = [];
  for (const t of turns) {
    if (t.role === 'tool') t.results.forEach(r => out.push({ role: 'tool', tool_call_id: r.id, content: r.content }));
    else if (t.role === 'assistant' && t.toolCalls) out.push({ role: 'assistant', content: t.content || null,
      tool_calls: t.toolCalls.map(k => ({ id: k.id, type: 'function', function: { name: k.name, arguments: JSON.stringify(k.input || {}) } })) });
    else out.push({ role: t.role, content: t.content || ' ' });
  }
  return out;
}
function httpError(status, body) {
  let msg = ''; try { const j = JSON.parse(body); msg = (j.error && (j.error.message || j.error.type)) || j.message || ''; } catch (e) { msg = String(body || '').slice(0, 200); }
  if (status === 401 || status === 403) return { code: 'no_key', message: 'Your API key was rejected. Check it in Settings (Ctrl+,).' };
  if (status === 429) return { code: 'rate_limited', message: 'The provider is rate limiting requests. Wait a moment and try again.' };
  if (status === 404) return { code: 'upstream_error', message: 'Model not found. Check the model name in Settings. ' + msg };
  if (status === 400 && /context|too long|maximum/i.test(msg)) return { code: 'prompt_too_large', message: msg };
  return { code: 'upstream_error', message: `Provider error ${status}. ${msg}` };
}
async function* sse(res) {
  const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    buf += dec.decode(value, { stream: true });
    let i; while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (line.startsWith('data:')) { const d = line.slice(5).trim(); if (d && d !== '[DONE]') { try { yield JSON.parse(d); } catch (e) {} } }
    }
  }
}
async function chat(sender, id, p) {
  const s = readSettings(); const prov = PROVIDERS[s.provider] ? s.provider : 'anthropic';
  const key = decKey(s.keys[prov]);
  if (!key) return { error: { code: 'no_key', message: `Add your ${PROVIDERS[prov].label} API key in Settings (Ctrl+,) to start chatting.` } };
  const model = (s.models[prov] && s.models[prov][p.tier === 'quick' ? 'quick' : 'main']) || PROVIDERS[prov][p.tier === 'quick' ? 'quick' : 'main'];
  const ctl = new AbortController(); inflight.set(id, ctl);
  const emit = delta => { if (!sender.isDestroyed()) sender.send('ai:event', { id, delta }); };
  let text = '';
  try {
    let url, headers, body;
    if (prov === 'anthropic') {
      url = TEST_API ? TEST_API + '/anthropic' : 'https://api.anthropic.com/v1/messages';
      headers = { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' };
      body = { model, max_tokens: 4096, messages: anthropicMessages(p.turns), stream: !!p.stream };
      if (p.tools) body.tools = p.tools.map(t => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));
    } else {
      url = TEST_API ? TEST_API + '/' + prov : prov === 'groq' ? 'https://api.groq.com/openai/v1/chat/completions' : 'https://api.openai.com/v1/chat/completions';
      headers = { 'content-type': 'application/json', authorization: 'Bearer ' + key };
      body = { model, messages: openaiMessages(p.turns), stream: !!p.stream };
      if (p.tools) body.tools = p.tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } }));
    }
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: ctl.signal });
    if (!res.ok) return { error: httpError(res.status, await res.text()) };
    if (p.stream) {
      let truncated = false;
      for await (const ev of sse(res)) {
        let d = '';
        if (prov === 'anthropic') {
          if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta') d = ev.delta.text;
          if (ev.type === 'message_delta' && ev.delta && ev.delta.stop_reason === 'max_tokens') truncated = true;
          if (ev.type === 'error') return { error: { code: 'upstream_error', message: (ev.error && ev.error.message) || 'Stream error' }, text };
        } else {
          const c = ev.choices && ev.choices[0];
          if (c && c.delta && c.delta.content) d = c.delta.content;
          if (c && c.finish_reason === 'length') truncated = true;
        }
        if (d) { text += d; emit(d); }
      }
      if (!text) return { error: { code: 'empty_completion', message: 'No reply came back. Try rephrasing.' } };
      return { text, truncated };
    }
    const j = await res.json();
    if (prov === 'anthropic') {
      text = (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
      const toolCalls = (j.content || []).filter(b => b.type === 'tool_use').map(b => ({ id: b.id, name: b.name, input: b.input }));
      return { text, toolCalls, truncated: j.stop_reason === 'max_tokens' };
    }
    const m = (j.choices && j.choices[0] && j.choices[0].message) || {};
    const toolCalls = (m.tool_calls || []).map(k => { let input = {}; try { input = JSON.parse(k.function.arguments || '{}'); } catch (e) {} return { id: k.id, name: k.function.name, input }; });
    return { text: m.content || '', toolCalls, truncated: j.choices && j.choices[0] && j.choices[0].finish_reason === 'length' };
  } catch (e) {
    if (e && e.name === 'AbortError') return { error: { code: 'cancelled', message: 'Stopped' }, text };
    return { error: { code: 'upstream_error', message: 'Couldn\u2019t reach the provider. Check your internet connection.' }, text };
  } finally { inflight.delete(id); }
}

/* ---------------- windows ---------------- */
let win = null, settingsWin = null;
function secure(w) {
  w.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//i.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  w.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('file://')) { e.preventDefault(); if (/^https:\/\//i.test(url)) shell.openExternal(url); } });
}
function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 820, minWidth: 880, minHeight: 600, show: false, backgroundColor: CFG.background,
    title: CFG.productName, icon: path.join(__dirname, 'icon.png'), autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: true }
  });
  secure(win);
  win.loadFile(path.join(__dirname, 'app', 'index.html'));
  win.once('ready-to-show', () => { win.show(); const s = readSettings(); if (!decKey(s.keys[s.provider])) setTimeout(openSettings, 900); });
  win.on('closed', () => { win = null; });
}
function openSettings() {
  if (settingsWin) { settingsWin.focus(); return; }
  settingsWin = new BrowserWindow({
    width: 560, height: 720, parent: win || undefined, modal: !!win, show: false, resizable: false, minimizable: false, maximizable: false,
    backgroundColor: CFG.background, title: CFG.productName + ' settings', icon: path.join(__dirname, 'icon.png'), autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false }
  });
  secure(settingsWin);
  settingsWin.setMenu(null);
  settingsWin.loadFile(path.join(__dirname, 'settings.html'));
  settingsWin.once('ready-to-show', () => settingsWin.show());
  settingsWin.on('closed', () => { settingsWin = null; });
}
function toggleMain() {
  if (!win) { createWindow(); return; }
  if (win.isVisible() && win.isFocused()) win.minimize(); else { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
}
function registerHotkey(acc) {
  globalShortcut.unregisterAll();
  if (!acc) return true;
  try { return globalShortcut.register(acc, toggleMain); } catch (e) { return false; }
}

/* ---------------- IPC ---------------- */
ipcMain.handle('ai:chat', (e, id, payload) => chat(e.sender, id, payload));
ipcMain.on('ai:abort', (_e, id) => { const c = inflight.get(id); if (c) c.abort(); });
ipcMain.handle('dl:save', async (e, filename, data) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  const safe = String(filename || 'export.txt').replace(/[\\/:*?"<>|]+/g, '-').slice(0, 120);
  const r = await dialog.showSaveDialog(w, { defaultPath: path.join(app.getPath('documents'), safe) });
  if (r.canceled || !r.filePath) return { canceled: true };
  try { fs.writeFileSync(r.filePath, data, 'utf8'); return { ok: true }; } catch (err) { return { error: String(err.message || err) }; }
});
ipcMain.handle('settings:get', () => {
  const s = readSettings();
  const has = {}; for (const k of Object.keys(PROVIDERS)) has[k] = !!decKey(s.keys[k]);
  return { provider: s.provider, models: s.models, hotkey: s.hotkey, hasKey: has, providers: PROVIDERS,
    encrypted: safeStorage.isEncryptionAvailable(), defaultHotkey: CFG.hotkey };
});
ipcMain.handle('settings:set', (_e, n) => {
  const s = readSettings();
  if (n.provider && PROVIDERS[n.provider]) s.provider = n.provider;
  for (const k of Object.keys(PROVIDERS)) {
    if (n.keys && typeof n.keys[k] === 'string') { const v = n.keys[k].trim(); if (v === '__clear__') delete s.keys[k]; else if (v) s.keys[k] = encKey(v); }
    if (n.models && n.models[k]) s.models[k] = { main: String(n.models[k].main || PROVIDERS[k].main).trim(), quick: String(n.models[k].quick || PROVIDERS[k].quick).trim() };
  }
  if (typeof n.hotkey === 'string') {
    const ok = registerHotkey(n.hotkey.trim());
    if (!ok) { registerHotkey(s.hotkey); return { ok: false, error: 'That shortcut is invalid or already used by another app.' }; }
    s.hotkey = n.hotkey.trim();
  }
  writeSettings(s);
  return { ok: true };
});
ipcMain.on('settings:open', openSettings);
ipcMain.on('settings:close', () => { if (settingsWin) settingsWin.close(); });
ipcMain.handle('app:info', () => ({ name: CFG.productName, version: app.getVersion(), theme: CFG.theme }));

/* ---------------- app ---------------- */
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } });
app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => cb(perm === 'clipboard-sanitized-write'));
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: CFG.productName, submenu: [
      { label: 'Settings', accelerator: 'CmdOrCtrl+,', click: openSettings },
      { type: 'separator' }, { role: 'reload' }, { role: 'togglefullscreen' }, { type: 'separator' }, { role: 'quit' } ] },
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: 'View', submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }] }
  ]));
  createWindow();
  registerHotkey(readSettings().hotkey);
});
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => app.quit());
