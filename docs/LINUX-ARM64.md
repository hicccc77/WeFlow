# Linux ARM64 支持说明

WeFlow-Lanxus 增加了 Linux arm64/aarch64 上的微信数据库 key 捕获和验证资源，目标环境是 Ubuntu 18.04+ 的 ARM64 桌面系统，例如 RK3568 这类板卡。

## 支持范围

- 微信程序默认探测：`/opt/wechat/wechat`、`/usr/bin/wechat`、`/usr/local/bin/wechat`、`wechat`
- 数据目录默认探测：`~/xwechat_files`、`~/.local/share/WeChat/xwechat_files`、`~/Documents/xwechat_files`
- key 捕获策略：通过 `com.Tencent.WCDB.Config.Cipher` 语义路径定位 ARM64 登录期 key 参数，不做全进程大范围扫描
- key 验证：支持 SQLCipher v4/passphrase，4096 page size，PBKDF2-HMAC-SHA512 256000 次，HMAC-SHA512
- key 存储：只写入本机用户数据目录下的 `linux-arm64-wechat/secrets/wechat_db_key.json`，目录权限 `0700`，文件权限 `0600`

原始 key 不应写入日志、文档、聊天窗口或版本库。需要确认时只输出长度、模式和短指纹。

## 应用内使用

1. 在首次启动页选择微信数据目录。
2. 选择账号目录。
3. 点击“自动获取密钥”。
4. 授权后完成微信登录确认。
5. WeFlow 会在本机验证候选 key，并把验证通过的 key 写入私有 secrets 文件。

如果自动启动微信失败，可以先手动启动微信到登录窗口，再重新点击自动获取。

## 命令行调试

资源脚本位于：

```bash
resources/key/linux/arm64/scripts
```

在源码目录中可直接运行：

```bash
WEFLOW_ARM64_WECHAT_DATA_ROOT="$HOME/xwechat_files" \
resources/key/linux/arm64/scripts/run_arm64_login_key_capture.sh --duration-sec 300
```

也可以指定账号目录名：

```bash
resources/key/linux/arm64/scripts/run_arm64_login_key_capture.sh \
  --data-root "$HOME/xwechat_files" \
  --account "wxid_example_abcd" \
  --duration-sec 300
```

脚本输出只包含事件和验证元信息，不会打印原始 key。

## 构建

Linux arm64 构建命令：

```bash
npm run build:linux:arm64
```

产物文件名包含系统和架构，例如：

```text
WeFlow-4.3.0-linux-arm64.AppImage
WeFlow-4.3.0-linux-arm64.tar.gz
```

## 维护说明

- ARM64 断点 offset 与微信 ARM64 二进制版本相关；如果微信升级导致捕获失败，需要重新用 `arm64_weflow_probe_scan.c` 从二进制语义锚点定位候选 offset。
- 捕获脚本退出后会尝试恢复被 ptrace 暂停的线程；异常退出后可手动执行 `kill -CONT <wechat-pid>`。
- `wechat_db_key_candidates*.jsonl` 只是候选文件，不应当作为最终 key 使用。
