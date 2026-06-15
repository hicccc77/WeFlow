import { wcdbService } from './wcdbService'
import { BrowserWindow } from 'electron'

export class WindowsHelloService {
    private verificationPromise: Promise<{ success: boolean; error?: string }> | null = null

    /**
     * 验证 Windows Hello
     * @param message 提示信息
     */
    async verify(message: string = '请验证您的身份以解锁 WeFlow', targetWindow?: BrowserWindow): Promise<{ success: boolean; error?: string }> {
        // Prevent concurrent verification requests
        if (this.verificationPromise) {
            return this.verificationPromise
        }

        // 获取窗口句柄: 优先使用传入的窗口，否则尝试获取焦点窗口，最后兜底主窗口
        const window = targetWindow || BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0]
        const hwndBuffer = window?.getNativeWindowHandle()
        // Convert buffer to int string for transport
        const hwndStr = hwndBuffer ? BigInt('0x' + hwndBuffer.toString('hex')).toString() : undefined

        this.verificationPromise = wcdbService.verifyUser(message, hwndStr)
            .finally(() => {
                this.verificationPromise = null
            })

        return this.verificationPromise
    }
}

export const windowsHelloService = new WindowsHelloService()
