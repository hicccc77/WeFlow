import { Notification } from "electron";
import { avatarFileCache, AvatarFileCacheService } from "./avatarFileCacheService";

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

export async function shutdownLinuxNotificationService(): Promise<void> {
  // 清理所有活动的通知
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

  console.log("[LinuxNotification] Service shutdown complete");
}
