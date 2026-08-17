import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const scriptPath = join(process.cwd(), '.github', 'scripts', 'publish-release.sh');

function runRelease(mode) {
  const directory = mkdtempSync(join(tmpdir(), 'qoder-release-test-'));
  const logPath = join(directory, 'gh.log');
  const ghPath = join(directory, 'gh');
  writeFileSync(
    ghPath,
    '#!/usr/bin/env sh\n' +
      'printf "%s\\n" "$*" >> "$GH_LOG"\n' +
      'if [ "$1" = release ] && [ "$2" = view ] && [ "$GH_FAKE_MODE" = missing ]; then exit 1; fi\n',
  );
  chmodSync(ghPath, 0o755);

  try {
    execFileSync('bash', [scriptPath, 'qoder-vscode-bridge-0.1.1.vsix'], {
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH}`,
        GH_FAKE_MODE: mode,
        GH_LOG: logPath,
        GITHUB_REF_NAME: 'v0.1.1',
      },
      stdio: 'pipe',
    });
    return readFileSync(logPath, 'utf8').trim().split('\n');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('updates an existing release asset instead of recreating the release', () => {
  assert.deepEqual(runRelease('existing'), [
    'release view v0.1.1',
    'release upload v0.1.1 qoder-vscode-bridge-0.1.1.vsix --clobber',
  ]);
});

test('creates a release when the tag has no release yet', () => {
  assert.deepEqual(runRelease('missing'), [
    'release view v0.1.1',
    'release create v0.1.1 qoder-vscode-bridge-0.1.1.vsix --verify-tag --title v0.1.1 --generate-notes',
  ]);
});
