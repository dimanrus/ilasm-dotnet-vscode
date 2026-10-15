'use strict';
// Minimal in-memory stand-in for the VS Code API, deep enough to exercise the extension end to end
// (commands, content providers, document links, selection synchronisation, tree view) without a GUI.
const fs = require('node:fs');
const path = require('node:path');

/** The components a uri is rebuilt from, narrowed to the parts the stub keeps. */
interface FakeUriComponents {
  readonly scheme: string;
  readonly path: string;
  readonly query?: string;
  readonly fragment?: string;
}

interface FakeUriChange {
  readonly scheme?: string;
  readonly path?: string;
  readonly query?: string;
  readonly fragment?: string;
}

/** A command handler, as the stub calls it back when a command is executed. */
type CommandHandler = (...args: unknown[]) => unknown;

/** The `{ content, language }` bag a command passes to have the host build an untitled document. */
interface UntitledDocumentOptions extends Uri {
  readonly content: string;
  readonly language?: string;
}

interface FakeDocument {
  readonly uri: Uri;
  languageId: string;
  readonly fileName: string;
  readonly lineCount: number;
  getText(): string;
  lineAt(index: number): { readonly text: string };
  _setText(next: string): void;
}

/** The builder a callback receives from `FakeEditor.edit`, as the host hands it a real one. */
interface FakeEditorEdit {
  insert(position: Position, text: string): void;
  replace(location: Range, value: string): void;
  delete(location: Range): void;
}

/** The decoration options the viewer passes, narrowed to the fields the stub keeps. */
interface DecorationOptions {
  readonly isWholeLine?: boolean;
  readonly backgroundColor?: ThemeColor | string;
  readonly borderColor?: ThemeColor | string;
  readonly borderStyle?: string;
  readonly borderWidth?: string;
  readonly overviewRulerColor?: ThemeColor | string;
  readonly overviewRulerLane?: number;
}

interface DecorationType {
  readonly options: DecorationOptions;
  dispose(): void;
}

/** A command a tree item or a code lens hangs on its node. */
interface FakeCommand {
  readonly title: string;
  readonly command: string;
  readonly arguments: readonly unknown[];
}

/** A caret as the editor hands it out: the suite places one, so the other ends are optional. */
interface FakeTextEditorSelection {
  active: Position;
  readonly start?: Position;
  readonly end?: Position;
  readonly anchor?: Position;
}

/** An editor as the stub hands it out, with the decoration and reveal hooks the suite drives. */
interface FakeEditor {
  readonly document: FakeDocument;
  viewColumn: number;
  selection: FakeTextEditorSelection;
  readonly revealed: Range[];
  readonly decorations: Map<DecorationType, readonly Range[]>;
  setDecorations(type: DecorationType, ranges: readonly Range[]): void;
  revealRange(range: Range): void;
  edit(callback: (edit: FakeEditorEdit) => void): Promise<boolean>;
}

interface FakeShowDocumentOptions {
  readonly viewColumn?: number;
  readonly preview?: boolean;
  readonly preserveFocus?: boolean;
}

interface FakeStatusBarItem {
  text: string;
  tooltip: string;
  command: string;
  visible: boolean;
  show(): void;
  hide(): void;
  dispose(): void;
}

interface FakeOutputChannel {
  readonly name: string;
  readonly lines: string[];
  appendLine(line: string): void;
  /** Log channel levels: the real API carries the severity of every line. */
  trace(line: string): void;
  debug(line: string): void;
  info(line: string): void;
  warn(line: string): void;
  error(line: string): void;
  show(): void;
  dispose(): void;
}

/** The provider the assemblies view registers: stored as is, so its nodes stay opaque. */
interface FakeTreeDataProvider {
  onDidChangeTreeData(listener: () => void): Disposable;
  getChildren(element?: unknown): readonly unknown[] | Promise<readonly unknown[]>;
  getTreeItem(element: unknown): TreeItem;
}

interface FakeTreeView {
  readonly id: string;
  readonly treeDataProvider: FakeTreeDataProvider;
  dispose(): void;
}

interface FakeTreeViewOptions {
  readonly treeDataProvider: FakeTreeDataProvider;
  readonly showCollapseAll?: boolean;
}

