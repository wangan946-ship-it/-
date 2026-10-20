# Windows 用户的 iPhone 构建与安装

目标设备：iPhone 14 Pro Max。用户尚未提供 iOS 版本；云端脚本使用已安装的最新稳定 iOS 模拟器运行时，报告会写出具体版本，不能代替用户手机上对应系统版本的验收。

## 当前状态（2026-10-20）

- Windows 已通过：93 项共用解析器/React 测试、TypeScript/Vite 构建、Capacitor iOS 资源同步、Xcode 工程结构与权限配置检查。
- 源码包已在全新目录解压验证：离线按锁文件安装 230 个依赖包、前端构建、iOS 同步和工程预检通过。首次检查发现遗漏 `pnpm-workspace.yaml` 导致 esbuild 构建脚本被拦截，补齐配置后复测通过。
- 新增苹果端 XCTest：HTTP 边界/分块响应/超时/取消/匿名访客隔离/SQLite 生命周期，原生桥注册、图片预览、系统分享、添加相册，以及真实小红书原片、抖音图文、抖音视频的端到端测试。
- Swift 改动：按 Content-Length 结束已完成的下载，避免等待 CDN 关闭连接；拒绝无效文件大小；静态 WebP 在写入相册时生成 PNG 副本，原文件保留。动态 WebP、超大分辨率或不支持格式提示使用原文件分享；没有修改或重新编码视频。
- **以上 Swift 代码和 XCTest 尚未在 Xcode 上编译或执行。尚未生成 IPA，尚未完成签名、真机安装和真机验收。**
- 用户已同意将整理后的 iOS 源码和测试样本链接上传到当前公开 GitHub 仓库，并运行云端编译。上传和运行结果以 GitHub Actions 的实际记录为准。

## 不需要购买 Mac

GitHub Actions 提供云端 macOS 运行环境。项目使用 Capacitor 8，要求 Xcode 26+。工作流为 `.github/workflows/ios-candidate.yml`，支持手动触发；为完成本次获准的云端验收，推送到 `main` 的手机工程或工作流变更也会自动运行全部测试。

官方依据：[GitHub 托管运行器](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)、[Capacitor 8 环境要求](https://capacitorjs.com/docs/updating/8-0)。私有仓库使用账号包含的 Actions 额度；额度不足时先停止，不为此任务购买服务或开通额外付费额度。

## 云端构建步骤

1. 使用自己的 GitHub 私有仓库。只上传导出的手机 iOS 工程，不上传整个 Windows 工作目录。
2. Windows 生成源码包：

   ```powershell
   cd G:\苹果无水印
   .\.venv\Scripts\python.exe mobile\scripts\export-ios-source.py
   ```

   产物为 `mobile/artifacts/liuying-ios-source.zip`，附文件清单和 SHA-256。源码包包含现有真实链接测试样本，因此建议私有仓库。包中不含 SDK、EXE、账号密码、`.env`、下载文件、本机数据库或浏览器数据。

3. 将源码包解压到新的干净目录，推送到你确定的仓库。例如：

   ```powershell
   Expand-Archive -LiteralPath G:\苹果无水印\mobile\artifacts\liuying-ios-source.zip -DestinationPath G:\Liuying-iOS-Cloud
   cd G:\Liuying-iOS-Cloud
   git init -b main
   git add .github mobile .gitignore SOURCE-MANIFEST.json
   git commit -m "Add iOS app and verification workflow"
   git remote add origin https://github.com/YOUR_ACCOUNT/YOUR_PRIVATE_REPO.git
   git push -u origin main
   ```

   必须把占位仓库地址替换成你自己的私有仓库地址。

4. 在仓库 **Actions → iOS candidate verification → Run workflow**，保留 `live_network=true`。
5. 工作流先执行共用测试，再创建独立 iPhone 14 Pro Max 模拟器；编译测试包，通过真实 WKWebView/原生插件完成解析、原片下载、校验、播放、相册和分享检查，最后编译 iPhone Release 版本。
6. 任一必要测试失败就停止，不发布候选 IPA。平台可能限制海外云端 IP，网络测试失败不能当作通过，也不等于已证明用户手机同样失败。应先读日志定位，不通过跳过测试来交付。
7. 全部通过后下载 `liuying-ios-unsigned-运行编号` 构建产物。包含未签名 IPA、SHA-256、Xcode 版本及 `verification.json`。`live_network=false` 仅用于编译诊断，不产出候选 IPA。

云端不需要 Apple ID、密码、短信验证码或证书。不会把用户媒体下载结果作为构建产物上传。测试结束删除本次创建的模拟器；保留构建/测试文字日志 7 天。工程已关闭 Capacitor 请求/返回值日志。

## Windows 安装到 iPhone

未签名 IPA **不能直接点开安装**。获得云端候选包后，可使用官方 AltServer Windows / AltStore Classic，在自己的电脑上用自己的 Apple 账号签名安装。账号凭证只在官方工具中输入，不要发到聊天或写入项目/工作流。

- [官方 Windows 安装教程](https://faq.altstore.io/altstore-classic/how-to-install-altstore-windows)
- [官方 AltServer 与续签说明](https://faq.altstore.io/altstore-classic/altserver)
- [Apple Personal Team 限制](https://developer.apple.com/help/account/basics/about-your-developer-account)

免费签名通常需要每 7 天续签，续签时需要电脑；日常解析和播放仍在手机内独立运行。按官方步骤在可信的 Windows 电脑安装依赖并允许设备连接，必要时在手机开启开发者模式。

## 最终交付前的真机验收

在用户的 iPhone 14 Pro Max 上，核对安装成功和首页版本；用同一条小红书链接检查原片播放、画面与相册保存，用抖音视频/图文检查解析和导出。再验证拒绝相册权限、取消下载、切后台停止、离线本机素材、删除记录、重新启动后记录保留。测试后记录真实 iOS 版本和结果。

云端模拟器通过只表示候选包通过了对应模拟器的检查。没有完成以上真机步骤时，报告必须保留“真机未验收”，不能声称已保证一次成功。

## 本地 Mac 或自有 Mac 运行器命令

```bash
cd mobile
pnpm install --frozen-lockfile
pnpm test
pnpm sync:ios
pnpm check:ios
LIUYING_LIVE_NETWORK=1 IOS_QA_OUTPUT="$PWD/artifacts/ios-qa" pnpm test:ios
python3 scripts/package-ios.py artifacts/ios-qa
```

测试脚本只创建并删除它自己的模拟器，不会清空其他模拟器或真实手机。没有 Apple 运行环境时，Windows 上的 `pnpm check:ios` 仅是静态工程检查。
