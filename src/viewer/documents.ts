import * as vscode from 'vscode';
import { EngineClient } from '../engine/client';
import { EngineRequest } from './viewSession';
import { ViewInfo } from '../engine/protocol';
import { Log } from '../util/log';
import { ViewerKind, ViewerSession, CacheKeyOptions, cacheKey, languageFor, requestFor } from './viewSession';

export type ViewKind = ViewerKind;

/** Path of the single reusable document; it has no extension so the tab reads just "ILASM Dotnet". */
const SESSION_PATH = '/ILASM Dotnet';

interface KindInfo {
  /** Suffix appended to the document name; it also drives the default language. */
  suffix: string;
  /** Language the document is switched to for syntax highlighting. */
  languageId: string;
  /** Engine method that produces the content. */
  request: string;
}

const KINDS: Record<ViewKind, KindInfo> = {
  il: { suffix: ' (IL).il', languageId: 'il', request: 'view/il' },
  csharp: { suffix: ' (C#).cs', languageId: 'csharp', request: 'view/csharp' },
  csharpLow: { suffix: ' (C# low level).cs', languageId: 'csharp', request: 'view/csharp' },
  asm: { suffix: ' (ASM).asm', languageId: 'il-asm', request: 'view/asm' },
};

/** Identity of the member or type a viewer instance shows. */
export interface ViewerTarget {
  assembly: string;
  token: number;
  title: string;
  /** True when the target is a whole type, which has IL and C# but no single body to disassemble. */
  isType?: boolean;
}

interface ViewerQuery {
  a: string;
  t: number;
  k?: 't' | 'm';
}

/**
 * Backs the read-only `ilasm-dotnet:` documents. A document URI carries the assembly path and the
 * metadata token in its query, so the same target always maps to the same tab.
 */
export class IlasmDotnetDocuments implements vscode.FileSystemProvider, vscode.Disposable {
  static readonly scheme = 'ilasm-dotnet';

  private readonly views = new Map<string, ViewInfo>();
  private readonly disposables: vscode.Disposable[] = [];

  /** State of the single viewer tab, keyed by its document URI. */
  private readonly sessions = new Map<string, ViewerSession>();

  /** Process the user attached to, when the assembly listing should come from live code. */
  private livePid?: number;

  /** A viewer path can hold characters a URI cannot carry literally, so the objects are kept. */
  private readonly knownUris = new Map<string, vscode.Uri>();

  /** Cache of session views, so switching back to a pane does not recompile its ASM. */
  private readonly sessionViews = new Map<string, ViewInfo>();

  private readonly changeEmitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();

  /**
   * Bumped on every content change. VS Code decides whether a file has to be re-read from the mtime
   * and size it gets from stat, so a constant value makes an announced change look like no change at
   * all and the document keeps the old text.
   */
  private version = 1;

  /** Fired when a viewer document has to be re-read, the way a changed file would be. */
  readonly onDidChangeFile = this.changeEmitter.event;

  constructor(
    private readonly client: EngineClient,
    private readonly includeCompilerGenerated: () => boolean,
    private readonly asmOptimized: () => boolean,
    private readonly asmSource: () => string,
    private readonly nativeRuntimeMethods: () => boolean,
  ) {
    // Registering as a file system rather than a content provider is what makes the documents
    // read only: a viewer must not be editable, and isReadonly is the only switch VS Code offers.
    this.disposables.push(
      vscode.workspace.registerFileSystemProvider(IlasmDotnetDocuments.scheme, this, {
        isReadonly: true,
        isCaseSensitive: true,
      }),
      this.enforceReadOnly(),
    );
  }

  static uriFor(kind: ViewKind, target: ViewerTarget): vscode.Uri {
    return vscode.Uri.from({
      scheme: IlasmDotnetDocuments.scheme,
      path: `/${sanitize(target.title)}${KINDS[kind].suffix}`,
      query: JSON.stringify({
        a: target.assembly,
        t: target.token,
        k: target.isType ? 't' : 'm',
      } satisfies ViewerQuery),
    });
  }

  static isViewerUri(uri: vscode.Uri): boolean {
    return uri.scheme === IlasmDotnetDocuments.scheme;
  }