/** The event the stub hands to a selection listener when the suite moves a caret. */
interface SelectionChangeEvent {
  readonly textEditor: FakeEditor;
  readonly selections?: readonly Selection[];
}

interface ConfigurationChangeEvent {
  affectsConfiguration(section: string): boolean;
}

type ActiveEditorListener = (editor: FakeEditor | undefined) => void;
type DocumentListener = (document: FakeDocument) => void;
type ConfigurationChangeListener = (event: ConfigurationChangeEvent) => void;

interface FakeConfiguration {
  get(key: string, fallback?: unknown): unknown;
  update(): Promise<void>;
}

interface FakeWorkspaceFolder {
  readonly uri: Uri;
  readonly name: string;
  readonly index: number;
}

interface FileChangeEvent {
  readonly uri: Uri;
}

/** A file system as the extension registers it, narrowed to the members the stub calls. */
interface FakeFileSystemProvider {
  readFile(uri: Uri): Uint8Array | Promise<Uint8Array>;
  onDidChangeFile?(listener: (events: readonly FileChangeEvent[]) => unknown): Disposable;
}

interface FakeFileSystemProviderOptions {
  readonly isReadonly?: boolean;
  readonly isCaseSensitive?: boolean;
}

/** A content provider as the extension registers it, narrowed to the members the stub calls. */
interface FakeTextDocumentContentProvider {
  provideTextDocumentContent(uri: Uri): string | undefined | Promise<string | undefined>;
  onDidChange?(listener: (uri: Uri) => unknown): Disposable;
}

interface FakeDocumentSelector {
  readonly scheme: string;
  readonly language?: string;
}

interface FakeDocumentLinkProvider {
  provideDocumentLinks(document: FakeDocument): readonly DocumentLink[] | undefined;
}

interface FakeCodeLensProvider {
  provideCodeLenses(document: FakeDocument): readonly CodeLens[] | undefined;
}

interface FakeCodeLensRegistration {
  readonly selector: FakeDocumentSelector;
  readonly provider: FakeCodeLensProvider;
}

/** A picker entry as the extension builds it, including the process id the live picker adds. */
interface QuickPickEntry {
  readonly label: string;
  readonly description?: string;
  readonly detail?: string;
  readonly pid?: number;
}

type QuickPickResponder = (items: QuickPickEntry[], options: unknown) => unknown;
type FindFilesHook = (
  pattern?: string | RelativePattern,
  exclude?: string | null,
  maxResults?: number,
) => unknown;

interface FakeProgressOptions {
  readonly location?: number;
  readonly title: string;
}

interface FakeProgress {
  report(value?: { readonly message?: string; readonly increment?: number }): void;
}

interface FakeCancellationToken {
  readonly isCancellationRequested: boolean;
  onCancellationRequested(listener: () => void): Disposable;
}

interface FakeWebview {
  html: string;
  readonly posted: unknown[];
  onDidReceiveMessage(listener: (message: unknown) => unknown): Disposable;
  postMessage(message: unknown): Promise<boolean>;
}

interface FakeWebviewPanel {
  readonly viewType: string;
  title: string;
  readonly viewColumn: number;
  readonly options: unknown;
  visible: boolean;
  readonly webview: FakeWebview;
  reveal(): void;
  onDidDispose(listener: () => void): Disposable;
  readonly _listeners: readonly ((message: unknown) => unknown)[];
  dispose(): void;
}

interface FakeErrorWithCode extends Error {
  code?: string;
}

