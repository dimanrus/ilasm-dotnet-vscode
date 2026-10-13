'use strict';
// Minimal in-memory stand-in for the VS Code API, deep enough to exercise the extension end to end
// (commands, content providers, document links, selection synchronisation, tree view) without a GUI.
const fs = require('node:fs');
const path = require('node:path');

const state = {
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
  constructor(scheme, fsPath, query = '', fragment = '') {
    this.scheme = scheme;
    this.fsPath = fsPath;
    this.path = fsPath;
    this.query = query;
    this.fragment = fragment;
  }

  static file(fsPath) {
    return new Uri('file', fsPath);
  }

  static from(components) {
    return new Uri(components.scheme, components.path, components.query ?? '', components.fragment ?? '');
  }

  with(changes) {
    return new Uri(
      changes.scheme ?? this.scheme,
      changes.path ?? this.path,
      changes.query ?? this.query,
      changes.fragment ?? this.fragment,
    );
  }

  toString() {
    return `${this.scheme}:${this.path}${this.query ? `?${this.query}` : ''}${this.fragment ? `#${this.fragment}` : ''}`;
  }
}

class Position {
  constructor(line, character) {
    this.line = line;
    this.character = character;
  }
}

class Range {
  constructor(startLine, startCharacter, endLine, endCharacter) {
    this.start = startLine instanceof Position ? startLine : new Position(startLine, startCharacter ?? 0);
    this.end = endLine instanceof Position ? endLine : new Position(endLine, endCharacter ?? 0);
  }
}

class Selection extends Range {
  // The real API takes either two positions or four numbers, and a selection carries both ends.
  constructor(anchorLineOrPosition, anchorCharacterOrPosition, activeLine, activeCharacter) {
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
  constructor(base, pattern) {
    this.base = typeof base === 'string' ? base : base.fsPath;
    this.pattern = pattern;
  }
}

class Disposable {
  constructor(action) {
    this.action = action;
  }

  dispose() {
    this.action?.();
  }
}

class EventEmitter {
  constructor() {
    this.listeners = new Set();
    this.event = (listener) => {
      this.listeners.add(listener);
      return new Disposable(() => this.listeners.delete(listener));
    };
  }

  fire(value) {
    for (const listener of this.listeners) {
      listener(value);
    }
  }

