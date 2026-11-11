// ==UserScript==
// @name         致远ERP 订单采集器
// @namespace    lichuan.erp.collector
// @version      2.8
// @description  采集订单与平台 SKU ID、填充空仓库，并创建可在 TEMU 页面精确匹配的批次任务
// @author       Lucas
// @match        https://oms.zhiyuansys.com/Order/index*
// @noframes
// @grant        none
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/lucasshare/team-script-hub/main/scripts/zhiyuan-erp-order-collector.meta.js
// @downloadURL  https://raw.githubusercontent.com/lucasshare/team-script-hub/main/scripts/zhiyuan-erp-order-collector.user.js
// ==/UserScript==

(function () {
  'use strict';

  document.querySelectorAll('#__ecp, #__ecpBubble').forEach(element => element.remove());

  const KEYS = {
    state: '__erp_collector_state_v2',
    orders: 'erpOrders',
    map: 'lucas:oms:recommendedWarehouseMap:v1',
    taskEvent: 'lucas:oms:temuTaskEvent:v1',
    tabId: 'lucas:oms:collectorTabId:v1',
  };
  const CHANNELS = {
    map: 'lucas-oms-recommended-warehouse-map-v1',
    task: 'lucas-oms-temu-task-v1',
  };
  const BUBBLE_SIZE = 44;
  const MARGIN = 8;
  const defaultState = { x: 18, y: 110 };
  let state = readJson(localStorage.getItem(KEYS.state), defaultState);
  let data = [];
  let selected = new Set();
  let root;
  let taskChannel;
  let mapChannel;
  let lastCreatedTask = null;
  let dragMoved = false;

  const tabId = (() => {
    let value = sessionStorage.getItem(KEYS.tabId);
    if (!value) {
      value = `oms-tab-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      sessionStorage.setItem(KEYS.tabId, value);
    }
    return value;
  })();

  function readJson(raw, fallback) {
    try { return raw ? { ...fallback, ...JSON.parse(raw) } : { ...fallback }; }
    catch (_) { return { ...fallback }; }
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[<>&"']/g, char => ({
      '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;',
    }[char]));
  }

  function splitBr(html) {
    return String(html || '').split(/<br\s*\/?>/i);
  }

  function stripTags(value) {
    return String(value || '').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function normalizeErp(value) {
    const compact = String(value || '').replace(/\s+/g, '').trim();
    const match = compact.match(/(\d+号仓.*)$/);
    return match ? match[1] : compact;
  }

  function noteFor(sku) {
    return /usca/i.test(String(sku || '')) ? '美发加' : '';
  }

  function warehouseIsEmpty(value) {
    return ['', '暂无', '—', '-'].includes(String(value == null ? '' : value).trim());
  }

  function platformSkuIdIndex() {
    const buckets = new Map();
    try {
      const jq = window.jQuery;
      if (!jq || !jq.fn || !jq.fn.DataTable || !jq.fn.DataTable.isDataTable('#example1')) {
        return { unique: new Map(), conflicts: new Set() };
      }
      jq('#example1').DataTable().rows({ search: 'applied', page: 'current' }).data().toArray().forEach(item => {
        const info = item && item.info || {};
        const orderId = String(info.id || '').trim();
        (Array.isArray(item && item.detail) ? item.detail : []).forEach(detail => {
          const channelSku = String(detail && detail.sellsku || '').trim();
          const platformSkuId = String(detail && detail.pfkey || '').trim();
          if (!orderId || !channelSku || !platformSkuId) return;
          const key = `${orderId}||${channelSku}`;
          if (!buckets.has(key)) buckets.set(key, new Set());
          buckets.get(key).add(platformSkuId);
        });
      });
    } catch (error) {
      console.error('[ERP 采集器] 平台 SKU ID 读取失败', error);
    }
    const unique = new Map();
    const conflicts = new Set();
    buckets.forEach((values, key) => {
      if (values.size === 1) unique.set(key, [...values][0]);
      else conflicts.add(key);
    });
    return { unique, conflicts };
  }

  function collect() {
    const output = [];
    const platformIds = platformSkuIdIndex();
    document.querySelectorAll('#example1 tbody tr[role="row"]').forEach(tr => {
      try {
        const tds = tr.querySelectorAll('td');
        if (tds.length < 8) return;
        const checkbox = tds[0].querySelector('input[name="checkList"]');
        const so = checkbox && checkbox.getAttribute('lables') || '';
        const innerId = checkbox && checkbox.getAttribute('values') || '';
        const orderLines = splitBr(tds[2].querySelector('p') && tds[2].querySelector('p').innerHTML).map(stripTags).filter(Boolean);
        const channelMain = (orderLines.find(line => /^渠道：/.test(line)) || '').replace(/^渠道：/, '');
        const channel = orderLines.find(line => /^temu-/i.test(line)) || '';
        const po = orderLines.find(line => /^PO-/.test(line)) || '';
        const deadline = (orderLines.find(line => /^发货限时：/.test(line)) || '').replace(/^发货限时：/, '');
        const productBox = tds[3].querySelector('.col-md-8');
        const productLines = splitBr(productBox && productBox.innerHTML).map(stripTags).filter(Boolean);
        const channelSku = (productLines[0] || '').split(/\s+/)[0] || '';
        const platformSkuKey = `${innerId}||${channelSku}`;
        const platformSkuId = platformIds.conflicts.has(platformSkuKey) ? '' : platformIds.unique.get(platformSkuKey) || '';
        let customSku = '';
        let qty = 1;
        const quantityLine = productLines.find(line => /\bx\b/.test(line));
        if (quantityLine) {
          const match = quantityLine.match(/^(\S+)\s*x\s*(\d+)/);
          if (match) { customSku = match[1]; qty = parseInt(match[2], 10) || 1; }
        }
        const productName = productLines[3] || '';
        const warehouseText = tds[6].innerText || '';
        const erpWarehouseRaw = (warehouseText.match(/仓库：([^\n]+)/) || [])[1] || '';
        const orderStatus = ((tds[7].innerText.match(/订单状态：(\S+)/) || [])[1] || '').trim();
        output.push({
          so, innerId, po, channelMain, channel, channelSku, platformSkuId, customSku, qty, productName,
          erpWarehouseRaw: erpWarehouseRaw.trim(),
          erpWarehouse: normalizeErp(erpWarehouseRaw),
          orderStatus, deadline, note: noteFor(channelSku),
        });
      } catch (error) {
        console.error('[ERP 采集器] 单行采集失败', error);
      }
    });
    return output;
  }

  function dataSignature(rows) {
    const value = JSON.stringify(rows.map(row => [row.so, row.po, row.channelSku, row.platformSkuId, row.customSku, row.erpWarehouse, row.qty]));
    let hash = 2166136261;
    for (let index = 0; index < value.length; index++) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return `${rows.length}-${(hash >>> 0).toString(16)}`;
  }

  function saveState(position) {
    state = { x: Math.round(position.x), y: Math.round(position.y) };
    localStorage.setItem(KEYS.state, JSON.stringify(state));
  }

  function clamp(x, y, width, height) {
    return {
      x: Math.max(MARGIN, Math.min(x, window.innerWidth - width - MARGIN)),
      y: Math.max(MARGIN, Math.min(y, window.innerHeight - height - MARGIN)),
    };
  }

  function snap(x, y) {
    const position = clamp(x, y, BUBBLE_SIZE, BUBBLE_SIZE);
    const sides = [
      ['left', position.x],
      ['right', window.innerWidth - position.x - BUBBLE_SIZE],
      ['top', position.y],
      ['bottom', window.innerHeight - position.y - BUBBLE_SIZE],
    ].sort((a, b) => a[1] - b[1]);
    if (sides[0][0] === 'left') position.x = MARGIN;
    if (sides[0][0] === 'right') position.x = window.innerWidth - BUBBLE_SIZE - MARGIN;
    if (sides[0][0] === 'top') position.y = MARGIN;
    if (sides[0][0] === 'bottom') position.y = window.innerHeight - BUBBLE_SIZE - MARGIN;
    return clamp(position.x, position.y, BUBBLE_SIZE, BUBBLE_SIZE);
  }

  function place(element, position) {
    element.style.left = `${position.x}px`;
    element.style.top = `${position.y}px`;
  }

  function bindDrag(handle, target, isBubble) {
    handle.addEventListener('pointerdown', event => {
      if (!isBubble && event.target.closest('button,input,[contenteditable]')) return;
      event.preventDefault();
      let moved = false;
      if (isBubble) dragMoved = false;
      const startX = event.clientX;
      const startY = event.clientY;
      const rect = target.getBoundingClientRect();
      handle.setPointerCapture(event.pointerId);
      const onMove = moveEvent => {
        const dx = moveEvent.clientX - startX;
        const dy = moveEvent.clientY - startY;
        if (Math.hypot(dx, dy) > 5) { moved = true; if (isBubble) dragMoved = true; }
        place(target, clamp(rect.left + dx, rect.top + dy, target.offsetWidth, target.offsetHeight));
      };
      const onUp = upEvent => {
        handle.releasePointerCapture(upEvent.pointerId);
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onUp);
        const current = target.getBoundingClientRect();
        const position = isBubble ? snap(current.left, current.top) : clamp(current.left, current.top, target.offsetWidth, target.offsetHeight);
        place(target, position);
        saveState(position);
      };
      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onUp);
    });
  }

  const css = `
    #__ecp,#__ecpBubble{font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","PingFang SC",sans-serif;color:#1d1d1f;box-sizing:border-box}
    #__ecp *{box-sizing:border-box}
    #__ecpBubble{position:fixed;z-index:2147483590;width:${BUBBLE_SIZE}px;height:${BUBBLE_SIZE}px;border:1px solid rgba(255,255,255,.9);border-radius:50%;display:grid;place-items:center;padding:0;background:#303640;color:#fff;box-shadow:0 6px 18px rgba(15,23,42,.24),inset 0 0 0 1px rgba(255,255,255,.12);font-size:11px;font-weight:700;text-align:center;cursor:grab;user-select:none}
    #__ecpBubble::after{content:'';position:absolute;right:2px;bottom:3px;width:7px;height:7px;border:2px solid #303640;border-radius:50%;background:#22c55e}
    #__ecpBubble:active{cursor:grabbing}
    #__ecp{position:fixed;z-index:2147483590;width:min(1000px,calc(100vw - 16px));height:auto;max-height:min(720px,calc(100vh - 16px));display:flex;flex-direction:column;background:#fff;border:1px solid #dde2ea;border-radius:14px;box-shadow:0 14px 36px rgba(20,34,58,.16);overflow:hidden;font-size:12px}
    #__ecp .hd{min-height:44px;padding:5px 8px 5px 12px;display:flex;align-items:center;gap:6px;cursor:move;user-select:none;border-bottom:1px solid rgba(0,0,0,.08);background:#f7f8fa}
    #__ecp .ttl{font-weight:700;font-size:14px}#__ecp .stat{color:#777;font-size:11px}#__ecp .sp{flex:1}
    #__ecp button{font:inherit;font-weight:600;font-size:11px;min-height:28px;padding:4px 8px;border-radius:8px;border:0;cursor:pointer;background:#edf0f5;color:#344158}
    #__ecp button:hover{filter:brightness(.97)}#__ecp button:disabled{opacity:.45;cursor:not-allowed}
    #__ecp button:focus-visible,#__ecp input:focus-visible,#__ecpBubble:focus-visible{outline:3px solid rgba(0,122,255,.34);outline-offset:2px}
    #__ecp .primary{background:#0878ef;color:#fff}#__ecp .success{background:#16845b;color:#fff}#__ecp .purple{background:#8651c7;color:#fff}
    #__ecp .icon{width:31px;padding:0;font-size:16px;background:transparent;color:#6f7682}
    #__ecp .meta{display:flex;gap:10px;align-items:center;min-height:32px;padding:5px 12px;border-bottom:1px solid #edf0f5;background:#fbfcfe;color:#667085;font-size:11px;flex-wrap:wrap}
    #__ecp .meta strong{color:#344158}#__ecp .warn{color:#a55700;font-weight:600}
    #__ecp .msg{display:none;padding:7px 12px;font-size:11px;font-weight:600;white-space:pre-wrap}
    #__ecp .msg.info{display:block;background:#eaf3ff;color:#075eaf}#__ecp .msg.ok{display:block;background:#eaf8f1;color:#126b4b}#__ecp .msg.err{display:block;background:#fff0f0;color:#a92c2c}
    #__ecp .body{overflow:auto;flex:0 1 auto;min-height:140px;max-height:min(560px,max(160px,calc(100vh - 160px)))}#__ecp table{min-width:1180px;width:100%;border-collapse:collapse}#__ecp thead{position:sticky;top:0;background:#f5f7fa;z-index:2}
    #__ecp th,#__ecp td{padding:5px 7px;border-bottom:1px solid #edf0f5;text-align:left;white-space:nowrap;font-size:11px;line-height:1.35}#__ecp th{font-size:10px;color:#687386}
    #__ecp th[data-f="so"],#__ecp td[data-f="so"]{min-width:150px}#__ecp th[data-f="po"],#__ecp td[data-f="po"]{min-width:190px}#__ecp th[data-f="channelSku"],#__ecp td[data-f="channelSku"]{min-width:140px}#__ecp th[data-f="customSku"],#__ecp td[data-f="customSku"]{min-width:126px}#__ecp th[data-f="qty"],#__ecp td[data-f="qty"]{min-width:42px}#__ecp th[data-f="erpWarehouse"],#__ecp td[data-f="erpWarehouse"]{min-width:150px}#__ecp th[data-f="platformSkuId"],#__ecp td[data-f="platformSkuId"]{min-width:125px}
    #__ecp td[contenteditable]{cursor:text}#__ecp td[contenteditable]:focus{outline:2px solid #0878ef;outline-offset:-2px;background:#edf6ff}
    #__ecp .cpCol{margin-left:4px;color:#788398;cursor:pointer;font-size:13px}#__ecp .badge{padding:1px 6px;border-radius:7px;background:#fff0d9;color:#9a5700;font-size:10px}
    #__ecp .empty{padding:48px 16px;text-align:center;color:#8992a3}#__ecp .ft{padding:6px 12px;border-top:1px solid #edf0f5;color:#7b8494;font-size:10px;background:#fafbfc}
    #__ecp input[type=checkbox]{accent-color:#0878ef;width:15px;height:15px}
    @media(prefers-color-scheme:dark){#__ecpBubble{border-color:#fff;box-shadow:0 9px 24px rgba(0,0,0,.55),0 0 0 2px #000}}
    @media(prefers-reduced-motion:reduce){#__ecp,#__ecpBubble{transition:none!important}}
  `;
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  const FIELDS = ['so', 'po', 'channelSku', 'customSku', 'erpWarehouse', 'channel', 'productName', 'orderStatus', 'deadline', 'note', 'platformSkuId', 'qty'];
  const HEADERS = {
    so: 'SO 号', po: '订单号 (PO)', channel: '渠道', channelSku: '渠道 SKU', customSku: '自定义 SKU',
    platformSkuId: '平台 SKU ID', qty: '数量', erpWarehouse: '仓库', productName: '产品名', orderStatus: '状态', deadline: '截止', note: '备注',
  };

  function selectedRows() {
    return [...selected].sort((a, b) => a - b).map(index => data[index]).filter(Boolean);
  }

  function buildExport(rows = selectedRows()) {
    return rows.map(row => ({
      so: row.so, innerId: row.innerId, po: row.po, channelMain: row.channelMain, channel: row.channel,
      channelSku: row.channelSku, platformSkuId: row.platformSkuId, customSku: row.customSku, qty: row.qty, productName: row.productName,
      erpWarehouseRaw: row.erpWarehouseRaw, erpWarehouse: normalizeErp(row.erpWarehouse),
      orderStatus: row.orderStatus, deadline: row.deadline, note: row.note || noteFor(row.channelSku),
      skus: [row.channelSku],
    }));
  }

  function buildHorizontalCopy(rows = selectedRows()) {
    const cleanCell = value => String(value == null ? '' : value).replace(/[\t\r\n]+/g, ' ').trim();
    return rows.map(row => [
      cleanCell(row.po),
      cleanCell(row.so),
      cleanCell(normalizeErp(row.erpWarehouse)),
    ].join('\t')).join('\r\n');
  }

  function readMapping() {
    try {
      const parsed = JSON.parse(localStorage.getItem(KEYS.map) || 'null');
      return parsed && parsed.items && typeof parsed.items === 'object' ? parsed : null;
    } catch (_) { return null; }
  }

  function mappingSummary() {
    const mapping = readMapping();
    if (!mapping) return '仓库映射：尚未生成';
    const count = Object.keys(mapping.items || {}).length;
    const time = mapping.generatedAt ? new Date(mapping.generatedAt).toLocaleString() : '时间未知';
    return `仓库映射：${count} 条 · ${time}`;
  }

  function showMessage(message, type = 'info', persistent = false) {
    const element = root && root.querySelector('#ecpMsg');
    if (!element) return;
    element.className = `msg ${type}`;
    element.textContent = message;
    clearTimeout(showMessage.timer);
    if (!persistent) showMessage.timer = setTimeout(() => { element.className = 'msg'; }, 5000);
  }

  function renderBubble() {
    root.innerHTML = '<button id="__ecpBubble" type="button" title="展开 ERP 采集器">采集</button>';
    const bubble = root.querySelector('#__ecpBubble');
    const position = snap(state.x, state.y);
    place(bubble, position);
    saveState(position);
    bindDrag(bubble, bubble, true);
    bubble.addEventListener('click', () => {
      if (!dragMoved) expandAndCollect();
      dragMoved = false;
    });
  }

  function renderPanel() {
    root.innerHTML = `
      <section id="__ecp">
        <header class="hd">
          <span class="ttl">ERP 订单采集器</span><span id="ecpS" class="stat"></span><span class="sp"></span>
          <button id="ecpRe" class="primary" type="button">重新采集</button>
          <button id="ecpFill" class="success" type="button">填充空仓库</button>
          <button id="ecpCopyRow" type="button" title="按一单一行复制 PO、SO 和仓库">复制 PO/SO/仓</button>
          <button id="ecpCopy" type="button">复制 JSON</button>
          <button id="ecpTask" class="purple" type="button">设为本批 TEMU 任务</button>
          <button id="ecpMin" class="icon" type="button" title="收起">—</button>
        </header>
        <div class="meta"><span id="ecpMap"></span><span id="ecpTaskState"></span></div>
        <div id="ecpMsg" class="msg"></div>
        <div class="body"><table><thead><tr>
          <th style="width:36px;text-align:center"><input type="checkbox" id="ecpAll" aria-label="全选"></th>
          ${FIELDS.map(field => `<th data-f="${field}">${HEADERS[field]}<span class="cpCol" data-f="${field}" title="复制勾选行的本列">⎘</span></th>`).join('')}
        </tr></thead><tbody id="ecpB"></tbody></table></div>
        <footer class="ft">双击单元格可修改；仓库映射只填充当前面板内的空仓库，不覆盖已有仓库；创建 TEMU 任务后若数据变化，请重新创建。</footer>
      </section>`;
    const panel = root.querySelector('#__ecp');
    bindEvents();
    renderRows();
    refreshMeta();
    place(panel, clamp(state.x, state.y, panel.offsetWidth, panel.offsetHeight));
    bindDrag(panel.querySelector('.hd'), panel, false);
  }

  function renderRows() {
    const status = root.querySelector('#ecpS');
    if (status) status.textContent = `共 ${data.length} 单 / 已选 ${selected.size}`;
    const body = root.querySelector('#ecpB');
    if (!body) return;
    if (!data.length) {
      body.innerHTML = `<tr><td colspan="${FIELDS.length + 1}" class="empty">当前页面未采集到订单</td></tr>`;
      return;
    }
    const all = root.querySelector('#ecpAll');
    all.checked = selected.size === data.length;
    all.indeterminate = selected.size > 0 && selected.size < data.length;
    body.innerHTML = data.map((row, index) => `<tr>
      <td style="text-align:center"><input type="checkbox" class="ecpRow" data-i="${index}" ${selected.has(index) ? 'checked' : ''}></td>
      ${FIELDS.map(field => {
        const value = row[field];
        const content = field === 'note' && value ? `<span class="badge">${escapeHtml(value)}</span>` : escapeHtml(value);
        return `<td contenteditable="true" data-f="${field}" data-i="${index}">${content}</td>`;
      }).join('')}
    </tr>`).join('');
  }

  function refreshMeta() {
    const map = root && root.querySelector('#ecpMap');
    if (map) map.textContent = mappingSummary();
    const taskState = root && root.querySelector('#ecpTaskState');
    if (!taskState) return;
    if (!lastCreatedTask) {
      taskState.textContent = '本页尚未创建 TEMU 任务';
      taskState.className = '';
      return;
    }
    const stale = lastCreatedTask.dataSignature !== dataSignature(data);
    taskState.textContent = stale
      ? `任务 ${lastCreatedTask.label} 已过期，请重新创建`
      : `当前任务：${lastCreatedTask.label}`;
    taskState.className = stale ? 'warn' : '';
  }

  function fillEmptyWarehouses() {
    const mapping = readMapping();
    if (!mapping) return showMessage('没有可用仓库映射，请先在 SKU 库存查询页面生成。', 'err');
    let filled = 0;
    let existing = 0;
    let unmatched = 0;
    let emptySku = 0;
    data.forEach(row => {
      if (!warehouseIsEmpty(row.erpWarehouse)) { existing++; return; }
      const sku = String(row.customSku || '').trim();
      if (!sku) { emptySku++; return; }
      const item = mapping.items && mapping.items[sku];
      if (!item || !item.warehouse) { unmatched++; return; }
      row.erpWarehouse = item.warehouse;
      row.erpWarehouseRaw = item.warehouse;
      filled++;
    });
    renderRows();
    refreshMeta();
    showMessage(`填充完成：成功填充 ${filled}；已有仓库跳过 ${existing}；未匹配 ${unmatched}；SKU 为空 ${emptySku}。`, 'ok', true);
  }

  function createTask() {
    const rows = buildExport();
    if (!rows.length) return showMessage('请先勾选要交给 TEMU 填充的订单。', 'err');
    const validRows = rows.filter(row => String(row.po || '').trim() && String(row.channelSku || '').trim());
    const invalidCount = rows.length - validRows.length;
    if (!validRows.length) return showMessage('勾选行都缺少 PO 或渠道 SKU，无法建立精确匹配任务。', 'err');
    const createdAt = new Date().toISOString();
    const firstPo = validRows[0].po || '无订单号';
    const task = {
      version: 2,
      id: `oms-${Date.now()}-${tabId.slice(-6)}`,
      createdAt,
      sourceTabId: tabId,
      sourceUrl: location.href,
      label: `${new Date(createdAt).toLocaleString()} · ${validRows.length} 单 · ${firstPo}`,
      orderCount: validRows.length,
      poList: [...new Set(validRows.map(row => row.po))],
      dataSignature: dataSignature(data),
      rows: validRows,
    };
    const envelope = { type: 'upsert-task', eventId: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, task };
    localStorage.setItem(KEYS.orders, JSON.stringify(validRows));
    localStorage.setItem(KEYS.taskEvent, JSON.stringify(envelope));
    try {
      taskChannel = taskChannel || new BroadcastChannel(CHANNELS.task);
      taskChannel.postMessage(envelope);
    } catch (_) { /* 同源 localStorage 和自定义事件仍可传递任务。 */ }
    window.dispatchEvent(new CustomEvent('lucas:oms:temu-task', { detail: envelope }));
    lastCreatedTask = task;
    refreshMeta();
    showMessage(`TEMU 任务已创建：${validRows.length} 单${invalidCount ? `；另有 ${invalidCount} 行因缺少 PO/渠道 SKU 未加入` : ''}。`, 'ok', true);
  }

  function bindEvents() {
    root.querySelector('#ecpMin').addEventListener('click', renderBubble);
    root.querySelector('#ecpRe').addEventListener('click', () => {
      data = collect();
      selected = new Set(data.map((_, index) => index));
      renderRows();
      refreshMeta();
      showMessage(`采集完成：${data.length} 单。`, 'ok');
    });
    root.querySelector('#ecpFill').addEventListener('click', fillEmptyWarehouses);
    root.querySelector('#ecpTask').addEventListener('click', createTask);
    root.querySelector('#ecpCopyRow').addEventListener('click', async () => {
      const rows = selectedRows();
      if (!rows.length) return showMessage('没有勾选任何行。', 'err');
      const text = buildHorizontalCopy(rows);
      try {
        await navigator.clipboard.writeText(text);
        showMessage(`已横向复制 ${rows.length} 单：PO / SO / 仓库。`, 'ok');
      } catch (_) {
        window.prompt('剪贴板写入失败，请手动复制 PO / SO / 仓库：', text);
      }
    });
    root.querySelector('#ecpCopy').addEventListener('click', async () => {
      const rows = buildExport();
      if (!rows.length) return showMessage('没有勾选任何行。', 'err');
      const json = JSON.stringify(rows);
      try { await navigator.clipboard.writeText(json); showMessage(`已复制 ${rows.length} 单。`, 'ok'); }
      catch (_) { window.prompt('剪贴板写入失败，请手动复制：', json); }
    });
    root.querySelector('#ecpAll').addEventListener('change', event => {
      selected = event.target.checked ? new Set(data.map((_, index) => index)) : new Set();
      renderRows();
    });
    root.querySelector('#ecpB').addEventListener('change', event => {
      if (!event.target.classList.contains('ecpRow')) return;
      const index = Number(event.target.dataset.i);
      if (event.target.checked) selected.add(index); else selected.delete(index);
      renderRows();
    });
    root.querySelector('#ecpB').addEventListener('blur', event => {
      const cell = event.target;
      if (cell.tagName !== 'TD' || !cell.dataset.f) return;
      const index = Number(cell.dataset.i);
      const field = cell.dataset.f;
      let value = cell.innerText.trim();
      if (field === 'qty') value = parseInt(value, 10) || 1;
      data[index][field] = value;
      if (field === 'erpWarehouse') data[index].erpWarehouseRaw = value;
      if (field === 'channelSku') data[index].note = noteFor(value);
      renderRows();
      refreshMeta();
    }, true);
    root.onclick = event => {
      const button = event.target.closest('.cpCol');
      if (!button) return;
      event.preventDefault();
      event.stopPropagation();
      const field = button.dataset.f;
      const values = selectedRows().map(row => row[field] == null ? '' : row[field]).join('\r\n');
      if (!values) return showMessage('没有勾选任何行。', 'err');
      navigator.clipboard.writeText(values)
        .then(() => showMessage(`已复制“${HEADERS[field]}”共 ${selected.size} 行。`, 'ok'))
        .catch(() => window.prompt(`请手动复制“${HEADERS[field]}”：`, values));
    };
  }

  function expandAndCollect() {
    data = collect();
    selected = new Set(data.map((_, index) => index));
    renderPanel();
    showMessage(`采集完成：${data.length} 单。`, 'ok');
  }

  function bindMappingNotifications() {
    window.addEventListener('storage', event => {
      if (event.key === KEYS.map) refreshMeta();
    });
    window.addEventListener('lucas:oms:warehouse-map-updated', refreshMeta);
    try {
      mapChannel = new BroadcastChannel(CHANNELS.map);
      mapChannel.addEventListener('message', refreshMeta);
    } catch (_) { /* 不支持 BroadcastChannel 时依赖 localStorage。 */ }
  }

  root = document.createElement('div');
  document.body.appendChild(root);
  bindMappingNotifications();
  renderBubble();

  window.addEventListener('resize', () => {
    const panel = root.querySelector('#__ecp');
    const bubble = root.querySelector('#__ecpBubble');
    const target = panel || bubble;
    if (!target) return;
    const rect = target.getBoundingClientRect();
    const position = bubble ? snap(rect.left, rect.top) : clamp(rect.left, rect.top, target.offsetWidth, target.offsetHeight);
    place(target, position);
    saveState(position);
  });
})();
