import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { prepare, metadata, withUpdateUrls, DISTRIBUTION_BASE, REPOSITORY_URL, projectRoot } from './build.mjs';

const catalog = JSON.parse(await readFile(resolve(projectRoot, 'catalog.json'), 'utf8'));
const approved = ['bi-temu-profit-price-export', 'erp-sales-sync-selfhost', 'oms-erp-shared-inventory-by-warehouse', 'oms-erp-waybill-bulk-delete', 'temu-marketing-invite-detail-export', 'temu-price-adjust-reject', 'temu-warehouse-auto-fill', 'temu-waybill-batch-download', 'zhiyuan-erp-order-collector', 'zhiyuansys-erp-order-attachment-upload'];

test('只接入明确选中的十个业务脚本及一个安装示例', () => {
  assert.deepEqual(catalog.filter(item => !item.demo).map(item => item.id).sort(), approved);
  assert.equal(catalog.filter(item => item.demo).length, 1);
});

test('分发文件只包含固定脚本、元信息、目录和首页', async () => {
  const files = await prepare();
  const expected = ['README.md', 'scripts.json', ...catalog.flatMap(item => [`scripts/${item.id}.meta.js`, `scripts/${item.id}.user.js`])];
  assert.deepEqual([...files.keys()].sort(), expected.sort());
  const published = JSON.parse(files.get('scripts.json'));
  assert.ok(published.every(item => item.file === undefined && item.sourceSha256 === undefined));
  assert.ok(![...files.keys()].some(path => /PROJECT_MEMORY|\.github|userscripts|index\.html/.test(path)));
});

test('GitHub 更新地址固定，所有旧脚本的身份、权限、版本和业务正文保持原样', async () => {
  const files = await prepare();
  for (const entry of catalog) {
    const source = await readFile(resolve(projectRoot, entry.file), 'utf8');
    const output = files.get(`scripts/${entry.id}.user.js`);
    const before = metadata(source);
    const after = metadata(output);
    assert.equal(source.slice(before.header.length), output.slice(after.header.length));
    for (const key of ['name', 'namespace', 'version', 'author', 'match', 'include', 'exclude', 'grant', 'connect', 'require', 'resource', 'run-at', 'noframes']) {
      assert.deepEqual(after.values.get(key), before.values.get(key), `${entry.id} @${key}`);
    }
    assert.deepEqual(after.values.get('updateURL'), [`${DISTRIBUTION_BASE}/scripts/${entry.id}.meta.js`]);
    assert.deepEqual(after.values.get('downloadURL'), [`${DISTRIBUTION_BASE}/scripts/${entry.id}.user.js`]);
    assert.equal(files.get(`scripts/${entry.id}.meta.js`), after.header + '\n');
    assert.ok(!after.header.includes('__PUBLIC_ORIGIN__'));
  }
  const demo = metadata(files.get('scripts/install-check.user.js'));
  assert.deepEqual(demo.values.get('homepageURL'), [REPOSITORY_URL + '/']);
});

test('清单重复、身份不符、越界路径、错版本与源文件指纹不符均阻止生成', async () => {
  for (const entries of [
    [...catalog, catalog[0]],
    [{ ...catalog[0], version: '9.9.9' }],
    [{ ...catalog[0], file: '../README.md' }],
    [{ ...catalog[0], pages: ['https://other.example/*'] }],
    [{ ...catalog[0], name: '错误名称' }],
    [{ ...catalog[0], namespace: '错误命名空间' }],
    [{ ...catalog[0], sourceSha256: '0'.repeat(64) }],
    [{ ...catalog[0], updated: '2026-02-31' }],
    [{ ...catalog[0], platforms: [] }],
    [{ ...catalog[0], platforms: ['通用', '通用'] }]
  ]) {
    await assert.rejects(prepare({ catalog: entries }));
  }
});

test('旧更新地址被替换，缺少更新头时补齐，重复更新头被拒绝', () => {
  const base = '// ==UserScript==\n// @name test\n// @updateURL https://old.example/check.js\n// ==/UserScript==\nconst unchanged = true;\n';
  const output = withUpdateUrls(base, DISTRIBUTION_BASE, 'test');
  assert.ok(!output.includes('old.example'));
  assert.equal(metadata(output).values.get('downloadURL').length, 1);
  assert.throws(() => withUpdateUrls(base.replace('// ==/UserScript==', '// @updateURL https://other.example/\n// ==/UserScript=='), DISTRIBUTION_BASE, 'test'));
});

test('无参数 noframes 不会吞掉下一行更新地址', () => {
  const source = '// ==UserScript==\n// @name test\n// @noframes\n// ==/UserScript==\n';
  const values = metadata(withUpdateUrls(source, DISTRIBUTION_BASE, 'test')).values;
  assert.deepEqual(values.get('noframes'), ['']);
  assert.deepEqual(values.get('updateURL'), [`${DISTRIBUTION_BASE}/scripts/test.meta.js`]);
});

test('面单工作流完整六步且没有夹入独立标发工具', async () => {
  const files = await prepare();
  const entries = JSON.parse(files.get('scripts.json'));
  const flow = entries.filter(item => item.workflow?.id === 'oms-temu-waybill');
  assert.deepEqual(flow.map(item => item.workflow.step).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6]);
  assert.ok(!entries.some(item => item.id === 'oms-temu-carrier-tracking-fill'));
  const broken = catalog.map(item => item.workflow?.step === 6 ? { ...item, workflow: { ...item.workflow, step: 5 } } : item);
  await assert.rejects(prepare({ catalog: broken }));
});

test('GitHub 首页含用途、注意、版本和全部安装链接，工作流关系明确', async () => {
  const files = await prepare();
  const readme = files.get('README.md');
  assert.match(readme, /^# 团队共享脚本中心/);
  assert.match(readme, /\| 平台 \| 脚本名称 \| 用途 \| 使用注意 \| 当前版本 \| 安装链接 \|/);
  assert.match(readme, /6 个脚本需分别安装/);
  assert.ok(!readme.includes('pages.dev'));
  for (const item of catalog) {
    assert.ok(readme.includes(`[安装脚本](${DISTRIBUTION_BASE}/scripts/${item.id}.user.js)`));
    assert.ok(readme.includes(`v${item.version}`));
  }
});
