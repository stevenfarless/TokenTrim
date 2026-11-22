/**
 * Dedicated worker: model download and loading, LLMLingua-2 inference and tiktoken counting.
 * Nothing in here touches the DOM, so the UI stays responsive on 20,000+ character prompts.
 */
import { AutoConfig, env } from '@huggingface/transformers';
import { LLMLingua2 } from '@atjsh/llmlingua-2';
import { Tiktoken } from 'js-tiktoken/lite';

import { cleanWhitespace, protectSegments, restoreSegments, splitPieces } from '../core/segmentProtector';
import { MODEL_CACHE_NAME } from '../types';
import type {
  CompressionSettings,
  CompressionStats,
  ComputeDevice,
  DiffPart,
  EncodingName,
  WorkerRequest,
  WorkerResponse,
} from '../types';

// Single-thread ONNX Runtime binaries, bundled so the app never needs a CDN.
// Relative paths are used on purpose: onnxruntime-web does not export these files.
import wasmPlainUrl from '../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm?url';
import wasmPlainGlueUrl from '../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs?url';
import wasmGpuUrl from '../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.wasm?url';
import wasmGpuGlueUrl from '../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.mjs?url';

/**
 * ONNX export of microsoft/llmlingua-2-bert-base-multilingual-cased-meetingbank with an int8
 * file at onnx/model_quantized.onnx (about 180 MB). Swap this constant to use another export.
 */
const MODEL_ID = 'ldenoue/llmlingua-2-bert-base-multilingual-cased-meetingbank';
const MIN_WORDS_TO_COMPRESS = 4;
const MAX_FORCE_TOKENS = 50;

interface WorkerScope {
  postMessage(message: WorkerResponse): void;
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  navigator: Navigator;
  location: Location;
}
const ctx = self as unknown as WorkerScope;
const post = (message: WorkerResponse): void => ctx.postMessage(message);

/* ------------------------------ Transformers.js env ------------------------------ */

env.allowLocalModels = false; // no probing /models/ on the static host
env.allowRemoteModels = true;
env.useBrowserCache = true; // model files persist in Cache Storage ...
env.cacheKey = MODEL_CACHE_NAME; // ... under "transformers-cache"

// Single-threaded WASM: no SharedArrayBuffer, so no COOP/COEP headers are needed (GitHub Pages).
const onnxWasm = env.backends.onnx.wasm;
if (onnxWasm) {
  onnxWasm.numThreads = 1;
  onnxWasm.proxy = false;
}

let wasmPathsConfigured = false;
/** Must run once, before the first ONNX session is created. */
function configureWasmPaths(device: ComputeDevice): void {
  if (wasmPathsConfigured || !onnxWasm) return;
  const abs = (url: string): string => new URL(url, ctx.location.href).href;
  onnxWasm.wasmPaths =
    device === 'webgpu'
      ? { mjs: abs(wasmGpuGlueUrl), wasm: abs(wasmGpuUrl) }
      : { mjs: abs(wasmPlainGlueUrl), wasm: abs(wasmPlainUrl) };
  wasmPathsConfigured = true;
}

/* ---------------------------------- Tokenizers ---------------------------------- */

const encoders = new Map<EncodingName, Tiktoken>();

async function getEncoder(name: EncodingName): Promise<Tiktoken> {
  const cached = encoders.get(name);
  if (cached) return cached;
  const ranks =
    name === 'o200k_base'
      ? (await import('js-tiktoken/ranks/o200k_base')).default
      : (await import('js-tiktoken/ranks/cl100k_base')).default;
  const encoder = new Tiktoken(ranks);
  // Treat special-token look-alikes such as "<|endoftext|>" as plain text instead of throwing.
  const rawEncode = encoder.encode.bind(encoder);
  encoder.encode = (text: string, allowed: string[] | 'all' = [], disallowed: string[] | 'all' = []) =>
    rawEncode(text, allowed, disallowed);
  encoders.set(name, encoder);
  return encoder;
}

function countTokens(encoder: Tiktoken, text: string): number {
  return text.length === 0 ? 0 : encoder.encode(text).length;
}

/* ------------------------------ Model download & load ------------------------------ */

