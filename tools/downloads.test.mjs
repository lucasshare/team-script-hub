import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import { prepareDownloads, root } from './build-downloads.mjs';
import { resolve } from 'node:path';

const manifest = JSON.parse(await readFile(resolve(root, 'templates/manifest.json'), 'utf8'));
const items = [...manifest.assets, manifest.bundle];

async function exercise(id, { corrupt = false } = {}) {
  const output = await prepareDownloads();
  const html = output.get('index.html').toString('utf8');
  const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1];
  const nodes = new Map();
  const downloads = [];
  const blobs = new Map();
  let requests = 0;
  const document = {
    querySelector: key => {
      if (!nodes.has(key)) nodes.set(key, { addEventListener(name, callback) { this[name] = callback; } });
      return nodes.get(key);
    },
    body: { append() {} },
    createElement: () => ({ click() { downloads.push({ name: this.download, blob: blobs.get(this.href) }); }, remove() {} }),
  };
  class LocalURL extends URL {
    static createObjectURL(blob) { const url = `blob:isolated-${blobs.size}`; blobs.set(url, blob); return url; }
    static revokeObjectURL() {}
  }
  const fetch = async path => {
    requests++;
    assert.ok(!/^https?:/.test(path), '模板必须从同一个Pages包读取');
    const bytes = corrupt ? Buffer.from('changed') : output.get(decodeURIComponent(path));
    assert.ok(bytes, '下载路径必须存在于部署包');
    return { ok: true, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
  };
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  await new AsyncFunction('document', 'fetch', 'crypto', 'URL', 'Blob', 'location', 'addEventListener', script)(
    document, fetch, webcrypto, LocalURL, Blob, { search: `?id=${encodeURIComponent(id)}` }, () => {},
  );
  return { nodes, downloads, requests };
}

test('Pages部署包只包含下载页、5份原中文名模板和中文ZIP，不包含脚本或其他业务表', async () => {
  const files = await prepareDownloads();
  assert.equal(files.size, 8);
  assert.ok(files.has('.nojekyll'));
  assert.ok(!files.get('index.html').includes(Buffer.from('__DOWNLOAD_FILES__')));
  for (const item of items) {
    const matches = [...files.entries()].filter(([name]) => name.endsWith('/' + item.downloadName));
    assert.equal(matches.length, 1);
    assert.deepEqual(matches[0][1], await readFile(resolve(root, item.path)));
  }
});

test('5份模板及ZIP使用原中文下载名，自动下载及手动重试保存同一份原字节', async () => {
  for (const item of items) {
    const { nodes, downloads } = await exercise(item.id);
    assert.equal(downloads.length, 1);
    assert.equal(downloads[0].name, item.downloadName);
    assert.deepEqual(Buffer.from(await downloads[0].blob.arrayBuffer()), await readFile(resolve(root, item.path)));
    nodes.get('#save').click();
    assert.equal(downloads.length, 2);
    assert.equal(downloads[1].name, item.downloadName);
  }
});

test('未知ID与对象原型名不发起请求，内容指纹不符不触发下载', async () => {
  for (const id of ['unknown', 'toString', '__proto__']) {
    const result = await exercise(id);
    assert.equal(result.requests, 0);
    assert.equal(result.downloads.length, 0);
    assert.match(result.nodes.get('#error').textContent, /共享脚本首页/);
  }
  const result = await exercise(items[0].id, { corrupt: true });
  assert.equal(result.downloads.length, 0);
  assert.match(result.nodes.get('#error').textContent, /文件正在更新/);
});
