# 第三批重构总结 - P1 高优先级剩余任务

## 概览

**分支**: `refactor/p1-remaining-high-priority`  
**日期**: 2026-06-11  
**提交数**: 5  
**文件修改**: 15 个文件  
**代码变更**: +657 / -64 行

## 完成任务

### 1. ✅ 添加缓存 flush 到退出流程 [HIGH]

**问题**:
- contactCacheService 和 messageCacheService 使用 3 秒防抖异步写盘
- 应用异常退出时可能丢失最近 3 秒的缓存更新

**修复**:
- 在 `shutdownAppServices()` 中添加缓存持久化逻辑
- chatService 暴露 `getContactCacheService()` / `getMessageCacheService()`
- 应用退出前强制调用 `flush()` 立即写盘

**时机**:
- 在停止 cloudControlService 之后
- 在停止 chatService 之前
- 在 5 秒强制退出超时之前

**收益**:
- 防止应用退出时丢失缓存数据
- 确保联系人信息和消息缓存完整持久化

---

### 2. ✅ 依赖分类优化 [HIGH]

**问题**:
- 纯渲染端依赖（React、echarts、zustand 等）错放在 dependencies
- 导致这些依赖被打包到 app.asar（当前 188MB）
- 增加安装包体积和首次安装时间

**修复**:
将 11 个纯渲染端依赖移到 devDependencies：
- **React 生态**: react, react-dom, react-router-dom, react-virtuoso, react-markdown, remark-gfm
- **UI 库**: lucide-react, echarts, echarts-for-react, html2canvas
- **状态管理**: zustand

保留主进程依赖在 dependencies（ffmpeg-static, koffi, electron-updater 等）

**预期收益**:
- app.asar 体积减少约 40-50MB
- 安装包体积减少约 20-30MB（压缩后）
- 不影响运行时功能（Vite 已打包渲染端代码）

---

### 3. ✅ 优化 extraResources 平台分离 [HIGH]

**问题**:
- resources/ 目录（68MB）被全平台打包
- macOS 包含 Windows/Linux 的 wcdb 和 key 文件
- 每个平台冗余约 25MB（wcdb + key 的其他平台版本）

**修复**:
- 删除全局 extraResources 中的 `resources/` 配置
- 为 mac/win/linux 各自配置平台特定的 extraResources
- 仅打包对应平台的 wcdb 和 key 目录
- 共享资源（icons、image、wedecrypt）所有平台都包含

**配置详情**:
- **macOS**: wcdb/macos + key/macos + 共享资源
- **Windows**: wcdb/win32 + key/win32 + 共享资源
- **Linux**: wcdb/linux + key/linux + 共享资源

**预期收益**:
- 每个平台安装包减少约 25MB
- macOS dmg: 预计减少 15-20MB（压缩后）
- Windows nsis: 预计减少 15-20MB（压缩后）
- Linux AppImage: 预计减少 15-20MB（压缩后）

---

### 4. ✅ 修复年度报告字体双份打包 [HIGH]

**问题**:
- 年度报告字体（27MB）被打包两次：
  1. Vite 构建时打包到 dist/assets/（SCSS 引用）
  2. electron-builder 打包到 resources/fonts/（extraResources）
- 每个平台安装包浪费约 27MB

**根本原因**:
- `src/pages/AnnualReportWindow.scss` 中使用 `url('../../resources/fonts/...')`
- Vite 解析路径后将字体复制到 dist/assets/
- 同时 extraResources 配置又打包了原始 resources/fonts/

**修复**:
- 删除所有平台 extraResources 中的 `resources/fonts` 配置
- 仅保留 Vite 打包的 dist/assets/ 版本
- 运行时加载的是 Vite 打包后的字体文件

**影响字体**:
- Inter-Var.ttf (可变字体)
- NotoSerifSC-Var.ttf (可变字体)
- PlayfairDisplay-Var.ttf (可变字体)
- CormorantGaramond-Var.ttf (可变字体)
- SpaceMono-Regular.ttf
- SpaceMono-Bold.ttf

**预期收益**:
- 每个平台安装包减少约 27MB（未压缩）
- 压缩后预计减少约 15-20MB
- 不影响年度报告功能（运行时使用 Vite 打包版本）

---

### 5. ✅ 迁移 file:// 协议到 weflow:// [HIGH]

**问题**:
- `webSecurity: false` 已删除，`file://` 协议不再可用
- 需要迁移到自定义 `weflow://` 协议

