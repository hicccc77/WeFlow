/**
 * ISAAC-64: A fast cryptographic PRNG
 * Re-implemented in TypeScript using BigInt for 64-bit support.
 * Used for WeChat Channels/SNS video decryption.
 */

export class Isaac64 {
    private mm = new BigUint64Array(256);
    private aa = 0n;
    private bb = 0n;
    private cc = 0n;
    private randrsl = new BigUint64Array(256);
    private randcnt = 0;
    private static readonly MASK = 0xFFFFFFFFFFFFFFFFn;

    constructor(seed: number | string | bigint) {
        const seedBig = BigInt(seed);
        // 通常单密钥初始化是将密钥放在第一个槽位，其余清零（或者按某种规律填充）
        // 这里我们尝试仅设置第一个槽位，这在很多 WASM 移植版本中更为常见
        this.randrsl.fill(0n);
        this.randrsl[0] = seedBig;
        this.init(true);
    }

    private init(flag: boolean) {
        let a: bigint, b: bigint, c: bigint, d: bigint, e: bigint, f: bigint, g: bigint, h: bigint;
        a = b = c = d = e = f = g = h = 0x9e3779b97f4a7c15n;

        const mix = () => {
            a = (a - e) & Isaac64.MASK; f ^= (h >> 9n); h = (h + a) & Isaac64.MASK;
            b = (b - f) & Isaac64.MASK; g ^= (a << 9n) & Isaac64.MASK; a = (a + b) & Isaac64.MASK;
            c = (c - g) & Isaac64.MASK; h ^= (b >> 23n); b = (b + c) & Isaac64.MASK;
            d = (d - h) & Isaac64.MASK; a ^= (c << 15n) & Isaac64.MASK; c = (c + d) & Isaac64.MASK;
            e = (e - a) & Isaac64.MASK; b ^= (d >> 14n); d = (d + e) & Isaac64.MASK;
            f = (f - b) & Isaac64.MASK; c ^= (e << 20n) & Isaac64.MASK; e = (e + f) & Isaac64.MASK;
            g = (g - c) & Isaac64.MASK; d ^= (f >> 17n); f = (f + g) & Isaac64.MASK;
            h = (h - d) & Isaac64.MASK; e ^= (g << 14n) & Isaac64.MASK; g = (g + h) & Isaac64.MASK;
        };

        for (let i = 0; i < 4; i++) mix();

        for (let i = 0; i < 256; i += 8) {
            if (flag) {
                a = (a + this.randrsl[i]) & Isaac64.MASK;
                b = (b + this.randrsl[i + 1]) & Isaac64.MASK;
                c = (c + this.randrsl[i + 2]) & Isaac64.MASK;
                d = (d + this.randrsl[i + 3]) & Isaac64.MASK;
                e = (e + this.randrsl[i + 4]) & Isaac64.MASK;
                f = (f + this.randrsl[i + 5]) & Isaac64.MASK;
                g = (g + this.randrsl[i + 6]) & Isaac64.MASK;
                h = (h + this.randrsl[i + 7]) & Isaac64.MASK;
            }
            mix();
            this.mm[i] = a; this.mm[i + 1] = b; this.mm[i + 2] = c; this.mm[i + 3] = d;
            this.mm[i + 4] = e; this.mm[i + 5] = f; this.mm[i + 6] = g; this.mm[i + 7] = h;
        }

        if (flag) {
            for (let i = 0; i < 256; i += 8) {
                a = (a + this.mm[i]) & Isaac64.MASK;
                b = (b + this.mm[i + 1]) & Isaac64.MASK;
                c = (c + this.mm[i + 2]) & Isaac64.MASK;
                d = (d + this.mm[i + 3]) & Isaac64.MASK;
                e = (e + this.mm[i + 4]) & Isaac64.MASK;
                f = (f + this.mm[i + 5]) & Isaac64.MASK;
                g = (g + this.mm[i + 6]) & Isaac64.MASK;
                h = (h + this.mm[i + 7]) & Isaac64.MASK;
                mix();
                this.mm[i] = a; this.mm[i + 1] = b; this.mm[i + 2] = c; this.mm[i + 3] = d;
                this.mm[i + 4] = e; this.mm[i + 5] = f; this.mm[i + 6] = g; this.mm[i + 7] = h;
            }
        }

        this.isaac64();
        this.randcnt = 256;
    }

    private isaac64() {
        this.cc = (this.cc + 1n) & Isaac64.MASK;
        this.bb = (this.bb + this.cc) & Isaac64.MASK;
        for (let i = 0; i < 256; i++) {
            let x = this.mm[i];
            switch (i & 3) {
                case 0: this.aa = (this.aa ^ (((this.aa << 21n) & Isaac64.MASK) ^ Isaac64.MASK)) & Isaac64.MASK; break;
                case 1: this.aa = (this.aa ^ (this.aa >> 5n)) & Isaac64.MASK; break;
                case 2: this.aa = (this.aa ^ ((this.aa << 12n) & Isaac64.MASK)) & Isaac64.MASK; break;
                case 3: this.aa = (this.aa ^ (this.aa >> 33n)) & Isaac64.MASK; break;
            }
            this.aa = (this.mm[(i + 128) & 255] + this.aa) & Isaac64.MASK;
            const y = (this.mm[Number(x >> 3n) & 255] + this.aa + this.bb) & Isaac64.MASK;
            this.mm[i] = y;
            this.bb = (this.mm[Number(y >> 11n) & 255] + x) & Isaac64.MASK;
            this.randrsl[i] = this.bb;
        }
    }

    public getNext(): bigint {
        if (this.randcnt === 0) {
            this.isaac64();
            this.randcnt = 256;
        }
        return this.randrsl[256 - (this.randcnt--)];
    }

    /**
     * Generates a keystream of the specified size (in bytes).
     * @param size Size of the keystream in bytes (must be multiple of 8)
     * @returns Buffer containing the keystream
     */
    public generateKeystream(size: number): Buffer {
        const stream = new BigUint64Array(size / 8);
        for (let i = 0; i < stream.length; i++) {
            stream[i] = this.getNext();
        }
        // WeChat's logic specifically reverses the entire byte array
        const buffer = Buffer.from(stream.buffer);
        // 注意：根据 worker.html 的逻辑，它是对 Uint8Array 执行 reverse()
        // Array.from(wasmArray).reverse()
        return buffer.reverse();
    }
}
