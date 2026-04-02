import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const cwd = process.cwd();
const distFile = path.resolve(cwd, 'dist/index.html');
// For VSCode extension, keep it in webview/dist (panel.ts reads it from there)
const targetFile = path.resolve(cwd, 'dist/index.html');

const main = async () => {
  const html = await readFile(distFile, 'utf-8');
  await mkdir(path.dirname(targetFile), { recursive: true });
  await writeFile(targetFile, html, 'utf-8');
  console.log(`[copy-dist] Build complete: ${distFile}`);
};

main().catch((error) => {
  console.error('[copy-dist] Failed to copy build output', error);
  process.exit(1);
});
