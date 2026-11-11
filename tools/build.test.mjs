import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Script } from 'node:vm';
import { prepare, metadata, publicOrigin, projectRoot } from './build.mjs';

const catalog = JSON.parse(await readFile(resolve(projectRoot, 'catalog.json'), 'utf8'));

test('正式发布拒绝缺失或不安全的域名，本地地址必须显式选择', () => {
  for (const value of [undefined, 'http://team.pages.dev', 'https://user:pass@team.pages.dev', 'https://team.pages.dev/path', 'https://team.pages.dev/?q=1', 'https://localhost']) {
    assert.throws(() => publicOrigin(value));
  }
  assert.equal(publicOrigin('https://team.pages.dev/'), 'https://team.pages.dev');
  assert.equal(publicOrigin(undefined, true), 'http://127.0.0.1:4173');
});

test('只发布当前白名单：公开清单不暴露源文件路径和历史版本', async () => {
  const files = await prepare({ origin: 'https://team.pages.dev' });
  assert.deepEqual([...files.keys()].sort(), ['404.html', '_headers', 'app.js', 'index.html', 'scripts.json', 'scripts/install-check.meta.js', 'scripts/install-check.user.js', 'style.css'].sort());
  const published = JSON.parse(files.get('scripts.json'));
  assert.equal(published[0].file, undefined);
  assert.equal(published[0].installPath, 'scripts/install-check.user.js');
  assert.ok(![...files.keys()].some(path => /README|PROJECT_MEMORY|\.github|userscripts|v1\.0\.0/.test(path)));
});

test('脚本与更新头版本一致，更新头只含元信息，地址使用正式域名', async () => {
  const files = await prepare({ origin: 'https://team.pages.dev' });
  const script = files.get('scripts/install-check.user.js');
  const meta = files.get('scripts/install-check.meta.js');
  assert.equal(meta, metadata(script).header + '\n');
  const { values } = metadata(meta);
  assert.deepEqual(values.get('version'), ['1.0.0']);
  assert.deepEqual(values.get('namespace'), ['https://github.com/lucasshare/team-script-hub']);
  assert.deepEqual(values.get('updateURL'), ['https://team.pages.dev/scripts/install-check.meta.js']);
  assert.deepEqual(values.get('downloadURL'), ['https://team.pages.dev/scripts/install-check.user.js']);
  assert.ok(!script.includes('__PUBLIC_ORIGIN__'));
  assert.ok(!meta.includes('document.'));
  new Script(script);
  new Script(files.get('app.js'));
});

test('清单重复、版本不符、越界路径和无效匹配页面均阻止构建', async () => {
  for (const entries of [
    [...catalog, catalog[0]],
    [{ ...catalog[0], version: '9.9.9' }],
    [{ ...catalog[0], file: '../README.md' }],
    [{ ...catalog[0], pages: ['https://other.example/*'] }],
    [{ ...catalog[0], name: '与油猴不同的名称' }],
    [{ ...catalog[0], updated: '2026-02-31' }],
    [{ ...catalog[0], platforms: [] }],
    [{ ...catalog[0], platforms: [''] }],
    [{ ...catalog[0], platforms: ['通用', '通用'] }]
  ]) {
    await assert.rejects(prepare({ origin: 'https://team.pages.dev', catalog: entries }));
  }
});

test('页面显示共享标识，平台信息进入公开清单', async () => {
  const files = await prepare({ origin: 'https://team.pages.dev' });
  assert.match(files.get('index.html'), /<title>团队共享脚本中心<\/title>/);
  assert.match(files.get('index.html'), /class="shared-badge">团队共享</);
  assert.match(files.get('index.html'), /id="platform"/);
  assert.deepEqual(JSON.parse(files.get('scripts.json'))[0].platforms, ['通用']);
});