  /** The one document that is reused for every file, view and member. */
  static sessionUri(): vscode.Uri {
    return vscode.Uri.from({ scheme: IlasmDotnetDocuments.scheme, path: SESSION_PATH });
  }

  /** True for the reusable single tab, false for the per-target documents. */
  isSession(uri: vscode.Uri): boolean {
    return this.sessions.has(uri.toString());
  }

  sessionState(uri: vscode.Uri): ViewerSession | undefined {
    return this.sessions.get(uri.toString());
  }

  /**
   * Points the single tab at another file, view or member. The change is always announced: VS Code
   * caches the text it read for a URI, so without the notification a language switch would keep the
   * previous content. The view itself is cached per state, so the extra read costs nothing.
   */
  async setSessionState(uri: vscode.Uri, session: ViewerSession, options?: { notify?: boolean }): Promise<void> {
    this.sessions.set(uri.toString(), session);
    this.knownUris.set(uri.toString(), uri);
    if (options?.notify ?? true) {
      this.notifyChanged(uri);
    }
  }

  /**
   * Tells VS Code the document content is stale. It has to be called last, because recreating a
   * document (which is what a language switch does) rebuilds it from the cached file content.
   */
  notifyChanged(uri: vscode.Uri): void {
    this.version++;
    this.changeEmitter.fire([{ type: vscode.FileChangeType.Changed, uri }]);
  }

  /**
   * VS Code does not always treat a provided document as read only, so a stray keystroke is undone
   * by announcing the change again: the document is then re-read from the engine. Without this a
   * user could edit a view and be confused by text that no longer matches anything.
   */
  private enforceReadOnly(): vscode.Disposable {
    return vscode.workspace.onDidChangeTextDocument((event) => {
      const uri = event.document.uri;
      if (!this.isViewerDocument(uri) || event.contentChanges.length === 0) {
        return;
      }

      const session = this.sessions.get(uri.toString());
      const served = session ? this.sessionViews.get(cacheKey(session, this.cacheOptions())) : this.views.get(uri.toString());
      if (!served || event.document.getText() === served.text) {
        return;
      }

      this.notifyChanged(uri);
    });
  }

  private isViewerDocument(uri: vscode.Uri): boolean {
    return uri.scheme === IlasmDotnetDocuments.scheme && (this.sessions.has(uri.toString()) || this.views.has(uri.toString()));
  }

  /** Points the assembly views at a live process, or clears it. */
  setLivePid(pid: number | undefined): void {
    if (this.livePid === pid) {
      return;
    }

    this.livePid = pid;
    this.sessionViews.clear();

    const uri = IlasmDotnetDocuments.sessionUri();
    if (this.sessions.has(uri.toString())) {
      this.notifyChanged(uri);
    }
  }

  /** Whether compiler generated members should be listed as well; the low-level view always does. */
  get includeGenerated(): boolean {
    return this.includeCompilerGenerated();
  }

  /** Whether the methods of the runtime of a native image are listed with the application's own. */
  get nativeIncludeRuntime(): boolean {
    return this.nativeRuntimeMethods();
  }

  /** Everything a cached view depends on besides the session itself. */
  private cacheOptions(): CacheKeyOptions {
    return {
      live: this.livePid !== undefined,
      asmSource: this.asmSource(),
      includeCompilerGenerated: this.includeCompilerGenerated(),
      optimized: this.asmOptimized(),
      nativeIncludeRuntime: this.nativeRuntimeMethods(),
    };
  }

  get attachedPid(): number | undefined {
    return this.livePid;
  }

  /** Reads the view the single tab should currently show. */
  async sessionView(session: ViewerSession): Promise<ViewInfo> {
    const key = cacheKey(session, this.cacheOptions());
    const cached = this.sessionViews.get(key);
    if (cached) {
      return cached;
    }

    const request = requestFor(session, {
      includeCompilerGenerated: this.includeCompilerGenerated(),
      optimized: this.asmOptimized(),
      asmSource: this.asmSource(),
      live: this.livePid !== undefined,
      nativeIncludeRuntime: this.nativeRuntimeMethods(),
    });

    const view = await this.read(request, session);
    this.sessionViews.set(key, view);
    this.views.set(IlasmDotnetDocuments.sessionUri().toString(), view);
    return view;
  }

