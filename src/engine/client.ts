import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import * as vscode from 'vscode';
import { Log } from '../util/log';

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  method: string;
}

interface RpcResponse {
  id?: number;
  result?: unknown;
  error?: { code: number; message: string; data?: string };
}

const ENGINE_DLL = 'IlasmDotnet.Engine.dll';
const TFM = 'net10.0';

/** Talks to the .NET engine over line delimited JSON-RPC on stdio. */
export class EngineClient implements vscode.Disposable {
  private process: ChildProcessWithoutNullStreams | undefined;
  private startPromise: Promise<void> | undefined;
  private readonly pending = new Map<number, PendingCall>();
  private nextId = 1;
  private disposed = false;

  constructor(private readonly extensionPath: string) {}

  /** Resolves the engine entry point, preferring an explicit setting. */
  private resolveLaunch(): { command: string; args: string[] } {
    const configuration = vscode.workspace.getConfiguration('ilasmDotnet');
    const dotnet = configuration.get<string>('dotnetPath', 'dotnet');
    const configured = configuration.get<string>('enginePath', '');

    const candidates: string[] = [];
    if (configured) {
      candidates.push(configured);
    }

    candidates.push(
      path.join(this.extensionPath, 'out', 'engine', ENGINE_DLL),
      path.join(this.extensionPath, 'out', 'engine', 'IlasmDotnet.Engine'),
      path.join(this.extensionPath, 'engine', 'IlasmDotnet.Engine', 'bin', 'Release', TFM, ENGINE_DLL),
      path.join(this.extensionPath, 'engine', 'IlasmDotnet.Engine', 'bin', 'Debug', TFM, ENGINE_DLL),
    );

    for (const candidate of candidates) {
      if (!candidate || !fs.existsSync(candidate)) {
        continue;
      }

      return candidate.endsWith('.dll')
        ? { command: dotnet, args: [candidate] }
        : { command: candidate, args: [] };
    }

    throw new Error(
      'ILASM Dotnet engine was not found. Build it with "dotnet publish engine/IlasmDotnet.Engine/IlasmDotnet.Engine.csproj -c Release -o out/engine", ' +
        'or point "ilasmDotnet.enginePath" at the built assembly.',
    );
  }

  async ensureStarted(): Promise<void> {
    if (this.disposed) {
      throw new Error('The ILASM Dotnet engine client has been disposed.');
    }

    if (this.process) {
      return;
    }

    if (!this.startPromise) {
      this.startPromise = this.start().catch((error: unknown) => {
        this.startPromise = undefined;
        throw error;
      });
    }

    return this.startPromise;
  }

  private async start(): Promise<void> {
    const launch = this.resolveLaunch();
    Log.info(`[engine] starting: ${launch.command} ${launch.args.join(' ')}`);

    const child = spawn(launch.command, launch.args, { stdio: 'pipe' });
    this.process = child;

    child.on('error', (error) => {
      Log.error('engine process error', error);
      this.failAllPending(error);
      this.process = undefined;
    });

    child.on('exit', (code, signal) => {
      Log.info(`[engine] exited with code ${code} (signal ${signal ?? 'none'})`);
      this.failAllPending(new Error(`ILASM Dotnet engine exited (code ${code ?? 'null'}).`));
      this.process = undefined;
      this.startPromise = undefined;
    });

    const stderr = readline.createInterface({ input: child.stderr });
    stderr.on('line', (line) => Log.info(`[engine] ${line}`));

    const stdout = readline.createInterface({ input: child.stdout });
    stdout.on('line', (line) => this.handleLine(line));

    // Fail fast if the host cannot start the engine at all.
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => resolve(), 200);
      child.once('spawn', () => {
        clearTimeout(timer);
        resolve();
      });
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  private handleLine(line: string): void {
    if (!line.trim()) {
      return;
    }

    let response: RpcResponse;
    try {
      response = JSON.parse(line) as RpcResponse;
    } catch {
      Log.info(`[engine] unparsable output: ${line.slice(0, 200)}`);
      return;
    }

    if (typeof response.id !== 'number') {
      return;
    }

    const pending = this.pending.get(response.id);
    if (!pending) {
      return;
    }

    this.pending.delete(response.id);

    if (response.error) {
      pending.reject(new Error(`${pending.method}: ${response.error.message}`));
    } else {
      pending.resolve(response.result);
    }
  }

  private failAllPending(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }

    this.pending.clear();
  }

  call<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    return this.ensureStarted().then(
      () =>
        new Promise<T>((resolve, reject) => {
          const child = this.process;
          if (!child) {
            reject(new Error('The ILASM Dotnet engine is not running.'));
            return;
          }

          const id = this.nextId++;
          this.pending.set(id, {
            resolve: resolve as (value: unknown) => void,
            reject,
            method,
          });

          child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`, (error) => {
            if (error) {
              this.pending.delete(id);
              reject(error);
            }
          });
        }),
    );
  }

  dispose(): void {
    this.disposed = true;
    const child = this.process;
    this.process = undefined;
    if (child) {
      try {
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'shutdown' })}\n`);
        child.stdin.end();
      } catch {
        // The process is already gone; nothing to clean up.
      }

      setTimeout(() => child.kill(), 500).unref?.();
    }

    this.failAllPending(new Error('The ILASM Dotnet engine has been shut down.'));
  }
}
