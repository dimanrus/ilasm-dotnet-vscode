'use strict';
// Runs inside a real VS Code extension host (--extensionTestsPath). Verifies what the stubbed
// integration test cannot: real language detection for the ilasm-dotnet documents, real editor
// integration, and that the whole path (command -> locator -> engine -> editors) works live.
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const vscode = require('vscode');

const failures = [];
let total = 0;

function check(name, condition, detail) {
  total++;
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    const suffix = detail === undefined ? '' : ` — ${detail}`;
    failures.push(`${name}${suffix}`);
    console.log(`  FAIL ${name}${suffix}`);
  }
}

/**
 * The fixture sources live in the repository, which is also the workspace when this test runs from
 * a packaged VSIX. Fall back to the extension folder for a development host started without one.
 */
function resolveFixtureRoot(extensionPath) {
  const folders = (vscode.workspace.workspaceFolders || []).map((folder) => folder.uri.fsPath);
  for (const folder of folders) {
    if (fs.existsSync(path.join(folder, 'test', 'fixtures', 'SampleLib', 'Calculator.cs'))) {
      return folder;
    }
  }

  return extensionPath;
}

async function waitFor(predicate, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value) {
      return value;
    }

    if (Date.now() > deadline) {
      return undefined;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * Kills leftover fixture processes, so an attach cannot pick an instance an earlier run left behind.
 */
function killLeftoverTargets() {
  for (const entry of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) {
      continue;
    }

    let command;
    try {
      command = fs.readFileSync(path.join('/proc', entry, 'cmdline'), 'utf8').replace(/\0/g, ' ');
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
}

/** Starts the long running fixture and resolves once it reports that its methods ran. */
function startLiveTarget(targetPath) {
  const target = spawn('dotnet', [targetPath, '90'], { stdio: ['ignore', 'pipe', 'pipe'] });

  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('the live target did not become ready')), 60000);
    const fail = (error) => {
      clearTimeout(timer);
      reject(error);
    };

    target.stdout.on('data', (chunk) => {
      output += String(chunk);
      if (output.includes('ready')) {
        clearTimeout(timer);
        resolve(target);
      }
    });
    target.on('error', fail);
    target.on('exit', () => fail(new Error('the live target exited before it was ready')));
  });
}

/**
 * The live route is the only one that reports an IL offset for every native instruction, so this
 * attaches to a real process and walks the whole link inside a real editor.
 */
async function checkLiveRoute(root) {
  const liveAssembly = path.join(root, 'test', 'fixtures', 'LiveTarget', 'bin', 'Release', 'net8.0', 'LiveTarget.dll');
  const liveSource = path.join(root, 'test', 'fixtures', 'LiveTarget', 'Target.cs');
  check('the live target is built in release', fs.existsSync(liveAssembly), liveAssembly);
  if (!fs.existsSync(liveAssembly)) {
    return;
  }

  killLeftoverTargets();
  const target = await startLiveTarget(liveAssembly);

  try {
    await vscode.commands.executeCommand('ilasmDotnet.attachProcess', target.pid);
    await vscode.commands.executeCommand('ilasmDotnet.showPanel', { assembly: liveAssembly, file: liveSource });
    await vscode.commands.executeCommand('ilasmDotnet.selectKind', 'asm');

    const liveEditor = await waitFor(() => {
      const found = vscode.window.visibleTextEditors.find(
        (editor) => editor.document.uri.scheme === 'ilasm-dotnet' && editor.document.getText().includes(`process ${target.pid}`),
      );
      return found;
    }, 120000);

    check('the live assembly view opens for the attached process', Boolean(liveEditor));
    if (!liveEditor) {
      return;
    }

    check('VS Code assigns the il-asm language to the live view', liveEditor.document.languageId === 'il-asm', liveEditor.document.languageId);

    const text = liveEditor.document.getText();
    const lines = text.split('\n');
    check(
      'the live view annotates instructions with IL offsets',
      (text.match(/; IL_[0-9A-Fa-f]{4}/g) || []).length >= 5,
      String((text.match(/; IL_[0-9A-Fa-f]{4}/g) || []).length),
    );
    check('the live view marks the prolog and the epilog', text.includes('; prolog') && text.includes('; epilog'), '');

    // A caret on an instruction must resolve to the source line it implements, through the very
    // command the status bar advertises.
    const addHeader = lines.findIndex((line) => line.startsWith('; ──') && line.includes('Add'));
    const instructionLine = lines.findIndex((line, index) => index > addHeader && /; IL_[0-9A-Fa-f]{4}/.test(line));
    check('the live listing starts with the warmed methods', addHeader >= 0 && instructionLine > addHeader, `${addHeader}/${instructionLine}`);

    await vscode.window.showTextDocument(liveEditor.document, { viewColumn: liveEditor.viewColumn });
    const position = new vscode.Position(instructionLine, 0);
    liveEditor.selection = new vscode.Selection(position, position);
    await new Promise((resolve) => setTimeout(resolve, 500));
    await vscode.commands.executeCommand('ilasmDotnet.goToSource');

    const expectedLine = fs.readFileSync(liveSource, 'utf8').split('\n').findIndex((line) => line.includes('Add(int a, int b)'));
    const landed = await waitFor(() => {
      const editor = vscode.window.activeTextEditor;
      return editor && editor.document.uri.fsPath === liveSource ? editor : undefined;
    }, 20000);

    check(
      'a live instruction jumps to the source line it implements',
      Boolean(landed) && landed.selection.active.line === expectedLine,
      `${landed ? landed.selection.active.line : 'no editor'} vs ${expectedLine}`,
    );

    await vscode.commands.executeCommand('ilasmDotnet.detachProcess');

    // Detaching has to put the assembly view back on the JIT harness route.
    const detached = await waitFor(() => {
      const text = liveEditor.document.getText();
      return text.includes('; ') && !text.includes(`process ${target.pid}`) ? text : undefined;
    }, 120000);
    check('detaching returns the view to the JIT listing', Boolean(detached), detached ? 'still live' : 'the view did not refresh');
  } finally {
    try {
      target.kill('SIGKILL');
    } catch {
      // The program already stopped.
    }
  }
}

