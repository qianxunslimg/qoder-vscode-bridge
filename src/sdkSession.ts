import type { SDKUserMessage } from '@qoder-ai/qoder-agent-sdk';

/** Keep a metadata-only SDK session alive until the caller closes it. */
export async function* holdSessionOpen(): AsyncGenerator<SDKUserMessage, void> {
  await new Promise<void>(() => undefined);
}
