import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { AssemblyLocator, isSourceFile } from './assemblyLocator';
import { EngineClient } from './engine/client';
import { AssemblyInfo, FileOf, MemberLocation, NativeInfo, NativeMethod, RoundTripResult, TypeInfo } from './engine/protocol';
import { AssemblyTreeProvider } from './tree/assemblyTree';
import { Log } from './util/log';
import { IlasmDotnetDocuments, ViewerTarget } from './viewer/documents';
import { anchorAt, nearestSourceBlock } from './viewer/mapping';
import { NativeViewer, ViewerLensProvider } from './viewer/nativeViewer';
import { openAsmPane, openViewer } from './viewer/opener';
import { resolveOutput } from './viewer/outputs';
import { TypeQuickPick } from './viewer/quickPick';
import { SourceLinkProvider } from './viewer/sourceLinks';
import { SyncController } from './viewer/sync';
import { FILE_SCOPE, ViewerKind } from './viewer/viewSession';

export function activate(context: vscode.ExtensionContext): void {
  Log.init();

  const configuration = () => vscode.workspace.getConfiguration('ilasmDotnet');
  const includeCompilerGenerated = () => configuration().get<boolean>('includeCompilerGenerated', false);
  const syncOriginalSource = () => configuration().get<boolean>('syncOriginalSource', true);
  const syncScroll = () => configuration().get<boolean>('syncScroll', true);
  const asmOptimized = () => configuration().get<boolean>('asmOptimized', true);
  const asmSource = () => configuration().get<string>('asmSource', 'auto');
  const nativeRuntimeMethods = () => configuration().get<boolean>('nativeIncludeRuntime', false);

  const client = new EngineClient(context.extensionPath);
  const documents = new IlasmDotnetDocuments(client, includeCompilerGenerated, asmOptimized, asmSource, nativeRuntimeMethods);
  const sync = new SyncController(documents, syncOriginalSource, syncScroll);
  const locator = new AssemblyLocator();
  const tree = new AssemblyTreeProvider(client, locator, includeCompilerGenerated, nativeRuntimeMethods);
  const treeView = vscode.window.createTreeView('ilasmDotnet.assemblies', {
    treeDataProvider: tree,
    showCollapseAll: true,
  });

  const links = vscode.languages.registerDocumentLinkProvider(
    { scheme: IlasmDotnetDocuments.scheme },
    new SourceLinkProvider(documents),
  );

  const viewer = new NativeViewer(client, documents);
  const lenses = vscode.languages.registerCodeLensProvider(
    { scheme: IlasmDotnetDocuments.scheme },
    new ViewerLensProvider(viewer),
  );

  context.subscriptions.push(
    client,
    documents,
    sync,
    treeView,
    tree,
    links,
    viewer,
    lenses,
    vscode.commands.registerCommand('ilasmDotnet.attachProcess', (pid?: number) => viewer.attachProcess(pid)),
    vscode.commands.registerCommand('ilasmDotnet.detachProcess', () => viewer.detachProcess()),
    vscode.commands.registerCommand('ilasmDotnet.selectKind', (kind?: unknown) => viewer.selectKind(kind)),
    vscode.commands.registerCommand('ilasmDotnet.selectScope', () => viewer.selectScope()),
    vscode.commands.registerCommand('ilasmDotnet.switchOption', () => viewer.switchOption()),
    vscode.commands.registerCommand('ilasmDotnet.openForFile', () => showForCurrentFile(client, locator, documents, viewer, false)),
    vscode.commands.registerCommand('ilasmDotnet.openForCurrentLine', () => showForCurrentFile(client, locator, documents, viewer, true)),
    vscode.commands.registerCommand('ilasmDotnet.openAssembly', () => openAssembly(client, documents, viewer, tree)),
    vscode.commands.registerCommand('ilasmDotnet.showAsm', () => showAsm(client, locator, documents)),
    vscode.commands.registerCommand('ilasmDotnet.showPanel', (arg?: unknown) => showViewer(client, locator, viewer, 'il', arg)),
    vscode.commands.registerCommand('ilasmDotnet.showPanelAsm', (arg?: unknown) => showViewer(client, locator, viewer, 'asm', arg)),
    // A node of the tree stands for a type or a member, and the code of it is what one wants to read
    // there; IL and ASM are one click away in the switcher of the same tab.
    vscode.commands.registerCommand('ilasmDotnet.openInViewer', (arg?: unknown) => showViewer(client, locator, viewer, 'csharp', arg)),
    // The current-file section of the tree has to follow the editor.
    vscode.window.onDidChangeActiveTextEditor(() => tree.refresh()),
    vscode.workspace.onDidSaveTextDocument((document) => {
      if (document.uri.scheme === 'file') {
        tree.refresh();
        // A save is the moment a build is usually started, and a rebuilt assembly has to replace
        // what the panes show; the caches are dropped so the next read sees the new file.
        if (isSourceFile(document.uri.fsPath)) {
          locator.invalidate();
          void viewer.refresh();
        }
      }
    }),
    // Settings decide what a view contains, so a change has to reach the panes that are already open.
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration('ilasmDotnet')) {
        return;
      }

      void viewer.refresh();
      tree.refresh();
    }),
    vscode.commands.registerCommand('ilasmDotnet.goToSource', () => goToSource(documents)),
    vscode.commands.registerCommand('ilasmDotnet.copyIl', () => copyIl(documents)),
    vscode.commands.registerCommand('ilasmDotnet.copyCsharp', () => copyCsharp(viewer)),
    vscode.commands.registerCommand('ilasmDotnet.showDiagnostics', () => showDiagnostics(context, client, viewer)),
    vscode.commands.registerCommand('ilasmDotnet.roundTripIl', (arg?: unknown) => roundTripIl(context, client, locator, viewer, arg)),
    vscode.commands.registerCommand('ilasmDotnet.refresh', () => {
      locator.invalidate();
      viewer.reset();
      tree.refresh();
    }),
  );

  Log.info('ILASM Dotnet activated');
}

