export interface PromptEntry {
  readonly label: string;
  readonly text: string;
}

export const DEFAULT_PROMPT_CHAR_BUDGET = 48_000;
const MAX_ASSISTANT_ENTRY_CHARS = 12_000;

const COPILOT_HOST_MARKERS = [
  'You are an expert AI programming assistant',
  'When asked for your name, you must respond',
  'Follow Microsoft content policies',
  '<instructions>',
  '<context>',
  '<reminderInstructions>',
];

const USER_REQUEST_PATTERN = /<userRequest>\s*([\s\S]*?)\s*<\/userRequest>/gi;

/**
 * Copilot can send its host policy/instruction envelope as user content. It is
 * not useful to Qoder and can be hundreds of kilobytes. Keep the actual
 * request when the envelope is recognisable; otherwise leave normal user text
 * untouched.
 */
export function stripCopilotHostInstructions(text: string): string {
  const requests = [...text.matchAll(USER_REQUEST_PATTERN)];
  if (requests.length === 0) {
    return text;
  }
  const markerCount = COPILOT_HOST_MARKERS.filter((marker) =>
    text.includes(marker),
  ).length;
  if (markerCount < 1) {
    return text;
  }

  const latestRequest = requests.at(-1)?.[1]?.trim();
  return latestRequest || '[Copilot host instructions omitted]';
}

function entryCost(entry: PromptEntry): number {
  return entry.label.length + entry.text.length + 4;
}

function compactLatestMessage(text: string, available: number): string {
  if (text.length <= available) {
    return text;
  }
  const marker = '\n[Middle of latest message omitted]\n';
  if (available <= marker.length + 1) {
    return text.slice(0, available);
  }
  const retained = available - marker.length;
  const tailLength = Math.max(1, Math.floor(retained * 0.4));
  return text.slice(0, retained - tailLength) + marker + text.slice(-tailLength);
}

/** Keep recent conversation context within a deterministic character budget. */
export function compactPromptEntries(
  entries: readonly PromptEntry[],
  maxChars = DEFAULT_PROMPT_CHAR_BUDGET,
): PromptEntry[] {
  const budget = Math.max(0, Math.floor(maxChars));
  if (budget === 0) {
    return [];
  }

  const normalized = entries
    .map((entry) => {
      const label = entry.label.trim() || 'user';
      let text = stripCopilotHostInstructions(entry.text).trim();
      if (
        label.startsWith('assistant') &&
        text.length > MAX_ASSISTANT_ENTRY_CHARS
      ) {
        text = [
          '[Earlier assistant activity omitted]',
          text.slice(-MAX_ASSISTANT_ENTRY_CHARS),
        ].join('\n');
      }
      return { label, text };
    })
    .filter((entry) => entry.text.length > 0);

  const kept: PromptEntry[] = [];
  let used = 0;
  let omitted = false;

  for (let index = normalized.length - 1; index >= 0; index -= 1) {
    const entry = normalized[index];
    const cost = entryCost(entry);
    if (used + cost <= budget) {
      kept.unshift(entry);
      used += cost;
      continue;
    }

    omitted = true;
    if (kept.length > 0) {
      continue;
    }

    // The latest request may put its instructions before a large attachment.
    // Retain both ends so the instruction cannot disappear behind the limit.
    const available = Math.max(0, budget - entry.label.length - 4);
    if (available === 0) {
      continue;
    }
    kept.unshift({
      label: entry.label,
      text: compactLatestMessage(entry.text, available),
    });
    used = entryCost(kept[0]);
  }

  if (!omitted) {
    return kept;
  }

  const marker: PromptEntry = {
    label: 'system',
    text: '[Earlier conversation omitted for performance.]',
  };
  while (kept.length > 1 && used + entryCost(marker) > budget) {
    const removed = kept.shift();
    if (removed) {
      used -= entryCost(removed);
    }
  }
  if (used + entryCost(marker) <= budget) {
    kept.unshift(marker);
  }
  return kept;
}