  /**
   * Asks the engine for a view, and turns a failure into a view that says what went wrong. A read
   * that throws leaves the previous text on screen, which looks exactly like a switch that did
   * nothing — that is how a view that cannot be produced goes unnoticed.
   */
  private async read(request: EngineRequest, session: ViewerSession): Promise<ViewInfo> {
    try {
      return await this.client.call<ViewInfo>(request.method, request.params);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      Log.error(`${request.method} failed`, error);
      return {
        title: session.kind,
        language: languageFor(session.kind),
        text: `; ILASM Dotnet could not read this view.\n; ${message}\n`,
        hasDebugInfo: false,
        blocks: [],
      };
    }
  }

  /**
   * View a document shows. The single tab reports whatever it is currently pointed at, which is why
   * this needs the instance rather than only the URI.
   */
  kindOf(uri: vscode.Uri): ViewKind | undefined {
    const session = this.sessions.get(uri.toString());
    if (session) {
      return session.kind;
    }

    return IlasmDotnetDocuments.kindFromPath(uri);
  }

  private static kindFromPath(uri: vscode.Uri): ViewKind | undefined {
    if (!IlasmDotnetDocuments.isViewerUri(uri)) {
      return undefined;
    }

    for (const [kind, info] of Object.entries(KINDS) as [ViewKind, KindInfo][]) {
      if (uri.path.endsWith(info.suffix)) {
        return kind;
      }
    }

    return undefined;
  }