**修复**:
- 创建 `toWeflowUrl()` 工具函数统一处理路径转换
- 迁移**渲染进程**（18 处）：
  * ChatPage.tsx: 图片/视频加载
  * ResourcesPage.tsx: 媒体资源
  * SnsPage.tsx: 文件夹打开（改用 shell.openPath）
  * SnsPostItem.tsx: 朋友圈图片/视频
  * SnsMediaGrid.tsx: 朋友圈媒体网格（6 处）
- 迁移**主进程**（5 处）：
  * main.ts: 图片预览窗口
  * chatService.ts: 路径转换注释
  * exportService.ts: 导出服务路径处理（2 处）
  * notificationWindow.ts: HTML 加载（保持 file://，标准用法）
  * wasmService.ts: 注释（保持 file://，Node 环境）

**toWeflowUrl() 特性**:
- 自动处理 Windows/Unix 路径
- URL 编码，特殊处理 # 字符
- 幂等性（重复调用不会破坏）
- 兼容已有 weflow:// 路径

**影响范围**:
- 所有本地文件加载（图片、视频、音频）
- 聊天记录图片预览
- 朋友圈媒体查看
- 资源管理页面
- 导出功能

**风险**:
- ⚠️ **高风险改动**，影响核心功能
- 需要全面测试所有媒体加载场景
- weflow:// 协议路径白名单已在 main.ts 中配置

---

## 累计收益

### 包体积优化
| 优化项 | 未压缩 | 压缩后（预估） |
|--------|--------|----------------|
| 依赖分类 | -40MB | -20~30MB |
| 平台分离 | -25MB | -15~20MB |
| 字体去重 | -27MB | -15~20MB |
| **总计** | **-92MB** | **-50~70MB** |

### 功能改进
- ✅ 防止退出时丢失缓存数据
- ✅ 迁移到安全的自定义协议
- ✅ 修复 webSecurity: false 删除后的兼容性

---

## 验证清单

### 必须验证（高风险）

#### weflow:// 协议迁移
- [ ] 聊天记录中的图片/视频显示正常
- [ ] 朋友圈图片/视频加载正常
- [ ] 资源管理页面媒体预览正常
- [ ] 图片预览窗口打开正常
- [ ] 视频播放窗口正常
- [ ] 导出功能中的媒体路径处理正常
- [ ] Live Photo 显示正常

#### 缓存 flush
- [ ] 正常退出应用后重新打开，缓存数据完整
- [ ] 强制结束进程后重新打开，验证数据完整性
- [ ] 查看日志确认 flush 调用成功

### 应该验证（中风险）

#### 包体积优化
- [ ] 构建后检查 app.asar 大小
- [ ] 各平台 app/resources/ 目录大小
- [ ] 确认只包含当前平台的 wcdb 和 key 文件
- [ ] 年度报告字体加载正常
- [ ] 年度报告导出 HTML 正常

#### 依赖分类
- [ ] 运行 `npm install` 后重新构建
- [ ] 确认应用正常启动
- [ ] 确认所有渲染端功能正常

---

## 技术债务

1. **weflow:// 协议白名单路径**
   - 当前实现较宽松
   - 未来可以添加更严格的路径验证

2. **字体加载策略**
   - 当前依赖 Vite 自动处理
   - 可以考虑显式配置字体路径

3. **缓存持久化**
   - 当前在退出时 flush
   - 可以考虑定期自动 flush（如每分钟）

---

## 下一步建议

### 立即验证
1. **全面测试 weflow:// 协议**（最高优先级）
2. 测试缓存 flush 功能
3. 构建所有平台包，验证体积减少

### 继续 P1 任务
剩余 7 个 HIGH 优先级任务（从 REVIEW_SUMMARY.md）：
- IPC 接口拆分与职责单一化
- 巨型服务拆分（chatService 8755 行）
- 数据库查询优化（N+1 问题）
- 错误处理标准化
- 事件监听器泄漏修复
- 资源清理不彻底
- TypeScript 类型安全加固

### 开始 P2 中期任务
- Electron 版本升级
- 构建工具链现代化
- 监控与可观测性
- 等等...

---

**总结**: 第三批完成了 5 个 HIGH 优先级任务，主要集中在包体积优化（总计减少 50-70MB）和 webSecurity 删除后的兼容性修复。**weflow:// 协议迁移是最高风险改动，需要立即全面测试**。
