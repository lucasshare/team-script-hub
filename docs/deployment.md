# Cloudflare Pages 部署与发布

## GitHub 源码仓库

创建个人私有仓库 `team-script-hub`，显示名称为“团队共享脚本中心”，仅 Lucas 管理；不要邀请协作者。将本项目源码推送至 `main`。本项目的 GitHub Actions 仅验证文件，不会自动发布网站，也不影响其他项目。

## 首次部署

1. 登录 Cloudflare，进入 Workers & Pages，创建 **Pages** 项目并连接 GitHub。不是创建需要付费的服务器。
2. 选择刚才的私有仓库。若尚未授权 GitHub 集成，需要由账号所有者完成授权；权限仅选择这个仓库。
3. 项目名称可选 `team-script-hub`，以控制台最终接受的名称为准。记录实际分配的正式 `pages.dev` 地址。
4. 框架选 None，生产分支为 `main`，构建命令为 `npm run build`，构建输出为 `dist`，根目录保持仓库根。
5. 设置公开构建变量 `SITE_URL` 为第 3 步的实际正式 HTTPS 地址，`NODE_VERSION` 为 `22`。若预览部署也启用，同样设置正式 `SITE_URL`。
6. 部署，等待成功，再逐一打开首页、`scripts.json`、`scripts/install-check.meta.js` 和 `scripts/install-check.user.js`。
7. 核对元信息的两个更新地址都使用正式域名，没有 `127.0.0.1`、占位符或某次预览部署的地址。
8. 用装有油猴的浏览器从首页安装示例，进入 `https://example.com/` 验证运行提示，再在油猴面板主动检查更新。

Cloudflare 授权、正式域名和生产发布必须单独回读记录；没有实际成功结果前，不记作已上线。如果控制台尚不能提供正式域名，可先选定可用的 Pages 项目名，在部署设置中填入对应域名；首次部署后立即核对实际分配结果，不一致则修正变量后重建。

## 日常发布

管理员添加新版本文件并更新清单，先 `npm test`，再检查公开构建输出。获得所需的提交/推送授权后推送 `main`，由 Pages Git 集成触发部署。GitHub 检查与 Pages 构建是独立的任务，发布人应同时确认两者成功。

每次发布后回读实际 `.meta.js` / `.user.js` 的版本和域名，再向团队分发首页链接。更换域名会影响已安装脚本的更新地址，不能只修改新站链接；应保留旧地址并先从旧地址发布指向新域名的升级版。

## 接入真实业务脚本

先逐个核对用途、适用站点、当前可用版本和公开范围。移除密钥、固定店铺资料和调试数据后，保持原脚本名称及命名空间，检查旧安装能否作为同一脚本升级。首版构建只接受当前项目的命名空间；若接入旧脚本，需要明确保留旧身份的方案并扩展校验，不能直接改名导致重复安装。

## 故障恢复

网页故障可通过 Pages 选择已确认可用的旧部署恢复。脚本已升级到员工电脑后，网站回滚不会保证油猴降级；应将可用逻辑发布为更高版本号，重新验证再分发。历史源文件保留在私有 GitHub，公网只保留清单选中的版本。

官方依据：[Pages Git 集成](https://developers.cloudflare.com/pages/configuration/git-integration/)、[构建配置](https://developers.cloudflare.com/pages/configuration/build-configuration/)、[Tampermonkey 元信息](https://www.tampermonkey.net/documentation.php?locale=zh)。
