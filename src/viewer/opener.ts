import * as vscode from 'vscode';
import { MapBlock, ViewInfo } from '../engine/protocol';
import { IlasmDotnetDocuments, ViewerTarget, besideColumn } from './documents';
import { blocksForSource, spanOf } from './mapping';

export interface OpenViewerOptions {
  /** A source position to reveal in the pane once it is open. */
  revealFile?: string;
  revealLine?: number;
  /** A method token whose region should be revealed. */
  revealMethodToken?: number;
}

/** Opens the IL and decompiled C# panes for one target, side by side. */
export async function openViewer(
  documents: IlasmDotnetDocuments,
  target: ViewerTarget,
  options: OpenViewerOptions = {},
): Promise<void> {
  // Both panes ask for the column beside the active one, which puts the IL pane next to the source
  // and the C# pane next to the IL pane: the two are meant to be read together. "Beside" creates a
  // group only when there is something to sit beside, so nothing is opened next to an empty group.
  const ilEditor = await documents.open('il', target, { viewColumn: besideColumn() });
  await documents.open('csharp', target, { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true });

  const view = documents.getCached(ilEditor.document.uri);
  if (!view) {
    return;
  }

  if (!view.hasDebugInfo) {
    vscode.window.setStatusBarMessage(
      'ILASM Dotnet: this assembly has no portable PDB, so IL cannot be linked to source lines.',
      8000,
    );
  }

  reveal(ilEditor, view, options);
}

/**
 * Opens the native ASM pane for one member. The JIT has to compile the method, which takes a
 * process launch, so this pane is opened on demand rather than together with the other two.
 */
export async function openAsmPane(documents: IlasmDotnetDocuments, target: ViewerTarget): Promise<void> {
  const editor = await documents.open('asm', target, { viewColumn: besideColumn() });
  const view = documents.getCached(editor.document.uri);

  if (!view) {
    return;
  }

  reveal(editor, view, { revealMethodToken: target.token });

  if (view.notes && view.notes.length > 0) {
    void vscode.window.showWarningMessage(`ILASM Dotnet: ${view.notes[0]}`);
  }
}

function reveal(editor: vscode.TextEditor, view: ViewInfo, options: OpenViewerOptions): void {
  const span = findSpan(view.blocks, options);
  if (!span) {
    return;
  }

  const lastLine = Math.max(editor.document.lineCount - 1, 0);
  const range = new vscode.Range(
    Math.min(span.start - 1, lastLine),
    0,
    Math.min(span.end - 1, lastLine),
    0,
  );

  editor.selection = new vscode.Selection(range.start, range.start);
  editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}

/** Computes the block span to reveal from the requested source position or method token. */
function findSpan(blocks: MapBlock[], options: OpenViewerOptions): { start: number; end: number } | undefined {
  if (options.revealFile && options.revealLine) {
    const span = spanOf(blocksForSource(blocks, options.revealFile, options.revealLine));
    if (span) {
      return span;
    }
  }

  if (options.revealMethodToken) {
    return spanOf(blocks.filter((block) => block.methodToken === options.revealMethodToken));
  }

  return undefined;
}