/** The in-memory state the suite drives and reads back after it exercises the extension. */
interface StubState {
  readonly commands: Map<string, CommandHandler>;
  readonly contentProviders: Map<string, FakeTextDocumentContentProvider>;
  readonly linkProviders: Map<string, FakeDocumentLinkProvider>;
  readonly documents: Map<string, FakeDocument>;
  readonly editors: FakeEditor[];
  activeEditor: FakeEditor | undefined;
  readonly config: Record<string, unknown>;
  readonly invokedCommands: string[];
  readonly statusBarMessages: string[];
  readonly informationMessages: string[];
  readonly warningMessages: string[];
  readonly errorMessages: string[];
  errorMessageResult: unknown;
  readonly statusBarItems: FakeStatusBarItem[];
  readonly webviewPanels: FakeWebviewPanel[];
  readonly progressTitles: string[];
  readonly codeLensProviders: FakeCodeLensRegistration[];
  readonly contentChangeSubscriptions: Disposable[];
  readonly fileSystemProviders: Map<string, FakeFileSystemProvider>;
  readonly readOnlySchemes: Set<string>;
  readonly selectionListeners: ((event: SelectionChangeEvent) => void)[];
  readonly saveListeners: DocumentListener[];
  readonly configListeners: ConfigurationChangeListener[];
  readonly textChangeListeners: DocumentListener[];
  readonly textChangeSubscriptions: DocumentListener[];
  readonly activeEditorListeners: ActiveEditorListener[];
  readonly treeProviders: Map<string, FakeTreeView>;
  clipboard: string;
  quickPickResult: QuickPickResponder | undefined;
  openDialogResult: unknown;
  findFiles: FindFilesHook;
  workspaceFolders: FakeWorkspaceFolder[];
  untitledCount?: number;
}

const state: StubState = {
  commands: new Map(),
  contentProviders: new Map(),
  linkProviders: new Map(),
  documents: new Map(),
  editors: [],
  activeEditor: undefined,
  config: {},
  invokedCommands: [],
  statusBarMessages: [],
  informationMessages: [],
  warningMessages: [],
  errorMessages: [],
  errorMessageResult: undefined,
  statusBarItems: [],
  webviewPanels: [],
  progressTitles: [],
  codeLensProviders: [],
  contentChangeSubscriptions: [],
  fileSystemProviders: new Map(),
  readOnlySchemes: new Set(),
  selectionListeners: [],
  saveListeners: [],
  configListeners: [],
  textChangeListeners: [],
  textChangeSubscriptions: [],
  activeEditorListeners: [],
  treeProviders: new Map(),
  clipboard: '',
  quickPickResult: undefined,
  openDialogResult: undefined,
  findFiles: () => Promise.resolve([]),
  workspaceFolders: [],
};

class Uri {
  declare scheme: string;
  declare fsPath: string;
  declare path: string;
  declare query: string;
  declare fragment: string;

  constructor(scheme: string, fsPath: string, query = '', fragment = '') {
    this.scheme = scheme;
    this.fsPath = fsPath;
    this.path = fsPath;
    this.query = query;
    this.fragment = fragment;
  }

  static file(fsPath: string): Uri {
    return new Uri('file', fsPath);
  }

  static from(components: FakeUriComponents): Uri {
    return new Uri(components.scheme, components.path, components.query ?? '', components.fragment ?? '');
  }

  with(changes: FakeUriChange): Uri {
    return new Uri(
      changes.scheme ?? this.scheme,
      changes.path ?? this.path,
      changes.query ?? this.query,
      changes.fragment ?? this.fragment,
    );
  }

  toString(): string {
    return `${this.scheme}:${this.path}${this.query ? `?${this.query}` : ''}${this.fragment ? `#${this.fragment}` : ''}`;
  }
}

class Position {
  declare line: number;
  declare character: number;

  constructor(line: number, character: number) {
    this.line = line;
    this.character = character;
  }
}

class Range {
  declare start: Position;
  declare end: Position;

  constructor(
    startLine: number | Position,
    startCharacter: number | undefined,
    endLine: number | Position,
    endCharacter: number | undefined,
  ) {
    this.start = startLine instanceof Position ? startLine : new Position(startLine, startCharacter ?? 0);
    this.end = endLine instanceof Position ? endLine : new Position(endLine, endCharacter ?? 0);
  }
}

class Selection extends Range {
  declare anchor: Position;
  declare active: Position;

  // The real API takes either two positions or four numbers, and a selection carries both ends.
  constructor(
    anchorLineOrPosition: number | Position,
    anchorCharacterOrPosition: number | undefined,
    activeLine: number | Position | undefined,
    activeCharacter: number | undefined,
  ) {
    super(anchorLineOrPosition, anchorCharacterOrPosition, activeLine ?? anchorLineOrPosition, activeCharacter);
    const anchor =
      anchorLineOrPosition instanceof Position
        ? anchorLineOrPosition
        : new Position(anchorLineOrPosition, anchorCharacterOrPosition ?? 0);
    this.anchor = anchor;
    this.active = activeLine instanceof Position ? activeLine : new Position(this.end.line, this.end.character);
  }
}