export function deactivate(): void {
  // Everything is released through the extension context subscriptions.
}

/**
 * Shows the machine code of a native image for a file of a project published with NativeAOT. Such an
 * image has no IL and no C#, so the panes of the managed route have nothing to show for it; the single
 * viewer tab is where a native image belongs, and its switcher offers the machine code alone.
 */
async function showNativeOutput(
  client: EngineClient,
  viewer: NativeViewer,
  info: NativeInfo,
  file: string,
  line: number,
  onlyCurrentMember: boolean,
): Promise<void> {
  const methods = await client
    .call<NativeMethod[]>('native/methods', { path: info.path, file })
    .catch(() => [] as NativeMethod[]);

  if (methods.length === 0) {
    void vscode.window.showWarningMessage(
      `ILASM Dotnet: ${info.name} is a native image, and no method of it was compiled from ${path.basename(file)}.` +
        `${info.note ? ` ${info.note}` : ''}`,
    );
    return;
  }

  const method = onlyCurrentMember
    ? await client.call<NativeMethod | null>('native/methodBySource', { path: info.path, file, line }).catch(() => undefined)
    : undefined;

  await viewer.show({
    assembly: info.path,
    file,
    kind: 'asm',
    scope: method ? String(method.address) : FILE_SCOPE,
    native: true,
  });
}

async function showForCurrentFile(
  client: EngineClient,
  locator: AssemblyLocator,
  documents: IlasmDotnetDocuments,
  viewer: NativeViewer,
  onlyCurrentMember: boolean,
): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.scheme !== 'file') {
    vscode.window.showInformationMessage('ILASM Dotnet: open a source file of a .NET project first.');
    return;
  }

  const resolved = await resolveOutput(client, locator, editor.document);
  if (resolved.kind === 'none') {
    const action = 'Open Assembly...';
    const choice = await vscode.window.showWarningMessage(
      'ILASM Dotnet: no build output was found for this file. Build the project first, or open an assembly directly.',
      action,
    );

    if (choice === action) {
      await vscode.commands.executeCommand('ilasmDotnet.openAssembly');
    }

    return;
  }

  if (resolved.kind === 'unreadable') {
    void vscode.window.showErrorMessage(`ILASM Dotnet: ${resolved.message}`);
    return;
  }

  const file = editor.document.uri.fsPath;
  const line = editor.selection.active.line + 1;

  if (resolved.kind === 'native') {
    await showNativeOutput(client, viewer, resolved.info, file, line, onlyCurrentMember);
    return;
  }

  const assembly = resolved.assembly;
  const member = await client.call<MemberLocation | null>('map/memberBySource', { path: assembly, file, line });

  if (onlyCurrentMember && member) {
    await openViewer(
      documents,
      { assembly, token: member.token, title: `${member.declaringType}.${member.name}` },
      { revealFile: file, revealLine: line, revealMethodToken: member.token },
    );
    return;
  }

  const type = await resolveTypeForFile(client, assembly, file);
  if (!type) {
    vscode.window.showWarningMessage('ILASM Dotnet: the assembly does not contain a matching type.');
    return;
  }

  await openViewer(
    documents,
    { assembly, token: type.token, title: type.fullName, isType: true },
    { revealFile: file, revealLine: line },
  );
}

