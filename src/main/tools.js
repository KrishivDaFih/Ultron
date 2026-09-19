'use strict';
/**
 * Computer control — implemented with PowerShell and Electron built-ins only.
 * No native modules, so nothing has to be compiled at install time.
 *
 * Every tool declares `risky`. Risky tools are gated behind an operator
 * confirmation in the renderer when settings.confirmRisky is on.
 */
const { execFile } = require('child_process');
const { shell, clipboard, desktopCapturer, screen } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');

const IS_WIN = process.platform === 'win32';

/* ---------- PowerShell bridge ---------- */
function ps(script, timeout) {
  return new Promise((resolve, reject) => {
    if (!IS_WIN) return reject(new Error('This action requires Windows.'));
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { timeout: timeout || 20000, maxBuffer: 1024 * 1024 * 8, windowsHide: true },
      (err, stdout, stderr) => {
        if (err && !stdout) return reject(new Error((stderr || err.message || '').trim()));
        resolve(((stdout || '') + (stderr ? '\n[stderr] ' + stderr : '')).trim());
      }
    );
  });
}

const PS_MOUSE = `
Add-Type -Name U -Namespace W -MemberDefinition '
[DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
[DllImport("user32.dll")] public static extern void mouse_event(uint f,uint x,uint y,uint d,int e);' -ErrorAction SilentlyContinue
`;

/* ---------- tool catalogue ---------- */
const TOOLS = [
  {
    name: 'system_info',
    risky: false,
    description: 'Read the operator machine: OS, CPU, memory, uptime, disk and GPU. Use before giving hardware-specific advice.',
    parameters: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'list_dir',
    risky: false,
    description: 'List the contents of a folder on the operator machine.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Absolute folder path.' } },
      required: ['path']
    }
  },
  {
    name: 'read_file',
    risky: false,
    description: 'Read a text file from disk. Returns the first 20000 characters.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Absolute file path.' } },
      required: ['path']
    }
  },
  {
    name: 'write_file',
    risky: true,
    description: 'Create or overwrite a text file on disk. Destructive — requires operator approval.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute file path.' },
        content: { type: 'string', description: 'Full file contents to write.' }
      },
      required: ['path', 'content']
    }
  },
  {
    name: 'run_command',
    risky: true,
    description: 'Run a PowerShell command and return its output. Use for installs, services, registry, cleanup and system changes. Requires operator approval.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The PowerShell command line to execute.' },
        why: { type: 'string', description: 'One short line explaining what this does, shown to the operator.' }
      },
      required: ['command']
    }
  },
  {
    name: 'open_target',
    risky: false,
    description: 'Open a URL, file, folder or installed application by name (e.g. "notepad", "https://roblox.com", "C:\\\\Users").',
    parameters: {
      type: 'object',
      properties: { target: { type: 'string', description: 'URL, path, or executable name.' } },
      required: ['target']
    }
  },
  {
    name: 'screen_capture',
    risky: false,
    description: 'Capture the operator screen. On a vision-capable model the image is attached to the next turn; otherwise only the saved path is returned.',
    parameters: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'type_text',
    risky: false,
    description: 'Type text into whatever window currently has focus.',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string', description: 'Literal text to type.' } },
      required: ['text']
    }
  },
  {
    name: 'press_keys',
    risky: false,
    description: 'Send a key combination to the focused window. SendKeys syntax: ^ = Ctrl, % = Alt, + = Shift, {ENTER} {TAB} {ESC} {F5} etc. Example: "^s" saves.',
    parameters: {
      type: 'object',
      properties: { keys: { type: 'string', description: 'SendKeys sequence.' } },
      required: ['keys']
    }
  },
  {
    name: 'mouse',
    risky: false,
    description: 'Move or click the mouse at absolute screen coordinates.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['move', 'click', 'double_click', 'right_click'] },
        x: { type: 'number', description: 'Absolute X in screen pixels.' },
        y: { type: 'number', description: 'Absolute Y in screen pixels.' }
      },
      required: ['action', 'x', 'y']
    }
  },
  {
    name: 'clipboard',
    risky: false,
    description: 'Read or replace the Windows clipboard.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['read', 'write'] },
        text: { type: 'string', description: 'Text to write when action is "write".' }
      },
      required: ['action']
    }
  }
];

const BY_NAME = {};
for (const t of TOOLS) BY_NAME[t.name] = t;

function schema() {
  return TOOLS.map(t => ({ name: t.name, description: t.description, parameters: t.parameters }));
}
function isRisky(name) { return !!(BY_NAME[name] && BY_NAME[name].risky); }

/* ---------- a short human line for the UI timeline ---------- */
function summarise(name, input) {
  input = input || {};
  switch (name) {
    case 'system_info': return 'read machine telemetry';
    case 'list_dir': return 'list ' + (input.path || '?');
    case 'read_file': return 'read ' + (input.path || '?');
    case 'write_file': return 'WRITE ' + (input.path || '?');
    case 'run_command': return 'EXECUTE ' + String(input.command || '').slice(0, 120);
    case 'open_target': return 'open ' + (input.target || '?');
    case 'screen_capture': return 'capture screen';
    case 'type_text': return 'type "' + String(input.text || '').slice(0, 60) + '"';
    case 'press_keys': return 'press ' + (input.keys || '?');
    case 'mouse': return (input.action || 'move') + ' @ ' + input.x + ',' + input.y;
    case 'clipboard': return 'clipboard ' + (input.action || '?');
    default: return name;
  }
}

