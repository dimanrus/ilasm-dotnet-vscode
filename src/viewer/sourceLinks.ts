import * as vscode from 'vscode';
import { IlasmDotnetDocuments } from './documents';

const SEQUENCE_POINT = /\(line (\d+), col \d+\) to \(line \d+, col \d+\) in (\S.*)$/;

/**
 * Turns the `// sequence point: ... in <path>` comments the IL view already contains into
 * clickable links, so an IL instruction opens its original source line.
 */
export class SourceLinkProvider implements vscode.DocumentLinkProvider {
  constructor(private readonly documents: IlasmDotnetDocuments) {}

  provideDocumentLinks(document: vscode.TextDocument): vscode.DocumentLink[] {
    // Only the IL view carries sequence point comments worth linking.
    if (this.documents.kindOf(document.uri) !== 'il') {
      return [];
    }

    const links: vscode.DocumentLink[] = [];
    for (let index = 0; index < document.lineCount; index++) {
      const text = document.lineAt(index).text;
      const match = SEQUENCE_POINT.exec(text);
      if (!match) {
        continue;
      }

      const file = match[2].trim();
      const start = text.indexOf(file, match.index);
      if (start < 0 || !file.includes('.')) {
        continue;
      }

      const range = new vscode.Range(index, start, index, start + file.length);
      const target = vscode.Uri.file(file).with({ fragment: `L${match[1]}` });
      const link = new vscode.DocumentLink(range, target);
      link.tooltip = `Go to ${file}:${match[1]}`;
      links.push(link);
    }

    return links;
  }
}
