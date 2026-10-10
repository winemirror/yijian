# 弈鉴 Xiangqi 产品工作区

本仓库把 `2026-10-08` 下的弈鉴开发线放在同一段 Git 历史里，方便对比、回退和标记版本。

**项目本身的说明——功能实现细节、特色功能使用教程、开发与打包流程——见
[`fe/README.md`](fe/README.md)。** 本文件只讲仓库的组织方式和日常 Git 用法。

## 目录

- `w-2/`：引擎、浏览器离线版、EXE 启动器、Capacitor/Android 打包和字体子集工具，主要覆盖 1.0 - 1.8。
- `fe/`：**当前主线**，覆盖 1.9 - 3.1，当前基线为 3.1；源码在 `fe/work`，发布物在 `fe/outputs`。
- `ben/`、`kan/`、`q/`、`w/`：早期或辅助工作目录，体量很小，一并保留。

各版 APK 在 `w-2/outputs/xiangqi-apk/` 和 `fe/outputs/` 中；桌面版 EXE 在对应 `outputs/` 下。
当前构建信息见 `fe/outputs/BUILD-INFO.txt`，版本 3.1（versionCode 30）。

## 日常使用

Git 安装位置由迁移脚本负责放到 `D:\Tools\PortableGit\cmd\git.exe`，并加入用户 PATH。

```powershell
git status
git add -A
git commit -m "描述这次改动"
git tag v1.15
```

发新版时建议先提交，再打 tag；tag 名与 APK 版本号保持一致。

## 查看与回退

```powershell
git log --oneline --decorate
git restore .              # 放弃尚未提交的改动
git switch --detach v1.13  # 只读查看 1.13 时的代码和发布物
git switch main            # 回到主线
```

## 仓库说明

- 入库内容：源码、配置、脚本、音效、字体子集产物，以及 `outputs` 下整理好的 APK/EXE。
- 不入库内容：`gradle-home`、`android-sdk`、`node_modules`、浏览器用户数据、APK 解包目录和各类构建缓存。
- `yijian-debug.keystore` 是从 1.5 一直沿用的 debug 签名，只有 2.6 KB，故意入库以保证后续 APK 升级仍是同一签名。正式发布密钥不要放进这个仓库。
