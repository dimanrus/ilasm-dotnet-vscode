import * as vscode from 'vscode';

/** Minimal output channel wrapper so the engine log stays out of the user's way. */
export class Log {
  private static channel: vscode.LogOutputChannel | undefined;

  static init(): void {
    if (!this.channel) {
      // A log channel carries the severity of every line, so the Output panel can filter by level
      // instead of the reader having to spot a prefix.
      this.channel = vscode.window.createOutputChannel('ILASM Dotnet', { log: true });
    }
  }

  static info(message: string): void {
    this.channel?.info(message);
  }

  static error(message: string, error?: unknown): void {
    const detail = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error ?? '');
    this.channel?.error(`${message}${detail ? `\n${detail}` : ''}`);
  }

  static show(): void {
    this.channel?.show(true);
  }
}