class RelativePattern {
  declare base: string;
  declare pattern: string;

  constructor(base: string | Uri, pattern: string) {
    this.base = typeof base === 'string' ? base : base.fsPath;
    this.pattern = pattern;
  }
}

class Disposable {
  declare action?: () => void;

  constructor(action?: () => void) {
    this.action = action;
  }

  dispose() {
    this.action?.();
  }
}

class EventEmitter {
  declare listeners: Set<(value: unknown) => void>;
  declare event: (listener: (value: unknown) => void) => Disposable;

  constructor() {
    this.listeners = new Set();
    this.event = (listener) => {
      this.listeners.add(listener);
      return new Disposable(() => this.listeners.delete(listener));
    };
  }

  fire(value: unknown) {
    for (const listener of this.listeners) {
      listener(value);
    }
  }

  dispose() {
    this.listeners.clear();
  }
}

class ThemeIcon {
  declare id: string;

  constructor(id: string) {
    this.id = id;
  }
}

class ThemeColor {
  declare id: string;

  constructor(id: string) {
    this.id = id;
  }
}

class MarkdownString {
  declare value: string;

  constructor(value = '') {
    this.value = value;
  }
}

class TreeItem {
  declare label: string;
  declare collapsibleState: number | undefined;
  // A node the tree hands back carries the command that opens it, which is what the suite reads.
  declare command: FakeCommand;
  declare id?: string;
  declare description?: string | boolean;
  declare tooltip?: string | MarkdownString;
  declare contextValue?: string;
  declare iconPath?: ThemeIcon;

  constructor(label: string, collapsibleState: number | undefined) {
    this.label = label;
    this.collapsibleState = collapsibleState;
  }
}

class CodeLens {
  declare range: Range;
  declare command: FakeCommand | undefined;

  constructor(range: Range, command?: FakeCommand) {
    this.range = range;
    this.command = command;
  }
}

class DocumentLink {
  declare range: Range;
  declare target: Uri;
  declare tooltip?: string;

  constructor(range: Range, target: Uri) {
    this.range = range;
    this.target = target;
  }
}

function languageFor(fsPath: string): string {
  const extension = path.extname(fsPath).toLowerCase();
  if (extension === '.il') {
    return 'il';
  }

  if (extension === '.cs') {
    return 'csharp';
  }

  return 'plaintext';
}

/** True for the `{ content, language }` bag a command passes to build an untitled document. */
function isUntitledDocument(
  argument: string | Uri | UntitledDocumentOptions,
): argument is UntitledDocumentOptions {
  return (
    typeof argument === 'object' &&
    'content' in argument &&
    typeof argument.content === 'string' &&
    !('scheme' in argument && typeof argument.scheme === 'string')
  );
}

function createDocument(uri: Uri, text: string): FakeDocument {
  let current = text;
  let lines = current.split('\n');

  return {
    uri,
    languageId: languageFor(uri.path),
    fileName: uri.path,
    get lineCount() {
      return lines.length;
    },
    getText: () => current,
    lineAt: (index) => ({ text: lines[index] ?? '' }),
    /** Test hook: the host rewrites a provided document when its provider reports a change. */
    _setText(next) {
      current = next;
      lines = next.split('\n');
    },
  };
}

function createEditor(document: FakeDocument, options: FakeShowDocumentOptions = {}): FakeEditor {
  const decorationTypes: DecorationType[] = [];
  const editor: FakeEditor = {
    document,
    viewColumn: options.viewColumn ?? 1,
    selection: new Selection(0, 0, 0, 0),
    revealed: [],
    decorations: new Map(),
    setDecorations(type, ranges) {
      this.decorations.set(type, ranges);
      if (!decorationTypes.includes(type)) {
        decorationTypes.push(type);
      }
    },
    revealRange(range) {
      this.revealed.push(range);
    },
    async edit(callback) {
      if (state.readOnlySchemes.has(this.document.uri.scheme)) {
        return false;
      }

      callback({
        insert: (position, text) => {
          const lines = this.document.getText().split('\n');
          lines[position.line] = lines[position.line].slice(0, position.character) + text + lines[position.line].slice(position.character);
          this.document._setText(lines.join('\n'));
        },
        replace: () => undefined,
        delete: () => undefined,
      });

      return true;
    },
  };

  state.editors.push(editor);
  state.activeEditor = editor;
  return editor;
}

