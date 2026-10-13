import * as vscode from 'vscode';
import { MapBlock } from '../engine/protocol';
import { Log } from '../util/log';
import { findVisibleEditor, IlasmDotnetDocuments, ViewKind } from './documents';
import { anchorAt, basename, blocksForInstruction, blocksForSource, blocksForTokens, blockContains, samePath, spanOf, tokensAt } from './mapping';
import { instructionLabel, KIND_ORDER } from './viewSession';

const ALL_KINDS: ViewKind[] = KIND_ORDER;

/**
 * Keeps the IL, decompiled C# and ASM panes in sync with each other and with the original source.
 *
 * The panes are linked by method token, which is the finest anchor all three share: IL also carries
 * instruction offsets and source lines, while ASM is reported per method by the JIT. Highlighting
 * uses decorations, so the caret of another editor is never moved.
 */
export class SyncController implements vscode.Disposable {
  private readonly counterpartDecoration: vscode.TextEditorDecorationType;
  private readonly sourceDecoration: vscode.TextEditorDecorationType;
  private readonly status: vscode.StatusBarItem;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly documents: IlasmDotnetDocuments,
    private readonly syncSource: () => boolean,
    private readonly syncScroll: () => boolean,
  ) {
    this.counterpartDecoration = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: new vscode.ThemeColor('editor.findMatchHighlightBackground'),
      overviewRulerColor: new vscode.ThemeColor('editor.findMatchHighlightBorder'),
      overviewRulerLane: vscode.OverviewRulerLane.Center,
    });

    this.sourceDecoration = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: new vscode.ThemeColor('editor.selectionHighlightBackground'),
      borderColor: new vscode.ThemeColor('editor.selectionHighlightBorder'),
      borderStyle: 'solid',
      borderWidth: '0 0 0 3px',
    });

    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
    this.status.command = 'ilasmDotnet.goToSource';
    this.status.tooltip = 'ILASM Dotnet: go to the original source line';

    this.disposables.push(
      vscode.window.onDidChangeTextEditorSelection((event) => this.update(event.textEditor)),
      // Switching to another pane also moves the caret the user works with, so the link is followed
      // for that as well: clicking into the source file has to show where its code is in the IL.
      vscode.window.onDidChangeActiveTextEditor((editor) => (editor ? this.update(editor) : this.clear())),
    );
  }

  private update(editor: vscode.TextEditor): void {
    try {
      this.clear();

      const kind = this.documents.kindOf(editor.document.uri);
      if (kind) {
        this.fromViewer(editor, kind);
        return;
      }

      if (editor.document.uri.scheme === 'file' && this.syncSource()) {
        this.fromSource(editor);
      }
    } catch (error) {
      Log.error('synchronizing the panes failed', error);
    }
  }

  /** Caret in one pane highlights the matching region of every other open pane. */
  private fromViewer(editor: vscode.TextEditor, kind: ViewKind): void {
    const target = IlasmDotnetDocuments.targetOf(editor.document.uri);
    const view = this.documents.getCached(editor.document.uri);
    if (!view) {
      return;
    }

    const line = editor.selection.active.line + 1;
    const anchor = anchorAt(view.blocks, line);
    const tokens = tokensAt(view.blocks, line);

    // Every other pane that is open gets linked: exactly the same IL instruction when both sides
    // report instruction offsets, which the live route does, otherwise the whole method.
    if (target) {
      for (const other of ALL_KINDS) {
        if (other === kind) {
          continue;
        }

        const uri = IlasmDotnetDocuments.uriFor(other, target);
        const otherEditor = findVisibleEditor(uri);
        const otherView = this.documents.getCached(uri);
        if (!otherEditor || !otherView) {
          continue;
        }

        let matching = anchor?.ilStart === undefined
          ? []
          : blocksForInstruction(otherView.blocks, anchor.methodToken, anchor.ilStart);

        if (matching.length === 0) {
          matching = blocksForTokens(otherView.blocks, tokens);
        }

        otherEditor.setDecorations(this.counterpartDecoration, toRanges(matching));
        this.reveal(otherEditor, matching);
      }
    }

    if (anchor?.source) {
      this.highlightSource(anchor.source);

      // A native image has addresses where an assembly has IL offsets, so the label follows the kind
      // of code the pane holds.
      const session = this.documents.sessionState(editor.document.uri);
      const instruction =
        anchor.ilStart === undefined ? '' : ` $(arrow-right) ${instructionLabel(session, anchor.ilStart)}`;
      this.status.text = `$(file-code) ${basename(anchor.source.file)}:${anchor.source.startLine}${instruction}`;
      this.status.show();
      return;
    }

    const current = view.blocks.find((candidate) => blockContains(candidate, line));
    if (current) {
      this.status.text = `$(circuit-board) ${target?.title ?? ''} — method 0x${current.methodToken.toString(16).toUpperCase()}`;
      this.status.show();
    }
  }

  /**
   * Caret in the real source file highlights the matching region of every open pane, and brings it
   * into view: the pane keeps its scroll position otherwise, which leaves the highlighted code below
   * the fold where nobody sees it.
   *
   * The IL listing knows the source line of each instruction, so it highlights the exact one. The
   * other views report the member a region belongs to, so they highlight the whole member there,
   * which is the finest link the view itself carries.
   */
  private fromSource(editor: vscode.TextEditor): void {
    const line = editor.selection.active.line + 1;
    const file = editor.document.uri.fsPath;

    for (const openEditor of vscode.window.visibleTextEditors) {
      if (!this.documents.kindOf(openEditor.document.uri)) {
        continue;
      }

      const view = this.documents.getCached(openEditor.document.uri);
      if (!view) {
        continue;
      }

      const matching = blocksForSource(view.blocks, file, line);
      if (matching.length > 0) {
        openEditor.setDecorations(this.counterpartDecoration, toRanges(matching));
        this.reveal(openEditor, matching);
      }
    }
  }

  /**
   * Scrolls a pane to the region that was just highlighted. Only panes that are off screen move, so
   * reading around the highlighted code stays possible: the caret never sits still for long, and
   * centring on every move would fight the user.
   */
  private reveal(editor: vscode.TextEditor, blocks: MapBlock[]): void {
    if (!this.syncScroll()) {
      return;
    }

    const span = spanOf(blocks);
    if (!span) {
      return;
    }

    editor.revealRange(
      new vscode.Range(span.start - 1, 0, span.end, 0),
      vscode.TextEditorRevealType.InCenterIfOutsideViewport,
    );
  }

  private highlightSource(source: { file: string; startLine: number; endLine: number }): void {
    if (!this.syncSource()) {
      return;
    }

    const editor = vscode.window.visibleTextEditors.find((candidate) =>
      samePath(candidate.document.uri.fsPath, source.file),
    );
    if (!editor) {
      return;
    }

    const lastLine = Math.max(editor.document.lineCount - 1, 0);
    const start = Math.min(Math.max(source.startLine - 1, 0), lastLine);
    const end = Math.min(Math.max(source.endLine - 1, start), lastLine);

    editor.setDecorations(this.sourceDecoration, [new vscode.Range(start, 0, end, 0)]);

    if (this.syncScroll()) {
      editor.revealRange(new vscode.Range(start, 0, end, 0), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    }
  }

  private clear(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      editor.setDecorations(this.counterpartDecoration, []);
      editor.setDecorations(this.sourceDecoration, []);
    }

    this.status.hide();
  }

  dispose(): void {
    this.counterpartDecoration.dispose();
    this.sourceDecoration.dispose();
    this.status.dispose();

    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }
}

function toRanges(blocks: MapBlock[]): vscode.Range[] {
  return blocks.map((block) => new vscode.Range(block.textStartLine - 1, 0, block.textEndLine, 0));
}