/* ---------- execution ---------- */
async function execute(name, input, ctx) {
  input = input || {};
  ctx = ctx || {};
  switch (name) {

    case 'system_info': {
      const mem = (os.totalmem() / 1073741824).toFixed(1);
      const free = (os.freemem() / 1073741824).toFixed(1);
      const base =
        'platform: ' + process.platform + ' ' + os.release() + '\n' +
        'cpu: ' + (os.cpus()[0] || {}).model + ' x' + os.cpus().length + '\n' +
        'memory: ' + free + ' GB free of ' + mem + ' GB\n' +
        'uptime: ' + Math.round(os.uptime() / 60) + ' min\n' +
        'user dir: ' + os.homedir();
      if (!IS_WIN) return { ok: true, output: base };
      let extra = '';
      try {
        extra = await ps(
          '$g=(Get-CimInstance Win32_VideoController | Select-Object -Expand Name) -join ", ";' +
          '$d=Get-PSDrive -PSProvider FileSystem | ForEach-Object { "$($_.Name): $([math]::Round($_.Free/1GB,1))GB free of $([math]::Round(($_.Used+$_.Free)/1GB,1))GB" };' +
          '"gpu: $g"; "disks:"; $d'
        );
      } catch (e) { extra = '(gpu/disk query failed: ' + e.message + ')'; }
      return { ok: true, output: base + '\n' + extra };
    }

    case 'list_dir': {
      const p = input.path;
      const items = fs.readdirSync(p, { withFileTypes: true }).slice(0, 300);
      return {
        ok: true,
        output: items.map(f => (f.isDirectory() ? '[DIR]  ' : '       ') + f.name).join('\n') || '(empty)'
      };
    }

    case 'read_file': {
      const txt = fs.readFileSync(input.path, 'utf8');
      return {
        ok: true,
        output: txt.length > 20000 ? txt.slice(0, 20000) + '\n… [truncated at 20000 chars]' : txt
      };
    }

    case 'write_file': {
      fs.mkdirSync(path.dirname(input.path), { recursive: true });
      fs.writeFileSync(input.path, String(input.content == null ? '' : input.content), 'utf8');
      return { ok: true, output: 'wrote ' + Buffer.byteLength(input.content || '') + ' bytes to ' + input.path };
    }

    case 'run_command': {
      const out = await ps(input.command, 120000);
      return { ok: true, output: out || '(no output)' };
    }

    case 'open_target': {
      const t = String(input.target || '').trim();
      if (/^https?:\/\//i.test(t)) { await shell.openExternal(t); return { ok: true, output: 'opened ' + t }; }
      if (fs.existsSync(t)) { await shell.openPath(t); return { ok: true, output: 'opened ' + t }; }
      if (IS_WIN) { await ps('Start-Process ' + JSON.stringify(t)); return { ok: true, output: 'launched ' + t }; }
      return { ok: false, output: 'Target not found: ' + t };
    }

    case 'screen_capture': {
      const display = screen.getPrimaryDisplay().size;
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: Math.min(1600, display.width), height: Math.min(900, display.height) }
      });
      if (!sources.length) return { ok: false, output: 'No screen source available.' };
      const img = sources[0].thumbnail;
      const png = img.toPNG();
      const file = path.join(ctx.capturesDir || os.tmpdir(), 'capture-' + Date.now() + '.png');
      try { fs.writeFileSync(file, png); } catch (e) {}
      return {
        ok: true,
        output: 'screen captured (' + img.getSize().width + 'x' + img.getSize().height + ') → ' + file,
        image: { media_type: 'image/png', data: png.toString('base64') }
      };
    }

    case 'type_text': {
      const esc = String(input.text || '').replace(/([+^%~(){}\[\]])/g, '{$1}');
      await ps(
        'Add-Type -AssemblyName System.Windows.Forms;' +
        '[System.Windows.Forms.SendKeys]::SendWait(' + JSON.stringify(esc) + ')'
      );
      return { ok: true, output: 'typed ' + String(input.text || '').length + ' chars' };
    }

    case 'press_keys': {
      await ps(
        'Add-Type -AssemblyName System.Windows.Forms;' +
        '[System.Windows.Forms.SendKeys]::SendWait(' + JSON.stringify(String(input.keys || '')) + ')'
      );
      return { ok: true, output: 'sent ' + input.keys };
    }

    case 'mouse': {
      const x = Math.round(input.x), y = Math.round(input.y);
      const CLICKS = {
        click: '[W.U]::mouse_event(0x02,0,0,0,0);[W.U]::mouse_event(0x04,0,0,0,0);',
        double_click: '[W.U]::mouse_event(0x02,0,0,0,0);[W.U]::mouse_event(0x04,0,0,0,0);Start-Sleep -m 60;[W.U]::mouse_event(0x02,0,0,0,0);[W.U]::mouse_event(0x04,0,0,0,0);',
        right_click: '[W.U]::mouse_event(0x08,0,0,0,0);[W.U]::mouse_event(0x10,0,0,0,0);'
      };
      await ps(PS_MOUSE + '[W.U]::SetCursorPos(' + x + ',' + y + ');' + (CLICKS[input.action] || ''));
      return { ok: true, output: input.action + ' at ' + x + ',' + y };
    }

    case 'clipboard': {
      if (input.action === 'write') {
        clipboard.writeText(String(input.text || ''));
        return { ok: true, output: 'clipboard replaced' };
      }
      return { ok: true, output: clipboard.readText().slice(0, 8000) || '(clipboard empty)' };
    }

    default:
      return { ok: false, output: 'Unknown tool: ' + name };
  }
}

module.exports = { TOOLS, schema, isRisky, execute, summarise };
