/**
 * Small, deliberately allow-listed diagnostic logger for the native bridge.
 *
 * Diagnostics are useful when VS Code drops a native tool callback, but this
 * logger must never become a second prompt or tool-output sink. Callers may
 * pass text-like values for convenience; only their lengths are retained.
 */

export type DiagnosticWriter = (line: string) => void;

const SAFE_STRING_FIELDS = new Set([
  'tool',
  'proxy',
  'status',
  'reasonCode',
  'errorName',
  'model',
  'boundary',
  'sessionId',
]);

const OMITTED_FIELD_PATTERN = /(?:path|uri|token|secret|prompt|cwd|file)/i;
const LENGTH_FIELD_PATTERN = /(?:text|content|input|output|error|reason)/i;

export interface DiagnosticFields {
  readonly [key: string]: unknown;
}

function safeFields(fields: DiagnosticFields): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || OMITTED_FIELD_PATTERN.test(key)) {
      continue;
    }
    if (SAFE_STRING_FIELDS.has(key) && typeof value === 'string') {
      result[key] = value;
      continue;
    }
    if (key === 'text' || key === 'content' || key === 'input' || key === 'output') {
      if (typeof value === 'string') {
        result[`${key}Length`] = value.length;
      }
      continue;
    }
    if (LENGTH_FIELD_PATTERN.test(key) && typeof value === 'string') {
      result[`${key}Length`] = value.length;
      continue;
    }
    if (
      (key === 'callId' || key.endsWith('Count') || key.endsWith('Length') || key.endsWith('Ms')) &&
      (typeof value === 'number' || typeof value === 'string')
    ) {
      result[key] = value;
      continue;
    }
    if (typeof value === 'boolean') {
      result[key] = value;
    }
  }
  return result;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownError';
}

export function errorMetadata(error: unknown): DiagnosticFields {
  if (error instanceof Error) {
    return { errorName: errorName(error), errorLength: error.message.length };
  }
  const message = String(error);
  return { errorName: errorName(error), errorLength: message.length };
}

export class BridgeDiagnostics {
  public constructor(
    private readonly enabled: boolean,
    private readonly writer: DiagnosticWriter = (line) => console.info(line),
  ) {}

  public event(name: string, fields: DiagnosticFields = {}): void {
    if (!this.enabled) {
      return;
    }
    const metadata = safeFields(fields);
    const suffix = Object.keys(metadata).length > 0
      ? ` ${JSON.stringify(metadata)}`
      : '';
    this.writer(
      `[qoder-bridge] ${new Date().toISOString()} ${name}${suffix}`,
    );
  }
}

export function textLength(value: unknown): number {
  return typeof value === 'string' ? value.length : 0;
}