  static targetOf(uri: vscode.Uri): ViewerTarget | undefined {
    const query = IlasmDotnetDocuments.parseQuery(uri);
    if (!query) {
      return undefined;
    }

    const title = uri.path.replace(/^\//, '').replace(/ \((IL|C#|ASM)\)\.\w+$/, '');
    return {
      assembly: query.a,
      token: query.t,
      title: decodeURIComponent(title),
      isType: query.k === 't',
    };
  }

  private static parseQuery(uri: vscode.Uri): ViewerQuery | undefined {
    try {
      const parsed = JSON.parse(uri.query) as ViewerQuery;
      return typeof parsed?.a === 'string' && typeof parsed?.t === 'number' ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  // ── FileSystemProvider ────────────────────────────────────────────────────────────────────────

  /** Everything is read only, so a stat is enough to describe the document. */
  stat(): vscode.FileStat {
    return {
      type: vscode.FileType.File,
      ctime: 0,
      mtime: this.version,
      size: this.version,
      permissions: vscode.FilePermission.Readonly,
    };
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const session = this.sessions.get(uri.toString());
    const text = session
      ? (await this.sessionView(session)).text
      : (await this.load(uri)).text;

    return new TextEncoder().encode(text);
  }

  /** The viewer holds no directory structure; listing is only ever asked for by accident. */
  readDirectory(): [string, vscode.FileType][] {
    return [];
  }

  watch(): vscode.Disposable {
    // Changes are announced explicitly through onDidChangeFile.
    return new vscode.Disposable(() => undefined);
  }

  writeFile(): void {
    throw vscode.FileSystemError.NoPermissions('The ILASM Dotnet is read only.');
  }

  delete(): void {
    throw vscode.FileSystemError.NoPermissions('The ILASM Dotnet is read only.');
  }

  rename(): void {
    throw vscode.FileSystemError.NoPermissions('The ILASM Dotnet is read only.');
  }

  createDirectory(): void {
    throw vscode.FileSystemError.NoPermissions('The ILASM Dotnet is read only.');
  }

  /** Switches the document language, which is what selects the syntax highlighting. */
  async applySessionLanguage(document: vscode.TextDocument, kind: ViewerKind): Promise<vscode.TextDocument> {
    const expected = languageFor(kind);
    if (document.languageId === expected) {
      return document;
    }

    try {
      return await vscode.languages.setTextDocumentLanguage(document, expected);
    } catch {
      // Leave the language alone if VS Code refuses; the text is still correct.
      return document;
    }
  }

  /** Loads (and caches) the view for a URI, fetching it from the engine when needed. */
  async load(uri: vscode.Uri): Promise<ViewInfo> {
    const key = uri.toString();
    const cached = this.views.get(key);
    if (cached) {
      return cached;
    }

    const kind = this.kindOf(uri);
    const target = IlasmDotnetDocuments.targetOf(uri);
    if (!kind || !target) {
      throw new Error(`Unsupported ILASM Dotnet document: ${uri.toString()}`);
    }

    this.knownUris.set(key, uri);

    // Assembly panes prefer the live route when a process is attached, because only that route
    // reports an IL offset for every instruction.
    const request = kind === 'asm' && this.livePid !== undefined ? 'view/asmLive' : KINDS[kind].request;
    const view = await this.client.call<ViewInfo>(request, {
      path: target.assembly,
      token: target.token,
      includeCompilerGenerated: this.includeCompilerGenerated(),
      optimized: this.asmOptimized(),
      source: this.asmSource(),
    });

    this.views.set(key, view);
    return view;
  }

  /** Opens the document, assigning the language that drives syntax highlighting. */
  async open(kind: ViewKind, target: ViewerTarget, options?: { viewColumn?: vscode.ViewColumn; preserveFocus?: boolean }): Promise<vscode.TextEditor> {
    const uri = IlasmDotnetDocuments.uriFor(kind, target);
    await this.load(uri);

    // Changing the language replaces the document instance, so the returned one has to be used.
    const opened = await vscode.workspace.openTextDocument(uri);
    const document = await this.applyLanguage(opened, kind);

    // A document that is already on screen stays in its own column; otherwise it goes where the
    // caller asked, which for the viewer means beside the source rather than on top of it.
    const existing = findVisibleEditor(uri);

    return vscode.window.showTextDocument(document, {
      viewColumn: existing?.viewColumn ?? options?.viewColumn ?? vscode.ViewColumn.Active,
      preserveFocus: options?.preserveFocus ?? false,
      preview: false,
    });
  }

  private async applyLanguage(document: vscode.TextDocument, kind: ViewKind): Promise<vscode.TextDocument> {
    const expected = KINDS[kind].languageId;
    if (document.languageId === expected) {
      return document;
    }

    try {
      return await vscode.languages.setTextDocumentLanguage(document, expected);
    } catch {
      // The file extension already selects a sensible language; ignore when we are too late.
      return document;
    }
  }

  getCached(uri: vscode.Uri): ViewInfo | undefined {
    return this.views.get(uri.toString());
  }

  /** Drops cached views, forcing the next open to ask the engine again. */
  invalidate(): void {
    // The documents this provider serves are exactly the ones it knows, so the panes that have to be
    // read again come from its own bookkeeping rather than from the workspace, which may not have
    // reported them yet. Their URIs are kept as objects: a viewer path can hold "#" or "(", which a
    // URI string cannot be split back into reliably.
    const uris = [...new Set([...this.sessions.keys(), ...this.views.keys()])]
      .map((key) => this.knownUris.get(key))
      .filter((uri): uri is vscode.Uri => uri !== undefined);

    this.views.clear();
    this.sessionViews.clear();

    for (const uri of uris) {
      this.notifyChanged(uri);
    }
  }

  dispose(): void {
    this.changeEmitter.dispose();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }
}

function sanitize(title: string): string {
  return title.replace(/[\\/:*?"<>|]/g, '_');
}

/** Finds an already visible editor showing the given document URI. */
export function findVisibleEditor(uri: vscode.Uri): vscode.TextEditor | undefined {
  const key = uri.toString();
  return vscode.window.visibleTextEditors.find((editor) => editor.document.uri.toString() === key);
}

/**
 * Column a viewer tab goes into when it is not open yet: next to whatever is on screen, and into the
 * only group when nothing is. Asking for "beside" with no editor open splits the window and leaves
 * an empty group behind, which reads as a bug rather than as a layout.
 */
export function besideColumn(): vscode.ViewColumn {
  return vscode.window.visibleTextEditors.length > 0 ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active;
}
