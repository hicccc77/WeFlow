// 构建前清空 dist-electron：vite 产物带内容 hash（如 config-XXXX.js），
// 不清理会让旧版本 chunk 无限堆积并被误打进安装包
const { rmSync, existsSync } = require('fs')
const { join } = require('path')

const dir = join(__dirname, '..', 'dist-electron')
if (existsSync(dir)) {
  rmSync(dir, { recursive: true, force: true })
  console.log('[clean] dist-electron removed')
}
