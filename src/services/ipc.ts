// Electron IPC 通信封装

// 配置
export const config = {
  get: (key: string) => window.electronAPI.config.get(key),
  set: async (key: string, value: unknown) => {
    await window.electronAPI.config.set(key, value)
    window.dispatchEvent(new CustomEvent('weflow:config-changed', { detail: { key } }))
  },
  clear: () => window.electronAPI.config.clear()
}

// 对话框
export const dialog = {
  openFile: (options?: Electron.OpenDialogOptions) => 
    window.electronAPI.dialog.openFile(options),
  saveFile: (options?: Electron.SaveDialogOptions) => 
    window.electronAPI.dialog.saveFile(options)
}

// 窗口控制
export const windowControl = {
  minimize: () => window.electronAPI.window.minimize(),
  maximize: () => window.electronAPI.window.maximize(),
  close: () => window.electronAPI.window.close()
}
