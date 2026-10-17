import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import '../scripts/vscode-mock-require.cjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const vscode = createRequire(import.meta.url)('vscode');
let panel;
vscode.ViewColumn = { One: 1 };
vscode.Uri = { joinPath: (base, ...parts) => ({ fsPath: join(base.fsPath, ...parts) }) };
vscode.window = { createWebviewPanel: () => panel };
const { QoderControlCenter } = await import('../out/controlCenter.js');

test('the Marketplace manifest points to a 256px PNG icon', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const png = readFileSync(join(root, manifest.icon));
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  assert.equal(png.readUInt32BE(16), 256);
  assert.equal(png.readUInt32BE(20), 256);
});

test('the control center tab uses existing light and dark icons', async () => {
  panel = {
    webview: { html: '', async postMessage() {}, onDidReceiveMessage() {} },
    onDidDispose() {}, dispose() {},
  };
  const center = new QoderControlCenter(
    { subscriptions: [], extensionUri: { fsPath: root } },
    { async getCatalogSnapshot() { return { models: [], loadedFromQoder: false }; } },
    { async get() {} },
  );
  center.open();
  assert.ok(existsSync(panel.iconPath.light.fsPath));
  assert.ok(existsSync(panel.iconPath.dark.fsPath));
  assert.notEqual(panel.iconPath.light.fsPath, panel.iconPath.dark.fsPath);
  assert.match(panel.webview.html, /--vscode-editor-background/);
  assert.match(panel.webview.html, /vscode-high-contrast-light/);
  await new Promise(resolve => setImmediate(resolve));
  center.dispose();
});
