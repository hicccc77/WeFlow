const { spawnSync } = require('child_process')
const { copyFileSync, mkdirSync, existsSync } = require('fs')
const { join } = require('path')

const root = join(__dirname, '..')
const projectDir = join(root, 'native', 'weflow-exporter')
const cargoName = process.platform === 'win32' ? 'cargo.exe' : 'cargo'
const cargoHomePath = process.platform === 'win32' && process.env.USERPROFILE
  ? join(process.env.USERPROFILE, '.cargo', 'bin', cargoName)
  : ''
const cargo = cargoHomePath && existsSync(cargoHomePath) ? cargoHomePath : cargoName
const rustup = process.platform === 'win32' && process.env.USERPROFILE
  ? join(process.env.USERPROFILE, '.cargo', 'bin', 'rustup.exe')
  : 'rustup'

const hasMsvcLinker = process.platform !== 'win32' || spawnSync('where.exe', ['link'], { encoding: 'utf8' }).status === 0
const hasGnuToolchain = process.platform === 'win32' &&
  existsSync(rustup) &&
  spawnSync(rustup, ['toolchain', 'list'], { encoding: 'utf8' }).stdout.includes('stable-x86_64-pc-windows-gnu')

const args = []
if (process.platform === 'win32' && !hasMsvcLinker && hasGnuToolchain) {
  args.push('+stable-x86_64-pc-windows-gnu')
}
args.push('build', '--release')

const build = spawnSync(cargo, args, {
  cwd: projectDir,
  stdio: 'inherit'
})

if (build.error && build.error.code === 'ENOENT') {
  console.error('[build-rust-exporter] cargo was not found. Install Rust to build the native exporter.')
  process.exit(1)
}
if (build.status !== 0) {
  process.exit(build.status || 1)
}

const executableName = process.platform === 'win32' ? 'weflow-exporter.exe' : 'weflow-exporter'
const source = join(projectDir, 'target', 'release', executableName)
if (!existsSync(source)) {
  console.error(`[build-rust-exporter] expected binary not found: ${source}`)
  process.exit(1)
}

const platformDir = process.platform === 'darwin' ? 'macos' : process.platform
const archDir = process.platform === 'darwin' ? 'universal' : process.arch
const destDir = join(root, 'resources', 'exporter', platformDir, archDir)
mkdirSync(destDir, { recursive: true })
copyFileSync(source, join(destDir, executableName))
console.log(`[build-rust-exporter] copied ${executableName} to ${destDir}`)
