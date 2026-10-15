#!/usr/bin/env node
// Integration test for the packaged extension: loads out/extension.js against a stubbed VS Code API,
// activates it, and drives the real commands against the real .NET engine and the fixture library.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import Module from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// This suite collects its failures itself instead of asserting on the spot.
void assert;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const fixtureDirectory = path.join(root, 'test', 'fixtures', 'SampleLib');
const fixtureProject = path.join(fixtureDirectory, 'SampleLib.csproj');
const fixtureAssembly = path.join(fixtureDirectory, 'bin', 'Debug', 'net10.0', 'SampleLib.dll');
const fixtureSource = path.join(fixtureDirectory, 'Calculator.cs');
const liveDirectory = path.join(root, 'test', 'fixtures', 'LiveTarget');
const liveProject = path.join(liveDirectory, 'LiveTarget.csproj');
const liveAssembly = path.join(liveDirectory, 'bin', 'Release', 'net8.0', 'LiveTarget.dll');
const liveSource = path.join(liveDirectory, 'Target.cs');
const r2rDirectory = path.join(liveDirectory, 'bin', 'r2r');
const r2rAssembly = path.join(r2rDirectory, 'LiveTarget.dll');
const aotDirectory = path.join(root, 'test', 'fixtures', 'AotTarget');
const aotProject = path.join(aotDirectory, 'AotTarget.csproj');
const aotSource = path.join(aotDirectory, 'Target.cs');
const nativeImageFile = path.join(aotDirectory, 'bin', 'Release', 'net10.0', 'linux-x64', 'publish', 'AotTarget');
const fsDirectory = path.join(root, 'test', 'fixtures', 'FsTarget');
const fsProject = path.join(fsDirectory, 'FsTarget.fsproj');
const fsSource = path.join(fsDirectory, 'Catalog.fs');
const fsAssembly = path.join(fsDirectory, 'bin', 'Release', 'net10.0', 'FsTarget.dll');
const singleDirectory = path.join(liveDirectory, 'bin', 'single');
const singleImageFile = path.join(singleDirectory, 'LiveTarget');

// The stub in scripts/vscode-stub.cts stands in for the VS Code API, so the shapes this suite reads
// out of it are spelled out here instead of being imported from the real API.
interface StubUri {
  scheme: string;
  fsPath: string;
  path: string;
  toString(): string;
}

interface StubDocument {
  uri: StubUri;
  languageId: string;
  getText(): string;
}

interface StubPosition {
  line: number;
  character: number;
}

interface StubRange {
  start: StubPosition;
  end: StubPosition;
}

interface StubEditor {
  document: StubDocument;
  viewColumn: number;
  selection: { active: StubPosition };
  revealed: StubRange[];
  decorations: Map<unknown, StubRange[]>;
}

interface StubEditorEdit {
  insert(position: StubPosition, text: string): void;
}

interface StubStatusBarItem {
  text: string;
  tooltip?: string;
  command?: string;
}

interface StubQuickPickItem {
  label: string;
  pid?: number;
}

interface StubCodeLens {
  command?: { title: string; command: string };
}

interface StubCodeLensEntry {
  selector: { scheme: string };
  provider: { provideCodeLenses(document: StubDocument): StubCodeLens[] | undefined };
}

interface StubTreeNodeInfo {
  name: string;
  fullName: string;
  path: string;
}

interface StubTreeNode {
  kind: string;
  info: StubTreeNodeInfo;
  file?: string;
  assembly?: string;
  problem?: string;
  method?: { fullName: string };
}

/** The workspace file search takes a plain glob or a base directory with the glob inside it. */
type StubFindFilesPattern = string | { base: string; pattern: string };

interface StubExtensionContext {
  extensionPath: string;
  subscriptions: { dispose(): void }[];
  extension: { packageJSON: unknown };
  storageUri: unknown;
  globalStorageUri: unknown;
}

// Redirecting require('vscode') goes through the module loader, whose hook is internal to Node and
// is not in the type definitions of node:module.
declare module 'node:module' {
  namespace Module {
    function _load(request: string, parent: unknown, isMain: boolean): unknown;
  }
}

const failures: string[] = [];
let checkCount = 0;

/** The newest modification time of the sources a build output is made of. */
function newestMtime(directory: string, extension: string) {
  let newest = 0;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'bin' || entry.name === 'obj' || entry.name === 'node_modules') {
      continue;
    }

    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      newest = Math.max(newest, newestMtime(full, extension));
    } else if (entry.name.endsWith(extension)) {
      newest = Math.max(newest, fs.statSync(full).mtimeMs);
    }
  }

  return newest;
}

// This suite loads the built bundle and drives the real engine, so a stale artifact would be tested
// instead of the sources: it has to say so, and the plain "npm test" rebuilds the bundle for you.
function requireFreshBundle() {
  const bundle = path.join(root, 'out', 'extension.js');
  if (!fs.existsSync(bundle)) {
    throw new Error('out/extension.js is missing; run "npm run compile" first.');
  }

  const sources = newestMtime(path.join(root, 'src'), '.ts');
  if (fs.statSync(bundle).mtimeMs < sources) {
    throw new Error('out/extension.js is older than src/**; run "npm run compile" (plain "npm test" does it).');
  }
}

function requireFreshEngine() {
  const candidates = [
    path.join(root, 'out', 'engine', 'IlasmDotnet.Engine.dll'),
    path.join(root, 'engine', 'IlasmDotnet.Engine', 'bin', 'Release', 'net10.0', 'IlasmDotnet.Engine.dll'),
    path.join(root, 'engine', 'IlasmDotnet.Engine', 'bin', 'Debug', 'net10.0', 'IlasmDotnet.Engine.dll'),
  ];
  const built = candidates.find((candidate) => fs.existsSync(candidate));
  if (!built) {
    throw new Error(`the .NET engine is not built; run "npm run build:engine" first.\nLooked in:\n  ${candidates.join('\n  ')}`);
  }

  const sources = newestMtime(path.join(root, 'engine'), '.cs');
  if (fs.statSync(built).mtimeMs < sources) {
    throw new Error(`the .NET engine is older than engine/**; run "npm run build:engine" first (${path.relative(root, built)}).`);
  }
}

