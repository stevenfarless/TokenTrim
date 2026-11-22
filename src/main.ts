import { registerSW } from 'virtual:pwa-register';

import { MODEL_CACHE_NAME } from './types';
import type {
  CompressionSettings,
  CompressionStats,
  DiffPart,
  EncodingName,
  Settings,
  WorkerRequest,
  WorkerResponse,
} from './types';

import './style.css';

registerSW({ immediate: true });

/* ----------------------------------- DOM helpers ----------------------------------- */

function $<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el as T;
}

const el = {
  pill: $('status-pill'),
  modelBtn: $<HTMLButtonElement>('model-btn'),
  banner: $('install-banner'),
  bannerDismiss: $<HTMLButtonElement>('install-dismiss'),
  modelCard: $('model-card'),
  modelText: $('model-text'),
  initBtn: $<HTMLButtonElement>('init-btn'),
  progress: $('progress'),
  progressBar: $('progress-bar'),
  progressLabel: $('progress-label'),
  storageText: $('storage-text'),
  input: $<HTMLTextAreaElement>('input'),
  inputMeta: $('input-meta'),
  pasteBtn: $<HTMLButtonElement>('paste-btn'),
  sampleBtn: $<HTMLButtonElement>('sample-btn'),
  clearBtn: $<HTMLButtonElement>('clear-btn'),
  reduction: $<HTMLInputElement>('reduction'),
  reductionOut: $('reduction-out'),
  keepHint: $('keep-hint'),
  chips: Array.from(document.querySelectorAll<HTMLButtonElement>('.chip')),
  encoding: $<HTMLSelectElement>('encoding'),
  protect: $<HTMLInputElement>('protect'),
  minify: $<HTMLInputElement>('minify'),
  diff: $<HTMLInputElement>('diff'),
  forceKeep: $<HTMLInputElement>('force-keep'),
  before: $('m-before'),
  after: $('m-after'),
  saved: $('m-saved'),
  badge: $('m-badge'),
  time: $('m-time'),
  trimKept: $('trim-kept'),
  trimCaption: $('trim-caption'),
  output: $<HTMLTextAreaElement>('output'),
  diffView: $('diff-view'),
  outputMeta: $('output-meta'),
  copyBtn: $<HTMLButtonElement>('copy-btn'),
  compressBtn: $<HTMLButtonElement>('compress-btn'),
  runStatus: $('run-status'),
};

const numberFormat = new Intl.NumberFormat('en-US');
const fmt = (n: number): string => numberFormat.format(n);
const formatBytes = (bytes: number): string => {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
};

/* ----------------------------------- Environment ----------------------------------- */

const ua = navigator.userAgent;
const isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isMobile = isIOS || /Android|Mobile/i.test(ua);
const isStandalone =
  (navigator as Navigator & { standalone?: boolean }).standalone === true ||
  window.matchMedia('(display-mode: standalone)').matches;
const isSafari = /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua);

/* -------------------------------------- Settings ----------------------------------- */

const SETTINGS_KEY = 'tokentrim:settings';
const BANNER_KEY = 'tokentrim:install-banner-dismissed';
const DEFAULT_SETTINGS: Settings = {
  reduction: 50,
  encoding: 'o200k_base',
  protect: true,
  minifyJson: true,
  diff: false,
  forceKeep: '\\n, ., ?, !',
};

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<Settings>;
    const reduction = typeof parsed.reduction === 'number' ? parsed.reduction : Number.NaN;
    return {
      reduction: Number.isFinite(reduction)
        ? Math.min(80, Math.max(10, reduction))
        : DEFAULT_SETTINGS.reduction,
      encoding: parsed.encoding === 'cl100k_base' ? 'cl100k_base' : 'o200k_base',
      protect: typeof parsed.protect === 'boolean' ? parsed.protect : DEFAULT_SETTINGS.protect,
      minifyJson: typeof parsed.minifyJson === 'boolean' ? parsed.minifyJson : DEFAULT_SETTINGS.minifyJson,
      diff: typeof parsed.diff === 'boolean' ? parsed.diff : DEFAULT_SETTINGS.diff,
      forceKeep: typeof parsed.forceKeep === 'string' ? parsed.forceKeep : DEFAULT_SETTINGS.forceKeep,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function readSettings(): Settings {
  return {
    reduction: Number(el.reduction.value),
    encoding: el.encoding.value as EncodingName,
    protect: el.protect.checked,
    minifyJson: el.minify.checked,
    diff: el.diff.checked,
    forceKeep: el.forceKeep.value,
  };
}

function saveSettings(): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(readSettings()));
  } catch {
    /* storage can be unavailable in private mode */
  }
}

