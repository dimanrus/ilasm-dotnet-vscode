import * as vscode from 'vscode';

/** Minimal output channel wrapper so the engine log stays out of the user's way. */
export class Log {
  private static channel: vscode.OutputChannel | undefined;

  static init(): void {
    if (!this.channel) {
      this.channel = vscode.window.createOutputChannel('ILASM Dotnet');
    }
  }

  static info(message: string): void {
    this.channel?.appendLine(message);
  }

  static error(message: string, error?: unknown): void {
    const detail = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error ?? '');
    this.channel?.appendLine(`[error] ${message}${detail ? `\n${detail}` : ''}`);
  }

  static show(): void {
    this.channel?.show(true);
  }
}
