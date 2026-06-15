// 数据收集服务前端接口

export async function initCloudControl() {
  return window.electronAPI.cloud.init()
}

export function recordPage(pageName: string) {
  window.electronAPI.cloud.recordPage(pageName)
}
