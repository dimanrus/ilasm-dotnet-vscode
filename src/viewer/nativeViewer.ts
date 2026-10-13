import * as vscode from 'vscode';
import { EngineClient } from '../engine/client';
import { FileScope, LiveAttachResult, LiveProcess, NativeMethod } from '../engine/protocol';
import { Log } from '../util/log';
import { IlasmDotnetDocuments, besideColumn, findVisibleEditor } from './documents';
import {
  FILE_SCOPE,
  KIND_LABELS,
  ScopeMember,
  ViewerKind,
  ViewerSession,
  isViewerKind,
  kindsFor,
  languageFor,
  lensSpecs,
  scopeChoices,
  statusText,
} from './viewSession';

export interface ViewerRequest {
  assembly: string;
  file: string;
  kind: ViewerKind;
  /** Member the tab starts on, or the whole file when it is not given. */
  scope?: string;
  /** Set for a native image, whose only view is its machine code. */
  native?: boolean;
}

/** A picker row that carries the value it selects; separators carry neither. */
interface OptionPick extends vscode.QuickPickItem {
  kindValue?: ViewerKind;
  scopeValue?: string;
}

/**
 * The viewer as a single native editor tab: one reused document whose content and language change
 * with the selected view, instead of a webview and a pile of tabs.
 *
 * A real dropdown cannot be placed inside a VS Code editor, so switching is offered through a
 * clickable row above the code (CodeLens) and through the status bar. Both call the same commands.
 */
export class NativeViewer implements vscode.Disposable {
  private readonly status: vscode.StatusBarItem;
  private readonly lensEmitter = new vscode.EventEmitter<void>();
  private readonly uri = IlasmDotnetDocuments.sessionUri();

  private session?: ViewerSession;
  private livePid?: number;
  private members: ScopeMember[] = [];
  private membersFile?: string;
  private busy = false;

  readonly onDidChangeLenses = this.lensEmitter.event;

