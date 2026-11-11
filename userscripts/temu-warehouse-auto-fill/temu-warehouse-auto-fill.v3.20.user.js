// ==UserScript==
// @name         Temu 仓库自动填充
// @namespace    lichuan.temu.filler
// @version      3.20
// @description  接收 OMS 批次，在订单列表由用户手动填入并查询本批 PO，并在普通在线下单和补发货页面填写尺寸与仓库；签名及物流渠道由人工选择
// @author       Lucas
// @match        https://oms.zhiyuansys.com/Order/index*
// @match        https://agentseller.temu.com/mmsos/online-shipping.html*
// @match        https://agentseller-us.temu.com/mmsos/online-shipping.html*
// @match        https://agentseller-eu.temu.com/mmsos/online-shipping.html*
// @match        https://agentseller.temu.com/mmsos/online-reship.html*
// @match        https://agentseller-us.temu.com/mmsos/online-reship.html*
// @match        https://agentseller-eu.temu.com/mmsos/online-reship.html*
// @match        https://agentseller.temu.com/mmsos/orders.html*
// @match        https://agentseller-us.temu.com/mmsos/orders.html*
// @match        https://agentseller-eu.temu.com/mmsos/orders.html*
// @noframes
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addValueChangeListener
// @grant        unsafeWindow
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const IS_OMS = location.hostname === 'oms.zhiyuansys.com';
  const IS_RESHIP = location.pathname === '/mmsos/online-reship.html';
  const IS_ORDER_LIST = location.pathname === '/mmsos/orders.html';
  const OMS_TASK_EVENT_KEY = 'lucas:oms:temuTaskEvent:v1';
  const OMS_TASK_CHANNEL = 'lucas-oms-temu-task-v1';
  const GM_KEYS = {
    tasks: 'temuFill_tasks_v1',
    activeTask: 'temuFill_activeTask_v1',
    mapping: 'temuFill_mapping_v2',
    productData: 'temuFill_productData_v1',
    state: 'temuFill_state_v2',
    orderSearchState: 'temuFill_orderSearchState_v1',
  };
  const LEGACY_MAP_KEY = 'temuFill_mapping_v1';
  const MAX_TASKS = 20;
  const BUBBLE_SIZE = 44;
  const MARGIN = 8;
  const KG_TO_LB = 2.2046226218487757;
  const CM_PER_INCH = 2.54;
  const MAX_AUTO_SPLIT_UNITS = 30;
  const DEFAULT_ITEM_GAP_MS = 600;
  const ORDER_SEARCH_LIMIT = 100;
  const PRODUCT_HEADERS = ['SKU', '毛重', '包装长', '包装宽', '包装高'];
  const pageWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  const pageDocument = pageWindow.document || document;
  let orderPanelRoot = null;
  let orderPanelState = { x: 18, y: 96 };
  let orderPanelDragMoved = false;
  let orderSearchRunning = false;
  let orderPanelMessage = null;

  const gmGet = (key, fallback) => (typeof GM_getValue === 'function' ? GM_getValue(key, fallback) : fallback);
  const gmSet = (key, value) => { if (typeof GM_setValue === 'function') GM_setValue(key, value); };
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  function normalizeErp(value) {
    const compact = String(value || '').replace(/\s+/g, '').trim();
    const match = compact.match(/(\d+号仓.*)$/);
    return match ? match[1] : compact;
  }

  function safeArray(value) {
    return Array.isArray(value) ? value : [];
  }

  function visible(element) {
    if (!element || typeof element.getBoundingClientRect !== 'function') return false;
    const rect = element.getBoundingClientRect();
    const style = pageWindow.getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
  }

  function normalizeOrderValue(value) {
    return String(value || '').trim().replace(/\s+/g, ' ');
  }

  function splitOrderValue(value) {
    return [...new Set(String(value || '').split(/[\s,，]+/).map(normalizeOrderValue).filter(Boolean))];
  }

  function sameOrderSet(left, right) {
    const leftOrders = splitOrderValue(left);
    const rightOrders = splitOrderValue(right);
    if (leftOrders.length !== rightOrders.length) return false;
    const rightSet = new Set(rightOrders);
    return leftOrders.every(order => rightSet.has(order));
  }

  function taskPoList(task) {
    const source = safeArray(task && task.poList).length
      ? task.poList
      : safeArray(task && task.rows).map(row => row && row.po);
    return [...new Set(source.map(normalizeOrderValue).filter(Boolean))];
  }

  function findOrderSearchInput() {
    const candidates = [...pageDocument.querySelectorAll('input[placeholder*="每次最多100个"]')].filter(visible);
    return candidates.find(input => {
      let element = input;
      for (let depth = 0; depth < 10 && element; depth++, element = element.parentElement) {
        if (normalizeOrderValue(element.innerText) === '订单号') return true;
      }
      return false;
    }) || null;
  }

  function findOrderSearchButton() {
    return [...pageDocument.querySelectorAll('button')].find(button => (
      visible(button) && normalizeOrderValue(button.textContent) === '查询'
    )) || null;
  }

  function setNativeInputValue(input, value) {
    const ownerWindow = input && input.ownerDocument && input.ownerDocument.defaultView;
    const InputConstructor = ownerWindow && ownerWindow.HTMLInputElement;
    let descriptor = InputConstructor
      ? Object.getOwnPropertyDescriptor(InputConstructor.prototype, 'value')
      : null;
    let prototype = input;
    while (!descriptor && prototype) {
      prototype = Object.getPrototypeOf(prototype);
      if (prototype) descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
    }
    if (!descriptor || typeof descriptor.set !== 'function') throw new Error('页面订单号输入框不支持原生写入');
    descriptor.set.call(input, value);
    const InputEventConstructor = ownerWindow && ownerWindow.InputEvent;
    const EventConstructor = ownerWindow && ownerWindow.Event;
    const inputEvent = typeof InputEventConstructor === 'function'
      ? new InputEventConstructor('input', {
      bubbles: true, composed: true, inputType: 'insertText', data: value,
      })
      : input.ownerDocument.createEvent('Event');
    if (typeof InputEventConstructor !== 'function') inputEvent.initEvent('input', true, false);
    input.dispatchEvent(inputEvent);
    const changeEvent = typeof EventConstructor === 'function'
      ? new EventConstructor('change', { bubbles: true, composed: true })
      : input.ownerDocument.createEvent('Event');
    if (typeof EventConstructor !== 'function') changeEvent.initEvent('change', true, false);
    input.dispatchEvent(changeEvent);
  }

  function clickPageElement(element) {
    const ownerWindow = element && element.ownerDocument && element.ownerDocument.defaultView;
    const MouseEventConstructor = ownerWindow && ownerWindow.MouseEvent;
    ['mousedown', 'mouseup'].forEach(type => {
      if (typeof MouseEventConstructor === 'function') {
        element.dispatchEvent(new MouseEventConstructor(type, { bubbles: true, cancelable: true }));
        return;
      }
      const event = element.ownerDocument.createEvent('MouseEvents');
      event.initMouseEvent(type, true, true, null, 0, 0, 0, 0, 0, false, false, false, false, 0, null);
      element.dispatchEvent(event);
    });
    element.click();
  }

  function waitForOrderSearchControls(timeout = 15000) {
    return new Promise((resolve, reject) => {
      const startedAt = Date.now();
      const poll = () => {
        const input = findOrderSearchInput();
        const button = findOrderSearchButton();
        if (input && button) return resolve({ input, button });
        if (Date.now() - startedAt >= timeout) return reject(new Error('订单列表搜索控件加载超时'));
        pageWindow.setTimeout(poll, 150);
      };
      poll();
    });
  }

  function escapeOrderHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, character => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[character]));
  }

  function clampOrderPanel(x, y, width, height) {
    return {
      x: Math.min(Math.max(MARGIN, x), Math.max(MARGIN, pageWindow.innerWidth - width - MARGIN)),
      y: Math.min(Math.max(MARGIN, y), Math.max(MARGIN, pageWindow.innerHeight - height - MARGIN)),
    };
  }

  function snapOrderBubble(x, y) {
    const maxX = Math.max(MARGIN, pageWindow.innerWidth - BUBBLE_SIZE - MARGIN);
    const maxY = Math.max(MARGIN, pageWindow.innerHeight - BUBBLE_SIZE - MARGIN);
    const clamped = clampOrderPanel(x, y, BUBBLE_SIZE, BUBBLE_SIZE);
    const edges = [
      { distance: clamped.x - MARGIN, x: MARGIN, y: clamped.y },
      { distance: maxX - clamped.x, x: maxX, y: clamped.y },
      { distance: clamped.y - MARGIN, x: clamped.x, y: MARGIN },
      { distance: maxY - clamped.y, x: clamped.x, y: maxY },
    ];
    edges.sort((left, right) => left.distance - right.distance);
    return { x: edges[0].x, y: edges[0].y };
  }

  function saveOrderPanelPosition(position) {
    orderPanelState = { x: Math.round(position.x), y: Math.round(position.y) };
    gmSet(GM_KEYS.orderSearchState, orderPanelState);
  }

  function placeOrderPanel(element, position) {
    element.style.left = `${position.x}px`;
    element.style.top = `${position.y}px`;
  }

  function bindOrderPanelDrag(handle, target, isBubble) {
    handle.addEventListener('pointerdown', event => {
      if (!isBubble && event.target.closest('button,select,input,textarea,a')) return;
      const startRect = target.getBoundingClientRect();
      const startX = event.clientX;
      const startY = event.clientY;
      orderPanelDragMoved = false;
      handle.setPointerCapture(event.pointerId);
      const onMove = moveEvent => {
        const deltaX = moveEvent.clientX - startX;
        const deltaY = moveEvent.clientY - startY;
        if (Math.hypot(deltaX, deltaY) >= 5) orderPanelDragMoved = true;
        const next = clampOrderPanel(startRect.left + deltaX, startRect.top + deltaY, target.offsetWidth, target.offsetHeight);
        placeOrderPanel(target, next);
      };
      const onUp = upEvent => {
        if (handle.hasPointerCapture(upEvent.pointerId)) handle.releasePointerCapture(upEvent.pointerId);
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onUp);
        handle.removeEventListener('pointercancel', onUp);
        const rect = target.getBoundingClientRect();
        const position = isBubble
          ? snapOrderBubble(rect.left, rect.top)
          : clampOrderPanel(rect.left, rect.top, target.offsetWidth, target.offsetHeight);
        placeOrderPanel(target, position);
        saveOrderPanelPosition(position);
      };
      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onUp);
      handle.addEventListener('pointercancel', onUp);
    });
  }

  function orderPanelDefaultMessage(task, orders) {
    if (!task) return { type: 'warning', text: '尚未收到 OMS 本批任务，请先在 OMS 设置本批任务。' };
    if (!orders.length) return { type: 'warning', text: '当前批次没有可查询的订单号。' };
    if (orders.length > ORDER_SEARCH_LIMIT) {
      return { type: 'warning', text: `本批有 ${orders.length} 个唯一订单，平台单次最多查询 ${ORDER_SEARCH_LIMIT} 个，请先缩小 OMS 批次。` };
    }
    return { type: 'info', text: `准备查询 ${orders.length} 个唯一订单。刷新页面不会自动执行。` };
  }

  function ensureOrderPanelStyle() {
    if (pageDocument.querySelector('#__tfpOrderPanelStyle')) return;
    const style = pageDocument.createElement('style');
    style.id = '__tfpOrderPanelStyle';
    style.textContent = `
      #__tfpOrderPanel,#__tfpOrderBubble{font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;box-sizing:border-box;color:#2F3540}
      #__tfpOrderPanel *{box-sizing:border-box}
      #__tfpOrderBubble{position:fixed;z-index:2147483580;width:44px;height:44px;border:1px solid #242A33;border-radius:999px;padding:0;background:#1770E6;color:#FFFFFF;box-shadow:0 0 6px rgba(0,0,0,.12);font-size:12px;line-height:18px;font-weight:600;cursor:grab;user-select:none}
      #__tfpOrderBubble:hover{background:#1876F2}#__tfpOrderBubble:active{background:#156AD9}
      #__tfpOrderPanel{position:fixed;z-index:2147483580;width:min(320px,calc(100vw - 16px));background:#FFFFFF;border:1px solid #E1E5EB;border-radius:4px;box-shadow:0 0 6px rgba(0,0,0,.12);overflow:hidden;font-size:14px;line-height:22px}
      #__tfpOrderPanel .tfp-order-hd{height:48px;padding:0 8px 0 16px;display:flex;align-items:center;gap:8px;background:#F7F8FA;border-bottom:1px solid #E1E5EB;cursor:move;user-select:none}
      #__tfpOrderPanel .tfp-order-title{font-weight:500;color:#242A33;flex:1}
      #__tfpOrderPanel .tfp-order-min{width:32px;height:32px;padding:0;border:1px solid transparent;border-radius:2px;background:transparent;color:#6C6F73;cursor:pointer;font-size:16px}
      #__tfpOrderPanel .tfp-order-min:hover{background:#F5F7FA;border-color:#CCD1D9}
      #__tfpOrderPanel .tfp-order-body{padding:16px;display:grid;gap:12px}
      #__tfpOrderPanel label{display:block;margin-bottom:4px;font-size:12px;line-height:18px;color:#6C6F73}
      #__tfpOrderPanel select{width:100%;height:32px;padding:0 8px;border:1px solid #CCD1D9;border-radius:2px;background:#FFFFFF;color:#2F3540;font-family:inherit;font-size:14px;line-height:22px}
      #__tfpOrderPanel select:hover{border-color:#B4B9BF}#__tfpOrderPanel select:disabled{background:#EEEEEE;color:#9CA0A6}
      #__tfpOrderPanel .tfp-order-summary{padding:8px 12px;border:1px solid #E1E5EB;border-radius:2px;background:#F7F8FA;color:#2F3540;white-space:pre-wrap}
      #__tfpOrderPanel .tfp-order-status{padding:8px 12px;border-radius:2px;white-space:pre-wrap}
      #__tfpOrderPanel .tfp-order-status.info{background:#F5F8FD;color:#596A80}#__tfpOrderPanel .tfp-order-status.success{background:#EDFCF2;color:#2D8048}#__tfpOrderPanel .tfp-order-status.warning{background:#FCF8F2;color:#F28D00}#__tfpOrderPanel .tfp-order-status.error{background:#FFF2F2;color:#E64545}
      #__tfpOrderPanel .tfp-order-run{width:100%;height:36px;padding:0 16px;border:0;border-radius:2px;background:#1770E6;color:#FFFFFF;font-family:inherit;font-size:14px;line-height:22px;font-weight:500;cursor:pointer}
      #__tfpOrderPanel .tfp-order-run:hover{background:#1876F2}#__tfpOrderPanel .tfp-order-run:active{background:#156AD9}#__tfpOrderPanel .tfp-order-run:disabled{background:#EEEEEE;color:#9CA0A6;cursor:not-allowed}
      #__tfpOrderPanel button:focus-visible,#__tfpOrderPanel select:focus-visible,#__tfpOrderBubble:focus-visible{outline:2px solid #1C6EFF;outline-offset:2px}
      @media(max-width:767px){#__tfpOrderPanel{width:min(320px,calc(100vw - 32px))}#__tfpOrderPanel .tfp-order-min,#__tfpOrderPanel .tfp-order-run{min-height:36px}}
      @media(prefers-reduced-motion:reduce){#__tfpOrderPanel,#__tfpOrderBubble{transition:none!important}}
    `;
    pageDocument.head.appendChild(style);
  }

  function renderOrderSearchBubble() {
    orderPanelRoot.innerHTML = '<button id="__tfpOrderBubble" type="button" title="展开本批订单查询" aria-label="展开本批订单查询">查单</button>';
    const bubble = orderPanelRoot.querySelector('#__tfpOrderBubble');
    const position = snapOrderBubble(orderPanelState.x, orderPanelState.y);
    placeOrderPanel(bubble, position);
    saveOrderPanelPosition(position);
    bindOrderPanelDrag(bubble, bubble, true);
    bubble.addEventListener('click', () => {
      if (!orderPanelDragMoved) renderOrderSearchPanel();
      orderPanelDragMoved = false;
    });
  }

  function renderOrderSearchPanel() {
    const task = activeTask();
    const orders = taskPoList(task);
    const tasks = taskList();
    const message = orderPanelMessage || orderPanelDefaultMessage(task, orders);
    const disabled = orderSearchRunning || !task || !orders.length || orders.length > ORDER_SEARCH_LIMIT;
    orderPanelRoot.innerHTML = `
      <section id="__tfpOrderPanel" aria-label="本批订单查询">
        <header class="tfp-order-hd"><span class="tfp-order-title">本批订单查询</span><button class="tfp-order-min" type="button" title="收起" aria-label="收起">—</button></header>
        <main class="tfp-order-body">
          <div><label for="tfpOrderTask">当前 OMS 批次</label><select id="tfpOrderTask" ${tasks.length && !orderSearchRunning ? '' : 'disabled'}>${tasks.length ? tasks.map(item => `<option value="${escapeOrderHtml(item.id)}" ${task && item.id === task.id ? 'selected' : ''}>${escapeOrderHtml(item.label || item.id)}</option>`).join('') : '<option>尚未收到任务</option>'}</select></div>
          <div class="tfp-order-summary">${task ? `任务行：${Number(task.orderCount) || safeArray(task.rows).length}\n唯一订单：${orders.length}\n创建：${task.createdAt ? new Date(task.createdAt).toLocaleString() : '未知'}` : '请先在 OMS 订单采集器中点击“设为本批 TEMU 任务”。'}</div>
          <div class="tfp-order-status ${escapeOrderHtml(message.type)}" role="status">${escapeOrderHtml(message.text)}</div>
          <button class="tfp-order-run" type="button" ${disabled ? 'disabled' : ''}>${orderSearchRunning ? '正在填入并查询…' : '填入并查询'}</button>
        </main>
      </section>`;
    const panel = orderPanelRoot.querySelector('#__tfpOrderPanel');
    const position = clampOrderPanel(orderPanelState.x, orderPanelState.y, Math.min(320, pageWindow.innerWidth - 16), panel.offsetHeight || 260);
    placeOrderPanel(panel, position);
    bindOrderPanelDrag(panel.querySelector('.tfp-order-hd'), panel, false);
    panel.querySelector('.tfp-order-min').addEventListener('click', renderOrderSearchBubble);
    const taskSelect = panel.querySelector('#tfpOrderTask');
    if (taskSelect) taskSelect.addEventListener('change', event => {
      gmSet(GM_KEYS.activeTask, event.target.value);
      orderPanelMessage = null;
      renderOrderSearchPanel();
    });
    panel.querySelector('.tfp-order-run').addEventListener('click', manualSearchCurrentTask);
  }

  async function manualSearchCurrentTask() {
    if (orderSearchRunning) return;
    const task = activeTask();
    const orders = taskPoList(task);
    if (!task || !orders.length || orders.length > ORDER_SEARCH_LIMIT) {
      orderPanelMessage = orderPanelDefaultMessage(task, orders);
      renderOrderSearchPanel();
      return;
    }
    orderSearchRunning = true;
    orderPanelMessage = { type: 'info', text: `正在填入并查询 ${orders.length} 个唯一订单……` };
    renderOrderSearchPanel();
    try {
      const { input, button } = await waitForOrderSearchControls();
      const query = orders.join(' ');
      const urlOrders = new URL(pageWindow.location.href).searchParams.get('parentOrderSnList') || '';
      if (sameOrderSet(input.value, query) || sameOrderSet(urlOrders, query)) {
        orderPanelMessage = { type: 'success', text: `当前页面已经是本批 ${orders.length} 个订单，无需重复查询。` };
        return;
      }
      setNativeInputValue(input, query);
      await sleep(80);
      if (!sameOrderSet(input.value, query)) throw new Error('订单号写入后未保留');
      clickPageElement(button);
      orderPanelMessage = { type: 'success', text: `已填入并发起查询，共 ${orders.length} 个唯一订单。` };
    } catch (error) {
      orderPanelMessage = { type: 'error', text: `填入或查询失败：${error.message}` };
    } finally {
      orderSearchRunning = false;
      if (orderPanelRoot.querySelector('#__tfpOrderPanel')) renderOrderSearchPanel();
    }
  }

  function startOrderListPanel() {
    pageDocument.querySelectorAll('#__tfpOrderPanel,#__tfpOrderBubble,#__tfpOrderSearchStatus').forEach(element => element.remove());
    ensureOrderPanelStyle();
    orderPanelState = { x: 18, y: 96, ...gmGet(GM_KEYS.orderSearchState, {}) };
    orderPanelRoot = pageDocument.createElement('div');
    (pageDocument.body || pageDocument.documentElement).appendChild(orderPanelRoot);
    renderOrderSearchBubble();
    if (typeof GM_addValueChangeListener === 'function') {
      GM_addValueChangeListener(GM_KEYS.tasks, () => {
        orderPanelMessage = null;
        if (!orderSearchRunning && orderPanelRoot.querySelector('#__tfpOrderPanel')) renderOrderSearchPanel();
      });
      GM_addValueChangeListener(GM_KEYS.activeTask, () => {
        orderPanelMessage = null;
        if (!orderSearchRunning && orderPanelRoot.querySelector('#__tfpOrderPanel')) renderOrderSearchPanel();
      });
    }
    pageWindow.addEventListener('resize', () => {
      const bubble = orderPanelRoot.querySelector('#__tfpOrderBubble');
      const panel = orderPanelRoot.querySelector('#__tfpOrderPanel');
      const target = bubble || panel;
      if (!target) return;
      const rect = target.getBoundingClientRect();
      const position = bubble
        ? snapOrderBubble(rect.left, rect.top)
        : clampOrderPanel(rect.left, rect.top, target.offsetWidth, target.offsetHeight);
      placeOrderPanel(target, position);
      saveOrderPanelPosition(position);
    });
  }

  function saveTask(task) {
    if (!task || !task.id || !Array.isArray(task.rows)) return false;
    const tasks = safeArray(gmGet(GM_KEYS.tasks, [])).filter(item => item && item.id !== task.id);
    tasks.unshift(task);
    gmSet(GM_KEYS.activeTask, task.id);
    gmSet(GM_KEYS.tasks, tasks.slice(0, MAX_TASKS));
    return true;
  }

  function acceptTaskEnvelope(envelope) {
    if (!envelope || envelope.type !== 'upsert-task' || !envelope.task) return;
    saveTask(envelope.task);
  }

  function startOmsBridge() {
    try { acceptTaskEnvelope(JSON.parse(localStorage.getItem(OMS_TASK_EVENT_KEY) || 'null')); } catch (_) { /* 没有待同步任务。 */ }
    window.addEventListener('lucas:oms:temu-task', event => acceptTaskEnvelope(event.detail));
    window.addEventListener('storage', event => {
      if (event.key !== OMS_TASK_EVENT_KEY || !event.newValue) return;
      try { acceptTaskEnvelope(JSON.parse(event.newValue)); } catch (_) { /* 忽略非任务内容。 */ }
    });
    try {
      const channel = new BroadcastChannel(OMS_TASK_CHANNEL);
      channel.addEventListener('message', event => acceptTaskEnvelope(event.data));
    } catch (_) { /* 不支持 BroadcastChannel 时仍使用同页事件和 localStorage。 */ }
  }

  if (IS_OMS) {
    startOmsBridge();
    return;
  }

  if (IS_ORDER_LIST) {
    startOrderListPanel();
    return;
  }

  document.querySelectorAll('#__tfp,#__tfpBubble').forEach(element => element.remove());

  function migrateLegacyMapping() {
    const current = safeArray(gmGet(GM_KEYS.mapping, []));
    if (current.length) return;
    try {
      const legacy = JSON.parse(localStorage.getItem(LEGACY_MAP_KEY) || '[]');
      if (Array.isArray(legacy) && legacy.length) gmSet(GM_KEYS.mapping, legacy);
    } catch (_) { /* 没有旧对照表。 */ }
  }
  migrateLegacyMapping();

  let root = document.createElement('div');
  document.body.appendChild(root);
  let state = { x: 18, y: 96, ...gmGet(GM_KEYS.state, {}) };
  let dragMoved = false;
  let running = false;
  let stopRequested = false;

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, char => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[char]));
  }

  function decodeCsv(buffer) {
    const bytes = new Uint8Array(buffer);
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder('utf-8').decode(bytes.subarray(3));
    if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
    if (bytes[0] === 0xfe && bytes[1] === 0xff) {
      const swapped = new Uint8Array(bytes.length - 2);
      for (let index = 2; index + 1 < bytes.length; index += 2) { swapped[index - 2] = bytes[index + 1]; swapped[index - 1] = bytes[index]; }
      return new TextDecoder('utf-16le').decode(swapped);
    }
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch (_) { return new TextDecoder('gb18030').decode(bytes); }
  }

  function parseCsv(text) {
    const rows = [];
    let row = [];
    let field = '';
    let quoted = false;
    let atFieldStart = true;
    const source = String(text || '').replace(/^\ufeff/, '');
    for (let index = 0; index < source.length; index++) {
      const char = source[index];
      if (quoted) {
        if (char === '"' && source[index + 1] === '"') { field += '"'; index++; }
        else if (char === '"') quoted = false;
        else field += char;
        continue;
      }
      if (char === '"' && atFieldStart) { quoted = true; atFieldStart = false; continue; }
      if (char === ',') { row.push(field); field = ''; atFieldStart = true; continue; }
      if (char === '\r' || char === '\n') {
        if (char === '\r' && source[index + 1] === '\n') index++;
        row.push(field); rows.push(row); row = []; field = ''; atFieldStart = true; continue;
      }
      field += char;
      atFieldStart = false;
    }
    if (quoted) throw new Error('CSV 存在未闭合的双引号');
    if (field || row.length) { row.push(field); rows.push(row); }
    return rows.filter(items => items.some(value => String(value).trim()));
  }

  function finitePositive(value) {
    const number = typeof value === 'number' ? value : Number(String(value == null ? '' : value).trim());
    return Number.isFinite(number) && number > 0 ? number : null;
  }

  function productDataFromRows(rows, sourceName) {
    if (!Array.isArray(rows) || rows.length < 2) throw new Error('商品表没有数据行');
    const headers = rows[0].map(value => String(value == null ? '' : value).trim());
    const positions = Object.fromEntries(PRODUCT_HEADERS.map(header => [header, headers.indexOf(header)]));
    const missingHeaders = PRODUCT_HEADERS.filter(header => positions[header] < 0);
    if (missingHeaders.length) throw new Error(`商品表缺少字段：${missingHeaders.join('、')}`);

    const validRows = [];
    const invalidRows = [];
    for (let index = 1; index < rows.length; index++) {
      const columns = rows[index];
      if (!columns || !columns.some(value => value !== '' && value != null)) continue;
      const rowNumber = index + 1;
      const sku = String(columns[positions.SKU] == null ? '' : columns[positions.SKU]).trim();
      const values = {
        weightKg: finitePositive(columns[positions['毛重']]),
        lengthCm: finitePositive(columns[positions['包装长']]),
        widthCm: finitePositive(columns[positions['包装宽']]),
        heightCm: finitePositive(columns[positions['包装高']]),
      };
      const invalidFields = [];
      if (!sku) invalidFields.push('SKU');
      if (values.weightKg == null) invalidFields.push('毛重');
      if (values.lengthCm == null) invalidFields.push('包装长');
      if (values.widthCm == null) invalidFields.push('包装宽');
      if (values.heightCm == null) invalidFields.push('包装高');
      if (invalidFields.length) {
        invalidRows.push({ rowNumber, sku, invalidFields });
        continue;
      }
      validRows.push({ rowNumber, sku, ...values });
    }
    if (!validRows.length) throw new Error('商品表没有有效尺寸数据');

    const buckets = new Map();
    validRows.forEach(row => {
      if (!buckets.has(row.sku)) buckets.set(row.sku, []);
      buckets.get(row.sku).push(row);
    });
    let conflictSkus = 0;
    let identicalDuplicateSkus = 0;
    let duplicateRows = 0;
    buckets.forEach(rowsForSku => {
      const variants = new Set(rowsForSku.map(row => JSON.stringify([row.weightKg, row.lengthCm, row.widthCm, row.heightCm])));
      if (variants.size > 1) conflictSkus++;
      else if (rowsForSku.length > 1) identicalDuplicateSkus++;
      duplicateRows += Math.max(0, rowsForSku.length - 1);
    });

    return {
      version: 1,
      sourceName: String(sourceName || ''),
      importedAt: Date.now(),
      rows: validRows,
      invalidRows,
      stats: {
        sourceRows: rows.length - 1,
        validRows: validRows.length,
        invalidRows: invalidRows.length,
        uniqueSkus: buckets.size,
        conflictSkus,
        identicalDuplicateSkus,
        duplicateRows,
      },
    };
  }

  function rowsToMapping(rows) {
    return rows.map(columns => ({
      channel: String(columns[0] || '').trim(),
      erpRaw: String(columns[1] || '').trim(),
      erp: normalizeErp(columns[1]),
      temuName: String(columns[2] || '').trim(),
      whId: String(columns[3] || '').trim(),
    })).filter(row => row.channel && row.erp && row.erp !== '未知' && row.temuName);
  }

  function mappingFromCsv(text) {
    const rows = parseCsv(text);
    if (rows.length < 2) throw new Error('CSV 没有数据行');
    return rowsToMapping(rows.slice(1));
  }

  function xlsxText(value) {
    return value == null ? '' : String(value);
  }

  function decodeXmlEntities(value) {
    return xlsxText(value).replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (match, entity) => {
      const lower = entity.toLowerCase();
      if (lower === 'amp') return '&';
      if (lower === 'lt') return '<';
      if (lower === 'gt') return '>';
      if (lower === 'quot') return '"';
      if (lower === 'apos') return "'";
      const codePoint = lower.startsWith('#x')
        ? Number.parseInt(lower.slice(2), 16)
        : Number.parseInt(lower.slice(1), 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    });
  }

  function xmlAttribute(tag, name) {
    const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = new RegExp(`(?:^|\\s)${escapedName}\\s*=\\s*(["'])([\\s\\S]*?)\\1`).exec(tag);
    return match ? decodeXmlEntities(match[2]) : '';
  }

  function xmlTextRuns(fragment) {
    const values = [];
    const pattern = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
    let match;
    while ((match = pattern.exec(fragment))) values.push(decodeXmlEntities(match[1]));
    return values.join('');
  }

  function normalizeZipPath(baseDirectory, target) {
    const normalizedTarget = xlsxText(target).replace(/\\/g, '/');
    const parts = normalizedTarget.startsWith('/')
      ? normalizedTarget.slice(1).split('/')
      : `${baseDirectory}/${normalizedTarget}`.split('/');
    const output = [];
    for (const part of parts) {
      if (!part || part === '.') continue;
      if (part === '..') output.pop();
      else output.push(part);
    }
    return output.join('/');
  }

  function openXlsxArchive(arrayBuffer) {
    const view = new DataView(arrayBuffer);
    const bytes = new Uint8Array(arrayBuffer);
    const minimumOffset = Math.max(0, bytes.length - 65557);
    let endOffset = -1;
    for (let offset = bytes.length - 22; offset >= minimumOffset; offset--) {
      if (view.getUint32(offset, true) === 0x06054b50) {
        endOffset = offset;
        break;
      }
    }
    if (endOffset < 0) throw new Error('XLSX 文件结构无法识别，请确认文件未损坏');

    const entryCount = view.getUint16(endOffset + 10, true);
    let centralOffset = view.getUint32(endOffset + 16, true);
    const entries = new Map();
    for (let index = 0; index < entryCount; index++) {
      if (view.getUint32(centralOffset, true) !== 0x02014b50) throw new Error('XLSX 文件目录已损坏');
      const method = view.getUint16(centralOffset + 10, true);
      const compressedSize = view.getUint32(centralOffset + 20, true);
      const fileNameLength = view.getUint16(centralOffset + 28, true);
      const extraLength = view.getUint16(centralOffset + 30, true);
      const commentLength = view.getUint16(centralOffset + 32, true);
      const localOffset = view.getUint32(centralOffset + 42, true);
      const nameBytes = bytes.subarray(centralOffset + 46, centralOffset + 46 + fileNameLength);
      const name = new TextDecoder('utf-8').decode(nameBytes).replace(/^\/+/, '');
      entries.set(name, { method, compressedSize, localOffset });
      centralOffset += 46 + fileNameLength + extraLength + commentLength;
    }

    async function readEntry(name) {
      const entry = entries.get(name);
      if (!entry) return null;
      if (view.getUint32(entry.localOffset, true) !== 0x04034b50) throw new Error(`XLSX 条目无法读取：${name}`);
      const fileNameLength = view.getUint16(entry.localOffset + 26, true);
      const extraLength = view.getUint16(entry.localOffset + 28, true);
      const dataOffset = entry.localOffset + 30 + fileNameLength + extraLength;
      const compressed = bytes.subarray(dataOffset, dataOffset + entry.compressedSize);
      if (entry.method === 0) return compressed.slice();
      if (entry.method !== 8) throw new Error(`XLSX 使用了不支持的压缩方式：${entry.method}`);
      if (typeof DecompressionStream !== 'function') throw new Error('当前 Chrome/Edge 版本不支持读取 XLSX，请升级浏览器后重试');
      try {
        const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
        return new Uint8Array(await new Response(stream).arrayBuffer());
      } catch (error) {
        throw new Error(`XLSX 解压失败：${name}`, { cause: error });
      }
    }

    return { readEntry };
  }

  async function readXlsxText(archive, name, required = true) {
    const bytes = await archive.readEntry(name);
    if (!bytes) {
      if (required) throw new Error(`XLSX 缺少必要文件：${name}`);
      return '';
    }
    return new TextDecoder('utf-8').decode(bytes);
  }

  function parseXlsxSharedStrings(xml) {
    if (!xml) return [];
    const output = [];
    const pattern = /<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g;
    let match;
    while ((match = pattern.exec(xml))) output.push(xmlTextRuns(match[1]));
    return output;
  }

  function xlsxColumnIndex(reference) {
    const match = /^([A-Z]+)/i.exec(xlsxText(reference));
    if (!match) return -1;
    let index = 0;
    for (const char of match[1].toUpperCase()) index = index * 26 + char.charCodeAt(0) - 64;
    return index - 1;
  }

  function parseXlsxRow(rowXml, sharedStrings) {
    const values = [];
    const pattern = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let sequentialIndex = 0;
    let match;
    while ((match = pattern.exec(rowXml))) {
      const attributes = match[1] || '';
      const body = match[2] || '';
      const referenceIndex = xlsxColumnIndex(xmlAttribute(attributes, 'r'));
      const columnIndex = referenceIndex >= 0 ? referenceIndex : sequentialIndex;
      sequentialIndex = columnIndex + 1;
      const type = xmlAttribute(attributes, 't');
      const valueMatch = /<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/.exec(body);
      const rawValue = valueMatch ? decodeXmlEntities(valueMatch[1]) : '';
      if (type === 's') values[columnIndex] = sharedStrings[Number(rawValue)] ?? '';
      else if (type === 'inlineStr') values[columnIndex] = xmlTextRuns(body);
      else if (type === 'b') values[columnIndex] = rawValue === '1';
      else if (type === 'str' || type === 'e' || type === 'd') values[columnIndex] = rawValue;
      else if (rawValue !== '') {
        const numeric = Number(rawValue);
        values[columnIndex] = Number.isFinite(numeric) ? numeric : rawValue;
      } else values[columnIndex] = '';
    }
    return values;
  }

  async function rowsFromExcel(file) {
    if (!/\.xlsx$/i.test(file.name)) throw new Error('请将旧版 .xls 另存为 .xlsx 或 UTF-8 CSV 后再导入');
    const archive = openXlsxArchive(await file.arrayBuffer());
    const workbookXml = await readXlsxText(archive, 'xl/workbook.xml');
    const relationshipsXml = await readXlsxText(archive, 'xl/_rels/workbook.xml.rels');
    const sharedStrings = parseXlsxSharedStrings(await readXlsxText(archive, 'xl/sharedStrings.xml', false));
    const relationshipTargets = new Map();
    for (const tag of relationshipsXml.match(/<Relationship\b[^>]*\/?\s*>/g) || []) {
      const id = xmlAttribute(tag, 'Id');
      const target = xmlAttribute(tag, 'Target');
      if (id && target) relationshipTargets.set(id, normalizeZipPath('xl', target));
    }
    const firstSheetTag = (workbookXml.match(/<sheet\b[^>]*\/?\s*>/g) || [])[0];
    const sheetPath = firstSheetTag && relationshipTargets.get(xmlAttribute(firstSheetTag, 'r:id'));
    if (!sheetPath) throw new Error('XLSX 没有可读取的工作表');
    const sheetXml = await readXlsxText(archive, sheetPath);
    const rows = [];
    const rowPattern = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
    let match;
    while ((match = rowPattern.exec(sheetXml))) rows.push(parseXlsxRow(match[1], sharedStrings));
    while (rows.length && rows[rows.length - 1].every(value => !xlsxText(value).trim())) rows.pop();
    if (!rows.length) throw new Error('Excel 没有数据行');
    return rows;
  }

  async function mappingFromExcel(file) {
    const rows = await rowsFromExcel(file);
    if (rows.length < 2) throw new Error('Excel 没有数据行');
    return rowsToMapping(rows.slice(1));
  }

  async function productDataFromFile(file) {
    const rows = /\.xlsx?$/i.test(file.name)
      ? await rowsFromExcel(file)
      : parseCsv(decodeCsv(await file.arrayBuffer()));
    return productDataFromRows(rows, file.name);
  }

  function loadMapping() {
    return safeArray(gmGet(GM_KEYS.mapping, []));
  }

  function mappingIndex(mapping) {
    const index = new Map();
    mapping.forEach(row => {
      const key = `${row.channel}||${normalizeErp(row.erp)}`;
      if (!index.has(key)) index.set(key, row);
    });
    return index;
  }

  function loadProductData() {
    const value = gmGet(GM_KEYS.productData, null);
    return value && value.version === 1 && Array.isArray(value.rows) ? value : null;
  }

  function productDataIndex(data) {
    const buckets = new Map();
    safeArray(data && data.rows).forEach(row => {
      const sku = String(row && row.sku || '').trim();
      if (!sku) return;
      if (!buckets.has(sku)) buckets.set(sku, []);
      buckets.get(sku).push(row);
    });
    const unique = new Map();
    const conflicts = new Map();
    buckets.forEach((rows, sku) => {
      const variants = new Map();
      rows.forEach(row => {
        const key = JSON.stringify([row.weightKg, row.lengthCm, row.widthCm, row.heightCm]);
        if (!variants.has(key)) variants.set(key, row);
      });
      if (variants.size === 1) unique.set(sku, [...variants.values()][0]);
      else conflicts.set(sku, rows);
    });
    const invalidSkus = new Set(safeArray(data && data.invalidRows).map(row => String(row && row.sku || '').trim()).filter(Boolean));
    return { unique, conflicts, invalidSkus };
  }

  function detectPageUnits() {
    const text = pageDocument.body ? pageDocument.body.innerText : '';
    const imperial = text.includes('重量（磅：lb）') && text.includes('体积（英寸：in）');
    const metric = text.includes('重量（千克：kg）') && text.includes('体积（厘米：cm）');
    if (imperial === metric) throw new Error('无法确认当前页面的重量和尺寸单位');
    return imperial ? { system: 'imperial', weight: 'lb', length: 'in' } : { system: 'metric', weight: 'kg', length: 'cm' };
  }

  function ceilTwo(value) {
    return Math.ceil((Number(value) * 100) - 1e-9) / 100;
  }

  function prepareMeasurements(product, units) {
    if (units.system === 'imperial') {
      return {
        weight: ceilTwo(product.weightKg * KG_TO_LB).toFixed(2),
        length: ceilTwo(product.lengthCm / CM_PER_INCH).toFixed(2),
        width: ceilTwo(product.widthCm / CM_PER_INCH).toFixed(2),
        height: ceilTwo(product.heightCm / CM_PER_INCH).toFixed(2),
      };
    }
    return {
      weight: String(product.weightKg),
      length: String(product.lengthCm),
      width: String(product.widthCm),
      height: String(product.heightCm),
    };
  }

  function taskList() {
    return safeArray(gmGet(GM_KEYS.tasks, [])).filter(task => task && task.id && Array.isArray(task.rows));
  }

  function activeTask() {
    const tasks = taskList();
    const activeId = gmGet(GM_KEYS.activeTask, '');
    return tasks.find(task => task.id === activeId) || tasks[0] || null;
  }

  function taskIndex(task) {
    const buckets = new Map();
    const platformBuckets = new Map();
    safeArray(task && task.rows).forEach(row => {
      const po = String(row.po || '').trim();
      const channelSku = String(row.channelSku || '').trim();
      const platformSkuId = String(row.platformSkuId || '').trim();
      if (po && channelSku) {
        const key = `${po}||${channelSku}`;
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(row);
      }
      if (po && platformSkuId) {
        const platformKey = `${po}||${platformSkuId}`;
        if (!platformBuckets.has(platformKey)) platformBuckets.set(platformKey, []);
        platformBuckets.get(platformKey).push(row);
      }
    });
    const groups = new Map();
    const conflicts = new Map();
    const platformGroups = new Map();
    const platformConflicts = new Map();
    const indexBuckets = (source, groupTarget, conflictTarget) => source.forEach((rows, key) => {
      const exactRows = new Map();
      rows.forEach(row => exactRows.set(JSON.stringify(row), row));
      const deduped = [...exactRows.values()];
      const identities = new Map();
      let invalidIdentity = false;
      deduped.forEach(row => {
        const identity = String(row.so || row.innerId || '').trim();
        if (!identity) {
          invalidIdentity = true;
          return;
        }
        if (!identities.has(identity)) identities.set(identity, []);
        identities.get(identity).push(row);
      });
      const repeatedIdentity = [...identities.values()].some(identityRows => identityRows.length > 1);
      if (invalidIdentity || repeatedIdentity) {
        conflictTarget.set(key, rows);
        return;
      }
      deduped.sort((left, right) => {
        const leftSo = String(left.so || left.innerId || '');
        const rightSo = String(right.so || right.innerId || '');
        return leftSo.localeCompare(rightSo, 'zh-CN', { numeric: true, sensitivity: 'base' });
      });
      groupTarget.set(key, deduped);
    });
    indexBuckets(buckets, groups, conflicts);
    indexBuckets(platformBuckets, platformGroups, platformConflicts);
    return { groups, conflicts, platformGroups, platformConflicts };
  }

  function reactPrivateKeys(element) {
    if (!element) return [];
    const keys = new Set();
    const readers = [Object.keys, Object.getOwnPropertyNames];
    if (pageWindow.Object) readers.push(pageWindow.Object.keys, pageWindow.Object.getOwnPropertyNames);
    readers.forEach(reader => {
      try { reader.call(pageWindow.Object || Object, element).forEach(key => keys.add(key)); }
      catch (_) { /* 某些浏览器隔离包装不暴露页面私有属性，继续使用其他读取方式。 */ }
    });
    return [...keys].filter(key => key.startsWith('__react'));
  }

  function getOrderItem(tr) {
    const image = tr.querySelector('img.lazy-image');
    if (!image) return null;
    const privateKeys = reactPrivateKeys(image);
    const propsKey = privateKeys.find(key => key.startsWith('__reactProps'));
    if (propsKey && image[propsKey] && image[propsKey].orderItem) return image[propsKey].orderItem;
    const fiberKey = privateKeys.find(key => key.startsWith('__reactFiber'));
    if (!fiberKey) return null;
    let fiber = image[fiberKey];
    for (let depth = 0; depth < 20 && fiber; depth++) {
      if (fiber.memoizedProps && fiber.memoizedProps.orderItem) return fiber.memoizedProps.orderItem;
      fiber = fiber.return;
    }
    return null;
  }

  function reshipRowForInput(input) {
    let element = input;
    for (let depth = 0; element && depth < 18; depth++, element = element.parentElement) {
      const placeholders = new Set([...element.querySelectorAll('input[data-testid="beast-core-inputNumber-htmlInput"]')]
        .map(candidate => candidate.placeholder));
      const hasDimensions = ['重量', '长', '宽', '高'].every(placeholder => placeholders.has(placeholder));
      if (hasDimensions
        && element.querySelector('img.lazy-image')
        && element.querySelector('[data-testid="beast-core-select-header"]')) {
        return element;
      }
    }
    return null;
  }

  function pageRows() {
    const tableRows = [...pageDocument.querySelectorAll('tr[data-testid="beast-core-table-body-tr"]')];
    if (tableRows.length) return tableRows;
    const rows = [...pageDocument.querySelectorAll('input[data-testid="beast-core-inputNumber-htmlInput"][placeholder="重量"]')]
      .map(reshipRowForInput)
      .filter(Boolean);
    return [...new Set(rows)].filter(row => getOrderItem(row));
  }

  function getReactProps(element, predicate, maxDepth = 22) {
    const privateKeys = reactPrivateKeys(element);
    const propsKey = privateKeys.find(key => key.startsWith('__reactProps'));
    const directProps = propsKey ? element[propsKey] : null;
    if (directProps && predicate(directProps)) return directProps;
    const fiberKey = privateKeys.find(key => key.startsWith('__reactFiber'));
    let fiber = fiberKey ? element[fiberKey] : null;
    for (let depth = 0; depth < maxDepth && fiber; depth++, fiber = fiber.return) {
      const props = fiber.memoizedProps;
      if (props && predicate(props)) return props;
    }
    return null;
  }

  function getSelectModels(tr) {
    return [...tr.querySelectorAll('[data-testid="beast-core-select-header"]')].map(header => {
      const props = getReactProps(header, candidate => (
        Array.isArray(candidate.options)
        && typeof candidate.onChange === 'function'
        && Object.prototype.hasOwnProperty.call(candidate, 'value')
      ));
      return props ? { header, props } : null;
    }).filter(Boolean);
  }

  function getWarehouseModel(tr) {
    const models = getSelectModels(tr).map(candidate => {
      const packageProps = getReactProps(candidate.header, props => (
        props.packageItem
        && typeof props.packageItem === 'object'
        && Array.isArray(props.packageItem.warehouseOptions)
      ), 50);
      return packageProps ? { ...candidate, packageProps } : candidate;
    });
    const model = models.find(candidate => safeArray(candidate.props && candidate.props.options).some(option => (
      option && (option.warehouseId != null || option.whId != null)
    ))) || models.find(candidate => {
      const input = candidate.header.querySelector('input');
      return input && !input.disabled && input.placeholder === '请选择';
    }) || models.find(candidate => candidate.packageProps) || null;
    if (!model) return null;
    const formItemProps = getReactProps(model.header, candidate => (
      typeof candidate.field === 'string'
      && /(?:^|\.)warehouseId$/.test(candidate.field)
      && typeof candidate.onChange === 'function'
    ), 40);
    return formItemProps ? { ...model, formItemProps } : model;
  }

  function warehouseOptions(model) {
    const direct = safeArray(model && model.props && model.props.options);
    if (direct.some(option => option && (option.warehouseId != null || option.whId != null))) return direct;
    return safeArray(model && model.packageProps && model.packageProps.packageItem
      && model.packageProps.packageItem.warehouseOptions);
  }

  function closeWarehouseDropdown(model) {
    const target = model && (model.header.querySelector('input') || model.header);
    if (!target) return;
    const KeyboardEventConstructor = pageWindow.KeyboardEvent || KeyboardEvent;
    ['keydown', 'keyup'].forEach(type => {
      target.dispatchEvent(new KeyboardEventConstructor(type, { key: 'Escape', code: 'Escape', bubbles: true }));
    });
  }

  async function ensureWarehouseOptions(tr) {
    let model = getWarehouseModel(tr);
    if (!model) throw new Error('找不到仓库表单更新入口');
    if (warehouseOptions(model).length) return model;
    closeWarehouseDropdown(model);
    await sleep(40);
    fireMouse(model.header.querySelector('input') || model.header);
    model = await waitForResult(() => {
      const current = getWarehouseModel(tr);
      return current && warehouseOptions(current).length ? current : null;
    }, 5000);
    return model;
  }

  function warehouseSubmissionState(model) {
    if (!model) return null;
    const packageItem = model.packageProps && model.packageProps.packageItem;
    if (packageItem && typeof packageItem === 'object') {
      return {
        source: 'packageItem',
        warehouseId: packageItem.warehouseId,
        warehouseName: packageItem.warehouseName,
        timezone: packageItem.timezone ?? packageItem.timeZone,
        certifiedWarehouseInfo: packageItem.certifiedWarehouseInfo,
      };
    }
    const formItemProps = model.formItemProps;
    const field = String(formItemProps && formItemProps.field || '');
    const recordProps = getReactProps(model.header, candidate => (
      candidate.record
      && typeof candidate.record === 'object'
      && Object.prototype.hasOwnProperty.call(candidate.record, 'warehouseId')
    ), 40);
    const record = (formItemProps && formItemProps.record) || (recordProps && recordProps.record);
    if (record && typeof record === 'object') {
      return {
        source: 'record',
        warehouseId: record.warehouseId,
        warehouseName: record.warehouseName,
        timezone: record.timezone,
        certifiedWarehouseInfo: record.certifiedWarehouseInfo,
      };
    }

    const formProps = getReactProps(model.header, candidate => {
      const api = candidate && candidate.formApi && (candidate.formApi.current || candidate.formApi);
      return api && typeof api.getFieldValue === 'function';
    }, 40);
    const api = formProps && formProps.formApi && (formProps.formApi.current || formProps.formApi);
    if (!api || !field) return null;
    const prefix = field.slice(0, -'warehouseId'.length);
    try {
      return {
        source: 'form',
        warehouseId: api.getFieldValue(`${prefix}warehouseId`),
        warehouseName: api.getFieldValue(`${prefix}warehouseName`),
        timezone: api.getFieldValue(`${prefix}timezone`),
        certifiedWarehouseInfo: api.getFieldValue(`${prefix}certifiedWarehouseInfo`),
      };
    } catch (_) {
      return null;
    }
  }

  function warehouseSubmissionIssues(state, option) {
    if (!state) return ['无法读取仓库提交模型'];
    const expectedId = String(option.warehouseId ?? option.whId ?? '').trim();
    const expectedName = String(option.warehouseName || '').trim();
    const expectedTimezone = String(option.timeZone ?? option.timezone ?? '').trim();
    const actualId = String(state.warehouseId ?? '').trim();
    const actualName = String(state.warehouseName ?? '').trim();
    const actualTimezone = String(state.timezone ?? '').trim();
    const issues = [];
    if (!actualId || actualId !== expectedId) issues.push(`warehouseId=${actualId || '空'}`);
    if (!actualName || actualName !== expectedName) issues.push(`warehouseName=${actualName || '空'}`);
    if (expectedTimezone && actualTimezone !== expectedTimezone) issues.push(`timezone=${actualTimezone || '空'}`);
    if (option.certifiedWarehouseInfo && Object.keys(option.certifiedWarehouseInfo).length) {
      const actualCertified = state.certifiedWarehouseInfo;
      if (!actualCertified || typeof actualCertified !== 'object' || !Object.keys(actualCertified).length) {
        issues.push('certifiedWarehouseInfo=空');
      }
    }
    return issues;
  }

  function getDimensionModel(tr, placeholder) {
    const input = [...tr.querySelectorAll('input[data-testid="beast-core-inputNumber-htmlInput"]')]
      .find(element => element.placeholder === placeholder);
    if (!input) return null;
    const props = getReactProps(input, candidate => (
      typeof candidate.onChange === 'function'
      && Object.prototype.hasOwnProperty.call(candidate, 'precision')
      && Object.prototype.hasOwnProperty.call(candidate, 'value')
    ));
    return props ? { input, props } : null;
  }

  function displayedPackageQuantity(tr, item) {
    const matches = [...String(tr && tr.innerText || '').matchAll(/×\s*(\d+)/g)];
    if (matches.length) return matches.reduce((sum, match) => sum + Number(match[1] || 0), 0);
    const fallback = Number(item && (item.unpackedQuantity ?? item.quantity ?? item.skuQuantity));
    return Number.isInteger(fallback) && fallback > 0 ? fallback : 0;
  }

  function pagePackageGroups() {
    const tableBodies = [...pageDocument.querySelectorAll('tbody[data-testid="beast-core-table-middle-tbody"]')];
    if (!tableBodies.length) {
      return pageRows().map(row => {
        const item = getOrderItem(row);
        const po = String(item && item.parentOrderSn || '').trim();
        return {
          tbody: null,
          rows: [row],
          items: item ? [{ tr: row, item }] : [],
          po,
          unitCount: item ? displayedPackageQuantity(row, item) : 0,
        };
      }).filter(group => group.po && group.rows.length);
    }
    return tableBodies.map(tbody => {
      const rows = [...tbody.querySelectorAll('tr[data-testid="beast-core-table-body-tr"]')];
      const items = rows.map(tr => ({ tr, item: getOrderItem(tr) })).filter(entry => entry.item);
      const poValues = [...new Set(items.map(entry => String(entry.item.parentOrderSn || '').trim()).filter(Boolean))];
      return {
        tbody,
        rows,
        items,
        po: poValues.length === 1 ? poValues[0] : '',
        unitCount: items.reduce((sum, entry) => sum + displayedPackageQuantity(entry.tr, entry.item), 0),
      };
    }).filter(group => group.po && group.rows.length);
  }

  function pageSplitCandidates() {
    const grouped = new Map();
    pagePackageGroups().filter(group => group.unitCount > 1).forEach(group => {
      if (!grouped.has(group.po)) grouped.set(group.po, { po: group.po, packageCount: 0, unitCount: 0 });
      const candidate = grouped.get(group.po);
      candidate.packageCount++;
      candidate.unitCount += group.unitCount;
    });
    return [...grouped.values()];
  }

  function pageMatchDescriptor(item) {
    const po = String(item && item.parentOrderSn || '').trim();
    const channelSku = String(item && item.extCodeList && item.extCodeList[0] || '').trim();
    const platformSkuId = String(item && item.skuId || '').trim();
    if (!po) return null;
    if (channelSku) {
      return {
        po,
        mode: 'channelSku',
        value: channelSku,
        key: `${po}||${channelSku}`,
        occurrenceKey: `channelSku||${po}||${channelSku}`,
        label: channelSku,
      };
    }
    if (platformSkuId) {
      return {
        po,
        mode: 'platformSkuId',
        value: platformSkuId,
        key: `${po}||${platformSkuId}`,
        occurrenceKey: `platformSkuId||${po}||${platformSkuId}`,
        label: `平台SKU:${platformSkuId}`,
      };
    }
    return null;
  }

  function taskRowsForDescriptor(taskData, descriptor) {
    if (!descriptor) return null;
    return descriptor.mode === 'platformSkuId'
      ? taskData.platformGroups.get(descriptor.key)
      : taskData.groups.get(descriptor.key);
  }

  function taskHasConflict(taskData, descriptor) {
    if (!descriptor) return false;
    return descriptor.mode === 'platformSkuId'
      ? taskData.platformConflicts.has(descriptor.key)
      : taskData.conflicts.has(descriptor.key);
  }

  function pageMatchCounts() {
    const counts = new Map();
    pageRows().forEach(tr => {
      const item = getOrderItem(tr);
      const descriptor = pageMatchDescriptor(item);
      if (!descriptor) return;
      if (!counts.has(descriptor.occurrenceKey)) {
        counts.set(descriptor.occurrenceKey, { descriptor, count: 0, orderSns: new Set() });
      }
      const entry = counts.get(descriptor.occurrenceKey);
      entry.count++;
      const orderSn = String(item && item.orderSn || '').trim();
      if (orderSn) entry.orderSns.add(orderSn);
    });
    return counts;
  }

  function taskDrivenSplitPlan(taskData) {
    const split = [];
    const excess = [];
    pageMatchCounts().forEach(entry => {
      if (taskHasConflict(taskData, entry.descriptor)) return;
      const taskRows = taskRowsForDescriptor(taskData, entry.descriptor);
      if (!taskRows || !taskRows.length) return;
      const expected = taskRows.length;
      const actual = entry.count;
      const item = { ...entry, expected, actual, taskRows };
      if (expected > actual) split.push(item);
      else if (expected < actual) excess.push(item);
    });
    return { split, excess };
  }

  function pageOrderSns(po) {
    return new Set(pageRows().map(getOrderItem)
      .filter(item => item && String(item.parentOrderSn || '').trim() === po)
      .map(item => String(item.orderSn || '').trim()).filter(Boolean));
  }

  function visibleDrawer() {
    return [...pageDocument.querySelectorAll('[data-testid="beast-core-drawer"]')].find(drawer => {
      const rect = drawer.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0
        && [...drawer.querySelectorAll('*')].some(element => String(element.textContent || '').trim() === '编辑包裹');
    }) || null;
  }

  function exactVisibleElements(scope, selector, text) {
    return [...scope.querySelectorAll(selector)].filter(element => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && String(element.textContent || '').trim() === text;
    });
  }

  function drawerPackageLabels(drawer) {
    return [...drawer.querySelectorAll('span')].filter(element => /^包裹\s+\d+$/.test(String(element.textContent || '').trim()));
  }

  function drawerSectionForLabel(label) {
    let node = label;
    for (let depth = 0; node && depth < 10; depth++, node = node.parentElement) {
      const labels = [...node.querySelectorAll('span')].filter(element => /^包裹\s+\d+$/.test(String(element.textContent || '').trim()));
      const hasProductControls = node.querySelector('[data-testid="beast-core-select-header"]')
        && node.querySelector('input[data-testid="beast-core-inputNumber-htmlInput"]')
        && exactVisibleElements(node, 'a[data-testid="beast-core-button-link"]', '添加商品').length === 1;
      if (labels.length === 1 && labels[0] === label && hasProductControls) return node;
    }
    return null;
  }

  function drawerPackageSections(drawer) {
    const labels = drawerPackageLabels(drawer);
    const sections = labels.map(label => ({ label, section: drawerSectionForLabel(label) })).filter(entry => entry.section);
    const unique = [];
    sections.forEach(entry => {
      if (!unique.some(item => item.section === entry.section)) unique.push(entry);
    });
    if (labels.length !== unique.length) throw new Error('编辑包裹中存在平台子包裹结构，已停止自动拆分');
    return unique;
  }

  function drawerProducts(section) {
    const headers = [...section.querySelectorAll('[data-testid="beast-core-select-header"]')];
    const inputs = [...section.querySelectorAll('input[data-testid="beast-core-inputNumber-htmlInput"]')];
    if (!headers.length || headers.length !== inputs.length) throw new Error('编辑包裹的商品选择与数量字段数量不一致');
    return headers.map((header, index) => {
      const match = String(header.innerText || '').match(/子订单号[：:\s]*([0-9]+-[0-9]+)/);
      const quantity = Number(inputs[index].value);
      return { header, input: inputs[index], orderSn: match ? match[1] : '', quantity };
    });
  }

  function readDrawerPlan(drawer) {
    const packages = drawerPackageSections(drawer).map(entry => ({ ...entry, products: drawerProducts(entry.section) }));
    const units = [];
    packages.forEach((pkg, packageIndex) => pkg.products.forEach((product, productIndex) => {
      if (!product.orderSn) throw new Error(`包裹 ${packageIndex + 1} 第 ${productIndex + 1} 个商品缺少子订单号`);
      if (!Number.isInteger(product.quantity) || product.quantity <= 0) {
        throw new Error(`包裹 ${packageIndex + 1} 第 ${productIndex + 1} 个商品数量无效`);
      }
      for (let count = 0; count < product.quantity; count++) units.push(product.orderSn);
    }));
    return { packages, units };
  }

  async function setDrawerQuantity(input, value) {
    const props = getReactProps(input, candidate => (
      typeof candidate.onChange === 'function'
      && Object.prototype.hasOwnProperty.call(candidate, 'precision')
      && Object.prototype.hasOwnProperty.call(candidate, 'value')
    ));
    if (!props) throw new Error('找不到编辑包裹数量的 React 更新入口');
    props.onChange(value);
    await waitForResult(() => Number(input.value) === value, 3000);
    const EventConstructor = pageWindow.Event || Event;
    input.dispatchEvent(new EventConstructor('change', { bubbles: true }));
    input.blur();
  }

  async function deleteDrawerProduct(section, productIndex) {
    const before = section.querySelectorAll('input[data-testid="beast-core-inputNumber-htmlInput"]').length;
    const links = exactVisibleElements(section, 'a[data-testid="beast-core-button-link"]', '删除商品');
    if (before <= 1 || links.length !== before) throw new Error('编辑包裹的删除商品控件数量异常');
    fireMouse(links[productIndex]);
    await waitForResult(() => section.querySelectorAll('input[data-testid="beast-core-inputNumber-htmlInput"]').length === before - 1, 3000);
  }

  async function deleteLastDrawerPackage(drawer) {
    const packages = drawerPackageSections(drawer);
    if (packages.length <= 1) throw new Error('至少需要保留一个包裹');
    const last = packages[packages.length - 1];
    const links = exactVisibleElements(last.label.parentElement || last.section, 'a[data-testid="beast-core-button-link"]', '删除');
    if (links.length !== 1) throw new Error('找不到最后一个包裹的删除入口');
    fireMouse(links[0]);
    await waitForResult(() => drawerPackageSections(drawer).length === packages.length - 1, 3000);
  }

  async function addDrawerPackage(drawer) {
    const before = drawerPackageSections(drawer).length;
    const links = exactVisibleElements(drawer, 'a[data-testid="beast-core-button-link"]', '添加包裹');
    if (links.length !== 1) throw new Error('编辑包裹的添加包裹入口数量异常');
    fireMouse(links[0]);
    return waitForResult(() => {
      const packages = drawerPackageSections(drawer);
      return packages.length === before + 1 ? packages[packages.length - 1] : null;
    }, 3000);
  }

  function drawerSplitCards(drawer) {
    return exactVisibleElements(drawer, 'a[data-testid="beast-core-button-link"]', '拆分包裹').map(link => {
      let card = link;
      for (let depth = 0; card && depth < 9; depth++, card = card.parentElement) {
        const headers = card.querySelectorAll('[data-testid="beast-core-select-header"]');
        const inputs = card.querySelectorAll('input[data-testid="beast-core-inputNumber-htmlInput"]');
        if (headers.length === 1 && inputs.length === 1) break;
      }
      if (!card) throw new Error('找不到“拆分包裹”对应的商品卡片');
      const product = drawerProducts(card)[0];
      let assignment = card;
      for (let depth = 0; assignment && depth < 9; depth++, assignment = assignment.parentElement) {
        const labels = drawerPackageLabels(assignment);
        const selects = assignment.querySelectorAll('[data-testid="beast-core-select-header"]');
        if (labels.length && selects.length === 1) {
          return { link, card, orderSn: product.orderSn, packageCount: labels.length };
        }
      }
      throw new Error('无法确认商品当前分配到几个包裹');
    });
  }

  function drawerSplitCard(drawer, allowedOrderSns) {
    const cards = drawerSplitCards(drawer).filter(card => allowedOrderSns.has(card.orderSn));
    if (cards.length !== 1) throw new Error(`匹配到的“拆分包裹”商品卡片数量异常：${cards.length}`);
    return cards[0];
  }

  async function chooseDrawerOrder(section, orderSn) {
    const products = drawerProducts(section);
    if (products.length !== 1 || products[0].orderSn) throw new Error('新包裹的初始商品字段异常');
    fireMouse(products[0].header);
    const option = await waitForResult(() => {
      const candidates = [...pageDocument.querySelectorAll('li[role="option"]')].filter(element => {
        const rect = element.getBoundingClientRect();
        const match = String(element.innerText || '').match(/子订单号[：:\s]*([0-9]+-[0-9]+)/);
        return rect.width > 0 && rect.height > 0 && match && match[1] === orderSn;
      });
      if (candidates.length > 1) throw new Error(`子订单 ${orderSn} 在商品下拉中匹配到多项`);
      return candidates[0] || null;
    }, 3000);
    fireMouse(option);
    await waitForResult(() => drawerProducts(section)[0].orderSn === orderSn, 3000);
  }

  function cancelDrawer(drawer) {
    const buttons = exactVisibleElements(drawer, 'button', '取消');
    if (buttons.length === 1) fireMouse(buttons[0]);
  }

  async function openAdjustDrawer(po) {
    if (visibleDrawer()) throw new Error('页面已有打开的编辑包裹面板，请先关闭后重试');
    const buttons = [...pageDocument.querySelectorAll('button')].filter(button => {
      const rect = button.getBoundingClientRect();
      const tbody = button.closest('tbody[data-testid="beast-core-table-middle-tbody"]');
      return rect.width > 0 && rect.height > 0
        && String(button.textContent || '').trim() === '调整包裹'
        && tbody && String(tbody.innerText || '').includes(po);
    });
    if (buttons.length !== 1) throw new Error(`${po} 的“调整包裹”入口数量异常：${buttons.length}`);
    fireMouse(buttons[0]);
    return waitForResult(() => visibleDrawer(), 5000);
  }

  async function confirmDrawer(drawer) {
    const buttons = exactVisibleElements(drawer, 'button', '确认');
    if (buttons.length !== 1) throw new Error('编辑包裹的确认按钮数量异常');
    fireMouse(buttons[0]);
    await waitForResult(() => !visibleDrawer(), 10000, 150);
  }

  function sameOrderSnUnits(left, right) {
    const leftSorted = [...left].sort();
    const rightSorted = [...right].sort();
    return leftSorted.length === rightSorted.length && leftSorted.every((value, index) => value === rightSorted[index]);
  }

  async function verifySingleUnitPackages(po, expectedUnits) {
    await waitForResult(() => {
      const groups = pagePackageGroups().filter(group => group.po === po);
      const actualUnits = groups.flatMap(group => group.items.flatMap(entry => {
        const quantity = displayedPackageQuantity(entry.tr, entry.item);
        return Array.from({ length: quantity }, () => String(entry.item.orderSn || '').trim());
      }));
      return groups.length === expectedUnits.length
        && groups.every(group => group.unitCount === 1)
        && groups.reduce((sum, group) => sum + group.unitCount, 0) === expectedUnits.length
        && sameOrderSnUnits(actualUnits, expectedUnits);
    }, 8000, 150);
  }

  async function normalizePoToSingleUnitPackages(po) {
    const allowedOrderSns = pageOrderSns(po);
    const drawer = await openAdjustDrawer(po);
    let submitStarted = false;
    try {
      const plan = readDrawerPlan(drawer);
      if (plan.units.some(orderSn => !allowedOrderSns.has(orderSn))) throw new Error('编辑包裹返回了当前订单范围外的子订单');
      if (plan.units.length <= 1) {
        cancelDrawer(drawer);
        await waitForResult(() => !visibleDrawer(), 3000);
        return { changed: false, units: plan.units };
      }
      if (plan.units.length > MAX_AUTO_SPLIT_UNITS) {
        throw new Error(`共 ${plan.units.length} 件，超过自动拆包安全上限 ${MAX_AUTO_SPLIT_UNITS} 件`);
      }
      const alreadySingle = plan.packages.length === plan.units.length
        && plan.packages.every(pkg => pkg.products.length === 1 && pkg.products[0].quantity === 1);
      if (alreadySingle) {
        cancelDrawer(drawer);
        await waitForResult(() => !visibleDrawer(), 3000);
        return { changed: false, units: plan.units };
      }

      while (drawerPackageSections(drawer).length > 1) await deleteLastDrawerPackage(drawer);
      let first = drawerPackageSections(drawer)[0];
      let firstProducts = drawerProducts(first.section);
      for (let index = firstProducts.length - 1; index >= 1; index--) {
        await deleteDrawerProduct(first.section, index);
        firstProducts = drawerProducts(first.section);
      }
      if (firstProducts[0].orderSn !== plan.units[0]) throw new Error('保留商品与拆包计划首件不一致');
      if (firstProducts[0].quantity !== 1) await setDrawerQuantity(firstProducts[0].input, 1);

      for (const orderSn of plan.units.slice(1)) {
        const added = await addDrawerPackage(drawer);
        await chooseDrawerOrder(added.section, orderSn);
        const product = drawerProducts(added.section)[0];
        await setDrawerQuantity(product.input, 1);
      }

      const finalPlan = readDrawerPlan(drawer);
      if (finalPlan.packages.length !== plan.units.length
        || finalPlan.packages.some(pkg => pkg.products.length !== 1 || pkg.products[0].quantity !== 1)
        || !sameOrderSnUnits(finalPlan.units, plan.units)) {
        throw new Error('拆包后的包裹数量、商品或件数复核不一致');
      }
      submitStarted = true;
      await confirmDrawer(drawer);
      await verifySingleUnitPackages(po, plan.units);
      return { changed: true, units: plan.units };
    } catch (error) {
      if (!submitStarted && visibleDrawer()) {
        cancelDrawer(drawer);
        try { await waitForResult(() => !visibleDrawer(), 3000); } catch (_) { /* 保留原错误。 */ }
      }
      throw error;
    }
  }

  async function splitTaskPackages(candidate) {
    if (candidate.expected > MAX_AUTO_SPLIT_UNITS) {
      throw new Error(`${candidate.po || candidate.descriptor.po} 需要 ${candidate.expected} 个包裹，超过自动拆包安全上限 ${MAX_AUTO_SPLIT_UNITS}`);
    }
    const drawer = await openAdjustDrawer(candidate.descriptor.po);
    let submitStarted = false;
    try {
      let card = drawerSplitCard(drawer, candidate.orderSns);
      if (card.packageCount !== candidate.actual) {
        throw new Error(`原生面板包裹数 ${card.packageCount} 与页面包裹行 ${candidate.actual} 不一致`);
      }
      while (card.packageCount < candidate.expected) {
        const before = card.packageCount;
        fireMouse(card.link);
        card = await waitForResult(() => {
          const current = drawerSplitCard(drawer, candidate.orderSns);
          return current.packageCount === before + 1 ? current : null;
        }, 3000);
      }
      if (card.packageCount !== candidate.expected) throw new Error('拆包后的原生包裹数量复核不一致');
      submitStarted = true;
      await confirmDrawer(drawer);
      await waitForResult(() => {
        const entry = pageMatchCounts().get(candidate.descriptor.occurrenceKey);
        return entry && entry.count === candidate.expected;
      }, 8000, 150);
      return candidate.expected;
    } catch (error) {
      if (!submitStarted && visibleDrawer()) {
        cancelDrawer(drawer);
        try { await waitForResult(() => !visibleDrawer(), 3000); } catch (_) { /* 保留原错误。 */ }
      }
      throw error;
    }
  }

  function selectWarehouseOption(model, mapRow) {
    const options = warehouseOptions(model).filter(option => option && !option.disabled && option.supportSend !== false);
    if (mapRow.whId) {
      const byId = options.filter(option => String(option.warehouseId) === String(mapRow.whId));
      if (byId.length === 1) return byId[0];
      if (byId.length > 1) throw new Error(`仓库 ID“${mapRow.whId}”匹配到多项`);
    }
    const exact = options.filter(option => String(option.warehouseName || '').trim() === mapRow.temuName);
    if (exact.length === 1) return exact[0];
    if (exact.length > 1) throw new Error(`仓库名称“${mapRow.temuName}”匹配到多项`);
    const partial = options.filter(option => String(option.warehouseName || '').includes(mapRow.temuName));
    if (partial.length === 1) return partial[0];
    if (partial.length > 1) throw new Error(`仓库名称“${mapRow.temuName}”模糊匹配到多项`);
    const sample = options.slice(0, 6).map(option => option.warehouseName).filter(Boolean).join(' | ');
    throw new Error(`没有“${mapRow.temuName}”；前 6 项：${sample}`);
  }

  function hasExactVisibleText(element, expectedText) {
    const expected = String(expectedText || '').replace(/\s+/g, ' ').trim();
    if (!expected) return false;
    return [element, ...element.querySelectorAll('*')].some(node => {
      if (node.children.length) return false;
      return String(node.textContent || '').replace(/\s+/g, ' ').trim() === expected;
    });
  }

  function visibleWarehouseOption(warehouseOption) {
    const warehouseName = String(warehouseOption && warehouseOption.warehouseName || '').trim();
    if (!warehouseName) return null;
    const matches = [...pageDocument.querySelectorAll('[role="option"]')].filter(element => {
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0 || element.getAttribute('data-disabled') === 'true') return false;
      return hasExactVisibleText(element, warehouseName);
    });
    if (matches.length > 1) throw new Error(`可见仓库选项“${warehouseName}”重复，已阻止猜测`);
    return matches[0] || null;
  }

  async function clickWarehouseOption(model, warehouseOption) {
    let optionElement = visibleWarehouseOption(warehouseOption);
    if (!optionElement) {
      const input = model.header.querySelector('input');
      const target = input || model.header;
      closeWarehouseDropdown(model);
      await sleep(40);
      fireMouse(target);
      optionElement = await waitForResult(() => visibleWarehouseOption(warehouseOption), 5000);
    }
    optionElement.scrollIntoView({ block: 'nearest' });
    fireMouse(optionElement);
  }

  function findPageRow(job) {
    const matches = pageRows().filter(tr => {
      const item = getOrderItem(tr);
      if (!item || String(item.parentOrderSn || '').trim() !== job.po) return false;
      if (job.matchMode === 'platformSkuId') {
        return String(item.skuId || '').trim() === job.platformSkuId;
      }
      return String(item.extCodeList && item.extCodeList[0] || '').trim() === job.channelSku;
    });
    const occurrence = Number.isInteger(job.matchOccurrence) ? job.matchOccurrence : 0;
    return matches[occurrence] || null;
  }

  async function waitForResult(getValue, timeout = 18000, interval = 100) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeout) {
      if (stopRequested) throw new Error('已停止');
      const value = getValue();
      if (value) return value;
      await sleep(interval);
    }
    throw new Error('等待页面更新超时');
  }

  function displayedMeasurements(tr) {
    const values = {};
    ['重量', '长', '宽', '高'].forEach(placeholder => {
      const model = getDimensionModel(tr, placeholder);
      values[placeholder] = model ? model.input.value : '';
    });
    return values;
  }

  function commitDimensionControls(tr) {
    const EventConstructor = pageWindow.Event || Event;
    [...tr.querySelectorAll('input[data-testid="beast-core-inputNumber-htmlInput"]')].forEach(input => {
      input.dispatchEvent(new EventConstructor('change', { bubbles: true }));
      input.blur();
    });
  }

  function fireMouse(element) {
    if (!element) return;
    const MouseEventConstructor = pageWindow.MouseEvent || MouseEvent;
    ['mousedown', 'mouseup', 'click'].forEach(type => {
      element.dispatchEvent(new MouseEventConstructor(type, { bubbles: true, cancelable: true, view: pageWindow }));
    });
  }

  async function fastPrepareRow(job) {
    const tr = findPageRow(job);
    if (!tr) throw new Error('页面订单行已变化，请重新开始');
    const dimensionModels = {
      weight: getDimensionModel(tr, '重量'),
      length: getDimensionModel(tr, '长'),
      width: getDimensionModel(tr, '宽'),
      height: getDimensionModel(tr, '高'),
    };
    if (Object.values(dimensionModels).some(model => !model)) throw new Error('找不到重量或尺寸输入框');

    dimensionModels.weight.props.onChange(Number(job.measurements.weight));
    dimensionModels.length.props.onChange(Number(job.measurements.length));
    dimensionModels.width.props.onChange(Number(job.measurements.width));
    dimensionModels.height.props.onChange(Number(job.measurements.height));

    const dimensionsReady = await waitForResult(() => {
      const current = findPageRow(job);
      if (!current) return null;
      const values = displayedMeasurements(current);
      return (
        Number(values['重量']) === Number(job.measurements.weight)
        && Number(values['长']) === Number(job.measurements.length)
        && Number(values['宽']) === Number(job.measurements.width)
        && Number(values['高']) === Number(job.measurements.height)
      ) ? current : null;
    }, 5000);
    commitDimensionControls(dimensionsReady);
    await sleep(80);

    const current = findPageRow(job);
    const warehouseModel = current && await ensureWarehouseOptions(current);
    if (!warehouseModel) throw new Error('找不到仓库表单更新入口');
    const warehouseOption = selectWarehouseOption(warehouseModel, job.mapRow);
    await clickWarehouseOption(warehouseModel, warehouseOption);

    try {
      await waitForResult(() => {
        const updated = findPageRow(job);
        if (!updated) return null;
        const updatedModel = getWarehouseModel(updated);
        if (!updatedModel) return null;
        const warehouseInput = updatedModel.header.querySelector('input');
        const displayReady = warehouseInput && warehouseInput.value.trim() === String(warehouseOption.warehouseName).trim();
        const issues = warehouseSubmissionIssues(warehouseSubmissionState(updatedModel), warehouseOption);
        return displayReady && !issues.length ? updated : null;
      }, 5000);
    } catch (error) {
      const failedRow = findPageRow(job);
      const failedModel = failedRow && getWarehouseModel(failedRow);
      const issues = warehouseSubmissionIssues(warehouseSubmissionState(failedModel), warehouseOption);
      throw new Error(issues.length ? `仓库提交模型不完整：${issues.join('，')}` : error.message);
    }

    const verifiedRow = findPageRow(job);
    const verified = verifiedRow && getWarehouseModel(verifiedRow);
    const issues = warehouseSubmissionIssues(warehouseSubmissionState(verified), warehouseOption);
    if (issues.length) throw new Error(`仓库提交模型不完整：${issues.join('，')}`);
    return warehouseOption;
  }

  function clamp(x, y, width, height) {
    return {
      x: Math.max(MARGIN, Math.min(x, window.innerWidth - width - MARGIN)),
      y: Math.max(MARGIN, Math.min(y, window.innerHeight - height - MARGIN)),
    };
  }

  function snap(x, y) {
    const position = clamp(x, y, BUBBLE_SIZE, BUBBLE_SIZE);
    const nearest = [
      ['left', position.x], ['right', window.innerWidth - position.x - BUBBLE_SIZE],
      ['top', position.y], ['bottom', window.innerHeight - position.y - BUBBLE_SIZE],
    ].sort((a, b) => a[1] - b[1])[0][0];
    if (nearest === 'left') position.x = MARGIN;
    if (nearest === 'right') position.x = window.innerWidth - BUBBLE_SIZE - MARGIN;
    if (nearest === 'top') position.y = MARGIN;
    if (nearest === 'bottom') position.y = window.innerHeight - BUBBLE_SIZE - MARGIN;
    return clamp(position.x, position.y, BUBBLE_SIZE, BUBBLE_SIZE);
  }

  function place(element, position) {
    element.style.left = `${position.x}px`;
    element.style.top = `${position.y}px`;
  }

  function savePosition(position) {
    state = { ...state, x: Math.round(position.x), y: Math.round(position.y) };
    gmSet(GM_KEYS.state, state);
  }

  function bindDrag(handle, target, isBubble) {
    handle.addEventListener('pointerdown', event => {
      if (!isBubble && event.target.closest('button,input,select,textarea,summary')) return;
      event.preventDefault();
      let moved = false;
      if (isBubble) dragMoved = false;
      const rect = target.getBoundingClientRect();
      const startX = event.clientX;
      const startY = event.clientY;
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
        savePosition(position);
      };
      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onUp);
    });
  }

  const css = `
    #__tfp,#__tfpBubble{font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","PingFang SC",sans-serif;color:#1d1d1f;box-sizing:border-box}
    #__tfp *{box-sizing:border-box}#__tfpBubble{position:fixed;z-index:2147483580;width:${BUBBLE_SIZE}px;height:${BUBBLE_SIZE}px;border:1px solid rgba(255,255,255,.9);border-radius:50%;display:grid;place-items:center;padding:0;background:#303640;color:#fff;box-shadow:0 6px 18px rgba(15,23,42,.24),inset 0 0 0 1px rgba(255,255,255,.12);font-size:11px;font-weight:700;text-align:center;cursor:grab;user-select:none}
    #__tfpBubble::after{content:'';position:absolute;right:2px;bottom:3px;width:7px;height:7px;border:2px solid #303640;border-radius:50%;background:#f59e0b}
    #__tfp{position:fixed;z-index:2147483580;width:min(380px,calc(100vw - 16px));height:min(560px,calc(100vh - 16px));display:flex;flex-direction:column;background:#fff;border:1px solid #dde2ea;border-radius:14px;box-shadow:0 14px 36px rgba(20,34,58,.16);overflow:hidden;font-size:12px}
    #__tfp .hd{height:44px;padding:0 9px 0 12px;display:flex;align-items:center;gap:6px;cursor:move;user-select:none;border-bottom:1px solid #e9edf3;background:#f7f8fa}#__tfp .ttl{font-weight:700}#__tfp .sp{flex:1}
    #__tfp .body{padding:8px;overflow:auto;flex:1}#__tfp .card{padding:8px;border:1px solid #e7ebf2;border-radius:10px;background:#fff;margin-bottom:7px}#__tfp .label{font-size:11px;color:#747f91;margin-bottom:4px}
    #__tfp select,#__tfp input,#__tfp textarea{font:inherit;width:100%;border:1px solid #dfe5ee;border-radius:9px;background:#fbfcfe;color:#1d1d1f;padding:7px 9px}#__tfp textarea{min-height:62px;resize:vertical;font-family:ui-monospace,"SF Mono",Menlo,monospace;font-size:11px}
    #__tfp select:focus,#__tfp input:focus,#__tfp textarea:focus{outline:none;border-color:#0878ef;box-shadow:0 0 0 3px rgba(8,120,239,.14)}
    #__tfp button{font:inherit;font-weight:600;font-size:11px;min-height:28px;border:0;border-radius:8px;padding:4px 8px;background:#edf1f6;color:#344158;cursor:pointer}#__tfp button:disabled{opacity:.45;cursor:not-allowed}#__tfp button:focus-visible,#__tfpBubble:focus-visible{outline:3px solid rgba(8,120,239,.34);outline-offset:2px}
    #__tfp .primary{background:#0878ef;color:#fff}#__tfp .danger{background:#d7473f;color:#fff}#__tfp .icon{width:31px;padding:0;background:transparent;color:#6f7784;font-size:16px}
    #__tfp .row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}#__tfp .row>*{flex:1}#__tfp .summary{font-size:12px;line-height:1.5;color:#4d596d;white-space:pre-wrap}#__tfp .summary.warn{color:#a55700;background:#fff7e8;padding:7px;border-radius:8px}
    #__tfp details summary{cursor:pointer;color:#596579;font-weight:600}#__tfp .drop{margin-top:8px;padding:13px;border:1.5px dashed #cdd5e1;border-radius:10px;text-align:center;color:#748095;cursor:pointer}#__tfp .drop.over{border-color:#0878ef;background:#edf6ff;color:#0878ef}
    #__tfp .log{min-height:100px;max-height:240px;overflow:auto;padding:8px 9px;border-radius:10px;background:#f4f6f9;font-family:ui-monospace,"SF Mono",Menlo,monospace;font-size:11px;line-height:1.55;white-space:pre-wrap}
    @media(prefers-color-scheme:dark){#__tfpBubble{border-color:#fff;box-shadow:0 9px 24px rgba(0,0,0,.55),0 0 0 2px #000}}@media(prefers-reduced-motion:reduce){#__tfp,#__tfpBubble{transition:none!important}}
  `;
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  function log(message, color = '') {
    const box = root.querySelector('#tfpLog');
    if (!box) return;
    const line = document.createElement('div');
    line.textContent = message;
    if (color) line.style.color = color;
    box.appendChild(line);
    box.scrollTop = box.scrollHeight;
  }

  function highlight(row, color) {
    row.style.background = color;
  }

  function renderBubble() {
    root.innerHTML = '<button id="__tfpBubble" type="button" title="展开 TEMU 填充">填仓</button>';
    const bubble = root.querySelector('#__tfpBubble');
    const position = snap(state.x, state.y);
    place(bubble, position);
    savePosition(position);
    bindDrag(bubble, bubble, true);
    bubble.addEventListener('click', () => {
      if (!dragMoved) renderPanel();
      dragMoved = false;
    });
  }

  function renderPanel() {
    const tasks = taskList();
    const active = activeTask();
    root.innerHTML = `
      <section id="__tfp">
        <header class="hd"><span class="ttl">TEMU 仓库填充</span><span class="sp"></span><button id="tfpMin" class="icon" type="button" title="收起">—</button></header>
        <main class="body">
          <section class="card">
            <div class="label">当前 OMS 批次</div>
            <select id="tfpTask" ${tasks.length ? '' : 'disabled'}>${tasks.length ? tasks.map(task => `<option value="${escapeHtml(task.id)}" ${active && active.id === task.id ? 'selected' : ''}>${escapeHtml(task.label || task.id)}</option>`).join('') : '<option>尚未收到任务</option>'}</select>
            <div id="tfpTaskInfo" class="summary"></div>
          </section>
          <section class="card">
            <div id="tfpMapInfo" class="summary"></div>
            <div id="tfpProductInfo" class="summary" style="margin-top:5px"></div>
            <div class="row" style="margin-top:8px"><label class="label" for="tfpGap" style="flex:0 0 auto;margin:0">单间附加等待</label><input id="tfpGap" type="number" min="0" step="100" value="${DEFAULT_ITEM_GAP_MS}" style="max-width:92px"><span class="label" style="flex:0 0 auto;margin:0">毫秒</span></div>
            <div class="row" style="margin-top:8px"><button id="tfpDry" type="button">仅预演</button><button id="tfpRun" class="primary" type="button">开始填充</button><button id="tfpStop" class="danger" type="button" disabled>停止</button></div>
          </section>
          <details class="card"><summary>商品尺寸数据</summary>
            <div id="tfpProductDrop" class="drop">点击或拖入商品表 .csv / .xlsx<input id="tfpProductFile" type="file" accept=".csv,.xlsx" hidden></div>
            <div class="label" style="margin-top:6px">重新导入会用新表整表替换当前商品数据，不修改本地源文件。</div>
            <div class="row" style="margin-top:7px"><button id="tfpClearProduct" type="button">清空商品数据</button></div>
          </details>
          <details class="card"><summary>仓库对照表</summary>
            <div id="tfpDrop" class="drop">点击或拖入 .csv / .xlsx<input id="tfpFile" type="file" accept=".csv,.xlsx" hidden></div>
            <div class="label" style="margin-top:8px">也可粘贴 CSV 全文</div><textarea id="tfpCsv" placeholder="包含表头"></textarea>
            <div class="row" style="margin-top:7px"><button id="tfpImportText" type="button">导入文本</button><button id="tfpClear" type="button">清空对照表</button></div>
          </details>
          <div id="tfpLog" class="log">等待操作。脚本只填写当前页面，不确认下单。</div>
        </main>
      </section>`;
    const panel = root.querySelector('#__tfp');
    place(panel, clamp(state.x, state.y, Math.min(380, window.innerWidth - 16), Math.min(560, window.innerHeight - 16)));
    bindDrag(panel.querySelector('.hd'), panel, false);
    bindPanelEvents();
    refreshPanelInfo();
  }

  function refreshPanelInfo() {
    const active = activeTask();
    const taskInfo = root.querySelector('#tfpTaskInfo');
    if (taskInfo) {
      taskInfo.className = active ? 'summary' : 'summary warn';
      taskInfo.textContent = active
        ? `任务：${active.orderCount || active.rows.length} 单\n来源页：${active.sourceTabId || '未知'}\n创建：${active.createdAt ? new Date(active.createdAt).toLocaleString() : '未知'}`
        : '请先回到目标 OMS 订单页，在 ERP 采集器中点击“设为本批 TEMU 任务”。';
    }
    const mapping = loadMapping();
    const mapInfo = root.querySelector('#tfpMapInfo');
    if (mapInfo) mapInfo.textContent = mapping.length
      ? `仓库对照表：${mapping.length} 条 / ${new Set(mapping.map(row => row.channel)).size} 个渠道`
      : '仓库对照表为空，请先展开下方导入。';
    const productData = loadProductData();
    const productInfo = root.querySelector('#tfpProductInfo');
    if (productInfo) {
      const stats = productData && productData.stats;
      productInfo.className = productData ? 'summary' : 'summary warn';
      productInfo.textContent = productData
        ? `商品尺寸：${stats.validRows} 条有效 / ${stats.uniqueSkus} 个 SKU；冲突 ${stats.conflictSkus}；无效 ${stats.invalidRows}\n文件：${productData.sourceName || '未记录'}；导入：${productData.importedAt ? new Date(productData.importedAt).toLocaleString() : '未记录'}`
        : '商品尺寸数据为空，请先导入商品表。';
    }
  }

  async function importFile(file) {
    if (!file) return;
    const mapping = /\.xlsx?$/i.test(file.name)
      ? await mappingFromExcel(file)
      : mappingFromCsv(decodeCsv(await file.arrayBuffer()));
    if (!mapping.length) throw new Error('没有读到有效对照关系');
    gmSet(GM_KEYS.mapping, mapping);
    refreshPanelInfo();
    log(`对照表已保存：${mapping.length} 条。`, '#16845b');
  }

  async function importProductFile(file) {
    if (!file) return;
    const productData = await productDataFromFile(file);
    gmSet(GM_KEYS.productData, productData);
    refreshPanelInfo();
    const stats = productData.stats;
    log(`商品表已保存：${stats.validRows} 条有效，${stats.uniqueSkus} 个 SKU；冲突 ${stats.conflictSkus}；无效 ${stats.invalidRows}。`, stats.conflictSkus || stats.invalidRows ? '#a55700' : '#16845b');
  }

  function setRunning(next) {
    running = next;
    root.querySelectorAll('#tfpTask,#tfpGap,#tfpDry,#tfpRun,#tfpFile,#tfpImportText,#tfpClear,#tfpProductFile,#tfpClearProduct').forEach(element => { if (element) element.disabled = next; });
    const stop = root.querySelector('#tfpStop');
    if (stop) stop.disabled = !next;
  }

  function bindPanelEvents() {
    root.querySelector('#tfpMin').addEventListener('click', renderBubble);
    const taskSelect = root.querySelector('#tfpTask');
    if (taskSelect) taskSelect.addEventListener('change', event => {
      gmSet(GM_KEYS.activeTask, event.target.value);
      refreshPanelInfo();
      log(`已切换任务：${activeTask() && activeTask().label || event.target.value}`, '#0878ef');
    });
    root.querySelector('#tfpDry').addEventListener('click', () => run(true));
    root.querySelector('#tfpRun').addEventListener('click', () => run(false));
    root.querySelector('#tfpStop').addEventListener('click', () => { stopRequested = true; log('已请求停止，将在当前单结束后停止。', '#a55700'); });
    const fileInput = root.querySelector('#tfpFile');
    const drop = root.querySelector('#tfpDrop');
    drop.addEventListener('click', () => fileInput.click());
    drop.addEventListener('dragover', event => { event.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', async event => {
      event.preventDefault(); drop.classList.remove('over');
      try { await importFile(event.dataTransfer.files && event.dataTransfer.files[0]); }
      catch (error) { log(`导入失败：${error.message}`, '#b42318'); }
    });
    fileInput.addEventListener('change', async event => {
      try { await importFile(event.target.files && event.target.files[0]); }
      catch (error) { log(`导入失败：${error.message}`, '#b42318'); }
      finally { event.target.value = ''; }
    });
    root.querySelector('#tfpImportText').addEventListener('click', () => {
      try {
        const mapping = mappingFromCsv(root.querySelector('#tfpCsv').value);
        if (!mapping.length) throw new Error('没有读到有效对照关系');
        gmSet(GM_KEYS.mapping, mapping);
        root.querySelector('#tfpCsv').value = '';
        refreshPanelInfo();
        log(`对照表已保存：${mapping.length} 条。`, '#16845b');
      } catch (error) { log(`导入失败：${error.message}`, '#b42318'); }
    });
    root.querySelector('#tfpClear').addEventListener('click', () => {
      if (!window.confirm('确认清空已保存的仓库对照表？')) return;
      gmSet(GM_KEYS.mapping, []);
      refreshPanelInfo();
      log('仓库对照表已清空。', '#a55700');
    });

    const productFileInput = root.querySelector('#tfpProductFile');
    const productDrop = root.querySelector('#tfpProductDrop');
    productDrop.addEventListener('click', () => productFileInput.click());
    productDrop.addEventListener('dragover', event => { event.preventDefault(); productDrop.classList.add('over'); });
    productDrop.addEventListener('dragleave', () => productDrop.classList.remove('over'));
    productDrop.addEventListener('drop', async event => {
      event.preventDefault(); productDrop.classList.remove('over');
      try { await importProductFile(event.dataTransfer.files && event.dataTransfer.files[0]); }
      catch (error) { log(`商品表导入失败：${error.message}`, '#b42318'); }
    });
    productFileInput.addEventListener('change', async event => {
      try { await importProductFile(event.target.files && event.target.files[0]); }
      catch (error) { log(`商品表导入失败：${error.message}`, '#b42318'); }
      finally { event.target.value = ''; }
    });
    root.querySelector('#tfpClearProduct').addEventListener('click', () => {
      if (!window.confirm('确认清空已保存的商品尺寸数据？')) return;
      gmSet(GM_KEYS.productData, null);
      refreshPanelInfo();
      log('商品尺寸数据已清空。', '#a55700');
    });
  }

  async function run(dryRun) {
    if (running) return;
    const task = activeTask();
    if (!task) return log('没有选定 OMS 任务。', '#b42318');
    const mapping = loadMapping();
    if (!mapping.length) return log('仓库对照表为空。', '#b42318');
    const productData = loadProductData();
    if (!productData) return log('商品尺寸数据为空。', '#b42318');

    let units;
    try { units = detectPageUnits(); }
    catch (error) { return log(error.message, '#b42318'); }

    const taskData = taskIndex(task);
    const mapData = mappingIndex(mapping);
    const products = productDataIndex(productData);
    let rows = pageRows();
    if (!rows.length) return log('当前页面没有找到 TEMU 子订单行。', '#b42318');
    const gap = Math.max(0, Number(root.querySelector('#tfpGap').value) || 0);
    root.querySelector('#tfpLog').innerHTML = '';
    stopRequested = false;
    setRunning(true);
    log(`${dryRun ? '预演' : '填充'}开始：任务 ${task.orderCount || task.rows.length} 单，页面 ${rows.length} 行，单位 ${units.weight}/${units.length}。`, '#0878ef');

    let success = 0;
    let missing = 0;
    let conflicts = 0;
    let failed = 0;
    const jobs = [];
    try {
      const splitCandidates = pageSplitCandidates();
      if (splitCandidates.length) {
        if (IS_RESHIP) {
          failed += splitCandidates.length;
          log(`补发货页检测到 ${splitCandidates.map(item => item.po).join('、')} 存在多件包裹；当前页面没有普通在线下单页的“调整包裹”结构，已停止自动拆包和填充。`, '#b42318');
          return;
        }
        if (dryRun) {
          splitCandidates.forEach(candidate => {
            log(`${candidate.po}：检测到 ${candidate.packageCount} 个多件包裹、合计 ${candidate.unitCount} 件；正式执行时先拆为一包一件。`, '#a55700');
          });
        } else {
          try {
            for (const candidate of splitCandidates) {
              if (stopRequested) break;
              log(`${candidate.po}：开始使用平台原生“调整包裹”拆分，一包只保留一件。`, '#0878ef');
              const result = await normalizePoToSingleUnitPackages(candidate.po);
              log(`${candidate.po}：${result.changed ? `已拆为 ${result.units.length} 个单件包裹` : '原生面板复核后无需拆分'}。`, '#16845b');
            }
            const remaining = pageSplitCandidates();
            if (!stopRequested && remaining.length) {
              throw new Error(`仍有 ${remaining.map(item => item.po).join('、')} 存在多件包裹`);
            }
            rows = pageRows();
            log(`拆包阶段完成：页面现有 ${rows.length} 个单件商品行，开始匹配尺寸与仓库。`, '#0878ef');
          } catch (error) {
            failed++;
            log(`自动拆包失败：${error.message}；已停止后续尺寸和仓库填充。`, '#b42318');
            return;
          }
        }
      }

      let taskSplitPlan = taskDrivenSplitPlan(taskData);
      if (taskSplitPlan.excess.length) {
        const details = taskSplitPlan.excess.map(item => `${item.descriptor.po}/${item.descriptor.label}：页面 ${item.actual} 包，OMS ${item.expected} 包`).join('；');
        failed += taskSplitPlan.excess.length;
        log(`包裹数量冲突：${details}。为避免删除或合并现有包裹，已停止后续填充。`, '#b42318');
        return;
      }
      if (taskSplitPlan.split.length) {
        if (IS_RESHIP) {
          failed += taskSplitPlan.split.length;
          log('补发货页的页面包裹数少于 OMS 拆单数；当前页面没有普通在线下单页的“调整包裹”结构，已停止自动拆包和填充。', '#b42318');
          return;
        }
        if (dryRun) {
          taskSplitPlan.split.forEach(candidate => {
            const packageSkus = candidate.taskRows.map((row, index) => `包裹${index + 1} ${row.so || 'SO未知'} / ${row.customSku || '产品SKU为空'}`).join('；');
            log(`${candidate.descriptor.po}/${candidate.descriptor.label}：页面 ${candidate.actual} 包，OMS ${candidate.expected} 包；正式执行时点击“拆分包裹” ${candidate.expected - candidate.actual} 次。${packageSkus}`, '#a55700');
          });
        } else {
          try {
            for (const candidate of taskSplitPlan.split) {
              if (stopRequested) break;
              log(`${candidate.descriptor.po}/${candidate.descriptor.label}：按 OMS ${candidate.expected} 个 SO 拆包，需新增 ${candidate.expected - candidate.actual} 个包裹。`, '#0878ef');
              await splitTaskPackages(candidate);
              log(`${candidate.descriptor.po}/${candidate.descriptor.label}：已拆为 ${candidate.expected} 个包裹，后续按 SO 自然序号匹配产品 SKU。`, '#16845b');
            }
            taskSplitPlan = taskDrivenSplitPlan(taskData);
            if (!stopRequested && (taskSplitPlan.split.length || taskSplitPlan.excess.length)) {
              throw new Error('OMS 包裹数与页面拆包后的包裹行数仍不一致');
            }
            rows = pageRows();
            log(`OMS 拆单对齐完成：页面现有 ${rows.length} 个包裹行，开始按产品 SKU 填写尺寸。`, '#0878ef');
          } catch (error) {
            failed++;
            log(`按 OMS 拆单自动拆包失败：${error.message}；已停止后续尺寸和仓库填充。`, '#b42318');
            return;
          }
        }
      }

      const occurrenceCounts = new Map();
      for (let index = 0; index < rows.length; index++) {
        if (stopRequested) break;
        const tr = rows[index];
        const item = getOrderItem(tr);
        if (!item) { failed++; log(`#${index + 1} 读取不到订单信息。`, '#b42318'); continue; }
        const po = String(item.parentOrderSn || '').trim();
        const channelSku = String(item.extCodeList && item.extCodeList[0] || '').trim();
        const platformSkuId = String(item.skuId || '').trim();
        const sku = channelSku || `平台SKU:${platformSkuId || '空'}`;
        const occurrenceKey = channelSku
          ? `channelSku||${po}||${channelSku}`
          : `platformSkuId||${po}||${platformSkuId}`;
        const matchOccurrence = occurrenceCounts.get(occurrenceKey) || 0;
        occurrenceCounts.set(occurrenceKey, matchOccurrence + 1);
        let matchMode = 'channelSku';
        let erpRow = null;
        if (channelSku) {
          const key = `${po}||${channelSku}`;
          if (taskData.conflicts.has(key)) {
            conflicts++; highlight(tr, '#fff0f0'); log(`#${index + 1} ${po}/${sku}：任务内渠道 SKU 存在冲突，已阻止。`, '#b42318'); continue;
          }
          const taskRows = taskData.groups.get(key);
          erpRow = taskRows && taskRows[matchOccurrence];
        } else {
          matchMode = 'platformSkuId';
          const platformKey = `${po}||${platformSkuId}`;
          if (taskData.platformConflicts.has(platformKey)) {
            conflicts++; highlight(tr, '#fff0f0'); log(`#${index + 1} ${po}/${sku}：任务内平台 SKU ID 存在冲突，已阻止。`, '#b42318'); continue;
          }
          const taskRows = platformSkuId ? taskData.platformGroups.get(platformKey) : null;
          erpRow = taskRows && taskRows[matchOccurrence];
        }
        if (!erpRow) {
          missing++;
          highlight(tr, '#fff7e0');
          const reason = channelSku
            ? '当前任务未匹配渠道 SKU'
            : platformSkuId
              ? '页面未返回渠道 SKU，当前任务也未匹配平台 SKU ID；请用采集器 v2.6 重新建立任务'
              : '页面同时缺少渠道 SKU 和平台 SKU ID';
          log(`#${index + 1} ${po}/${sku}：${reason}，或页面包裹数超过 OMS 拆单数。`, '#a55700');
          continue;
        }
        const mapRow = mapData.get(`${erpRow.channel}||${normalizeErp(erpRow.erpWarehouse)}`);
        if (!mapRow) {
          missing++; highlight(tr, '#fff7e0'); log(`#${index + 1} ${po}：缺少“${erpRow.channel} + ${erpRow.erpWarehouse}”仓库对照。`, '#a55700'); continue;
        }
        const customSku = String(erpRow.customSku || '').trim();
        if (!customSku) {
          missing++; highlight(tr, '#fff7e0'); log(`#${index + 1} ${po}/${sku}：OMS 任务缺少产品 SKU。`, '#a55700'); continue;
        }
        if (products.conflicts.has(customSku)) {
          conflicts++; highlight(tr, '#fff0f0'); log(`#${index + 1} ${po}/${sku}：商品表 SKU“${customSku}”存在不同尺寸数据，已阻止。`, '#b42318'); continue;
        }
        const product = products.unique.get(customSku);
        if (!product) {
          missing++; highlight(tr, '#fff7e0');
          const reason = products.invalidSkus.has(customSku) ? '尺寸数据无效' : '未找到';
          log(`#${index + 1} ${po}/${sku}：商品表 ${reason} SKU“${customSku}”。`, '#a55700');
          continue;
        }
        const measurements = prepareMeasurements(product, units);
        const job = { index, po, sku, channelSku, platformSkuId, matchMode, matchOccurrence, customSku, mapRow, measurements };
        if (dryRun) {
          const dimensionModels = ['重量', '长', '宽', '高'].map(placeholder => getDimensionModel(tr, placeholder));
          if (dimensionModels.some(model => !model)) {
            failed++; highlight(tr, '#fff0f0'); log(`#${index + 1} ${po}/${sku}：找不到页面重量或尺寸表单入口。`, '#b42318'); continue;
          }
          let warehouseModel;
          try {
            warehouseModel = await ensureWarehouseOptions(tr);
            selectWarehouseOption(warehouseModel, mapRow);
          }
          catch (error) {
            failed++; highlight(tr, '#fff0f0'); log(`#${index + 1} ${po}/${sku}：${error.message}`, '#b42318'); continue;
          }
          finally { if (warehouseModel) closeWarehouseDropdown(warehouseModel); }
          success++;
          log(`#${index + 1} ${po}/${sku}：${erpRow.so || 'SO未知'} / ${customSku} → ${measurements.weight}${units.weight}，${measurements.length}×${measurements.width}×${measurements.height}${units.length}；仓库“${mapRow.temuName}”；签名和物流渠道由人工选择。`, '#16845b');
        } else {
          jobs.push(job);
        }
      }

      if (!dryRun) {
        const prepared = [];
        for (const job of jobs) {
          if (stopRequested) break;
          try {
            const warehouse = await fastPrepareRow(job);
            prepared.push(job);
            success++;
            const current = findPageRow(job);
            if (current) highlight(current, '#e9f8f0');
            log(`#${job.index + 1} ${job.po}/${job.sku}：已快速填写 ${job.measurements.weight}${units.weight}，${job.measurements.length}×${job.measurements.width}×${job.measurements.height}${units.length}；仓库“${warehouse.warehouseName}”。`, '#0878ef');
          } catch (error) {
            failed++;
            const current = findPageRow(job);
            if (current) highlight(current, '#fff0f0');
            log(`#${job.index + 1} ${job.po}/${job.sku}：尺寸或仓库填写失败：${error.message}`, '#b42318');
          }
          if (gap) await sleep(gap);
        }
        if (prepared.length) log('尺寸和仓库填写结束；脚本未选择签名或物流渠道，请人工选择后再确认下单。', '#0878ef');
      }
      log(`完成：成功 ${success}；未匹配 ${missing}；冲突 ${conflicts}；失败 ${failed}${stopRequested ? '；已停止' : ''}。未选择签名和物流渠道，未确认下单。`, success ? '#16845b' : '#596579');
    } finally {
      setRunning(false);
    }
  }

  renderBubble();
  if (typeof GM_addValueChangeListener === 'function') {
    GM_addValueChangeListener(GM_KEYS.tasks, () => {
      if (!running && root.querySelector('#__tfp')) renderPanel();
    });
    GM_addValueChangeListener(GM_KEYS.productData, () => {
      if (!running && root.querySelector('#__tfp')) refreshPanelInfo();
    });
  }
  window.addEventListener('resize', () => {
    const bubble = root.querySelector('#__tfpBubble');
    const panel = root.querySelector('#__tfp');
    const target = bubble || panel;
    if (!target) return;
    const rect = target.getBoundingClientRect();
    const position = bubble ? snap(rect.left, rect.top) : clamp(rect.left, rect.top, target.offsetWidth, target.offsetHeight);
    place(target, position);
    savePosition(position);
  });
})();
