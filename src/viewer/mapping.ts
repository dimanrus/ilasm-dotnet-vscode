import type { MapBlock } from '../engine/protocol';

/**
 * Pure mapping helpers shared by the selection sync and the viewer opener. They intentionally
 * have no dependency on the VS Code API so they can be unit tested directly.
 */

export function blockContains(block: MapBlock, line: number): boolean {
  return line >= block.textStartLine && line <= block.textEndLine;
}

/** The block at the given line, or the closest preceding block that carries source information. */
export function nearestSourceBlock(blocks: MapBlock[], line: number): MapBlock | undefined {
  const atLine = blocks.filter((block) => blockContains(block, line) && block.sourceFile);
  if (atLine.length > 0) {
    return atLine[0];
  }

  let best: MapBlock | undefined;
  for (const block of blocks) {
    if (!block.sourceFile || block.textStartLine > line) {
      continue;
    }

    if (!best || block.textStartLine > best.textStartLine) {
      best = block;
    }
  }

  return best;
}

/** Method tokens of the blocks that cover a line in one of the views. */
export function tokensAt(blocks: MapBlock[], line: number): Set<number> {
  const tokens = new Set<number>();
  for (const block of blocks) {
    if (blockContains(block, line) && block.methodToken !== 0) {
      tokens.add(block.methodToken);
    }
  }

  return tokens;
}

/** Blocks of a view that map to a given original source position. */
export function blocksForSource(blocks: MapBlock[], file: string, line: number): MapBlock[] {
  return blocks.filter(
    (block) =>
      block.sourceFile !== undefined &&
      samePath(block.sourceFile, file) &&
      line >= block.sourceStartLine &&
      line <= block.sourceEndLine,
  );
}

/**
 * Where the caret sits, in the terms a counterpart view can match on: the method it belongs to, the
 * IL instruction when the view knows it, and the original source position.
 */
export interface CursorAnchor {
  methodToken: number;
  ilStart?: number;
  source?: { file: string; startLine: number; endLine: number };
}

export function anchorAt(blocks: MapBlock[], line: number): CursorAnchor | undefined {
  const block = narrowestBlock(blocks.filter((candidate) => blockContains(candidate, line)));
  if (!block) {
    return undefined;
  }

  return {
    methodToken: block.methodToken,
    ilStart: block.ilStart,
    source: block.sourceFile
      ? { file: block.sourceFile, startLine: block.sourceStartLine, endLine: block.sourceEndLine }
      : undefined,
  };
}

/**
 * The narrowest of the covering blocks. Listings nest: one block spans the whole method while every
 * instruction has a one line block of its own, and only the narrow blocks know the source line.
 */
function narrowestBlock(candidates: MapBlock[]): MapBlock | undefined {
  let best: MapBlock | undefined;
  for (const candidate of candidates) {
    if (!best) {
      best = candidate;
      continue;
    }

    const span = candidate.textEndLine - candidate.textStartLine;
    const bestSpan = best.textEndLine - best.textStartLine;
    if (span < bestSpan || (span === bestSpan && candidate.sourceFile && !best.sourceFile)) {
      best = candidate;
    }
  }

  return best;
}

/**
 * Blocks that cover the same IL instruction. This is the exact link between the assembly listing and
 * the IL listing, and it needs the live route: the environment variable route only reports native
 * code per method, so its blocks carry no instruction offsets.
 */
export function blocksForInstruction(blocks: MapBlock[], methodToken: number, ilStart: number): MapBlock[] {
  return blocks.filter(
    (block) =>
      block.methodToken === methodToken &&
      block.ilStart <= ilStart &&
      ilStart < Math.max(block.ilEnd, block.ilStart + 1),
  );
}

/** Blocks of the counterpart view that belong to any of the given method tokens. */
export function blocksForTokens(blocks: MapBlock[], tokens: ReadonlySet<number>): MapBlock[] {
  if (tokens.size === 0) {
    return [];
  }

  return blocks.filter((block) => tokens.has(block.methodToken));
}

/** Overall line span covered by a set of blocks, or undefined when the set is empty. */
export function spanOf(blocks: MapBlock[]): { start: number; end: number } | undefined {
  if (blocks.length === 0) {
    return undefined;
  }

  return {
    start: Math.min(...blocks.map((block) => block.textStartLine)),
    end: Math.max(...blocks.map((block) => block.textEndLine)),
  };
}

export function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').toLowerCase();
}

export function samePath(left: string, right: string): boolean {
  return normalizePath(left) === normalizePath(right);
}

export function basename(file: string): string {
  const normalized = file.replace(/\\/g, '/');
  return normalized.slice(normalized.lastIndexOf('/') + 1);
}

/** Formats an IL offset the way the disassembler prints labels, which is lower case. */
export function ilLabel(offset: number): string {
  return `IL_${offset.toString(16).padStart(4, '0')}`;
}