function check(name: string, condition: unknown, detail = '') {
  checkCount++;
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function buildFixture() {
  for (const project of [fixtureProject, liveProject, fsProject]) {
    const result = spawnSync('dotnet', ['build', project, '-c', 'Release', '-v', 'q', '--nologo'], {
      stdio: 'pipe',
      encoding: 'utf8',
    });

    if (result.status !== 0) {
      throw new Error(`fixture build failed for ${project}:\n${result.stdout}\n${result.stderr}`);
    }
  }

  // The debug build of the sample is what the earlier checks rely on.
  spawnSync('dotnet', ['build', fixtureProject, '-c', 'Debug', '-v', 'q', '--nologo'], { stdio: 'pipe' });
}

/**
 * Publishes the native fixture, which is the one program the viewer cannot read as an assembly: a
 * NativeAOT image holds machine code and no IL at all. A machine without the AOT toolchain skips
 * these checks rather than failing them.
 */
function publishNativeImage() {
  const result = spawnSync('dotnet', ['publish', aotProject, '-c', 'Release', '-v', 'q', '--nologo'], {
    stdio: 'pipe',
    encoding: 'utf8',
  });

  const published = result.status === 0 && fs.existsSync(nativeImageFile);
  if (!published) {
    console.log(`  the NativeAOT publish failed:\n${result.stdout}${result.stderr}`);
  }

  return published;
}

/**
 * Publishes the live target into one file. What a reader opens is a native host, and the assembly it
 * runs is appended inside it: the engine has to take that bundle apart before IL, C# or ASM can be
 * shown, which is the one thing this publish shape needs.
 */
function publishSingleFile() {
  const result = spawnSync(
    'dotnet',
    ['publish', liveProject, '-c', 'Release', '-r', 'linux-x64', '--self-contained', 'false', '-p:PublishSingleFile=true', '-o', singleDirectory, '-v', 'q', '--nologo'],
    { stdio: 'pipe', encoding: 'utf8' },
  );

  const published = result.status === 0 && fs.existsSync(singleImageFile);
  if (!published) {
    console.log(`  the single file publish failed:\n${result.stdout}${result.stderr}`);
  }

  return published;
}

/** Publishes the live fixture ahead of time, which is what the image route reads. */
function publishReadyToRun() {
  const result = spawnSync(
    'dotnet',
    ['publish', liveProject, '-c', 'Release', '-r', 'linux-x64', '--self-contained', 'false', '-p:PublishReadyToRun=true', '-o', r2rDirectory, '-v', 'q', '--nologo'],
    { stdio: 'pipe', encoding: 'utf8' },
  );

  if (result.status !== 0) {
    console.log('  the ReadyToRun publish failed, its checks are skipped');
    return undefined;
  }

  return fs.existsSync(r2rAssembly) ? r2rAssembly : undefined;
}

/** Kills leftover fixture processes so a live attach cannot pick a stale instance. */
async function killLeftoverTargets() {
  const entries = await fs.promises.readdir('/proc');

  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) {
      continue;
    }

    let command;
    try {
      command = (await fs.promises.readFile(`/proc/${entry}/cmdline`, 'utf8')).replaceAll('\0', ' ');
    } catch {
      continue;
    }

    if (command.includes('LiveTarget.dll')) {
      try {
        process.kill(Number(entry), 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
  }

  await new Promise((resolve) => setTimeout(resolve, 300));
}

/** Redirects require('vscode') to the in-memory stub before loading the bundle. */
function loadExtension() {
  const stubPath = path.join(root, 'scripts', 'vscode-stub.cts');
  const stub = require(stubPath);
  const originalLoad = Module._load;
  Module._load = function patched(request, parent, isMain) {
    if (request === 'vscode') {
      return stub;
    }

    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    return { extension: require(path.join(root, 'out', 'extension.js')), vscode: require(stubPath) };
  } finally {
    Module._load = originalLoad;
  }
}

async function main() {
  requireFreshBundle();
  requireFreshEngine();

  buildFixture();

  const { extension, vscode } = loadExtension();

/** Polls a predicate while the engine answers, which can take a moment for ASM. */
async function waitFor<T>(predicate: () => T, timeoutMs = 15000): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value) {
      return value;
    }

    if (Date.now() > deadline) {
      return undefined;
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
  const state = vscode.state;

  // Derive the line under test from the fixture itself; hard coded line numbers silently rot as
  // soon as anyone edits the fixture.
  const fixtureLines = fs.readFileSync(fixtureSource, 'utf8').split('\n');
  const negativeLine = fixtureLines.findIndex((line) => line.includes('return "negative"'));
  check('the fixture exposes an anchor line inside Describe', negativeLine > 0, String(negativeLine));

  state.config['ilasmDotnet.dotnetPath'] = 'dotnet';
  state.config['ilasmDotnet.includeCompilerGenerated'] = false;
  state.config['ilasmDotnet.syncOriginalSource'] = true;
  state.config['ilasmDotnet.asmSource'] = 'auto';
  state.workspaceFolders = [{ uri: vscode.Uri.file(root), name: 'ilasm-dotnet', index: 0 }];

  // The locator discovers the fixture the same way it would discover a real project.
  state.findFiles = (pattern: StubFindFilesPattern) => {
    const isRelative = pattern !== null && typeof pattern === 'object';
    const base = isRelative ? pattern.base : '';
    const glob = isRelative ? pattern.pattern : String(pattern ?? '');

    if (glob.includes('csproj')) {
      return [vscode.Uri.file(fixtureProject)];
    }

    if (base === fixtureDirectory && glob.endsWith('SampleLib.dll')) {
      return [vscode.Uri.file(fixtureAssembly)];
    }

    return [];
  };

  // The real host always fills in the storage locations, so the extension may rely on them.
  const storageDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ilasm-dotnet-storage-'));
  const context: StubExtensionContext = {
    extensionPath: root,
    subscriptions: [],
    // The real host hands the extension's own manifest over as well.
    extension: { packageJSON: JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) },
    storageUri: vscode.Uri.file(path.join(storageDirectory, 'storage')),
    globalStorageUri: vscode.Uri.file(path.join(storageDirectory, 'global')),
  };
  extension.activate(context);

  const expectedCommands = [
    'ilasmDotnet.openForFile',
    'ilasmDotnet.openForCurrentLine',
    'ilasmDotnet.openAssembly',
    'ilasmDotnet.goToSource',
    'ilasmDotnet.copyIl',
    'ilasmDotnet.refresh',
  ];

  check(
    'activate registers every contributed command',
    expectedCommands.every((id) => state.commands.has(id)),
    [...state.commands.keys()].join(','),
  );
  check('activate registers the ilasm-dotnet file system', state.fileSystemProviders.has('ilasm-dotnet'));
  check('the viewer scheme is registered read only', state.readOnlySchemes.has('ilasm-dotnet'));
  check('activate registers the document link provider', state.linkProviders.has('ilasm-dotnet'));
  check('activate registers the assemblies tree view', state.treeProviders.has('ilasmDotnet.assemblies'));

  const treeProvider = state.treeProviders.get('ilasmDotnet.assemblies').treeDataProvider;
  const assemblies = await treeProvider.getChildren();
  check('the tree discovers the fixture assembly', assemblies.length === 1, String(assemblies.length));
  check('the tree labels the assembly', assemblies[0]?.info?.name === 'SampleLib', assemblies[0]?.info?.name);
  check('the assembly reports debug information', assemblies[0]?.info?.hasPdb === true);

  const types = await treeProvider.getChildren(assemblies[0]);
  const calculator = types.find((node: StubTreeNode) => node.info?.fullName === 'SampleLib.Calculator');
  check('the tree lists SampleLib.Calculator', Boolean(calculator));
  check('the tree hides compiler generated types by default', !types.some((node: StubTreeNode) => node.info?.name?.startsWith('<')), types.map((n: StubTreeNode) => n.info?.name).join(','));

  const members = await treeProvider.getChildren(calculator);
  check('the tree lists the members', members.length >= 4, String(members.length));
  check('a member node carries an open command', members[0]?.info && typeof treeProvider.getTreeItem(members[0]).command?.command === 'string');

  // A node stands for a type or a member, and a click has to land in the single tab with the code of
  // it: the assembly explorer is where one reads code, and the switcher offers IL and ASM from there.
  const describeMember = members.find((node: StubTreeNode) => node.info.name === 'Describe');
  const describeItem = treeProvider.getTreeItem(describeMember);
  check('a member node opens the single viewer tab', describeItem.command?.command === 'ilasmDotnet.openInViewer', describeItem.command?.command);

  await vscode.commands.executeCommand(describeItem.command.command, ...describeItem.command.arguments);
  const sessionEditor = await waitFor(
    () => state.editors.find((editor: StubEditor) => editor.document.uri.path === '/ILASM Dotnet' && editor.document.languageId === 'csharp'),
    30000,
  );
  check('the tab is the reusable viewer', Boolean(sessionEditor), state.editors.map((editor: StubEditor) => `${editor.document.uri.path}:${editor.document.languageId}`).join(','));
  check(
    'the member node narrows that tab to the member',
    sessionEditor.document.getText().includes('public string Describe') && !sessionEditor.document.getText().includes('public int Add'),
    sessionEditor.document.getText().slice(0, 80),
  );

  const nodeLenses = state.codeLensProviders
    .filter((entry: StubCodeLensEntry) => entry.selector.scheme === 'ilasm-dotnet')
    .flatMap((entry: StubCodeLensEntry) => entry.provider.provideCodeLenses(sessionEditor.document) ?? []);
  check('the viewer opened from the tree offers the switcher row', nodeLenses.length === 5, String(nodeLenses.length));
  check('the row names the member the node stands for', String(nodeLenses[4]?.command?.title).includes('Describe'), nodeLenses[4]?.command?.title);
  check('the row marks the C# view as the one that is open', String(nodeLenses[1]?.command?.title).startsWith('●'), nodeLenses.map((lens: StubCodeLens) => lens.command?.title).join(' | '));

  // The source file opens on the left with the caret on the member, so the viewer is read next to the
  // code and the link between them works — the same as opening the viewer from the file itself.
  const openedSource = state.editors.find((editor: StubEditor) => editor.document.uri.fsPath === fixtureSource);
  check('the source file of the member opens', Boolean(openedSource), state.editors.map((editor: StubEditor) => editor.document.uri.fsPath).join(','));
  check('the source file sits in the first column', openedSource?.viewColumn === vscode.ViewColumn.One, String(openedSource?.viewColumn));
  check('the viewer sits to the right of it', sessionEditor.viewColumn === vscode.ViewColumn.Beside, String(sessionEditor.viewColumn));
  check(
    'the caret lands on the member in the source',
    openedSource.selection.active.line > 0 && fixtureLines[openedSource.selection.active.line] !== undefined,
    String(openedSource.selection.active.line),
  );
  // In a real window the viewer takes focus on its own, which is what links the two; the stub is told.
  state.activeEditor = sessionEditor;
  for (const listener of state.activeEditorListeners) {
    listener(sessionEditor);
  }

  check('the source file is linked to the viewer', [...openedSource.decorations.values()].flat().length > 0, '');

  // The shortcuts of a node in the tree hand over the node itself, and they have to work as well:
  // this is what the ASM action of a member does.
  await vscode.commands.executeCommand('ilasmDotnet.showPanelAsm', describeMember);
  const asmFromTree = await waitFor(
    () => state.editors.find((editor: StubEditor) => editor.document.uri.path === '/ILASM Dotnet' && editor.document.languageId === 'il-asm'),
    60000,
  );
  check('the ASM action of a member shows native code', Boolean(asmFromTree), state.editors.map((editor: StubEditor) => `${editor.document.uri.path}:${editor.document.languageId}`).join(','));
  check(
    'the ASM action keeps the member in scope',
    asmFromTree.document.getText().includes('SampleLib.Calculator:Describe') ||
      asmFromTree.document.getText().includes('Describe'),
    asmFromTree.document.getText().slice(0, 120),
  );

  // A type has no single body, so its native code is every body it declares: asking for it has to
  // produce a listing, not fail and leave the previous text in the tab.
  await vscode.commands.executeCommand('ilasmDotnet.showPanelAsm', {
    assembly: fixtureAssembly,
    token: 0x02000002,
    title: 'SampleLib.Calculator',
    isType: true,
  });
  const typeAsm = await waitFor(
    () =>
      state.editors.find(
        (editor: StubEditor) =>
          editor.document.uri.path === '/ILASM Dotnet' &&
          editor.document.languageId === 'il-asm' &&
          // The member view of the previous check is also a listing, so this has to wait for a view
          // that holds several of them: that is what makes it the view of a type.
          (editor.document.getText().match(/Assembly listing for method /g) ?? []).length > 1,
      ),
    90000,
  );
  check('the ASM view of a type lists the code of its methods', Boolean(typeAsm), state.editors.map((editor: StubEditor) => `${editor.document.uri.path}:${editor.document.languageId}`).join(','));
  check(
    'the ASM view of a type holds every method of it',
    typeAsm && (typeAsm.document.getText().match(/Assembly listing for method /g) ?? []).length > 1,
    typeAsm ? String((typeAsm.document.getText().match(/Assembly listing for method /g) ?? []).length) : '',
  );

  // A view the engine had to explain has to say so on screen: a note that only travels in the payload
  // is a note nobody reads, and the listing may be empty because of it.
  await vscode.commands.executeCommand('ilasmDotnet.showPanel', {
    assembly: fixtureAssembly,
    file: path.join(root, 'scripts', 'smoke.mts'),
  });
  const explained = await waitFor(
    () => state.editors.find((editor: StubEditor) => editor.document.uri.path === '/ILASM Dotnet' && editor.document.getText().includes('Nothing in')),
    30000,
  );
  check('a view with nothing to show explains itself', Boolean(explained), state.editors.map((editor: StubEditor) => editor.document.getText().slice(0, 60)).join(' | '));
  check(
    'the notes of the engine reach the status bar',
    state.statusBarItems.some((item: StubStatusBarItem) => item.text.startsWith('$(warning)')),
    state.statusBarItems.map((item: StubStatusBarItem) => item.text).join(' | '),
  );

  // The C# of what the tab shows can be copied without switching to that view first.
  await vscode.commands.executeCommand('ilasmDotnet.showPanel', { assembly: fixtureAssembly, file: fixtureSource });
  await waitFor(() => (/public int Add/.test(state.editors.find((editor: StubEditor) => editor.document.uri.path === '/ILASM Dotnet')?.document.getText() ?? '') ? true : undefined), 30000);
  state.clipboard = '';
  await vscode.commands.executeCommand('ilasmDotnet.copyCsharp');
  check(
    'the C# of the view can be copied',
    /public int Add|class Calculator/.test(state.clipboard),
    state.clipboard.slice(0, 80),
  );

  // What a bug report needs lives in settings, the file system and a running process; one command
  // gathers it instead of asking for each piece.
  await vscode.commands.executeCommand('ilasmDotnet.showDiagnostics');
  const diagnostics = await waitFor(
    () => state.documents.get('untitled:/Untitled-1') ?? [...state.documents.values()].find((document) => document.getText().includes('ILASM Dotnet diagnostics')),
    30000,
  );
  check('diagnostics report the extension and the environment', Boolean(diagnostics), '');
  check('diagnostics name the assembly the viewer shows', diagnostics.getText().includes('SampleLib'), '');
  check('diagnostics say whether a PDB was found', diagnostics.getText().includes('portable PDB'), '');

  // A view that cannot be produced says so instead of leaving the previous text on screen.
  await vscode.commands.executeCommand('ilasmDotnet.openInViewer', { assembly: fixtureAssembly, token: 0x0600ffff, title: 'nowhere' });
  const broken = await waitFor(
    () => state.editors.find((editor: StubEditor) => editor.document.uri.path === '/ILASM Dotnet' && editor.document.getText().includes('could not read this view')),
    30000,
  );
  check('a view that cannot be read explains itself', Boolean(broken), state.editors.map((editor: StubEditor) => editor.document.getText().slice(0, 60)).join(' | '));

  // A type node names a token, and the tab is asked for that type: a type whose bodies all live in
  // generated types (an async entry point, an iterator) has no code in the file index of its file.
  await vscode.commands.executeCommand('ilasmDotnet.openInViewer', {
    assembly: fixtureAssembly,
    token: 0x02000002,
    title: 'SampleLib.Calculator',
    isType: true,
  });
  const typeTab = await waitFor(
    () => state.editors.find((editor: StubEditor) => editor.document.uri.path === '/ILASM Dotnet' && editor.document.getText().includes('class Calculator')),
    30000,
  );
  check('a type node opens the code of that type', Boolean(typeTab), state.editors.map((editor: StubEditor) => editor.document.uri.path).join(','));

  // An assembly without a PDB has no file to name, and the member still has to open, alone.
  const strippedDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ilasm-dotnet-stripped-'));
  const strippedAssembly = path.join(strippedDirectory, 'SampleLib.dll');
  fs.copyFileSync(fixtureAssembly, strippedAssembly);

  await vscode.commands.executeCommand('ilasmDotnet.openInViewer', {
    assembly: strippedAssembly,
    token: 0x02000002,
    title: 'SampleLib.Calculator',
    isType: true,
  });
  const strippedTab = await waitFor(
    () => state.editors.find((editor: StubEditor) => editor.document.uri.path === '/ILASM Dotnet' && editor.document.getText().includes('class Calculator')),
    30000,
  );
  check('a type of an assembly without a PDB opens as well', Boolean(strippedTab), state.editors.map((editor: StubEditor) => editor.document.uri.path).join(','));
  check(
    'the tab names no file it does not have',
    !state.statusBarItems.some((item: StubStatusBarItem) => item.text.includes(' ·  · ')),
    state.statusBarItems.map((item: StubStatusBarItem) => item.text).join(' | '),
  );
  fs.rmSync(strippedDirectory, { recursive: true, force: true });

  // Opening the viewer from a source file is the separate-panes route: the IL and C# views of the
  // type declared in that file open side by side.
  const typeSourceEditor = state.editors.find((editor: StubEditor) => editor.document.uri.fsPath === fixtureSource);
  state.activeEditor = typeSourceEditor;
  await vscode.commands.executeCommand('ilasmDotnet.openForFile');

  const ilEditor = state.editors.find((editor: StubEditor) => editor.document.uri.scheme === 'ilasm-dotnet' && editor.document.uri.path.endsWith('.il'));
  const csharpEditor = state.editors.find((editor: StubEditor) => editor.document.uri.scheme === 'ilasm-dotnet' && editor.document.uri.path.endsWith('.cs'));

  check('opening a type creates the IL view', Boolean(ilEditor));
  check('opening a type creates the decompiled C# view', Boolean(csharpEditor));
  check('the IL document gets the il language', ilEditor?.document.languageId === 'il', ilEditor?.document.languageId);
  check('the C# document gets the csharp language', csharpEditor?.document.languageId === 'csharp', csharpEditor?.document.languageId);

  const ilText = ilEditor.document.getText();
  const csharpText = csharpEditor.document.getText();
  check('the IL view contains IL labels', /IL_0000:/.test(ilText));
  check('the IL view contains sequence point comments', ilText.includes('sequence point'));
  check('the IL view names the type', ilText.includes('SampleLib.Calculator'));
  check('the C# view contains the decompiled type', csharpText.includes('class Calculator'));
  check('the C# view contains the decompiled body of Add', csharpText.includes('public int Add'));

  // Selection synchronisation is verified on a method view, where every IL block belongs to the
  // member shown in the decompiled C# pane. The caret in the source decides which member that is.
  const memberSourceEditor = state.editors.find((editor: StubEditor) => editor.document.uri.fsPath === fixtureSource);
  state.activeEditor = memberSourceEditor;
  memberSourceEditor.selection = { active: { line: negativeLine, character: 0 } };
  await vscode.commands.executeCommand('ilasmDotnet.openForCurrentLine');

  const memberIlEditor = state.editors.find(
    (editor: StubEditor) => editor.document.uri.path.endsWith('.il') && editor.document.uri.path.includes('Describe'),
  );
  const memberCsEditor = state.editors.find(
    (editor: StubEditor) => editor.document.uri.path.endsWith('.cs') && editor.document.uri.path.includes('Describe'),
  );

  check('opening a member creates a member scoped IL view', Boolean(memberIlEditor));
  check('opening a member creates a member scoped C# view', Boolean(memberCsEditor));
  check('the member IL pane also opens beside the source', memberIlEditor?.viewColumn === vscode.ViewColumn.Beside, String(memberIlEditor?.viewColumn));
  check('the member view is revealed automatically', (memberIlEditor?.revealed.length ?? 0) > 0);

  const memberLines = memberIlEditor.document.getText().split('\n');
  const mappedInstructionIndex = memberLines.findIndex((line: string, index: number) => {
    if (!/IL_[0-9A-F]{4}:/.test(line)) {
      return false;
    }

    const previous = memberLines.slice(Math.max(0, index - 3), index).join('\n');
    return previous.includes('sequence point');
  });

  check('an IL instruction is preceded by a sequence point', mappedInstructionIndex > 0, String(mappedInstructionIndex));

  // The original source editor has to be open for the source highlight to be observable.
  const sourceDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(fixtureSource));
  const sourceEditor = await vscode.window.showTextDocument(sourceDocument, {});

  memberIlEditor.selection = { active: { line: mappedInstructionIndex, character: 0 } };
  for (const listener of state.selectionListeners) {
    listener({ textEditor: memberIlEditor });
  }

  const csharpDecorations = [...memberCsEditor.decorations.values()].flat();
  check('moving the caret in IL highlights the counterpart C# member', csharpDecorations.length > 0, String(csharpDecorations.length));
  check('moving the caret in IL highlights the original source line', [...sourceEditor.decorations.values()].flat().length > 0);
  check('moving the caret in IL scrolls the source to that line', (sourceEditor.revealed.length ?? 0) > 0, '');

  const statusItem = state.statusBarItems.find((item: StubStatusBarItem) => item.text.includes('Calculator.cs'));
  check('the mapping is reported in the status bar', Boolean(statusItem), state.statusBarItems.map((item: StubStatusBarItem) => item.text).join('|'));
  check('the status bar points at the IL offset', statusItem?.text.includes('IL_'), statusItem?.text);

  const provider = state.linkProviders.get('ilasm-dotnet');
  const links = await provider.provideDocumentLinks(memberIlEditor.document);
  check('sequence point comments become clickable links', links.length > 5, String(links.length));
  check(
    'source links target the fixture source file',
    links.length > 0 && links[0].target.fsPath.endsWith('Calculator.cs'),
    links[0]?.target?.fsPath,
  );
  check('source links carry a line fragment', links.length > 0 && /^L\d+$/.test(links[0].target.fragment), links[0]?.target?.fragment);

  // Caret in the real source file highlights the IL of the enclosing instruction.
  sourceEditor.selection = { active: { line: negativeLine, character: 0 } };
  for (const listener of state.selectionListeners) {
    listener({ textEditor: sourceEditor });
  }

  const ilDecorations = [...memberIlEditor.decorations.values()].flat();
  check('a caret in the source file highlights the matching IL lines', ilDecorations.length > 0, String(ilDecorations.length));

  // The link works in both directions, and every pane takes part in it: the C# member reported by the
  // PDB covers the very line the caret is on, so its pane has to be highlighted as well.
  memberCsEditor.decorations.clear();
  sourceEditor.selection = { active: { line: negativeLine, character: 0 } };
  for (const listener of state.selectionListeners) {
    listener({ textEditor: sourceEditor });
  }

  const csharpFromSource = [...memberCsEditor.decorations.values()].flat();
  check('a caret in the source file highlights the matching C# member', csharpFromSource.length > 0, String(csharpFromSource.length));

  // Highlighting a pane the user cannot see is only half the job: the pane has to show that place.
  const ilRanges = [...memberIlEditor.decorations.values()].flat();
  const highlighted = Math.min(...ilRanges.map((range) => range.start.line));
  check('a caret in the source file scrolls the IL pane to the match', memberIlEditor.revealed.at(-1)?.start.line === highlighted, `${memberIlEditor.revealed.at(-1)?.start.line} vs ${highlighted}`);
  check('a caret in the source file scrolls the C# pane to the member', (memberCsEditor.revealed.length ?? 0) > 0, '');

  // The setting keeps the panes where they are for anyone who scrolls by hand.
  state.config['ilasmDotnet.syncScroll'] = false;
  memberIlEditor.revealed.length = 0;
  memberIlEditor.decorations.clear();
  for (const listener of state.selectionListeners) {
    listener({ textEditor: sourceEditor });
  }

  check('the highlight does not depend on the scroll', [...memberIlEditor.decorations.values()].flat().length > 0, '');
  check('the scroll follows the setting', memberIlEditor.revealed.length === 0, String(memberIlEditor.revealed.length));
  state.config['ilasmDotnet.syncScroll'] = true;

  // Switching to the source file with the mouse is not a caret move, and it still has to link up.
  memberIlEditor.decorations.clear();
  memberIlEditor.revealed.length = 0;
  for (const listener of state.activeEditorListeners) {
    listener(sourceEditor);
  }

  check(
    'switching to the source file links the IL pane as well',
    [...memberIlEditor.decorations.values()].flat().length > 0 && memberIlEditor.revealed.length > 0,
    `${[...memberIlEditor.decorations.values()].flat().length}/${memberIlEditor.revealed.length}`,
  );

  // Opening from the current line uses the PDB to resolve the member under the caret.
  state.editors.length = 0;
  state.activeEditor = sourceEditor;
  sourceEditor.selection = { active: { line: negativeLine, character: 0 } };
  await vscode.commands.executeCommand('ilasmDotnet.openForCurrentLine');

  const methodView = state.editors.find((editor: StubEditor) => editor.document.uri.path.endsWith('.il'));
  check('openForCurrentLine opens the member that owns the line', methodView?.document.uri.path.includes('Describe'), methodView?.document.uri.path);
  check('openForCurrentLine reveals the matching instructions', (methodView?.revealed.length ?? 0) > 0);

  // The reset above produced fresh editor objects, so the current C# pane has to be looked up again.
  const currentCsEditor = state.editors.find(
    (editor: StubEditor) => editor.document.uri.path.endsWith('.cs') && editor.document.uri.path.includes('Describe'),
  );
  check('the C# pane was reopened for the current line', Boolean(currentCsEditor));

  // Copying the IL uses the clipboard and refuses non-IL editors.
  state.activeEditor = methodView;
  await vscode.commands.executeCommand('ilasmDotnet.copyIl');
  check('copyIl copies the view text', state.clipboard.includes('IL_0000:'), String(state.clipboard.length));

  // ASM pane: the JIT compiles the method on request and the pane links to the other two.
  state.config['ilasmDotnet.asmOptimized'] = true;
  state.activeEditor = methodView;
  await vscode.commands.executeCommand('ilasmDotnet.showAsm');

  const asmEditor = state.editors.find((editor: StubEditor) => editor.document.uri.path.endsWith('.asm'));
  check('showAsm opens the ASM pane', Boolean(asmEditor));
  check('the ASM pane is scoped to the member', Boolean(asmEditor?.document.uri.path.includes('Describe')), asmEditor?.document.uri.path);
  check('the ASM document gets the il-asm language', asmEditor?.document.languageId === 'il-asm', asmEditor?.document.languageId);

  const asmText = asmEditor ? asmEditor.document.getText() : '';
  check('the ASM pane contains a JIT listing', /; Assembly listing for method /.test(asmText));
  check('the ASM pane contains real instructions', /\bmov\b|\blea\b|\bpush\b/.test(asmText));
  check('the ASM pane names the disassembled method', asmText.includes('SampleLib.Calculator:Describe'));
  check('the ASM pane contains a code size', /; Total bytes of code \d+/.test(asmText));
  check('the ASM pane was revealed', (asmEditor?.revealed.length ?? 0) > 0);

  // Linking by method token: the caret in one pane lights up the others.
  const asmInstructionLine = asmText.split('\n').findIndex((line: string) => /^ {2,}[a-z]/.test(line));
  check('the ASM pane has an instruction line to place the caret on', asmInstructionLine > 0, String(asmInstructionLine));

  if (asmEditor && asmInstructionLine > 0) {
    asmEditor.selection = { active: { line: asmInstructionLine, character: 0 } };
    for (const listener of state.selectionListeners) {
      listener({ textEditor: asmEditor });
    }

    check('a caret in ASM highlights the IL pane', [...methodView.decorations.values()].flat().length > 0);
    check('a caret in ASM highlights the C# pane', [...currentCsEditor.decorations.values()].flat().length > 0);

    // The caret has to sit on an instruction; the pane header carries no method token.
    const ilInstructionLine = methodView.document
      .getText()
      .split('\n')
      .findIndex((line: string) => /^IL_[0-9A-F]{4}:/.test(line.trimStart()));
    check('the IL pane has an instruction to place the caret on', ilInstructionLine > 0, String(ilInstructionLine));

    methodView.selection = { active: { line: ilInstructionLine, character: 0 } };
    for (const listener of state.selectionListeners) {
      listener({ textEditor: methodView });
    }

    check('a caret in IL highlights the ASM pane', [...asmEditor.decorations.values()].flat().length > 0);
  }

  // The viewer as one native tab: content and language change instead of new tabs or a webview.
  // Only the source editor is kept, so the viewer can be counted and the source can stay open.
  state.editors.splice(0, state.editors.length, sourceEditor);
  state.activeEditor = sourceEditor;
  state.config['ilasmDotnet.asmOptimized'] = true;
  await vscode.commands.executeCommand('ilasmDotnet.showPanel');

  check('no webview is used any more', state.webviewPanels.length === 0, String(state.webviewPanels.length));

  const viewerEditors = state.editors.filter((editor: StubEditor) => editor.document.uri.scheme === 'ilasm-dotnet');
  check('showPanel opens exactly one native editor', viewerEditors.length === 1, String(viewerEditors.length));

  const viewerEditor = viewerEditors[0];
  const viewerUri = viewerEditor?.document.uri.toString();

  // The viewer belongs next to the source file, not on top of it.
  check('the viewer opens beside the source file', viewerEditor?.viewColumn === vscode.ViewColumn.Beside, String(viewerEditor?.viewColumn));
  check('the source editor stays open', state.editors.some((editor: StubEditor) => editor.document.uri.fsPath === fixtureSource));
  check('the tab is named for the viewer, not for the file', viewerUri?.endsWith('/ILASM Dotnet'), viewerEditor?.document.uri.path);
  check('the viewer document uses the il language', viewerEditor?.document.languageId === 'il', viewerEditor?.document.languageId);

  const viewerText = () => viewerEditor.document.getText();

  // The tab may already have been open for another member or file, in which case its content is read
  // again; the check has to wait for the text the command asked for, not for any previous content.
  await waitFor(() => (/IL_[0-9A-F]{4}:/.test(viewerText()) ? true : undefined), 30000);
  check('the whole file IL is shown by default', /IL_[0-9A-F]{4}:/.test(viewerText()) && !viewerText().includes('Assembly listing'));
  check('the view covers the declared type', viewerText().includes('SampleLib.Calculator'), '');
  check('the view holds every method of the type', (viewerText().match(/IL_0000:/g) ?? []).length >= 3, String((viewerText().match(/IL_0000:/g) ?? []).length));

  // The clickable row above the code replaces the dropdown.
  const lensProvider = state.codeLensProviders.find((entry: StubCodeLensEntry) => entry.selector.scheme === 'ilasm-dotnet');
  check('a code lens provider is registered for the viewer', Boolean(lensProvider), String(state.codeLensProviders.length));

  const lenses = lensProvider ? lensProvider.provider.provideCodeLenses(viewerEditor.document) : [];
  check('the row offers every view and the scope', lenses.length === 5, String(lenses.length));
  check('the row marks the active view', lenses[0]?.command?.title === '● IL code', lenses[0]?.command?.title);
  check('the row offers both C# flavours', [lenses[1]?.command?.title, lenses[2]?.command?.title].join('|') === 'C# (high level)|C# (low level)', `${lenses[1]?.command?.title}|${lenses[2]?.command?.title}`);
  check('the row shows the scope entry', String(lenses[4]?.command?.title).startsWith('Scope: Entire file'), lenses[4]?.command?.title);
  check('the view switches through commands', lenses[0]?.command?.command === 'ilasmDotnet.selectKind', lenses[0]?.command?.command);

  // Switching the view keeps the single tab and swaps the language.
  await vscode.commands.executeCommand('ilasmDotnet.selectKind', 'asm');
  await waitFor(() => viewerEditor.document.languageId === 'il-asm' && viewerText().includes('Assembly listing'), 60000);
  check('switching the view keeps the same tab', viewerEditor.document.uri.toString() === viewerUri, viewerEditor.document.uri.toString());
  check('switching to ASM changes the document language', viewerEditor.document.languageId === 'il-asm', viewerEditor.document.languageId);
  check('the ASM view holds a JIT listing', viewerText().includes('Assembly listing'), viewerText().slice(0, 80));

  const asmLenses = lensProvider ? lensProvider.provider.provideCodeLenses(viewerEditor.document) : [];
  check('the row marks ASM as the active view', asmLenses[3]?.command?.title === '● Native ASM', asmLenses[3]?.command?.title);

  await vscode.commands.executeCommand('ilasmDotnet.selectKind', 'csharp');
  await waitFor(() => viewerEditor.document.languageId === 'csharp', 30000);
  check('switching to C# changes the document language', viewerEditor.document.languageId === 'csharp', viewerEditor.document.languageId);
  check('the C# view holds the decompiled type', viewerText().includes('Calculator'), '');

  // Phase 5: the low-level flavour shows what the compiler made of the sugar.
  await vscode.commands.executeCommand('ilasmDotnet.selectKind', 'csharpLow');
  const lowViewer = await waitFor(() => (viewerText().includes('IteratorStateMachine') ? viewerEditor : undefined), 60000);
  check('the low level view opens', Boolean(lowViewer), viewerText().slice(0, 120));
  check('the low level view keeps the csharp language', viewerEditor.document.languageId === 'csharp', viewerEditor.document.languageId);
  check('the low level view shows the generated state machine', viewerText().includes('SampleLib.Calculator.<'), '');
  check('the low level view hides the yield of the iterator', !viewerText().includes('yield return'), '');
  check('the low level view is its own tab state', viewerEditor.document.uri.toString() === viewerUri, viewerEditor.document.uri.toString());

  const lowLenses = lensProvider ? lensProvider.provider.provideCodeLenses(viewerEditor.document) : [];
  check('the row marks the low level view as active', lowLenses[2]?.command?.title === '● C# (low level)', lowLenses[2]?.command?.title);

  await vscode.commands.executeCommand('ilasmDotnet.selectKind', 'csharp');
  await waitFor(() => (viewerText().includes('yield return') ? viewerEditor : undefined), 60000);
  check('the high level view brings the yield back', viewerText().includes('yield return'), '');

  await vscode.commands.executeCommand('ilasmDotnet.selectKind', 'il');
  await waitFor(() => viewerEditor.document.languageId === 'il', 30000);
  check('switching back to IL restores the language', viewerEditor.document.languageId === 'il', viewerEditor.document.languageId);

  // The scope picker narrows the view, and reopening the file keeps that choice.
  state.quickPickResult = (items: StubQuickPickItem[]) => items.find((item: StubQuickPickItem) => String(item.label).includes('Add()'));
  await vscode.commands.executeCommand('ilasmDotnet.selectScope');
  await waitFor(() => !viewerText().includes('Describe'), 30000);
  check('the scope picker narrows the view to one member', !viewerText().includes('Describe'), viewerText().slice(0, 80));
  check('the narrowed view still holds IL', /IL_[0-9A-F]{4}:/.test(viewerText()));

  const scopedLenses = lensProvider ? lensProvider.provider.provideCodeLenses(viewerEditor.document) : [];
  check('the row reports the narrowed scope', scopedLenses.at(-1)?.command?.title === 'Scope: Add()', scopedLenses.at(-1)?.command?.title);

  state.activeEditor = sourceEditor;
  await vscode.commands.executeCommand('ilasmDotnet.showPanel');
  await waitFor(() => viewerEditor.document.languageId === 'il' && viewerText().includes('Describe'), 30000);
  check('reopening the file starts from the whole file again', viewerText().includes('Describe'), viewerText().slice(0, 80));
  check('reopening still uses one tab', state.editors.filter((editor: StubEditor) => editor.document.uri.scheme === 'ilasm-dotnet').length === 1);

  // Switching the view or the scope must not move the tab into another column.
  const columnAfterSwitching = viewerEditor.viewColumn;
  await vscode.commands.executeCommand('ilasmDotnet.selectKind', 'asm');
  await waitFor(() => viewerEditor.document.languageId === 'il-asm', 60000);
  check('switching the view keeps the column', viewerEditor.viewColumn === columnAfterSwitching, `${columnAfterSwitching} -> ${viewerEditor.viewColumn}`);

  // Switching to another file through the tree entry point resets the scope to the whole file.
  await vscode.commands.executeCommand('ilasmDotnet.showPanel', { assembly: fixtureAssembly, file: fixtureSource });
  await waitFor(() => viewerText().includes('Describe'), 30000);
  check('the tree entry point reopens the whole file', /IL_[0-9A-F]{4}:/.test(viewerText()) && viewerText().includes('Describe'), viewerText().slice(0, 60));

  // Native editor features keep working on the viewer document.
  const viewerLinks = await state.linkProviders.get('ilasm-dotnet').provideDocumentLinks(viewerEditor.document);
  check('sequence point links work in the native tab', viewerLinks.length > 3, String(viewerLinks.length));

  const viewerStatusItem = state.statusBarItems.find((item: StubStatusBarItem) => item.command === 'ilasmDotnet.switchOption');
  check('the status bar entry describes the current view', Boolean(viewerStatusItem?.text.includes('Calculator.cs')), String(viewerStatusItem?.text));
  check('the status bar entry opens the switcher', viewerStatusItem?.command === 'ilasmDotnet.switchOption', String(viewerStatusItem?.command));

  // A viewer must not be editable, otherwise a stray keystroke would fight the refresh.
  const editApplied = await viewerEditor.edit((builder: StubEditorEdit) => builder.insert({ line: 0, character: 0 }, 'x'));
  check('the viewer document is read only', editApplied === false, String(editApplied));

  // The status bar switcher offers both dimensions in one list.
  state.quickPickResult = (items: StubQuickPickItem[]) => items.find((item: StubQuickPickItem) => String(item.label).includes('Native ASM'));
  await vscode.commands.executeCommand('ilasmDotnet.switchOption');
  await waitFor(() => viewerEditor.document.languageId === 'il-asm', 60000);
  check('the switcher can change the view', viewerEditor.document.languageId === 'il-asm', viewerEditor.document.languageId);

  state.quickPickResult = (items: StubQuickPickItem[]) => items.find((item: StubQuickPickItem) => String(item.label).includes('Describe()'));
  await vscode.commands.executeCommand('ilasmDotnet.switchOption');
  await waitFor(() => viewerText().includes('Describe'), 60000);
  check('the switcher can change the scope', viewerText().includes('Describe'), viewerText().slice(0, 60));

  state.quickPickResult = undefined;

  // Phase 4: a ReadyToRun image is read from the file, without a process and without the JIT.
  const readyToRun = publishReadyToRun();
  if (readyToRun) {
    await vscode.commands.executeCommand('ilasmDotnet.showPanel', { assembly: readyToRun, file: liveSource });
    await vscode.commands.executeCommand('ilasmDotnet.selectKind', 'asm');

    const imageViewer = await waitFor(() => {
      const editor = state.editors.find((candidate: StubEditor) => candidate.document.uri.path === '/ILASM Dotnet');
      return editor && editor.document.getText().includes('(read from the image)') ? editor : undefined;
    }, 120000);

    check('the assembly pane reads precompiled code from the image', Boolean(imageViewer), '');
    const imageText = imageViewer ? imageViewer.document.getText() : '';
    check('the image listing names the target it was built for', imageText.includes('ReadyToRun x64 code'), imageText.split('\n')[1]);
    check('the image listing holds native instructions', /\bpush\b|\bmov\b/.test(imageText), '');
    check('the image listing names the IL instruction behind an instruction', /; IL_[0-9a-f]{4}/.test(imageText), imageText.split('\n').find((line: string) => line.includes('; IL_')) ?? '');
    check('the image listing is in the il-asm language', imageViewer?.document.languageId === 'il-asm', imageViewer?.document.languageId);

    // The setting has to be able to bring the JIT back, which is what the other assemblies use.
    state.config['ilasmDotnet.asmSource'] = 'jit';
    await vscode.commands.executeCommand('ilasmDotnet.selectKind', 'il');
    await vscode.commands.executeCommand('ilasmDotnet.selectKind', 'asm');
    const jitViewer = await waitFor(() => {
      const editor = state.editors.find((candidate: StubEditor) => candidate.document.uri.path === '/ILASM Dotnet');
      return editor && editor.document.getText().includes('Assembly listing for method') ? editor : undefined;
    }, 120000);

    check('the setting brings the JIT back', Boolean(jitViewer));
    state.config['ilasmDotnet.asmSource'] = 'auto';
  }

  // The ILASM round-trip: the listing of the assembly is assembled back by ilasm and compared.
  // It works on the assembly of the open viewer, so point that back at the fixture first.
  await vscode.commands.executeCommand('ilasmDotnet.showPanel', { assembly: fixtureAssembly, file: fixtureSource });
  state.activeEditor = sourceEditor;
  await vscode.commands.executeCommand('ilasmDotnet.roundTripIl');
  check('the round-trip shows progress', state.progressTitles.some((title: string) => title.includes('ilasm')), state.progressTitles.join('|'));
  check(
    'the round-trip reports that nothing was lost',
    state.informationMessages.some((message: string) => message.includes('without differences')),
    state.informationMessages.at(-1),
  );
  const roundTripListing = state.editors.find((editor: StubEditor) => editor.document.uri.fsPath?.endsWith('.il'));
  check('the round-trip opens the generated listing', Boolean(roundTripListing), roundTripListing?.document.uri.fsPath);
  check('the generated listing holds the whole assembly', roundTripListing?.document.getText().includes('.assembly SampleLib') === true, '');
  check('the generated listing is a file on disk', roundTripListing?.document.uri.scheme === 'file', roundTripListing?.document.uri.scheme);

  // The command also accepts the assembly the tree hands over.
  await vscode.commands.executeCommand('ilasmDotnet.roundTripIl', { assembly: fixtureAssembly });
  check(
    'the command accepts the assembly the tree passes',
    state.informationMessages.filter((message: string) => message.includes('without differences')).length >= 2,
    state.informationMessages.at(-1),
  );

  // The side bar tree gains a section for the file that is open in the editor.
  state.activeEditor = sourceEditor;
  for (const listener of state.activeEditorListeners) {
    listener(sourceEditor);
  }

  check('the active editor is the fixture source', state.activeEditor?.document.uri.fsPath === fixtureSource, state.activeEditor?.document.uri.fsPath);

  const rootsWithFile = await treeProvider.getChildren();
  check('the tree shows a current-file section first', rootsWithFile[0]?.kind === 'currentfile', rootsWithFile.map((node: StubTreeNode) => node.kind).join(','));
  check('the tree still lists the project assembly', rootsWithFile.some((node: StubTreeNode) => node.kind === 'assembly'), rootsWithFile.map((node: StubTreeNode) => node.kind).join(','));

  const currentFileNode = rootsWithFile[0];
  const currentFileItem = currentFileNode ? treeProvider.getTreeItem(currentFileNode) : undefined;
  check('the current-file node is labelled with the file name', currentFileItem?.label === 'Calculator.cs', String(currentFileItem?.label));
  check('the current-file node maps to the built assembly', Boolean(currentFileNode?.assembly?.endsWith('SampleLib.dll')), String(currentFileNode?.assembly));
  check('the current-file node reports how much is declared there', Boolean(currentFileItem?.description?.includes('member')), String(currentFileItem?.description));

  const fileTypes = await treeProvider.getChildren(currentFileNode);
  check('the section lists the type declared in the file', fileTypes.length === 1 && fileTypes[0].info.fullName === 'SampleLib.Calculator', fileTypes.map((node: StubTreeNode) => node.info.fullName).join(','));

  const fileMembers = await treeProvider.getChildren(fileTypes[0]);
  const fileMemberNames = fileMembers.map((node: StubTreeNode) => node.info.name);
  check('the section lists the members written in this file', fileMemberNames.includes('Add') && fileMemberNames.includes('Describe'), fileMemberNames.join(','));
  check('the section does not list bodies from other files', !fileMemberNames.includes('MoveNext'), fileMemberNames.join(','));
  check('the section lists the property accessor of the file', fileMemberNames.includes('get_Count'), fileMemberNames.join(','));
  check('a file member node carries an open command', typeof treeProvider.getTreeItem(fileMembers[0]).command?.command === 'string');

  // Clicking the node opens the viewer for the whole file, without going through the active editor.
  await vscode.commands.executeCommand(currentFileItem.command.command, ...currentFileItem.command.arguments);
  await waitFor(() => /IL_[0-9A-F]{4}:/.test(viewerEditor.document.getText()), 30000);
  check('clicking the current-file node opens the viewer for that file', /IL_[0-9A-F]{4}:/.test(viewerEditor.document.getText()));
  check('that view holds the whole file, not just a member', viewerEditor.document.getText().includes('Describe'));

  // Switching to a viewer document removes the section, because there is no source file anymore.
  state.activeEditor = viewerEditor;
  for (const listener of state.activeEditorListeners) {
    listener(viewerEditor);
  }

  const rootsWithoutFile = await treeProvider.getChildren();
  check('the section disappears when the active editor is not a source file', rootsWithoutFile.every((node: StubTreeNode) => node.kind !== 'currentfile'), rootsWithoutFile.map((node: StubTreeNode) => node.kind).join(','));

  // Saving a source file refreshes the tree, so a fresh build is picked up.
  let treeRefreshes = 0;
  const treeSubscription = treeProvider.onDidChangeTreeData(() => {
    treeRefreshes++;
  });

  state.activeEditor = sourceEditor;
  for (const listener of state.saveListeners) {
    listener(sourceEditor.document);
  }

  check('saving a source file refreshes the tree', treeRefreshes > 0, String(treeRefreshes));
  treeSubscription.dispose();

  // A save is followed by a rebuild, so the open pane has to be read again as well. The setting
  // changed here without being announced, so only the re-read can bring it into the pane.
  await vscode.commands.executeCommand('ilasmDotnet.selectKind', 'csharp');
  await waitFor(
    () => viewerEditor.document.languageId === 'csharp' && viewerText().includes('public int Add'),
    60000,
  );

  // The settings checks read the whole-file view, whatever scope the picker selected before.
  state.quickPickResult = (items: StubQuickPickItem[]) => items.find((item: StubQuickPickItem) => String(item.label).includes('Entire file'));
  await vscode.commands.executeCommand('ilasmDotnet.selectScope');
  await waitFor(() => viewerText().includes('public string Describe'), 60000);

  const beforeSave = viewerText();
  check('the C# view hides the compiler generated members by default', !beforeSave.includes('nested type'), beforeSave.slice(0, 120));

  state.config['ilasmDotnet.includeCompilerGenerated'] = true;
  for (const listener of state.saveListeners) {
    listener(sourceEditor.document);
  }

  const afterSave = await waitFor(() => (viewerText().includes('nested type') ? viewerText() : undefined), 60000);
  check('saving a source file re-reads the open viewer', Boolean(afterSave), viewerText().slice(0, 120));
  check('the re-read view follows the settings', viewerText() !== beforeSave, '');

  // A settings change reaches the pane that is already open: the cached view is dropped, so the
  // document has to be read again without reopening it.
  state.config['ilasmDotnet.includeCompilerGenerated'] = false;
  for (const listener of state.configListeners) {
    listener({ affectsConfiguration: (section: string) => section === 'ilasmDotnet' });
  }

  await waitFor(() => viewerText() === beforeSave, 60000);
  check(
    'a settings change re-reads the open viewer',
    viewerText() === beforeSave,
    `len=${viewerText().length} expected=${beforeSave.length} generated=${viewerText().includes('nested type')}`,
  );

  // An accessor is listed under the property it belongs to and its C# is that property.
  state.quickPickResult = (items: StubQuickPickItem[]) => items.find((item: StubQuickPickItem) => String(item.label).includes('Count (get)'));
  await vscode.commands.executeCommand('ilasmDotnet.selectScope');
  const accessorView = await waitFor(() => (/public int Count =>\s*_history\.Count;/.test(viewerText()) ? viewerText() : undefined), 60000);
  check('the scope picker lists an accessor under its property', Boolean(accessorView), viewerText().slice(0, 120));

  const accessorLenses = lensProvider ? lensProvider.provider.provideCodeLenses(viewerEditor.document) : [];
  check('the row names the accessor scope after its property', String(accessorLenses[4]?.command?.title).includes('Count (get)'), accessorLenses[4]?.command?.title);

  // The IL view is by method, so the same scope keeps the accessor there: only C# has a property.
  await vscode.commands.executeCommand('ilasmDotnet.selectKind', 'il');
  const accessorIl = await waitFor(
    () => (viewerEditor.document.languageId === 'il' && viewerText().includes('get_Count') ? viewerText() : undefined),
    60000,
  );
  check('the accessor scope keeps the IL of the accessor itself', Boolean(accessorIl), viewerText().slice(0, 200));
  check('the IL pane shows the accessor, not the property', !viewerText().includes('public int Count'), viewerText().slice(0, 200));

  state.quickPickResult = (items: StubQuickPickItem[]) => items.find((item: StubQuickPickItem) => String(item.label).includes('Entire file'));
  await vscode.commands.executeCommand('ilasmDotnet.selectScope');
  await waitFor(() => viewerText().includes('Describe'), 30000);

  // A file with no build output still gets a node, so the reason is visible.
  state.findFiles = () => [];
  state.activeEditor = sourceEditor;
  for (const listener of state.activeEditorListeners) {
    listener(sourceEditor);
  }

  const rootsUnbuilt = await treeProvider.getChildren();
  const unbuilt = rootsUnbuilt.find((node: StubTreeNode) => node.kind === 'currentfile');
  check('a file without build output explains itself', Boolean(unbuilt?.problem?.includes('build')), String(unbuilt?.problem));

  // A live process gives an IL offset for every native instruction, which is the exact link.
  await killLeftoverTargets();
  const liveTarget = spawn('dotnet', [liveAssembly, '90'], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const ready = await waitFor(
      () => Boolean(liveTarget.pid),
      20000,
    );
    check('the live target process starts', Boolean(ready), String(liveTarget.pid));

    // Give the program a moment to warm its methods up, then attach through the command.
    await new Promise((resolve) => setTimeout(resolve, 4000));

    state.quickPickResult = (items: StubQuickPickItem[]) => items.find((item: StubQuickPickItem) => item.pid === liveTarget.pid) ?? items[0];
    await vscode.commands.executeCommand('ilasmDotnet.attachProcess');

    check(
      'attaching reports the process it read',
      state.informationMessages.some((message: string) => message.includes('attached') && message.includes(`pid ${liveTarget.pid}`)),
      state.informationMessages.at(-1),
    );
    check('attaching shows progress', state.progressTitles.some((title: string) => title.includes('reading process')), state.progressTitles.join('|'));
    check('the status bar mentions the live process', state.statusBarItems.some((item: StubStatusBarItem) => /live \d+/.test(item.text)), state.statusBarItems.map((item: StubStatusBarItem) => item.text).join('|'));

    // The assembly pane has to switch to the live route.
    await vscode.commands.executeCommand('ilasmDotnet.showPanel', { assembly: liveAssembly, file: liveSource });
    await vscode.commands.executeCommand('ilasmDotnet.selectKind', 'asm');

    const liveViewer = await waitFor(() => {
      const editor = state.editors.find((candidate: StubEditor) => candidate.document.uri.path === '/ILASM Dotnet');
      return editor && editor.document.getText().includes('Native code of') ? editor : undefined;
    }, 90000);

    check('the viewer shows a live assembly listing', Boolean(liveViewer));
    const liveText = liveViewer ? liveViewer.document.getText() : '';
    check('the live listing comes from the attached process', liveText.includes(`process ${liveTarget.pid}`), liveText.split('\n')[1]);
    check('the live listing annotates instructions with IL offsets', /; IL_[0-9A-Fa-f]{4}/.test(liveText), '');
    check('the live listing marks prolog and epilog', liveText.includes('; prolog') && liveText.includes('; epilog'), '');

    // Caret on an annotated instruction has to highlight the original source line.
    const liveSourceDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(liveSource));
    const liveSourceEditor = await vscode.window.showTextDocument(liveSourceDocument, { viewColumn: vscode.ViewColumn.One });
    liveSourceEditor.decorations.clear();

    const annotatedLine = liveText.split('\n').findIndex((line: string) => /; IL_[0-9A-Fa-f]{4}/.test(line));
    check('the live listing has an annotated instruction to place the caret on', annotatedLine > 0, String(annotatedLine));

    liveViewer.selection = { active: { line: annotatedLine, character: 0 } };
    for (const listener of state.selectionListeners) {
      listener({ textEditor: liveViewer });
    }

    check('a live instruction highlights the source line it implements', [...liveSourceEditor.decorations.values()].flat().length > 0);

    // Detaching goes back to reading the assembly from the JIT.
    await vscode.commands.executeCommand('ilasmDotnet.detachProcess');
    check('detaching is reported', state.informationMessages.some((message: string) => message.includes('detached')), state.informationMessages.at(-1));
  } finally {
    try {
      liveTarget.kill('SIGKILL');
    } catch {
      // The program already stopped.
    }
  }

  // A file that is not a managed assembly is an ordinary mistake, and it has to end in a sentence
  // that says what the file is instead of "unknown file format"; the path also stays in the tree
  // with that reason, because an entry that silently disappears looks like a broken extension.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ilasm-dotnet-native-'));
  const notAnImage = path.join(scratch, 'notes.txt');
  fs.writeFileSync(notAnImage, 'this file is not an image at all\n');

  state.openDialogResult = [vscode.Uri.file(notAnImage)];
  await vscode.commands.executeCommand('ilasmDotnet.openAssembly');

  check(
    'a file that is no assembly is reported as one',
    state.errorMessages.some((message: string) => message.includes('not a .NET assembly')),
    state.errorMessages.at(-1),
  );

  const rootsAfterFailure = await treeProvider.getChildren();
  const unreadable = rootsAfterFailure.find((node: StubTreeNode) => node.kind === 'assembly' && node.info.path === notAnImage);
  check('an unreadable path stays in the tree', Boolean(unreadable), rootsAfterFailure.map((node: StubTreeNode) => node.info?.path).join(','));
  check('the node carries the reason it could not be read', /not a \.NET assembly/.test(unreadable?.problem ?? ''), unreadable?.problem);

  const unreadableItem = treeProvider.getTreeItem(unreadable);
  check('the unreadable node shows the reason next to its name', unreadableItem.description === unreadable.problem, String(unreadableItem.description));
  check('the unreadable node cannot be expanded', unreadableItem.collapsibleState === vscode.TreeItemCollapsibleState.None);
  check('the unreadable node has no children', (await treeProvider.getChildren(unreadable)).length === 0);

  // The native route: a NativeAOT image has no IL, so the machine code is what the viewer shows of
  // it. The methods come from the debug information the compiler wrote beside the image.
  const published = publishNativeImage();
  if (published) {
    state.openDialogResult = [vscode.Uri.file(nativeImageFile)];
    state.quickPickResult = (items: StubQuickPickItem[]) => items.find((item: StubQuickPickItem) => item.label === 'AotTarget.Target.Sum') ?? items[0];

    await vscode.commands.executeCommand('ilasmDotnet.openAssembly');

    const nativeItem = await waitFor(() => {
      const editor = state.editors.find((candidate: StubEditor) => candidate.document.uri.path === '/ILASM Dotnet');
      return editor && editor.document.getText().includes('AotTarget.Target.Sum') ? editor : undefined;
    }, 30000);

    check('opening a native image shows the machine code of a method', Boolean(nativeItem));
    const nativeText = nativeItem ? nativeItem.document.getText() : '';
    check('the native listing holds instructions', /0x[0-9a-f]{8}\s{2}(push|mov|xor|test|sub|add)/.test(nativeText), nativeText.split('\n')[5]);
    check('the native listing names the debug file it read', nativeText.includes('AotTarget.dbg'), nativeText.split('\n')[1]);
    check('the native listing is the asm language', nativeItem?.document.languageId === 'il-asm', nativeItem?.document.languageId);

    const nativeSource = state.editors.find((editor: StubEditor) => editor.document.uri.fsPath === aotSource);
    check('the source file of the method opens beside it', Boolean(nativeSource), state.editors.map((editor: StubEditor) => editor.document.uri.fsPath).join(','));
    check(
      'the caret of the source file is on the method',
      (nativeSource?.selection?.active?.line ?? -1) + 1 === 13,
      String((nativeSource?.selection?.active?.line ?? -1) + 1),
    );
    check(
      'the status bar names the native view and the method it shows',
      state.statusBarItems.some((item: StubStatusBarItem) => /Native ASM · AotTarget\.Target\.Sum/.test(item.text)),
      state.statusBarItems.map((item: StubStatusBarItem) => item.text).join(' | '),
    );

    // The row above the code offers one view, not four: there is no IL and no C# in this image.
    const nativeLenses =
      state.codeLensProviders
        .find((entry: StubCodeLensEntry) => entry.selector.scheme === 'ilasm-dotnet')
        ?.provider.provideCodeLenses(nativeItem.document) ?? [];
    check('the row of a native image offers only the machine code', nativeLenses.length === 2, nativeLenses.map((lens: StubCodeLens) => lens.command?.title).join('|'));
    check('the row of a native image marks that view active', nativeLenses[0]?.command?.title === '● Native ASM', nativeLenses[0]?.command?.title);

    const switched = await vscode.commands.executeCommand('ilasmDotnet.selectKind', 'il');
    // The refusal is what the checks below read, not the result of the command.
    void switched;
    check(
      'switching a native image to IL is refused with the reason',
      state.informationMessages.some((message: string) => message.includes('no IL')),
      state.informationMessages.at(-1),
    );
    const afterRefusal = state.editors.find((editor: StubEditor) => editor.document.uri.path === '/ILASM Dotnet');
    check(
      'the refused switch leaves the machine code on screen',
      afterRefusal?.document.getText().includes('AotTarget.Target.Sum') === true && afterRefusal?.document.languageId === 'il-asm',
      afterRefusal?.document.languageId,
    );

    // The tree lists a native image with its methods instead of hiding it as unreadable.
    const rootsWithNative = await treeProvider.getChildren();
    const nativeNode = rootsWithNative.find((node: StubTreeNode) => node.kind === 'nativeimage' && node.info.path === nativeImageFile);
    check('a native image is a node of the tree', Boolean(nativeNode), rootsWithNative.map((node: StubTreeNode) => node.info?.path).join(','));
    check('the node reports the machine of the image', /x86-64/.test(treeProvider.getTreeItem(nativeNode).description ?? ''), String(treeProvider.getTreeItem(nativeNode).description));

    const nativeMethods = await treeProvider.getChildren(nativeNode);
    check('the node lists the methods of the image', nativeMethods.length >= 3, String(nativeMethods.length));
    const sumNode = nativeMethods.find((node: StubTreeNode) => node.method?.fullName === 'AotTarget.Target.Sum');
    check('a method node names the method', Boolean(sumNode), nativeMethods.map((node: StubTreeNode) => node.method?.fullName).join(','));
    const sumItem = treeProvider.getTreeItem(sumNode);
    check('a method node shows the source line it came from', sumItem.description === 'Target.cs:13', String(sumItem.description));
    check('a method node opens the code of it', sumItem.command?.command === 'ilasmDotnet.openInViewer', sumItem.command?.command);

    await vscode.commands.executeCommand(sumItem.command.command, ...sumItem.command.arguments);
    const reopened = await waitFor(() => {
      const editor = state.editors.find((candidate: StubEditor) => candidate.document.uri.path === '/ILASM Dotnet');
      return editor && editor.document.getText().includes('AotTarget.Target.Sum') ? editor : undefined;
    }, 30000);
    check('a method node reopens the machine code of that method', Boolean(reopened));
    check('the reopening keeps the source file beside it', state.editors.some((editor: StubEditor) => editor.document.uri.fsPath === aotSource));
  } else {
    console.log('  skip the native route checks — the NativeAOT publish failed');
  }

  // A single file application is the third shape a workspace holds: the file to open is the
  // executable, and the assembly inside it is what every view of the viewer reads.
  if (publishSingleFile()) {
    state.openDialogResult = [vscode.Uri.file(singleImageFile)];
    state.quickPickResult = (items: StubQuickPickItem[]) => items.find((item: StubQuickPickItem) => item.label === 'LiveTarget.Target') ?? items[0];

    await vscode.commands.executeCommand('ilasmDotnet.openAssembly');

    const singleEditor = await waitFor(() => {
      const editor = state.editors.find((candidate: StubEditor) => candidate.document.uri.path === '/ILASM Dotnet');
      return editor && editor.document.getText().includes('LiveTarget.Target') ? editor : undefined;
    }, 30000);

    check('a single file application opens in the viewer', Boolean(singleEditor), state.editors.map((editor: StubEditor) => editor.document.uri.path).join(','));
    check('the view of a single file application holds IL', singleEditor?.document.getText().includes('.class') === true, singleEditor?.document.getText().slice(0, 60));
    check(
      'the view says the assembly was taken out of the bundle',
      state.statusBarItems.some((item: StubStatusBarItem) => String(item.tooltip).includes('single file application')),
      state.statusBarItems.map((item: StubStatusBarItem) => String(item.tooltip)).join(' | '),
    );

    const singleSource = state.editors.find((editor: StubEditor) => editor.document.uri.fsPath === liveSource);
    check('the source of a single file application opens beside the view', Boolean(singleSource), state.editors.map((editor: StubEditor) => editor.document.uri.fsPath).join(','));

    const singleRoots = await treeProvider.getChildren();
    const singleNode = singleRoots.find((node: StubTreeNode) => node.kind === 'assembly' && node.info.path === singleImageFile);
    check('a single file application is a node of the tree', Boolean(singleNode), singleRoots.map((node: StubTreeNode) => node.info?.path).join(','));
    check('the node of a single file application reports its types', (singleNode?.info?.typeCount ?? 0) >= 3, String(singleNode?.info?.typeCount));
    check('the node of a single file application finds its PDB', singleNode?.info?.hasPdb === true, String(singleNode?.info?.hasPdb));
  } else {
    console.log('  skip the single file checks — the publish failed');
  }

  // A project published with NativeAOT has no assembly anywhere: the output is the image itself, and
  // a command for the current file has to open its machine code instead of failing in every pane of
  // the managed route. This is also what the locator has to prefer: an assembly when there is one,
  // the executable only when there is none.
  state.findFiles = (pattern: StubFindFilesPattern) => {
    const isRelative = pattern !== null && typeof pattern === 'object';
    const base = isRelative ? pattern.base : '';
    const glob = isRelative ? pattern.pattern : String(pattern ?? '');

    if (glob.includes('csproj')) {
      return base === aotDirectory ? [vscode.Uri.file(aotProject)] : [];
    }

    if (base === aotDirectory && glob.endsWith('AotTarget')) {
      return fs.existsSync(nativeImageFile) ? [vscode.Uri.file(nativeImageFile)] : [];
    }

    if (base === liveDirectory && glob.endsWith('LiveTarget.dll')) {
      return [vscode.Uri.file(liveAssembly)];
    }

    // The host executable of an ordinary build sits next to the assembly; it must be ignored.
    if (base === liveDirectory && glob.endsWith('LiveTarget')) {
      return fs.existsSync(singleImageFile) ? [vscode.Uri.file(singleImageFile)] : [];
    }

    return [];
  };

  if (published) {
    const targetDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(aotSource));
    const targetEditor = await vscode.window.showTextDocument(targetDocument, { viewColumn: vscode.ViewColumn.One });
    const sumLine = fs.readFileSync(aotSource, 'utf8').split('\n').findIndex((line) => line.includes('total += value')) ;
    targetEditor.selection = { active: { line: sumLine, character: 0 }, anchor: { line: sumLine, character: 0 } };

    const editorsBefore = state.editors.length;
    await vscode.commands.executeCommand('ilasmDotnet.openForCurrentLine');

    const nativeFromEditor = await waitFor(() => {
      const editor = state.editors.find((candidate: StubEditor) => candidate.document.uri.path === '/ILASM Dotnet');
      return editor && editor.document.getText().includes('AotTarget.Target.Sum') ? editor : undefined;
    }, 30000);

    check('a command for a file of a NativeAOT project opens the machine code', Boolean(nativeFromEditor));
    check('the machine code of the line is what opens', nativeFromEditor?.document.getText().includes('0x') === true);
    const openedHere = state.editors.slice(editorsBefore);
    check(
      'no pane of the managed route is opened for it',
      openedHere.every((editor: StubEditor) => editor.document.languageId === 'il-asm'),
      openedHere.map((editor: StubEditor) => `${editor.document.uri.path}:${editor.document.languageId}`).join(','),
    );
    check(
      'no view reports that it could not read the image',
      !state.editors.some((editor: StubEditor) => editor.document.getText().includes('could not read this view')),
      state.editors.map((editor: StubEditor) => editor.document.uri.path).join(','),
    );

    // The current-file section of the tree lists what that file was compiled into.
    // The current-file section follows the active editor, and opening the viewer made it active, so
    // the source file is brought back the way a reader would.
    state.activeEditor = targetEditor;
    for (const listener of state.activeEditorListeners) {
      listener(targetEditor);
    }

    const fileRoots = await treeProvider.getChildren();
    const fileNode = fileRoots.find((node: StubTreeNode) => node.kind === 'currentfile' && node.file === aotSource);
    check('the tree keeps a node for the file of a native image', Boolean(fileNode), fileRoots.map((node: StubTreeNode) => node.file ?? node.info?.path).join(','));
    const fileMethods = fileNode ? await treeProvider.getChildren(fileNode) : [];
    check('the node of the file lists the methods of the image', fileMethods.length >= 3, String(fileMethods.length));
    check(
      'the node says the file is part of a native image',
      /native image/.test(treeProvider.getTreeItem(fileNode).description ?? ''),
      String(treeProvider.getTreeItem(fileNode).description),
    );
  } else {
    console.log('  skip the native project checks — the NativeAOT publish failed');
  }

  // An ordinary project keeps opening as an assembly even though an executable sits next to the dll.
  const ordinaryDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(liveSource));
  const ordinaryEditor = await vscode.window.showTextDocument(ordinaryDocument, { viewColumn: vscode.ViewColumn.One });
  ordinaryEditor.selection = { active: { line: 11, character: 0 }, anchor: { line: 11, character: 0 } };
  await vscode.commands.executeCommand('ilasmDotnet.openForFile');

  const managedFromEditor = await waitFor(() => {
    const editor = state.editors.find((candidate: StubEditor) => candidate.document.languageId === 'il');
    return editor && editor.document.getText().includes('IL_') ? editor : undefined;
  }, 30000);
  check('a file of an ordinary project still opens its assembly', Boolean(managedFromEditor));
  check(
    'the host executable next to the assembly is not what gets read',
    state.editors.every((editor: StubEditor) => editor.document.uri.fsPath !== singleImageFile),
    state.editors.map((editor: StubEditor) => editor.document.uri.fsPath).join(','),
  );

  fs.rmSync(scratch, { recursive: true, force: true });


  // The viewer reads an assembly; the language of the file it was opened from is only how that
  // assembly is found. An F# project is a project like any other, so the same commands have to work
  // for it, and a save of a `.fs` file has to drop the caches the same way a `.cs` save does.
  if (fs.existsSync(fsAssembly)) {
    state.findFiles = (pattern: StubFindFilesPattern) => {
      const isRelative = pattern !== null && typeof pattern === 'object';
      const base = isRelative ? pattern.base : '';
      const glob = isRelative ? pattern.pattern : String(pattern ?? '');

      if (glob.includes('fsproj')) {
        return [vscode.Uri.file(fsProject)];
      }

      if (base === fsDirectory && glob.endsWith('FsTarget.dll')) {
        return [vscode.Uri.file(fsAssembly)];
      }

      return [];
    };

    const fsDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(fsSource));
    const fsEditor = await vscode.window.showTextDocument(fsDocument, { viewColumn: vscode.ViewColumn.One });
    fsEditor.selection = { active: { line: 26, character: 0 }, anchor: { line: 26, character: 0 } };

    const fsRoots = await treeProvider.getChildren();
    const fsNode = fsRoots.find((node: StubTreeNode) => node.kind === 'currentfile');
    check('the tree follows an F# file to its assembly', Boolean(fsNode) && !fsNode.problem, String(fsNode?.problem ?? fsNode?.file));
    check('the tree attaches the F# file to the assembly of its project', fsNode?.assembly === fsAssembly, String(fsNode?.assembly));

    const fsTypes = fsNode ? await treeProvider.getChildren(fsNode) : [];
    const fsLabels = fsTypes.map((node: StubTreeNode) => String(treeProvider.getTreeItem(node).label));
    check('the types declared in an F# file are listed', fsLabels.some((label: string) => label.endsWith('Catalog')), fsLabels.join(','));

    await vscode.commands.executeCommand('ilasmDotnet.openForCurrentLine');
    const fsViewer = await waitFor(() => {
      const editor = state.editors.find(
        (candidate: StubEditor) => candidate.document.languageId === 'il' && candidate.document.getText().includes('FsTarget.Catalog'),
      );
      return editor || undefined;
    }, 30000);
    check('a command for an F# file opens the IL of its assembly', Boolean(fsViewer), state.editors.map((editor: StubEditor) => editor.document.languageId).join(','));
    check(
      'the IL of an F# member links back to the .fs file',
      Boolean(fsViewer) && fsViewer.document.getText().includes('.method'),
      fsViewer ? fsViewer.document.getText().split('\n')[0] : '',
    );
  } else {
    console.log('  skip the F# checks — the fixture could not be built');
  }

  // Shutting the extension down stops the engine through the context subscriptions.
  const disposables = context.subscriptions.filter((item) => typeof item?.dispose === 'function');
  check('activate contributes disposables to the context', disposables.length >= 6, String(disposables.length));
  for (const disposable of disposables) {
    disposable.dispose();
  }

  console.log(`\n${checkCount - failures.length}/${checkCount} checks passed`);
  if (failures.length > 0) {
    console.error(`failures:\n - ${failures.join('\n - ')}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  // The engine child keeps the event loop alive, so exit explicitly instead of hanging.
  process.exit(1);
});
