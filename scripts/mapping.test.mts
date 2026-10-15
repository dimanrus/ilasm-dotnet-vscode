#!/usr/bin/env node
// Unit tests for the pure mapping helpers that link the IL view, the C# view and the source.
// The module under test is compiled first by `npm run pretest`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  anchorAt,
  basename,
  blocksForInstruction,
  blockContains,
  blocksForSource,
  blocksForTokens,
  ilLabel,
  nearestSourceBlock,
  normalizePath,
  samePath,
  spanOf,
  tokensAt,
} from '../out/test/viewer/mapping.js';
import type { MapBlock } from '../out/test/engine/protocol.js';

/** A block of a view, with everything the tests do not care about filled in. */
const block = (overrides: Partial<MapBlock>): MapBlock => ({
  methodToken: 0,
  ilStart: 0,
  ilEnd: 1,
  textStartLine: 1,
  textEndLine: 1,
  sourceStartLine: 0,
  sourceEndLine: 0,
  ...overrides,
});

test('blockContains uses inclusive line bounds', () => {
  const subject = block({ textStartLine: 10, textEndLine: 12 });

  assert.equal(blockContains(subject, 9), false);
  assert.equal(blockContains(subject, 10), true);
  assert.equal(blockContains(subject, 11), true);
  assert.equal(blockContains(subject, 12), true);
  assert.equal(blockContains(subject, 13), false);
});

test('nearestSourceBlock prefers the block under the caret', () => {
  const blocks = [
    block({ methodToken: 1, textStartLine: 1, textEndLine: 5, sourceStartLine: 10, sourceEndLine: 12, sourceFile: 'a.cs' }),
    block({ methodToken: 2, textStartLine: 6, textEndLine: 9, sourceStartLine: 20, sourceEndLine: 22, sourceFile: 'a.cs' }),
  ];

  assert.equal(nearestSourceBlock(blocks, 7)?.methodToken, 2);
});

test('nearestSourceBlock falls back to the previous mapped block', () => {
  const blocks = [
    block({ methodToken: 1, textStartLine: 1, textEndLine: 5, sourceStartLine: 10, sourceEndLine: 12, sourceFile: 'a.cs' }),
    block({ methodToken: 2, textStartLine: 6, textEndLine: 9 }),
  ];

  // Line 8 has no source of its own, so the instruction that last carried source wins.
  assert.equal(nearestSourceBlock(blocks, 8)?.methodToken, 1);
});

test('nearestSourceBlock returns nothing when no block carries source information', () => {
  assert.equal(nearestSourceBlock([block({ textStartLine: 1, textEndLine: 4 })], 2), undefined);
});

test('tokensAt collects the method tokens of the blocks covering a line', () => {
  const blocks = [
    block({ methodToken: 0x06000001, textStartLine: 1, textEndLine: 3 }),
    block({ methodToken: 0x06000002, textStartLine: 2, textEndLine: 4 }),
    block({ methodToken: 0, textStartLine: 2, textEndLine: 2 }),
  ];

  assert.deepEqual([...tokensAt(blocks, 2)].sort(), [0x06000001, 0x06000002]);
  assert.deepEqual([...tokensAt(blocks, 4)], [0x06000002]);
});

test('blocksForTokens returns nothing for an empty token set', () => {
  const blocks = [block({ methodToken: 0x06000001 })];
  assert.deepEqual(blocksForTokens(blocks, new Set()), []);
  assert.equal(blocksForTokens(blocks, new Set([0x06000001])).length, 1);
  assert.equal(blocksForTokens(blocks, new Set([0x06000009])).length, 0);
});

test('blocksForSource matches Windows and Unix paths case insensitively', () => {
  const blocks = [
    block({ sourceFile: 'C:\\src\\App\\Calculator.cs', sourceStartLine: 10, sourceEndLine: 14 }),
    block({ sourceFile: '/src/App/Other.cs', sourceStartLine: 10, sourceEndLine: 14 }),
  ];

  assert.equal(blocksForSource(blocks, 'c:/src/app/calculator.cs', 12).length, 1);
  assert.equal(blocksForSource(blocks, '/SRC/app/Other.cs', 14).length, 1);
  assert.equal(blocksForSource(blocks, '/src/App/Other.cs', 15).length, 0);
});

