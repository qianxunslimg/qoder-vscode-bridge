import { fileURLToPath } from 'node:url';

export const DEFAULT_MAX_INLINE_REFERENCE_CHARS = 24_000;

interface JsonObject {
  readonly [key: string]: unknown;
}

export interface ReferenceRenderOptions {
  readonly maxInlineChars?: number;
  readonly activeEditorReference?: ActiveEditorReference;
}

export interface ActiveEditorReference {
  readonly resource: string;
  readonly range?: string;
  readonly text?: string;
}

export interface UnknownImagePart {
  readonly mimeType: string;
  readonly data: Uint8Array | string;
}

function objectValue(value: unknown): JsonObject | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function normalizedMimeType(mimeType: string): string {
  return mimeType.split(';', 1)[0].trim().toLowerCase();
}

function maxInlineChars(options: ReferenceRenderOptions): number {
  return Math.max(
    0,
    Math.min(
      100_000,
      Math.floor(options.maxInlineChars ?? DEFAULT_MAX_INLINE_REFERENCE_CHARS),
    ),
  );
}

function truncateText(text: string, limit: number): string {
  const normalized = text.replace(/\r\n?/g, '\n');
  if (normalized.length <= limit) {
    return normalized;
  }
  if (limit === 0) {
    return '[内容较大，已省略；请使用附加文件路径调用 read_file 读取。]';
  }
  return `${normalized.slice(0, limit)}\n… [已省略 ${normalized.length - limit} 个字符；如需完整内容，请读取附加文件]`;
}

function decodeUtf8(data: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: false }).decode(data);
  } catch {
    return Buffer.from(data).toString('utf8');
  }
}

function isTextMime(mimeType: string): boolean {
  return (
    mimeType.startsWith('text/') ||
    mimeType === 'application/json' ||
    mimeType.endsWith('+json') ||
    mimeType === 'application/xml' ||
    mimeType.endsWith('+xml') ||
    mimeType === 'application/javascript' ||
    mimeType === 'application/x-javascript' ||
    mimeType === 'application/x-yaml' ||
    mimeType === 'application/yaml' ||
    mimeType === 'application/toml' ||
    mimeType === 'application/graphql' ||
    mimeType === 'application/vnd.code.notebook.stdout' ||
    mimeType === 'application/vnd.code.notebook.stderr' ||
    mimeType === 'application/vnd.code.notebook.error'
  );
}

function isResourceString(value: string): boolean {
  const normalized = value.trim();
  if (!normalized) {
    return false;
  }
  return (
    normalized.startsWith('/') ||
    normalized.startsWith('~/') ||
    normalized.startsWith('file://') ||
    normalized.startsWith('vscode-remote://') ||
    normalized.startsWith('untitled:') ||
    normalized.startsWith('http://') ||
    normalized.startsWith('https://') ||
    /^[A-Za-z]:[\\/]/.test(normalized) ||
    /(?:^|[\\/])[^\\/]+\.[A-Za-z0-9]{1,12}$/.test(normalized)
  );
}

function uriToDisplay(value: string): string {
  const normalized = value.trim();
  if (!normalized.startsWith('file://')) {
    return normalized;
  }
  try {
    const filePath = fileURLToPath(normalized);
    return `${filePath} (URI: ${normalized})`;
  } catch {
    return normalized;
  }
}

function splitUriFragment(value: string): {
  readonly resource: string;
  readonly range?: string;
} {
  const match = value.match(
    /^(.*)#L(\d+)(?:,(\d+))?(?:-L?(\d+)(?:,(\d+))?)?$/i,
  );
  if (!match) {
    return { resource: value };
  }

  const startLine = Number(match[2]);
  const startColumn = match[3] === undefined ? undefined : Number(match[3]);
  const endLine = match[4] === undefined ? startLine : Number(match[4]);
  const endColumn = match[5] === undefined ? undefined : Number(match[5]);
  if (!Number.isFinite(startLine) || !Number.isFinite(endLine)) {
    return { resource: value };
  }
  const columns =
    startColumn !== undefined && endColumn !== undefined
      ? `, columns ${startColumn}-${endColumn}`
      : startColumn !== undefined
        ? `, column ${startColumn}`
        : '';
  return {
    resource: match[1],
    range: `lines ${startLine}-${Math.max(startLine, endLine)}${columns}`,
  };
}

