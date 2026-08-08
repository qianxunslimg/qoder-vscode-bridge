import type { UsageInfo } from '@qoder-ai/qoder-agent-sdk';
import { QoderMetadataSession } from './modelCatalogService.js';

/** One-shot usage helper for callers outside the long-lived provider. */
export async function fetchUsage(
  pat: string,
  cwd: string,
): Promise<UsageInfo | null> {
  const session = new QoderMetadataSession();
  try {
    return await session.getUsageInfo(pat, cwd);
  } finally {
    await session.close();
  }
}