async function run() {
  const extension = vscode.extensions.all.find((candidate) => candidate.packageJSON.name === 'ilasm-dotnet');
  check('the extension is discovered by VS Code', Boolean(extension));
  if (!extension) {
    throw new Error('extension not found');
  }

  await extension.activate();
  check('the extension activates', extension.isActive);

  const root = resolveFixtureRoot(extension.extensionPath);
  const sourcePath = path.join(root, 'test', 'fixtures', 'SampleLib', 'Calculator.cs');
  const assemblyPath = path.join(root, 'test', 'fixtures', 'SampleLib', 'bin', 'Debug', 'net10.0', 'SampleLib.dll');
  check('the fixture sources are reachable', fs.existsSync(sourcePath), sourcePath);
  check('the fixture assembly is built', fs.existsSync(assemblyPath), assemblyPath);
  check(
    'the extension ships the published engine',
    fs.existsSync(path.join(extension.extensionPath, 'out', 'engine', 'IlasmDotnet.Engine.dll')),
    path.join(extension.extensionPath, 'out', 'engine'),
  );

  const sourceDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(sourcePath));
  const sourceEditor = await vscode.window.showTextDocument(sourceDocument, { viewColumn: vscode.ViewColumn.One });
  check('the fixture source file opens', sourceDocument.languageId === 'csharp', sourceDocument.languageId);

  // Place the caret on a statement inside Describe, located from the fixture text itself.
  const anchorLine = fs.readFileSync(sourcePath, 'utf8').split('\n').findIndex((line) => line.includes('return "negative"'));
  check('the fixture exposes an anchor line inside Describe', anchorLine > 0, String(anchorLine));
  const position = new vscode.Position(anchorLine, 8);
  sourceEditor.selection = new vscode.Selection(position, position);

  await vscode.commands.executeCommand('ilasmDotnet.openForCurrentLine');

  const viewerEditors = await waitFor(() => {
    const found = vscode.window.visibleTextEditors.filter((editor) => editor.document.uri.scheme === 'ilasm-dotnet');
    return found.length >= 2 ? found : undefined;
  });

  check('opening the viewer shows at least two panels', Boolean(viewerEditors), 'no ilasm-dotnet editors appeared');
  check(
    'opening the views as separate tabs leaves no empty group',
    vscode.window.tabGroups.all.every((group) => group.tabs.length > 0),
    JSON.stringify(vscode.window.tabGroups.all.map((group) => [group.viewColumn, group.tabs.map((tab) => tab.label)])),
  );
  if (!viewerEditors) {
    throw new Error('viewer did not open');
  }

  const ilEditor = viewerEditors.find((editor) => editor.document.uri.path.endsWith('.il'));
  const csharpEditor = viewerEditors.find((editor) => editor.document.uri.path.endsWith('.cs'));

  check('the IL panel opens', Boolean(ilEditor));
  check('the decompiled C# panel opens', Boolean(csharpEditor));
  check('the IL panel targets the member under the caret', ilEditor ? ilEditor.document.uri.path.includes('Describe') : false, ilEditor && ilEditor.document.uri.path);
  check('VS Code assigns the il language from the uri', ilEditor && ilEditor.document.languageId === 'il', ilEditor && ilEditor.document.languageId);
  check('VS Code assigns the csharp language from the uri', csharpEditor && csharpEditor.document.languageId === 'csharp', csharpEditor && csharpEditor.document.languageId);

  const ilText = ilEditor.document.getText();
  check('the IL document contains instructions', /IL_[0-9A-F]{4}:/.test(ilText));
  check('the IL document contains sequence points', ilText.includes('sequence point'));
  check('the IL document contains the method header', ilText.includes('.method'));
  check('the C# document contains the decompiled method', csharpEditor.document.getText().includes('Describe'));

  // Document links must resolve to the real file on disk.
  const links = await vscode.commands.executeCommand('vscode.executeLinkProvider', ilEditor.document.uri, 2000);
  check('VS Code resolves the sequence point links', Array.isArray(links) && links.length > 0, Array.isArray(links) ? String(links.length) : typeof links);
  if (Array.isArray(links) && links.length > 0) {
    check('a link points at the fixture source file', links[0].target.fsPath.endsWith('Calculator.cs'), links[0].target.fsPath);
    check('a link carries a line fragment', /^L\d+$/.test(links[0].target.fragment), links[0].target.fragment);
  }

  // Moving the caret inside the IL view must not throw and must keep the panels alive.
  const mappedLine = ilText.split('\n').findIndex((line) => /IL_[0-9A-F]{4}:/.test(line));
  if (mappedLine >= 0) {
    ilEditor.selection = new vscode.Selection(new vscode.Position(mappedLine, 0), new vscode.Position(mappedLine, 0));
    await new Promise((resolve) => setTimeout(resolve, 400));
    check('the IL panel survives caret synchronisation', !ilEditor.document.isClosed);
  }

  // The assemblies tree view is contributed and reachable.
  const treeCommands = await vscode.commands.getCommands(true);
  check('the contributed commands are registered', treeCommands.includes('ilasmDotnet.showPanel') && treeCommands.includes('ilasmDotnet.refresh'));

  // The ASM pane: the extension starts the JIT harness and shows real native code.
  await vscode.window.showTextDocument(ilEditor.document, { viewColumn: vscode.ViewColumn.Active });
  await vscode.commands.executeCommand('ilasmDotnet.showAsm');

  const asmEditor = await waitFor(
    () => vscode.window.visibleTextEditors.find((editor) => editor.document.uri.path.endsWith('.asm')),
    30000,
  );

  check('the ASM pane opens in a real host', Boolean(asmEditor));
  check('VS Code assigns the il-asm language', asmEditor?.document.languageId === 'il-asm', asmEditor?.document.languageId);

  const asmText = asmEditor ? asmEditor.document.getText() : '';
  check('the ASM pane contains a JIT listing', /; Assembly listing for method /.test(asmText));
  check('the ASM pane contains native instructions', /\bmov\b|\blea\b|\bpush\b/.test(asmText));
  check('the ASM pane names the disassembled method', asmText.includes('SampleLib.Calculator:Describe'), asmText.split('\n').slice(0, 6).join(' | '));
  check('the ASM pane reports a code size', /; Total bytes of code \d+/.test(asmText));

  // Caret synchronisation must survive with three panes open.
  if (asmEditor) {
    const instructionLine = asmText.split('\n').findIndex((line) => /^ {2,}[a-z]/.test(line));
    if (instructionLine > 0) {
      const position2 = new vscode.Position(instructionLine, 0);
      asmEditor.selection = new vscode.Selection(position2, position2);
      await new Promise((resolve) => setTimeout(resolve, 400));
      check('the ASM pane survives caret synchronisation', !asmEditor.document.isClosed);
    }
  }

  // The viewer as one native tab, with the switcher row in place of a dropdown.
  await vscode.window.showTextDocument(sourceDocument, { viewColumn: vscode.ViewColumn.Active });
  await vscode.commands.executeCommand('ilasmDotnet.showPanel');

  // The session tab is the document without a per-target suffix in its name.
  const isSessionDocument = (editor) => editor.document.uri.scheme === 'ilasm-dotnet' && editor.document.uri.path === '/ILASM Dotnet';

  const sessionEditors = await waitFor(() => {
    const found = vscode.window.visibleTextEditors.filter(isSessionDocument);
    return found.length > 0 ? found : undefined;
  }, 30000);

  check('the viewer opens a native editor', Boolean(sessionEditors), 'no ilasm-dotnet session editor appeared');

  // The whole point of the request: the code stays visible on the left of the viewer.
  const viewerColumn = sessionEditors && sessionEditors.length > 0 ? sessionEditors[0].viewColumn : undefined;
  const sourceColumn = sourceEditor.viewColumn;
  check('the viewer opens in its own column', viewerColumn !== undefined && viewerColumn !== sourceColumn, `viewer=${viewerColumn} source=${sourceColumn}`);
  check('the source file stays visible next to the viewer', vscode.window.visibleTextEditors.some((editor) => editor.document.uri.fsPath === sourcePath), '');

  const viewerTab = vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .find((tab) => tab.label === 'ILASM Dotnet');
  check('the tab is named ILASM Dotnet', Boolean(viewerTab), vscode.window.tabGroups.all.flatMap((group) => group.tabs).map((tab) => tab.label).join(','));

  const viewerEditor = sessionEditors ? sessionEditors[0] : undefined;
  check('VS Code assigns the il language', viewerEditor?.document.languageId === 'il', viewerEditor?.document.languageId);
  check('the viewer holds the whole file IL', /IL_[0-9A-F]{4}:/.test(viewerEditor ? viewerEditor.document.getText() : ''), '');
  check('the viewer text is readable, so native find and copy work', (viewerEditor?.document.getText().split('\n').length ?? 0) > 50, String(viewerEditor?.document.getText().split('\n').length));

  // The clickable row is a real CodeLens, which is what replaces the dropdown.
  const lenses = await vscode.commands.executeCommand('vscode.executeCodeLensProvider', viewerEditor.document.uri, 2000);
  check('the switcher row is provided as code lenses', Array.isArray(lenses) && lenses.length >= 4, Array.isArray(lenses) ? String(lenses.length) : typeof lenses);
  if (Array.isArray(lenses) && lenses.length > 0) {
    const titles = lenses.map((lens) => lens.command && lens.command.title).join(' · ');
    check(
      'the row offers every view',
      ['IL code', 'C# (high level)', 'C# (low level)', 'Native ASM'].every((label) => titles.includes(label)),
      titles,
    );
    check('the row marks the active view', titles.includes('● IL code'), titles);
    check('the row offers the scope picker', titles.includes('Scope:'), titles);
  }

  // The low-level flavour of the C# view shows the lowered code, generated state machine included.
  await vscode.commands.executeCommand('ilasmDotnet.selectKind', 'csharpLow');
  const lowLevel = await waitFor(
    () => (viewerEditor.document.getText().includes('IteratorStateMachine') ? viewerEditor : undefined),
    60000,
  );
  check('the low level C# view opens in a real host', Boolean(lowLevel), viewerEditor.document.getText().slice(0, 120));
  check('the low level view counts as C# for the editor', viewerEditor.document.languageId === 'csharp', viewerEditor.document.languageId);
  check('the low level view does not pretend to be an iterator', !viewerEditor.document.getText().includes('yield return'), '');

  // Switching the view changes the document language and its content, without a second tab.
  await vscode.commands.executeCommand('ilasmDotnet.selectKind', 'asm');
  const asmViewer = await waitFor(
    () => sessionEditors.find((editor) => editor.document.languageId === 'il-asm' && editor.document.getText().includes('Assembly listing')),
    90000,
  );

  check('switching the view changes the document language', Boolean(asmViewer), sessionEditors.map((editor) => editor.document.languageId).join(','));
  check('the ASM view holds a real JIT listing', Boolean(asmViewer && /; Assembly listing for method /.test(asmViewer.document.getText())));

  const tabsAfterSwitch = vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .filter((tab) => tab.label === 'ILASM Dotnet');
  check('switching keeps a single tab', tabsAfterSwitch.length === 1, String(tabsAfterSwitch.length));

  // The tree's current-file node calls the command with an explicit file.
  await vscode.commands.executeCommand('ilasmDotnet.showPanel', { assembly: assemblyPath, file: sourcePath });
  const backToIl = await waitFor(() => {
    const editor = sessionEditors.find((candidate) => candidate.document.languageId === 'il');
    return editor && editor.document.getText().includes('IL_0000:') ? editor : undefined;
  }, 60000);
  check('the command accepts the arguments the tree passes', Boolean(backToIl));

  // A viewer must not keep user edits: either the edit is refused or it is reverted by the extension.
  const beforeEdit = viewerEditor.document.getText();
  const applied = await viewerEditor.edit((builder) => builder.insert(new vscode.Position(0, 0), 'XX'));
  const reverted = await waitFor(() => (viewerEditor.document.getText() === beforeEdit ? true : undefined), 20000);
  check('the viewer document does not keep edits', applied === false || reverted === true, `applied=${applied}`);

  // A settings change has to reach the pane that is already open, without reopening it.
  await vscode.commands.executeCommand('ilasmDotnet.selectKind', 'csharp');
  await waitFor(
    () => viewerEditor.document.languageId === 'csharp' && viewerEditor.document.getText().includes('public int Add'),
    60000,
  );

  const beforeSetting = viewerEditor.document.getText();
  check('the C# view hides the compiler generated members by default', !beforeSetting.includes('nested type'), beforeSetting.slice(0, 120));

  const configuration = vscode.workspace.getConfiguration('ilasmDotnet');
  await configuration.update('includeCompilerGenerated', true, vscode.ConfigurationTarget.Workspace);
  const afterSetting = await waitFor(
    () => (viewerEditor.document.getText().includes('nested type') ? viewerEditor.document.getText() : undefined),
    60000,
  );
  check('a settings change re-reads the open viewer', Boolean(afterSetting), viewerEditor.document.getText().slice(0, 120));

  await configuration.update('includeCompilerGenerated', false, vscode.ConfigurationTarget.Workspace);
  await waitFor(() => viewerEditor.document.getText() === beforeSetting, 60000);
  check('the pane follows the setting back', viewerEditor.document.getText() === beforeSetting, `len=${viewerEditor.document.getText().length} expected=${beforeSetting.length}`);

  // The panes follow the caret, and not only by highlighting: a match outside the visible part has to
  // be brought into view, otherwise a listing of a whole file forces the user to scroll by hand.
  await vscode.commands.executeCommand('ilasmDotnet.showPanel', { assembly: assemblyPath, file: sourcePath });
  const fileIlEditor = await waitFor(() => {
    const editor = sessionEditors.find(
      (candidate) => candidate.document.languageId === 'il' && candidate.document.getText().includes('IL_0000:'),
    );
    return editor;
  }, 60000);
  check('the whole-file IL view is in the session tab', Boolean(fileIlEditor), viewerEditor.document.languageId);

  const ilLines = fileIlEditor.document.getText().split('\n');
  const describeHeader = ilLines.findIndex((line) => line.includes('Describe ('));
  const describeEnd = ilLines.findIndex((line) => line.includes('end of method Calculator::Describe'));
  check('the listing holds the method to scroll to', describeHeader > 100 && describeEnd > describeHeader, `${describeHeader}/${describeEnd}`);

  fileIlEditor.revealRange(new vscode.Range(0, 0, 0, 0), vscode.TextEditorRevealType.AtTop);
  await new Promise((resolve) => setTimeout(resolve, 500));
  check('the viewer is scrolled to the top before the probe', (fileIlEditor.visibleRanges[0]?.start.line ?? 0) < 5, String(fileIlEditor.visibleRanges[0]?.start.line));

  sourceEditor.selection = new vscode.Selection(anchorLine, 0, anchorLine, 0);
  const scrolledInto = await waitFor(() => {
    const visible = fileIlEditor.visibleRanges[0];
    return visible && visible.start.line <= describeEnd && visible.end.line >= describeHeader ? visible : undefined;
  }, 20000);
  check(
    'a caret in the source scrolls the IL pane to the matching method',
    Boolean(scrolledInto),
    fileIlEditor.visibleRanges.map((range) => `${range.start.line}-${range.end.line}`).join(','),
  );

  // The C# of what the tab shows can be copied, and one command reports what a bug report needs.
  await vscode.env.clipboard.writeText('');
  await vscode.commands.executeCommand('ilasmDotnet.copyCsharp');
  const clipboard = await vscode.env.clipboard.readText();
  check('the C# of the view reaches the clipboard', clipboard.includes('SampleLib.Calculator'), clipboard.slice(0, 80));

  const beforeDiagnostics = new Set(vscode.window.visibleTextEditors.map((editor) => editor.document.uri.toString()));
  await vscode.commands.executeCommand('ilasmDotnet.showDiagnostics');
  const diagnosticsReport = await waitFor(
    () =>
      vscode.window.visibleTextEditors.find(
        (editor) =>
          !beforeDiagnostics.has(editor.document.uri.toString()) && editor.document.getText().includes('ILASM Dotnet diagnostics'),
      ),
    30000,
  );
  check('diagnostics open a report', Boolean(diagnosticsReport), 'no report appeared');
  check(
    'the report names the runtime and the assembly in view',
    Boolean(diagnosticsReport) &&
      diagnosticsReport.document.getText().includes('node in the extension host') &&
      diagnosticsReport.document.getText().includes('SampleLib'),
    diagnosticsReport ? diagnosticsReport.document.getText().split('\n')[3] : '',
  );

  // Phase 3: the live route, which is what makes the ASM to IL link exact.
  await checkLiveRoute(root);

  // Phase 4: the listing has to be real IL, so a real assembler is given the whole assembly.
  const roundTrip = await vscode.commands.executeCommand('ilasmDotnet.roundTripIl', { assembly: assemblyPath });
  check('ilasm assembles the whole listing', roundTrip && roundTrip.success === true, roundTrip && roundTrip.output.split('\n').at(-1));
  check('the assembled assembly keeps every type', roundTrip && roundTrip.roundTripTypes === roundTrip.originalTypes, roundTrip && `${roundTrip.roundTripTypes}/${roundTrip.originalTypes}`);
  check('the assembled assembly keeps every method', roundTrip && roundTrip.roundTripMethods === roundTrip.originalMethods, roundTrip && `${roundTrip.roundTripMethods}/${roundTrip.originalMethods}`);
  check('the round-trip reports no differences', roundTrip && roundTrip.differences.length === 0, roundTrip && JSON.stringify(roundTrip.differences));
  check(
    'the generated listing opens in a real editor',
    Boolean(roundTrip) &&
      vscode.window.visibleTextEditors.some(
        (candidate) => candidate.document.uri.scheme === 'file' && candidate.document.uri.fsPath.endsWith('.il'),
      ),
    roundTrip && roundTrip.ilPath,
  );
  check('the extension ships the assembler', Boolean(roundTrip) && roundTrip.ilasmPath.includes('ilasm'), roundTrip && roundTrip.ilasmPath);

  // A node of the tree stands for a type or a member, and clicking it has to land in the same single
  // tab with the code of it. With nothing else open it must not split the window either: an empty
  // group showing the "open a file" page reads as a broken layout, not as a place to put the viewer.
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await new Promise((resolve) => setTimeout(resolve, 1500));
  await vscode.commands.executeCommand('ilasmDotnet.openInViewer', {
    assembly: assemblyPath,
    token: 0x02000002,
    title: 'SampleLib.Calculator',
    isType: true,
  });

  const fromTree = await waitFor(
    () =>
      vscode.window.visibleTextEditors.find(
        (editor) =>
          editor.document.uri.path === '/ILASM Dotnet' &&
          editor.document.languageId === 'csharp' &&
          editor.document.getText().includes('class Calculator'),
      ),
    60000,
  );
  check('a node of the tree opens the single viewer tab', Boolean(fromTree), vscode.window.visibleTextEditors.map((editor) => `${editor.document.uri.path}:${editor.document.languageId}`).join(','));
  check('the tab shows the code of the type the node stands for', Boolean(fromTree) && fromTree.document.getText().includes('class Calculator'), '');
  check('opening from the tree leaves no empty editor group', vscode.window.tabGroups.all.every((group) => group.tabs.length > 0), JSON.stringify(vscode.window.tabGroups.all.map((group) => [group.viewColumn, group.tabs.map((tab) => tab.label)])));

  // Opening from the tree gives the same workplace as opening from the file: the source on the left,
  // the viewer next to it, and the two linked, which is what makes the navigation usable.
  const openedSource = vscode.window.visibleTextEditors.find((editor) => editor.document.uri.fsPath === sourcePath);
  check('the source file of the node opens next to the viewer', Boolean(openedSource), vscode.window.visibleTextEditors.map((editor) => editor.document.uri.fsPath).join(','));
  check('the source file is in the left column', openedSource && openedSource.viewColumn === vscode.ViewColumn.One, String(openedSource && openedSource.viewColumn));
  check('the viewer is in the column to its right', fromTree && openedSource && fromTree.viewColumn > openedSource.viewColumn, `${fromTree && fromTree.viewColumn} vs ${openedSource && openedSource.viewColumn}`);
  const caretLine = openedSource ? openedSource.selection.active.line : -1;
  check(
    'the caret of the source file is on the code of the node',
    caretLine > 1 && openedSource.document.lineAt(caretLine).text.trim().length > 0,
    `${caretLine}: ${openedSource ? openedSource.document.lineAt(Math.max(caretLine, 0)).text.trim() : ''}`,
  );
  check(
    'the source file is scrolled to the caret',
    Boolean(openedSource) && openedSource.visibleRanges.some((range) => range.start.line <= caretLine && range.end.line >= caretLine),
    openedSource ? openedSource.visibleRanges.map((range) => `${range.start.line}-${range.end.line}`).join(',') : '',
  );

  // The shortcuts of a node hand over the node itself, so the ASM action has to accept that shape too.
  await vscode.commands.executeCommand('ilasmDotnet.showPanelAsm', { kind: 'member', assembly: assemblyPath, info: { token: 0x06000003, name: 'Describe', declaringType: 'SampleLib.Calculator' } });
  const asmFromTree = await waitFor(
    () => vscode.window.visibleTextEditors.find((editor) => editor.document.uri.path === '/ILASM Dotnet' && editor.document.languageId === 'il-asm'),
    90000,
  );
  check('the ASM action of a node shows native code', Boolean(asmFromTree), vscode.window.visibleTextEditors.map((editor) => `${editor.document.uri.path}:${editor.document.languageId}`).join(','));
  check('the ASM listing names the member of that node', Boolean(asmFromTree) && asmFromTree.document.getText().includes('Describe'), asmFromTree ? asmFromTree.document.getText().slice(0, 120) : '');

  // A type has no single body, so its native code is every body it declares. Asking for it has to
  // produce that listing rather than fail and leave the previous text on screen.
  await vscode.commands.executeCommand('ilasmDotnet.showPanelAsm', {
    assembly: assemblyPath,
    token: 0x02000002,
    title: 'SampleLib.Calculator',
    isType: true,
  });
  const typeAsmFromTree = await waitFor(
    () => {
      const editor = vscode.window.visibleTextEditors.find((candidate) => candidate.document.uri.path === '/ILASM Dotnet');
      if (!editor || editor.document.languageId !== 'il-asm') {
        return undefined;
      }

      return (editor.document.getText().match(/Assembly listing for method /g) ?? []).length > 1 ? editor : undefined;
    },
    90000,
  );
  check(
    'the ASM view of a type holds the code of several of its methods',
    Boolean(typeAsmFromTree),
    typeAsmFromTree ? String((typeAsmFromTree.document.getText().match(/Assembly listing for method /g) ?? []).length) : 'no listing',
  );

  const treeLenses = fromTree
    ? await vscode.commands.executeCommand('vscode.executeCodeLensProvider', fromTree.document.uri, 2000)
    : undefined;
  check(
    'the tab opened from the tree offers the switcher row',
    Array.isArray(treeLenses) && treeLenses.length >= 4,
    Array.isArray(treeLenses) ? treeLenses.map((lens) => lens.command && lens.command.title).join(' | ') : typeof treeLenses,
  );

  await checkNativeProject(root);
  await checkFsharpProject(root);

  console.log(`\n${total - failures.length}/${total} in-host checks passed`);
  if (failures.length > 0) {
    throw new Error(`in-host failures:\n - ${failures.join('\n - ')}`);
  }
}

