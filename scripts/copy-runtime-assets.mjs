import { copyFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const assets = [
  ['src/features/japanese-search/worker.mjs', 'dist/features/japanese-search/worker.mjs'],
  ['src/features/ocr/reviewed.mjs', 'dist/features/ocr/reviewed.mjs'],
  ['src/features/original-images/image-worker.mjs', 'dist/features/original-images/image-worker.mjs'],
];

for (const [source, target] of assets) {
  await mkdir(dirname(target), { recursive: true });
  await copyFile(source, target);
  console.log(`Copied runtime worker asset: ${target}`);
}
