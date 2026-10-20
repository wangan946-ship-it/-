# 手机版本第三方依赖

运行依赖固定在 `package.json` 和 `pnpm-lock.yaml`：

| 项目 | 使用方式 | 许可证 |
| --- | --- | --- |
| Capacitor 8.5.3 | 内嵌页面、原生桥、Android/iOS 工程模板 | MIT |
| React / React DOM 19.2.0 | 本地 UI | MIT |
| Lucide React 0.468.0 | 图标 | ISC |
| SQLite | Android 系统 SQLite / Apple SQLite3 | SQLite public domain |
| AndroidX、Android Gradle Plugin | Android 构建与系统 UI/文件分享 | Apache-2.0，详见各组件 |

Vite、TypeScript、Vitest、Testing Library 等仅用于开发与测试；具体版本和完整传递依赖以锁文件为准。Apple 系统框架和 Android SDK 受各自平台许可约束。JDK 构建环境使用 Eclipse Temurin（GPLv2 + Classpath Exception），不打包进手机 APP。

移动端解析逻辑为本项目适配器的 TypeScript 实现，未集成 yt-dlp、第三方收费 API、签名服务或平台账号 Cookie。开源调研与服务器版本的选择依据仍见根目录 `docs/`；不会把某个开源项目的许可证等同于对所有平台内容的下载授权。

1.0.2 的抖音匿名访客会话处理为独立实现，只接收官方公开分享页当前响应下发的 `ttwid`，仅在同一次请求操作内用于同主机、同作品路径。没有复制第三方项目的随机访客 ID、`a_bogus` 生成、账号 Cookie 或访问控制绕过逻辑。图文下载只使用官方公开页实际提供的下载地址。

应用图标来自本项目已有几何图标，由 `scripts/generate-icons.py` 复用生成，无外部商标素材。发布二进制时应保留各实际包含依赖的版权与许可证通知；`node_modules` 和原生依赖内含对应许可证文件。

1.0.3 小红书原片键结构调研参考 [media-parser 的小红书字段说明](https://github.com/ucmao/media-parser/blob/main/docs/parsers/xiaohongshu.md) 与 [rednote_downloader](https://github.com/SeanLi-Coder/rednote_downloader)。仅参考公开数据字段，未复制或集成其代码、Cookie、签名或浏览器登录流程；实际选择规则、路径格式校验、全文件 MD5 核对为本项目独立实现，并经真实公开页面与文件核验。Android 使用系统 MessageDigest，iOS 使用系统 CryptoKit，无新增运行依赖。诊断帧提取工具仅在 `.local/xhs-watermark/python-tools/`，不进入 APK 或生产依赖。
