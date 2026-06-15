
// 全局头像加载队列管理器（限制并发，避免卡顿）
export class AvatarLoadQueue {
    private queue: Array<{ url: string; resolve: () => void; reject: (error: Error) => void }> = []
    private loading = new Map<string, Promise<void>>()
    private failed = new Map<string, number>()
    private activeCount = 0
    private readonly maxConcurrent = 3
    private readonly delayBetweenBatches = 10
    private readonly failedTtlMs = 10 * 60 * 1000

    private static instance: AvatarLoadQueue

    public static getInstance(): AvatarLoadQueue {
        if (!AvatarLoadQueue.instance) {
            AvatarLoadQueue.instance = new AvatarLoadQueue()
        }
        return AvatarLoadQueue.instance
    }

    async enqueue(url: string): Promise<void> {
        if (!url) return Promise.resolve()
        if (this.hasFailed(url)) {
            return Promise.reject(new Error(`Failed: ${url}`))
        }

        // 核心修复：防止重复并发请求同一个 URL
        const existingPromise = this.loading.get(url)
        if (existingPromise) {
            return existingPromise
        }

        const loadPromise = new Promise<void>((resolve, reject) => {
            this.queue.push({ url, resolve, reject })
            this.processQueue()
        })

        this.loading.set(url, loadPromise)
        void loadPromise.then(
            () => {
                this.loading.delete(url)
                this.clearFailed(url)
            },
            () => {
                this.loading.delete(url)
            }
        )

        return loadPromise
    }

    hasFailed(url: string): boolean {
        if (!url) return false
        const failedAt = this.failed.get(url)
        if (!failedAt) return false
        if (Date.now() - failedAt > this.failedTtlMs) {
            this.failed.delete(url)
            return false
        }
        return true
    }

    markFailed(url: string) {
        if (!url) return
        this.failed.set(url, Date.now())
    }

    clearFailed(url: string) {
        if (!url) return
        this.failed.delete(url)
    }

    private async processQueue() {
        if (this.activeCount >= this.maxConcurrent || this.queue.length === 0) {
            return
        }

        const task = this.queue.shift()
        if (!task) return

        this.activeCount++

        const img = new Image()
        img.referrerPolicy = 'no-referrer'
        img.onload = () => {
            this.activeCount--
            this.clearFailed(task.url)
            task.resolve()
            setTimeout(() => this.processQueue(), this.delayBetweenBatches)
        }
        img.onerror = () => {
            this.activeCount--
            this.markFailed(task.url)
            task.reject(new Error(`Failed: ${task.url}`))
            setTimeout(() => this.processQueue(), this.delayBetweenBatches)
        }
        img.src = task.url

        this.processQueue()
    }

    clear() {
        this.queue = []
        this.loading.clear()
        this.failed.clear()
        this.activeCount = 0
    }
}

export const avatarLoadQueue = AvatarLoadQueue.getInstance()
