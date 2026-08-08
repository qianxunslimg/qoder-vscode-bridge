import {
  accessToken,
  query,
  type ModelInfo,
  type Query,
  type UsageInfo,
} from '@qoder-ai/qoder-agent-sdk';
import { holdSessionOpen } from './sdkSession.js';

/**
 * A metadata-only Qoder session that stays open while the extension is alive.
 *
 * Qoder's worker runtime can race when a metadata session is closed and a chat
 * session is created immediately afterwards. Reusing this session avoids that
 * lifecycle gap and also makes model refreshes cheap.
 */
export class QoderMetadataSession {
  private querySession: Query | undefined;
  private sessionKey: string | undefined;
  private opening: Promise<Query> | undefined;

  public async getAvailableModels(
    pat: string,
    cwd: string,
  ): Promise<ModelInfo[]> {
    const session = await this.ensureSession(pat, cwd);
    try {
      return await session.getAvailableModels({ fetchStrategy: 'live' });
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  public async getUsageInfo(
    pat: string,
    cwd: string,
  ): Promise<UsageInfo | null> {
    const session = await this.ensureSession(pat, cwd);
    try {
      return await session.getUsageInfo();
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  public async close(): Promise<void> {
    const session = this.querySession;
    this.querySession = undefined;
    this.sessionKey = undefined;
    if (session) {
      await session.close().catch(() => undefined);
    }
  }

  private async ensureSession(pat: string, cwd: string): Promise<Query> {
    const nextKey = `${cwd}\u0000${pat}`;
    if (this.querySession && this.sessionKey === nextKey) {
      return this.querySession;
    }

    if (this.opening) {
      const session = await this.opening;
      if (this.sessionKey === nextKey) {
        return session;
      }
    }

    await this.close();
    const opening = this.openSession(pat, cwd);
    this.opening = opening;
    try {
      const session = await opening;
      this.querySession = session;
      this.sessionKey = nextKey;
      return session;
    } finally {
      if (this.opening === opening) {
        this.opening = undefined;
      }
    }
  }

  private async openSession(pat: string, cwd: string): Promise<Query> {
    const session = query({
      prompt: holdSessionOpen(),
      options: {
        auth: accessToken(pat),
        cwd,
        permissionMode: 'auto',
      },
    });
    try {
      await session.initializationResult();
      return session;
    } catch (error) {
      await session.close().catch(() => undefined);
      throw error;
    }
  }
}

/** One-shot helper for CLI smoke tests. Extension code should reuse a session. */
export async function fetchModelCatalog(
  pat: string,
  cwd: string,
): Promise<ModelInfo[]> {
  const session = new QoderMetadataSession();
  try {
    return await session.getAvailableModels(pat, cwd);
  } finally {
    await session.close();
  }
}
