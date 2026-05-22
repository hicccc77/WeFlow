import { createRequire } from 'module'
import { dirname, join } from 'path'
import { existsSync } from 'fs'

function resolveRequireAnchor(): string {
  if (typeof __filename === 'string' && __filename.length > 0) {
    return __filename
  }
  const candidates = [
    process.argv[1],
    join(process.cwd(), 'package.json'),
    join(process.cwd(), 'dist-electron', 'exportWorker.js'),
    join(process.cwd(), 'dist-electron', 'main.js')
  ].filter((value): value is string => typeof value === 'string' && value.length > 0 && existsSync(value))
  return candidates[0] || join(process.cwd(), 'package.json')
}

/** Node require anchored for silk-wasm (must stay external, not bundled). */
const nodeRequire = createRequire(resolveRequireAnchor())

export type SilkWasmModule = {
  decode: (input: Buffer, sampleRate: number) => Promise<{ data: Uint8Array; duration: number }>
}

export function loadSilkWasmModule(): SilkWasmModule {
  return nodeRequire('silk-wasm') as SilkWasmModule
}

export function resolveSilkWasmFilePath(): string | null {
  try {
    const pkgPath = nodeRequire.resolve('silk-wasm/package.json')
    const wasmPath = join(dirname(pkgPath), 'lib', 'silk.wasm')
    return existsSync(wasmPath) ? wasmPath : null
  } catch {
    return null
  }
}
