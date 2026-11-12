import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { loadTemplates, readZip, parseCsv, urlPath } from './template-assets.mjs';
import { prepare, projectRoot, DISTRIBUTION_BASE } from './build.mjs';

const catalog = JSON.parse(await readFile(resolve(projectRoot, 'catalog.json'), 'utf8'));
const manifest = JSON.parse(await readFile(resolve(projectRoot, 'templates/manifest.json'), 'utf8'));
const asset = name => manifest.assets.find(item => item.name === name);
const plainXml = text => text.replace(/(<\/?)[A-Za-z_][\w.-]*:/g, '$1');
const decode = text => text.replace(/&#(\d+);|&#x([0-9a-f]+);|&(amp|lt|gt|quot|apos);/gi, (_, decimal, hex, named) => decimal ? String.fromCodePoint(Number(decimal)) : hex ? String.fromCodePoint(parseInt(hex, 16)) : ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[named.toLowerCase()]);

function xlsxRows(zip, xml, width) {
  xml = plainXml(xml);
  const shared = [...plainXml(zip.get('xl/sharedStrings.xml')?.toString('utf8') ?? '').matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map(match => [...match[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(text => decode(text[1])).join(''));
  return [...xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)].map(row => {
    const values = Array(width).fill(null);
    for (const cell of row[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
      const address = cell[1].match(/\br="([A-Z]+)\d+"/);
      if (!address) continue;
      const col = [...address[1]].reduce((n, char) => n * 26 + char.charCodeAt(0) - 64, 0) - 1;
      const value = cell[2].match(/<v\b[^>]*>([\s\S]*?)<\/v>/)?.[1];
      if (/\bt="s"/.test(cell[1])) values[col] = shared[Number(value)];
      else if (/\bt="inlineStr"/.test(cell[1])) values[col] = [...cell[2].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(match => decode(match[1])).join('');
      else if (value != null) values[col] = /\bt="(?:str|e)"/.test(cell[1]) ? decode(value) : Number(value);
    }
    return values;
  });
}

async function functions(scriptId, names, extra = {}) {
  const entry = catalog.find(item => item.id === scriptId);
  const source = await readFile(resolve(projectRoot, entry.file), 'utf8');
  const code = names.map(name => {
    const match = source.match(new RegExp(`^  (?:async )?function ${name}\\([^]*?^  }`, 'm'));
    assert.ok(match, `源脚本函数 ${name} 不存在，需要重新核对模板合同`);
    return match[0];
  }).join('\n');
  return runInNewContext(code + '\n({' + names.join(',') + '})', { TextDecoder, ...extra });
}

test('仅发布用户目录的23份样例，每张表保留5条，并与ZIP内容一致', async () => {
  const result = await loadTemplates(projectRoot, catalog);
  assert.equal(result.assets.size, 23);
  assert.equal(manifest.assets.filter(item => item.format === 'CSV').length, 16);
  assert.equal(manifest.assets.filter(item => item.format === 'XLSX').length, 7);
  assert.ok(manifest.assets.every(item => item.sheets.every(sheet => sheet.dataRows === 5)));
});

test('Excel实际表头、冻结首行与清单一致，不携带公式或隐藏完整数据', async () => {
  for (const item of manifest.assets.filter(item => item.format === 'XLSX')) {
    const zip = readZip(await readFile(resolve(projectRoot, item.path)));
    const workbook = zip.get('xl/workbook.xml').toString('utf8');
    assert.ok(!/state="(?:hidden|veryHidden)"/.test(workbook), item.name);
    for (let index = 0; index < item.sheets.length; index++) {
      const xml = plainXml(zip.get(`xl/worksheets/sheet${index + 1}.xml`).toString('utf8'));
      const sheet = item.sheets[index];
      const rows = xlsxRows(zip, xml, sheet.headers.length);
      assert.equal(rows.length, 6, item.name);
      assert.deepEqual(rows[0], sheet.headers, item.name + ' ' + sheet.name);
      assert.match(xml, /<pane\b[^>]*\bySplit="1"/, item.name);
    }
  }
});

test('库存查询实际导入函数可以读取仓库优先级样例，不写入真实环境', async () => {
  let saved;
  const api = await functions('oms-erp-shared-inventory-by-warehouse', ['decodeCsv', 'parseCsv', 'importWhitelist'], {
    STORE: { whitelist: 'sandbox' }, gmSet: (_, value) => { saved = value; }, renderWhitelist: () => {}, setStatus: () => {},
  });
  const bytes = await readFile(resolve(projectRoot, asset('美发加仓库挑选顺序.csv').path));
  await api.importWhitelist({ name: 'sample.csv', arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
  assert.equal(saved.names.length, 5);
});

test('填仓对照样例符合实际四列位置；商品尺寸沿用源字段及数值单位', async () => {
  const api = await functions('temu-warehouse-auto-fill', ['normalizeErp', 'rowsToMapping', 'parseCsv', 'mappingFromCsv', 'finitePositive', 'productDataFromRows'], { PRODUCT_HEADERS: ['SKU', '毛重', '包装长', '包装宽', '包装高'] });
  const mapping = await readFile(resolve(projectRoot, asset('仓库对照表.csv').path), 'utf8');
  assert.equal(api.mappingFromCsv(mapping).length, 5);
  const dimensions = asset('商品尺寸数据表.xlsx');
  const zip = readZip(await readFile(resolve(projectRoot, dimensions.path)));
  const rows = xlsxRows(zip, zip.get('xl/worksheets/sheet1.xml').toString('utf8'), dimensions.sheets[0].headers.length);
  assert.equal(api.productDataFromRows(rows, 'sample.xlsx').stats.validRows, 5);
});

test('面单下载实际CSV解析器可识别原SKU映射表头', async () => {
  const api = await functions('temu-waybill-batch-download', ['normalizeHeader', 'parseCsvLine', 'parseCsv']);
  const text = await readFile(resolve(projectRoot, asset('skuid_sku货号映射.csv').path), 'utf8');
  assert.equal(api.parseCsv(text).count, 5);
});

test('活动退出当前解析器兼容现用12列样例，保持试跑之外零业务调用', async () => {
  const text = await readFile(resolve(projectRoot, asset('批量退活动.csv').path), 'utf8');
  const rows = parseCsv(text);
  const storeColumn = rows[0].findIndex(header => ['店铺', '店铺名称', '店铺信息'].includes(header));
  assert.ok(storeColumn >= 0);
  const stores = [...new Set(rows.slice(1).map(row => row[storeColumn]))].map((name, index) => ({ name, mallId: String(index + 1) }));
  const api = await functions('temu-marketing-invite-detail-export', ['toText', 'normalizeMatchText', 'resolveStoreInput', 'parseCsvText', 'findHeaderIndex', 'parseActivityPriceRaw', 'uniqueActivityPriceRaws', 'parseCancelCsv'], { stores, STORE_NAME_ALIASES: new Map() });
  const parsed = api.parseCancelCsv(text);
  assert.ok(parsed.rows.length > 0);
  assert.ok(parsed.rows.every(row => !row.validationError));
});

test('首页只关联已验证的五份输入表，所有样例都提供索引和合集', async () => {
  const files = await prepare();
  const readme = files.get('README.md');
  assert.match(readme, /\| 配套模板 \|/);
  assert.match(readme, /每张表只保留表头和前 5 条数据/);
  assert.match(readme, /下载全部 23 份参考表 ZIP/);
  assert.equal(catalog.flatMap(item => item.templateIds ?? []).length, 5);
  for (const item of catalog) {
    for (const id of item.templateIds ?? []) {
      const sample = manifest.assets.find(asset => asset.id === id);
      assert.ok(readme.includes(DISTRIBUTION_BASE + '/' + urlPath(sample.path)));
    }
  }
});