/**
 * Writes the whole assembly as ILASM, gives it to ilasm and reports the result. It is the one check
 * that does not take the viewer on trust: a listing ilasm accepts is real IL.
 */
async function roundTripIl(
  context: vscode.ExtensionContext,
  client: EngineClient,
  locator: AssemblyLocator,
  viewer: NativeViewer,
  arg?: unknown,
): Promise<RoundTripResult | undefined> {
  const request = arg as { assembly?: string } | undefined;
  const assembly = request?.assembly ?? viewer.currentSession?.assembly ?? (await activeDocumentAssembly(locator));
  if (!assembly) {
    vscode.window.showInformationMessage('ILASM Dotnet: open a source file of a project or an assembly to assemble its IL.');
    return undefined;
  }

  // The generated files belong to the extension, not to the project being inspected.
  const storage = context.storageUri?.fsPath ?? context.globalStorageUri.fsPath;
  const outputDirectory = path.join(storage, 'roundtrip', path.basename(assembly, path.extname(assembly)));

  const result = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `ILASM Dotnet: assembling ${path.basename(assembly)} with ilasm…`,
    },
    () =>
      client.call<RoundTripResult>('assemble/roundTrip', {
        path: assembly,
        outputDirectory,
        ilasmPath: vscode.workspace.getConfiguration('ilasmDotnet').get<string>('ilasmPath', ''),
      }),
  );

  const name = path.basename(assembly);
  if (!result.success) {
    Log.error(`assembling ${assembly} failed: ${result.output}`);
    const choice = await vscode.window.showErrorMessage(
      `ILASM Dotnet: ${name} could not be assembled back. ${result.output.split('\n').at(-1) ?? ''}`.trim(),
      'Show the IL',
      'Show the log',
    );

    if (choice === 'Show the IL') {
      await showText(result.ilPath);
    } else if (choice === 'Show the log') {
      Log.show();
    }

    return result;
  }

  const summary = `${result.roundTripTypes}/${result.originalTypes} types, ${result.roundTripMethods}/${result.originalMethods} methods`;
  if (result.differences.length > 0) {
    void vscode.window.showWarningMessage(
      `ILASM Dotnet: ${name} assembled, but the result differs — ${summary}. ${result.differences.join('; ')}`,
    );
  } else {
    void vscode.window.showInformationMessage(`ILASM Dotnet: ${name} assembled back without differences — ${summary}.`);
  }

  await showText(result.ilPath);
  return result;
}

async function activeDocumentAssembly(locator: AssemblyLocator): Promise<string | undefined> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.scheme !== 'file') {
    return undefined;
  }

  return locator.findForDocument(editor.document);
}

/** Opens a generated file next to whatever the user is looking at. */
async function showText(file: string): Promise<void> {
  try {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.Beside, preview: false });
  } catch (error) {
    Log.error(`opening ${file} failed`, error);
  }
}