const window = {
  get activeTextEditor(): FakeEditor | undefined {
    return state.activeEditor;
  },
  get visibleTextEditors(): FakeEditor[] {
    return state.editors;
  },
  createTextEditorDecorationType(options: DecorationOptions): DecorationType {
    return { options, dispose() {} };
  },
  createStatusBarItem(): FakeStatusBarItem {
    const item: FakeStatusBarItem = {
      text: '',
      tooltip: '',
      command: '',
      visible: false,
      show() {
        this.visible = true;
      },
      hide() {
        this.visible = false;
      },
      dispose() {},
    };

    state.statusBarItems.push(item);
    return item;
  },
  createOutputChannel(name: string, _options?: { log?: boolean }): FakeOutputChannel {
    const lines: string[] = [];
    const append = (line: string): void => {
      lines.push(line);
    };

    return {
      name,
      lines,
      appendLine: append,
      // A log channel records the level of every line; the stub keeps the text and drops the level,
      // which is what the tests inspect.
      trace: append,
      debug: append,
      info: append,
      warn: append,
      error: append,
      show() {},
      dispose() {},
    };
  },
  createTreeView(id: string, options: FakeTreeViewOptions): FakeTreeView {
    const view: FakeTreeView = { id, treeDataProvider: options.treeDataProvider, dispose() {} };
    state.treeProviders.set(id, view);
    return view;
  },
  onDidChangeTextEditorSelection(listener: (event: SelectionChangeEvent) => void): Disposable {
    state.selectionListeners.push(listener);
    return new Disposable(() => {
      const index = state.selectionListeners.indexOf(listener);
      if (index >= 0) {
        state.selectionListeners.splice(index, 1);
      }
    });
  },
  onDidChangeActiveTextEditor(listener: ActiveEditorListener): Disposable {
    state.activeEditorListeners.push(listener);
    return new Disposable();
  },
  async withProgress(
    options: FakeProgressOptions | string,
    task: (progress: FakeProgress, token: FakeCancellationToken) => unknown,
  ) {
    state.progressTitles.push(typeof options === 'object' ? options.title : String(options));
    return task({ report() {} }, { isCancellationRequested: false, onCancellationRequested() { return new Disposable(); } });
  },

  createWebviewPanel(
    viewType: string,
    title: string,
    column: number,
    options: unknown,
  ): FakeWebviewPanel {
    const messageListeners: ((message: unknown) => unknown)[] = [];
    const disposeListeners: (() => void)[] = [];
    const panel: FakeWebviewPanel = {
      viewType,
      title,
      viewColumn: column,
      options,
      visible: true,
      webview: {
        html: '',
        posted: [],
        onDidReceiveMessage(listener) {
          messageListeners.push(listener);
          return new Disposable(() => {
            const index = messageListeners.indexOf(listener);
            if (index >= 0) {
              messageListeners.splice(index, 1);
            }
          });
        },
        postMessage(message) {
          this.posted.push(message);
          return Promise.resolve(true);
        },
      },
      reveal() {
        this.visible = true;
      },
      onDidDispose(listener) {
        disposeListeners.push(listener);
        return new Disposable();
      },
      /** Test hook: the listeners the extension registered for webview messages. */
      _listeners: messageListeners,
      dispose() {
        this.visible = false;
        for (const listener of disposeListeners) {
          listener();
        }
      },
    };

    state.webviewPanels.push(panel);
    return panel;
  },

  async showTextDocument(document: FakeDocument, options: FakeShowDocumentOptions = {}) {
    const existing = state.editors.find((editor) => editor.document.uri.toString() === document.uri.toString());
    if (existing) {
      state.activeEditor = existing;
      return existing;
    }

    return createEditor(document, options);
  },
  setStatusBarMessage(message: string): Disposable {
    state.statusBarMessages.push(message);
    return new Disposable();
  },
  async showInformationMessage(message: string) {
    state.informationMessages.push(message);
  },
  async showWarningMessage(message: string) {
    state.warningMessages.push(message);
  },
  async showErrorMessage(message: string) {
    state.errorMessages.push(message);
    return state.errorMessageResult;
  },
  async showQuickPick(
    itemsOrPromise: QuickPickEntry[] | Promise<QuickPickEntry[]>,
    options: unknown,
  ) {
    const items = await itemsOrPromise;
    if (typeof state.quickPickResult === 'function') {
      return state.quickPickResult(items, options);
    }

    return state.quickPickResult;
  },
  async showOpenDialog() {
    return state.openDialogResult;
  },
};

