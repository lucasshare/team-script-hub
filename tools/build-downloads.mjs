import { readFile, mkdir, writeFile, rm } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTemplates, urlPath } from './template-assets.mjs';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export async function prepareDownloads() {
  const catalog = JSON.parse(await readFile(resolve(root, 'catalog.json'), 'utf8'));
  const { manifest } = await loadTemplates(root, catalog);
  const output = new Map([['.nojekyll', Buffer.alloc(0)]]);
  const entries = Object.create(null);
  for (const file of [...manifest.assets, manifest.bundle]) {
    const owner = catalog.find(entry => entry.templateIds?.includes(file.id));
    const path = `files/${owner?.id ?? 'bundle'}/${file.downloadName}`;
    output.set(path, await readFile(resolve(root, file.path)));
    entries[file.id] = { name: file.downloadName, path: urlPath(path), sha256: file.sha256 };
  }
  const source = await readFile(resolve(root, 'downloads/index.html'), 'utf8');
  const json = JSON.stringify(entries).replaceAll('<', '\\u003c');
  output.set('index.html', Buffer.from(source.replace('__DOWNLOAD_FILES__', json)));
  return output;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = await prepareDownloads();
  const target = resolve(root, 'dist/downloads');
  await rm(target, { recursive: true, force: true });
  for (const [path, bytes] of files) {
    await mkdir(dirname(resolve(target, path)), { recursive: true });
    await writeFile(resolve(target, path), bytes);
  }
  console.log(`下载辅助页已生成：${files.size} 个文件，仅含页面、5份模板、ZIP和.nojekyll。`);
}
