/*
 * image_scan_helper - 轻量包装程序
 * 加载 libwx_key.dylib 并调用 ScanMemoryForImageKey
 * 用法: image_scan_helper <pid> <ciphertext_hex>
 * 输出: JSON {"success":true,"aesKey":"..."} 或 {"success":false,"error":"..."}
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <dlfcn.h>
#include <libgen.h>
#include <mach-o/dyld.h>

typedef const char* (*ScanMemoryForImageKeyFn)(int pid, const char* ciphertext);
typedef void (*FreeStringFn)(const char* str);

int main(int argc, char* argv[]) {
    if (argc != 3) {
        fprintf(stderr, "Usage: %s <pid> <ciphertext_hex>\n", argv[0]);
        printf("{\"success\":false,\"error\":\"invalid arguments\"}\n");
        return 1;
    }

    int pid = atoi(argv[1]);
    const char* ciphertext_hex = argv[2];

    if (pid <= 0) {
        printf("{\"success\":false,\"error\":\"invalid pid\"}\n");
        return 1;
    }

    /* 定位 dylib: 与自身同目录下的 libwx_key.dylib */
    char exe_path[4096];
    uint32_t size = sizeof(exe_path);
    if (_NSGetExecutablePath(exe_path, &size) != 0) {
        printf("{\"success\":false,\"error\":\"cannot get executable path\"}\n");
        return 1;
    }

    char* dir = dirname(exe_path);
    char dylib_path[4096];
    snprintf(dylib_path, sizeof(dylib_path), "%s/libwx_key.dylib", dir);

    void* handle = dlopen(dylib_path, RTLD_LAZY);
    if (!handle) {
        printf("{\"success\":false,\"error\":\"dlopen failed: %s\"}\n", dlerror());
        return 1;
    }

    ScanMemoryForImageKeyFn scan_fn = (ScanMemoryForImageKeyFn)dlsym(handle, "ScanMemoryForImageKey");
    if (!scan_fn) {
        printf("{\"success\":false,\"error\":\"symbol not found: ScanMemoryForImageKey\"}\n");
        dlclose(handle);
        return 1;
    }

    FreeStringFn free_fn = (FreeStringFn)dlsym(handle, "FreeString");

    fprintf(stderr, "[image_scan_helper] calling ScanMemoryForImageKey(pid=%d, ciphertext=%s)\n", pid, ciphertext_hex);

    const char* result = scan_fn(pid, ciphertext_hex);

    if (result && strlen(result) > 0) {
        /* 检查是否是错误 */
        if (strncmp(result, "ERROR", 5) == 0) {
            printf("{\"success\":false,\"error\":\"%s\"}\n", result);
        } else {
            printf("{\"success\":true,\"aesKey\":\"%s\"}\n", result);
        }
        if (free_fn) free_fn(result);
    } else {
        printf("{\"success\":false,\"error\":\"no key found\"}\n");
    }

    dlclose(handle);
    return 0;
}