function uriLikeToString(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value.trim() || undefined;
  }

  const object = objectValue(value);
  if (!object) {
    return undefined;
  }

  for (const key of ['fsPath', 'filePath', 'file_path', 'path']) {
    const candidate = object[key];
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }

  const scheme = typeof object.scheme === 'string' ? object.scheme : undefined;
  const path = typeof object.path === 'string' ? object.path : undefined;
  if (scheme && path) {
    const authority =
      typeof object.authority === 'string' && object.authority
        ? `//${object.authority}`
        : scheme === 'file'
          ? '//'
          : '';
    const query = typeof object.query === 'string' && object.query
      ? `?${object.query}`
      : '';
    const fragment = typeof object.fragment === 'string' && object.fragment
      ? `#${object.fragment}`
      : '';
    return `${scheme}:${authority}${path}${query}${fragment}`;
  }

  return undefined;
}

function rangeToText(value: unknown): string | undefined {
  const object = objectValue(value);
  if (!object) {
    return undefined;
  }

  const start = objectValue(object.start);
  const end = objectValue(object.end);
  if (
    start &&
    end &&
    typeof start.line === 'number' &&
    typeof end.line === 'number'
  ) {
    const startLine = Math.max(1, Math.floor(start.line) + 1);
    const endLine = Math.max(startLine, Math.floor(end.line) + 1);
    const startCharacter =
      typeof start.character === 'number' ? Math.max(0, Math.floor(start.character)) : undefined;
    const endCharacter =
      typeof end.character === 'number' ? Math.max(0, Math.floor(end.character)) : undefined;
    const characterSuffix =
      startCharacter !== undefined && endCharacter !== undefined
        ? `, columns ${startCharacter}-${endCharacter}`
        : '';
    return `lines ${startLine}-${endLine}${characterSuffix}`;
  }

  if (typeof object.startLine === 'number' || typeof object.endLine === 'number') {
    const startLine = Math.max(1, Math.floor(Number(object.startLine ?? 1)));
    const endLine = Math.max(startLine, Math.floor(Number(object.endLine ?? startLine)));
    return `lines ${startLine}-${endLine}`;
  }

  return undefined;
}

function textFromUnknown(value: unknown, depth = 0): string | undefined {
  if (depth > 4) {
    return undefined;
  }
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    const parts = value
      .map((item) => textFromUnknown(item, depth + 1))
      .filter((item): item is string => Boolean(item));
    return parts.length > 0 ? parts.join('\n') : undefined;
  }

  const object = objectValue(value);
  if (!object) {
    return undefined;
  }
  for (const key of [
    'selectedText',
    'selectionText',
    'text',
    'content',
    'value',
  ]) {
    const text = textFromUnknown(object[key], depth + 1);
    if (text?.trim()) {
      return text;
    }
  }
  return undefined;
}

function resourceFromUnknown(value: unknown, depth = 0): string | undefined {
  if (depth > 4) {
    return undefined;
  }
  const direct = uriLikeToString(value);
  if (direct && (isResourceString(direct) || objectValue(value)?.scheme)) {
    return direct;
  }

  const object = objectValue(value);
  if (!object) {
    return undefined;
  }
  for (const key of [
    'uri',
    'resource',
    'location',
    'documentUri',
    'targetUri',
    'file',
    'filePath',
    'file_path',
    'fsPath',
    'path',
  ]) {
    const resource = resourceFromUnknown(object[key], depth + 1);
    if (resource) {
      return resource;
    }
  }

  const valueCandidate = object.value;
  if (typeof valueCandidate === 'string' && isResourceString(valueCandidate)) {
    return valueCandidate.trim();
  }
  if (valueCandidate && typeof valueCandidate === 'object') {
    return resourceFromUnknown(valueCandidate, depth + 1);
  }
  return undefined;
}

function rangeFromUnknown(value: unknown): string | undefined {
  const object = objectValue(value);
  if (!object) {
    return undefined;
  }
  for (const key of ['range', 'selectionRange', 'selection', 'location']) {
    const range = rangeToText(object[key]);
    if (range) {
      return range;
    }
    const nested = objectValue(object[key]);
    if (nested) {
      const nestedRange = rangeToText(nested.range);
      if (nestedRange) {
        return nestedRange;
      }
    }
  }
  return undefined;
}

function formatAttachment(
  resource: string | undefined,
  range: string | undefined,
  text: string | undefined,
  options: ReferenceRenderOptions,
): string | undefined {
  if (!resource && !text?.trim()) {
    return undefined;
  }

  const output: string[] = [];
  if (resource) {
    output.push('[Attached file reference]');
    output.push(`Path or URI: ${uriToDisplay(resource)}`);
    if (range) {
      output.push(`Selected range: ${range}`);
    }
    if (!text?.trim()) {
      output.push('Use read_file when the file contents are needed.');
    }
  }

  if (text?.trim()) {
    output.push(resource ? '[Selected content]' : '[Attached text reference]');
    output.push(truncateText(text, maxInlineChars(options)));
  }

  return output.join('\n');
}

function parseResourceLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      if (line.startsWith('<') && line.endsWith('>')) {
        return line.slice(1, -1);
      }
      return line;
    })
    .filter((line) => isResourceString(line));
}

function formatDataText(
  text: string,
  mimeType: string,
  options: ReferenceRenderOptions,
): string {
  const resources = parseResourceLines(text);
  const nonCommentLines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  if (resources.length > 0 && resources.length === nonCommentLines.length) {
    const attachments = resources
      .map((resource) => {
        const split = splitUriFragment(resource);
        return formatAttachment(split.resource, split.range, undefined, options);
      })
      .filter((attachment): attachment is string => Boolean(attachment));
    return attachments.length > 0
      ? attachments.join('\n\n')
      : `[Attached data (${mimeType})]\n${truncateText(text, maxInlineChars(options))}`;
  }
  return `[Attached text (${mimeType})]\n${truncateText(text, maxInlineChars(options))}`;
}

function formatStructuredData(
  value: unknown,
  options: ReferenceRenderOptions,
): string | undefined {
  const resource = resourceFromUnknown(value);
  const range = rangeFromUnknown(value);
  const text = textFromUnknown(value);
  return formatAttachment(resource, range, text, options);
}

export function renderActiveEditorReference(
  reference: ActiveEditorReference,
  options: ReferenceRenderOptions = {},
): string | undefined {
  const attachment = formatAttachment(
    reference.resource,
    reference.range,
    reference.text,
    options,
  );
  const label = reference.text?.trim()
    ? '[Active editor selection]'
    : '[Active editor file]';
  return attachment ? `${label}\n${attachment}` : undefined;
}

export function renderDataPart(
  mimeTypeInput: string,
  data: Uint8Array,
  options: ReferenceRenderOptions = {},
): string {
  const mimeType = normalizedMimeType(mimeTypeInput);
  const text = decodeUtf8(data);

  if (mimeType === 'text/uri-list' || mimeType === 'application/vnd.code.uri-list') {
    return formatDataText(text, mimeType, options);
  }

  if (mimeType === 'application/json' || mimeType.endsWith('+json')) {
    try {
      const parsed = JSON.parse(text) as unknown;
      const structured = formatStructuredData(parsed, options);
      if (structured) {
        return structured;
      }
      return `[Attached data (${mimeType})]\n${truncateText(JSON.stringify(parsed, null, 2), maxInlineChars(options))}`;
    } catch {
      // Keep malformed JSON useful as text rather than hiding it.
    }
  }

  if (isTextMime(mimeType)) {
    return formatDataText(text, mimeType, options);
  }

  return `[Attached data (${mimeType}; ${data.byteLength} bytes)]`;
}

function bytesFromUnknown(value: unknown): Uint8Array | undefined {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  if (
    Array.isArray(value) &&
    value.every((item) => typeof item === 'number' && Number.isFinite(item))
  ) {
    return Uint8Array.from(value as number[]);
  }
  return undefined;
}

/** Extracts an image from an opaque VS Code content part when it is not an
 * actual LanguageModelDataPart instance (for example, a future API part). */
export function imageDataFromUnknown(
  part: unknown,
): UnknownImagePart | undefined {
  const object = objectValue(part);
  if (!object) {
    return undefined;
  }

  const source = objectValue(object.source);
  const mimeType = [
    object.mimeType,
    object.mediaType,
    source?.media_type,
  ].find(
    (value): value is string =>
      typeof value === 'string' && value.trim().length > 0,
  );
  if (!mimeType || !mimeType.toLowerCase().startsWith('image/')) {
    return undefined;
  }

  const rawData = object.data ?? source?.data;
  if (typeof rawData === 'string' && rawData.trim()) {
    return { mimeType, data: rawData.trim() };
  }
  const bytes = bytesFromUnknown(rawData);
  return bytes ? { mimeType, data: bytes } : undefined;
}

export function renderUnknownPart(
  part: unknown,
  options: ReferenceRenderOptions = {},
): string {
  if (typeof part === 'string') {
    return part;
  }
  const structured = formatStructuredData(part, options);
  if (structured) {
    return structured;
  }

  try {
    return JSON.stringify(part) ?? String(part);
  } catch {
    return String(part);
  }
}