  dispose() {
    this.listeners.clear();
  }
}

class ThemeIcon {
  constructor(id) {
    this.id = id;
  }
}

class ThemeColor {
  constructor(id) {
    this.id = id;
  }
}

class MarkdownString {
  constructor(value = '') {
    this.value = value;
  }
}

class TreeItem {
  constructor(label, collapsibleState) {
    this.label = label;
    this.collapsibleState = collapsibleState;
  }
}

class CodeLens {
  constructor(range, command) {
    this.range = range;
    this.command = command;
  }
}

class DocumentLink {
  constructor(range, target) {
    this.range = range;
    this.target = target;
  }
}

function languageFor(fsPath) {
  const extension = path.extname(fsPath).toLowerCase();
  if (extension === '.il') {
    return 'il';
  }

  if (extension === '.cs') {
    return 'csharp';
  }

  return 'plaintext';
}

function createDocument(uri, text) {
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

function createEditor(document, options = {}) {
  const decorationTypes = [];
  const editor = {
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
  get activeTextEditor() {
    return state.activeEditor;
  },
  get visibleTextEditors() {
    return state.editors;
  },
  createTextEditorDecorationType(options) {
    return { options, dispose() {} };
  },
  createStatusBarItem() {
    const item = {
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
  createOutputChannel(name) {
    return {
      name,
      lines: [],
      appendLine(line) {
        this.lines.push(line);
      },
      show() {},
      dispose() {},
    };
  },
  createTreeView(id, options) {
    const view = { id, treeDataProvider: options.treeDataProvider, dispose() {} };
    state.treeProviders.set(id, view);
    return view;
  },
  onDidChangeTextEditorSelection(listener) {
    state.selectionListeners.push(listener);
    return new Disposable(() => {
      const index = state.selectionListeners.indexOf(listener);
      if (index >= 0) {
        state.selectionListeners.splice(index, 1);
      }
    });
  },
  onDidChangeActiveTextEditor(listener) {
    state.activeEditorListeners.push(listener);
    return new Disposable();
  },
  async withProgress(options, task) {
    state.progressTitles.push(typeof options === 'object' ? options.title : String(options));
    return task({ report() {} }, { isCancellationRequested: false, onCancellationRequested() { return new Disposable(); } });
  },

  createWebviewPanel(viewType, title, column, options) {
    const messageListeners = [];
    const disposeListeners = [];
    const panel = {
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

  async showTextDocument(document, options = {}) {
    const existing = state.editors.find((editor) => editor.document.uri.toString() === document.uri.toString());
    if (existing) {
      state.activeEditor = existing;
      return existing;
    }

    return createEditor(document, options);
  },
  setStatusBarMessage(message) {
    state.statusBarMessages.push(message);
    return new Disposable();
  },
  async showInformationMessage(message) {
    state.informationMessages.push(message);
  },
  async showWarningMessage(message) {
    state.warningMessages.push(message);
  },
  async showErrorMessage(message) {
    state.errorMessages.push(message);
    return state.errorMessageResult;
  },
  async showQuickPick(itemsOrPromise, options) {
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
  get workspaceFolders() {
    return state.workspaceFolders;
  },
  getConfiguration(section) {
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
  async openTextDocument(argument) {
    // An untitled document is described by its content, the way a command that reports something uses it.
    if (argument && typeof argument === 'object' && typeof argument.content === 'string' && typeof argument.scheme !== 'string') {
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
  onDidChangeTextDocument(listener) {
    state.textChangeListeners.push(listener);
    state.textChangeSubscriptions.push(listener);
    return new Disposable(() => {
      const index = state.textChangeListeners.indexOf(listener);
      if (index >= 0) {
        state.textChangeListeners.splice(index, 1);
      }
    });
  },
  onDidSaveTextDocument(listener) {
    state.saveListeners.push(listener);
    return new Disposable(() => {
      const index = state.saveListeners.indexOf(listener);
      if (index >= 0) {
        state.saveListeners.splice(index, 1);
      }
    });
  },
  onDidChangeConfiguration(listener) {
    state.configListeners.push(listener);
    return new Disposable(() => {
      const index = state.configListeners.indexOf(listener);
      if (index >= 0) {
        state.configListeners.splice(index, 1);
      }
    });
  },
  registerFileSystemProvider(scheme, provider, options = {}) {
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
  registerTextDocumentContentProvider(scheme, provider) {
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
  findFiles(pattern, exclude, maxResults) {
    return Promise.resolve(state.findFiles(pattern, exclude, maxResults));
  },
  getWorkspaceFolder(uri) {
    const folder = state.workspaceFolders.find((candidate) => uri.fsPath.startsWith(candidate.uri.fsPath));
    return folder;
  },
};

const commands = {
  registerCommand(id, handler) {
    state.commands.set(id, handler);
    return new Disposable(() => state.commands.delete(id));
  },
  async executeCommand(id, ...args) {
    state.invokedCommands.push(id);
    const handler = state.commands.get(id);
    if (handler) {
      return handler(...args);
    }

    return undefined;
  },
};

const languages = {
  async setTextDocumentLanguage(document, languageId) {
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
  registerDocumentLinkProvider(selector, provider) {
    state.linkProviders.set(selector.scheme, provider);
    return new Disposable(() => state.linkProviders.delete(selector.scheme));
  },
  registerCodeLensProvider(selector, provider) {
    state.codeLensProviders.push({ selector, provider });
    return new Disposable(() => {
      const index = state.codeLensProviders.indexOf(provider);
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
async function sendWebviewMessage(panel, message) {
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
      async writeText(text) {
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
    NoPermissions(message) {
      const error = new Error(message);
      error.code = 'NoPermissions';
      return error;
    },
  },
  QuickPickItemKind: { Separator: -1, Default: 0 },
  TextEditorRevealType: { Default: 0, InCenter: 1, InCenterIfOutsideViewport: 2, AtTop: 3 },
};
