#!/usr/bin/env node
// Unit tests for the viewer's switching rules: which engine call a state maps to, how the view and
// scope are labelled, and what the clickable row above the code contains.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  FILE_SCOPE,
  KIND_LABELS,
  KIND_ORDER,
  cacheKey,
  instructionLabel,
  isViewerKind,
  kindsFor,
  languageFor,
  lensSpecs,
  memberLabel,
  requestFor,
  scopeChoices,
  scopeLabel,
  scopeValueOf,
  statusText,
  subtitleFor,
} from '../out/test/viewer/viewSession.js';

const session = (overrides = {}) => ({
  assembly: '/out/SampleLib.dll',
  file: '/src/Calculator.cs',
  kind: 'il',
  scope: FILE_SCOPE,
  ...overrides,
});

const members = [
  { token: 100663297, kind: 'constructor', name: '.ctor', declaringType: 'SampleLib.Calculator' },
  { token: 100663298, kind: 'method', name: 'Add', declaringType: 'SampleLib.Calculator' },
  { token: 100663299, kind: 'method', name: 'Describe', declaringType: 'SampleLib.Calculator' },
];

const options = { includeCompilerGenerated: false, optimized: true };

test('the whole file maps to the file endpoints', () => {
  assert.equal(requestFor(session(), options).method, 'view/fileIl');
  assert.equal(requestFor(session({ kind: 'csharp' }), options).method, 'view/fileCsharp');
  assert.equal(requestFor(session({ kind: 'asm' }), options).method, 'view/fileAsm');

  const params = requestFor(session(), options).params;
  assert.equal(params.file, '/src/Calculator.cs');
  assert.equal(params.path, '/out/SampleLib.dll');
  assert.equal(params.optimized, true);
});

test('a single member maps to the member endpoints and sends the token', () => {
  const scoped = session({ scope: '100663298' });
  assert.equal(requestFor(scoped, options).method, 'view/il');
  assert.equal(requestFor({ ...scoped, kind: 'csharp' }, options).method, 'view/csharp');
  assert.equal(requestFor({ ...scoped, kind: 'asm' }, options).method, 'view/asm');
  assert.equal(requestFor(scoped, options).params.token, 100663298);
  assert.equal(requestFor(scoped, options).params.file, undefined);
});

test('the options given by the settings are passed through', () => {
  const params = requestFor(session({ kind: 'asm' }), { includeCompilerGenerated: true, optimized: false }).params;
  assert.equal(params.includeCompilerGenerated, true);
  assert.equal(params.optimized, false);
});

test('each view has its own document language', () => {
  assert.deepEqual(KIND_ORDER, ['il', 'csharp', 'csharpLow', 'asm']);
  assert.equal(languageFor('il'), 'il');
  assert.equal(languageFor('csharp'), 'csharp');
  // Both C# flavours are C# as far as highlighting is concerned; only the settings differ.
  assert.equal(languageFor('csharpLow'), 'csharp');
  assert.equal(languageFor('asm'), 'il-asm');
});

test('view kinds are validated', () => {
  assert.equal(isViewerKind('il'), true);
  assert.equal(isViewerKind('asm'), true);
  assert.equal(isViewerKind('metadata'), false);
  assert.equal(isViewerKind(undefined), false);
});

test('the cache key separates view and scope', () => {
  const base = cacheKey(session());
  assert.notEqual(base, cacheKey(session({ kind: 'asm' })));
  assert.notEqual(base, cacheKey(session({ scope: '100663298' })));
  assert.equal(base, cacheKey(session()));
});

test('the cache key follows the settings that change a view', () => {
  const csharp = session({ kind: 'csharp' });
  assert.notEqual(cacheKey(csharp, { includeCompilerGenerated: false }), cacheKey(csharp, { includeCompilerGenerated: true }));
  // The IL view does not depend on the generated-member setting.
  assert.equal(cacheKey(session(), { includeCompilerGenerated: false }), cacheKey(session(), { includeCompilerGenerated: true }));

  const asm = session({ kind: 'asm' });
  assert.notEqual(cacheKey(asm, { optimized: true }), cacheKey(asm, { optimized: false }));
  assert.notEqual(cacheKey(asm, { asmSource: 'image' }), cacheKey(asm, { asmSource: 'jit' }));
  assert.notEqual(cacheKey(asm, { asmSource: 'image' }), cacheKey(asm, { asmSource: 'image', live: true }));
});