test('spanOf returns the enclosing line range', () => {
  const blocks = [
    block({ textStartLine: 5, textEndLine: 7 }),
    block({ textStartLine: 12, textEndLine: 14 }),
  ];

  assert.deepEqual(spanOf(blocks), { start: 5, end: 14 });
  assert.equal(spanOf([]), undefined);
});

test('path helpers normalize separators and case', () => {
  assert.equal(normalizePath('C:\\A\\B.CS'), 'c:/a/b.cs');
  assert.equal(samePath('C:\\A\\B.cs', 'c:/a/b.cs'), true);
  assert.equal(basename('/home/user/Calculator.cs'), 'Calculator.cs');
  assert.equal(basename('C:\\src\\Calculator.cs'), 'Calculator.cs');
});

test('anchorAt reports the method, the IL instruction and the source of a line', () => {
  const blocks = [
    block({ methodToken: 0x06000001, ilStart: 0, ilEnd: 1, textStartLine: 1, textEndLine: 1, sourceFile: 'a.cs', sourceStartLine: 10, sourceEndLine: 10 }),
    block({ methodToken: 0x06000001, ilStart: 4, ilEnd: 5, textStartLine: 2, textEndLine: 2 }),
  ];

  const first = anchorAt(blocks, 1);
  assert.ok(first);
  assert.equal(first.methodToken, 0x06000001);
  assert.equal(first.ilStart, 0);
  assert.deepEqual(first.source, { file: 'a.cs', startLine: 10, endLine: 10 });

  const second = anchorAt(blocks, 2);
  assert.ok(second);
  assert.equal(second.ilStart, 4);
  assert.equal(second.source, undefined);

  assert.equal(anchorAt(blocks, 99), undefined);
});

test('anchorAt prefers the instruction block over the method block that covers it', () => {
  const blocks = [
    // The whole method, as the live assembly listing reports it: no IL offset and no source.
    block({ methodToken: 0x06000001, ilStart: 0, ilEnd: 28, textStartLine: 6, textEndLine: 17 }),
    block({
      methodToken: 0x06000001,
      ilStart: 0,
      ilEnd: 1,
      textStartLine: 13,
      textEndLine: 13,
      sourceFile: 'a.cs',
      sourceStartLine: 9,
      sourceEndLine: 9,
    }),
  ];

  const anchor = anchorAt(blocks, 13);
  assert.ok(anchor);
  assert.equal(anchor.ilStart, 0);
  assert.deepEqual(anchor.source, { file: 'a.cs', startLine: 9, endLine: 9 });

  // A line the instructions do not cover still resolves to the method it belongs to.
  const prolog = anchorAt(blocks, 8);
  assert.ok(prolog);
  assert.equal(prolog.methodToken, 0x06000001);
  assert.equal(prolog.source, undefined);
});

test('blocksForInstruction finds the counterpart instruction of the same method', () => {
  const blocks = [
    block({ methodToken: 0x06000001, ilStart: 0, ilEnd: 1, textStartLine: 1, textEndLine: 1 }),
    block({ methodToken: 0x06000001, ilStart: 4, ilEnd: 5, textStartLine: 2, textEndLine: 2 }),
    block({ methodToken: 0x06000002, ilStart: 4, ilEnd: 5, textStartLine: 3, textEndLine: 3 }),
  ];

  const matches = blocksForInstruction(blocks, 0x06000001, 4);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].textStartLine, 2);

  // A different method with the same offset must not match.
  assert.equal(blocksForInstruction(blocks, 0x06000009, 4).length, 0);
  assert.equal(blocksForInstruction(blocks, 0x06000001, 2).length, 0);
});

test('blocksForInstruction also matches a block that spans several offsets', () => {
  const blocks = [block({ methodToken: 0x06000001, ilStart: 0, ilEnd: 16, textStartLine: 5, textEndLine: 9 })];
  assert.equal(blocksForInstruction(blocks, 0x06000001, 7).length, 1);
  assert.equal(blocksForInstruction(blocks, 0x06000001, 16).length, 0);
});

test('ilLabel formats offsets the way the disassembler prints them', () => {
  assert.equal(ilLabel(0), 'IL_0000');
  assert.equal(ilLabel(15), 'IL_000f');
  assert.equal(ilLabel(0x1ab), 'IL_01ab');
});
