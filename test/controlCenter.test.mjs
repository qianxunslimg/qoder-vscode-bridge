import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { createRequire } from 'node:module';

import '../scripts/vscode-mock-require.cjs';

const { QoderControlCenter } = await import('../out/controlCenter.js');
const vscode = createRequire(import.meta.url)('vscode');

function webview(center) {
  const handlers = {};
  const sent = [];
  const elements = { app: { innerHTML: '' }, feedback: { textContent: '', hidden: true } };
  const buttons = [{ dataset: { action: 'refreshModels' }, textContent: '刷新模型目录' }];
  const html = center.html({});
  vm.runInNewContext(html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)[1], {
    acquireVsCodeApi: () => ({ postMessage: (message) => sent.push(message) }),
    document: {
      getElementById: (id) => elements[id],
      querySelectorAll: () => buttons,
      querySelector: () => undefined,
      addEventListener(type, listener) { (handlers[type] ??= []).push(listener); },
    },
    window: { addEventListener(type, listener) { handlers['window:' + type] = [listener]; } },
    Intl,
  });
  return {
    elements, sent, buttons, html,
    dispatch(type, event) { handlers[type]?.forEach((listener) => listener(event)); },
  };
}

test('a context selection from the real webview script is saved to user settings', async (t) => {
  const writes = [];
  const values = {};
  t.mock.method(vscode.workspace, 'getConfiguration', () => ({
    get: (key, fallback) => values[key] ?? fallback,
    async update(key, value, scope) { values[key] = value; writes.push({ key, value, scope }); },
  }));
  const center = new QoderControlCenter({ subscriptions: [] }, {}, { async get() {} });
  const view = webview(center);
  const target = {
    dataset: { modelId: 'gmodel', modelSetting: 'contextWindow' },
    value: '200000',
    closest(selector) { return selector === '[data-model-setting]' ? this : null; },
  };
  view.dispatch('change', { target });
  await center.handleMessage(view.sent.at(-1));
  assert.equal(writes.length, 1);
  assert.equal(writes[0].value.gmodel.contextWindow, 200000);
  assert.equal(writes[0].scope, vscode.ConfigurationTarget.Global);
});

test('model edits do not lose each other while settings writes are pending', async (t) => {
  let saved = {};
  t.mock.method(vscode.workspace, 'getConfiguration', () => ({
    get: (key, fallback) => key === 'modelOverrides' ? saved : fallback,
    async update(_key, value) { await new Promise((resolve) => setImmediate(resolve)); saved = value; },
  }));
  const center = new QoderControlCenter({ subscriptions: [] }, {}, {});
  await Promise.all([
    center.handleMessage({ type: 'setModelSetting', modelId: 'gmodel', key: 'contextWindow', value: 200000 }),
    center.handleMessage({ type: 'setModelSetting', modelId: 'gmodel', key: 'reasoningEffort', value: 'max' }),
  ]);
  assert.deepEqual(saved.gmodel, { contextWindow: 200000, reasoningEffort: 'max' });
});

test('configured PAT alone is not displayed as a verified connection', () => {
  const center = new QoderControlCenter({}, {}, {});
  const view = webview(center);
  view.dispatch('window:message', { data: { type: 'state', state: {
    patConfigured: true, loadedFromQoder: false, models: [], config: {}, usageStatus: 'error',
  } } });
  assert.doesNotMatch(view.elements.app.innerHTML, /已连接/);
  assert.match(view.elements.app.innerHTML, /未验证|连接失败|PAT 已配置/);
});

test('catalog refresh gives immediate feedback in the webview', () => {
  const center = new QoderControlCenter({}, {}, {});
  const view = webview(center);
  const button = view.buttons[0];
  button.closest = () => button;
  view.dispatch('click', { target: button, preventDefault() {} });
  assert.equal(button.disabled, true);
  assert.match(button.textContent, /刷新中/);
  assert.equal(view.sent.at(-1).type, 'refreshModels');
});

test('a failed catalog refresh becomes retryable and preserves the usage panel', async () => {
  const states = [];
  let available = false;
  const center = new QoderControlCenter({}, { async refreshModels() {} }, {});
  center.panel = { webview: { async postMessage(message) { states.push(message.state); } } };
  const usage = { primary: { remaining: 70 } };
  center.latestState = { models: [], usageStatus: 'loaded', usage };
  center.state = async () => ({
    models: [], loadedFromQoder: available, patConfigured: true, workspace: '/workspace',
    usageStatus: 'not-loaded',
  });
  await center.handleMessage({ type: 'refreshModels' });
  assert.equal(states[0].catalogStatus, 'loading');
  assert.equal(states.at(-1).catalogStatus, 'error');
  assert.equal(states.at(-1).usage, usage);
  available = true;
  await center.handleMessage({ type: 'refreshModels' });
  assert.equal(states.at(-1).catalogStatus, 'loaded');
  assert.equal(states.at(-1).usage, usage);
});

test('settings write errors are shown without removing the page', async (t) => {
  t.mock.method(vscode.workspace, 'getConfiguration', () => ({
    get: (_key, fallback) => fallback,
    async update() { throw new Error('read-only settings'); },
  }));
  const center = new QoderControlCenter({}, {}, {});
  const view = webview(center);
  view.elements.app.innerHTML = 'existing settings';
  center.panel = { webview: { async postMessage(message) { view.dispatch('window:message', { data: message }); } } };
  await center.handleMessage({ type: 'setSetting', key: 'maxTurns', value: 40 });
  assert.match(view.elements.feedback.textContent, /保存失败.*read-only settings/);
  assert.equal(view.elements.app.innerHTML, 'existing settings');
});

test('closing the panel while a state read fails does not post to a disposed webview', async () => {
  const pending = deferred();
  const center = new QoderControlCenter({}, {}, {});
  let posts = 0;
  center.panel = { webview: { async postMessage() { posts++; } }, dispose() {} };
  center.state = () => pending.promise;
  const request = center.sendState(false);
  center.dispose();
  pending.reject(new Error('state unavailable'));
  await request;
  assert.equal(posts, 0);
});

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
  const catalog = deferred();
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
  center.state = () => { catalogIndex++; return catalog.promise; };

  const older = center.sendStateWithUsage({ refreshCatalog: true, forceUsage: false });
  await new Promise((resolve) => setImmediate(resolve));
  const newer = center.sendStateWithUsage({ refreshCatalog: false, forceUsage: true });
  await new Promise((resolve) => setImmediate(resolve));

  usages[1].resolve({ userType: 'plus', userQuota: { total: 100, remaining: 25 } });
  await newer;
  catalog.resolve({ models: [{ id: 'new' }], usageStatus: 'not-loaded', loadedFromQoder: true });
  await new Promise((resolve) => setImmediate(resolve));

  usages[0].resolve({ userType: 'plus', userQuota: { total: 100, remaining: 90 } });
  await older;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(states.at(-1).models[0].id, 'new');
  assert.equal(states.at(-1).usage.primary.remaining, 25);
  assert.equal(catalogIndex, 1, 'a usage-only refresh must not restart the catalog request');
});
