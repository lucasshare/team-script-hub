// ==UserScript==
// @name         OMS ERP 共享库存按仓库明细查询
// @namespace    https://oms.zhiyuansys.com/
// @version      1.1.0
// @description  按自定义 SKU 查询共享库存，并按上传的仓库优先级生成推荐仓库映射
// @author       Lucas
// @match        https://oms.zhiyuansys.com/SharedInventory*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_setClipboard
// @grant        GM_addStyle
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const STORE = {
    position: 'omsInventoryV110Position',
    whitelist: 'omsInventoryV110WarehouseWhitelist',
    threshold: 'omsInventoryV110Threshold',
    skus: 'omsInventoryV110Skus',
  };
  const MAP_KEY = 'lucas:oms:recommendedWarehouseMap:v1';
  const MAP_CHANNEL = 'lucas-oms-recommended-warehouse-map-v1';
  const DEFAULT_POSITION = { left: 18, top: 120 };
  const BUBBLE_SIZE = 44;
  const MARGIN = 8;
  const MAX_INPUT_SKUS = 500;

  let lastRows = [];
  let lastQuerySkus = [];
  let panel;
  let bubble;
  let expanded = false;
  let dragMoved = false;
  let channel = null;

  const gmGet = (key, fallback) => (typeof GM_getValue === 'function' ? GM_getValue(key, fallback) : fallback);
  const gmSet = (key, value) => { if (typeof GM_setValue === 'function') GM_setValue(key, value); };
  const escapeHtml = value => String(value == null ? '' : value).replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
  const normalizeSku = value => String(value == null ? '' : value).trim();
  const toQuantity = value => {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
  };

  const css = `
    #oms-inventory-v110-panel, #oms-inventory-v110-bubble { font-family: -apple-system,BlinkMacSystemFont,"SF Pro Text","PingFang SC",sans-serif; }
    #oms-inventory-v110-panel { position: fixed; z-index: 2147483600; width: min(520px, calc(100vw - 16px)); height: min(600px, calc(100vh - 16px)); color: #172033; background: #fff; border: 1px solid #dde2ea; border-radius: 14px; box-shadow: 0 14px 36px rgba(20,34,58,.16); overflow: hidden; display: none; }
    #oms-inventory-v110-panel * { box-sizing: border-box; }
    #oms-inventory-v110-panel button, #oms-inventory-v110-panel input, #oms-inventory-v110-panel textarea { font: inherit; }
    .oiv-head { height: 44px; display: flex; align-items: center; gap: 8px; padding: 0 9px 0 12px; border-bottom: 1px solid #e8edf5; cursor: move; user-select: none; }
    .oiv-head strong { font-size: 14px; flex: 1; }
    .oiv-head button { width: 28px; height: 28px; border: 0; border-radius: 8px; background: #eef2f8; color: #4b5870; cursor: pointer; }
    .oiv-body { height: calc(100% - 44px); padding: 8px; overflow: auto; }
    .oiv-card { background: #fff; border: 1px solid #e8edf5; border-radius: 10px; padding: 8px; margin-bottom: 7px; }
    .oiv-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .oiv-row + .oiv-row { margin-top: 6px; }
    .oiv-label { color: #566178; font-size: 12px; }
    .oiv-grow { flex: 1; min-width: 170px; }
    .oiv-input, .oiv-textarea { width: 100%; border: 1px solid #dfe5ee; border-radius: 10px; background: #fbfcfe; color: #172033; outline: none; }
    .oiv-input { height: 30px; padding: 0 8px; }
    .oiv-textarea { min-height: 68px; padding: 7px 8px; resize: vertical; line-height: 1.4; }
    .oiv-input:focus, .oiv-textarea:focus { border-color: #4f7cff; box-shadow: 0 0 0 3px rgba(79,124,255,.14); }
    .oiv-btn { min-height: 30px; border: 0; border-radius: 8px; padding: 5px 9px; background: #edf1f7; color: #344158; cursor: pointer; font-weight: 600; font-size: 12px; }
    .oiv-btn.primary { background: #356df3; color: #fff; }
    .oiv-btn.success { background: #16845b; color: #fff; }
    .oiv-btn:disabled { opacity: .45; cursor: not-allowed; }
    .oiv-btn:focus-visible, .oiv-head button:focus-visible, #oms-inventory-v110-bubble:focus-visible { outline: 3px solid rgba(53,109,243,.35); outline-offset: 2px; }
    .oiv-muted { color: #7a8599; font-size: 12px; line-height: 1.45; }
    .oiv-status { min-height: 22px; padding: 8px 10px; border-radius: 10px; background: #f1f5fb; color: #48566f; font-size: 12px; white-space: pre-wrap; }
    .oiv-status.error { background: #fff0f0; color: #a92c2c; }
    .oiv-status.success { background: #ebf8f2; color: #126b4b; }
    .oiv-table-wrap { border: 1px solid #e7ebf2; border-radius: 9px; overflow: auto; max-height: 255px; background: #fff; }
    .oiv-table { width: 100%; border-collapse: collapse; font-size: 12px; }
    .oiv-table th { position: sticky; top: 0; z-index: 1; background: #f5f7fb; color: #536077; text-align: left; }
    .oiv-table th, .oiv-table td { padding: 7px 8px; border-bottom: 1px solid #edf0f5; white-space: nowrap; }
    .oiv-table tr:last-child td { border-bottom: 0; }
    .oiv-empty { color: #9a6370; }
    #oms-inventory-v110-bubble { position: fixed; z-index: 2147483601; width: ${BUBBLE_SIZE}px; height: ${BUBBLE_SIZE}px; border: 1px solid rgba(255,255,255,.9); border-radius: 50%; padding: 0; background: #303640; color: #fff; box-shadow: 0 6px 18px rgba(15,23,42,.24), inset 0 0 0 1px rgba(255,255,255,.12); cursor: grab; display: grid; place-items: center; font-size: 11px; font-weight: 700; text-align: center; }
    #oms-inventory-v110-bubble::after { content: ''; position: absolute; right: 2px; bottom: 3px; width: 7px; height: 7px; border: 2px solid #303640; border-radius: 50%; background: #3b82f6; }
    #oms-inventory-v110-bubble:active { cursor: grabbing; }
    @media (prefers-color-scheme: dark) { #oms-inventory-v110-bubble { border-color: rgba(255,255,255,.9); box-shadow: 0 9px 24px rgba(0,0,0,.55),0 0 0 2px rgba(0,0,0,.65); } }
    @media (prefers-reduced-motion: reduce) { #oms-inventory-v110-panel, #oms-inventory-v110-bubble { transition: none !important; } }
  `;
  if (typeof GM_addStyle === 'function') GM_addStyle(css);

  function parseSkuInput(text) {
    return [...new Set(String(text || '').split(/[\n,，\t ]+/).map(normalizeSku).filter(Boolean))].slice(0, MAX_INPUT_SKUS);
  }

  function decodeCsv(buffer) {
    const bytes = new Uint8Array(buffer);
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder('utf-8').decode(bytes.subarray(3));
    if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
    if (bytes[0] === 0xfe && bytes[1] === 0xff) {
      const swapped = new Uint8Array(bytes.length - 2);
      for (let i = 2; i + 1 < bytes.length; i += 2) { swapped[i - 2] = bytes[i + 1]; swapped[i - 1] = bytes[i]; }
      return new TextDecoder('utf-16le').decode(swapped);
    }
    const zeroEven = bytes.filter((_, index) => index % 2 === 0 && bytes[index] === 0).length;
    const zeroOdd = bytes.filter((_, index) => index % 2 === 1 && bytes[index] === 0).length;
    if (zeroOdd > bytes.length / 8) return new TextDecoder('utf-16le').decode(bytes);
    if (zeroEven > bytes.length / 8) {
      const swapped = new Uint8Array(bytes.length);
      for (let i = 0; i + 1 < bytes.length; i += 2) { swapped[i] = bytes[i + 1]; swapped[i + 1] = bytes[i]; }
      return new TextDecoder('utf-16le').decode(swapped);
    }
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch (_) { return new TextDecoder('gb18030').decode(bytes); }
  }

  function parseCsv(text) {
    const rows = [];
    let row = [];
    let field = '';
    let quoted = false;
    let atFieldStart = true;
    const source = String(text || '').replace(/^\ufeff/, '');
    for (let i = 0; i < source.length; i++) {
      const ch = source[i];
      if (quoted) {
        if (ch === '"' && source[i + 1] === '"') { field += '"'; i++; }
        else if (ch === '"') quoted = false;
        else field += ch;
        continue;
      }
      if (ch === '"' && atFieldStart) { quoted = true; atFieldStart = false; continue; }
      if (ch === ',') { row.push(field); field = ''; atFieldStart = true; continue; }
      if (ch === '\r' || ch === '\n') {
        if (ch === '\r' && source[i + 1] === '\n') i++;
        row.push(field); rows.push(row); row = []; field = ''; atFieldStart = true; continue;
      }
      field += ch;
      atFieldStart = false;
    }
    if (quoted) throw new Error('CSV 存在未闭合的双引号');
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows.filter(items => items.some(value => String(value).trim() !== ''));
  }

  function readWhitelist() {
    const value = gmGet(STORE.whitelist, null);
    return value && Array.isArray(value.names) ? value : { names: [], importedAt: '' };
  }

  function getThreshold() {
    const value = Number(gmGet(STORE.threshold, 15));
    return Number.isFinite(value) ? value : 15;
  }

  function recommendForSku(sku, whitelist, threshold) {
    const priorities = new Map(whitelist.map((name, index) => [name, index]));
    const candidates = lastRows
      .filter(row => row.sku === sku && priorities.has(row.warehouse))
      .map(row => ({ ...row, priority: priorities.get(row.warehouse), quantityNumber: toQuantity(row.quantity) }));
    if (!candidates.length) return null;
    const above = candidates.filter(item => item.quantityNumber > threshold).sort((a, b) => a.priority - b.priority);
    if (above.length) return { ...above[0], reason: `库存 ${above[0].quantityNumber} > ${threshold}，按优先级选择` };
    candidates.sort((a, b) => b.quantityNumber - a.quantityNumber || a.priority - b.priority);
    return { ...candidates[0], reason: `均未超过 ${threshold}，选择白名单内库存最多仓库` };
  }

  function clampPosition(left, top, width, height) {
    return {
      left: Math.max(MARGIN, Math.min(left, window.innerWidth - width - MARGIN)),
      top: Math.max(MARGIN, Math.min(top, window.innerHeight - height - MARGIN)),
    };
  }

  function snapBubble(left, top) {
    const pos = clampPosition(left, top, BUBBLE_SIZE, BUBBLE_SIZE);
    const distances = [
      { side: 'left', value: pos.left },
      { side: 'right', value: window.innerWidth - pos.left - BUBBLE_SIZE },
      { side: 'top', value: pos.top },
      { side: 'bottom', value: window.innerHeight - pos.top - BUBBLE_SIZE },
    ].sort((a, b) => a.value - b.value);
    if (distances[0].side === 'left') pos.left = MARGIN;
    if (distances[0].side === 'right') pos.left = window.innerWidth - BUBBLE_SIZE - MARGIN;
    if (distances[0].side === 'top') pos.top = MARGIN;
    if (distances[0].side === 'bottom') pos.top = window.innerHeight - BUBBLE_SIZE - MARGIN;
    return clampPosition(pos.left, pos.top, BUBBLE_SIZE, BUBBLE_SIZE);
  }

  function applyPosition(element, position) {
    element.style.left = `${position.left}px`;
    element.style.top = `${position.top}px`;
  }

  function savedPosition() {
    const value = gmGet(STORE.position, DEFAULT_POSITION);
    return value && Number.isFinite(Number(value.left)) && Number.isFinite(Number(value.top))
      ? { left: Number(value.left), top: Number(value.top) } : DEFAULT_POSITION;
  }

  function persistPosition(position) {
    gmSet(STORE.position, { left: Math.round(position.left), top: Math.round(position.top) });
  }

  function bindDrag(handle, target, isBubble) {
    handle.addEventListener('pointerdown', event => {
      if (!isBubble && event.target.closest('button,input,textarea')) return;
      event.preventDefault();
      const startX = event.clientX;
      const startY = event.clientY;
      const rect = target.getBoundingClientRect();
      let moved = false;
      if (isBubble) dragMoved = false;
      handle.setPointerCapture(event.pointerId);
      const move = moveEvent => {
        const dx = moveEvent.clientX - startX;
        const dy = moveEvent.clientY - startY;
        if (Math.hypot(dx, dy) > 5) { moved = true; if (isBubble) dragMoved = true; }
        const pos = clampPosition(rect.left + dx, rect.top + dy, target.offsetWidth, target.offsetHeight);
        applyPosition(target, pos);
      };
      const up = upEvent => {
        handle.releasePointerCapture(upEvent.pointerId);
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        const current = target.getBoundingClientRect();
        const pos = isBubble ? snapBubble(current.left, current.top) : clampPosition(current.left, current.top, target.offsetWidth, target.offsetHeight);
        applyPosition(target, pos);
        persistPosition(pos);
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
    });
  }

  function setExpanded(next) {
    expanded = next;
    const current = savedPosition();
    if (expanded) {
      bubble.style.display = 'none';
      panel.style.display = 'block';
      applyPosition(panel, clampPosition(current.left, current.top, panel.offsetWidth || 520, panel.offsetHeight || 600));
    } else {
      panel.style.display = 'none';
      bubble.style.display = 'grid';
      const pos = snapBubble(current.left, current.top);
      applyPosition(bubble, pos);
      persistPosition(pos);
    }
  }

  function setStatus(text, type = '') {
    const status = panel.querySelector('#oiv-status');
    status.className = `oiv-status${type ? ` ${type}` : ''}`;
    status.textContent = text;
  }

  function setBusy(busy) {
    panel.querySelectorAll('button,input,textarea').forEach(element => {
      if (element.id !== 'oiv-collapse') element.disabled = busy;
    });
  }

  function renderWhitelist() {
    const whitelist = readWhitelist();
    panel.querySelector('#oiv-whitelist-info').textContent = whitelist.names.length
      ? `已保存 ${whitelist.names.length} 个仓库 · ${new Date(whitelist.importedAt).toLocaleString()}`
      : '尚未导入仓库顺序 CSV';
  }

  function renderResults() {
    const container = panel.querySelector('#oiv-results');
    if (!lastQuerySkus.length) {
      container.innerHTML = '<div class="oiv-muted">查询后在这里显示仓库明细。</div>';
      return;
    }
    const grouped = new Map(lastQuerySkus.map(sku => [sku, []]));
    lastRows.forEach(row => { if (grouped.has(row.sku)) grouped.get(row.sku).push(row); });
    const body = [];
    grouped.forEach((rows, sku) => {
      if (!rows.length) body.push(`<tr><td>${escapeHtml(sku)}</td><td colspan="5" class="oiv-empty">未找到库存明细</td></tr>`);
      else rows.forEach((row, index) => body.push(`<tr><td>${index ? '' : escapeHtml(row.sku)}</td><td>${index ? '' : escapeHtml(row.productName)}</td><td>${escapeHtml(row.warehouse)}</td><td>${escapeHtml(row.quantity)}</td><td>${escapeHtml(row.stockAge)}</td><td>${escapeHtml(row.syncTime)}</td></tr>`));
    });
    container.innerHTML = `<div class="oiv-table-wrap"><table class="oiv-table"><thead><tr><th>自定义 SKU</th><th>商品名</th><th>仓库</th><th>数量</th><th>库龄</th><th>同步时间</th></tr></thead><tbody>${body.join('')}</tbody></table></div>`;
  }

  async function postForm(url, params) {
    const response = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest' },
      body: params.toString(),
    });
    if (!response.ok) throw new Error(`${url} 返回 HTTP ${response.status}`);
    return response.json();
  }

  async function queryInventory() {
    const input = panel.querySelector('#oiv-skus');
    const skus = parseSkuInput(input.value);
    if (!skus.length) throw new Error('请输入至少一个自定义 SKU');
    gmSet(STORE.skus, input.value);
    lastRows = [];
    lastQuerySkus = skus;
    renderResults();
    setBusy(true);
    try {
      setStatus(`正在定位 SKU（${skus.length} 个）…`);
      const params = new URLSearchParams();
      params.set('draw', '1'); params.set('start', '0'); params.set('length', '500');
      params.set('search[value]', ''); params.set('search[regex]', 'false');
      params.set('search_type', 'sku'); params.set('search_type_id', 'sku'); params.set('search_param', '');
      params.set('c_string', `${skus.join('\n')}\n`); params.append('warehouse_id[]', '11');
      const listResponse = await postForm('/SharedInventory/lists', params);
      const idMap = new Map();
      (Array.isArray(listResponse && listResponse.data) ? listResponse.data : []).forEach(item => {
        const sku = normalizeSku(item && item.sku);
        if (sku) idMap.set(sku, { id: item.id, productName: item.sku_name || '' });
      });
      for (let index = 0; index < skus.length; index++) {
        const sku = skus[index];
        setStatus(`正在读取仓库明细 ${index + 1}/${skus.length} · ${sku}`);
        const info = idMap.get(sku);
        if (!info) continue;
        const detailParams = new URLSearchParams();
        detailParams.set('id', info.id);
        const detailResponse = await postForm('/SharedInventory/getTotalStock', detailParams);
        const details = Array.isArray(detailResponse && detailResponse.data) ? detailResponse.data : [];
        details.forEach(item => lastRows.push({
          sku,
          productName: info.productName,
          warehouse: String(item && item.warehouse_name || '').trim(),
          quantity: item && item.quantity,
          stockAge: item && item.stock_age,
          syncTime: item && item.sync_time,
        }));
      }
      renderResults();
      setStatus(`查询完成：${skus.length} 个 SKU，${lastRows.length} 条仓库明细。`, 'success');
    } finally {
      setBusy(false);
    }
  }

  function generateMapping() {
    if (!lastQuerySkus.length) throw new Error('请先查询库存');
    const whitelist = readWhitelist();
    if (!whitelist.names.length) throw new Error('请先导入仓库顺序 CSV');
    const thresholdInput = panel.querySelector('#oiv-threshold');
    const threshold = Number(thresholdInput.value);
    if (!Number.isFinite(threshold)) throw new Error('库存阈值必须是数字');
    gmSet(STORE.threshold, threshold);
    const items = {};
    let withoutWhitelistWarehouse = 0;
    lastQuerySkus.forEach(sku => {
      const choice = recommendForSku(sku, whitelist.names, threshold);
      if (!choice) { withoutWhitelistWarehouse++; return; }
      items[sku] = {
        customSku: sku,
        warehouse: choice.warehouse,
        quantity: choice.quantityNumber,
        reason: choice.reason,
      };
    });
    const mapping = {
      version: 1,
      generatedAt: new Date().toISOString(),
      threshold,
      whitelistImportedAt: whitelist.importedAt,
      sourceSkuCount: lastQuerySkus.length,
      items,
    };
    localStorage.setItem(MAP_KEY, JSON.stringify(mapping));
    try {
      channel = channel || new BroadcastChannel(MAP_CHANNEL);
      channel.postMessage({ type: 'mapping-updated', generatedAt: mapping.generatedAt, count: Object.keys(items).length });
    } catch (_) { /* BroadcastChannel 不可用时，localStorage 仍可供订单页读取。 */ }
    window.dispatchEvent(new CustomEvent('lucas:oms:warehouse-map-updated', { detail: mapping }));
    setStatus(`仓库映射已生成：${Object.keys(items).length} 条；无白名单仓库 ${withoutWhitelistWarehouse} 个。`, 'success');
  }

  function copyMapping() {
    const raw = localStorage.getItem(MAP_KEY);
    if (!raw) throw new Error('尚未生成仓库映射');
    const mapping = JSON.parse(raw);
    const lines = ['自定义 SKU\t推荐仓库'];
    Object.values(mapping.items || {}).forEach(item => lines.push(`${item.customSku}\t${item.warehouse}`));
    const text = lines.join('\r\n');
    if (typeof GM_setClipboard === 'function') GM_setClipboard(text, 'text');
    else navigator.clipboard.writeText(text);
    setStatus(`已复制 ${Math.max(0, lines.length - 1)} 条 SKU + 仓库。`, 'success');
  }

  async function importWhitelist(file) {
    if (!file) return;
    const text = decodeCsv(await file.arrayBuffer());
    const rows = parseCsv(text);
    if (!rows.length) throw new Error('CSV 为空');
    const headers = rows[0].map(value => String(value).trim());
    const nameIndex = headers.indexOf('名称');
    if (nameIndex < 0) throw new Error('CSV 缺少“名称”列');
    const names = rows.slice(1).map(row => String(row[nameIndex] || '').trim()).filter(Boolean);
    if (!names.length) throw new Error('“名称”列没有仓库数据');
    const duplicates = names.filter((name, index) => names.indexOf(name) !== index);
    if (duplicates.length) throw new Error(`“名称”列存在重复仓库：${[...new Set(duplicates)].join('、')}`);
    gmSet(STORE.whitelist, { names, importedAt: new Date().toISOString(), sourceName: file.name });
    renderWhitelist();
    setStatus(`仓库顺序已保存：${names.length} 个仓库。以后规则不变时无需重新上传。`, 'success');
  }

  function buildUi() {
    bubble = document.createElement('button');
    bubble.id = 'oms-inventory-v110-bubble';
    bubble.type = 'button';
    bubble.title = '展开 SKU 库存查询';
    bubble.textContent = '库存';

    panel = document.createElement('section');
    panel.id = 'oms-inventory-v110-panel';
    panel.innerHTML = `
      <header class="oiv-head"><strong>SKU 库存查询</strong><button id="oiv-collapse" type="button" title="收起">—</button></header>
      <main class="oiv-body">
        <section class="oiv-card">
          <div class="oiv-row"><div class="oiv-grow"><div class="oiv-label">仓库优先级 CSV</div><div id="oiv-whitelist-info" class="oiv-muted"></div></div><label class="oiv-btn" for="oiv-file">选择 CSV</label><input id="oiv-file" type="file" accept=".csv,text/csv" hidden></div>
          <div class="oiv-row"><label class="oiv-label" for="oiv-threshold">库存阈值（严格大于）</label><input id="oiv-threshold" class="oiv-input" type="number" step="1" style="width:110px"><span class="oiv-muted">默认 15，修改后自动记忆</span></div>
        </section>
        <section class="oiv-card">
          <label class="oiv-label" for="oiv-skus">自定义 SKU（换行、逗号或空格分隔）</label>
          <textarea id="oiv-skus" class="oiv-textarea" spellcheck="false"></textarea>
          <div class="oiv-row"><button id="oiv-query" class="oiv-btn primary" type="button">查询库存</button><button id="oiv-generate" class="oiv-btn success" type="button">生成仓库映射</button><button id="oiv-copy" class="oiv-btn" type="button">复制 SKU + 仓库</button></div>
        </section>
        <div id="oiv-status" class="oiv-status">等待操作。查询和生成映射都只在点击后执行。</div>
        <section id="oiv-results" class="oiv-card"><div class="oiv-muted">查询后在这里显示仓库明细。</div></section>
      </main>`;
    document.body.append(bubble, panel);
    panel.querySelector('#oiv-threshold').value = String(getThreshold());
    panel.querySelector('#oiv-skus').value = String(gmGet(STORE.skus, ''));
    renderWhitelist();

    bubble.addEventListener('click', () => { if (!dragMoved) setExpanded(true); dragMoved = false; });
    panel.querySelector('#oiv-collapse').addEventListener('click', () => setExpanded(false));
    panel.querySelector('#oiv-threshold').addEventListener('change', event => {
      const value = Number(event.target.value);
      if (Number.isFinite(value)) gmSet(STORE.threshold, value);
    });
    panel.querySelector('#oiv-file').addEventListener('change', async event => {
      try { await importWhitelist(event.target.files && event.target.files[0]); }
      catch (error) { setStatus(error.message, 'error'); }
      finally { event.target.value = ''; }
    });
    panel.querySelector('#oiv-query').addEventListener('click', async () => {
      try { await queryInventory(); } catch (error) { setStatus(error.message, 'error'); setBusy(false); }
    });
    panel.querySelector('#oiv-generate').addEventListener('click', () => {
      try { generateMapping(); } catch (error) { setStatus(error.message, 'error'); }
    });
    panel.querySelector('#oiv-copy').addEventListener('click', () => {
      try { copyMapping(); } catch (error) { setStatus(error.message, 'error'); }
    });
    bindDrag(bubble, bubble, true);
    bindDrag(panel.querySelector('.oiv-head'), panel, false);
    setExpanded(false);
    window.addEventListener('resize', () => {
      const target = expanded ? panel : bubble;
      const rect = target.getBoundingClientRect();
      const pos = expanded
        ? clampPosition(rect.left, rect.top, target.offsetWidth, target.offsetHeight)
        : snapBubble(rect.left, rect.top);
      applyPosition(target, pos);
      persistPosition(pos);
    });
  }

  if (document.body) buildUi();
  else window.addEventListener('DOMContentLoaded', buildUi, { once: true });
})();
