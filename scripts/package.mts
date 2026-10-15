#!/usr/bin/env node
// Packages the extension into dist/ilasm-dotnet-<version>.vsix. The name is taken from the manifest,
// so bumping the version does not mean editing a second copy of it in a script.
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { version: string };
const target = path.join(root, 'dist', `ilasm-dotnet-${manifest.version}.vsix`);

fs.mkdirSync(path.dirname(target), { recursive: true });

const vsce = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'vsce.cmd' : 'vsce');
execFileSync(vsce, ['package', '--out', target], { cwd: root, stdio: 'inherit' });
console.log(`packaged ${path.relative(root, target)}`);
