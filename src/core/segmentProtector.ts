/**
 * Stage 1: deterministic pre-cleaning and segment protection.
 *
 * Code, prompt tags and JSON are swapped for unique placeholders (__SEG_0__, __SEG_1__, ...)
 * so the language model only ever sees prose. After compression the placeholders are
 * replaced with the original text. Placeholders never reach the model: the worker splits
 * the text at every placeholder and compresses each prose piece on its own.
 */

export interface ProtectOptions {
  /** Minify valid JSON blocks (including ```json fences). */
  minifyJson: boolean;
}

export interface ProtectResult {
  /** Text with placeholders in place of protected segments. */
  text: string;
  /** Original (or minified) text of each protected segment, indexed by placeholder number. */
  segments: string[];
  /** Collision-free marker prefix used to identify protected segments. */
  placeholderPrefix: string;
}

export interface Piece {
  kind: 'prose' | 'protected';
  text: string;
}

const PLACEHOLDER_BASE = '__TOKENTRIM_SEGMENT_';
const MIN_JSON_LENGTH = 6;

/** Normalises line endings, strips trailing whitespace and collapses runs of blank lines. */
export function cleanWhitespace(input: string): string {
  return input
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\f\v\u00a0]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function placeholder(index: number, prefix: string): string {
  return `${prefix}${index}__`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\\]\\]/g, '\\function placeholder(index: number): string {
  return `__SEG_${index}__`;
}');
}

function tryMinifyJson(source: string): string | null {
  try {
    return JSON.stringify(JSON.parse(source));
  } catch {
    return null;
  }
}

/** Finds the end (exclusive) of a balanced JSON-looking span starting at `start`, or -1. */
function findBalancedEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) return i + 1;
      if (depth < 0) return -1;
    }
  }
  return -1;
}

/** Replaces every valid JSON object or array in `text` with a placeholder. */
function protectJson(text: string, push: (segment: string) => string, minify: boolean): string {
  let out = '';
  let cursor = 0;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch !== '{' && ch !== '[') {
      i++;
      continue;
    }
    const end = findBalancedEnd(text, i);
    if (end === -1) {
      // Unbalanced opener: nothing after this point can be a complete JSON value we trust.
      if (ch === '{') break;
      i++;
      continue;
    }
    const candidate = text.slice(i, end);
    const compact = candidate.length >= MIN_JSON_LENGTH ? tryMinifyJson(candidate) : null;
    if (compact === null) {
      i++;
      continue;
    }
    out += text.slice(cursor, i) + push(minify ? compact : candidate);
    cursor = end;
    i = end;
  }
  return out + text.slice(cursor);
}

export function protectSegments(input: string, options: ProtectOptions): ProtectResult {
  const segments: string[] = [];
  let placeholderPrefix = PLACEHOLDER_BASE;
  while (input.includes(placeholderPrefix)) placeholderPrefix = `_${placeholderPrefix}`;
  const push = (segment: string): string => {
    segments.push(segment);
    return placeholder(segments.length - 1, placeholderPrefix);
  };

  // 1. Fenced code blocks. ```json fences are minified when requested and valid.
  let text = input.replace(/(```|~~~)([^\n`]*)\n([\s\S]*?)(?:\n?\1|$)/g, (match, fence: string, info: string, body: string) => {
    if (options.minifyJson && /^\s*json\s*$/i.test(info)) {
      const compact = tryMinifyJson(body);
      if (compact !== null) return push(`${fence}${info}\n${compact}\n${fence}`);
    }
    return push(match);
  });

  // 2. Standalone JSON objects and arrays in the remaining prose.
  text = protectJson(text, push, options.minifyJson);

  // 3. Inline code.
  text = text.replace(/`[^`\n]+`/g, (match) => push(match));

  // 4. XML / HTML prompt tags. Only the tags are protected; the text between
  //    <context> and </context> is still compressed.
  text = text.replace(/<\/?[A-Za-z][\w:.-]*(?:\s+[^<>]*?)?\/?>/g, (match) => push(match));

  return { text, segments, placeholderPrefix };
}

/** Splits text at placeholders into alternating prose and protected pieces. */
export function splitPieces(text: string, placeholderPrefix: string): Piece[] {
  const pieces: Piece[] = [];
  const re = new RegExp(`${escapeRegExp(placeholderPrefix)}(\\d+)__`, 'g');
  let last = 0;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    if (m.index > last) pieces.push({ kind: 'prose', text: text.slice(last, m.index) });
    pieces.push({ kind: 'protected', text: m[0] });
    last = m.index + m[0].length;
  }
  if (last < text.length) pieces.push({ kind: 'prose', text: text.slice(last) });
  return pieces;
}

/** Puts the original segments back in place of their placeholders. */
export function restoreSegments(text: string, segments: readonly string[], placeholderPrefix: string): string {
  if (segments.length === 0) return text;
  const re = new RegExp(`${escapeRegExp(placeholderPrefix)}(\\d+)__`, 'g');
  return text.replace(re, (match, index: string) => segments[Number(index)] ?? match);
}
