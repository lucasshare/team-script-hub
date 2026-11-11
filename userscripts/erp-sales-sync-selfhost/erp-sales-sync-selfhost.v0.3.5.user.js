// ==UserScript==
// @name         致远ERP同步到TEMU Copilot自建版
// @namespace    http://192.168.10.17/
// @version      0.3.5
// @author       Lucas
// @description  同步或导出 ERP 销量月报，并补充 SHEIN 负责人到商品运营工作台
// @match        https://product.zhiyuansys.com/SalesMonthly/index*
// @match        https://oms.zhiyuansys.com/SkuMap/index*
// @updateURL    http://192.168.10.17/erp-sales-sync.selfhost.v0.3.5.user.js
// @downloadURL  http://192.168.10.17/erp-sales-sync.selfhost.v0.3.5.user.js
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const APP_ORIGIN = 'http://192.168.10.17';
  const BRIDGE_URL = `${APP_ORIGIN}/link-parser?erpSyncBridge=1`;
  const SCRIPT_VERSION = '0.3.5';
  const SALES_LIST_URL = '/SalesMonthly/list';
  const OWNER_LIST_URL = '/SkuMap/lists';
  const SALES_CONCURRENCY = 2;
  const OWNER_CONCURRENCY = 2;
  const MAX_MONTHS_PER_SYNC = 12;
  const SALES_EXPORT_PAGE_SIZE = 500;
  const SALES_EXPORT_MAX_ROWS = 200000;
  const SALES_CACHE_KEY = `zy-erp-sync-cache:${APP_ORIGIN}:sales`;
  const OWNER_CACHE_KEY = `zy-erp-sync-cache:${APP_ORIGIN}:owner`;
  const SALES_COLUMN_KEYS = [
    '', 'pic', 'spu', 'spu_name', 'type', 'sales', 'orders', 'amazon', 'amazonvc',
    'wayfair', 'overstock', 'shopify', 'walmart', 'homedepot', 'temu', 'shein',
    'tiktok', 'other', 'stock', 'person', 'month',
  ];
  const OWNER_COLUMN_KEYS = [
    'id', 'platform_name', 'way_channel', 'shop_name', 'way_sku', 'insku',
    'brand_str', 'label', 'sku', 'fnsku', 'response_name', 'team_name',
  ];
  const PLATFORM_ALIASES = {
    amazon: 'Amazon',
    amazonvc: 'Amazon VC',
    ebay: 'eBay',
    homedepot: 'HomeDepot',
    overstock: 'OverStock',
    shein: 'Shein',
    shopify: 'Shopify',
    temu: 'TEMU',
    tiktok: 'TikTok',
    walmart: 'Walmart',
    wayfair: 'Wayfair',
    '未知': 'Other',
  };
  const SALES_PLATFORM_KEYS = [
    'sales', 'amazon', 'amazonvc', 'wayfair', 'overstock', 'shopify', 'walmart',
    'homedepot', 'temu', 'shein', 'tiktok', 'other',
  ];

  let bridgeWindow = null;
  let isSyncing = false;
  const PANEL_COLLAPSED_KEY = 'zy-erp-sync-panel:collapsed';

  addPanel();

  function addPanel() {
    if (document.getElementById('zy-erp-sync-panel')) return;
    const mode = currentMode();
    const collapsed = readPanelCollapsed();
    const panel = document.createElement('div');
    panel.id = 'zy-erp-sync-panel';
    panel.className = `${mode === 'sales' ? 'is-sales' : 'is-owner'}${collapsed ? ' is-collapsed' : ''}`;
    panel.innerHTML = `
      <style>
        #zy-erp-sync-panel {
          position: fixed;
          right: 12px;
          bottom: 12px;
          z-index: 99999;
          display: grid;
          grid-template-rows: auto minmax(0, 1fr);
          width: min(360px, calc(100vw - 24px));
          height: min(356px, calc(100vh - 24px));
          box-sizing: border-box;
          overflow: hidden;
          border: 1px solid #d6dce5;
          border-radius: 12px;
          background: #fff;
          box-shadow: 0 14px 36px rgba(15, 23, 42, .22);
          color: #202632;
          font-size: 13px;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          transform-origin: right bottom;
          transition:
            width 260ms cubic-bezier(.2, .8, .2, 1),
            height 260ms cubic-bezier(.2, .8, .2, 1),
            border-radius 260ms cubic-bezier(.2, .8, .2, 1),
            box-shadow 220ms ease;
          will-change: width, height, border-radius;
        }
        #zy-erp-sync-panel.is-owner {
          height: min(268px, calc(100vh - 24px));
        }
        #zy-erp-sync-panel.is-collapsed {
          width: 54px;
          height: 54px;
          border-radius: 999px;
          box-shadow: 0 10px 24px rgba(37, 99, 235, .28);
        }
        #zy-erp-sync-mini {
          position: absolute;
          inset: 0;
          z-index: 2;
          display: grid;
          place-items: center;
          border: 0;
          border-radius: inherit;
          background: #2563eb;
          color: #fff;
          font-weight: 800;
          cursor: pointer;
          opacity: 0;
          visibility: hidden;
          transform: scale(.78);
          transition:
            opacity 150ms ease,
            transform 240ms cubic-bezier(.2, .8, .2, 1),
            visibility 0s linear 240ms;
        }
        #zy-erp-sync-panel.is-collapsed #zy-erp-sync-mini {
          opacity: 1;
          visibility: visible;
          transform: scale(1);
          transition-delay: 100ms, 0s, 0s;
        }
        #zy-erp-sync-panel header,
        #zy-erp-sync-panel main {
          opacity: 1;
          visibility: visible;
          transform: translate(0, 0) scale(1);
          transition:
            opacity 150ms ease 100ms,
            transform 240ms cubic-bezier(.2, .8, .2, 1),
            visibility 0s linear 0s;
        }
        #zy-erp-sync-panel.is-collapsed header,
        #zy-erp-sync-panel.is-collapsed main {
          opacity: 0;
          visibility: hidden;
          pointer-events: none;
          transform: translate(14px, 14px) scale(.96);
          transition-delay: 0s, 0s, 180ms;
        }
        #zy-erp-sync-panel header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 10px 12px;
          border-bottom: 1px solid #edf0f5;
          font-weight: 700;
        }
        #zy-erp-sync-panel .header-actions {
          display: flex;
          gap: 6px;
          min-width: 0;
        }
        #zy-erp-sync-panel main {
          display: grid;
          align-content: start;
          gap: 8px;
          padding: 10px 12px 12px;
          min-width: 0;
          min-height: 0;
          overflow-y: auto;
          overflow-x: hidden;
        }
        #zy-erp-sync-panel .month-grid {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 8px;
        }
        #zy-erp-sync-panel label {
          display: grid;
          gap: 4px;
          min-width: 0;
          color: #475467;
          font-size: 12px;
          font-weight: 700;
        }
        #zy-erp-sync-panel input {
          width: 100%;
          min-width: 0;
          height: 32px;
          box-sizing: border-box;
          border: 1px solid #cfd8e3;
          border-radius: 6px;
          padding: 4px 8px;
          color: #202632;
        }
        #zy-erp-sync-panel .button-row {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 8px;
        }
        #zy-erp-sync-panel .button-row > * {
          min-width: 0;
        }
        #zy-erp-sync-panel .single-row {
          grid-template-columns: 1fr;
        }
        #zy-erp-sync-panel .panel-note {
          border: 1px solid #e6ebf2;
          border-radius: 6px;
          padding: 7px 8px;
          background: #f8fafc;
          color: #667085;
          font-size: 12px;
          line-height: 1.45;
        }
        #zy-erp-sync-panel button {
          min-width: 0;
          height: 34px;
          padding: 0 10px;
          overflow: hidden;
          border: 1px solid #2563eb;
          border-radius: 6px;
          background: #2563eb;
          color: #fff;
          font-weight: 700;
          text-overflow: ellipsis;
          white-space: nowrap;
          cursor: pointer;
        }
        #zy-erp-sync-panel button.secondary {
          border-color: #cfd8e3;
          background: #fff;
          color: #202632;
        }
        #zy-erp-sync-panel button.icon {
          width: 34px;
          padding: 0;
        }
        #zy-erp-sync-panel button:disabled {
          cursor: not-allowed;
          opacity: .62;
        }
        #zy-erp-sync-status {
          min-height: 44px;
          color: #475467;
          line-height: 1.45;
          white-space: pre-wrap;
        }
        @media (max-width: 340px) {
          #zy-erp-sync-panel .month-grid,
          #zy-erp-sync-panel .button-row {
            grid-template-columns: 1fr;
          }
          #zy-erp-sync-panel.is-sales {
            height: min(466px, calc(100vh - 24px));
          }
          #zy-erp-sync-panel.is-owner {
            height: min(314px, calc(100vh - 24px));
          }
        }
        @media (prefers-reduced-motion: reduce) {
          #zy-erp-sync-panel,
          #zy-erp-sync-panel header,
          #zy-erp-sync-panel main,
          #zy-erp-sync-mini {
            transition-duration: 1ms !important;
            transition-delay: 0s !important;
          }
        }
      </style>
      <button type="button" id="zy-erp-sync-mini" title="展开 ERP 同步">ERP</button>
      <header>
        <span>${mode === 'sales' ? '销量同步' : '负责人同步'}</span>
        <div class="header-actions">
          <button type="button" class="secondary icon" id="zy-erp-sync-collapse" title="最小化">－</button>
          <button type="button" class="secondary" id="zy-erp-sync-open" style="width:72px">工作台</button>
        </div>
      </header>
      <main>
        ${mode === 'sales' ? `
          <div class="month-grid">
            <label>
              开始月份
              <input id="zy-erp-sync-start-month" type="text" inputmode="numeric" maxlength="7" placeholder="2025-05" title="填写 YYYY-MM，例如 2025-05 或 2027-01" />
            </label>
            <label>
              结束月份
              <input id="zy-erp-sync-end-month" type="text" inputmode="numeric" maxlength="7" placeholder="2027-01" title="填写 YYYY-MM，例如 2025-05 或 2027-01" />
            </label>
          </div>
          <div class="button-row">
            <button type="button" id="zy-erp-sync-start">同步到网页</button>
            <button type="button" class="secondary" id="zy-erp-sync-export">导出销量表 CSV</button>
          </div>
          <div class="panel-note">月份直接填写 YYYY-MM，例如 2025-05、2027-01。导出的 CSV 是所选月份全量数据，字段为 SKU、月份、国家、平台、销量。</div>
        ` : `
          <button type="button" id="zy-erp-sync-start">同步负责人到网页</button>
          <div class="panel-note">用于补充当前预览批次里的 SHEIN 负责人。</div>
        `}
        <div class="button-row">
          <button type="button" class="secondary" id="zy-erp-sync-retry">重试缓存</button>
          <button type="button" class="secondary" id="zy-erp-sync-download">下载兜底 JSON</button>
        </div>
        <div id="zy-erp-sync-status">已就绪\n版本 ${SCRIPT_VERSION}，并发 ${mode === 'sales' ? SALES_CONCURRENCY : OWNER_CONCURRENCY}</div>
      </main>
    `;
    document.body.appendChild(panel);

    if (mode === 'sales') {
      const startInput = document.getElementById('zy-erp-sync-start-month');
      const endInput = document.getElementById('zy-erp-sync-end-month');
      startInput.value = readDefaultStartMonth();
      endInput.value = readDefaultEndMonth() || startInput.value;
    }
    document.getElementById('zy-erp-sync-start').addEventListener('click', () => {
      if (mode === 'sales') void startSalesSync();
      else void startOwnerSync();
    });
    const exportButton = document.getElementById('zy-erp-sync-export');
    if (exportButton) {
      exportButton.addEventListener('click', () => {
        void startSalesExport();
      });
    }
    document.getElementById('zy-erp-sync-open').addEventListener('click', () => {
      bridgeWindow = window.open(BRIDGE_URL, 'zy_erp_sync_bridge_selfhost_192_168_10_17');
    });
    document.getElementById('zy-erp-sync-mini').addEventListener('click', (event) => {
      if (panel.dataset.suppressMiniClick === 'true') {
        delete panel.dataset.suppressMiniClick;
        event.preventDefault();
        return;
      }
      setPanelCollapsed(panel, false);
    });
    document.getElementById('zy-erp-sync-collapse').addEventListener('click', () => {
      setPanelCollapsed(panel, true);
    });
    document.getElementById('zy-erp-sync-retry').addEventListener('click', () => {
      void retryCachedPayload(mode);
    });
    document.getElementById('zy-erp-sync-download').addEventListener('click', () => {
      downloadCachedPayload(mode);
    });
  }

  function readPanelCollapsed() {
    const saved = window.localStorage.getItem(PANEL_COLLAPSED_KEY);
    return saved === null ? true : saved === 'true';
  }

  function setPanelCollapsed(panel, collapsed) {
    panel.classList.toggle('is-collapsed', collapsed);
    window.localStorage.setItem(PANEL_COLLAPSED_KEY, String(collapsed));
  }

  async function startSalesSync() {
    if (isSyncing) return;
    const months = readMonthsOrReport();
    if (months.length === 0) return;
    isSyncing = true;
    setBusy(true);
    let fallback = null;
    try {
      const collected = await collectSalesPayloads(months);
      fallback = buildSalesFallback(collected.payloads);
      saveCache('sales', fallback);
      setStatus('写入工作台共享缓存');
      const submitResponse = await bridgeRequest('zy-erp-sales-sync:submit-batch', {
        payloads: collected.payloads,
      }, 90000);
      clearCache('sales');
      setStatus(`同步完成\n写入 ${submitResponse.payload?.updatedRows || collected.taskCount} 条`);
    } catch (error) {
      if (fallback) saveCache('sales', fallback);
      setStatus(`同步失败\n${error instanceof Error ? error.message : String(error)}`);
    } finally {
      isSyncing = false;
      setBusy(false);
    }
  }

  async function startSalesExport() {
    if (isSyncing) return;
    const months = readMonthsOrReport();
    if (months.length === 0) return;
    isSyncing = true;
    setBusy(true);
    try {
      const rows = await collectAllSalesExportRows(months);
      downloadSalesReportCsv(rows, buildSalesExportFileName(months));
      setStatus(`导出完成\n生成 ${rows.length} 条全量销量明细，可在工作台“上传销量月报表”使用`);
    } catch (error) {
      setStatus(`导出失败\n${error instanceof Error ? error.message : String(error)}`);
    } finally {
      isSyncing = false;
      setBusy(false);
    }
  }

  function readMonthsOrReport() {
    try {
      const months = readSelectedMonths();
      if (months.length === 0) {
        setStatus('请先选择月份');
        return [];
      }
      return months;
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
      return [];
    }
  }

  async function collectSalesPayloads(months) {
    setStatus('连接工作台页面');
    const targetsResponse = await bridgeRequest('zy-erp-sales-sync:get-targets', {
      month: months[months.length - 1],
    }, 30000);
    const payload = targetsResponse.payload || {};
    const targets = Array.isArray(payload.targets) ? payload.targets : [];
    if (!payload.previewBatchId || targets.length === 0) {
      throw new Error('工作台当前预览没有可同步的 SKU + 站点');
    }

    const rowsByMonth = new Map(months.map((month) => [month, []]));
    const tasks = [];
    months.forEach((month) => {
      targets.forEach((target) => tasks.push({ month, target }));
    });
    let completed = 0;
    await runPool(tasks, SALES_CONCURRENCY, async (task) => {
      const row = await querySalesTarget(task.target, task.month);
      rowsByMonth.get(task.month).push(row);
      completed += 1;
      setStatus(`查询销量 ${completed} / ${tasks.length}\n${task.month} ${task.target.sku} ${task.target.siteCode}`);
    });

    return {
      taskCount: tasks.length,
      payloads: months.map((month) => ({
        previewBatchId: payload.previewBatchId,
        month,
        rows: rowsByMonth.get(month),
      })),
    };
  }

  async function collectAllSalesExportRows(months) {
    const allRows = [];
    for (const month of months) {
      setStatus(`读取 ERP 全量销量\n${month}`);
      const response = await fetchAllSalesRows(month);
      const rows = buildAllSalesReportRows(response.rows, month);
      allRows.push(...rows);
      setStatus(`整理 ERP 全量销量\n${month} ${rows.length} 条`);
    }

    return allRows;
  }

  function buildSalesFallback(payloads) {
    return {
      kind: 'erp-sales-sync',
      version: 3,
      scriptVersion: SCRIPT_VERSION,
      savedAt: new Date().toISOString(),
      payloads,
    };
  }

  function buildSalesExportFileName(months) {
    const range = months.length === 1 ? months[0] : `${months[0]}_${months[months.length - 1]}`;
    return `erp-sales-report-${range}-${Date.now()}.csv`;
  }

  function buildSalesExportRows(payloads) {
    return payloads.flatMap((payload) => {
      const rows = Array.isArray(payload.rows) ? payload.rows : [];
      return rows.map((row) => ({
        previewBatchId: payload.previewBatchId,
        month: payload.month || row.month || '',
        sku: row.sku || '',
        siteCode: row.siteCode || '',
        siteName: row.siteName || '',
        siteSales: row.siteSales || 0,
        platformSalesJson: JSON.stringify(row.platformSales || {}),
        rawJson: JSON.stringify(row.raw || {}),
      }));
    });
  }

  async function startOwnerSync() {
    if (isSyncing) return;
    isSyncing = true;
    setBusy(true);
    let fallback = null;
    try {
      setStatus('连接工作台页面');
      const targetsResponse = await bridgeRequest('zy-erp-owner-sync:get-targets', {}, 30000);
      const payload = targetsResponse.payload || {};
      const targets = Array.isArray(payload.targets) ? payload.targets : [];
      if (!payload.previewBatchId || targets.length === 0) {
        setStatus('负责人表已命中，或没有 SHEIN 缺失项');
        return;
      }

      const rows = [];
      let completed = 0;
      await runPool(targets, OWNER_CONCURRENCY, async (target) => {
        rows.push(await queryOwnerTarget(target));
        completed += 1;
        setStatus(`查询负责人 ${completed} / ${targets.length}\n${target.sku} ${target.siteCode} ${target.brand}`);
      });

      const ownerPayload = {
        previewBatchId: payload.previewBatchId,
        rows,
      };
      fallback = {
        kind: 'erp-owner-sync',
        version: 3,
        scriptVersion: SCRIPT_VERSION,
        savedAt: new Date().toISOString(),
        ownerPayload,
      };
      saveCache('owner', fallback);
      setStatus('写入工作台共享缓存');
      const submitResponse = await bridgeRequest('zy-erp-owner-sync:submit', { ownerPayload }, 90000);
      clearCache('owner');
      setStatus(`同步完成\n写入 ${submitResponse.payload?.updatedRows || rows.length} 条`);
    } catch (error) {
      if (fallback) saveCache('owner', fallback);
      setStatus(`同步失败\n${error instanceof Error ? error.message : String(error)}`);
    } finally {
      isSyncing = false;
      setBusy(false);
    }
  }

  async function retryCachedPayload(mode) {
    if (isSyncing) return;
    const cached = readCache(mode);
    if (!cached) {
      setStatus('没有可重试的缓存');
      return;
    }
    isSyncing = true;
    setBusy(true);
    try {
      setStatus('重试写入工作台');
      if (mode === 'sales') {
        const payloads = Array.isArray(cached.payloads) ? cached.payloads : [];
        if (payloads.length === 0) throw new Error('缓存里没有销量 payload');
        const response = await bridgeRequest('zy-erp-sales-sync:submit-batch', { payloads }, 90000);
        clearCache('sales');
        setStatus(`重试完成\n写入 ${response.payload?.updatedRows || 0} 条`);
      } else {
        const ownerPayload = cached.ownerPayload || cached.payload;
        if (!ownerPayload) throw new Error('缓存里没有负责人 payload');
        const response = await bridgeRequest('zy-erp-owner-sync:submit', { ownerPayload }, 90000);
        clearCache('owner');
        setStatus(`重试完成\n写入 ${response.payload?.updatedRows || 0} 条`);
      }
    } catch (error) {
      setStatus(`重试失败\n${error instanceof Error ? error.message : String(error)}`);
    } finally {
      isSyncing = false;
      setBusy(false);
    }
  }

  async function querySalesTarget(target, month) {
    const response = await fetchSalesRows({
      sku: target.sku,
      month,
      siteCode: target.siteCode,
    });
    const data = response.rows;
    const platformSales = {};
    let siteSales = 0;

    data.filter((row) => Number(row?.is_detail) === 1).forEach((row) => {
      Object.keys(row).forEach((key) => {
        if (!key.endsWith('_arr') || key === 'stock_arr') return;
        toList(row[key]).forEach((item) => {
          if (!item || String(item.site_name || '').toUpperCase() !== target.siteCode) return;
          const platform = normalizeSalesPlatform(item.plat_name || key.replace(/_arr$/u, ''));
          const sales = parseNumber(item.sales);
          if (sales <= 0) return;
          platformSales[platform] = (platformSales[platform] || 0) + sales;
          siteSales += sales;
        });
      });
    });

    if (siteSales === 0) {
      data.filter((row) => Number(row?.is_detail) === 0).forEach((row) => {
        ['amazon', 'amazonvc', 'ebay', 'homedepot', 'overstock', 'shein', 'shopify', 'temu', 'tiktok', 'walmart', 'wayfair', 'other'].forEach((key) => {
          const sales = parseNumber(row[key]);
          if (sales <= 0) return;
          const platform = normalizeSalesPlatform(key);
          platformSales[platform] = (platformSales[platform] || 0) + sales;
          siteSales += sales;
        });
      });
    }

    return {
      sku: target.sku,
      month,
      siteCode: target.siteCode,
      siteName: target.siteName || target.siteCode,
      siteSales,
      platformSales,
      raw: {
        recordsTotal: response.recordsTotal,
        recordsFiltered: response.recordsFiltered,
        salesTotal: response.salesTotal,
        totalArr: response.totalArr,
      },
    };
  }

  function buildAllSalesReportRows(rows, month) {
    const details = [];
    rows.forEach((row) => {
      const sku = readSalesRowSku(row);
      if (!sku) return;
      const rowMonth = normalizeMonth(row.month) || month;
      let hasSiteDetail = false;

      SALES_PLATFORM_KEYS.forEach((key) => {
        toList(row[`${key}_arr`]).forEach((item) => {
          const siteCode = siteCodeFromText(item?.site_name || item?.site || item?.market || item?.market_name);
          const sales = parseNumber(item?.sales);
          if (!siteCode || sales <= 0) return;
          const platform = normalizeSalesPlatform(item?.plat_name || key);
          details.push({
            SKU: sku,
            月份: rowMonth,
            国家: siteCode,
            平台: platform,
            销量: sales,
          });
          hasSiteDetail = true;
        });
      });

      if (!hasSiteDetail) {
        const siteCode = siteCodeFromText(row.site_name || row.site || row.market || row.market_name);
        if (!siteCode) return;
        SALES_PLATFORM_KEYS.forEach((key) => {
          const sales = parseNumber(row[key]);
          if (sales <= 0) return;
          const platform = normalizeSalesPlatform(key);
          details.push({
            SKU: sku,
            月份: rowMonth,
            国家: siteCode,
            平台: platform,
            销量: sales,
          });
        });
      }
    });

    return aggregateSalesReportRows(details);
  }

  function readSalesRowSku(row) {
    return normalizeSku(row?.SKU || row?.sku || row?.spu || row?.insku || row?.way_sku || row?.产品SKU || row?.产品sku);
  }

  function aggregateSalesReportRows(rows) {
    const map = new Map();
    rows.forEach((row) => {
      const sku = normalizeSku(row.SKU);
      const month = normalizeMonth(row.月份);
      const country = siteCodeFromText(row.国家) || String(row.国家 || '').trim().toUpperCase();
      const platform = normalizeSalesPlatform(row.平台);
      const sales = parseNumber(row.销量);
      if (!sku || !month || !country || !platform || sales <= 0) return;
      const key = `${sku}\u0001${month}\u0001${country}\u0001${platform}`;
      const current = map.get(key);
      if (current) {
        current.销量 += sales;
      } else {
        map.set(key, {
          SKU: sku,
          月份: month,
          国家: country,
          平台: platform,
          销量: sales,
        });
      }
    });
    return Array.from(map.values());
  }

  async function queryOwnerTarget(target) {
    const response = await fetchOwnerRows(target);
    const matches = response.rows.filter((row) => {
      const rowSku = normalizeSku(row.insku);
      const rowPlatform = normalizeKey(row.platform_name);
      const rowBrand = normalizeBrand(row.brand_str);
      const rowSite = readSiteCodeFromWayChannel(row.way_channel) || target.siteCode;
      return rowSku === normalizeSku(target.sku)
        && rowPlatform === 'shein'
        && rowBrand === normalizeBrand(target.brand)
        && rowSite === target.siteCode;
    });
    const ownerNames = unique(matches.map((row) => String(row.response_name || '').trim()).filter(Boolean));
    const teamNames = unique(matches.map((row) => String(row.team_name || '').trim()).filter(Boolean));

    return {
      sku: target.sku,
      platform: target.platform || 'SHEIN',
      platformKey: target.platformKey || 'shein',
      brand: target.brand,
      brandKey: target.brandKey || normalizeBrand(target.brand),
      siteCode: target.siteCode,
      siteName: target.siteName || target.siteCode,
      ownerName: ownerNames.join('/'),
      teamName: teamNames.join('/'),
      matchedCount: matches.length,
      raw: {
        recordsTotal: response.recordsTotal,
        recordsFiltered: response.recordsFiltered,
        matches: matches.slice(0, 20).map((row) => ({
          insku: row.insku,
          platform_name: row.platform_name,
          brand_str: row.brand_str,
          way_channel: row.way_channel,
          response_name: row.response_name,
          team_name: row.team_name,
        })),
      },
    };
  }

  async function fetchSalesRows({ sku, month, siteCode }) {
    const length = 200;
    const rows = [];
    let firstResponse = null;
    let start = 0;
    while (rows.length < 5000) {
      const response = await postSalesList({ sku, month, siteCode, start, length });
      if (!firstResponse) firstResponse = response;
      const pageRows = Array.isArray(response.data) ? response.data : [];
      rows.push(...pageRows);
      const total = parseNumber(response.recordsFiltered || response.recordsTotal || pageRows.length);
      if (pageRows.length === 0 || rows.length >= total) break;
      start += pageRows.length;
    }
    return {
      ...(firstResponse || {}),
      rows,
    };
  }

  async function fetchAllSalesRows(month) {
    const rows = [];
    let firstResponse = null;
    let start = 0;
    while (rows.length < SALES_EXPORT_MAX_ROWS) {
      const response = await postSalesList({
        sku: '',
        month,
        siteCode: '',
        start,
        length: SALES_EXPORT_PAGE_SIZE,
      });
      if (!firstResponse) firstResponse = response;
      const pageRows = Array.isArray(response.data) ? response.data : [];
      rows.push(...pageRows);
      const total = parseNumber(response.recordsFiltered || response.recordsTotal || pageRows.length);
      setStatus(`读取 ERP 全量销量\n${month} ${Math.min(rows.length, total)} / ${total || rows.length}`);
      if (total > SALES_EXPORT_MAX_ROWS) {
        throw new Error(`ERP 月报 ${month} 超过 ${SALES_EXPORT_MAX_ROWS} 行，请缩小月份后再导出`);
      }
      if (pageRows.length === 0 || rows.length >= total) break;
      start += pageRows.length;
    }
    return {
      ...(firstResponse || {}),
      rows,
    };
  }

  async function fetchOwnerRows(target) {
    const length = 100;
    const rows = [];
    let firstResponse = null;
    let start = 0;
    while (rows.length < 1000) {
      const response = await postOwnerList({ target, start, length });
      if (!firstResponse) firstResponse = response;
      const pageRows = Array.isArray(response.data) ? response.data : [];
      rows.push(...pageRows);
      const total = parseNumber(response.recordsFiltered || response.recordsTotal || pageRows.length);
      if (pageRows.length === 0 || rows.length >= total) break;
      start += pageRows.length;
    }
    return {
      ...(firstResponse || {}),
      rows,
    };
  }

  function postSalesList({ sku, month, siteCode, start, length }) {
    const params = new URLSearchParams();
    appendDataTablesColumns(params, SALES_COLUMN_KEYS);
    params.append('draw', '1');
    params.append('order[0][column]', '0');
    params.append('order[0][dir]', 'asc');
    params.append('start', String(start));
    params.append('length', String(length));
    params.append('search[value]', '');
    params.append('search[regex]', 'false');
    params.append('sku', sku || '');
    params.append('spu', '');
    params.append('name', '');
    params.append('delver_id', '');
    params.append('operation_id', '');
    params.append('date_start', month);
    params.append('date_end', month);
    params.append('category_id', '');
    params.append('supplier_id', '');
    params.append('date_type', readInputValue('#search_date_type') || '0');
    params.append('show_detail', 'false');
    params.append('search_type', '');
    params.append('search_dev_group', '');
    params.append('search_sale_group', '');
    if (siteCode) params.append('search_site[]', siteCode);
    return postForm(SALES_LIST_URL, params, 'ERP 销量请求失败');
  }

  function postOwnerList({ target, start, length }) {
    const siteMap = readOwnerSiteMap();
    const siteValue = siteMap[target.siteCode];
    if (!siteValue) {
      throw new Error(`ERP 页面找不到站点 ${target.siteCode}`);
    }
    const params = new URLSearchParams();
    appendDataTablesColumns(params, OWNER_COLUMN_KEYS);
    params.append('draw', '1');
    params.append('start', String(start));
    params.append('length', String(length));
    params.append('search[value]', '');
    params.append('search[regex]', 'false');
    params.append('plateForm_id', readSheinPlatformId());
    params.append('store_id', '');
    params.append('way_sku', '');
    params.append('sku', target.sku);
    params.append('fnsku_search', '');
    params.append('search_response_user', '');
    params.append('search_type_id', '');
    params.append('c_string', '');
    params.append('search_company_team', '');
    params.append('sku_asin', '');
    params.append('inventory_update', '');
    params.append('market_id', '');
    params.append('out_type', '');
    params.append('start_date', '');
    params.append('end_date', '');
    params.append('brand_id', '');
    params.append('way_id[]', siteValue);
    return postForm(OWNER_LIST_URL, params, 'ERP 负责人请求失败');
  }

  function postForm(url, params, message) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', url, true);
      xhr.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded; charset=UTF-8');
      xhr.setRequestHeader('X-Requested-With', 'XMLHttpRequest');
      xhr.onreadystatechange = () => {
        if (xhr.readyState !== 4) return;
        if (xhr.status < 200 || xhr.status >= 300) {
          reject(new Error(`${message}：${xhr.status}`));
          return;
        }
        try {
          const parsed = normalizeErpResponse(JSON.parse(xhr.responseText));
          if (!parsed) {
            reject(new Error('ERP 返回数据格式不正确'));
            return;
          }
          resolve(parsed);
        } catch (error) {
          reject(new Error('ERP 登录可能已失效，请重新登录后再同步'));
        }
      };
      xhr.onerror = () => reject(new Error('ERP 网络请求失败'));
      xhr.send(params.toString());
    });
  }

  function normalizeErpResponse(parsed) {
    if (!parsed || typeof parsed !== 'object') return null;
    const data = parsed.data;
    if (Array.isArray(data)) return parsed;
    if (data === false && isEmptyErpResult(parsed)) {
      return {
        ...parsed,
        data: [],
      };
    }
    return null;
  }

  function isEmptyErpResult(parsed) {
    const total = parseNumber(parsed.recordsFiltered || parsed.recordsTotal || 0);
    return total === 0;
  }

  function bridgeRequest(type, payload, timeoutMs) {
    const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    bridgeWindow = bridgeWindow && !bridgeWindow.closed
      ? bridgeWindow
      : window.open(BRIDGE_URL, 'zy_erp_sync_bridge_selfhost_192_168_10_17');
    if (!bridgeWindow) {
      return Promise.reject(new Error('无法打开工作台桥接页面'));
    }

    return new Promise((resolve, reject) => {
      let pollTimer = 0;
      let timeoutTimer = 0;
      const startedAt = Date.now();
      const cleanup = () => {
        window.removeEventListener('message', onMessage);
        window.clearInterval(pollTimer);
        window.clearTimeout(timeoutTimer);
      };
      const onMessage = (event) => {
        if (event.origin !== APP_ORIGIN || event.source !== bridgeWindow) return;
        const data = event.data || {};
        if (data.requestId !== requestId) return;
        cleanup();
        if (data.ok === false || String(data.type || '').endsWith(':error')) {
          reject(new Error(data.message || '工作台同步失败'));
          return;
        }
        resolve(data);
      };
      const send = () => {
        if (Date.now() - startedAt > timeoutMs) {
          cleanup();
          reject(new Error('等待工作台页面响应超时'));
          return;
        }
        bridgeWindow.postMessage({ type, requestId, ...payload }, APP_ORIGIN);
      };
      window.addEventListener('message', onMessage);
      if (type.includes(':submit')) {
        timeoutTimer = window.setTimeout(() => {
          cleanup();
          reject(new Error('等待工作台页面响应超时'));
        }, timeoutMs);
      } else {
        pollTimer = window.setInterval(send, 500);
      }
      send();
    });
  }

  async function runPool(items, limit, worker) {
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const current = next;
        next += 1;
        await worker(items[current], current);
      }
    }));
  }

  function appendDataTablesColumns(params, keys) {
    keys.forEach((data, index) => {
      params.append(`columns[${index}][data]`, data);
      params.append(`columns[${index}][name]`, '');
      params.append(`columns[${index}][searchable]`, 'true');
      params.append(`columns[${index}][orderable]`, 'false');
      params.append(`columns[${index}][search][value]`, '');
      params.append(`columns[${index}][search][regex]`, 'false');
    });
  }

  function readSelectedMonths() {
    const start = normalizeMonth(readInputValue('#zy-erp-sync-start-month'));
    const end = normalizeMonth(readInputValue('#zy-erp-sync-end-month')) || start;
    if (!start || !end) return [];
    const months = enumerateMonths(start <= end ? start : end, start <= end ? end : start);
    if (months.length > MAX_MONTHS_PER_SYNC) {
      throw new Error(`一次最多同步 ${MAX_MONTHS_PER_SYNC} 个月`);
    }
    return months;
  }

  function enumerateMonths(start, end) {
    const result = [];
    const [startYear, startMonth] = start.split('-').map(Number);
    const [endYear, endMonth] = end.split('-').map(Number);
    let year = startYear;
    let month = startMonth;
    while (year < endYear || (year === endYear && month <= endMonth)) {
      result.push(`${year}-${String(month).padStart(2, '0')}`);
      month += 1;
      if (month > 12) {
        month = 1;
        year += 1;
      }
    }
    return result;
  }

  function readDefaultStartMonth() {
    return currentMonth();
  }

  function readDefaultEndMonth() {
    return currentMonth();
  }

  function readOwnerSiteMap() {
    const map = {};
    Array.from(document.querySelectorAll('#site_id option')).forEach((option) => {
      const code = siteCodeFromText(option.textContent || option.value);
      if (code && option.value) map[code] = option.value;
    });
    return map;
  }

  function readSheinPlatformId() {
    const option = Array.from(document.querySelectorAll('#plateForm_id option'))
      .find((item) => normalizeKey(item.textContent) === 'shein');
    return option ? option.value : '';
  }

  function siteCodeFromText(text) {
    const upper = String(text || '').trim().toUpperCase();
    const direct = upper.match(/\b(US|CA|DE|FR|GB|UK|IT|ES|NL|PL|SE|AT|BE|PT|CZ|SK|IE|RO|HU|LU|AU|JP|SA|AE)\b/u);
    if (direct) return direct[1] === 'UK' ? 'GB' : direct[1];
    const map = {
      美国: 'US',
      加拿大: 'CA',
      德国: 'DE',
      法国: 'FR',
      英国: 'GB',
      意大利: 'IT',
      西班牙: 'ES',
      澳大利亚: 'AU',
      澳洲: 'AU',
      日本: 'JP',
      沙特: 'SA',
      阿联酋: 'AE',
    };
    for (const [label, code] of Object.entries(map)) {
      if (String(text || '').includes(label)) return code;
    }
    return '';
  }

  function readSiteCodeFromWayChannel(value) {
    const match = String(value || '').trim().toUpperCase().match(/^([A-Z]{2})(?:-|$)/u);
    if (!match) return '';
    return match[1] === 'UK' ? 'GB' : match[1];
  }

  function currentMode() {
    if (location.host === 'oms.zhiyuansys.com') return 'owner';
    return 'sales';
  }

  function readInputValue(selector) {
    const element = document.querySelector(selector);
    return element && 'value' in element ? String(element.value || '') : '';
  }

  function currentMonth() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  }

  function normalizeMonth(value) {
    const match = String(value || '').trim().match(/^(\d{4})[-/](\d{1,2})/u);
    return match ? `${match[1]}-${match[2].padStart(2, '0')}` : '';
  }

  function parseNumber(value) {
    const parsed = Number(String(value ?? '').replace(/,/gu, '').trim());
    return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
  }

  function normalizeSalesPlatform(value) {
    const key = normalizeKey(value);
    return PLATFORM_ALIASES[key] || String(value || '').trim() || 'Other';
  }

  function normalizeKey(value) {
    return String(value || '').trim().toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/gu, '');
  }

  function normalizeBrand(value) {
    return normalizeKey(value);
  }

  function normalizeSku(value) {
    return String(value || '').trim().toUpperCase();
  }

  function unique(values) {
    return Array.from(new Set(values)).sort((left, right) => left.localeCompare(right, 'zh-CN'));
  }

  function toList(value) {
    if (Array.isArray(value)) return value;
    if (value && typeof value === 'object') return Object.values(value);
    return [];
  }

  function cacheKey(mode) {
    return mode === 'sales' ? SALES_CACHE_KEY : OWNER_CACHE_KEY;
  }

  function saveCache(mode, value) {
    window.localStorage.setItem(cacheKey(mode), JSON.stringify(value));
  }

  function readCache(mode) {
    try {
      const raw = window.localStorage.getItem(cacheKey(mode));
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  function clearCache(mode) {
    window.localStorage.removeItem(cacheKey(mode));
  }

  function downloadCachedPayload(mode) {
    const cached = readCache(mode);
    if (!cached) {
      setStatus('没有可下载的缓存');
      return;
    }
    downloadJsonPayload(cached, `${mode === 'sales' ? 'erp-sales-sync' : 'erp-owner-sync'}-${Date.now()}.json`);
    setStatus('兜底 JSON 已下载');
  }

  function downloadJsonPayload(payload, fileName) {
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  function downloadCsvPayload(rows, fileName) {
    const headers = ['previewBatchId', 'month', 'sku', 'siteCode', 'siteName', 'siteSales', 'platformSalesJson', 'rawJson'];
    const lines = [
      headers.join(','),
      ...rows.map((row) => headers.map((header) => csvEscape(row[header])).join(',')),
    ];
    const blob = new Blob([`\uFEFF${lines.join('\r\n')}`], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  function downloadSalesReportCsv(rows, fileName) {
    const headers = ['SKU', '月份', '国家', '平台', '销量'];
    const lines = [
      headers.join(','),
      ...rows.map((row) => headers.map((header) => csvEscape(row[header])).join(',')),
    ];
    const blob = new Blob([`\uFEFF${lines.join('\r\n')}`], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  function csvEscape(value) {
    const text = String(value ?? '');
    if (!/[",\r\n]/u.test(text)) return text;
    return `"${text.replace(/"/gu, '""')}"`;
  }

  function setStatus(message) {
    const status = document.getElementById('zy-erp-sync-status');
    if (status) status.textContent = message;
  }

  function setBusy(value) {
    ['zy-erp-sync-start', 'zy-erp-sync-export', 'zy-erp-sync-retry', 'zy-erp-sync-download'].forEach((id) => {
      const button = document.getElementById(id);
      if (button) button.disabled = value;
    });
  }
})();
