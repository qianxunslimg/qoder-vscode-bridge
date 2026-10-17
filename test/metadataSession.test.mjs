import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import '../scripts/vscode-mock-require.cjs';

const require = createRequire(import.meta.url);
const Module = require('node:module');
const sdk = require('@qoder-ai/qoder-agent-sdk');
const originalLoad = Module._load;
let makeQuery;
Module._load = function (name, parent, isMain) {
  return name === '@qoder-ai/qoder-agent-sdk'
    ? { ...sdk, query: (...args) => makeQuery(...args) }
    : originalLoad.call(this, name, parent, isMain);
};
const { QoderMetadataSession } = require('../out/modelCatalogService.js');
const { QoderModelProvider } = require('../out/provider.js');
Module._load = originalLoad;

function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('concurrent catalog and usage share one metadata session', async () => {
  let opens = 0, closes = 0;
  makeQuery = () => {
    opens++;
    return {
      async initializationResult() {},
      async getAvailableModels() { return []; },
      async getUsageInfo() { return { userType: 'enterprise' }; },
      async close() { closes++; },
    };
  };
  const metadata = new QoderMetadataSession();
  await Promise.all([metadata.getAvailableModels('a', '/workspace'), metadata.getUsageInfo('a', '/workspace')]);
  await metadata.close();
  assert.equal(opens, 1);
  assert.equal(closes, 1);
});

test('closing during initialization cannot resurrect the old account session', async () => {
  const init = deferred();
  let opens = 0, closes = 0, oldCalls = 0;
  makeQuery = () => {
    const old = opens++ === 0;
    return {
      initializationResult() { return old ? init.promise : Promise.resolve(); },
      async getUsageInfo() { if (old) oldCalls++; return { userType: old ? 'old' : 'new' }; },
      async close() { closes++; },
    };
  };
  const metadata = new QoderMetadataSession();
  const old = metadata.getUsageInfo('a', '/workspace');
  const rejected = assert.rejects(old, /closed|changed|superseded/i);
  await tick();
  await metadata.close();
  assert.equal((await metadata.getUsageInfo('b', '/workspace')).userType, 'new');
  init.resolve();
  await rejected;
  assert.equal((await metadata.getUsageInfo('b', '/workspace')).userType, 'new');
  await metadata.close();
  assert.equal(oldCalls, 0);
  assert.equal(opens, 2);
  assert.equal(closes, 2);
});

test('an old request failure cannot close a newer account session', async () => {
  const oldUsage = deferred();
  let opens = 0, newCloses = 0;
  makeQuery = () => {
    const old = opens++ === 0;
    return {
      async initializationResult() {},
      getUsageInfo() { return old ? oldUsage.promise : Promise.resolve({ userType: 'new' }); },
      async close() { if (!old) newCloses++; },
    };
  };
  const metadata = new QoderMetadataSession();
  const old = metadata.getUsageInfo('a', '/workspace');
  const rejected = assert.rejects(old, /offline/);
  await tick();
  await metadata.getUsageInfo('b', '/workspace');
  oldUsage.reject(new Error('offline'));
  await rejected;
  assert.equal(newCloses, 0);
  assert.equal((await metadata.getUsageInfo('b', '/workspace')).userType, 'new');
  assert.equal(opens, 2);
  await metadata.close();
});

test('clearing PAT during refresh discards the old catalog and usage', async () => {
  let pat = 'old';
  const catalog = deferred(), usage = deferred();
  const provider = new QoderModelProvider({ async get() { return pat; } });
  provider.metadataSession.getAvailableModels = () => catalog.promise;
  provider.metadataSession.getUsageInfo = () => usage.promise;
  const pendingCatalog = provider.refreshModels();
  const pendingUsage = provider.fetchUsage(pat, process.cwd());
  const joinedUsage = provider.fetchUsage(pat, process.cwd());
  await tick();
  pat = undefined;
  const afterClear = provider.refreshModels();
  catalog.resolve([{ value: 'old-model', displayName: 'Old account' }]);
  usage.resolve({ userType: 'old' });
  assert.equal(await afterClear, false);
  assert.equal(await pendingCatalog, false);
  assert.equal(await pendingUsage, null);
  assert.equal(await joinedUsage, null);
  const snapshot = await provider.getCatalogSnapshot(false, false);
  assert.equal(snapshot.loadedFromQoder, false);
  assert.equal(snapshot.models.some((model) => model.id === 'old-model'), false);
  assert.equal(provider.usageCache, undefined);
  provider.dispose();
});

test('initialization failure can be retried even if SDK cleanup stalls', async () => {
  let opens = 0;
  makeQuery = () => {
    const fail = opens++ === 0;
    return {
      async initializationResult() { if (fail) throw new Error('offline'); },
      async getUsageInfo() { return { userType: 'new' }; },
      close() { return new Promise(() => {}); },
    };
  };
  const metadata = new QoderMetadataSession();
  await assert.rejects(metadata.getUsageInfo('a', '/workspace'), /offline/);
  assert.equal((await metadata.getUsageInfo('a', '/workspace')).userType, 'new');
  await metadata.close();
  assert.equal(opens, 2);
});

test('a slow old account cannot overwrite the refreshed new account', async () => {
  let pat = 'old';
  const oldCatalog = deferred(), oldUsage = deferred();
  const provider = new QoderModelProvider({ async get() { return pat; } });
  provider.metadataSession.getAvailableModels = (token) => token === 'old'
    ? oldCatalog.promise : Promise.resolve([{ value: 'new-model', displayName: 'New account' }]);
  provider.metadataSession.getUsageInfo = (token) => token === 'old'
    ? oldUsage.promise : Promise.resolve({ userType: 'new' });
  const previousCatalog = provider.getCatalogSnapshot(true);
  const previousUsage = provider.fetchUsage(pat, process.cwd());
  await tick();
  pat = 'new';
  assert.equal(await provider.refreshModels(), true);
  assert.equal((await provider.fetchUsage(pat, process.cwd())).userType, 'new');
  oldCatalog.resolve([{ value: 'old-model', displayName: 'Old account' }]);
  oldUsage.resolve({ userType: 'old' });
  assert.equal((await previousCatalog).models[0].id, 'new-model');
  assert.equal(await previousUsage, null);
  assert.equal(provider.usageCache.usage.userType, 'new');
  assert.equal((await provider.getCatalogSnapshot(false, false)).models[0].id, 'new-model');
  provider.dispose();
});
