// ==UserScript==
// @name         Temu 面单批量下载
// @namespace    temu-waybill-batch
// @version      1.5.6
// @description  接收 OMS 本批任务，按当前账号动态店铺范围查询并下载普通或补寄面单，支持三站协作和 CSV 货号映射
// @author       Lucas
// @match        https://oms.zhiyuansys.com/Order/index*
// @match        https://agentseller.temu.com/mmsos/waybill.html*
// @match        https://agentseller-us.temu.com/mmsos/waybill.html*
// @match        https://agentseller-eu.temu.com/mmsos/waybill.html*
// @match        https://agentseller.temu.com/mmsos/reship-list.html*
// @match        https://agentseller-us.temu.com/mmsos/reship-list.html*
// @match        https://agentseller-eu.temu.com/mmsos/reship-list.html*
// @run-at       document-idle
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addValueChangeListener
// @grant        unsafeWindow
// @noframes
// @updateURL    https://raw.githubusercontent.com/lucasshare/team-script-hub/main/scripts/temu-waybill-batch-download.meta.js
// @downloadURL  https://raw.githubusercontent.com/lucasshare/team-script-hub/main/scripts/temu-waybill-batch-download.user.js
// ==/UserScript==
