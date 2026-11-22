/** Shared types for the UI thread and the compressor worker. */

export type EncodingName = 'o200k_base' | 'cl100k_base';
export type ComputeDevice = 'wasm' | 'webgpu';
export type ModelPhase = 'download' | 'load' | 'warmup';

/** Name of the Cache Storage bucket Transformers.js writes model files to. */
export const MODEL_CACHE_NAME = 'transformers-cache';

/** Persisted UI settings. */
export interface Settings {
  /** Target token reduction in percent (10 to 80). The keep ratio is 1 - reduction / 100. */
  reduction: number;
  encoding: EncodingName;
  protect: boolean;
  minifyJson: boolean;
  diff: boolean;
  /** Raw text of the "always keep" field, e.g. "\n, ., ?, !". */
  forceKeep: string;
}

/** The subset of settings the worker needs to compress a prompt. */
export interface CompressionSettings {
  /** Fraction of tokens to keep, from 0.20 to 0.90. */
  keepRatio: number;
  encoding: EncodingName;
  protect: boolean;
  minifyJson: boolean;
  /** Parsed force-keep tokens (newlines already expanded). */
  forceKeep: string[];
}

export interface CompressionStats {
  beforeTokens: number;
  afterTokens: number;
  savedTokens: number;
  /** Reduction as a percentage of the original, e.g. 54.2. Negative if the output grew. */
  savedPercent: number;
  timeMs: number;
  beforeChars: number;
  afterChars: number;
  protectedSegments: number;
  device: ComputeDevice;
}

export interface DiffPart {
  kind: 'keep' | 'remove';
  text: string;
}

export interface DownloadProgress {
  loadedBytes: number;
  totalBytes: number;
  /** 0 to 100 */
  percent: number;
  file: string;
}

export type WorkerRequest =
  | { type: 'init'; cachedOnly: boolean; forceWasm: boolean }
  | { type: 'count'; id: number; text: string; encoding: EncodingName }
  | { type: 'compress'; id: number; text: string; settings: CompressionSettings };

export type WorkerResponse =
  | { type: 'phase'; phase: ModelPhase; device: ComputeDevice }
  | { type: 'progress'; progress: DownloadProgress }
  | { type: 'ready'; device: ComputeDevice; warmupMs: number }
  | { type: 'counted'; id: number; tokens: number }
  | { type: 'chunk-progress'; id: number; done: number; total: number }
  | { type: 'compressed'; id: number; output: string; diff: DiffPart[]; stats: CompressionStats }
  | { type: 'error'; scope: 'init' | 'count' | 'compress'; id?: number; message: string };
