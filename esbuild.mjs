import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

const options = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  outfile: 'out/extension.js',
  external: ['vscode'],
  sourcemap: true,
  logLevel: 'info',
  minify: !watch,
};

if (watch) {
  const context = await esbuild.context(options);
  await context.watch();
  console.log('watching for changes...');
} else {
  await esbuild.build(options);
}
