# 留影 · iPhone 独立素材助手

React、TypeScript 与 Capacitor iOS 原生工程。页面、公开链接解析器、下载器和 SQLite 素材记录均在手机内运行，无需自己的服务器。只处理可公开获取且有权保存的素材，不使用账号 Cookie、收费解析 API 或访问控制绕过。

这个仓库只包含手机 iOS 工程与构建测试所需文件。开发环境、Windows 工具、个人素材、数据库及凭证不进入仓库。

## 验证与安装

GitHub Actions 的 **iOS candidate verification** 在 iPhone 14 Pro Max 模拟器执行原生检查及三个公开样本的解析、下载、原片校验、播放和相册测试，然后编译 iPhone Release 版本。全部必要检查通过才产生未签名 IPA。

目前仍处于云端验收阶段。Actions 成功不代表已完成实体 iPhone 的签名安装与验收；未签名 IPA 不能直接点开安装。无需 Apple 账号即可编译，签名凭证由用户在自己的可信工具中管理。

参见 [Windows 用户的 iPhone 构建与安装](mobile/IOS_WINDOWS.md)、[第三方依赖](mobile/THIRD_PARTY.md)。

主分支的手机工程变更自动触发验收，也可手动运行。具体结果以对应提交的 Actions 记录和构建产物 `verification.json` 为准。
