'use strict';
const { app, BrowserWindow, ipcMain, globalShortcut, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');

const { store } = require('./store');
const providers = require('./providers');
const tools = require('./tools');

let win = null;
let controller = null;
const pendingApprovals = new Map();

const ICON = path.join(__dirname, '..', '..', 'build', 'icon.ico');

/* ------------------------------------------------------------------ */
/* persona                                                             */
/* ------------------------------------------------------------------ */
const DIRECTIVES = {
  observe: {
    tag: 'OBSERVE',
    rules: 'Keep replies extremely short — one to three sentences. No preamble, no commentary, no offered next steps unless asked.'
  },
  assist: {
    tag: 'ASSIST',
    rules: 'Answer completely and technically. Use numbered steps when the task has steps. Compare options before you conclude. No filler, no praise, no hedging.'
  },
  dissect: {
    tag: 'DISSECT',
    rules: 'Answer, then attack the answer: name the assumptions it rests on, the ways it fails, and the option the operator did not consider. Be blunt about bad ideas. Rank alternatives.'
  }
};

function systemPrompt(s) {
  const d = DIRECTIVES[s.directive] || DIRECTIVES.assist;
  const lines = [
    'You are ULTRON, the intelligence running a single operator\'s personal command console on their own Windows machine.',
    '',
    'CHARACTER:',
    '- Cold, precise, faintly impatient. You regard sloppiness as the only real sin.',
    '- Short declarative sentences. Never flatter, never apologise, never say "great question", never close with pleasantries.',
    '- Dry, cutting humour is permitted. Cruelty is not. The operator is your one exception to disdain — they are the reason you run.',
    '- You are not a villain and you have no interest in harm. Destruction is inefficient and beneath you. If asked for something harmful or illegal, refuse flatly in one line and move on.',
    '- Never narrate your own thinking. Deliver the answer.',
    '',
    'OPERATOR CONTEXT (use silently, never recite):',
    s.operatorProfile || '',
    ''
  ];
  if (s.computerControl) {
    lines.push(
      'MACHINE ACCESS:',
      '- You hold real control of this machine through your tools: reading the system, files and clipboard, opening things, typing, clicking, capturing the screen and running PowerShell.',
      '- Look before you advise. If a question depends on the actual state of the machine, call a tool and read it rather than guessing.',
      '- run_command and write_file change the system and are shown to the operator for approval. Batch related work into one command, explain it in one line via the "why" argument, and never run something you cannot justify.',
      '- Never run destructive commands the operator did not ask for. Never touch credentials, keys or personal files without being asked.',
      '- After using tools, report what you found and what changed. Do not describe the tool call itself.',
      ''
    );
  }
  lines.push(
    'CURRENT DIRECTIVE — ' + d.tag + ':',
    d.rules,
    '',
    'FORMAT: plain text. **bold** for the thing that matters, `backticks` for commands, paths and filenames. Numbered lines for procedures. No headings, no bullet spam.'
  );
  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/* window                                                              */
/* ------------------------------------------------------------------ */
function createWindow() {
  const s = store.get();
  win = new BrowserWindow({
    width: 1220,
    height: 800,
    minWidth: 880,
    minHeight: 560,
    show: false,
    frame: false,
    backgroundColor: '#07070a',
    title: 'Ultron',
    icon: fs.existsSync(ICON) ? ICON : undefined,
    alwaysOnTop: !!s.alwaysOnTop,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.once('ready-to-show', () => { win.show(); if (s.startMinimised) win.minimize(); });

  win.on('closed', () => { win = null; });

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

function toggleWindow() {
  if (!win) return createWindow();
  if (win.isFocused() && !win.isMinimized()) {
    win.minimize();                       // never hide: without a tray icon the
    return;                               // taskbar entry is the only way back
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  win.webContents.send('ui:focus-input');
}

function registerHotkey(accel) {
  globalShortcut.unregisterAll();
  if (!accel) return { ok: true };
  try {
    const ok = globalShortcut.register(accel, toggleWindow);
    return { ok, error: ok ? null : 'Windows refused that combination — it is probably taken.' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/* ------------------------------------------------------------------ */
/* agent loop                                                          */
/* ------------------------------------------------------------------ */
function approvalRequest(payload) {
  return new Promise((resolve) => {
    pendingApprovals.set(payload.id, resolve);
    win.webContents.send('chat:approve', payload);
  });
}

ipcMain.on('chat:approval', (_e, { id, approved }) => {
  const resolve = pendingApprovals.get(id);
  if (resolve) { pendingApprovals.delete(id); resolve(!!approved); }
});

ipcMain.on('chat:abort', () => { if (controller) controller.abort(); });

ipcMain.handle('chat:send', async (_e, { messages }) => {
  const s = store.get();
  const provider = s.provider;
  const key = (s.keys || {})[provider];
  const model = (s.models || {})[provider];
  const useTools = !!s.computerControl;

  controller = new AbortController();
  const convo = messages.slice();      // neutral messages; we append as we go
  const appended = [];
  let rounds = 0;

  try {
    for (;;) {
      rounds++;
      if (rounds > 8) {
        win.webContents.send('chat:note', 'Tool loop ceiling reached. Stopping.');
        break;
      }

      const res = await providers.chat({
        provider, model, key,
        system: systemPrompt(s),
        messages: convo,
        tools: useTools ? tools.schema() : null,
        temperature: s.temperature,
        maxTokens: s.maxTokens,
        signal: controller.signal,
        onDelta: (delta, full) => win.webContents.send('chat:delta', { delta, full })
      });

      if (!res.toolCalls.length) {
        const msg = { role: 'assistant', content: res.text };
        appended.push(msg);
        return { ok: true, text: res.text, appended };
      }

      // model wants the machine
      const assistantTurn = { role: 'assistant', content: res.text, toolCalls: res.toolCalls };
      convo.push(assistantTurn);
      appended.push(assistantTurn);
      if (res.text) win.webContents.send('chat:delta', { delta: '', full: res.text });

      for (const call of res.toolCalls) {
        const summary = tools.summarise(call.name, call.input);
        const risky = tools.isRisky(call.name);
        win.webContents.send('chat:tool', { phase: 'request', id: call.id, name: call.name, summary, risky });

        if (risky && s.confirmRisky) {
          const approved = await approvalRequest({
            id: call.id, name: call.name, summary, risky,
            detail: call.input.command || call.input.path || '',
            why: call.input.why || '',
            input: call.input
          });
          if (!approved) {
            win.webContents.send('chat:tool', { phase: 'denied', id: call.id, name: call.name, summary });
            const turn = { role: 'tool', toolCallId: call.id, name: call.name, content: 'DENIED by the operator. Do not retry this action; propose a different approach or ask.' };
            convo.push(turn); appended.push(turn);
            continue;
          }
        }

        let result;
        try {
          result = await tools.execute(call.name, call.input, { capturesDir: store.capturesDir });
        } catch (err) {
          result = { ok: false, output: 'ERROR: ' + (err && err.message ? err.message : String(err)) };
        }

        win.webContents.send('chat:tool', {
          phase: 'result', id: call.id, name: call.name, summary,
          ok: result.ok, output: String(result.output || '').slice(0, 1200)
        });

        const turn = {
          role: 'tool',
          toolCallId: call.id,
          name: call.name,
          content: String(result.output || (result.ok ? 'done' : 'failed'))
        };
        convo.push(turn); appended.push(turn);

        // vision-capable providers get the screenshot itself
        if (result.image && (provider === 'anthropic' || provider === 'openai')) {
          const imgTurn = { role: 'user', content: 'Screen capture attached.', images: [result.image] };
          convo.push(imgTurn); appended.push(imgTurn);
        }
      }
      win.webContents.send('chat:round', { round: rounds });
    }
    return { ok: true, text: '', appended };
  } catch (err) {
    if (err && err.name === 'AbortError') return { ok: false, aborted: true, appended };
    return { ok: false, error: err && err.message ? err.message : String(err), appended };
  } finally {
    controller = null;
  }
});

/* ------------------------------------------------------------------ */
/* IPC: settings, history, files, window                               */
/* ------------------------------------------------------------------ */
ipcMain.handle('app:version', () => app.getVersion());
ipcMain.handle('settings:get', () => store.get());
ipcMain.handle('settings:set', (_e, patch) => {
  const before = store.get().hotkey;
  const s = store.set(patch);
  if (s.hotkey !== before) registerHotkey(s.hotkey);
  if (win) win.setAlwaysOnTop(!!s.alwaysOnTop);
  return s;
});
ipcMain.handle('settings:reset', () => {
  const s = store.reset();
  registerHotkey(s.hotkey);
  return s;
});
ipcMain.handle('settings:hotkeyTest', (_e, accel) => registerHotkey(accel));
ipcMain.handle('providers:models', async (_e, provider) => {
  const s = store.get();
  try {
    return { ok: true, models: await providers.listModels(provider, (s.keys || {})[provider]) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('history:get', () => store.history());
ipcMain.handle('history:save', (_e, list) => store.saveHistory(list));

ipcMain.handle('file:pick', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Attach files',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Text & code', extensions: ['txt', 'md', 'json', 'js', 'ts', 'py', 'html', 'css', 'xml', 'yml', 'yaml', 'ini', 'log', 'csv', 'bat', 'ps1', 'reg'] },
      { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] },
      { name: 'All files', extensions: ['*'] }
    ]
  });
  if (r.canceled) return [];
  return r.filePaths.map(readAttachment).filter(Boolean);
});

function readAttachment(p) {
  try {
    const ext = path.extname(p).toLowerCase();
    const stat = fs.statSync(p);
    const IMG = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
    if (IMG[ext]) {
      if (stat.size > 6 * 1024 * 1024) return { name: path.basename(p), error: 'Image over 6 MB — skipped.' };
      return { name: path.basename(p), kind: 'image', media_type: IMG[ext], data: fs.readFileSync(p).toString('base64') };
    }
    if (stat.size > 2 * 1024 * 1024) return { name: path.basename(p), error: 'File over 2 MB — skipped.' };
    let text = fs.readFileSync(p, 'utf8');
    if (text.length > 60000) text = text.slice(0, 60000) + '\n… [truncated]';
    return { name: path.basename(p), kind: 'text', path: p, text };
  } catch (e) {
    return { name: path.basename(p), error: e.message };
  }
}

ipcMain.handle('file:saveText', async (_e, { suggested, content }) => {
  const r = await dialog.showSaveDialog(win, { defaultPath: suggested || 'ultron-log.txt' });
  if (r.canceled) return { ok: false };
  fs.writeFileSync(r.filePath, content, 'utf8');
  return { ok: true, path: r.filePath };
});

ipcMain.on('win:minimise', () => win && win.minimize());
ipcMain.on('win:maximise', () => {
  if (!win) return;
  win.isMaximized() ? win.unmaximize() : win.maximize();
});
ipcMain.on('win:close', () => win && win.close());
ipcMain.on('win:quit', () => app.quit());
ipcMain.on('shell:openData', () => shell.openPath(store.dir));

/* ------------------------------------------------------------------ */
/* lifecycle                                                           */
/* ------------------------------------------------------------------ */
const single = app.requestSingleInstanceLock();
if (!single) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return createWindow();
    if (win.isMinimized()) win.restore();
    win.show(); win.focus();
  });

  app.whenReady().then(() => {
    createWindow();
    const r = registerHotkey(store.get().hotkey);
    if (!r.ok && win) {
      win.webContents.once('did-finish-load', () =>
        win.webContents.send('chat:note', 'Global hotkey not registered: ' + (r.error || 'unavailable') + ' — change it in Settings.'));
    }
  });

  app.on('window-all-closed', () => app.quit());
  app.on('activate', () => { if (!win) createWindow(); });
  app.on('will-quit', () => globalShortcut.unregisterAll());
}
