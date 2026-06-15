import https from "https";
import http, { IncomingMessage } from "http";
import { promises as fs } from "fs";
import { join } from "path";
import { ConfigService } from "./config";

// 头像文件缓存服务 - 复用项目已有的缓存目录结构
export class AvatarFileCacheService {
  private static instance: AvatarFileCacheService | null = null;

  // 头像文件缓存目录
  private readonly cacheDir: string;
  // 头像URL -> 本地文件路径的内存缓存（仅追踪正在下载的）
  private readonly pendingDownloads: Map<string, Promise<string | null>> =
    new Map();
  // LRU 追踪：文件路径->最后访问时间
  private readonly lruOrder: string[] = [];
  private readonly maxCacheFiles = 100;

  private constructor() {
    const basePath = ConfigService.getInstance().getCacheBasePath();
    this.cacheDir = join(basePath, "avatar-files");
    this.ensureCacheDir();
    this.loadLruOrder();
  }

  public static getInstance(): AvatarFileCacheService {
    if (!AvatarFileCacheService.instance) {
      AvatarFileCacheService.instance = new AvatarFileCacheService();
    }
    return AvatarFileCacheService.instance;
  }

  private ensureCacheDir(): void {
    // 同步确保目录存在（构造函数调用）
    try {
      fs.mkdir(this.cacheDir, { recursive: true }).catch(() => {});
    } catch {}
  }

  private async ensureCacheDirAsync(): Promise<void> {
    try {
      await fs.mkdir(this.cacheDir, { recursive: true });
    } catch {}
  }

  private getFilePath(url: string): string {
    // 使用URL的hash作为文件名，避免特殊字符问题
    const hash = this.hashString(url);
    return join(this.cacheDir, `avatar_${hash}.png`);
  }

  private hashString(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash; // 转换为32位整数
    }
    return Math.abs(hash).toString(16);
  }

  private async loadLruOrder(): Promise<void> {
    try {
      const entries = await fs.readdir(this.cacheDir);
      // 按修改时间排序（旧的在前）
      const filesWithTime: { file: string; mtime: number }[] = [];
      for (const entry of entries) {
        if (!entry.startsWith("avatar_") || !entry.endsWith(".png")) continue;
        try {
          const stat = await fs.stat(join(this.cacheDir, entry));
          filesWithTime.push({ file: entry, mtime: stat.mtimeMs });
        } catch {}
      }
      filesWithTime.sort((a, b) => a.mtime - b.mtime);
      this.lruOrder.length = 0;
      this.lruOrder.push(...filesWithTime.map((f) => f.file));
    } catch {}
  }

  private updateLru(fileName: string): void {
    const index = this.lruOrder.indexOf(fileName);
    if (index > -1) {
      this.lruOrder.splice(index, 1);
    }
    this.lruOrder.push(fileName);
  }

  private async evictIfNeeded(): Promise<void> {
    while (this.lruOrder.length >= this.maxCacheFiles) {
      const oldest = this.lruOrder.shift();
      if (oldest) {
        try {
          await fs.rm(join(this.cacheDir, oldest));
          console.log(`[AvatarFileCache] Evicted: ${oldest}`);
        } catch {}
      }
    }
  }

  private async downloadAvatar(url: string): Promise<string | null> {
    const localPath = this.getFilePath(url);

    // 检查文件是否已存在
    try {
      await fs.access(localPath);
      const fileName = localPath.split("/").pop()!;
      this.updateLru(fileName);
      return localPath;
    } catch {}

    await this.ensureCacheDirAsync();
    await this.evictIfNeeded();

    return new Promise<string | null>((resolve) => {
      const options = {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/107.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) WindowsWechat(0x63090719) XWEB/8351",
          Referer: "https://servicewechat.com/",
          Accept:
            "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
          "Accept-Encoding": "gzip, deflate, br",
          "Accept-Language": "zh-CN,zh;q=0.9",
          Connection: "keep-alive",
        },
      };

      const callback = (res: IncomingMessage) => {
        if (res.statusCode !== 200) {
          resolve(null);
          return;
        }
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", async () => {
          try {
            const buffer = Buffer.concat(chunks);
            await fs.writeFile(localPath, buffer);
            const fileName = localPath.split("/").pop()!;
            this.updateLru(fileName);
            console.log(
              `[AvatarFileCache] Downloaded: ${url.substring(0, 50)}... -> ${localPath}`,
            );
            resolve(localPath);
          } catch {
            resolve(null);
          }
        });
        res.on("error", () => resolve(null));
      };

      const req = url.startsWith("https")
        ? https.get(url, options, callback)
        : http.get(url, options, callback);

      req.on("error", () => resolve(null));
      req.setTimeout(10000, () => {
        req.destroy();
        resolve(null);
      });
    });
  }

  /**
   * 获取头像本地文件路径，如果需要会下载
   * 同一URL并发调用会复用同一个下载任务
   */
  async getAvatarPath(url: string): Promise<string | null> {
    if (!url) return null;

    // 检查是否有正在进行的下载
    const pending = this.pendingDownloads.get(url);
    if (pending) {
      return pending;
    }

    // 发起新下载
    const downloadPromise = this.downloadAvatar(url);
    this.pendingDownloads.set(url, downloadPromise);

    try {
      const result = await downloadPromise;
      return result;
    } finally {
      this.pendingDownloads.delete(url);
    }
  }

  // 清理所有缓存文件（App退出时调用）
  async clearCache(): Promise<void> {
    try {
      const entries = await fs.readdir(this.cacheDir);
      for (const entry of entries) {
        if (entry.startsWith("avatar_") && entry.endsWith(".png")) {
          try {
            await fs.rm(join(this.cacheDir, entry));
          } catch {}
        }
      }
      this.lruOrder.length = 0;
      console.log("[AvatarFileCache] Cache cleared");
    } catch {}
  }

  // 获取当前缓存的文件数量
  async getCacheCount(): Promise<number> {
    try {
      const entries = await fs.readdir(this.cacheDir);
      return entries.filter(
        (e) => e.startsWith("avatar_") && e.endsWith(".png"),
      ).length;
    } catch {
      return 0;
    }
  }
}

export const avatarFileCache = AvatarFileCacheService.getInstance();
