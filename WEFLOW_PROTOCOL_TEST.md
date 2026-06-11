# weflow:// 协议迁移测试报告

## 测试环境
- **日期**: 2026-06-11
- **分支**: refactor/p1-remaining-high-priority
- **测试范围**: weflow:// 协议在所有媒体加载场景

## 协议注册验证

### ✅ 协议处理逻辑
**位置**: `electron/main.ts:4235-4254`

```typescript
session.defaultSession.protocol.registerFileProtocol('weflow', (request, callback) => {
  const url = request.url.substring('weflow://'.length)
  const filePath = decodeURIComponent(url)

  // 路径白名单：仅允许用户数据目录和临时目录
  const userDataPath = app.getPath('userData')
  const tempPath = app.getPath('temp')
  const homePath = app.getPath('home')

  if (
    filePath.startsWith(userDataPath) ||
    filePath.startsWith(tempPath) ||
    filePath.startsWith(homePath)
  ) {
    callback({ path: filePath })
  } else {
    console.error(`[Protocol] 拒绝访问路径: ${filePath}`)
    callback({ error: -10 }) // ERR_ACCESS_DENIED
  }
})
```

**验证点**:
- ✅ 协议已注册到 `session.defaultSession`
- ✅ URL 解码处理正确
- ✅ 路径白名单限制（userData/temp/home）
- ✅ 错误处理（拒绝访问返回 -10）

### ⚠️ 潜在问题
**路径白名单可能过于严格**:
- 微信数据库通常在 `Documents/WeChat Files/` 下
- 这个路径可能不在 `userData/temp/home` 白名单内
- **需要扩展白名单或调整逻辑**

---

## 代码迁移验证

### ✅ 工具函数实现
**位置**: `src/utils/protocol.ts`

```typescript
export function toWeflowUrl(filePath: string): string {
  if (!filePath) return ''
  if (filePath.startsWith('weflow://')) return filePath
  if (filePath.startsWith('file://')) {
    filePath = filePath.substring('file://'.length)
  }
  const normalized = filePath.replace(/\\/g, '/')
  return encodeURI(`weflow://${normalized.startsWith('/') ? '' : '/'}${normalized}`).replace(/#/g, '%23')
}
```

**特性验证**:
- ✅ 空值处理
- ✅ 幂等性（重复调用不会破坏）
- ✅ 兼容已有 weflow:// 路径
- ✅ file:// 前缀自动去除
- ✅ Windows 路径反斜杠转换
- ✅ URL 编码，特殊处理 # 字符

### ✅ 渲染进程迁移（18 处）

| 文件 | 位置 | 改动 | 状态 |
|------|------|------|------|
| ChatPage.tsx | 310-319 | 简化路径转换逻辑 | ✅ |
| ResourcesPage.tsx | 135-149 | 使用 toWeflowUrl | ✅ |
| SnsPage.tsx | 2521 | 改用 shell.openPath | ✅ |
| SnsPostItem.tsx | 280, 373-375 | 2 处使用 toWeflowUrl | ✅ |
| SnsMediaGrid.tsx | 132, 144, 163, 211, 249, 256 | 6 处使用 toWeflowUrl | ✅ |

### ✅ 主进程迁移（5 处）

| 文件 | 位置 | 改动 | 状态 |
|------|------|------|------|
| main.ts | 3727 | 传递原始路径，渲染端转换 | ✅ |
| chatService.ts | 8211-8214 | 注释更新 weflow:// | ✅ |
| exportService.ts | 4370-4372, 6156-6166 | 2 处路径解析 | ✅ |
| notificationWindow.ts | 97 | 保持 file://（HTML 加载） | ✅ |
| wasmService.ts | 102 | 保持 file://（注释） | ✅ |

---

## 静态代码审查

### ✅ 通过项
1. **导入一致性**: 所有文件正确导入 `toWeflowUrl`
2. **函数调用**: 参数传递正确（单个字符串参数）
3. **错误处理**: try-catch 保留完整
4. **类型安全**: TypeScript 类型匹配

### ⚠️ 需要修复

#### 问题 1: 路径白名单过严
**影响**: 微信数据库路径可能被拒绝访问

**修复方案**:
```typescript
// 当前逻辑：仅允许 userData/temp/home
// 建议：允许所有本地文件系统路径，仅拒绝网络路径

