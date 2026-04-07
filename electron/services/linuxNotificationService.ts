import https from "https";
import http, { IncomingMessage } from "http";
import { promises as fs } from "fs";
import { join } from "path";
import { app, Notification } from "electron";

export interface LinuxNotificationData {
  sessionId?: string;
  title: string;
  content: string;
  avatarUrl?: string;
  expireTimeout?: number;
}

type NotificationCallback = (sessionId: string) => void;

let notificationCallbacks: NotificationCallback[] = [];
let notificationCounter = 1;
const activeNotifications: Map<number, Notification> = new Map();
const closeTimers: Map<number, NodeJS.Timeout> = new Map();

// 头像缓存：url->localFilePath
const avatarCache: Map<string, string> = new Map();
// 缓存目录
let avatarCacheDir: string | null = null;

function nextNotificationId(): number {
  const id = notificationCounter;
  notificationCounter += 1;
  return id;
}

function clearNotificationState(notificationId: number): void {
  activeNotifications.delete(notificationId);
  const timer = closeTimers.get(notificationId);
  if (timer) {
    clearTimeout(timer);
    closeTimers.delete(notificationId);
  }
}

// 确保缓存目录存在
async function ensureCacheDir(): Promise<string> {
  if (!avatarCacheDir) {
    avatarCacheDir = join(app.getPath("temp"), "weflow-avatars");
    try {
      await fs.mkdir(avatarCacheDir, { recursive: true });
    } catch (error) {
      console.error(
        "[LinuxNotification] Failed to create avatar cache dir:",
        error,
      );
    }
  }
  return avatarCacheDir;
}

// 下载头像到本地临时文件
async function downloadAvatarToLocal(url: string): Promise<string | null> {
  // 检查缓存
  if (avatarCache.has(url)) {
    return avatarCache.get(url) || null;
  }

  try {
    const cacheDir = await ensureCacheDir();
    // 生成唯一文件名
    const fileName = `avatar_${Date.now()}_${Math.random().toString(36).substring(2, 8)}.png`;
    const localPath = join(cacheDir, fileName);

    await new Promise<void>((resolve, reject) => {
      // 微信 CDN 需要特殊的请求头才能下载图片
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
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", async () => {
          try {
            const buffer = Buffer.concat(chunks);
            await fs.writeFile(localPath, buffer);
            avatarCache.set(url, localPath);
            resolve();
          } catch (err) {
            reject(err);
          }
        });
        res.on("error", reject);
      };

      const req = url.startsWith("https")
        ? https.get(url, options, callback)
        : http.get(url, options, callback);

      req.on("error", reject);
      req.setTimeout(10000, () => {
        req.destroy();
        reject(new Error("Download timeout"));
      });
    });

    console.log(
      `[LinuxNotification] Avatar downloaded: ${url} -> ${localPath}`,
    );
    return localPath;
  } catch (error) {
    console.error("[LinuxNotification] Failed to download avatar:", error);
    return null;
  }
}

function triggerNotificationCallback(sessionId: string): void {
  for (const callback of notificationCallbacks) {
    try {
      callback(sessionId);
    } catch (error) {
      console.error("[LinuxNotification] Callback error:", error);
    }
  }
}

export async function showLinuxNotification(
  data: LinuxNotificationData,
): Promise<number | null> {
  if (process.platform !== "linux") {
    return null;
  }

  if (!Notification.isSupported()) {
    console.warn("[LinuxNotification] Notification API is not supported");
    return null;
  }

  try {
    let iconPath: string | undefined;
    if (data.avatarUrl) {
      iconPath = (await downloadAvatarToLocal(data.avatarUrl)) || undefined;
    }

    const notification = new Notification({
      title: data.title,
      body: data.content,
      icon: iconPath,
    });

    const notificationId = nextNotificationId();
    activeNotifications.set(notificationId, notification);

    notification.on("click", () => {
      if (data.sessionId) {
        triggerNotificationCallback(data.sessionId);
      }
    });

    notification.on("close", () => {
      clearNotificationState(notificationId);
    });

    notification.on("failed", (_, error) => {
      console.error("[LinuxNotification] Notification failed:", error);
      clearNotificationState(notificationId);
    });

    const expireTimeout = data.expireTimeout ?? 5000;
    if (expireTimeout > 0) {
      const timer = setTimeout(() => {
        const currentNotification = activeNotifications.get(notificationId);
        if (currentNotification) {
          currentNotification.close();
        }
      }, expireTimeout);
      closeTimers.set(notificationId, timer);
    }

    notification.show();

    console.log(
      `[LinuxNotification] Shown notification ${notificationId}: ${data.title}`,
    );

    return notificationId;
  } catch (error) {
    console.error("[LinuxNotification] Failed to show notification:", error);
    return null;
  }
}

export async function closeLinuxNotification(
  notificationId: number,
): Promise<void> {
  const notification = activeNotifications.get(notificationId);
  if (!notification) return;
  notification.close();
  clearNotificationState(notificationId);
}

export async function getCapabilities(): Promise<string[]> {
  if (process.platform !== "linux") {
    return [];
  }

  if (!Notification.isSupported()) {
    return [];
  }

  return ["native-notification", "click"];
}

export function onNotificationAction(callback: NotificationCallback): void {
  notificationCallbacks.push(callback);
}

export function removeNotificationCallback(
  callback: NotificationCallback,
): void {
  const index = notificationCallbacks.indexOf(callback);
  if (index > -1) {
    notificationCallbacks.splice(index, 1);
  }
}

export async function initLinuxNotificationService(): Promise<void> {
  if (process.platform !== "linux") {
    console.log("[LinuxNotification] Not on Linux, skipping init");
    return;
  }

  if (!Notification.isSupported()) {
    console.warn("[LinuxNotification] Notification API is not supported");
    return;
  }

  const caps = await getCapabilities();
  console.log("[LinuxNotification] Service initialized with native API:", caps);
}