  constructor(
    private readonly client: EngineClient,
    private readonly documents: IlasmDotnetDocuments,
  ) {
    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 80);
    this.status.command = 'ilasmDotnet.switchOption';
    this.status.tooltip = 'ILASM Dotnet: choose the view and the scope';
  }

  get currentMembers(): ScopeMember[] {
    return this.members;
  }

  get currentSession(): ViewerSession | undefined {
    return this.session;
  }

  get attachedPid(): number | undefined {
    return this.livePid;
  }

  /**
   * Attaches the viewer to a running .NET process. That is what unlocks the exact link from a native
   * instruction to the IL instruction and the source line it implements, because only a live process
   * reports the JIT mapping from a native address to an IL offset.
   *
   * A pid can be passed in, which skips the picker; the command argument is what automated tests use.
   */
  async attachProcess(pid?: number): Promise<void> {
    const processes = await this.client.call<LiveProcess[]>('processes');
    if (pid === undefined && processes.length === 0) {
      void vscode.window.showInformationMessage('ILASM Dotnet: no running .NET process was found.');
      return;
    }

    const picked =
      pid === undefined
        ? await vscode.window.showQuickPick(
            processes.map((process) => ({
              label: process.name,
              description: `pid ${process.pid}`,
              detail: process.command,
              pid: process.pid,
            })),
            {
              placeHolder: 'Attach the viewer to a running .NET process',
              matchOnDescription: true,
              matchOnDetail: true,
            },
          )
        : { label: processes.find((process) => process.pid === pid)?.name ?? `pid ${pid}`, pid };

    if (!picked) {
      return;
    }

    try {
      const result = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `ILASM Dotnet: reading process ${picked.pid}…`,
        },
        () => this.client.call<LiveAttachResult>('live/attach', { pid: picked.pid }),
      );

      this.livePid = result.pid;
      this.documents.setLivePid(result.pid);
      void vscode.window.showInformationMessage(
        `ILASM Dotnet: attached to ${picked.label} (pid ${result.pid}, runtime ${result.runtime}, ${result.detail}).`,
      );
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      void vscode.window.showWarningMessage(`ILASM Dotnet: could not attach to pid ${picked.pid}: ${text}`);
      return;
    }

    // Reload so an assembly pane switches to the live route straight away.
    if (this.session) {
      await this.apply(this.session);
    }
  }

  async detachProcess(): Promise<void> {
    if (this.livePid === undefined) {
      void vscode.window.showInformationMessage('ILASM Dotnet: no process is attached.');
      return;
    }

    this.livePid = undefined;
    this.documents.setLivePid(undefined);

    try {
      await this.client.call('live/detach');
    } catch (error) {
      Log.error('detaching failed', error);
    }

    void vscode.window.showInformationMessage('ILASM Dotnet: detached. Assembly is read from the JIT again.');
    if (this.session) {
      await this.apply(this.session);
    }
  }

  /** True when this document is the reusable viewer tab. */
  owns(uri: vscode.Uri): boolean {
    return uri.toString() === this.uri.toString();
  }

  /**
   * Opens the viewer for a file, or reuses the tab to show another file. The entry commands start
   * from the whole file unless they were given a member: a command titled after a file should not
   * silently reopen one member, while a node in the tree names the member it stands for.
   */
  async show(request: ViewerRequest): Promise<void> {
    await this.apply({
      assembly: request.assembly,
      file: request.file,
      kind: request.kind,
      scope: request.scope ?? FILE_SCOPE,
      native: request.native === true,
    });
  }

  async selectKind(kind: unknown): Promise<void> {
    if (!this.session) {
      void vscode.window.showInformationMessage('ILASM Dotnet: open a file with the viewer first.');
      return;
    }

    // A native image has no IL and no C# to switch to; the lenses do not offer them either, and a
    // command that asks for one anyway is answered with the reason.
    if (isViewerKind(kind) && !kindsFor(this.session).includes(kind)) {
      void vscode.window.showInformationMessage(
        'ILASM Dotnet: a native image has no IL and no C# in it; only its machine code can be shown.',
      );
      return;
    }

    if (isViewerKind(kind)) {
      await this.apply({ ...this.session, kind });
    }
  }

  async selectScope(): Promise<void> {
    if (!this.session) {
      void vscode.window.showInformationMessage('ILASM Dotnet: open a file with the viewer first.');
      return;
    }

    const current = this.session.scope;
    const picked = await vscode.window.showQuickPick(
      scopeChoices(this.members, this.scopeOptions()).map((choice) => ({
        label: (choice.value === current ? '$(check)' : '$(blank)') + ' ' + choice.label,
        description: choice.description,
        scopeValue: choice.value,
      })),
      { placeHolder: 'Show the whole file or a single member', matchOnDescription: true },
    );

    if (picked) {
      await this.apply({ ...this.session, scope: picked.scopeValue });
    }
  }

  /** Single entry point used by the status bar: offers the view and the scope in one list. */
  async switchOption(): Promise<void> {
    if (!this.session) {
      void vscode.window.showInformationMessage('ILASM Dotnet: open a file with the viewer first.');
      return;
    }

    const session = this.session;
    const kindSection: vscode.QuickPickItem = { label: 'View', kind: vscode.QuickPickItemKind.Separator };
    const scopeSection: vscode.QuickPickItem = { label: 'Scope', kind: vscode.QuickPickItemKind.Separator };

    const kindItems: OptionPick[] = kindsFor(session).map((kind) => ({
      label: (kind === session.kind ? '$(check)' : '$(blank)') + ' ' + KIND_LABELS[kind],
      description: kind === session.kind ? 'current view' : undefined,
      kindValue: kind,
    }));

    const scopeItems: OptionPick[] = scopeChoices(this.members, this.scopeOptions()).map((choice) => ({
      label: (choice.value === session.scope ? '$(check)' : '$(blank)') + ' ' + choice.label,
      description: choice.description,
      scopeValue: choice.value,
    }));

    const picked = await vscode.window.showQuickPick<OptionPick>(
      [kindSection, ...kindItems, scopeSection, ...scopeItems],
      { placeHolder: 'ILASM Dotnet: view and scope', matchOnDescription: true },
    );

    if (!picked) {
      return;
    }

    if (picked.kindValue) {
      await this.apply({ ...session, kind: picked.kindValue });
    } else if (picked.scopeValue) {
      await this.apply({ ...session, scope: picked.scopeValue });
    }
  }

  /**
   * Points the tab at the given state. Changing the view also changes the document language, which
   * makes VS Code reload it; changing only the scope reloads the content in place.
   */
  private async apply(session: ViewerSession): Promise<void> {
    if (this.busy) {
      return;
    }

    this.busy = true;
    try {
      this.session = session;
      this.members = await this.loadMembers(session);

      const existing = findVisibleEditor(this.uri);

      // The state has to be in place before the document is created or re-read. The staleness is
      // announced after the language switch, since recreating a document reads the cached content.
      await this.documents.setSessionState(this.uri, session, { notify: false });

      const base = existing?.document ?? (await vscode.workspace.openTextDocument(this.uri));
      const document = await this.documents.applySessionLanguage(base, session.kind);
      this.documents.notifyChanged(this.uri);

      // Beside, not on top of the source file: the viewer is meant to be read next to the code. With
      // nothing else open there is nothing to sit beside, and splitting would leave an empty group
      // showing the "open a file" page, so the tab goes into the only group that exists.
      const editor = await vscode.window.showTextDocument(document, {
        viewColumn: existing?.viewColumn ?? besideColumn(),
        preview: false,
        preserveFocus: false,
      });

      this.revealStart(editor);
      await this.updateChrome();
    } catch (error) {
      Log.error('showing a view in the native viewer failed', error);
      const text = error instanceof Error ? error.message : String(error);
      void vscode.window.showWarningMessage(`ILASM Dotnet: ${text}`);
    } finally {
      this.busy = false;
    }
  }

  /** The whole-file entry is only offered when the session knows the file it shows. */
  private scopeOptions(): { wholeFile: boolean } {
    return { wholeFile: Boolean(this.session?.file) };
  }

  private async loadMembers(session: ViewerSession): Promise<ScopeMember[]> {
    // A member of an assembly without a PDB has no file to list members from; the tab shows it alone.
    if (!session.file) {
      return [];
    }

    if (session.native) {
      return this.loadNativeMembers(session);
    }

    // The low-level flavour shows the compiler generated members, so the picker has to offer them,
    // otherwise a state machine that is on screen could not be selected.
    const includeGenerated = session.kind === 'csharpLow' || this.documents.includeGenerated;
    const key = `${session.file}|${includeGenerated}`;
    if (this.membersFile === key) {
      return this.members;
    }

    try {
      const scope = await this.client.call<FileScope>('file/scope', {
        path: session.assembly,
        file: session.file,
        includeCompilerGenerated: includeGenerated,
      });

      this.membersFile = key;
      return scope.members;
    } catch (error) {
      Log.error('reading the file scope for the viewer failed', error);
      this.membersFile = key;
      return [];
    }
  }

  /**
   * Methods of a native image, as the scope picker needs them. A native method has no metadata token,
   * so the address of its code is what the session carries, and the file and line the debug
   * information names become the second line of the entry.
   */
  private async loadNativeMembers(session: ViewerSession): Promise<ScopeMember[]> {
    const includeRuntime = this.documents.nativeIncludeRuntime;
    const key = `native:${session.file}|${includeRuntime}`;
    if (this.membersFile === key) {
      return this.members;
    }

    try {
      const methods = await this.client.call<NativeMethod[]>('native/methods', {
        path: session.assembly,
        file: session.file,
        includeRuntime,
      });

      this.membersFile = key;
      return methods.map((method) => ({
        token: 0,
        address: method.address,
        kind: 'method',
        name: method.fullName,
        declaringType: method.declaringType,
        label: method.fullName,
        detail: method.file ? `${method.file.split(/[\\/]/).pop()}:${method.line}` : 'no source line',
      }));
    } catch (error) {
      Log.error('reading the methods of a native image failed', error);
      this.membersFile = key;
      return [];
    }
  }

  /**
   * Puts the caret on the first code the tab shows, and centres it. The caret is what links the tab
   * to the others: without it a freshly opened tab would point at line one, which is a comment or an
   * empty line in every listing, so the source file would stay unhighlighted until the reader clicks
   * something. The legacy panes do the same when they open on a member.
   */
  private revealStart(editor: vscode.TextEditor): void {
    const view = this.documents.getCached(this.uri);
    if (!view) {
      return;
    }

    const block = view.blocks.find((candidate) => candidate.sourceFile) ?? view.blocks[0];
    if (!block) {
      return;
    }

    const range = new vscode.Range(block.textStartLine - 1, 0, block.textEndLine, 0);
    editor.selection = new vscode.Selection(range.start, range.start);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }

  private async updateChrome(): Promise<void> {
    if (this.session) {
      // What the engine had to say about the view — no code for a method, no PDB, another
      // architecture — belongs on screen too: a note that only lives in the payload is a note nobody
      // reads, and the listing itself may well be empty because of it.
      //
      // The notes are taken from the view of the current session rather than from whatever the
      // document is showing: a document is re-read asynchronously, so reading the cache here would
      // show the notes of the session before this one.
      const notes = (await this.documents.sessionView(this.session).catch(() => undefined))?.notes ?? [];
      this.status.text = `${notes.length > 0 ? '$(warning) ' : '$(file-code) '}${statusText(this.session, this.members, this.livePid)}`;
      this.status.tooltip = notes.length > 0 ? notes.join('\n') : 'ILASM Dotnet: go to the original source line';
      this.status.show();
    } else {
      this.status.hide();
    }

    this.lensEmitter.fire();
  }

  /** Text of the C# view of what the tab shows, whether or not that view is on screen. */
  async csharpText(): Promise<string | undefined> {
    // A native image has no C# to copy, and asking for it would read a view that cannot exist.
    if (!this.session || this.session.native) {
      return undefined;
    }

    return (await this.documents.sessionView({ ...this.session, kind: 'csharp' })).text;
  }

  /** Drops cached state so a rebuilt assembly is picked up. */
  reset(): void {
    this.members = [];
    this.membersFile = undefined;
    this.documents.invalidate();
  }

  /**
   * Follows a rebuild or a settings change: the cached views are dropped and the scope list is read
   * again, so a member that a setting now hides disappears from the picker as well.
   */
  async refresh(): Promise<void> {
    this.membersFile = undefined;
    this.documents.invalidate();

    if (!this.session) {
      return;
    }

    this.members = await this.loadMembers(this.session);
    await this.updateChrome();
  }

  /** True when a live process is attached, which is what the assembly panes prefer. */
  get isLive(): boolean {
    return this.livePid !== undefined;
  }

  dispose(): void {
    this.status.dispose();
    this.lensEmitter.dispose();
  }
}

/**
 * Supplies the clickable row above the code. Each view is one click away and the scope entry opens a
 * picker, so the row behaves like the dropdown of a tool window.
 */
export class ViewerLensProvider implements vscode.CodeLensProvider, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  private readonly disposables: vscode.Disposable[] = [];

  readonly onDidChangeCodeLenses = this.emitter.event;

  constructor(private readonly viewer: NativeViewer) {
    this.disposables.push(viewer.onDidChangeLenses(() => this.emitter.fire()));
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const session = this.viewer.currentSession;
    if (!session || !this.viewer.owns(document.uri) || document.languageId !== languageFor(session.kind)) {
      return [];
    }

    const range = new vscode.Range(0, 0, 0, 0);
    return lensSpecs(session, this.viewer.currentMembers).map(
      (spec) =>
        new vscode.CodeLens(range, {
          title: spec.title,
          command: spec.command,
          arguments: spec.arguments,
        }),
    );
  }

  dispose(): void {
    this.emitter.dispose();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }
}
