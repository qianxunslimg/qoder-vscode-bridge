import * as vscode from 'vscode';

const SECRET_KEY = 'qoderBridge.personalAccessToken';

export class TokenStore {
  public constructor(private readonly secrets: vscode.SecretStorage) {}

  public get(): Thenable<string | undefined> {
    return this.secrets.get(SECRET_KEY);
  }

  public async set(token: string): Promise<void> {
    await this.secrets.store(SECRET_KEY, token);
  }

  public async clear(): Promise<void> {
    await this.secrets.delete(SECRET_KEY);
  }
}