test('members are labelled with their type and parentheses', () => {
  assert.equal(memberLabel(members[0]), 'Calculator()');
  assert.equal(memberLabel(members[1]), 'Add()');
});

test('an accessor is labelled with the property it belongs to', () => {
  const accessor = {
    token: 100663299,
    kind: 'method',
    name: 'get_Count',
    declaringType: 'SampleLib.Calculator',
    owner: 'Count',
    accessor: 'get',
  };

  assert.equal(memberLabel(accessor), 'Count (get)');
  // Without an owner it stays a plain method, which is what a method without an accessor role is.
  assert.equal(memberLabel({ ...accessor, owner: null, accessor: null }), 'get_Count()');
});

test('the scope label reflects the selection', () => {
  assert.equal(scopeLabel(session(), members), 'Entire file');
  assert.equal(scopeLabel(session({ scope: '100663298' }), members), 'Add()');
  assert.equal(scopeLabel(session({ scope: '999' }), members), 'Member');
});

test('the scope choices start with the whole file', () => {
  const choices = scopeChoices(members);
  assert.equal(choices.length, members.length + 1);
  assert.equal(choices[0].value, FILE_SCOPE);

  // A member of an assembly without a PDB: there is no file to offer.
  const withoutFile = scopeChoices(members, { wholeFile: false });
  assert.equal(withoutFile.length, members.length);
  assert.ok(!withoutFile.some((choice) => choice.value === FILE_SCOPE));
  assert.equal(choices[0].label, 'Entire file');
  assert.deepEqual(
    choices.slice(1).map((choice) => choice.value),
    ['100663297', '100663298', '100663299'],
  );
});

test('the clickable row offers every view plus the scope, and marks the active one', () => {
  const lenses = lensSpecs(session({ kind: 'csharp' }), members);

  assert.equal(lenses.length, KIND_ORDER.length + 1);
  assert.deepEqual(
    lenses.map((lens) => lens.command),
    [...KIND_ORDER.map(() => 'ilasmDotnet.selectKind'), 'ilasmDotnet.selectScope'],
  );
  assert.equal(lenses[0].title, KIND_LABELS.il);
  assert.equal(lenses[1].title, `● ${KIND_LABELS.csharp}`);
  assert.equal(lenses[1].active, true);
  assert.deepEqual(lenses[1].arguments, ['csharp']);
  assert.equal(lenses[2].title, KIND_LABELS.csharpLow);
  // The row follows KIND_ORDER, so every entry can be checked against it rather than by hand.
  assert.deepEqual(
    lenses.slice(0, KIND_ORDER.length).map((lens) => lens.title.replace('● ', '')),
    KIND_ORDER.map((kind) => KIND_LABELS[kind]),
  );
  assert.equal(lenses.at(-1).title, 'Scope: Entire file');
});

test('the scope entry of the row names the selected member', () => {
  const lenses = lensSpecs(session({ scope: '100663298' }), members);
  assert.equal(lenses.at(-1).title, 'Scope: Add()');
});

test('the low level view is asked for with the decompiler transformations off', () => {
  const low = requestFor(session({ kind: 'csharpLow', scope: '100663298' }), { includeCompilerGenerated: false, optimized: true });
  assert.equal(low.method, 'view/csharp');
  assert.equal(low.params.lowLevel, true);
  assert.equal(low.params.includeCompilerGenerated, true);

  const high = requestFor(session({ kind: 'csharp', scope: '100663298' }), { includeCompilerGenerated: false, optimized: true });
  assert.equal(high.params.lowLevel, false);
  assert.equal(high.params.includeCompilerGenerated, false);

  // A whole-file low-level view requests the file and keeps the generated types in scope.
  const fileLow = requestFor(session({ kind: 'csharpLow', scope: 'file' }), { includeCompilerGenerated: false, optimized: true });
  assert.equal(fileLow.method, 'view/fileCsharp');
  assert.equal(fileLow.params.lowLevel, true);
  assert.equal(fileLow.params.includeCompilerGenerated, true);
});

