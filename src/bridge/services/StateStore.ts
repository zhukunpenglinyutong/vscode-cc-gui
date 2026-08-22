import * as vscode from 'vscode';

export class StateStore {
  constructor(private readonly context: vscode.ExtensionContext) {}

  get<T>(key: string, defaultValue: T): T {
    return this.context.globalState.get<T>(key) ?? defaultValue;
  }

  update<T>(key: string, value: T | undefined): Thenable<void> {
    return this.context.globalState.update(key, value);
  }

  getString(key: string, defaultValue = ''): string {
    return this.get<string>(key, defaultValue);
  }

  updateString(key: string, value: string): Thenable<void> {
    return this.update(key, value);
  }
}
