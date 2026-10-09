# Codex 本地沙箱故障排查记录

日期：2026-10-08

## 结论

根因是 `C:\Users\su\.codex\config.toml` 里的一行 Windows 沙箱设置：

```toml
[windows]
sandbox = "elevated"
```

修复：把它改成 `sandbox = "unelevated"`，完全退出并重启 Codex。
结果：shell、文件读写全部恢复正常。

## 故障症状

- `exec_command` 的所有命令都在创建进程时失败：
  `helper_unknown_error: setup refresh had errors`
- Node REPL 内核启动时崩溃，并吐出了底层原因：
  `windows sandbox failed: helper_unknown_error: setup refresh had errors`
- 普通文件写入也失败：`Failed to write file ...`
- 应用本体正常：工作区依赖加载、设置页、界面都能用

## 排查过程

1. 换 shell（powershell / cmd / bash）、换 workdir、加 tty、改 login 模式，错误完全一致
   -> 排除命令、目录、会话模式因素，确认是执行器本身起不来。
2. 尝试请求提权（sandbox_permissions = require_escalated）
   -> 被策略拒绝：`sandbox_approval: false`。
3. 通过不依赖 shell 的通道交叉验证（工作区依赖加载、Node REPL）
   -> 应用主体正常，问题局限在沙箱助手。
4. Node REPL 暴露出底层报错：`windows sandbox failed ...`，确认是 Windows 沙箱助手故障。
5. 用 `apply_patch` 当"读取探针"（它不走 shell）
   -> 读取正常，写入失败，说明写入同样要经过沙箱助手。
6. 设置页提示 `disable_response_storage` is ignored
   -> 确认配置被第三方切换工具改过，但该项是无害警告，不是根因。
7. 用探针逐行验证 `config.toml` 内容，命中：
   `[windows]`、`sandbox = "elevated"`、`[mcp_servers.cua_repl]`。
8. 把 `sandbox = "elevated"` 改成 `sandbox = "unelevated"`，完全退出 Codex 后重启
   -> 沙箱立即恢复。

## 根因分析

- 本机 Codex 是**微软商店 MSIX 版**（安装在
  `C:\Program Files\WindowsApps\OpenAI.Codex_26.1002.7124.0_x64__2p2nqsd0c76g0\`）。
- MSIX 应用无法为沙箱助手提权。
- 当 `[windows] sandbox = "elevated"` 时，沙箱助手尝试以提权方式初始化，必然失败，
  于是 `setup refresh had errors`，**所有走沙箱的操作（起进程、写文件）全部瘫痪**。
- 该设置持久保存在 `config.toml` 中，所以重启、清缓存都无法摆脱它。

## 修复步骤

1. 完全退出 Codex（含托盘进程）。
2. 打开 `C:\Users\su\.codex\config.toml`。
3. 将
   ```toml
   [windows]
   sandbox = "elevated"
   ```
   改为
   ```toml
   [windows]
   sandbox = "unelevated"
   ```
4. 保存，重新启动 Codex。

## 验证结果

- `exec_command` 正常执行，退出码 0
- `node --version` -> `v24.18.0`
- 文件写入 / 删除正常，探针文件已清理

## 排除项

- **cc-switch**：无关。`[windows] sandbox` 是 Codex 自身的 Windows 沙箱设置，
  cc-switch 不会写这个字段。
- **disable_response_storage**：无关。Codex 明确提示该项 "is ignored"，
  只是遗留/第三方写入的无害键，可删可不删。
- **杀毒软件**：无关。退出后故障无任何变化。
- **运行时缓存损坏**：无关。清理后故障无变化。

## 备注

- 如果以后想使用提权沙箱模式，需要以管理员身份运行 Codex；商店版通常无法做到，
  因此建议保持 `unelevated`。
- 当前审批策略中 `sandbox_approval = false`，意味着部分需要提权的命令会被自动拒绝
  （不弹窗）。如需执行这类命令，需调整审批策略。
- `git` / `python` 未加入 PATH，但随应用捆绑在运行时目录中：
  `C:\Users\su\.cache\codex-runtimes\codex-primary-runtime\dependencies\`。
