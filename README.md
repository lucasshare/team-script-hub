# 团队共享脚本中心

团队共享的油猴脚本库。打开本页查看用途，点击“安装脚本”，在 Tampermonkey 页面确认安装。无需单独的网站或 GitHub 登录。

当前收录 **10 个业务脚本**，均为已确认共享的最新版；另提供安装验证示例。由 Lucas 统一维护，后续更新使用固定地址。

## 配套参考表

[下载全部 5 份参考表 ZIP](https://raw.githubusercontent.com/lucasshare/team-script-hub/main/templates/reference-samples.zip) · [按脚本查看模板与填写说明](templates/README.md)

只提供已共享脚本对应的参考表，文件和填写说明放在各自的脚本目录下，ZIP 也按脚本分文件夹。每张表只保留表头和前 5 条数据，供查看格式和填法。使用前请替换为自己的完整业务数据，不能把精简样例直接当作完整配置表。CSV 若打开为文本，可下载 ZIP。

## 先安装油猴

从 [Tampermonkey 官网](https://www.tampermonkey.net/)选择浏览器并安装扩展。如果安装链接只显示代码，请确认油猴已启用，或复制该链接到油猴管理面板“实用工具”的 URL 安装入口。

## OMS / TEMU 面单工作流

以下 **6 个脚本需分别安装**。按“库存查询 → 订单采集 → 填仓 → 下载面单 → 按需删除旧面单 → 上传新面单”配套使用。库存查询和采集器使用同一浏览器配置；先核对本批任务，再进入后续步骤。签名、物流渠道和最终下单仍由人工处理。

| 平台 | 脚本名称 | 用途 | 使用注意 | 当前版本 | 安装链接 | 配套模板 |
| --- | --- | --- | --- | --- | --- | --- |
| OMS | OMS ERP 共享库存按仓库明细查询 | 按自定义 SKU 查询各仓库存，依据仓库优先级和库存阈值生成推荐仓库。 | 面单第 1 步。先导入仓库优先级 CSV；与采集器使用同一浏览器配置。 | v1.1.0 | [安装脚本](https://raw.githubusercontent.com/lucasshare/team-script-hub/main/scripts/oms-erp-shared-inventory-by-warehouse.user.js) | [美发加仓库挑选顺序.csv](https://raw.githubusercontent.com/lucasshare/team-script-hub/main/userscripts/oms-erp-shared-inventory-by-warehouse/templates/%E7%BE%8E%E5%8F%91%E5%8A%A0%E4%BB%93%E5%BA%93%E6%8C%91%E9%80%89%E9%A1%BA%E5%BA%8F.csv)<br>[模板与填写说明](userscripts/oms-erp-shared-inventory-by-warehouse/README.md) |
| OMS | 致远ERP 订单采集器 | 采集当前订单、填充面板中的空仓库，并把选中订单设为本批 TEMU 任务。 | 面单第 2 步。核对订单和仓库后建立本批任务；数据变化后重新建立。 | v2.8 | [安装脚本](https://raw.githubusercontent.com/lucasshare/team-script-hub/main/scripts/zhiyuan-erp-order-collector.user.js) | 复用库存查询映射，无独立表格模板 |
| OMS、TEMU | Temu 仓库自动填充 | 接收 OMS 批次，查询对应订单，并在普通下单或补发货页面填写尺寸与仓库。 | 面单第 3 步。需商品尺寸表；签名、渠道和最终下单由人工处理。 | v3.20 | [安装脚本](https://raw.githubusercontent.com/lucasshare/team-script-hub/main/scripts/temu-warehouse-auto-fill.user.js) | [仓库对照表.csv](https://raw.githubusercontent.com/lucasshare/team-script-hub/main/userscripts/temu-warehouse-auto-fill/templates/%E4%BB%93%E5%BA%93%E5%AF%B9%E7%85%A7%E8%A1%A8.csv)<br>[商品尺寸数据表.xlsx](https://raw.githubusercontent.com/lucasshare/team-script-hub/main/userscripts/temu-warehouse-auto-fill/templates/%E5%95%86%E5%93%81%E5%B0%BA%E5%AF%B8%E6%95%B0%E6%8D%AE%E8%A1%A8.xlsx)<br>[模板与填写说明](userscripts/temu-warehouse-auto-fill/README.md) |
| OMS、TEMU | Temu 面单批量下载 | 接收当前 OMS 批次，按所选店铺下载普通或补寄物流面单。 | 面单第 4 步。先建立本批任务；普通与补寄面单使用各自页面。 | v1.5.6 | [安装脚本](https://raw.githubusercontent.com/lucasshare/team-script-hub/main/scripts/temu-waybill-batch-download.user.js) | [skuid_sku货号映射.csv](https://raw.githubusercontent.com/lucasshare/team-script-hub/main/userscripts/temu-waybill-batch-download/templates/skuid_sku%E8%B4%A7%E5%8F%B7%E6%98%A0%E5%B0%84.csv)<br>[模板与填写说明](userscripts/temu-waybill-batch-download/README.md) |
| OMS | OMS ERP面单一键批量删除 | 预览订单关联附件，按明确选择逐项删除并回读结果。 | 面单第 5 步。仅在确需替换旧面单时使用；先核对附件预览。 | v1.8 | [安装脚本](https://raw.githubusercontent.com/lucasshare/team-script-hub/main/scripts/oms-erp-waybill-bulk-delete.user.js) | 无需表格模板 |
| OMS | ZhiyuanSys ERP · 订单附件批量自动上传 | 按平台订单号、渠道 SKU 和跟踪号精确匹配本地 PDF，批量上传订单面单。 | 面单第 6 步。先核对 PDF 文件名和预扫匹配，再执行上传。 | v0.2.6 | [安装脚本](https://raw.githubusercontent.com/lucasshare/team-script-hub/main/scripts/zhiyuansys-erp-order-attachment-upload.user.js) | 使用面单 PDF，无表格模板 |

仓库优先级 CSV、商品尺寸表及 SKU 映射表按实际业务准备，详见 [配套使用说明](docs/shared-scripts.md)。

## 其他共享工具

| 平台 | 脚本名称 | 用途 | 使用注意 | 当前版本 | 安装链接 | 配套模板 |
| --- | --- | --- | --- | --- | --- | --- |
| TEMU | Temu 调价单一键拒绝助手 | 按当前账号选择的店铺批量拒绝待卖家确认的调价单。 | 先选择店铺并核对待确认调价单，再执行拒绝。 | v0.1.1 | [安装脚本](https://raw.githubusercontent.com/lucasshare/team-script-hub/main/scripts/temu-price-adjust-reject.user.js) | 无需表格模板 |
| 致远 BI | 致远BI TEMU利润率价格导出 | 保留 BI 售价参考页的全部字段，并按所选利润率范围导出价格表。 | 需登录 BI 并有报表权限；先设置利润率范围。 | v0.1.1 | [安装脚本](https://raw.githubusercontent.com/lucasshare/team-script-hub/main/scripts/bi-temu-profit-price-export.user.js) | 无需表格模板 |
| 产品中心、OMS、商品运营工作台 | 致远ERP同步到TEMU Copilot自建版 | 同步或导出 ERP 销量月报，并向自建工作台补充 SHEIN 负责人。 | 需能访问原自建工作台；本项为自建版。 | v0.3.5 | [安装脚本](https://raw.githubusercontent.com/lucasshare/team-script-hub/main/scripts/erp-sales-sync-selfhost.user.js) | 无需表格模板 |
| TEMU | Temu 活动采集与精确退出 | 采集活动列表、邀约、报名明细，并按 CSV 精确核对或退出指定活动。 | 先选择店铺、活动和站点；精确退出默认试跑。 | v0.1.23 | [安装脚本](https://raw.githubusercontent.com/lucasshare/team-script-hub/main/scripts/temu-marketing-invite-detail-export.user.js) | [批量退活动.csv](https://raw.githubusercontent.com/lucasshare/team-script-hub/main/userscripts/temu-marketing-invite-detail-export/templates/%E6%89%B9%E9%87%8F%E9%80%80%E6%B4%BB%E5%8A%A8.csv)<br>[模板与填写说明](userscripts/temu-marketing-invite-detail-export/README.md) |

## 安装验证

| 平台 | 脚本名称 | 用途 | 使用注意 | 当前版本 | 安装链接 | 配套模板 |
| --- | --- | --- | --- | --- | --- | --- |
| 通用 | 团队脚本安装验证 | 第一次使用时，确认油猴已经安装并允许脚本运行。 | 安装后打开 example.com，查看运行成功提示。 | v1.0.0 | [安装脚本](https://raw.githubusercontent.com/lucasshare/team-script-hub/main/scripts/install-check.user.js) | 无需表格模板 |

## 安装与更新

- 每个脚本独立安装，名称和命名空间沿用原脚本，权限及业务逻辑保持原样。
- 已安装同版本旧脚本时，从本页手动安装一次以采用共享更新地址；后续由油猴按设置检查更高版本。更新不是实时强制推送。
- 在对应平台登录并具有业务权限后使用。ERP 同步自建版还需要能访问原有工作台服务。
- 这里提供已确认的脚本文件和说明。发布检查不等于已在每位同事的账号或 Windows 环境完成业务运行验收。

## 管理与发布

源码原文件在 `userscripts/`，发布清单在 `catalog.json`；本页目录、`scripts/` 中的安装/更新文件和 `scripts.json` 由工具生成。

```sh
npm test
npm run build
npm run check
```

新增或升级时保留旧版源文件，更新清单，运行检查，再提交和推送。不要直接修改生成的脚本文件或首页表格。详细规则见 [AGENTS.md](AGENTS.md) 和 [分发说明](docs/deployment.md)。历史网页草案仅留存，不作为使用入口，也不构建或部署独立网站。