/**
 * A project published with NativeAOT has no assembly at all: the output of the project is the image
 * itself. Opening a source file of such a project has to end in the machine code of the method the
 * caret sits in - and it must not end in the panes of the managed route, which have nothing to read
 * and would show the same "not a managed assembly" in every one of them.
 */
async function checkNativeProject(root) {
  const directory = path.join(root, 'test', 'fixtures', 'AotTarget');
  const project = path.join(directory, 'AotTarget.csproj');
  const source = path.join(directory, 'Target.cs');
  const image = path.join(directory, 'bin', 'Release', 'net10.0', 'linux-x64', 'publish', 'AotTarget');

  if (!fs.existsSync(image)) {
    // The publish needs the AOT toolchain, which not every machine has; the checks are then skipped
    // rather than failed, the same way the other suites treat a fixture they cannot build.
    spawnSync('dotnet', ['publish', project, '-c', 'Release', '-v', 'q', '--nologo'], { stdio: 'pipe' });
  }

  if (!fs.existsSync(image)) {
    console.log('  skip the NativeAOT checks — the fixture could not be published');
    return;
  }

  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(source));
  const editor = await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.One });
  const line = fs.readFileSync(source, 'utf8').split('\n').findIndex((text) => text.includes('total += value'));
  const position = new vscode.Position(line, 0);
  editor.selection = new vscode.Selection(position, position);

  await vscode.commands.executeCommand('ilasmDotnet.openForCurrentLine');

  const native = await waitFor(() => {
    const found = vscode.window.visibleTextEditors.find(
      (candidate) => candidate.document.uri.scheme === 'ilasm-dotnet' && candidate.document.languageId === 'il-asm',
    );
    return found && found.document.getText().includes('AotTarget.Target.') ? found : undefined;
  }, 60000);

  check('a file of a NativeAOT project opens its machine code', Boolean(native), 'no native listing appeared');
  const text = native ? native.document.getText() : '';
  check('the machine code of the method the caret is in is shown', text.includes('AotTarget.Target.Sum'), text.split('\n')[2] ?? '');
  check('the listing holds instructions of the image', /0x[0-9a-f]{8}\s{2}(push|mov|xor|test)/.test(text), text.split('\n')[5] ?? '');
  check('nothing reports that the image could not be read', !text.includes('could not read this view'), text.split('\n')[1] ?? '');
  check('the source file stays open beside the image', vscode.window.visibleTextEditors.some((candidate) => candidate.document.uri.fsPath === source), '');

  const lenses = native
    ? await vscode.commands.executeCommand('vscode.executeCodeLensProvider', native.document.uri, 2000)
    : undefined;
  const titles = Array.isArray(lenses) ? lenses.map((lens) => lens.command && lens.command.title).join(' | ') : '';
  check('the row of a native image offers the machine code alone', Array.isArray(lenses) && lenses.length === 2, titles);
  check('the row of a native image does not offer IL or C#', !titles.includes('IL code') && !titles.includes('C#'), titles);

  // No pane of the managed route may have been opened for the image.
  const managed = vscode.window.visibleTextEditors.filter(
    (candidate) => candidate.document.uri.scheme === 'ilasm-dotnet' && (candidate.document.languageId === 'il' || candidate.document.languageId === 'csharp'),
  );
  check('no pane of the managed route is opened for the image', managed.length === 0, managed.map((candidate) => candidate.document.languageId).join(','));
}