async function openAssembly(
  client: EngineClient,
  documents: IlasmDotnetDocuments,
  viewer: NativeViewer,
  tree: AssemblyTreeProvider,
): Promise<void> {
  const selection = await vscode.window.showOpenDialog({
    canSelectMany: false,
    // A NativeAOT executable usually has no extension at all, so every file has to be offerable.
    filters: { Assemblies: ['dll', 'exe'], 'All files': ['*'] },
    openLabel: 'Open in ILASM Dotnet',
  });

  const assembly = selection?.[0]?.fsPath;
  if (!assembly) {
    return;
  }

  tree.addAssembly(assembly);

  let types: TypeInfo[];
  try {
    types = await client.call<TypeInfo[]>('assembly/types', { path: assembly, limit: 5000 });
  } catch (error) {
    // A file that is no managed assembly may still be a native image, and then it has machine code
    // to show. Only when that fails too is the reason the metadata reader gave what is left to say.
    const native = await client
      .call<NativeInfo>('native/info', { path: assembly })
      .catch(() => undefined);

    if (!native) {
      const message = error instanceof Error ? error.message : String(error);
      void vscode.window.showErrorMessage(`ILASM Dotnet: ${message}`);
      return;
    }

    await openNativeImage(client, viewer, native);
    return;
  }

  const usable = types.filter((type) => !type.name.startsWith('<'));
  const type = await TypeQuickPick.pick(usable, 'Select a type to inspect');

  if (!type) {
    return;
  }

  // A type of an assembly opened by hand has no source file until the PDB names one, and the viewer
  // works per file; the views then open as separate tabs, which is what a stripped assembly allows.
  const source = await resolveFileForToken(client, assembly, type.token);
  if (source.file) {
    await showSourceFile(source.file, source.line);
    await viewer.show({ assembly, file: source.file, kind: 'il' });
    return;
  }

  vscode.window.setStatusBarMessage('ILASM Dotnet: this assembly has no PDB, so its views open as separate tabs.', 8000);
  await openViewer(documents, { assembly, token: type.token, title: type.fullName, isType: true });
}

/**
 * Opens a native image: a NativeAOT application or a native library. There is no IL in one, so a
 * method is chosen by name and the machine code of it is what the tab shows, with the file the debug
 * information names beside it.
 */
async function openNativeImage(client: EngineClient, viewer: NativeViewer, info: NativeInfo): Promise<void> {
  const methods = await client.call<NativeMethod[]>('native/methods', {
    path: info.path,
    includeRuntime: vscode.workspace.getConfiguration('ilasmDotnet').get<boolean>('nativeIncludeRuntime', false),
  });

  if (methods.length === 0) {
    void vscode.window.showWarningMessage(
      `ILASM Dotnet: ${info.name} holds no method this route can read.${info.note ? ` ${info.note}` : ''}`,
    );
    return;
  }

  const picked = await vscode.window.showQuickPick(
    methods.map((method) => ({
      label: method.fullName,
      description: method.file ? `${path.basename(method.file)}:${method.line}` : 'no source line',
      detail: `${method.size} bytes at 0x${method.address.toString(16)}`,
      method,
    })),
    {
      placeHolder: `${info.name} (native image, ${info.machine}) — select a method to disassemble`,
      matchOnDescription: true,
      matchOnDetail: true,
    },
  );

  if (!picked) {
    return;
  }

  await showSourceFile(picked.method.file, picked.method.line);
  await viewer.show({
    assembly: info.path,
    file: picked.method.file,
    kind: 'asm',
    scope: String(picked.method.address),
    native: true,
  });
}

/** What a viewer command was asked to show, however it was called. */
interface ViewerRequestArgs {
  assembly?: string;
  file?: string;
  token?: number;
  title?: string;
  isType?: boolean;
  revealMethodToken?: number;
  /** Set when the file is a native image, which is read by the route of its own. */
  native?: boolean;
  /** Address of the machine code of one method of a native image. */
  address?: number;
  /** Line of the source a native method starts on, for opening its file at the right place. */
  line?: number;
}

/**
 * The commands are reached in two ways, and both have to work: a node of the tree calls its command
 * with explicit arguments, while the shortcuts in the context menu of a node hand over the node
 * itself. This turns either shape into one request.
 */