const workspace = {
  get workspaceFolders(): FakeWorkspaceFolder[] {
    return state.workspaceFolders;
  },
  getConfiguration(section: string): FakeConfiguration {
    return {
      get(key, fallback) {
        const value = state.config[`${section}.${key}`];
        return value === undefined ? fallback : value;
      },
      update() {
        return Promise.resolve();
      },
    };
  },
  async openTextDocument(argument: string | Uri | UntitledDocumentOptions) {
    // An untitled document is described by its content, the way a command that reports something uses it.
    if (isUntitledDocument(argument)) {
      state.untitledCount = (state.untitledCount ?? 0) + 1;
      const untitled = new Uri('untitled', `/Untitled-${state.untitledCount}`);
      const created = createDocument(untitled, argument.content);
      if (typeof argument.language === 'string') {
        created.languageId = argument.language;
      }

      state.documents.set(untitled.toString(), created);
      return created;
    }

    const uri = typeof argument === 'string' ? Uri.file(argument) : argument;
    const key = uri.toString();
    if (state.documents.has(key)) {
      return state.documents.get(key);
    }

    const fileSystem = state.fileSystemProviders.get(uri.scheme);
    const provider = state.contentProviders.get(uri.scheme);
    const text = fileSystem
      ? Buffer.from(await fileSystem.readFile(uri)).toString('utf8')
      : provider
        ? await provider.provideTextDocumentContent(uri)
        : uri.scheme === 'file' && fs.existsSync(uri.fsPath)
          ? fs.readFileSync(uri.fsPath, 'utf8')
          : '';
    const document = createDocument(uri, text);
    state.documents.set(key, document);
    return document;
  },
  onDidChangeTextDocument(listener: DocumentListener): Disposable {
    state.textChangeListeners.push(listener);
    state.textChangeSubscriptions.push(listener);
    return new Disposable(() => {
      const index = state.textChangeListeners.indexOf(listener);
      if (index >= 0) {
        state.textChangeListeners.splice(index, 1);
      }
    });
  },
  onDidSaveTextDocument(listener: DocumentListener): Disposable {
    state.saveListeners.push(listener);
    return new Disposable(() => {
      const index = state.saveListeners.indexOf(listener);
      if (index >= 0) {
        state.saveListeners.splice(index, 1);
      }
    });
  },
  onDidChangeConfiguration(listener: ConfigurationChangeListener): Disposable {
    state.configListeners.push(listener);
    return new Disposable(() => {
      const index = state.configListeners.indexOf(listener);
      if (index >= 0) {
        state.configListeners.splice(index, 1);
      }
    });
  },
  registerFileSystemProvider(
    scheme: string,
    provider: FakeFileSystemProvider,
    options: FakeFileSystemProviderOptions = {},
  ): Disposable {
    state.fileSystemProviders.set(scheme, provider);
    if (options.isReadonly) {
      state.readOnlySchemes.add(scheme);
    }

    // A real host re-reads a document when its file system reports a change.
    if (typeof provider.onDidChangeFile === 'function') {
      state.contentChangeSubscriptions.push(
        provider.onDidChangeFile(async (events) => {
          for (const change of events) {
            const document = state.documents.get(change.uri.toString());
            if (!document) {
              continue;
            }

            const bytes = await provider.readFile(change.uri);
            document._setText(Buffer.from(bytes).toString('utf8'));
          }
        }),
      );
    }

    return new Disposable(() => state.fileSystemProviders.delete(scheme));
  },
  registerTextDocumentContentProvider(
    scheme: string,
    provider: FakeTextDocumentContentProvider,
  ): Disposable {
    state.contentProviders.set(scheme, provider);

    // A real host reloads the document when a provider reports a change, so mirror that here:
    // otherwise switching the view or the scope would look like it did nothing.
    if (typeof provider.onDidChange === 'function') {
      state.contentChangeSubscriptions.push(
        provider.onDidChange(async (uri) => {
          const document = state.documents.get(uri.toString());
          if (!document) {
            return;
          }

          const text = await provider.provideTextDocumentContent(uri);
          if (typeof text === 'string') {
            document._setText(text);
          }
        }),
      );
    }

    return new Disposable(() => state.contentProviders.delete(scheme));
  },
  findFiles(pattern?: string | RelativePattern, exclude?: string | null, maxResults?: number) {
    return Promise.resolve(state.findFiles(pattern, exclude, maxResults));
  },
  getWorkspaceFolder(uri: Uri): FakeWorkspaceFolder | undefined {
    const folder = state.workspaceFolders.find((candidate) => uri.fsPath.startsWith(candidate.uri.fsPath));
    return folder;
  },
};