/**
 * A project written in F# is a project like any other: the viewer reads its assembly, and the file
 * is only how that assembly is found. The check drives the very command a user runs on the file and
 * looks at what the panes contain — the IL of the F# type and the link back to the `.fs` line.
 *
 * The language of the file has to be recognised by the host for the menu entry to be offered, which
 * is the work of an F# extension; when the profile running this test has none, the file opens as
 * plain text and only the command side is checked.
 */
async function checkFsharpProject(root) {
  const directory = path.join(root, 'test', 'fixtures', 'FsTarget');
  const project = path.join(directory, 'FsTarget.fsproj');
  const source = path.join(directory, 'Catalog.fs');
  const assembly = path.join(directory, 'bin', 'Release', 'net10.0', 'FsTarget.dll');

  if (!fs.existsSync(assembly)) {
    spawnSync('dotnet', ['build', project, '-c', 'Release', '-v', 'q', '--nologo'], { stdio: 'pipe' });
  }

  if (!fs.existsSync(assembly)) {
    console.log('  skip the F# checks — the fixture could not be built');
    return;
  }

  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(source));
  const line = fs.readFileSync(source, 'utf8').split('\n').findIndex((text) => text.includes('member _.Total'));
  const editor = await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.One });
  const position = new vscode.Position(line, 0);
  editor.selection = new vscode.Selection(position, position);

  check('a file of an F# project is recognised as F#', document.languageId === 'fsharp', document.languageId);

  // The line of the caret is a member written in F#, so the panes have to show that member.
  await vscode.commands.executeCommand('ilasmDotnet.openForCurrentLine');

  const pane = await waitFor(() => {
    const found = vscode.window.visibleTextEditors.find(
      (candidate) => candidate.document.uri.scheme === 'ilasm-dotnet' && candidate.document.getText().includes('FsTarget.Catalog'),
    );
    return found || undefined;
  }, 30000);

  check('a command for an F# file opens the IL of its assembly', Boolean(pane), 'no pane with FsTarget.Catalog appeared');
  if (pane) {
    const text = pane.document.getText();
    check('the pane holds the IL of the F# member', text.includes('.method') && text.includes('get_Total'), text.split('\n')[0]);
    check('the pane does not report that the file could not be read', !text.includes('could not read this view'), text.split('\n')[1] ?? '');
  }

  // The C# pane of an F# assembly is a decompilation of its IL: the viewer has one decompiler and it
  // reads metadata, so an F# body is shown as the C# it would have been. What it must not be is a
  // message, which is what a language the engine refused to read would produce.
  await vscode.commands.executeCommand('ilasmDotnet.selectKind', 'csharp');
  const csharp = await waitFor(() => {
    const found = vscode.window.visibleTextEditors.find(
      (candidate) => candidate.document.uri.scheme === 'ilasm-dotnet' && candidate.document.languageId === 'csharp',
    );
    return found && found.document.getText().includes('Total') ? found : undefined;
  }, 30000);
  check('the C# pane of an F# assembly is a decompilation of its IL', Boolean(csharp), 'no C# pane with the member appeared');
  check(
    'the C# pane of an F# assembly is code rather than a message',
    Boolean(csharp) && !/could not read this view|not a managed assembly/.test(csharp.document.getText()),
    csharp ? csharp.document.getText().split('\n')[0] : '',
  );
}

module.exports = { run };
