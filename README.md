# 团队共享脚本中心

为同事提供跨平台的油猴脚本共享入口，支持平台筛选、用途分类、搜索、安装和使用说明。Lucas 在 GitHub 私有仓库 [team-script-hub](https://github.com/lucasshare/team-script-hub) 管理发布；同事通过 Cloudflare Pages 公网地址安装，无需注册。首页明确展示“团队共享”标识。

脚本库覆盖各业务平台和通用工具，平台选项从已发布脚本动态生成，一个脚本可归属多个平台。首版只提供一个**安装验证脚本**，运行于 `https://example.com/`，不会执行业务操作。现有业务源码仓库保持独立，只有经过检查并加入发布清单的脚本才会公开。

## 本地运行

依赖 Node.js 22，无需安装第三方包，Mac / Windows 使用相同命令。

```sh
npm test
npm run build:local
npm run preview
```

打开 `http://127.0.0.1:4173`。本地构建使用本机更新地址，仅供检查；正式安装应使用部署后的 HTTPS 链接。

## 构建与部署

在 Cloudflare Pages 连接本 GitHub 私有仓库，选择 `main` 分支，构建命令 `npm run build`，输出目录 `dist`。在 Pages 的构建环境变量中设置 `SITE_URL` 为实际正式地址，且不带路径，例如项目提供的 `pages.dev` 域名。它是公开地址，不是密钥。

正式构建必须提供 `SITE_URL`；未设置时会停止，避免发布错误的更新地址。Cloudflare 的预览部署也沿用这个正式地址，以免已安装脚本跟随临时预览域名。

详细操作见 [部署说明](docs/deployment.md)。GitHub 保存源码不会自动生成公网安装地址，必须完成 Pages 部署。

## 发布脚本

1. 将审核后的脚本放入 `userscripts/<英文ID>/<ID>.v版本号.user.js`，保留历史版本。
2. 在 `catalog.json` 添加名称、所属平台 `platforms`、用途分类 `category`、适用页面、版本及发布说明，`file` 指向这次发布的精确文件。平台名称按实际工具填写，不固定为某个平台。
3. 源文件使用 `__PUBLIC_ORIGIN__` 作为 `@updateURL` / `@downloadURL` 的域名，由构建程序替换；命名空间与脚本名称保持稳定。
4. 运行测试，核对构建结果，使用中文提交说明，再发布到 `main`。

发布文件使用稳定路径 `scripts/<ID>.user.js` 和 `scripts/<ID>.meta.js`；升级时不改变路径，只提高 `@version`。油猴按用户设置检查更新，不保证实时推送。出现问题时，以更高版本号发布修复版；直接降低版本号不能保证客户端回退。

## 权限与边界

- 管理权限由 GitHub 仓库控制，首版不添加协作者、账号系统或网站上传入口。
- `dist/` 中的脚本可被任何拿到链接的人下载、复制和运行，私有源码仓库不代表公开脚本保密。
- 不发布凭据、浏览器存储、店铺资料和业务导出文件。仓库文档和历史版本不进入 `dist/`。
- `catalog.json`、油猴元信息和文件版本必须一致，构建时校验。该校验不代替上线前对脚本内容的人工检查。

## 目录

| 路径 | 用途 |
| --- | --- |
| `web/` | 静态首页、样式及搜索逻辑 |
| `userscripts/` | 按版本保留的源脚本 |
| `catalog.json` | 明确允许公开的脚本清单 |
| `tools/` | 构建、验证及本地预览，无第三方依赖 |
| `.github/workflows/check.yml` | GitHub 上的自动检查，不执行部署 |
| `docs/PRD.md` | 首版范围及验收要求 |
| `docs/DEVELOPMENT_LOG.md` | 工作记录、验证结果与未完成事项 |
| `PROJECT_MEMORY.md` | 后续对话需要延续的长期决定 |

技术依据：[Cloudflare Git 集成](https://developers.cloudflare.com/pages/configuration/git-integration/)、[油猴元信息说明](https://www.tampermonkey.net/documentation.php?locale=zh)。
