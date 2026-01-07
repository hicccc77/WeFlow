# Weflow 重构进度

## 基础架构
- [x] 项目初始化（React + Electron + TypeScript）
- [x] 自定义标题栏 + Windows 原生窗口控件
- [x] Zustand 状态管理
- [x] Electron IPC 通信封装
- [x] 数据库服务（SQLite）
- [x] 配置服务
- [x] 路由守卫（未解密时跳转欢迎页）

## 页面
- [x] 欢迎页（WelcomePage）
  - [x] 数据库路径选择
  - [x] 密钥输入/自动获取
  - [x] 解密进度显示
- [x] 数据管理页（DataManagementPage）
  - [x] 数据库列表扫描
  - [x] 解密状态显示
  - [x] 批量解密功能（Node.js 原生实现）
  - [x] 增量更新功能
  - [x] 图片解密功能（V4 格式）
- [ ] 首页（HomePage）
  - [ ] 数据概览卡片
  - [ ] 快捷入口
- [x] 聊天页（ChatPage）
  - [x] 会话列表侧边栏
  - [x] 消息列表
  - [x] 消息气泡组件
  - [x] 图片消息（占位符）
  - [x] 语音消息（占位符）
  - [x] 表情消息（支持下载缓存）
  - [x] 引用消息
  - [x] 系统消息
  - [x] 群聊发送者头像/名称
  - [x] 日期分隔线
  - [x] 滚动加载更多
  - [ ] 图片消息查看器
  - [ ] 语音消息播放
- [ ] 数据分析页（AnalyticsPage）
  - [ ] 消息统计图表
  - [ ] 词云
  - [ ] 活跃时段分析
- [ ] 年度报告页（AnnualReportPage）
  - [ ] 报告生成
  - [ ] 报告展示
- [x] 设置页（SettingsPage）
  - [x] 数据库配置（密钥、路径、wxid）
  - [x] 图片解密配置（XOR/AES 密钥，半完成，相当于没完成）
  - [x] 缓存管理（迁移功能）
  - [ ] 主题切换
  - [x] 自动获取密钥功能
  - [x] 自动检测数据库路径

## 服务
- [x] 数据管理服务（扫描数据库、图片）
- [x] 数据库解密服务（Node.js 原生 PBKDF2 + AES + HMAC）
- [x] 图片解密服务（V4: AES-128-ECB + XOR 没怎么完成，假完成，给自己点感觉）
- [x] 图片密钥获取服务（从微信进程内存读取）
- [x] WCDB 数据库服务（通过 wcdb_api.dll）
- [x] 微信密钥获取服务（通过 wx_key.dll）
- [x] 聊天服务（会话列表、消息查询、联系人信息）
- [x] 表情包下载缓存服务
- [x] 消息解析服务（文本/表情/引用/系统消息）
- [ ] 消息解析服务（图片/语音）
- [ ] 语音解码服务
- [ ] 分析计算服务
- [ ] 导出服务

## 数据模型
- [x] Message 消息模型
- [x] Contact 联系人模型
- [x] ChatSession 会话模型
- [x] AnalyticsData 分析数据模型

## 组件
- [x] TitleBar 标题栏
- [x] Sidebar 侧边导航
- [x] RouteGuard 路由守卫
- [x] DecryptProgressOverlay 解密进度遮罩
- [x] SessionAvatar 会话头像（支持骨架屏）
- [x] MessageBubble 消息气泡
- [ ] ImageViewer 图片查看器
- [ ] VoicePlayer 语音播放器
- [ ] LoadingSpinner 加载动画
- [ ] Toast 提示组件
