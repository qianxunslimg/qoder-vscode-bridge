import { accessToken, query } from '@qoder-ai/qoder-agent-sdk';
import { QoderMetadataSession } from '../out/modelCatalogService.js';

const pat = process.env.QODER_PERSONAL_ACCESS_TOKEN?.trim();
if (!pat) {
  console.error('QODER_PERSONAL_ACCESS_TOKEN is required');
  process.exit(2);
}

const requestedId = process.env.QODER_SMOKE_MODEL?.trim() || 'qmodel_38max';
const metadataSession = new QoderMetadataSession();
let chatSession;
let exitCode = 0;

try {
  const catalog = await metadataSession.getAvailableModels(pat, process.cwd());
  const model = catalog.find(
    (candidate) =>
      candidate.value === requestedId && candidate.isEnabled !== false,
  );
  if (!model) {
    throw new Error(`requested smoke model is not available: ${requestedId}`);
  }

  const contextWindow = model.availableContextWindows?.length
    ? Math.max(...model.availableContextWindows)
    : undefined;
  chatSession = query({
    prompt: 'Solve this simple check and reply with only the number: 2+2.',
    options: {
      auth: accessToken(pat),
      cwd: process.cwd(),
      model: model.value,
      extraArgs:
        contextWindow === undefined
          ? undefined
          : { 'context-window': String(contextWindow) },
      permissionMode: 'auto',
      maxTurns: 1,
      includePartialMessages: false,
    },
  });

  let result;
  for await (const message of chatSession) {
    if (message.type === 'result') {
      result = message;
    }
  }
  if (!result || result.subtype !== 'success') {
    throw new Error('concrete model request did not succeed');
  }
  if (!result.result.trim()) {
    throw new Error('concrete model returned an empty response');
  }

  process.stdout.write(
    `${JSON.stringify({
      marker: 'QODER_CONCRETE_MODEL_OK',
      model: model.value,
      contextWindow,
    })}\n`,
  );
} catch (error) {
  exitCode = 1;
  console.error(error instanceof Error ? error.stack : String(error));
} finally {
  await chatSession?.close().catch(() => undefined);
}

// The metadata session deliberately stays open until the process exits. This
// avoids the SDK's close-then-immediate-reopen race in a one-shot smoke test.
await new Promise((resolve) => setImmediate(resolve));
process.exit(exitCode);
