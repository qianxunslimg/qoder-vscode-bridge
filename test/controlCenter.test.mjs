import assert from 'node:assert/strict';
import test from 'node:test';

import '../scripts/vscode-mock-require.cjs';

const { QoderControlCenter } = await import('../out/controlCenter.js');

test('model inactivity timeout is independently bounded in the control center', () => {
  const center = new QoderControlCenter(
    { subscriptions: [] },
    {},
    { async get() { return undefined; } },
  );
  assert.equal(center.normalizeSetting('sdkIdleTimeoutMs', 1), 30_000);
  assert.equal(center.normalizeSetting('sdkIdleTimeoutMs', 5_000_000), 1_800_000);
  assert.equal(center.normalizeSetting('sdkIdleTimeoutMs', 'invalid'), undefined);
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

test('usage is shown before a slower model catalog refresh finishes', async () => {
  const catalog = deferred();
  const usage = deferred();
  const states = [];
  const provider = {
    fetchUsage() { return usage.promise; },
  };
  const center = new QoderControlCenter(
    { subscriptions: [] },
    provider,
    { async get() { return 'test-token'; } },
  );
  center.panel = {
    webview: {
      async postMessage(message) {
        if (message.type === 'state') {
          states.push(message.state);
        }
      },
    },
  };
  center.latestState = {
    models: [{ id: 'old' }],
    usageStatus: 'not-loaded',
  };
  center.state = () => catalog.promise;

  const request = center.sendStateWithUsage({
    refreshCatalog: true,
    forceUsage: false,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(states.at(-1).usageStatus, 'loading');

  usage.resolve({
    userType: 'enterprise',
    orgResourcePackage: { cap: 100, remaining: 70 },
  });
  await request;
  assert.equal(states.at(-1).usageStatus, 'loaded');
  assert.equal(states.at(-1).usage.primary.remaining, 70);
  assert.equal(states.at(-1).models[0].id, 'old');

  catalog.resolve({ models: [{ id: 'new' }], usageStatus: 'not-loaded' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(states.at(-1).models[0].id, 'new');
  assert.equal(states.at(-1).usageStatus, 'loaded');
  assert.equal(states.at(-1).usage.primary.remaining, 70);
});

test('an older usage request cannot overwrite a newer refresh', async () => {
  const catalogs = [deferred(), deferred()];
  const usages = [deferred(), deferred()];
  const states = [];
  let catalogIndex = 0;
  let usageIndex = 0;
  const center = new QoderControlCenter(
    { subscriptions: [] },
    { fetchUsage() { return usages[usageIndex++].promise; } },
    { async get() { return 'test-token'; } },
  );
  center.panel = {
    webview: {
      async postMessage(message) {
        if (message.type === 'state') states.push(message.state);
      },
    },
  };
  center.latestState = { models: [], usageStatus: 'not-loaded' };
  center.state = () => catalogs[catalogIndex++].promise;

  const older = center.sendStateWithUsage({ refreshCatalog: true, forceUsage: false });
  await new Promise((resolve) => setImmediate(resolve));
  const newer = center.sendStateWithUsage({ refreshCatalog: false, forceUsage: true });
  await new Promise((resolve) => setImmediate(resolve));

  usages[1].resolve({ userType: 'plus', userQuota: { total: 100, remaining: 25 } });
  await newer;
  catalogs[1].resolve({ models: [{ id: 'new' }], usageStatus: 'not-loaded' });
  await new Promise((resolve) => setImmediate(resolve));

  usages[0].resolve({ userType: 'plus', userQuota: { total: 100, remaining: 90 } });
  catalogs[0].resolve({ models: [{ id: 'old' }], usageStatus: 'not-loaded' });
  await older;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(states.at(-1).models[0].id, 'new');
  assert.equal(states.at(-1).usage.primary.remaining, 25);
});
