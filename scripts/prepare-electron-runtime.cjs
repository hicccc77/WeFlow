const fs = require('node:fs');
const path = require('node:path');

const runtimeNames = [
  'msvcp140.dll',
  'msvcp140_1.dll',
  'vcruntime140.dll',
  'vcruntime140_1.dll',
];

function copyIfDifferent(sourcePath, targetPath) {
  const source = fs.statSync(sourcePath);
  const targetExists = fs.existsSync(targetPath);

  if (targetExists) {
    const target = fs.statSync(targetPath);
    if (target.size === source.size && target.mtimeMs >= source.mtimeMs) {
      return false;
    }
  }

  fs.copyFileSync(sourcePath, targetPath);
  return true;
}

function main() {
  if (process.platform !== 'win32') {
    return;
  }

  const projectRoot = path.resolve(__dirname, '..');
  const sourceDir = path.join(projectRoot, 'resources', 'runtime', 'win32');
  const targetDir = path.join(projectRoot, 'node_modules', 'electron', 'dist');

  if (!fs.existsSync(sourceDir) || !fs.existsSync(targetDir)) {
    return;
  }

  let copiedCount = 0;

  for (const name of runtimeNames) {
    const sourcePath = path.join(sourceDir, name);
    const targetPath = path.join(targetDir, name);
    if (!fs.existsSync(sourcePath)) {
      continue;
    }
    if (copyIfDifferent(sourcePath, targetPath)) {
      copiedCount += 1;
    }
  }

  if (copiedCount > 0) {
    console.log(`[prepare-electron-runtime] synced ${copiedCount} runtime DLL(s) to ${targetDir}`);
  }
}

main();