type Compressor = Awaited<ReturnType<typeof LLMLingua2.WithBERTMultilingual>>;
let loaded: Compressor | null = null;
let loadedDevice: ComputeDevice = 'wasm';
let initPromise: Promise<void> | null = null;

function createProgressReporter(): (info: { status: string; file?: string; loaded?: number; total?: number }) => void {
  const files = new Map<string, { loaded: number; total: number }>();
  let lastPost = 0;
  return (info) => {
    if (info.status !== 'progress' || !info.file || !info.total) return;
    files.set(info.file, { loaded: info.loaded ?? 0, total: info.total });
    const now = performance.now();
    if (now - lastPost < 120 && (info.loaded ?? 0) < info.total) return;
    lastPost = now;
    let loadedBytes = 0;
    let totalBytes = 0;
    for (const f of files.values()) {
      loadedBytes += f.loaded;
      totalBytes += f.total;
    }
    post({
      type: 'progress',
      progress: {
        loadedBytes,
        totalBytes,
        percent: totalBytes > 0 ? Math.min(100, (loadedBytes / totalBytes) * 100) : 0,
        file: info.file,
      },
    });
  };
}

async function loadModel(device: ComputeDevice, cachedOnly: boolean): Promise<Compressor> {
  configureWasmPaths(device);
  post({ type: 'phase', phase: cachedOnly ? 'load' : 'download', device });
  const onProgress = createProgressReporter();
  const encoder = await getEncoder('o200k_base');
  const config = await AutoConfig.from_pretrained(MODEL_ID, { progress_callback: onProgress, local_files_only: cachedOnly });
  return LLMLingua2.WithBERTMultilingual(MODEL_ID, {
    transformerJSConfig: { device, dtype: 'q8' },
    oaiTokenizer: encoder,
    pretrainedConfig: config,
    pretrainedTokenizerOptions: { progress_callback: onProgress, local_files_only: cachedOnly },
    modelSpecificOptions: { device, dtype: 'q8', progress_callback: onProgress, local_files_only: cachedOnly },
  });
}

const WARMUP_TEXT =
  'This is a short warm up pass. It makes sure the model, the tokenizer and the runtime are all initialised before the first real prompt.';

async function warmUp(compressor: Compressor): Promise<number> {
  const start = performance.now();
  await compressor.promptCompressor.compress(WARMUP_TEXT, { rate: 0.5 });
  return Math.round(performance.now() - start);
}