function applySettings(s: Settings): void {
  el.reduction.value = String(s.reduction);
  el.encoding.value = s.encoding;
  el.protect.checked = s.protect;
  el.minify.checked = s.minifyJson;
  el.diff.checked = s.diff;
  el.forceKeep.value = s.forceKeep;
  syncControls();
}

function parseForceKeep(raw: string): string[] {
  const tokens = raw
    .split(',')
    .map((t) => t.trim().replace(/\\n/g, '\n'))
    .filter((t) => t.length > 0);
  return [...new Set(tokens)];
}

function toCompressionSettings(s: Settings): CompressionSettings {
  return {
    keepRatio: Math.round((1 - s.reduction / 100) * 100) / 100,
    encoding: s.encoding,
    protect: s.protect,
    minifyJson: s.minifyJson && s.protect,
    forceKeep: parseForceKeep(s.forceKeep),
  };
}

function syncControls(): void {
  const reduction = Number(el.reduction.value);
  el.reductionOut.textContent = `${reduction}%`;
  el.keepHint.textContent = `Keeps about ${100 - reduction}% of the words the model rates as important.`;
  for (const chip of el.chips) chip.setAttribute('aria-pressed', String(Number(chip.dataset.reduction) === reduction));
  el.minify.disabled = !el.protect.checked;
}

/* ----------------------------------- Worker client ----------------------------------- */

type ModelState = 'idle' | 'cached' | 'downloading' | 'loading' | 'ready' | 'error';

let worker: Worker;
let modelState: ModelState = 'idle';
let modelCached = false;
let busy = false;
let pendingCompress = false;
let sequence = 0;
let latestCountId = 0;
let latestCompressId = 0;
let hasResult = false;
let lastDiff: DiffPart[] = [];
let countTimer = 0;
let copyTimer = 0;

function send(request: WorkerRequest): void {
  worker.postMessage(request);
}

function createWorker(): Worker {
  const w = new Worker(new URL('./worker/compressor.worker.ts', import.meta.url), { type: 'module' });
  w.onmessage = (event: MessageEvent<WorkerResponse>) => handleMessage(event.data);
  w.onerror = (event) => handleCrash(event.message);
  w.onmessageerror = () => handleCrash('The worker sent a message the page could not read.');
  return w;
}

function handleCrash(detail: string): void {
  worker.terminate();
  worker = createWorker();
  busy = false;
  pendingCompress = false;
  setModelState('error');
  el.progressLabel.hidden = false;
  el.progressLabel.textContent = `The background worker stopped (${detail || 'it may have run out of memory'}). Close other tabs and tap Retry.`;
  setRunStatus('');
  refreshCompressButton();
  recount();
}

function handleMessage(msg: WorkerResponse): void {
  switch (msg.type) {
    case 'phase': {
      setModelState(msg.phase === 'download' ? 'downloading' : 'loading');
      el.progressLabel.hidden = false;
      el.progressLabel.textContent =
        msg.phase === 'download'
          ? 'Downloading the model…'
          : msg.phase === 'load'
            ? 'Loading the model from this device…'
            : 'Warming up the model…';
      break;
    }
    case 'progress': {
      const { percent, loadedBytes, totalBytes } = msg.progress;
      el.progress.hidden = false;
      el.progress.setAttribute('aria-valuenow', String(Math.round(percent)));
      el.progressBar.style.width = `${percent.toFixed(1)}%`;
      el.progressLabel.hidden = false;
      el.progressLabel.textContent = `${formatBytes(loadedBytes)} of ${formatBytes(totalBytes)} (${Math.round(percent)}%)`;
      el.pill.textContent = `Downloading ${Math.round(percent)}%`;
      break;
    }
    case 'ready': {
      modelCached = true;
      setModelState('ready');
      void refreshStorage();
      void navigator.storage?.persist?.();
      el.progressLabel.hidden = true;
      if (pendingCompress) {
        pendingCompress = false;
        runCompression();
      } else {
        setRunStatus(`Model ready on ${msg.device === 'webgpu' ? 'WebGPU' : 'WebAssembly'}.`);
      }
      break;
    }
    case 'counted': {
      if (msg.id === latestCountId) el.before.textContent = fmt(msg.tokens);
      break;
    }
    case 'chunk-progress': {
      if (msg.id === latestCompressId && msg.total > 1) setRunStatus(`Compressing part ${msg.done} of ${msg.total}…`);
      break;
    }
    case 'compressed': {
      if (msg.id !== latestCompressId) break;
      busy = false;
      showResult(msg.output, msg.diff, msg.stats);
      setRunStatus('Done.');
      refreshCompressButton();
      break;
    }
    case 'error': {
      if (msg.scope === 'init') {
        pendingCompress = false;
        setModelState('error');
        el.progressLabel.hidden = false;
        el.progressLabel.textContent = `Could not load the model: ${msg.message}`;
      } else if (msg.scope === 'compress') {
        if (msg.id !== latestCompressId) break;
        busy = false;
        setRunStatus(`Compression failed: ${msg.message}`);
        refreshCompressButton();
      }
      break;
    }
  }
}

