// ==UserScript==
// @name         ZhiyuanSys ERP · 订单附件批量自动上传
// @namespace    https://lucas.local/
// @version      0.2.6
// @description  精确恢复用户保存位置，并按平台订单号、渠道 SKU、跟踪号精确匹配及批量上传物流面单
// @author       Lucas
// @match        https://oms.zhiyuansys.com/Order/index*
// @grant        none
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/lucasshare/team-script-hub/main/scripts/zhiyuansys-erp-order-attachment-upload.meta.js
// @downloadURL  https://raw.githubusercontent.com/lucasshare/team-script-hub/main/scripts/zhiyuansys-erp-order-attachment-upload.user.js
// ==/UserScript==

(function () {
  "use strict";

  const CFG = {
    poRegex: /PO-\d{2,4}-\d{10,}/,
    systemOrderRegex: /\bSO\d+(?:_\d+)?\b/,
    trackingRegex: /^[A-Z0-9][A-Z0-9-]{7,}$/i,
    attachType: "201",
    attachTypeLabel: "物流面单",
    waitGap: 260,
    panelId: "__erp_auto_panel",
    posKey: "__erp_auto_panel_pos_v2",
    bubblePosKey: "__erp_auto_bubble_pos_v1",
  };

  const state = {
    filePool: [],
    dirHandle: null,
    running: false,
    stopRequested: false,
    report: [],
    plan: [],
  };

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const log = (...args) => console.log("%c[面单上传]", "color:#10b981;font-weight:bold", ...args);
  const warn = (...args) => console.warn("%c[面单上传]", "color:#f59e0b;font-weight:bold", ...args);
  const error = (...args) => console.error("%c[面单上传]", "color:#ef4444;font-weight:bold", ...args);

  function $(selector, root = document) {
    return root.querySelector(selector);
  }

  function $all(selector, root = document) {
    return Array.from(root.querySelectorAll(selector));
  }

  function normalizeText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function normalizeKey(value) {
    return normalizeText(value).toUpperCase();
  }

  function csvCell(value) {
    const text = value == null ? "" : String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }

  function safeFileBase(name) {
    return String(name || "").replace(/\.[^.]+$/, "");
  }

  function parsePdfFile(file) {
    const base = safeFileBase(file.name);
    const parts = base.split("_").map((item) => item.trim()).filter(Boolean);
    if (parts.length < 3) {
      return {
        file,
        fileName: file.name,
        valid: false,
        reason: "文件名不是 平台订单号_跟踪号_sku渠道SKU.pdf 格式",
      };
    }

    const platformOrder = parts.find((item) => CFG.poRegex.test(item)) || parts[0];
    const trackingNo = parts.find((item, index) => index > 0 && CFG.trackingRegex.test(item)) || parts[1];
    let channelSku = parts.slice(2).join("_");
    channelSku = channelSku.replace(/^sku/i, "");

    const valid = CFG.poRegex.test(platformOrder) && trackingNo && channelSku;
    return {
      file,
      fileName: file.name,
      valid,
      reason: valid ? "" : "文件名缺平台订单号、跟踪号或渠道 SKU",
      platformOrder,
      platformKey: normalizeKey(platformOrder),
      trackingNo,
      trackingKey: normalizeKey(trackingNo),
      channelSku,
      skuKey: normalizeKey(channelSku),
    };
  }

  function updatePoolHint() {
    const hint = $("#__erp_auto_hint");
    if (!hint) return;
    if (state.filePool.length) {
      hint.textContent = `${state.filePool.length} PDF`;
      hint.style.color = "#34c759";
      return;
    }
    if (state.dirHandle) {
      hint.textContent = state.dirHandle.name;
      hint.style.color = "#34c759";
      return;
    }
    hint.textContent = "未导入";
    hint.style.color = "#8e8e93";
  }

  function setFilePool(files, sourceLabel) {
    state.filePool = files.filter((file) => file && /\.pdf$/i.test(file.name));
    state.dirHandle = null;
    updatePoolHint();
    addLog(`已导入 ${state.filePool.length} 个 PDF（${sourceLabel}）`, "ok");
  }

  async function pickMultipleFiles() {
    if (window.showOpenFilePicker) {
      try {
        const handles = await window.showOpenFilePicker({
          id: "zhiyuansys-erp-waybill-api-files",
          multiple: true,
          startIn: "downloads",
          types: [{ description: "PDF", accept: { "application/pdf": [".pdf"] } }],
        });
        const files = await Promise.all(handles.map((handle) => handle.getFile()));
        setFilePool(files, "多选文件");
        return;
      } catch (err) {
        if (err && err.name === "AbortError") return;
        warn("showOpenFilePicker 失败，回退到 input", err);
      }
    }

    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".pdf,application/pdf";
    input.multiple = true;
    input.onchange = () => setFilePool(Array.from(input.files || []), "input 多选");
    input.click();
  }

  async function pickDownloadsDir() {
    if (!window.showDirectoryPicker) {
      alert("当前浏览器不支持选择文件夹，请使用 Chrome / Edge / Arc，或改用“选多个 PDF”。");
      return;
    }
    try {
      state.dirHandle = await window.showDirectoryPicker({
        id: "zhiyuansys-erp-waybill-api-dir",
        mode: "read",
        startIn: "downloads",
      });
      state.filePool = [];
      updatePoolHint();
      addLog(`已授权文件夹：${state.dirHandle.name}`, "ok");
    } catch (err) {
      if (err && err.name === "AbortError") return;
      alert("目录授权失败。可以改用“选多个 PDF”或拖拽 PDF 到面板。");
      throw err;
    }
  }

  async function collectFilesFromDirHandle(dirHandle) {
    const files = [];
    async function walk(handle) {
      for await (const entry of handle.values()) {
        if (entry.kind === "file") {
          const file = await entry.getFile();
          if (/\.pdf$/i.test(file.name)) files.push(file);
        } else if (entry.kind === "directory") {
          await walk(entry);
        }
      }
    }
    await walk(dirHandle);
    return files;
  }

  async function getAllPdfFiles() {
    if (state.filePool.length) return state.filePool;
    if (state.dirHandle) return collectFilesFromDirHandle(state.dirHandle);
    throw new Error("请先导入 PDF：选多个 PDF、选文件夹，或拖拽 PDF 到面板。");
  }

  function bindDropZone(el) {
    el.addEventListener("dragover", (event) => {
      event.preventDefault();
      el.classList.add("erp-api-drop-active");
    });
    el.addEventListener("dragleave", () => {
      el.classList.remove("erp-api-drop-active");
    });
    el.addEventListener("drop", async (event) => {
      event.preventDefault();
      el.classList.remove("erp-api-drop-active");
      const files = [];
      const items = event.dataTransfer?.items ? Array.from(event.dataTransfer.items) : [];

      async function walkEntry(entry) {
        if (!entry) return;
        if (entry.isFile) {
          await new Promise((resolve) => entry.file((file) => {
            files.push(file);
            resolve();
          }, resolve));
          return;
        }
        if (entry.isDirectory) {
          const reader = entry.createReader();
          let batch = [];
          do {
            batch = await new Promise((resolve) => reader.readEntries(resolve, () => resolve([])));
            for (const sub of batch) await walkEntry(sub);
          } while (batch.length);
        }
      }

      for (const item of items) {
        const entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : null;
        if (entry) await walkEntry(entry);
        else {
          const file = item.getAsFile && item.getAsFile();
          if (file) files.push(file);
        }
      }
      if (!files.length && event.dataTransfer?.files) {
        files.push(...Array.from(event.dataTransfer.files));
      }
      setFilePool(files, "拖拽");
    });
  }

  function parseOrderFromDataItem(item) {
    const info = item.info || {};
    const detail = Array.isArray(item.detail) ? item.detail[0] : null;
    const logistic = item.logistic || {};
    const shipInfo = Array.isArray(logistic.shipInfo) ? logistic.shipInfo[0] : null;
    return {
      orderId: String(info.id || detail?.order_id || ""),
      systemOrder: normalizeText(info.label || ""),
      platformOrder: normalizeText(info.src_oid || ""),
      platformKey: normalizeKey(info.src_oid || ""),
      channelSku: normalizeText(detail?.sellsku || detail?.label || ""),
      skuKey: normalizeKey(detail?.sellsku || detail?.label || ""),
      currentTracking: normalizeText(shipInfo?.track_no || ""),
      rowSource: "datatable",
    };
  }

  function collectRowsFromDataTable(onlyChecked) {
    if (!window.jQuery || !window.jQuery.fn?.DataTable) return [];
    const table = window.jQuery("#example1");
    if (!table.length) return [];
    let dt;
    try {
      dt = table.DataTable();
    } catch (_) {
      return [];
    }
    if (!dt) return [];

    const selectedIds = new Set();
    if (onlyChecked) {
      $all("tr").forEach((tr) => {
        const checked = $("input[type='checkbox']", tr)?.checked;
        if (!checked) return;
        const onclick = $("a[onclick*='attach_file'],button[onclick*='doEdit']", tr)?.getAttribute("onclick") || "";
        const id = onclick.match(/\((\d+)/)?.[1];
        if (id) selectedIds.add(String(id));
      });
    }

    const out = [];
    const rows = dt.rows({ search: "applied", page: "current" }).data().toArray();
    for (const item of rows) {
      const parsed = parseOrderFromDataItem(item);
      if (!parsed.orderId || !parsed.systemOrder || !parsed.platformOrder || !parsed.channelSku) continue;
      if (onlyChecked && !selectedIds.has(parsed.orderId)) continue;
      out.push(parsed);
    }
    return out;
  }

  function extractOrderIdFromRow(tr) {
    const candidates = $all("[onclick]", tr)
      .map((el) => el.getAttribute("onclick") || "")
      .join("\n");
    return candidates.match(/attach_file\((\d+),/)?.[1]
      || candidates.match(/doEdit\((\d+)\)/)?.[1]
      || "";
  }

  function collectRowsFromDom(onlyChecked) {
    const rows = [];
    for (const tr of $all("tr")) {
      const text = normalizeText(tr.innerText || "");
      if (!CFG.poRegex.test(text)) continue;
      if (onlyChecked) {
        const checkbox = $("input[type='checkbox']", tr);
        if (!checkbox || !checkbox.checked) continue;
      }
      const systemOrder = text.match(CFG.systemOrderRegex)?.[0] || "";
      const platformOrder = text.match(CFG.poRegex)?.[0] || "";
      const orderId = extractOrderIdFromRow(tr);
      const channelSku = inferChannelSkuFromRowText(text);
      if (!systemOrder || !platformOrder || !orderId || !channelSku) continue;
      rows.push({
        orderId,
        systemOrder,
        platformOrder,
        platformKey: normalizeKey(platformOrder),
        channelSku,
        skuKey: normalizeKey(channelSku),
        currentTracking: text.match(/跟踪号：\s*([^\s]+)/)?.[1] || "",
        rowSource: "dom",
      });
    }
    return rows;
  }

  function inferChannelSkuFromRowText(text) {
    const afterPo = text.split(CFG.poRegex)[1] || text;
    const matches = afterPo.match(/\b[A-Z][A-Z0-9]+-[A-Z0-9-]+\b/g) || [];
    const skus = matches.filter((item) => !/^PO-/i.test(item) && !/^SO/i.test(item) && !/^TEMU-/i.test(item));
    if (!skus.length) return "";
    return skus[0];
  }

  function collectOrderRows(onlyChecked) {
    const fromTable = collectRowsFromDataTable(onlyChecked);
    const rows = fromTable.length ? fromTable : collectRowsFromDom(onlyChecked);
    const seen = new Set();
    return rows.filter((row) => {
      const key = row.orderId || row.systemOrder;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function groupKey(platformKey, skuKey) {
    return `${platformKey}@@${skuKey}`;
  }

  function buildPdfGroups(parsedFiles) {
    const groups = new Map();
    const invalidFiles = [];
    const duplicateTrackRows = [];

    for (const item of parsedFiles) {
      if (!item.valid) {
        invalidFiles.push(item);
        continue;
      }
      const key = groupKey(item.platformKey, item.skuKey);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    }

    for (const [key, items] of groups) {
      const byTrack = new Map();
      const uniqueItems = [];
      for (const item of items) {
        if (byTrack.has(item.trackingKey)) {
          duplicateTrackRows.push({
            platformOrder: item.platformOrder,
            channelSku: item.channelSku,
            trackingNo: item.trackingNo,
            file: item.fileName,
            duplicateOf: byTrack.get(item.trackingKey).fileName,
          });
          continue;
        }
        byTrack.set(item.trackingKey, item);
        uniqueItems.push(item);
      }
      uniqueItems.sort((a, b) => a.fileName.localeCompare(b.fileName, "zh-Hans-CN"));
      groups.set(key, uniqueItems);
    }

    return { groups, invalidFiles, duplicateTrackRows };
  }

  function buildUploadPlan(rows, parsedFiles) {
    const { groups, invalidFiles, duplicateTrackRows } = buildPdfGroups(parsedFiles);
    const rowGroups = new Map();
    const plan = [];

    for (const row of rows) {
      const key = groupKey(row.platformKey, row.skuKey);
      if (!rowGroups.has(key)) rowGroups.set(key, []);
      rowGroups.get(key).push(row);
    }

    for (const [key, groupRows] of rowGroups) {
      const pdfs = groups.get(key) || [];
      const sortedRows = [...groupRows].sort((a, b) => a.systemOrder.localeCompare(b.systemOrder, "zh-Hans-CN"));
      for (let index = 0; index < sortedRows.length; index += 1) {
        const row = sortedRows[index];
        const pdf = pdfs[index] || null;
        if (!pdf) {
          plan.push({
            ...row,
            status: "skip_no_pdf",
            reason: "没有可用 PDF，或同 PO + SKU 的不同跟踪号数量不足",
          });
          continue;
        }
        plan.push({
          ...row,
          status: "ready",
          reason: "",
          file: pdf.file,
          fileName: pdf.fileName,
          trackingNo: pdf.trackingNo,
        });
      }
      if (pdfs.length > sortedRows.length) {
        for (const pdf of pdfs.slice(sortedRows.length)) {
          plan.push({
            orderId: "",
            systemOrder: "",
            platformOrder: pdf.platformOrder,
            channelSku: pdf.channelSku,
            trackingNo: pdf.trackingNo,
            fileName: pdf.fileName,
            status: "unused_pdf",
            reason: "PDF 数量多于 ERP 系统订单数",
          });
        }
      }
    }

    for (const invalid of invalidFiles) {
      plan.push({
        orderId: "",
        systemOrder: "",
        platformOrder: invalid.platformOrder || "",
        channelSku: invalid.channelSku || "",
        trackingNo: invalid.trackingNo || "",
        fileName: invalid.fileName,
        status: "invalid_pdf",
        reason: invalid.reason,
      });
    }

    for (const duplicate of duplicateTrackRows) {
      plan.push({
        orderId: "",
        systemOrder: "",
        platformOrder: duplicate.platformOrder,
        channelSku: duplicate.channelSku,
        trackingNo: duplicate.trackingNo,
        fileName: duplicate.file,
        status: "duplicate_tracking_pdf",
        reason: `同 PO + SKU 下跟踪号重复，已保留 ${duplicate.duplicateOf}`,
      });
    }

    return plan;
  }

  function summarizePlan(plan) {
    const counts = {};
    for (const item of plan) counts[item.status] = (counts[item.status] || 0) + 1;
    return counts;
  }

  function statusText(status) {
    return {
      ready: "待上传",
      uploaded: "已上传",
      skipped_existing: "已存在跳过",
      skip_no_pdf: "缺 PDF",
      unused_pdf: "多余 PDF",
      invalid_pdf: "无效文件名",
      duplicate_tracking_pdf: "跟踪号重复",
      upload_failed: "上传失败",
      stopped: "已停止",
    }[status] || status;
  }

  async function apiPostForm(path, data) {
    const response = await fetch(path, {
      method: "POST",
      body: data,
      credentials: "same-origin",
      headers: { "x-requested-with": "XMLHttpRequest" },
    });
    const text = await response.text();
    let json;
    try {
      json = text ? JSON.parse(text) : {};
    } catch (_) {
      throw new Error(`接口返回不是 JSON: ${text.slice(0, 160)}`);
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 160)}`);
    return json;
  }

  async function apiPostUrlencoded(path, params) {
    const response = await fetch(path, {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "x-requested-with": "XMLHttpRequest",
        "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
      },
      body: new URLSearchParams(params),
    });
    const text = await response.text();
    let json;
    try {
      json = text ? JSON.parse(text) : {};
    } catch (_) {
      throw new Error(`接口返回不是 JSON: ${text.slice(0, 160)}`);
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 160)}`);
    return json;
  }

  async function getFileLists(orderId) {
    const json = await apiPostUrlencoded("/Order/getFileLists", { id: orderId });
    if (json.code !== 400) throw new Error(json.message || "获取附件列表失败");
    return Array.isArray(json.data) ? json.data : [];
  }

  function hasSameAttachment(list, fileName) {
    return list.some((item) => normalizeKey(item.srcname || "") === normalizeKey(fileName));
  }

  async function uploadAttachment(task) {
    const form = new FormData();
    form.append("file", task.file);
    form.append("id", task.orderId);
    form.append("file_attach_type", CFG.attachType);
    const json = await apiPostForm("/Order/saveFile", form);
    if (json.code !== 400) throw new Error(json.message || "上传失败");
    return json;
  }

  function addLog(message, type = "info") {
    const box = $("#__erp_auto_log");
    if (!box) {
      log(message);
      return;
    }
    const line = document.createElement("div");
    line.className = `erp-api-log-line erp-api-log-${type}`;
    line.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
    box.prepend(line);
    while (box.children.length > 100) box.lastElementChild.remove();
    if (type === "fail") error(message);
    else if (type === "warn") warn(message);
    else log(message);
  }

  function setProgress(done, total, label) {
    const bar = $("#__erp_auto_progress_bar");
    const text = $("#__erp_auto_progress_text");
    if (!bar || !text) return;
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    bar.style.width = `${Math.max(0, Math.min(100, pct))}%`;
    text.textContent = `${label || "进度"}：${done}/${total} (${pct}%)`;
  }

  function downloadReportCsv(report) {
    const header = [
      "system_order",
      "order_id",
      "platform_order",
      "channel_sku",
      "tracking_no",
      "file",
      "status",
      "message",
    ];
    const lines = [header.join(",")];
    for (const row of report) {
      lines.push(header.map((key) => csvCell(row[key])).join(","));
    }
    const blob = new Blob(["\ufeff" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `erp-waybill-upload-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    addLog(`已发起报告下载：${a.download}`, "info");
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  function planToReportRow(item, status, message = "") {
    return {
      system_order: item.systemOrder || "",
      order_id: item.orderId || "",
      platform_order: item.platformOrder || "",
      channel_sku: item.channelSku || "",
      tracking_no: item.trackingNo || "",
      file: item.fileName || "",
      status,
      message,
    };
  }

  async function preparePlan(onlyChecked) {
    const rows = collectOrderRows(onlyChecked);
    if (!rows.length) throw new Error(onlyChecked ? "没有识别到勾选订单行" : "当前页没有识别到订单行");

    const files = await getAllPdfFiles();
    const parsedFiles = files.map(parsePdfFile);
    const plan = buildUploadPlan(rows, parsedFiles);
    state.plan = plan;

    const counts = summarizePlan(plan);
    const ready = counts.ready || 0;
    const msg = [
      `识别 ERP 系统订单：${rows.length}`,
      `识别 PDF：${files.length}`,
      `可上传：${ready}`,
      `缺 PDF：${counts.skip_no_pdf || 0}`,
      `多余 PDF：${counts.unused_pdf || 0}`,
      `无效文件名：${counts.invalid_pdf || 0}`,
      `跟踪号重复：${counts.duplicate_tracking_pdf || 0}`,
      "",
      "确认后会直接调用 /Order/saveFile 上传物流面单附件。",
    ].join("\n");

    console.table(plan.map((item) => ({
      系统订单号: item.systemOrder,
      内部ID: item.orderId,
      平台订单号: item.platformOrder,
      渠道SKU: item.channelSku,
      跟踪号: item.trackingNo,
      文件: item.fileName,
      状态: statusText(item.status),
      原因: item.reason,
    })));
    addLog(`预扫完成：可上传 ${ready}，缺 PDF ${counts.skip_no_pdf || 0}，异常 ${((counts.invalid_pdf || 0) + (counts.duplicate_tracking_pdf || 0))}`, "info");

    if (!ready) {
      downloadReportCsv(plan.map((item) => planToReportRow(item, statusText(item.status), item.reason)));
      throw new Error("没有可上传任务，已导出预扫报告。");
    }
    return confirm(msg) ? plan : null;
  }

  async function runAll(onlyChecked) {
    if (state.running) {
      alert("正在上传中，请先停止或等待完成。");
      return;
    }
    state.running = true;
    state.stopRequested = false;
    state.report = [];
    setProgress(0, 0, "预扫");

    try {
      const plan = await preparePlan(onlyChecked);
      if (!plan) {
        addLog("用户取消上传", "warn");
        return;
      }

      const readyTasks = plan.filter((item) => item.status === "ready");
      for (const item of plan.filter((task) => task.status !== "ready")) {
        state.report.push(planToReportRow(item, statusText(item.status), item.reason));
      }

      let done = 0;
      setProgress(done, readyTasks.length, "上传");
      for (const task of readyTasks) {
        if (state.stopRequested) {
          state.report.push(planToReportRow(task, "已停止", "用户点击停止"));
          addLog(`已停止，剩余任务未上传：${task.systemOrder}`, "warn");
          continue;
        }

        try {
          addLog(`上传 ${task.systemOrder} / ${task.platformOrder} / ${task.channelSku} / ${task.trackingNo}`, "info");
          const list = await getFileLists(task.orderId);
          if (hasSameAttachment(list, task.fileName)) {
            state.report.push(planToReportRow(task, "已存在跳过", "订单附件里已有同名文件"));
            addLog(`跳过已存在：${task.systemOrder} ${task.fileName}`, "warn");
          } else {
            const result = await uploadAttachment(task);
            state.report.push(planToReportRow(task, "已上传", result.message || "上传成功"));
            addLog(`上传成功：${task.systemOrder} ${task.fileName}`, "ok");
          }
        } catch (err) {
          state.report.push(planToReportRow(task, "上传失败", err.message || String(err)));
          addLog(`上传失败：${task.systemOrder} ${err.message || err}`, "fail");
        }

        done += 1;
        setProgress(done, readyTasks.length, "上传");
        await sleep(CFG.waitGap);
      }

      downloadReportCsv(state.report);
      addLog("处理完成，报告 CSV 已下载", "ok");
    } catch (err) {
      addLog(err.message || String(err), "fail");
      alert(err.message || String(err));
    } finally {
      state.running = false;
      state.stopRequested = false;
    }
  }

  function stopRun() {
    if (!state.running) {
      addLog("当前没有运行中的上传任务", "warn");
      return;
    }
    state.stopRequested = true;
    addLog("收到停止指令，当前请求结束后停止", "warn");
  }

  function mountStyle() {
    if ($("#__erp_auto_api_style")) return;
    const style = document.createElement("style");
    style.id = "__erp_auto_api_style";
    style.textContent = `
      #${CFG.panelId}{
        position:fixed;right:14px;bottom:14px;z-index:999999;width:220px;max-height:min(520px,calc(100vh - 16px));
        background:#fff;color:#1d1d1f;border:1px solid #dde2ea;
        border-radius:14px;box-shadow:0 14px 36px rgba(20,34,58,.16);
        font:12px/1.38 -apple-system,BlinkMacSystemFont,"SF Pro","PingFang SC",sans-serif;
        overflow:hidden;
      }
      #${CFG.panelId} *{box-sizing:border-box}
      #${CFG.panelId}.min{width:44px;height:44px;border-radius:50%;background:#303640;border-color:rgba(255,255,255,.9);box-shadow:0 6px 18px rgba(15,23,42,.24),inset 0 0 0 1px rgba(255,255,255,.12);color:#fff}
      #${CFG.panelId}.min::after{content:'';position:absolute;right:2px;bottom:3px;width:7px;height:7px;border:2px solid #303640;border-radius:50%;background:#06b6d4}
      #${CFG.panelId}.min .erp-api-body{display:none}
      #${CFG.panelId}.min .erp-api-head{width:44px;height:44px;padding:0;justify-content:center;border:0}
      #${CFG.panelId}.min .erp-api-title-full,#${CFG.panelId}.min .erp-api-hint,#${CFG.panelId}.min .erp-api-min{display:none}
      #${CFG.panelId} .erp-api-title-mini{display:none}
      #${CFG.panelId}.min .erp-api-title-mini{display:inline}
      #${CFG.panelId} .erp-api-head{display:flex;align-items:center;gap:5px;padding:6px 7px 6px 9px;cursor:move;user-select:none;background:#f7f8fa;border-bottom:1px solid #e9edf3}
      #${CFG.panelId} .erp-api-title{font-weight:700}
      #${CFG.panelId} .erp-api-min{width:26px;height:26px;padding:0;border:0;background:transparent;color:#697386}
      #${CFG.panelId} .erp-api-hint{margin-left:auto;font-size:10px;color:#8e8e93;max-width:66px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      #${CFG.panelId} .erp-api-body{padding:6px 7px;display:grid;gap:5px;max-height:474px;overflow:auto}
      #${CFG.panelId} .erp-api-grid{display:grid;grid-template-columns:1fr 1fr;gap:5px}
      #${CFG.panelId} button{border:1px solid rgba(60,60,67,.14);border-radius:7px;padding:5px 4px;cursor:pointer;font:inherit;font-weight:650;min-height:26px;white-space:nowrap;background:rgba(255,255,255,.72);color:#1d1d1f}
      #${CFG.panelId} button:hover{background:rgba(255,255,255,.95)}
      #${CFG.panelId} .erp-api-blue{background:rgba(0,122,255,.10);color:#0066cc;border-color:rgba(0,122,255,.18)}
      #${CFG.panelId} .erp-api-green{background:rgba(52,199,89,.10);color:#1f7a3a;border-color:rgba(52,199,89,.18)}
      #${CFG.panelId} .erp-api-gray{background:rgba(242,242,247,.82);color:#1d1d1f}
      #${CFG.panelId} .erp-api-red{background:rgba(255,59,48,.08);color:#c5281c;border-color:rgba(255,59,48,.16)}
      #${CFG.panelId} .erp-api-drop{padding:6px;border:1px dashed rgba(60,60,67,.24);border-radius:7px;text-align:center;color:#6e6e73;font-size:11px;background:rgba(255,255,255,.45)}
      #${CFG.panelId} .erp-api-drop-active{outline:2px solid rgba(0,122,255,.28);background:rgba(0,122,255,.06)}
      #${CFG.panelId} .erp-api-progress{height:6px;border-radius:999px;background:rgba(120,120,128,.20);overflow:hidden}
      #${CFG.panelId} .erp-api-progress span{display:block;height:100%;width:0;background:#8e8e93;transition:width .18s ease}
      #${CFG.panelId} .erp-api-progress-text{font-size:11px;color:#6e6e73}
      #${CFG.panelId} .erp-api-log{max-height:72px;overflow:auto;border-top:1px solid rgba(60,60,67,.12);padding-top:5px}
      #${CFG.panelId} .erp-api-log-line{font-size:11px;margin-bottom:3px;color:#3a3a3c;word-break:break-all}
      #${CFG.panelId} .erp-api-log-ok{color:#248a3d}
      #${CFG.panelId} .erp-api-log-warn{color:#a15c00}
      #${CFG.panelId} .erp-api-log-fail{color:#d70015}
    `;
    document.head.appendChild(style);
  }

  function clampPanel(panel) {
    const rect = panel.getBoundingClientRect();
    let left = rect.left;
    let top = rect.top;
    if (panel.style.right !== "auto") {
      left = window.innerWidth - rect.width - 16;
      top = window.innerHeight - rect.height - 16;
    }
    left = Math.max(4, Math.min(window.innerWidth - rect.width - 4, left));
    top = Math.max(4, Math.min(window.innerHeight - rect.height - 4, top));
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
    panel.style.right = "auto";
    panel.style.bottom = "auto";
  }

  function readPanelPosition(key) {
    try {
      const saved = JSON.parse(localStorage.getItem(key) || "null");
      if (!saved || !Number.isFinite(saved.left) || !Number.isFinite(saved.top)) return null;
      return { left: saved.left, top: saved.top };
    } catch (_) {
      return null;
    }
  }

  function restorePanelPosition(panel, key) {
    const saved = readPanelPosition(key);
    if (!saved) return false;
    panel.style.left = `${saved.left}px`;
    panel.style.top = `${saved.top}px`;
    panel.style.right = "auto";
    panel.style.bottom = "auto";
    return true;
  }

  function savePanelPosition(panel, key) {
    const rect = panel.getBoundingClientRect();
    localStorage.setItem(key, JSON.stringify({ left: rect.left, top: rect.top }));
  }

  function avoidDeletePanel(panel) {
    if (panel.classList.contains("min")) return;
    const other = document.querySelector("#__bdPanel");
    if (!other) return;
    const panelRect = panel.getBoundingClientRect();
    const otherRect = other.getBoundingClientRect();
    const overlaps = (left, top) => !(
      left + panelRect.width + 6 <= otherRect.left
      || left >= otherRect.right + 6
      || top + panelRect.height + 6 <= otherRect.top
      || top >= otherRect.bottom + 6
    );
    if (!overlaps(panelRect.left, panelRect.top)) return;
    const candidates = [
      { left: otherRect.right + 8, top: otherRect.top },
      { left: otherRect.left - panelRect.width - 8, top: otherRect.top },
      { left: otherRect.left, top: otherRect.top - panelRect.height - 8 },
      { left: otherRect.left, top: otherRect.bottom + 8 },
    ];
    const target = candidates.find(item => (
      item.left >= 4 && item.top >= 4
      && item.left + panelRect.width <= window.innerWidth - 4
      && item.top + panelRect.height <= window.innerHeight - 4
      && !overlaps(item.left, item.top)
    ));
    if (!target) return;
    panel.style.left = `${target.left}px`;
    panel.style.top = `${target.top}px`;
    localStorage.setItem(CFG.posKey, JSON.stringify(target));
  }

  function snapPanel(panel) {
    if (!panel.classList.contains("min")) return clampPanel(panel);
    const rect = panel.getBoundingClientRect();
    const size = 44;
    let left = Math.max(8, Math.min(window.innerWidth - size - 8, rect.left));
    let top = Math.max(8, Math.min(window.innerHeight - size - 8, rect.top));
    const nearest = [["left", left], ["right", window.innerWidth - left - size], ["top", top], ["bottom", window.innerHeight - top - size]].sort((a, b) => a[1] - b[1])[0][0];
    if (nearest === "left") left = 8;
    if (nearest === "right") left = window.innerWidth - size - 8;
    if (nearest === "top") top = 8;
    if (nearest === "bottom") top = window.innerHeight - size - 8;
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
    panel.style.right = "auto";
    panel.style.bottom = "auto";
    localStorage.setItem(CFG.bubblePosKey, JSON.stringify({ left, top }));
  }

  function makeDraggable(panel) {
    const handle = $(".erp-api-head", panel);

    let dragging = false;
    let moved = false;
    let sx = 0;
    let sy = 0;
    let sl = 0;
    let st = 0;
    handle.addEventListener("mousedown", (event) => {
      if (event.button !== 0 || event.target.closest("button")) return;
      const rect = panel.getBoundingClientRect();
      dragging = true;
      moved = false;
      sx = event.clientX;
      sy = event.clientY;
      sl = rect.left;
      st = rect.top;
      panel.style.left = `${rect.left}px`;
      panel.style.top = `${rect.top}px`;
      panel.style.right = "auto";
      panel.style.bottom = "auto";
      event.preventDefault();
    });
    document.addEventListener("mousemove", (event) => {
      if (!dragging) return;
      if (Math.hypot(event.clientX - sx, event.clientY - sy) > 5) moved = true;
      const width = panel.offsetWidth;
      const height = panel.offsetHeight;
      const left = Math.max(4, Math.min(window.innerWidth - width - 4, sl + event.clientX - sx));
      const top = Math.max(4, Math.min(window.innerHeight - height - 4, st + event.clientY - sy));
      panel.style.left = `${left}px`;
      panel.style.top = `${top}px`;
    });
    document.addEventListener("mouseup", () => {
      if (!dragging) return;
      dragging = false;
      if (panel.classList.contains("min")) {
        snapPanel(panel);
        savePanelPosition(panel, CFG.bubblePosKey);
      } else {
        clampPanel(panel);
        savePanelPosition(panel, CFG.posKey);
      }
      if (moved) panel.dataset.justDragged = "1";
      setTimeout(() => { panel.dataset.justDragged = ""; }, 120);
    });
    window.addEventListener("resize", () => {
      if (panel.classList.contains("min")) {
        snapPanel(panel);
        savePanelPosition(panel, CFG.bubblePosKey);
      } else {
        clampPanel(panel);
        savePanelPosition(panel, CFG.posKey);
      }
    });
  }

  function mountUI() {
    if ($(`#${CFG.panelId}`)) return;
    mountStyle();
    const panel = document.createElement("div");
    panel.id = CFG.panelId;
    panel.innerHTML = `
      <div class="erp-api-head">
        <span class="erp-api-title"><span class="erp-api-title-full">面单上传</span><span class="erp-api-title-mini">上传</span></span>
        <span id="__erp_auto_hint" class="erp-api-hint">未导入</span>
        <button class="erp-api-min" type="button" title="收起">−</button>
      </div>
      <div class="erp-api-body">
        <div class="erp-api-grid">
          <button id="__erp_auto_files" class="erp-api-blue" type="button">选PDF</button>
          <button id="__erp_auto_pick" class="erp-api-gray" type="button">选目录</button>
          <button id="__erp_auto_run" class="erp-api-green" type="button">当前页</button>
          <button id="__erp_auto_runs" class="erp-api-green" type="button">勾选</button>
        </div>
        <div id="__erp_auto_drop" class="erp-api-drop">拖拽 PDF / 文件夹</div>
        <button id="__erp_auto_stop" class="erp-api-red" type="button">停止</button>
        <div class="erp-api-progress"><span id="__erp_auto_progress_bar"></span></div>
        <div id="__erp_auto_progress_text" class="erp-api-progress-text">进度：0/0 (0%)</div>
        <div id="__erp_auto_log" class="erp-api-log"></div>
      </div>
    `;
    document.body.appendChild(panel);
    const minButton = $(".erp-api-min", panel);
    minButton.addEventListener("click", () => {
      panel.classList.add("min");
      setTimeout(() => {
        restorePanelPosition(panel, CFG.bubblePosKey);
        snapPanel(panel);
      }, 0);
    });
    $(".erp-api-head", panel).addEventListener("click", (event) => {
      if (!panel.classList.contains("min") || event.target.closest("button") || panel.dataset.justDragged === "1") return;
      panel.classList.remove("min");
      setTimeout(() => {
        restorePanelPosition(panel, CFG.posKey);
        clampPanel(panel);
        savePanelPosition(panel, CFG.posKey);
      }, 0);
    });

    $("#__erp_auto_files", panel).addEventListener("click", () => pickMultipleFiles().catch((err) => addLog(err.message || String(err), "fail")));
    $("#__erp_auto_pick", panel).addEventListener("click", () => pickDownloadsDir().catch((err) => addLog(err.message || String(err), "fail")));
    $("#__erp_auto_run", panel).addEventListener("click", () => runAll(false).catch((err) => addLog(err.message || String(err), "fail")));
    $("#__erp_auto_runs", panel).addEventListener("click", () => runAll(true).catch((err) => addLog(err.message || String(err), "fail")));
    $("#__erp_auto_stop", panel).addEventListener("click", stopRun);
    bindDropZone($("#__erp_auto_drop", panel));
    const restoredExpandedPosition = restorePanelPosition(panel, CFG.posKey);
    makeDraggable(panel);
    setTimeout(() => {
      clampPanel(panel);
      if (!restoredExpandedPosition) avoidDeletePanel(panel);
      savePanelPosition(panel, CFG.posKey);
    }, 0);
    updatePoolHint();
    addLog("面单上传已就绪。先导入 PDF，再上传当前页或仅勾选。", "ok");
  }

  const timer = setInterval(() => {
    if (!document.body) return;
    clearInterval(timer);
    mountUI();
  }, 300);
})();