test('the two C# flavours do not share a cached view', () => {
  assert.notEqual(cacheKey(session({ kind: 'csharp' })), cacheKey(session({ kind: 'csharpLow' })));
});

test('the status bar text carries the view, the scope and the file', () => {
  const text = statusText(session({ kind: 'asm' }), members);
  assert.ok(text.includes(KIND_LABELS.asm));
  assert.ok(text.includes('Entire file'));
  assert.ok(text.includes('Calculator.cs'));
  assert.ok(!text.includes('/src/'), text);
});

test('a session without a file is named by its member', () => {
  const stripped = session({ file: '', kind: 'csharp', scope: '100663298' });
  const text = statusText(stripped, members);
  assert.ok(!text.includes(' ·  · '), text);
  assert.equal(text, `${KIND_LABELS.csharp} · Add()`);
  assert.ok(!subtitleFor(stripped, members).startsWith(' · '), subtitleFor(stripped, members));
});

test('the status bar text handles Windows paths', () => {
  const text = statusText(session({ file: 'C:\\src\\App\\Calculator.cs' }), members);
  assert.ok(text.includes('Calculator.cs'), text);
  assert.ok(!text.includes('C:\\'), text);
});

// The native route: an image of machine code has no tokens, so a method is named by the address of
// its code and the whole-file scope is the set of methods one source file was compiled into.
const nativeSession = (overrides = {}) => ({
  assembly: '/out/AotTarget',
  file: '/src/Target.cs',
  kind: 'asm',
  scope: FILE_SCOPE,
  native: true,
  ...overrides,
});

const nativeMembers = [
  {
    token: 0,
    address: 442944,
    kind: 'method',
    name: 'AotTarget.Target.Sum',
    declaringType: 'AotTarget.Target',
    label: 'AotTarget.Target.Sum',
    detail: 'Target.cs:13',
  },
];

test('a native image is only ever shown as machine code', () => {
  assert.deepEqual(kindsFor(nativeSession()), ['asm']);
  assert.deepEqual(kindsFor(session()), KIND_ORDER);
  assert.equal(lensSpecs(nativeSession(), nativeMembers).length, 2);
  assert.ok(!lensSpecs(nativeSession(), nativeMembers).some((lens) => lens.arguments.includes('il')));
});

test('the native view asks its own route for a file and for a method', () => {
  const file = requestFor(nativeSession(), options);
  assert.equal(file.method, 'native/asm');
  assert.equal(file.params.file, '/src/Target.cs');
  assert.equal(file.params.includeRuntime, false);
  assert.equal(file.params.token, undefined);

  const method = requestFor(nativeSession({ scope: '442944' }), options);
  assert.equal(method.method, 'native/asm');
  assert.equal(method.params.address, 442944);
  assert.equal(method.params.file, undefined);

  const withRuntime = requestFor(nativeSession(), { ...options, nativeIncludeRuntime: true });
  assert.equal(withRuntime.params.includeRuntime, true);
});

test('a native view is cached apart from the assembly views', () => {
  assert.notEqual(cacheKey(nativeSession()), cacheKey(session({ kind: 'asm' })));
  assert.notEqual(
    cacheKey(nativeSession(), { nativeIncludeRuntime: true }),
    cacheKey(nativeSession(), { nativeIncludeRuntime: false }),
  );
});

test('a native member is identified by the address of its code', () => {
  assert.equal(scopeValueOf(nativeMembers[0]), '442944');
  assert.equal(scopeValueOf(members[1]), '100663298');
  assert.equal(memberLabel(nativeMembers[0]), 'AotTarget.Target.Sum');
  assert.equal(scopeLabel(nativeSession({ scope: '442944' }), nativeMembers), 'AotTarget.Target.Sum');
  assert.equal(scopeChoices(nativeMembers)[1].description, 'Target.cs:13');
  assert.equal(scopeChoices(nativeMembers)[1].value, '442944');
});

test('an instruction is labelled by its address in a native view and by its IL offset otherwise', () => {
  assert.equal(instructionLabel(nativeSession(), 442944), '0x6c240');
  assert.equal(instructionLabel(session(), 5), 'IL_0005');
  assert.equal(instructionLabel(undefined, 5), 'IL_0005');
});
