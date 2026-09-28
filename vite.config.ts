import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import electron from 'vite-plugin-electron'
import { copyFileSync, mkdirSync } from 'fs'
import { dirname, resolve } from 'path'

let electronReloadTimer: ReturnType<typeof setTimeout> | undefined
const handleElectronOnStart = (options: { reload: () => void }) => {
  // A single source edit can rebuild several worker entries. Reloading for
  // every closeBundle races with the main-process replacement and may call
  // child.send() after its IPC channel has closed. Coalesce worker reloads and
  // ignore only that expected development lifecycle race.
  if (electronReloadTimer) clearTimeout(electronReloadTimer)
  electronReloadTimer = setTimeout(() => {
    electronReloadTimer = undefined
    const current = (process as typeof process & {
      electronApp?: { connected?: boolean; killed?: boolean }
    }).electronApp
    if (current && (current.killed || current.connected === false)) return
    try {
      options.reload()
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ERR_IPC_CHANNEL_CLOSED') throw error
    }
  }, 150)
}

const handleElectronMainOnStart = async (options: { startup: () => Promise<boolean> }) => {
  const current = (process as typeof process & {
    electronApp?: {
      removeAllListeners: () => void
      on: (event: 'error', listener: (error: NodeJS.ErrnoException) => void) => void
      kill: () => boolean
    }
  }).electronApp
  if (current) {
    // vite-plugin-electron starts the replacement immediately after kill(). On
    // Windows the old process can still hold Electron's single-instance lock,
    // making the replacement exit and consequently taking Vite down with it.
    current.removeAllListeners()
    current.on('error', (error) => {
      if (error.code !== 'ERR_IPC_CHANNEL_CLOSED') console.warn('[vite] Electron child process error:', error)
    })
    current.kill()
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  await options.startup()
}

const exportWorkerElectronShimPlugin = () => {
  const virtualId = 'virtual:weflow-export-worker-electron'
  const resolvedVirtualId = `\0${virtualId}`

  return {
    name: 'weflow-export-worker-electron-shim',
    enforce: 'pre' as const,
    resolveId(id: string) {
      if (id === virtualId) return resolvedVirtualId
      return null
    },
    load(id: string) {
      if (id !== resolvedVirtualId) return null
      return `
        import { homedir, tmpdir } from 'os'
        import { join } from 'path'

        const workerUserDataPath = () => String(process.env.WEFLOW_USER_DATA_PATH || process.env.WEFLOW_CONFIG_CWD || '').trim()
        const appDataPath = () => {
          if (process.platform === 'win32' && process.env.APPDATA) return process.env.APPDATA
          if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support')
          return process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
        }
        const getPath = (name) => {
          if (name === 'userData') return workerUserDataPath() || join(appDataPath(), 'WeFlow')
          if (name === 'documents') return join(homedir(), 'Documents')
          if (name === 'desktop') return join(homedir(), 'Desktop')
          if (name === 'downloads') return join(homedir(), 'Downloads')
          if (name === 'temp') return tmpdir()
          if (name === 'appData') return appDataPath()
          return process.cwd()
        }

        export const app = {
          isPackaged: Boolean(process.resourcesPath && process.env.NODE_ENV !== 'development'),
          getPath,
          getAppPath: () => process.cwd(),
          getName: () => 'WeFlow',
          getVersion: () => process.env.npm_package_version || '0.0.0',
          // Worker 中不存在 app 生命周期事件（如 will-quit），no-op 兼容注册退出钩子的服务
          on: () => app,
          once: () => app,
          off: () => app,
          removeListener: () => app,
          removeAllListeners: () => app
        }
        export const BrowserWindow = { getAllWindows: () => [], getFocusedWindow: () => null }
        export const dialog = { showMessageBox: async () => ({ response: 0, checkboxChecked: false }) }
        export const shell = { openExternal: async () => false, showItemInFolder: () => {} }
        export const net = { fetch: undefined }
        export const ipcMain = { on: () => {}, handle: () => {}, removeHandler: () => {} }
        export const ipcRenderer = { sendSync: () => ({}) }
        export const safeStorage = {
          isEncryptionAvailable: () => false,
          encryptString: (value) => Buffer.from(String(value || ''), 'utf8'),
          decryptString: (value) => Buffer.isBuffer(value) ? value.toString('utf8') : Buffer.from(value).toString('utf8')
        }
        export const Notification = class {
          static isSupported() { return false }
          on() { return this }
          show() {}
          close() {}
        }
        export default { app, BrowserWindow, dialog, shell, ipcMain, ipcRenderer, safeStorage, Notification }
      `
    },
    transform(code: string, id: string) {
      if (!/\.[cm]?[jt]s$/.test(id)) return null
      if (!code.includes("'electron'") && !code.includes('"electron"')) return null
      const next = code
        .replace(/from\s+(['"])electron\1/g, `from '${virtualId}'`)
        .replace(/import\s*\(\s*(['"])electron\1\s*\)/g, `import('${virtualId}')`)
        .replace(/require\s*\(\s*(['"])electron\1\s*\)/g, `require('${virtualId}')`)
      return next === code ? null : { code: next, map: null }
    }
  }
}

const copyJiebaNodeWasmPlugin = () => ({
  name: 'weflow-copy-jieba-node-wasm',
  writeBundle(options: { dir?: string; file?: string }) {
    const outputDir = options.dir || (options.file ? dirname(options.file) : '')
    if (!outputDir) return
    mkdirSync(outputDir, { recursive: true })
    copyFileSync(
      resolve(process.cwd(), 'node_modules/jieba-wasm/pkg/nodejs/jieba_rs_wasm_bg.wasm'),
      resolve(outputDir, 'jieba_rs_wasm_bg.wasm'),
    )
  },
})

export default defineConfig({
  base: './',
  server: {
    port: 3000,
    strictPort: false,
    watch: {
      ignored: [
        '**/WeLive/target/**',
        '**/wcdb/target/**',
        '**/WeLive/wcdb/x64/**',
        '**/wcdb/x64/**'
      ]
    }
  },
  build: {
    chunkSizeWarningLimit: 900,
    commonjsOptions: {
      ignoreDynamicRequires: true
    }
  },
  optimizeDeps: {
    exclude: []
  },
  plugins: [
    tailwindcss(),
    react(),
    electron([
      {
        entry: 'electron/main.ts',
        onstart: handleElectronMainOnStart,
        vite: {
          plugins: [copyJiebaNodeWasmPlugin()],
          build: {
            outDir: 'dist-electron',
            rollupOptions: {
              external: [
                'better-sqlite3',
                'koffi',
                'fsevents',
                'whisper-node',
                'shelljs',
                'exceljs',
                'node-llama-cpp',
                '@vscode/sudo-prompt',
                'silk-wasm',
                // 原生 .node 二进制不可打包，运行时从 asarUnpack 目录解析
                '@hicccc77/electron-liquid-glass'
              ]
            }
          }
        }
      },
      {
        entry: 'electron/annualReportWorker.ts',
        onstart: handleElectronOnStart,
        vite: {
          build: {
            outDir: 'dist-electron',
            rollupOptions: {
              external: [
                'koffi',
                'fsevents'
              ],
              output: {
                entryFileNames: 'annualReportWorker.js',
                codeSplitting: false
              }
            }
          }
        }
      },
      {
        entry: 'electron/dualReportWorker.ts',
        onstart: handleElectronOnStart,
        vite: {
          build: {
            outDir: 'dist-electron',
            rollupOptions: {
              external: [
                'koffi',
                'fsevents'
              ],
              output: {
                entryFileNames: 'dualReportWorker.js',
                codeSplitting: false
              }
            }
          }
        }
      },
      {
        entry: 'electron/imageSearchWorker.ts',
        onstart: handleElectronOnStart,
        vite: {
          build: {
            outDir: 'dist-electron',
            rollupOptions: {
              output: {
                entryFileNames: 'imageSearchWorker.js',
                codeSplitting: false
              }
            }
          }
        }
      },
      {
        entry: 'electron/imageDecryptWorker.ts',
        onstart: handleElectronOnStart,
        vite: {
          build: {
            outDir: 'dist-electron',
            rollupOptions: {
              output: {
                entryFileNames: 'imageDecryptWorker.js',
                codeSplitting: false
              }
            }
          }
        }
      },
      {
        entry: 'electron/wcdbWorker.ts',
        onstart: handleElectronOnStart,
        vite: {
          build: {
            outDir: 'dist-electron',
            rollupOptions: {
              external: [
                'better-sqlite3',
                'koffi',
                'fsevents'
              ],
              output: {
                entryFileNames: 'wcdbWorker.js',
                codeSplitting: false
              }
            }
          }
        }
      },
      {
        entry: 'electron/transcribeWorker.ts',
        onstart: handleElectronOnStart,
        vite: {
          build: {
            outDir: 'dist-electron',
            rollupOptions: {
              external: [
                'sherpa-onnx-node'
              ],
              output: {
                entryFileNames: 'transcribeWorker.js',
                codeSplitting: false
              }
            }
          }
        }
      },
      {
        entry: 'electron/exportWorker.ts',
        onstart: handleElectronOnStart,
        vite: {
          plugins: [exportWorkerElectronShimPlugin()],
          build: {
            outDir: 'dist-electron',
            rollupOptions: {
              external: [
                'better-sqlite3',
                'koffi',
                'fsevents',
                'exceljs'
              ],
              output: {
                entryFileNames: 'exportWorker.js',
                codeSplitting: false
              }
            }
          }
        }
      },
      {
        entry: 'electron/apiMessageWorker.ts',
        onstart: handleElectronOnStart,
        vite: {
          build: {
            outDir: 'dist-electron',
            rollupOptions: {
              output: {
                entryFileNames: 'apiMessageWorker.js',
                codeSplitting: false
              }
            }
          }
        }
      },
      {
        entry: 'electron/agentRunWorker.ts',
        onstart: handleElectronOnStart,
        vite: {
          plugins: [exportWorkerElectronShimPlugin(), copyJiebaNodeWasmPlugin()],
          build: {
            outDir: 'dist-electron',
            rollupOptions: {
              external: [
                'better-sqlite3',
                'koffi',
                'fsevents',
                'whisper-node',
                'sherpa-onnx-node',
                'shelljs',
                'exceljs',
                'node-llama-cpp',
                '@vscode/sudo-prompt',
                'silk-wasm',
                '@hicccc77/electron-liquid-glass'
              ],
              output: {
                entryFileNames: 'agentRunWorker.js',
                codeSplitting: false
              }
            }
          }
        }
      },
      {
        entry: 'electron/agentTitleWorker.ts',
        onstart: handleElectronOnStart,
        vite: {
          plugins: [exportWorkerElectronShimPlugin()],
          build: {
            outDir: 'dist-electron',
            rollupOptions: {
              output: {
                entryFileNames: 'agentTitleWorker.js',
                codeSplitting: false
              }
            }
          }
        }
      },
      {
        entry: 'electron/preload.ts',
        onstart: handleElectronOnStart,
        vite: {
          build: {
            outDir: 'dist-electron'
          }
        }
      }
    ])
  ],
  resolve: {
    dedupe: ['react', 'react-dom'],
    alias: {
      '@': resolve(process.cwd(), 'src')
    }
  }
})