/* ------------------------------------ Model state ------------------------------------ */

function setModelState(next: ModelState): void {
  modelState = next;
  const labels: Record<ModelState, [string, 'idle' | 'busy' | 'ready' | 'error']> = {
    idle: ['Model not loaded', 'idle'],
    cached: ['Offline ready', 'ready'],
    downloading: ['Downloading', 'busy'],
    loading: ['Loading model', 'busy'],
    ready: ['Offline ready', 'ready'],
    error: ['Model error', 'error'],
  };
  const [text, tone] = labels[next];
  el.pill.textContent = text;
  el.pill.dataset.state = tone;

  const working = next === 'downloading' || next === 'loading';
  const installed = next === 'cached' || next === 'ready';
  el.modelCard.classList.toggle('compact', installed);
  el.modelText.hidden = installed;
  el.initBtn.hidden = installed || working;
  el.initBtn.textContent = next === 'error' ? 'Retry download' : 'Initialize / Download Offline Model (~180 MB)';
  if (!working) el.progress.hidden = true;
  if (next === 'idle' || installed) el.progressLabel.hidden = true;
  if (next === 'downloading') {
    el.progress.hidden = false;
  }
  el.modelBtn.textContent = installed ? 'Clear model' : 'Download model';
  el.modelBtn.disabled = working;
  refreshCompressButton();
}

function initModel(): void {
  if (modelState === 'downloading' || modelState === 'loading' || modelState === 'ready') return;
  setModelState(modelCached ? 'loading' : 'downloading');
  el.progressBar.style.width = '0%';
  el.progressLabel.hidden = false;
  el.progressLabel.textContent = modelCached ? 'Loading the model from this device…' : 'Starting download…';
  send({ type: 'init', cachedOnly: modelCached, forceWasm: isMobile });
}

async function detectCachedModel(): Promise<boolean> {
  try {
    if (!('caches' in window) || !(await caches.has(MODEL_CACHE_NAME))) return false;
    const cache = await caches.open(MODEL_CACHE_NAME);
    return (await cache.keys()).some((request) => request.url.includes('model_quantized.onnx'));
  } catch {
    return false;
  }
}

async function clearModel(): Promise<void> {
  if (!window.confirm('Remove the downloaded model (about 180 MB)? You will need to download it again to compress offline.')) return;
  worker.terminate(); // frees the model memory immediately
  try {
    await caches.delete(MODEL_CACHE_NAME);
  } catch {
    /* ignore */
  }
  worker = createWorker();
  modelCached = false;
  busy = false;
  pendingCompress = false;
  setModelState('idle');
  setRunStatus('Model removed.');
  void refreshStorage();
  recount();
}

async function refreshStorage(): Promise<void> {
  try {
    const estimate = await navigator.storage?.estimate?.();
    if (!estimate || estimate.usage === undefined) {
      el.storageText.textContent = 'Storage usage is not available in this browser.';
      return;
    }
    const persisted = (await navigator.storage.persisted?.()) ? ' Storage is marked persistent.' : '';
    const quota = estimate.quota ? ` of ${formatBytes(estimate.quota)} available` : '';
    el.storageText.textContent = `Stored on this device: ${formatBytes(estimate.usage)}${quota}.${persisted}`;
  } catch {
    el.storageText.textContent = '';
  }
}

/* -------------------------------------- Counting ------------------------------------- */

function recount(): void {
  window.clearTimeout(countTimer);
  const text = el.input.value;
  el.inputMeta.textContent = `${fmt(text.length)} character${text.length === 1 ? '' : 's'}`;
  if (text.length === 0) {
    latestCountId = ++sequence;
    el.before.textContent = '0';
    return;
  }
  countTimer = window.setTimeout(() => {
    latestCountId = ++sequence;
    send({ type: 'count', id: latestCountId, text, encoding: el.encoding.value as EncodingName });
  }, 200);
}

