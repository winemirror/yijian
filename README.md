# 弈鉴 Xiangqi 产品工作区

弈鉴是一个本地优先的中国象棋应用。同一套 Web 源码可运行在浏览器、
Windows 便携程序和 Android 中。

当前主线为 **3.23.0**。功能实现、架构、验证和打包说明见
[`fe/README.md`](fe/README.md)。

3.23.0 使用新的 applicationId `com.yijian.xiangqi.v2`。它不能覆盖升级
`com.yijian.xiangqi` 3.22.1，但可以与旧版并存；旧版棋谱需先导出再导入。

## 目录

- `fe/`：当前主线，包含 Web、Android、Windows 启动器、联机服务、棋库和测试。
- `w-2/`：历史工作区，保留 1.0-1.8 的源码与发布物，不再用于当前发布。
- `ben/`、`kan/`、`q/`、`w/`：早期或辅助目录。

当前源码位于 `fe/work`，发布物位于 `fe/outputs`。

## 开始开发

```powershell
cd fe\work
npm ci
npm run verify
npm run verify:release
node serve.mjs
```

本地预览默认使用 `fe/outputs/xiangqi-local`。直接运行源码目录时：

```powershell
$env:ROOT = "www"
$env:PORT = "4291"
node serve.mjs
```

Android 和 Windows 构建需要额外的 SDK，具体命令见
[`fe/README.md`](fe/README.md)。正式 Android APK 必须使用仓库外的
release keystore；流程和迁移限制见
[`fe/work/docs/RELEASE-SIGNING.md`](fe/work/docs/RELEASE-SIGNING.md)。

## Git

首次克隆后设置跟踪分支：

```powershell
git branch --set-upstream-to=origin/main main
git status
```

发版时应提交代码、验证版本和哈希、再创建与版本号一致的 tag。

## 安全与许可证

3.22.1 及更早版本使用过已公开的 Android debug 证书。先阅读
[`SECURITY.md`](SECURITY.md)，不要把那些 APK 当作未来版本的安全发布模板。

自有代码采用 MIT License。第三方组件和棋谱数据仍适用各自来源与许可，
详见
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。
