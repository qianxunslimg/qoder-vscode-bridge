import assert from 'node:assert/strict';
import test from 'node:test';

const { BridgeDiagnostics, errorMetadata } = await import('../out/diagnostics.js');

test('does not write diagnostics when debug logging is disabled', () => {
  const lines = [];
  const diagnostics = new BridgeDiagnostics(false, (line) => lines.push(line));

  diagnostics.event('tool_result_received', {
    callId: 'qoder-native-call-1',
    sessionId: 'native-session-1',
    tool: 'Read',
    status: 'success',
    text: 'secret file content',
  });

  assert.deepEqual(lines, []);
});

test('writes allow-listed metadata and only text lengths', () => {
  const lines = [];
  const diagnostics = new BridgeDiagnostics(true, (line) => lines.push(line));

  diagnostics.event('tool_result_received', {
    callId: 'qoder-native-call-1',
    sessionId: 'native-session-1',
    tool: 'Read',
    status: 'success',
    text: 'secret file content',
    filePath: '/home/user/private.txt',
    token: 'pat-secret',
    prompt: 'do not persist this prompt',
  });

  assert.equal(lines.length, 1);
  assert.match(lines[0], /qoder-native-call-1/);
  assert.match(lines[0], /"sessionId":"native-session-1"/);
  assert.match(lines[0], /"tool":"Read"/);
  assert.match(lines[0], /"status":"success"/);
  assert.match(lines[0], /"textLength":19/);
  assert.doesNotMatch(lines[0], /secret file content|private\.txt|pat-secret|do not persist/);
});

test('error metadata excludes the error message body', () => {
  const lines = [];
  const diagnostics = new BridgeDiagnostics(true, (line) => lines.push(line));

  diagnostics.event('native_session_error', {
    status: 'error',
    ...errorMetadata(new Error('failed while reading /private/file.txt')),
  });

  assert.match(lines[0], /"errorName":"Error"/);
  assert.match(lines[0], /"errorLength":/);
  assert.doesNotMatch(lines[0], /private\/file\.txt/);
});
