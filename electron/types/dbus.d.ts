declare module 'dbus-native' {
  namespace dbus {
    interface DBusConnection {
      invoke(options: any, callback: (err: Error | null, result?: any) => void): void;
      on(event: string, listener: Function): void;
      // 底层connection，用于监听signal
      connection: {
        on(event: string, listener: Function): void;
      };
    }

    // 声明sessionBus方法
    function sessionBus(): DBusConnection;
    function systemBus(): DBusConnection;
  }

  export = dbus;
}
