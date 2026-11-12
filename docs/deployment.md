# GitHub 分发与更新

团队入口为 [team-script-hub 仓库首页](https://github.com/lucasshare/team-script-hub)。这个仓库用于公开分发；2026-11-12 用户允许增加 GitHub Pages 下载辅助页以保留中文文件名，不部署 Cloudflare Pages 或另建团队门户；原业务开发源码仓库不改变可见性。

## 文件关系

- `catalog.json`：管理员维护的共享清单，精确选择源文件与版本，并记录原身份、使用说明和 SHA-256。
- `userscripts/`：按原字节保存选定版本的源文件，保留历史版本用于回退。
- `scripts/`：生成的稳定分发文件，每项含 `.user.js` 和仅有元信息的 `.meta.js`。
- `README.md`：从同一清单生成的首页表格，列出平台、名称、用途、注意、版本、安装链接及配套模板。
- `scripts.json`：由同一清单生成的机器可读目录，不含本地路径或源文件指纹。
- `userscripts/<ID>/templates/`：该脚本对应的精简参考表，填写说明在同一脚本目录的 README。当前共 5 份（4 CSV、1 Excel），每张表最多 5 条记录；通过 templateIds 关联已核对版本的输入表。
- `templates/`：按脚本分组的索引、ZIP 合集和指纹清单；不存放其他未关联表格。模板文件随 Git 提交，不属于脚本构建输出的 24 个文件。

安装及更新地址固定为 `https://raw.githubusercontent.com/lucasshare/team-script-hub/main/scripts/<ID>.user.js` 和对应的 `.meta.js`。不使用私有仓库的临时签名链接，不改变每个脚本的原名称、命名空间、权限或业务正文。

## 发布步骤

1. 核对所选脚本的用途、版本、共享范围与内容，排除凭据、运行存储和未授权业务导出。参考表只允许用户明确批准的前 5 条精简样例，原完整文件不能上传。
2. 将原源文件保存到带版本号的目录文件，保留旧版；更新清单及 SHA-256。
3. 运行 `npm test`、`npm run build`、`npm run check`，检查生成的首页及分发文件。
4. 核对暂存范围并用中文提交，按用户授权推送 `main`。生成的 `scripts/`、`scripts.json` 和 README 必须一同提交。
5. 回读公开可见性、远端提交及首页；逐项匿名读取安装/更新文件，确认版本、身份和更新地址与清单一致，并检查 GitHub 自动检查结果。

无需 `SITE_URL`、Cloudflare 账号、独立网站或服务器。仓库内保留的旧网页草案不作为入口，也不参与发布输出。

## 已安装脚本

接入共享中心时维持原版本号。已有同版本旧安装需要从首页手动安装一次，才能采用新的更新地址；以后发布更高 `@version`，油猴按用户更新设置检查。出现故障时，将可用逻辑发布为更高版本的修复版，不能假定降低版本号会让所有客户端回退。

面单六步配套关系和当前共享清单见 [已接入脚本](shared-scripts.md)。当前分发检查与同事真实运行验收分别记录。

## 参考表更新

原业务文件保持只读；Excel 从表头和保留的记录重新生成，公式按保存的结果值导出，不复制完整工作簿的缓存、隐藏数据和外链。CSV 使用 UTF-8 BOM。只选择已共享脚本实际使用的表格，放到该脚本的 templates 子目录并更新同目录 README。同步更新 templates/manifest.json 的文件 SHA-256、工作表与行数、适用脚本版本，并重建按脚本分目录的 ZIP。不要手动删掉指纹检查以绕过不一致。

运行测试、构建和一致性检查后，核对独立样例与 ZIP 完全一致、每张表只有表头加最多 5 条记录。推送后匿名下载样例及 ZIP，与本地逐字节比较；数据完整性或真实业务运行不能由这些精简样例证明。

## 首页模板直接下载与中文名

首页链接使用 `https://lucasshare.github.io/team-script-hub/?id=<模板ID>`，ZIP 使用 `id=all-templates`。中文原文件仍在对应脚本的 templates 目录；下载页和实际文件同源打包。页面先核对 SHA-256，再用 Blob 和原中文 downloadName 发起保存。浏览器阻止自动下载时可点击页面中的按钮，不能假定页面能知道文件是否已保存到用户电脑。

`downloads/index.html` 是页面源码，`tools/build-downloads.mjs` 从 templates/manifest.json 构建 `dist/downloads`。运行 `npm run build` 会同时生成脚本分发和下载包；`npm run build:downloads` 只构建后者。包内只有 8 个文件：页面、.nojekyll、5 份模板、1 份 ZIP；不发布其他表格、源脚本或业务数据。

GitHub Pages 从 gh-pages 分支根目录发布，main 保留源码与原脚本目录，两个分支独立历史。更新时先在独立工作树同步当前下载包到 gh-pages 并推送；通过 GitHub Pages API 确认部署提交、核对 8 个部署文件及 7 个可访问资源的字节，并检查浏览器下载命名后，再推送 main 的首页入口。无需新增 workflow 授权或 Cloudflare 账号。旧 template-samples Release 保留作历史资料，当前首页不再链接其英文附件。
