'use strict';
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const DIR = app.getPath('userData');
const SETTINGS = path.join(DIR, 'settings.json');
const HISTORY = path.join(DIR, 'history.json');
const CAPTURES = path.join(DIR, 'captures');

const DEFAULTS = {
  provider: 'groq',
  models: {
    groq: 'llama-3.3-70b-versatile',
    openai: 'gpt-4o-mini',
    anthropic: 'claude-sonnet-4-5-20250929'
  },
  keys: { groq: '', openai: '', anthropic: '' },
  temperature: 0.6,
  maxTokens: 2048,
  directive: 'assist',
  hotkey: 'Control+Shift+U',
  wakeWord: 'ultron',
  wakeWordEnabled: false,
  speakReplies: false,
  voiceRate: 1.05,
  startMinimised: false,
  alwaysOnTop: false,
  computerControl: true,
  confirmRisky: true,
  operatorProfile:
    'Machine: ASUS TUF A15 — Ryzen 7, RTX 3050, 32GB DDR5, 1TB SSD, 144Hz, Windows 11.\n' +
    'Interests: PC customisation, Windows tuning, gaming, AI tooling, design and Figma, wallpapers, minimal desktop setups.\n' +
    'Wants depth, real steps, comparisons before conclusions, honest verdicts instead of marketing.'
};

function readJSON(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const raw = fs.readFileSync(file, 'utf8');
    const val = JSON.parse(raw);
    return val == null ? fallback : val;
  } catch (e) {
    return fallback;
  }
}

function writeJSON(file, value) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
    return true;
  } catch (e) {
    return false;
  }
}

function deepMerge(base, patch) {
  const out = Object.assign({}, base);
  for (const k of Object.keys(patch || {})) {
    const v = patch[k];
    if (v && typeof v === 'object' && !Array.isArray(v)) out[k] = deepMerge(base[k] || {}, v);
    else if (v !== undefined) out[k] = v;
  }
  return out;
}

let settings = deepMerge(DEFAULTS, readJSON(SETTINGS, {}));

const store = {
  dir: DIR,
  capturesDir: CAPTURES,
  settingsPath: SETTINGS,
  historyPath: HISTORY,

  get() { return settings; },

  set(patch) {
    settings = deepMerge(settings, patch);
    writeJSON(SETTINGS, settings);
    return settings;
  },

  reset() {
    settings = JSON.parse(JSON.stringify(DEFAULTS));
    writeJSON(SETTINGS, settings);
    return settings;
  },

  history() { return readJSON(HISTORY, []); },

  saveHistory(list) {
    // keep the 60 most recent conversations
    writeJSON(HISTORY, (list || []).slice(0, 60));
    return true;
  }
};

try { fs.mkdirSync(CAPTURES, { recursive: true }); } catch (e) {}

module.exports = { store, DEFAULTS };
