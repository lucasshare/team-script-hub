// ==UserScript==
// @name         团队脚本安装验证
// @namespace    https://github.com/lucasshare/team-script-hub
// @version      1.0.0
// @description  在 example.com 验证油猴安装与运行，不执行业务操作。
// @author       Lucas
// @match        https://example.com/*
// @grant        none
// @run-at       document-idle
// @homepageURL  https://github.com/lucasshare/team-script-hub/
// @updateURL    https://raw.githubusercontent.com/lucasshare/team-script-hub/main/scripts/install-check.meta.js
// @downloadURL  https://raw.githubusercontent.com/lucasshare/team-script-hub/main/scripts/install-check.user.js
// ==/UserScript==

(() => {
  'use strict';
  if (document.getElementById('team-script-install-check')) return;
  const notice = document.createElement('aside');
  notice.id = 'team-script-install-check';
  notice.setAttribute('role', 'status');
  notice.style.cssText = 'padding:16px;margin:16px;border:1px solid #b6dcca;border-radius:12px;background:#f1fbf5;color:#175c38;font:14px/1.6 system-ui,sans-serif;';
  const message = document.createElement('span');
  message.textContent = '团队脚本运行正常 · v1.0.0。这是安装验证示例。';
  const close = document.createElement('button');
  close.textContent = '关闭提示';
  close.type = 'button';
  close.style.cssText = 'margin-left:12px;padding:4px 10px;border:1px solid #93bca4;border-radius:6px;background:white;color:#175c38;cursor:pointer;';
  close.addEventListener('click', () => notice.remove());
  notice.append(message, close);
  document.body.prepend(notice);
})();