function viewerRequest(arg: unknown): ViewerRequestArgs | undefined {
  const value = arg as
    | (ViewerRequestArgs & { kind?: string; info?: { token?: number; name?: string; fullName?: string; declaringType?: string } })
    | undefined;
  if (!value?.assembly) {
    return undefined;
  }

  if (typeof value.token === 'number' || typeof value.file === 'string' || typeof value.address === 'number') {
    return value;
  }

  const info = value.info;
  if (typeof info?.token !== 'number') {
    return undefined;
  }

  return {
    assembly: value.assembly,
    token: info.token,
    title: info.fullName ?? [info.declaringType, info.name].filter(Boolean).join('.'),
    isType: value.kind === 'type',
  };
}

/**
 * Opens the single viewer tab, with a view already chosen. The tree hands over the file or the member
 * its node stands for, so the command also works without touching the active editor.
 *
 * A node names a metadata token, while the members a scope picker can list belong to a file: the PDB
 * says which file a token was compiled from. The source file is opened next to the tab with the caret
 * on that member, so the reader sees the code and its IL together and the panes stay linked — exactly
 * what opening the viewer from the file itself gives. An assembly without the PDB information has no
 * file, and the tab then shows the member alone, which is all a stripped assembly can be read by.
 */
async function showViewer(
  client: EngineClient,
  locator: AssemblyLocator,
  viewer: NativeViewer,
  kind: ViewerKind,
  arg?: unknown,
): Promise<void> {
  const request = viewerRequest(arg);

  if (request?.assembly && request.native) {
    // A node of a native image stands for one method: its code is what to show, and the file the
    // debug information names is opened beside it so the two stay linked.
    await showSourceFile(request.file, request.line);

    await viewer.show({
      assembly: request.assembly,
      file: request.file ?? '',
      kind: 'asm',
      scope: typeof request.address === 'number' ? String(request.address) : FILE_SCOPE,
      native: true,
    });
    return;
  }

  if (request?.assembly && typeof request.token === 'number') {
    const source = await resolveFileForToken(client, request.assembly, request.token);
    await showSourceFile(source?.file, source?.line);

    await viewer.show({
      assembly: request.assembly,
      // The file is only what the scope picker lists and what its labels name; the view of a type or
      // a member needs the token alone, which is also what an assembly without a PDB can be shown by.
      file: source?.file ?? '',
      kind,
      scope: String(request.token),
    });
    return;
  }

  if (request?.assembly && request?.file) {
    await viewer.show({ assembly: request.assembly, file: request.file, kind });
    return;
  }

  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showInformationMessage('ILASM Dotnet: open a source file of a .NET project first.');
    return;
  }

  if (editor.document.uri.scheme !== 'file') {
    vscode.window.showInformationMessage('ILASM Dotnet: the panel opens for a source file on disk.');
    return;
  }

  const resolved = await resolveOutput(client, locator, editor.document);
  if (resolved.kind === 'none') {
    const action = 'Open Assembly...';
    const choice = await vscode.window.showWarningMessage(
      'ILASM Dotnet: no build output was found for this file. Build the project first, or open an assembly directly.',
      action,
    );

    if (choice === action) {
      await vscode.commands.executeCommand('ilasmDotnet.openAssembly');
    }

    return;
  }

  if (resolved.kind === 'unreadable') {
    void vscode.window.showErrorMessage(`ILASM Dotnet: ${resolved.message}`);
    return;
  }

  if (resolved.kind === 'native') {
    // The switcher of a native image offers the machine code alone, whatever view was asked for.
    await showNativeOutput(client, viewer, resolved.info, editor.document.uri.fsPath, editor.selection.active.line + 1, false);
    return;
  }

  await viewer.show({ assembly: resolved.assembly, file: editor.document.uri.fsPath, kind });
}

/** Source file a metadata token was compiled from, or nothing when the PDB does not say. */
async function resolveFileForToken(
  client: EngineClient,
  assembly: string,
  token: number,
): Promise<{ file?: string; line?: number }> {
  try {
    const resolved = await client.call<FileOf>('map/fileOf', { path: assembly, token });
    return { file: resolved?.file ?? undefined, line: resolved?.line || undefined };
  } catch (error) {
    Log.error('resolving the source file of a member failed', error);
    return {};
  }
}

/**
 * Shows a source file next to where the viewer will open, with the caret on the member that was asked
 * for. A file that is not on this machine — a path from another build machine — is skipped: there is
 * nothing to open, and the viewer still shows the member.
 */
