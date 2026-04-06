import dbus from "dbus-native";
import https from "https";
import http, { IncomingMessage } from "http";
import { promises as fs } from "fs";
import { join } from "path";
import { app } from "electron";

const BUS_NAME = "org.freedesktop.Notifications";
const OBJECT_PATH = "/org/freedesktop/Notifications";

export interface LinuxNotificationData {
  sessionId?: string;
  title: string;
  content: string;
  avatarUrl?: string;
  expireTimeout?: number;
}

type NotificationCallback = (sessionId: string) => void;

let sessionBus: dbus.DBusConnection | null = null;
let notificationCallbacks: NotificationCallback[] = [];
let pendingNotifications: Map<number, LinuxNotificationData> = new Map();

// 头像缓存：url->localFilePath
const avatarCache: Map<string, string> = new Map();
// 缓存目录
let avatarCacheDir: string | null = null;

async function getSessionBus(): Promise<dbus.DBusConnection> {
  if (!sessionBus) {
    sessionBus = dbus.sessionBus();

    // 挂载底层socket的error事件，防止掉线即可
    sessionBus.connection.on("error", (err: Error) => {
      console.error("[LinuxNotification] D-Bus connection error:", err);
      sessionBus = null; // 报错清理死对象
    });
  }
  return sessionBus;
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

export async function showLinuxNotification(
  data: LinuxNotificationData,
): Promise<number | null> {
  try {
    const bus = await getSessionBus();

    const appName = "WeFlow";
    const replaceId = 0;
    const expireTimeout = data.expireTimeout ?? 5000;

    // 处理头像：下载到本地或使用URL
    let appIcon = "";
    let hints: any[] = [];
    if (data.avatarUrl) {
      // 优先尝试下载到本地
      const localPath = await downloadAvatarToLocal(data.avatarUrl);
      if (localPath) {
        hints = [["image-path", ["s", localPath]]];
      }
    }

    return new Promise((resolve, reject) => {
      bus.invoke(
        {
          destination: BUS_NAME,
          path: OBJECT_PATH,
          interface: "org.freedesktop.Notifications",
          member: "Notify",
          signature: "susssasa{sv}i",
          body: [
            appName,
            replaceId,
            appIcon,
            data.title,
            data.content,
            ["default", "打开"], // 提供default action，否则系统不会抛出点击事件
            hints,
            // [],                  // 传空数组以避开a{sv}变体的序列化崩溃，有pendingNotifications映射维护保证不出错
            expireTimeout,
          ],
        },
        (err: Error | null, result: any) => {
          if (err) {
            console.error("[LinuxNotification] Notify error:", err);
            reject(err);
            return;
          }
          const notificationId =
            typeof result === "number" ? result : result[0];
          if (data.sessionId) {
            // 依赖Map实现点击追踪，没有使用D-Bus hints
            pendingNotifications.set(notificationId, data);
          }
          console.log(
            `[LinuxNotification] Shown notification ${notificationId}: ${data.title}, icon: ${appIcon || "none"}`,
          );
          resolve(notificationId);
        },
      );
    });
  } catch (error) {
    console.error("[LinuxNotification] Failed to show notification:", error);
    return null;
  }
}

export async function closeLinuxNotification(
  notificationId: number,
): Promise<void> {
  try {
    const bus = await getSessionBus();
    return new Promise((resolve, reject) => {
      bus.invoke(
        {
          destination: BUS_NAME,
          path: OBJECT_PATH,
          interface: "org.freedesktop.Notifications",
          member: "CloseNotification",
          signature: "u",
          body: [notificationId],
        },
        (err: Error | null) => {
          if (err) {
            console.error("[LinuxNotification] CloseNotification error:", err);
            reject(err);
            return;
          }
          pendingNotifications.delete(notificationId);
          resolve();
        },
      );
    });
  } catch (error) {
    console.error("[LinuxNotification] Failed to close notification:", error);
  }
}

export async function getCapabilities(): Promise<string[]> {
  try {
    const bus = await getSessionBus();
    return new Promise((resolve, reject) => {
      bus.invoke(
        {
          destination: BUS_NAME,
          path: OBJECT_PATH,
          interface: "org.freedesktop.Notifications",
          member: "GetCapabilities",
        },
        (err: Error | null, result: any) => {
          if (err) {
            console.error("[LinuxNotification] GetCapabilities error:", err);
            reject(err);
            return;
          }
          resolve(result as string[]);
        },
      );
    });
  } catch (error) {
    console.error("[LinuxNotification] Failed to get capabilities:", error);
    return [];
  }
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

function triggerNotificationCallback(sessionId: string): void {
  for (const callback of notificationCallbacks) {
    try {
      callback(sessionId);
    } catch (error) {
      console.error("[LinuxNotification] Callback error:", error);
    }
  }
}

export async function initLinuxNotificationService(): Promise<void> {
  if (process.platform !== "linux") {
    console.log("[LinuxNotification] Not on Linux, skipping init");
    return;
  }

  try {
    const bus = await getSessionBus();

    // 监听底层connection的message事件
    bus.connection.on("message", (msg: any) => {
      // type 4表示SIGNAL
      if (
        msg.type === 4 &&
        msg.path === OBJECT_PATH &&
        msg.interface === "org.freedesktop.Notifications"
      ) {
        if (msg.member === "ActionInvoked") {
          const [notificationId, actionId] = msg.body;
          console.log(
            `[LinuxNotification] Action invoked: ${notificationId}, ${actionId}`,
          );

          // 如果用户点击了通知本体，actionId会是'default'
          if (actionId === "default") {
            const data = pendingNotifications.get(notificationId);
            if (data?.sessionId) {
              triggerNotificationCallback(data.sessionId);
            }
          }
        }

        if (msg.member === "NotificationClosed") {
          const [notificationId] = msg.body;
          pendingNotifications.delete(notificationId);
        }
      }
    });

    // AddMatch用来接收信号
    await new Promise<void>((resolve, reject) => {
      bus.invoke(
        {
          destination: "org.freedesktop.DBus",
          path: "/org/freedesktop/DBus",
          interface: "org.freedesktop.DBus",
          member: "AddMatch",
          signature: "s",
          body: ["type='signal',interface='org.freedesktop.Notifications'"],
        },
        (err: Error | null) => {
          if (err) {
            console.error("[LinuxNotification] AddMatch error:", err);
            reject(err);
            return;
          }
          resolve();
        },
      );
    });

    console.log("[LinuxNotification] Service initialized");

    // 打印相关日志
    const caps = await getCapabilities();
    console.log("[LinuxNotification] Server capabilities:", caps);
  } catch (error) {
    console.error("[LinuxNotification] Failed to initialize:", error);
  }
}
