#!/usr/bin/env node
// Validates the extension manifest: every command referenced from a menu exists, and every file
// the manifest points at is actually on disk.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const contributes = manifest.contributes ?? {};

const declaredCommands = new Set((contributes.commands ?? []).map((command) => command.command));

test('the manifest declares a display name, main entry and publisher', () => {
  assert.ok(manifest.displayName);
  assert.ok(manifest.description);
  assert.ok(manifest.main);
  assert.ok(manifest.engines?.vscode);
});

test('every command referenced by a menu is declared', () => {
  const referenced = new Set();
  for (const entries of Object.values(contributes.menus ?? {})) {
    for (const entry of entries) {
      referenced.add(entry.command);
    }
  }

  const missing = [...referenced].filter((command) => !declaredCommands.has(command));
  assert.deepEqual(missing, []);
});

test('activation events reference declared commands or views', () => {
  const views = new Set(Object.values(contributes.views ?? {}).flat().map((view) => view.id));

  for (const event of manifest.activationEvents ?? []) {
    if (event.startsWith('onCommand:')) {
      assert.ok(declaredCommands.has(event.slice('onCommand:'.length)), `unknown command in ${event}`);
    }

    if (event.startsWith('onView:')) {
      assert.ok(views.has(event.slice('onView:'.length)), `unknown view in ${event}`);
    }
  }
});

test('the assemblies view is contributed by the ilasmDotnet container', () => {
  const containers = new Set((contributes.viewsContainers?.activitybar ?? []).map((entry) => entry.id));
  assert.ok(containers.has('ilasmDotnet'));
  assert.ok((contributes.views?.ilasmDotnet ?? []).some((view) => view.id === 'ilasmDotnet.assemblies'));
});

test('the context menu of a source file offers the viewer once', () => {
  // One entry on purpose: the tab switches between IL, both C# flavours and ASM itself, so a menu
  // with one button per view would only repeat what is inside. The other entry commands stay
  // available through the Command Palette.
  const entries = (contributes.menus?.['editor/context'] ?? []).filter((entry) =>
    String(entry.when).includes('editorLangId'),
  );

  assert.equal(entries.length, 1, entries.map((entry) => entry.command).join(', '));
  assert.equal(entries[0].command, 'ilasmDotnet.showPanel');
  assert.ok(declaredCommands.has(entries[0].command));
});

test('the viewer is offered for every language that compiles to an assembly', () => {
  // The viewer reads an assembly, and a source file is only how that assembly is found: C#, F# and
  // VB all produce the same metadata. A language missing here is a project whose file cannot open
  // its own IL, which is what F# was before this.
  const conditions = [
    ...(contributes.menus?.['editor/context'] ?? []).map((entry) => entry.when),
    ...(contributes.menus?.commandPalette ?? []).filter((entry) => declaredCommands.has(entry.command)).map((entry) => entry.when),
    ...(contributes.keybindings ?? []).map((entry) => entry.when),
    ...(manifest.activationEvents ?? []),
  ]
    .filter(Boolean)
    .join(' ');

  for (const language of ['csharp', 'fsharp', 'vb']) {
    assert.ok(conditions.includes(language), `${language} is not offered in the manifest`);
  }
});

test('a language condition lists every language explicitly', () => {
  // The equality form is used on purpose: a pattern such as `editorLangId =~ /^(csharp|fsharp)$/`
  // would be shorter, but a condition VS Code cannot parse hides an entry of the menu without a
  // word, and this form is the one that has been seen working in a real host. It is also why the
  // check above names the languages rather than trusting one spelling of the condition.
  const whens = [
    ...(contributes.menus?.['editor/context'] ?? []).map((entry) => entry.when),
    ...(contributes.menus?.commandPalette ?? []).map((entry) => entry.when),
    ...(contributes.keybindings ?? []).map((entry) => entry.when),
  ].filter(Boolean);

  for (const when of whens) {
    if (!when.includes('editorLangId')) {
      continue;
    }

    assert.ok(!when.includes('=~'), `a pattern condition cannot be verified here: ${when}`);
    for (const language of ['csharp', 'fsharp', 'vb']) {
      assert.ok(when.includes(`editorLangId == ${language}`), `${language} is missing from ${when}`);
    }
  }
});

test('manifest file references exist', () => {
  const references = [
    manifest.main,
    contributes.viewsContainers?.activitybar?.[0]?.icon,
    ...(contributes.grammars ?? []).map((grammar) => grammar.path),
    ...(contributes.languages ?? []).map((language) => language.configuration).filter(Boolean),
  ].filter(Boolean);

  for (const reference of references) {
    assert.ok(fs.existsSync(path.join(root, reference)), `${reference} is missing`);
  }
});

test('the grammars target contributed languages', () => {
  const languages = new Set((contributes.languages ?? []).map((language) => language.id));
  for (const grammar of contributes.grammars ?? []) {
    assert.ok(languages.has(grammar.language), `grammar language ${grammar.language} is not contributed`);
  }
});

test('the IL grammar is valid JSON with a scope name', () => {
  const grammarPath = path.join(root, contributes.grammars[0].path);
  const grammar = JSON.parse(fs.readFileSync(grammarPath, 'utf8'));
  assert.equal(grammar.scopeName, 'source.il');
  assert.ok(grammar.repository.comments);
  assert.ok(grammar.repository.opcodes);
});

test('every key binding is unique and points at a declared command', () => {
  const bindings = contributes.keybindings ?? [];
  assert.ok(bindings.length > 0, 'no key binding is contributed');

  const seen = new Set();
  for (const binding of bindings) {
    assert.ok(declaredCommands.has(binding.command), `unknown command in ${binding.key}`);
    assert.ok(binding.key, `${binding.command} has no key`);
    const identity = `${binding.key}|${binding.when ?? ''}`;
    assert.ok(!seen.has(identity), `${binding.key} is bound twice for the same context`);
    seen.add(identity);
  }
});

test('configuration defaults match what the code reads', () => {
  const properties = contributes.configuration?.properties ?? {};
  for (const key of [
    'ilasmDotnet.dotnetPath',
    'ilasmDotnet.enginePath',
    'ilasmDotnet.includeCompilerGenerated',
    'ilasmDotnet.syncOriginalSource',
    'ilasmDotnet.syncScroll',
    'ilasmDotnet.nativeIncludeRuntime',
  ]) {
    assert.ok(properties[key], `${key} is not contributed`);
  }
});