async function showSourceFile(file: string | undefined, line: number | undefined): Promise<void> {
  if (!file || !fs.existsSync(file)) {
    return;
  }

  try {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    const lastLine = Math.max(document.lineCount - 1, 0);
    const position = new vscode.Position(Math.min(Math.max((line ?? 1) - 1, 0), lastLine), 0);
    const editor = await vscode.window.showTextDocument(document, {
      viewColumn: vscode.ViewColumn.One,
      preserveFocus: true,
    });

    editor.selection = new vscode.Selection(position, position);
    editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  } catch (error) {
    Log.error('opening the source file of a member failed', error);
  }
}

/** Opens the native ASM pane for whatever member the active editor or tree node points at. */
async function showAsm(
  client: EngineClient,
  locator: AssemblyLocator,
  documents: IlasmDotnetDocuments,
  arg?: unknown,
): Promise<void> {
  const fromTree = arg as { assembly?: string; info?: { token: number; declaringType: string; name: string } } | undefined;
  if (fromTree?.assembly && fromTree.info) {
    await openAsmPane(documents, {
      assembly: fromTree.assembly,
      token: fromTree.info.token,
      title: `${fromTree.info.declaringType}.${fromTree.info.name}`,
    });
    return;
  }

  const explicit = arg as ViewerTarget | undefined;
  if (explicit?.assembly && typeof explicit.token === 'number') {
    await openAsmPane(documents, explicit);
    return;
  }

  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showInformationMessage('ILASM Dotnet: open a source file, or an IL/C# pane, first.');
    return;
  }

  const viewerTarget = IlasmDotnetDocuments.targetOf(editor.document.uri);
  if (viewerTarget?.isType) {
    vscode.window.showInformationMessage(
      'ILASM Dotnet: native code is reported per member. Open a member from the ILASM Dotnet tree, or place the caret in the source line you want.',
    );
    return;
  }

  if (viewerTarget) {
    await openAsmPane(documents, viewerTarget);
    return;
  }

  if (editor.document.uri.scheme !== 'file') {
    vscode.window.showInformationMessage('ILASM Dotnet: the ASM pane is available for source files of a project and for IL/C# panes.');
    return;
  }

  const assembly = await locator.findForDocument(editor.document);
  if (!assembly) {
    vscode.window.showWarningMessage('ILASM Dotnet: no build output was found for this file. Build the project first.');
    return;
  }

  const file = editor.document.uri.fsPath;
  const line = editor.selection.active.line + 1;
  const member = await client.call<MemberLocation | null>('map/memberBySource', { path: assembly, file, line });
  if (!member) {
    vscode.window.showInformationMessage('ILASM Dotnet: no method was found for the current line.');
    return;
  }

  await openAsmPane(documents, {
    assembly,
    token: member.token,
    title: `${member.declaringType}.${member.name}`,
  });
}

async function goToSource(documents: IlasmDotnetDocuments): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  const kind = editor ? documents.kindOf(editor.document.uri) : undefined;
  if (!editor || !kind) {
    vscode.window.showInformationMessage('ILASM Dotnet: place the caret inside the ILASM Dotnet first.');
    return;
  }

  const line = editor.selection.active.line + 1;
  const view = documents.getCached(editor.document.uri);
  // The narrowest block knows the exact instruction; an instruction without a sequence point falls
  // back to the closest block that does carry source information.
  const anchor = view ? anchorAt(view.blocks, line) : undefined;
  const fallback = view ? nearestSourceBlock(view.blocks, line) : undefined;
  const source =
    anchor?.source ??
    (fallback?.sourceFile
      ? { file: fallback.sourceFile, startLine: fallback.sourceStartLine, endLine: fallback.sourceEndLine }
      : undefined);

  if (!source) {
    vscode.window.showInformationMessage('ILASM Dotnet: no source information for this instruction.');
    return;
  }

  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(source.file));
  const target = await vscode.window.showTextDocument(document, {
    viewColumn: vscode.ViewColumn.Beside,
    preserveFocus: false,
  });

  const targetLine = Math.min(source.startLine - 1, document.lineCount - 1);
  const range = new vscode.Range(targetLine, 0, targetLine, 0);
  target.selection = new vscode.Selection(range.start, range.start);
  target.revealRange(range, vscode.TextEditorRevealType.InCenter);
}

