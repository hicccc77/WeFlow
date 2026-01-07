# WeFlow

基于 Electron + React + TypeScript 构建的微信聊天记录查看工具。

## 功能特性

## 技术栈

- **前端**: React 19 + TypeScript + Zustand
- **桌面**: Electron 39
- **构建**: Vite + electron-builder
- **数据库**: better-sqlite3
- **样式**: SCSS + CSS Variables

## 开发环境

### 前置要求

- Node.js 18+
- pnpm（推荐）或 npm

### 安装依赖

```bash
npm install
```

### 开发模式

```bash
npm run dev
```

### 构建打包

```bash
npm run build
```

打包产物在 `release` 目录下。

## 项目结构

```
WeFlow/
├── electron/              # Electron 主进程
│   ├── main.ts           # 主进程入口
│   ├── preload.ts        # 预加载脚本
│   └── services/         # 后端服务
│       ├── chatService.ts      # 聊天数据服务
│       ├── wcdbService.ts      # WCDB 数据库服务
│       ├── decryptService.ts   # 解密服务
│       └── ...
├── src/                   # React 前端
│   ├── components/       # 通用组件
│   ├── pages/            # 页面组件
│   ├── stores/           # Zustand 状态管理
│   ├── services/         # 前端服务
│   └── types/            # TypeScript 类型定义
├── public/               # 静态资源
└── resources/            # 打包资源（DLL 等）
```


## 注意事项

- 仅支持 Windows 系统
- 需要微信 4.x 版本
- 所有数据仅在本地处理，不会上传到任何服务器
- 请负责任地使用本工具，遵守相关法律法规