async function initialise(request: Extract<WorkerRequest, { type: 'init' }>): Promise<void> {
  if (loaded) {
    post({ type: 'ready', device: loadedDevice, warmupMs: 0 });
    return;
  }
  const canUseGpu = !request.forceWasm && 'gpu' in ctx.navigator;
  const devices: ComputeDevice[] = canUseGpu ? ['webgpu', 'wasm'] : ['wasm'];
  const sources = request.cachedOnly ? [true, false] : [false];
  let lastError: unknown = null;

  for (const device of devices) {
    for (const cachedOnly of sources) {
      if (!cachedOnly && !ctx.navigator.onLine) continue; // offline: a network attempt cannot succeed
      let candidate: Compressor | null = null;
      try {
        candidate = await loadModel(device, cachedOnly);
        post({ type: 'phase', phase: 'warmup', device });
        const warmupMs = await warmUp(candidate);
        loaded = candidate;
        loadedDevice = device;
        post({ type: 'ready', device, warmupMs });
        return;
      } catch (error) {
        lastError = error;
        try {
          await candidate?.model.dispose();
        } catch {
          /* ignore */
        }
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError ?? 'Model failed to load'));
}

/* ----------------------------------- Compression ----------------------------------- */

function wordCount(text: string): number {
  return text.match(/\S+/g)?.length ?? 0;
}

/**
 * Word-level diff. LLMLingua-2 only deletes words and never reorders them, so a greedy
 * in-order match is enough. Whitespace follows the word before it.
 */
function buildDiff(original: string, compressed: string): DiffPart[] {
  const tokens = original.match(/\s+|\S+/g) ?? [];
  const kept = compressed.match(/\S+/g) ?? [];
  const parts: DiffPart[] = [];
  const add = (kind: DiffPart['kind'], text: string): void => {
    const last = parts[parts.length - 1];
    if (last && last.kind === kind) last.text += text;
    else parts.push({ kind, text });
  };
  let j = 0;
  let misses = 0;
  let lastKind: DiffPart['kind'] = 'keep';
  for (const token of tokens) {
    if (/^\s/.test(token)) {
      add(lastKind, token);
      continue;
    }
    if (j < kept.length && kept[j] === token) {
      lastKind = 'keep';
      j++;
      misses = 0;
    } else {
      lastKind = 'remove';
      // If the model altered a word we would otherwise wait for it forever: resync.
      if (++misses > 40) {
        j++;
        misses = 0;
      }
    }
    add(lastKind, token);
  }
  return parts;
}

async function compress(id: number, text: string, settings: CompressionSettings): Promise<void> {
  if (!loaded) throw new Error('The model is not loaded yet.');
  const startedAt = performance.now();
  const encoder = await getEncoder(settings.encoding);
  const beforeTokens = countTokens(encoder, text);

  // Stage 1: clean and protect.
  const cleaned = cleanWhitespace(text);
  const { text: shielded, segments } = settings.protect
    ? protectSegments(cleaned, { minifyJson: settings.minifyJson })
    : { text: cleaned, segments: [] as string[] };
  const pieces = splitPieces(shielded);
  const jobs = pieces.filter((p) => p.kind === 'prose' && wordCount(p.text) >= MIN_WORDS_TO_COMPRESS).length;

  // Stage 2: semantic pruning of every prose piece.
  const forceTokens = settings.forceKeep.slice(0, MAX_FORCE_TOKENS);
  let done = 0;
  let output = '';
  for (const piece of pieces) {
    if (piece.kind === 'protected' || wordCount(piece.text) < MIN_WORDS_TO_COMPRESS) {
      output += piece.text;
      continue;
    }
    const lead = /^\s*/.exec(piece.text)?.[0] ?? '';
    const trail = /\s*$/.exec(piece.text)?.[0] ?? '';
    const pruned = await loaded.promptCompressor.compress(piece.text.trim(), {
      rate: settings.keepRatio,
      tokenToWord: 'mean',
      forceTokens,
      chunkEndTokens: ['.', '\n'],
    });
    output += lead + pruned.trim() + trail;
    post({ type: 'chunk-progress', id, done: ++done, total: jobs });
  }

  const finalText = restoreSegments(output, segments).trim();
  const afterTokens = countTokens(encoder, finalText);
  const savedTokens = beforeTokens - afterTokens;
  const stats: CompressionStats = {
    beforeTokens,
    afterTokens,
    savedTokens,
    savedPercent: beforeTokens > 0 ? (savedTokens / beforeTokens) * 100 : 0,
    timeMs: Math.round(performance.now() - startedAt),
    beforeChars: text.length,
    afterChars: finalText.length,
    protectedSegments: segments.length,
    device: loadedDevice,
  };
  post({
    type: 'compressed',
    id,
    output: finalText,
    diff: buildDiff(restoreSegments(shielded, segments), finalText),
    stats,
  });
}

/* ------------------------------------ Messaging ------------------------------------ */

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

ctx.onmessage = (event) => {
  const request = event.data;
  switch (request.type) {
    case 'init':
      if (loaded) {
        post({ type: 'ready', device: loadedDevice, warmupMs: 0 });
        break;
      }
      initPromise ??= initialise(request).catch((error: unknown) => {
        initPromise = null; // allow a retry
        post({ type: 'error', scope: 'init', message: messageOf(error) });
      });
      break;
    case 'count':
      getEncoder(request.encoding)
        .then((encoder) => post({ type: 'counted', id: request.id, tokens: countTokens(encoder, request.text) }))
        .catch((error: unknown) => post({ type: 'error', scope: 'count', id: request.id, message: messageOf(error) }));
      break;
    case 'compress':
      compress(request.id, request.text, request.settings).catch((error: unknown) =>
        post({ type: 'error', scope: 'compress', id: request.id, message: messageOf(error) }),
      );
      break;
  }
};
