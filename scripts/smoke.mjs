import { accessToken, query } from '@qoder-ai/qoder-agent-sdk';

const pat = process.env.QODER_PERSONAL_ACCESS_TOKEN;
if (!pat) {
  console.error('Set QODER_PERSONAL_ACCESS_TOKEN for the smoke test.');
  process.exitCode = 2;
}

if (pat) {
  const q = query({
    prompt: 'Reply with exactly: QODER_BRIDGE_SMOKE_OK',
    options: {
      auth: accessToken(pat),
      cwd: process.cwd(),
      model: 'lite',
      permissionMode: 'auto',
      maxTurns: 1,
      includePartialMessages: true,
    },
  });

  let finalResult = '';
  try {
    for await (const message of q) {
      if (message.type === 'result' && message.subtype === 'success') {
        finalResult = message.result;
      }
    }
  } finally {
    await q.close().catch(() => undefined);
  }

  console.log(finalResult.trim());
}