/* ------------------------------------ Compression ------------------------------------ */

function setRunStatus(text: string): void {
  el.runStatus.textContent = text;
}

function refreshCompressButton(): void {
  el.compressBtn.disabled = busy;
  el.compressBtn.textContent = busy ? 'Compressing…' : 'Compress prompt';
}

function startCompression(): void {
  if (busy) return;
  if (!el.input.value.trim()) {
    setRunStatus('Paste a prompt first.');
    el.input.focus();
    return;
  }
  switch (modelState) {
    case 'idle':
    case 'error':
      setRunStatus('Download the offline model first. It is a one-time download of about 180 MB.');
      el.modelCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    case 'downloading':
    case 'loading':
      pendingCompress = true;
      setRunStatus('The model is still loading. Compression starts as soon as it is ready.');
      return;
    case 'cached':
      pendingCompress = true;
      setRunStatus('Loading the model into memory…');
      initModel();
      return;
    case 'ready':
      runCompression();
  }
}

function runCompression(): void {
  busy = true;
  hasResult = false;
  latestCompressId = ++sequence;
  setRunStatus('Compressing…');
  refreshCompressButton();
  send({ type: 'compress', id: latestCompressId, text: el.input.value, settings: toCompressionSettings(readSettings()) });
}

function showResult(output: string, diff: DiffPart[], stats: CompressionStats): void {
  hasResult = true;
  lastDiff = diff;
  el.output.value = output;
  el.copyBtn.disabled = output.length === 0;
  el.before.textContent = fmt(stats.beforeTokens);
  el.after.textContent = fmt(stats.afterTokens);
  const sign = stats.savedTokens > 0 ? '-' : stats.savedTokens < 0 ? '+' : '';
  el.saved.textContent = `${sign}${fmt(Math.abs(stats.savedTokens))}`;
  el.badge.hidden = false;
  el.badge.textContent = `${sign}${Math.abs(stats.savedPercent).toFixed(1)}%`;
  el.badge.dataset.tone = stats.savedTokens > 0 ? 'good' : 'flat';
  el.time.textContent = `${fmt(stats.timeMs)} ms`;
  const kept = stats.beforeTokens > 0 ? Math.min(100, (stats.afterTokens / stats.beforeTokens) * 100) : 100;
  el.trimKept.style.width = `${kept.toFixed(1)}%`;
  const segments = stats.protectedSegments;
  el.trimCaption.textContent =
    `Kept ${kept.toFixed(1)}% of the original tokens. ` +
    `${segments === 0 ? 'No segments were protected.' : `${segments} segment${segments === 1 ? ' was' : 's were'} protected.`} ` +
    `Ran on ${stats.device === 'webgpu' ? 'WebGPU' : 'WebAssembly'}.`;
  el.outputMeta.textContent = `${fmt(stats.afterChars)} of ${fmt(stats.beforeChars)} characters`;
  renderOutputMode();
}

function clearResult(): void {
  if (!hasResult && !el.output.value) return;
  hasResult = false;
  lastDiff = [];
  el.output.value = '';
  el.copyBtn.disabled = true;
  el.after.textContent = '-';
  el.saved.textContent = '-';
  el.badge.hidden = true;
  el.time.textContent = '-';
  el.trimKept.style.width = '0%';
  el.trimCaption.textContent = 'Run a compression to see how much was trimmed.';
  el.outputMeta.textContent = '';
  renderOutputMode();
}

function renderOutputMode(): void {
  const showDiff = el.diff.checked && hasResult;
  el.diffView.hidden = !showDiff;
  el.output.hidden = showDiff;
  if (!showDiff) return;
  const fragment = document.createDocumentFragment();
  for (const part of lastDiff) {
    const node = document.createElement(part.kind === 'remove' ? 'del' : 'span');
    node.className = part.kind === 'remove' ? 'd-cut' : 'd-keep';
    node.textContent = part.text;
    fragment.append(node);
  }
  el.diffView.replaceChildren(fragment);
}

/* -------------------------------------- Clipboard ------------------------------------ */

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const scratch = document.createElement('textarea');
    scratch.value = text;
    scratch.setAttribute('readonly', '');
    scratch.style.cssText = 'position:fixed;top:0;left:0;opacity:0;font-size:16px';
    document.body.append(scratch);
    scratch.focus();
    scratch.select();
    scratch.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    scratch.remove();
    return ok;
  }
}

