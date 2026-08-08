import * as vscode from 'vscode';
import { QoderModelProvider } from './provider.js';
import { registerQoderReadFileTool } from './nativeReadFileTool.js';
import { TokenStore } from './tokenStore.js';

function workspaceCwd(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

export function activate(context: vscode.ExtensionContext): void {
  const tokenStore = new TokenStore(context.secrets);
  const provider = new QoderModelProvider(tokenStore);

  registerQoderReadFileTool(context);

  context.subscriptions.push(
    vscode.lm.registerLanguageModelChatProvider('qoder', provider),
  );
  context.subscriptions.push(provider);

  context.subscriptions.push(
    vscode.commands.registerCommand('qoderBridge.setPat', async () => {
      const pat = await vscode.window.showInputBox({
        prompt: 'Qoder Personal Access Token',
        password: true,
        ignoreFocusOut: true,
        placeHolder: 'Paste the PAT once; it will be stored in SecretStorage.',
      });
      const normalized = pat?.trim();
      if (!normalized) {
        return false;
      }
      await tokenStore.set(normalized);
      const loaded = await provider.refreshModels();
      if (loaded) {
        void vscode.window.showInformationMessage(
          'Qoder PAT saved securely; the current model catalog is ready.',
        );
      } else {
        void vscode.window.showWarningMessage(
          'Qoder PAT saved securely, but the live model catalog was unavailable; retry refresh later.',
        );
      }
      return true;
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('qoderBridge.clearPat', async () => {
      await tokenStore.clear();
      await provider.refreshModels();
      void vscode.window.showInformationMessage('Qoder PAT cleared.');
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('qoderBridge.refreshModels', async () => {
      const loaded = await provider.refreshModels();
      void (loaded
        ? vscode.window.showInformationMessage(
            'Qoder model catalog refreshed from the account.',
          )
        : vscode.window.showWarningMessage(
            'Qoder model catalog is unavailable; the fallback tier list remains visible.',
          ));
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('qoderBridge.showUsage', async () => {
      const pat = await tokenStore.get();
      const cwd = workspaceCwd();
      if (!pat) {
        void vscode.window.showWarningMessage(
          'Configure a Qoder PAT before checking usage.',
        );
        return;
      }
      if (!cwd) {
        void vscode.window.showWarningMessage(
          'Open a workspace folder before checking Qoder usage.',
        );
        return;
      }

      try {
        const usage = await provider.fetchUsage(pat, cwd);
        if (!usage) {
          void vscode.window.showWarningMessage(
            'Qoder did not return usage information for this session.',
          );
          return;
        }
        const plan = usage.userType ?? 'unknown';
        const remaining = usage.userQuota?.remaining;
        const total = usage.userQuota?.total;
        const unit = usage.userQuota?.unit ?? 'Credits';
        const org = usage.orgResourcePackage?.remaining;
        const orgText = org === undefined ? '' : ` Organization remaining: ${org}.`;
        void vscode.window.showInformationMessage(
          `Qoder ${plan}: ${remaining ?? '?'} / ${total ?? '?'} ${unit} remaining.${orgText}`,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        void vscode.window.showErrorMessage(`Qoder usage check failed: ${message}`);
      }
    }),
  );
}

export function deactivate(): void {}
