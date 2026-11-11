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
// @updateURL    https://raw.githubusercontent.com/lucasshare/team-script-hub/main/scripts/temu-warehouse-auto-fill.meta.js
// @downloadURL  https://raw.githubusercontent.com/lucasshare/team-script-hub/main/scripts/temu-warehouse-auto-fill.user.js
// ==/UserScript==