async function copyOutput(): Promise<void> {
  if (!el.output.value) return;
  const ok = await copyText(el.output.value);
  window.clearTimeout(copyTimer);
  el.copyBtn.textContent = ok ? 'Copied!' : 'Copy failed. Select the text instead.';
  el.copyBtn.classList.toggle('is-done', ok);
  copyTimer = window.setTimeout(() => {
    el.copyBtn.textContent = 'Copy compressed prompt';
    el.copyBtn.classList.remove('is-done');
  }, 1800);
}

async function pasteInput(): Promise<void> {
  try {
    const text = await navigator.clipboard.readText();
    setInput(text);
  } catch {
    setRunStatus('Your browser blocked the paste button. Press and hold in the prompt box, then choose Paste.');
    el.input.focus();
  }
}

/* ---------------------------------------- Input -------------------------------------- */

function setInput(text: string): void {
  el.input.value = text;
  clearResult();
  recount();
  setRunStatus('');
}

function sampleText(): string {
  const fence = '`'.repeat(3);
  return [
    'You are a senior customer support analyst for a software company. Please read the customer conversation below very carefully, and then write a reply that is friendly, professional, and as concise as possible.',
    '',
    '<context>',
    'The customer, Dana, has been using our Team plan for about eight months now. Yesterday she wrote in to say that, quite frankly, the export feature has been really slow for her, and that she is honestly thinking about maybe switching to one of our competitors if the problem cannot be fixed in the near future. She also mentioned that several of her colleagues have noticed the very same problem and that it is starting to affect their daily work in a pretty significant way.',
    '</context>',
    '',
    'Here is the account information in JSON format, which you should use when you are deciding which options we can offer her:',
    '',
    '{',
    '  "plan": "team",',
    '  "seats": 12,',
    '  "region": "eu-west",',
    '  "export_jobs_last_30_days": 148,',
    '  "median_export_seconds": 94',
    '}',
    '',
    'For reference, the function that starts an export looks like this:',
    '',
    fence + 'ts',
    'async function startExport(accountId: string) {',
    '  return api.post(`/accounts/${accountId}/exports`);',
    '}',
    fence,
    '',
    '<instructions>',
    'Please make sure that you apologise sincerely for the inconvenience, explain in simple and non-technical terms what we are currently doing to investigate the slowness, and offer at least two concrete next steps. It is really important that you do not promise any specific dates or any compensation, and that you only mention the `median_export_seconds` value if it is actually helpful to the customer.',
    '</instructions>',
  ].join('\n');
}

/* ---------------------------------------- Wiring ------------------------------------- */

function wire(): void {
  el.input.addEventListener('input', () => {
    clearResult();
    recount();
  });
  el.pasteBtn.addEventListener('click', () => void pasteInput());
  el.sampleBtn.addEventListener('click', () => setInput(sampleText()));
  el.clearBtn.addEventListener('click', () => {
    setInput('');
    el.input.focus();
  });

  el.reduction.addEventListener('input', () => {
    syncControls();
    saveSettings();
  });
  for (const chip of el.chips) {
    chip.addEventListener('click', () => {
      el.reduction.value = chip.dataset.reduction ?? '50';
      syncControls();
      saveSettings();
    });
  }
  el.encoding.addEventListener('change', () => {
    saveSettings();
    clearResult();
    recount();
  });
  el.protect.addEventListener('change', () => {
    syncControls();
    saveSettings();
  });
  el.minify.addEventListener('change', saveSettings);
  el.forceKeep.addEventListener('change', saveSettings);
  el.diff.addEventListener('change', () => {
    saveSettings();
    renderOutputMode();
  });

  el.compressBtn.addEventListener('click', startCompression);
  el.copyBtn.addEventListener('click', () => void copyOutput());
  el.initBtn.addEventListener('click', initModel);
  el.modelBtn.addEventListener('click', () => {
    if (modelState === 'cached' || modelState === 'ready') void clearModel();
    else initModel();
  });

  if (isIOS && isSafari && !isStandalone) {
    let dismissed = false;
    try {
      dismissed = localStorage.getItem(BANNER_KEY) === '1';
    } catch {
      /* ignore */
    }
    el.banner.hidden = dismissed;
  }
  el.bannerDismiss.addEventListener('click', () => {
    el.banner.hidden = true;
    try {
      localStorage.setItem(BANNER_KEY, '1');
    } catch {
      /* ignore */
    }
  });
}

async function boot(): Promise<void> {
  worker = createWorker();
  applySettings(loadSettings());
  wire();
  recount();
  modelCached = await detectCachedModel();
  setModelState(modelCached ? 'cached' : 'idle');
  await refreshStorage();
}

void boot();
