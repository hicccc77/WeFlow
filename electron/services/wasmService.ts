
import path from 'path';
import fs from 'fs';
import vm from 'vm';

let app: any;
try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    app = require('electron').app;
} catch (e) {
    app = { isPackaged: false };
}

// This service handles the loading and execution of the WeChat WASM module
// to generate the correct Isaac64 keystream for video decryption.
export class WasmService {
    private static instance: WasmService;
    private module: any = null;
    private wasmLoaded = false;
    private initPromise: Promise<void> | null = null;
    private capturedKeystream: Uint8Array | null = null;

    private constructor() { }

    public static getInstance(): WasmService {
        if (!WasmService.instance) {
            WasmService.instance = new WasmService();
        }
        return WasmService.instance;
    }

    private async init(): Promise<void> {
        if (this.wasmLoaded) return;
        if (this.initPromise) return this.initPromise;

        this.initPromise = new Promise((resolve, reject) => {
            try {
                // For dev, files are in electron/assets/wasm
                // __dirname in dev (from dist-electron) is .../dist-electron
                // So we need to go up one level and then into electron/assets/wasm
                const isDev = !app.isPackaged;
                const basePath = isDev
                    ? path.join(__dirname, '../electron/assets/wasm')
                    : path.join(process.resourcesPath, 'assets/wasm'); // Adjust as needed for production build

                const wasmPath = path.join(basePath, 'wasm_video_decode.wasm');
                const jsPath = path.join(basePath, 'wasm_video_decode.js');


                if (!fs.existsSync(wasmPath) || !fs.existsSync(jsPath)) {
                    throw new Error(`WASM files not found at ${basePath}`);
                }

                const wasmBinary = fs.readFileSync(wasmPath);

                // Emulate Emscripten environment
                // We must use 'any' for global mocking
                const mockGlobal: any = {
                    console: console,
                    Buffer: Buffer,
                    Uint8Array: Uint8Array,
                    Int8Array: Int8Array,
                    Uint16Array: Uint16Array,
                    Int16Array: Int16Array,
                    Uint32Array: Uint32Array,
                    Int32Array: Int32Array,
                    Float32Array: Float32Array,
                    Float64Array: Float64Array,
                    BigInt64Array: BigInt64Array,
                    BigUint64Array: BigUint64Array,
                    Array: Array,
                    Object: Object,
                    Function: Function,
                    String: String,
                    Number: Number,
                    Boolean: Boolean,
                    Error: Error,
                    Promise: Promise,
                    require: require,
                    process: process,
                    setTimeout: setTimeout,
                    clearTimeout: clearTimeout,
                    setInterval: setInterval,
                    clearInterval: clearInterval,
                };

                // Define Module
                mockGlobal.Module = {
                    onRuntimeInitialized: () => {
                        this.wasmLoaded = true;
                        resolve();
                    },
                    wasmBinary: wasmBinary,
                    print: (text: string) => console.log('[WASM stdout]', text),
                    printErr: (text: string) => console.error('[WASM stderr]', text)
                };

                // Define necessary globals for Emscripten loader
                mockGlobal.self = mockGlobal;
                mockGlobal.self.location = { href: jsPath };
                mockGlobal.WorkerGlobalScope = function () { };
                mockGlobal.VTS_WASM_URL = `file://${wasmPath}`; // Needs a URL, file protocol works in Node context for our mock?

                // Define the callback function that WASM calls to return data
                // The WASM module calls `wasm_isaac_generate(ptr, size)`
                mockGlobal.wasm_isaac_generate = (ptr: number, size: number) => {
                    // console.log(`[WasmService] wasm_isaac_generate called: ptr=${ptr}, size=${size}`);
                    const buffer = new Uint8Array(mockGlobal.Module.HEAPU8.buffer, ptr, size);
                    // Copy the data because WASM memory might change or be invalidated
                    this.capturedKeystream = new Uint8Array(buffer);
                };

                // Execute the loader script in the context
                const jsContent = fs.readFileSync(jsPath, 'utf8');
                const script = new vm.Script(jsContent, { filename: jsPath });

                // create context
                const context = vm.createContext(mockGlobal);
                script.runInContext(context);

                // Store reference to module
                this.module = mockGlobal.Module;

            } catch (error) {
                console.error('[WasmService] Failed to initialize WASM:', error);
                reject(error);
            }
        });

        return this.initPromise;
    }

    public async getKeystream(key: string, size: number = 131072): Promise<Buffer> {
        // ISAAC-64 uses 8-byte blocks. If size is not a multiple of 8,
        // the global reverse() will cause a shift in alignment.
        const alignSize = Math.ceil(size / 8) * 8;
        const buffer = await this.getRawKeystream(key, alignSize);

        // Reverse the entire aligned buffer
        const reversed = new Uint8Array(buffer);
        reversed.reverse();

        // Return exactly the requested size from the beginning of the reversed stream.
        // Since we reversed the 'aligned' buffer, index 0 is the last byte of the last block.
        return Buffer.from(reversed).subarray(0, size);
    }

    public async getRawKeystream(key: string, size: number = 131072): Promise<Buffer> {
        await this.init();

        if (!this.module || !this.module.WxIsaac64) {
            if (this.module.asm && this.module.asm.WxIsaac64) {
                this.module.WxIsaac64 = this.module.asm.WxIsaac64;
            }
        }

        if (!this.module.WxIsaac64) {
            throw new Error('[WasmService] WxIsaac64 not found in WASM module');
        }

        try {
            this.capturedKeystream = null;
            const isaac = new this.module.WxIsaac64(key);
            isaac.generate(size);

            if (isaac.delete) {
                isaac.delete();
            }

            if (this.capturedKeystream) {
                return Buffer.from(this.capturedKeystream);
            } else {
                throw new Error('[WasmService] Failed to capture keystream (callback not called)');
            }
        } catch (error) {
            console.error('[WasmService] Error generating raw keystream:', error);
            throw error;
        }
    }
}