async function copyIl(documents: IlasmDotnetDocuments): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || documents.kindOf(editor.document.uri) !== 'il') {
    vscode.window.showInformationMessage('ILASM Dotnet: the active editor is not an IL view.');
    return;
  }

  await vscode.env.clipboard.writeText(editor.document.getText());
  vscode.window.setStatusBarMessage('ILASM Dotnet: IL copied to the clipboard.', 4000);
}

async function copyCsharp(viewer: NativeViewer): Promise<void> {
  const text = await viewer.csharpText();
  if (!text) {
    vscode.window.showInformationMessage('ILASM Dotnet: open the viewer first.');
    return;
  }

  await vscode.env.clipboard.writeText(text);
  vscode.window.setStatusBarMessage('ILASM Dotnet: the decompiled C# copied to the clipboard.', 4000);
}

/**
 * Everything a bug report needs, in one document. The interesting details — which runtime, which
 * engine, whether a PDB was found, whether a process is attached — are otherwise scattered across
 * settings, the file system and a running process.
 */
async function showDiagnostics(
  context: vscode.ExtensionContext,
  client: EngineClient,
  viewer: NativeViewer,
): Promise<void> {
  const configuration = vscode.workspace.getConfiguration('ilasmDotnet');
  const session = viewer.currentSession;
  const lines = [
    '# ILASM Dotnet diagnostics',
    '',
    `- extension: ${context.extension?.packageJSON?.version ?? 'unknown'} (${context.extensionPath})`,
    `- VS Code: ${vscode.version}, ${process.platform} ${process.arch}, electron ${process.versions.electron}`,
    `- node in the extension host: ${process.versions.node}`,
    `- ilasmDotnet.dotnetPath: ${configuration.get<string>('dotnetPath', 'dotnet')}`,
    `- ilasmDotnet.enginePath: ${configuration.get<string>('enginePath', '') || '(the one shipped with the extension)'}`,
    `- ilasmDotnet.asmSource: ${configuration.get<string>('asmSource', 'auto')}, asmOptimized: ${configuration.get<boolean>('asmOptimized', true)}`,
    `- ilasmDotnet.includeCompilerGenerated: ${configuration.get<boolean>('includeCompilerGenerated', false)}, syncScroll: ${configuration.get<boolean>('syncScroll', true)}`,
    `- ilasmDotnet.ilasmPath: ${configuration.get<string>('ilasmPath', '') || '(the one shipped with the extension)'}`,
    `- attached process: ${viewer.isLive ? 'yes' : 'no'}`,
  ];

  if (session) {
    lines.push(`- viewer shows: ${session.kind} of ${session.file || '(no file, the member alone)'} in ${session.assembly}`);
    try {
      const info = await client.call<AssemblyInfo>('assembly/info', { path: session.assembly });
      lines.push(
        `- assembly: ${info.name} ${info.version}, ${info.targetFramework}, ${info.architecture}, ${info.typeCount} type(s), ${info.hasPdb ? 'portable PDB found and matching' : 'no portable PDB'}`,
      );
    } catch (error) {
      lines.push(`- assembly could not be read: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    lines.push('- viewer: not open yet');
  }

  lines.push('', `Engine log is in the output channel "ILASM Dotnet".`, '');
  const document = await vscode.workspace.openTextDocument({ content: lines.join('\n'), language: 'markdown' });
  await vscode.window.showTextDocument(document, { preview: false });
}

/** Finds the type that most likely contains the given source file. */
async function resolveTypeForFile(
  client: EngineClient,
  assembly: string,
  filePath: string,
): Promise<TypeInfo | undefined> {
  const types = await client.call<TypeInfo[]>('assembly/types', { path: assembly, limit: 5000 });
  const usable = types.filter((type) => !type.name.startsWith('<') && type.name !== '<Module>');
  if (usable.length === 0) {
    return undefined;
  }

  const baseName = path.basename(filePath, path.extname(filePath));
  const match = usable.find(
    (type) => type.name === baseName || type.name.split('.').pop() === baseName || type.fullName.endsWith(`.${baseName}`),
  );

  return match ?? usable[0];
}
