import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { projectRoot } from './build.mjs';

// 只验证搜索/平台/分类/加载状态的行为；此轻量 DOM 不代替浏览器视觉验收。
class Node {
  constructor(tag) { this.tagName = tag; this.children = []; this.listeners = {}; this.value = ''; this.hidden = false; this.textContent = ''; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  get firstElementChild() { return this.children[0]; }
  setAttribute(key, value) { this[key] = value; }
  addEventListener(name, fn) { this.listeners[name] = fn; }
}
const code = await readFile(resolve(projectRoot, 'web/app.js'), 'utf8');
const sample = {
  id: 'install-check', name: '安装验证', description: '检查油猴运行', platforms: ['通用'], category: '安装验证', version: '1.0.0',
  updated: '2026-11-11', pages: ['https://example.com/*'], usage: '打开适用页面', releaseNotes: '首版',
  demo: true, installPath: 'scripts/install-check.user.js'
};

async function start(fetch) {
  const nodes = Object.fromEntries(['search', 'platform', 'category', 'scripts', 'status', 'retry', 'count'].map(id => ['#' + id, new Node(id)]));
  runInNewContext(code, { document: { querySelector: id => nodes[id], createElement: tag => new Node(tag) }, fetch, AbortSignal });
  await new Promise(resolve => setImmediate(resolve));
  return nodes;
}

test('列表加载后可搜索、显示空结果，并组合分类过滤', async () => {
  const other = { ...sample, id: 'order-helper', name: '订单助手', category: '订单', installPath: 'scripts/order-helper.user.js' };
  const nodes = await start(async () => ({ ok: true, json: async () => [sample, other] }));
  assert.equal(nodes['#scripts'].children.length, 2);
  nodes['#search'].value = '订单';
  nodes['#search'].listeners.input();
  assert.equal(nodes['#scripts'].children.length, 1);
  nodes['#category'].value = '安装验证';
  nodes['#category'].listeners.change();
  assert.equal(nodes['#scripts'].children.length, 0);
  assert.match(nodes['#status'].textContent, /没有找到/);
  nodes['#search'].value = 'EXAMPLE.COM';
  nodes['#search'].listeners.input();
  assert.equal(nodes['#scripts'].children.length, 1);
  assert.equal(nodes['#status'].hidden, true);
});

test('网络失败显示重试，恢复后显示可安装脚本', async () => {
  let attempts = 0;
  const nodes = await start(async () => {
    if (attempts++ === 0) throw new Error('连接失败');
    return { ok: true, json: async () => [sample] };
  });
  assert.equal(nodes['#retry'].hidden, false);
  assert.match(nodes['#status'].textContent, /连接失败/);
  await nodes['#retry'].listeners.click();
  assert.equal(nodes['#retry'].hidden, true);
  const card = nodes['#scripts'].children[0];
  const install = card.children.at(-1).children.at(-1);
  assert.equal(install.href, 'scripts/install-check.user.js');
  assert.equal(install['aria-label'], '安装 安装验证 v1.0.0');
});

test('清单中的任意远程安装路径都会被拒绝', async () => {
  const nodes = await start(async () => ({ ok: true, json: async () => [{ ...sample, installPath: 'https://other.example/bad.user.js' }] }));
  assert.equal(nodes['#scripts'].children.length, 0);
  assert.equal(nodes['#retry'].hidden, false);
  assert.match(nodes['#status'].textContent, /格式不正确/);
});

test('平台从清单生成，多平台脚本可按任一平台找到并组合分类搜索', async () => {
  const shared = { ...sample, platforms: ['平台甲', '平台乙'] };
  const other = { ...sample, id: 'export-helper', platforms: ['平台乙'], category: '导出', installPath: 'scripts/export-helper.user.js' };
  const nodes = await start(async () => ({ ok: true, json: async () => [shared, other] }));
  assert.deepEqual(nodes['#platform'].children.map(option => option.textContent), ['全部平台', '平台甲', '平台乙']);
  nodes['#platform'].value = '平台甲';
  nodes['#platform'].listeners.change();
  assert.equal(nodes['#scripts'].children.length, 1);
  nodes['#platform'].value = '平台乙';
  nodes['#platform'].listeners.change();
  assert.equal(nodes['#scripts'].children.length, 2);
  nodes['#category'].value = '安装验证';
  nodes['#search'].value = '平台甲';
  nodes['#search'].listeners.input();
  assert.equal(nodes['#scripts'].children.length, 1);
  nodes['#category'].value = '导出';
  nodes['#category'].listeners.change();
  assert.equal(nodes['#scripts'].children.length, 0);
});
