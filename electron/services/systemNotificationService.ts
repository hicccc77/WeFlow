import { Notification } from "electron";
import { avatarFileCache } from "./avatarFileCacheService";

// 系统通知服务（Linux / macOS）：走各自系统的通知中心（Linux 底层为
// D-Bus/libnotify，macOS 为通知中心），Windows 使用特制的液态玻璃通知窗口。
// 声音、勿扰模式、通知历史均由系统按用户设置管理

export interface SystemNotificationData {
  sessionId?: string;
  title: string;
  content: string;
  avatarUrl?: string;
  channel?: string;
  insightRecordId?: string;
  targetRoute?: string;
  expireTimeout?: number;
}

type NotificationCallback = (payload: unknown) => void;

const isSupportedPlatform =
  process.platform === "linux" || process.platform === "darwin";

let notificationCallbacks: NotificationCallback[] = [];
let notificationCounter = 1;
const activeNotifications: Map<number, Notification> = new Map();
const closeTimers: Map<number, NodeJS.Timeout> = new Map();

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

function triggerNotificationCallback(payload: unknown): void {
  for (const callback of notificationCallbacks) {
    try {
      callback(payload);
    } catch (error) {
      console.error("[SystemNotification] Callback error:", error);
    }
  }
}

export async function showSystemNotification(
  data: SystemNotificationData,
): Promise<number | null> {
  if (!isSupportedPlatform) {
    return null;
  }

  if (!Notification.isSupported()) {
    console.warn("[SystemNotification] Notification API is not supported");
    return null;
  }

  try {
    let iconPath: string | undefined;
    if (data.avatarUrl) {
      iconPath = (await avatarFileCache.getAvatarPath(data.avatarUrl)) || undefined;
    }

    const notification = new Notification({
      title: data.title,
      body: data.content,
      icon: iconPath,
    });

    const notificationId = nextNotificationId();
    activeNotifications.set(notificationId, notification);

    notification.on("click", () => {
      if (data.channel === "ai-insight" && data.insightRecordId) {
        triggerNotificationCallback({
          sessionId: data.sessionId,
          channel: data.channel,
          insightRecordId: data.insightRecordId,
          targetRoute: data.targetRoute,
        });
        return;
      }
      if (data.sessionId) {
        triggerNotificationCallback(data.sessionId);
      }
    });

    notification.on("close", () => {
      clearNotificationState(notificationId);
    });

    notification.on("failed", (_, error) => {
      console.error("[SystemNotification] Notification failed:", error);
      clearNotificationState(notificationId);
    });

    // Linux 的部分通知服务不会自动过期，需要手动关闭兜底；
    // macOS 横幅由系统自动收起并保留在通知中心，手动 close 反而会把它
    // 从通知中心移除，因此不做超时关闭
    const expireTimeout = data.expireTimeout ?? 5000;
    if (process.platform === "linux" && expireTimeout > 0) {
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
      `[SystemNotification] Shown notification ${notificationId}: ${data.title}`,
    );

    return notificationId;
  } catch (error) {
    console.error("[SystemNotification] Failed to show notification:", error);
    return null;
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

export async function initSystemNotificationService(): Promise<void> {
  if (!isSupportedPlatform) {
    console.log("[SystemNotification] Platform uses custom window, skipping init");
    return;
  }

  if (!Notification.isSupported()) {
    console.warn("[SystemNotification] Notification API is not supported");
    return;
  }

  console.log("[SystemNotification] Service initialized for", process.platform);
}

export async function shutdownSystemNotificationService(): Promise<void> {
  for (const [id, notification] of activeNotifications) {
    try {
      notification.close();
    } catch {}
    clearNotificationState(id);
  }

  // 清理头像文件缓存
  try {
    await avatarFileCache.clearCache();
  } catch {}

  console.log("[SystemNotification] Service shutdown complete");
}