const commands = {
  registerCommand(id: string, handler: CommandHandler): Disposable {
    state.commands.set(id, handler);
    return new Disposable(() => state.commands.delete(id));
  },
  async executeCommand(id: string, ...args: unknown[]) {
    state.invokedCommands.push(id);
    const handler = state.commands.get(id);
    if (handler) {
      return handler(...args);
    }

    return undefined;
  },
};

const languages = {
  async setTextDocumentLanguage(document: FakeDocument, languageId: string) {
    document.languageId = languageId;

    // A real host recreates the document when its language changes, which asks the content provider
    // again. Mirror that, otherwise a view switch would only repaint the same text.
    const provider = state.contentProviders.get(document.uri.scheme);
    if (provider) {
      const text = await provider.provideTextDocumentContent(document.uri);
      if (typeof text === 'string') {
        document._setText(text);
      }
    }

    return document;
  },
  registerDocumentLinkProvider(
    selector: FakeDocumentSelector,
    provider: FakeDocumentLinkProvider,
  ): Disposable {
    state.linkProviders.set(selector.scheme, provider);
    return new Disposable(() => state.linkProviders.delete(selector.scheme));
  },
  registerCodeLensProvider(
    selector: FakeDocumentSelector,
    provider: FakeCodeLensProvider,
  ): Disposable {
    state.codeLensProviders.push({ selector, provider });
    return new Disposable(() => {
      // A registration is stored, not the provider itself, so this lookup only ever misses.
      const index = state.codeLensProviders.indexOf({ selector, provider });
      if (index >= 0) {
        state.codeLensProviders.splice(index, 1);
      }
    });
  },
};

/**
 * Delivers a message from the webview to the extension, the way the real host does when a user
 * changes a dropdown or clicks a line.
 */
async function sendWebviewMessage(panel: FakeWebviewPanel | undefined, message: unknown) {
  const listeners = panel && panel._listeners ? panel._listeners : [];
  for (const listener of listeners) {
    await listener(message);
  }
}

module.exports = {
  state,
  sendWebviewMessage,
  CodeLens,
  Uri,
  Position,
  Range,
  Selection,
  RelativePattern,
  Disposable,
  EventEmitter,
  ThemeIcon,
  ThemeColor,
  MarkdownString,
  TreeItem,
  DocumentLink,
  window,
  workspace,
  commands,
  languages,
  env: {
    clipboard: {
      async writeText(text: string) {
        state.clipboard = text;
      },
    },
  },
  ViewColumn: { Active: -1, Beside: -2, One: 1 },
  StatusBarAlignment: { Left: 1, Right: 2 },
  ProgressLocation: { SourceControl: 1, Window: 10, Notification: 15 },
  OverviewRulerLane: { Left: 1, Center: 2, Right: 4, Full: 7 },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  FileType: { Unknown: 0, File: 1, Directory: 2 },
  FileChangeType: { Changed: 1, Created: 2, Deleted: 3 },
  FilePermission: { Readonly: 1 },
  FileSystemError: {
    NoPermissions(message: string) {
      const error: FakeErrorWithCode = new Error(message);
      error.code = 'NoPermissions';
      return error;
    },
  },
  QuickPickItemKind: { Separator: -1, Default: 0 },
  TextEditorRevealType: { Default: 0, InCenter: 1, InCenterIfOutsideViewport: 2, AtTop: 3 },
};