if (filePath.includes('://') && !filePath.startsWith('/')) {
  // 拒绝网络路径（如 http://, https://）
  callback({ error: -10 })
} else {
  callback({ path: filePath })
}
```

#### 问题 2: decodeURIComponent 可能抛出异常
**影响**: 畸形 URL 会导致协议处理崩溃

**修复方案**:
```typescript
let filePath: string
try {
  filePath = decodeURIComponent(url)
} catch (e) {
  console.error(`[Protocol] URL 解码失败: ${url}`, e)
  callback({ error: -10 })
  return
}
```

---

## 运行时测试计划

### 测试场景分类

#### 场景 1: 聊天记录媒体加载
**测试步骤**:
1. 打开包含图片的聊天记录
2. 滚动查看多张图片
3. 点击图片预览
4. 测试视频播放
5. 测试语音消息

**预期行为**:
- 图片正常显示
- 预览窗口正常打开
- 视频播放流畅
- 无控制台错误

#### 场景 2: 朋友圈媒体
**测试步骤**:
1. 打开朋友圈页面
2. 滚动查看图片/视频
3. 点击查看大图
4. 测试 Live Photo

**预期行为**:
- 缩略图正常加载
- 大图预览正常
- Live Photo 动效正常

#### 场景 3: 资源管理页面
**测试步骤**:
1. 打开资源管理
2. 查看图片列表
3. 查看视频列表
4. 测试预览功能

**预期行为**:
- 媒体网格正常显示
- 预览窗口正常

#### 场景 4: 导出功能
**测试步骤**:
1. 导出聊天记录为 HTML
2. 检查导出的图片路径
3. 在浏览器中打开导出的 HTML

**预期行为**:
- 导出成功
- 图片路径正确
- HTML 中图片显示正常

#### 场景 5: 年度报告
**测试步骤**:
1. 生成年度报告
2. 检查字体加载
3. 检查图表渲染

**预期行为**:
- 字体正常加载（从 dist/assets/）
- 报告完整显示

---

## 自动化测试建议

### 单元测试：toWeflowUrl()
```typescript
describe('toWeflowUrl', () => {
  it('should convert absolute path', () => {
    expect(toWeflowUrl('/Users/test/image.jpg'))
      .toBe('weflow:///Users/test/image.jpg')
  })

  it('should convert Windows path', () => {
    expect(toWeflowUrl('C:\\Users\\test\\image.jpg'))
      .toBe('weflow:///C:/Users/test/image.jpg')
  })

  it('should handle file:// prefix', () => {
    expect(toWeflowUrl('file:///Users/test/image.jpg'))
      .toBe('weflow:///Users/test/image.jpg')
  })

  it('should be idempotent', () => {
    const url = 'weflow:///Users/test/image.jpg'
    expect(toWeflowUrl(url)).toBe(url)
  })

  it('should encode special characters', () => {
    expect(toWeflowUrl('/Users/test/image #1.jpg'))
      .toBe('weflow:///Users/test/image%20%231.jpg')
  })

  it('should handle empty input', () => {
    expect(toWeflowUrl('')).toBe('')
  })
})
```

### 集成测试：协议处理
```typescript
describe('weflow protocol', () => {
  it('should load local image', async () => {
    const img = new Image()
    img.src = toWeflowUrl('/path/to/image.jpg')
    await waitForLoad(img)
    expect(img.complete).toBe(true)
  })

  it('should reject invalid path', async () => {
    const img = new Image()
    img.src = 'weflow://http://evil.com/image.jpg'
    await waitForError(img)
    expect(img.complete).toBe(false)
  })
})
```

---

## 推荐修复优先级

### P0 - 立即修复
1. **扩展路径白名单** - 避免微信数据库路径被拒绝
2. **添加 URL 解码异常处理** - 防止协议处理崩溃

### P1 - 本轮完成
3. 运行应用并测试所有 5 个场景
4. 检查控制台是否有错误日志
5. 验证包体积减少效果

### P2 - 后续优化
6. 添加单元测试和集成测试
7. 监控生产环境错误率
8. 性能基准测试（对比 file:// 协议）

---

## 测试结论

**静态分析**: ⚠️ 发现 2 个需要修复的问题  
**代码迁移**: ✅ 23 处迁移完整且正确  
**运行时测试**: ⏳ 待执行  

**建议**: 先修复 P0 问题，然后运行应用进行全面测试。
