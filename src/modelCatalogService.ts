import {
  accessToken,
  query,
  type ModelInfo,
  type Query,
  type UsageInfo,
} from '@qoder-ai/qoder-agent-sdk';
import { holdSessionOpen } from './sdkSession.js';

// Metadata requests should fail visibly instead of leaving the control center
// waiting behind the SDK's much longer general-purpose control timeout.
const METADATA_CONTROL_REQUEST_TIMEOUT_MS = 15_000;

interface MetadataConnection {
  readonly key: string;
  readonly session: Query;
  ready: Promise<Query>;
}

/**
 * A metadata-only Qoder session that stays open while the extension is alive.
 *
 * Qoder's worker runtime can race when a metadata session is closed and a chat
 * session is created immediately afterwards. Reusing this session avoids that
 * lifecycle gap and also makes model refreshes cheap.
 */
export class QoderMetadataSession {
  private connection: MetadataConnection | undefined;
  private readonly closedSessions = new WeakSet<Query>();

  public async getAvailableModels(
    pat: string,
    cwd: string,
  ): Promise<ModelInfo[]> {
    const session = await this.ensureSession(pat, cwd);
    try {
      return await session.getAvailableModels({ fetchStrategy: 'live' });
    } catch (error) {
      this.closeSession(session);
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
      this.closeSession(session);
      throw error;
    }
  }

  public async close(): Promise<void> {
    const session = this.connection?.session;
    this.connection = undefined;
    if (session) {
      this.closeSession(session);
    }
  }

  private closeSession(session: Query): void {
    if (this.connection?.session === session) {
      this.connection = undefined;
    }
    if (this.closedSessions.has(session)) return;
    this.closedSessions.add(session);
    try {
      // Cleanup must not keep a failed metadata request pending indefinitely.
      void session.close().catch(() => undefined);
    } catch {
      // The connection is already invalidated even if SDK cleanup fails.
    }
  }

  private ensureSession(pat: string, cwd: string): Promise<Query> {
    const key = `${cwd}\u0000${pat}`;
    if (this.connection?.key === key) return this.connection.ready;
    void this.close();
    const session = query({
      prompt: holdSessionOpen(),
      options: {
        auth: accessToken(pat),
        cwd,
        permissionMode: 'auto',
        controlRequestTimeoutMs: METADATA_CONTROL_REQUEST_TIMEOUT_MS,
      },
    });
    const connection: MetadataConnection = {
      key,
      session,
      ready: Promise.resolve(session),
    };
    // Publish the in-flight connection before the first asynchronous boundary.
    this.connection = connection;
    connection.ready = Promise.resolve()
      .then(() => session.initializationResult())
      .then(() => {
        if (this.connection !== connection) {
          throw new Error('Qoder metadata session closed or account changed.');
        }
        return session;
      })
      .catch((error: unknown) => {
        this.closeSession(session);
        throw error;
      });
    return connection.ready;
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
