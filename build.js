const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// create output directory
if (!fs.existsSync('compiler/build/')) {
  fs.mkdirSync('compiler/build/')
}

// create output directory
if (!fs.existsSync('compiler/build/std')) {
  fs.mkdirSync('compiler/build/std')
}

execSync('npm install', { cwd: 'compiler' });
execSync('npm run build', { cwd: 'compiler' });
copyFilesRecur('std', 'compiler/build/std', ['.chad']);
if (!process.argv.includes('compiler')) {
  execSync('npm install', { cwd: 'vscode' });
  execSync('npm run build', { cwd: 'vscode' });
}

let compilerDir = process.cwd() + '/' + 'compiler/build/index.js'
fs.writeFileSync('chad', `NODE_OPTIONS=--enable-source-maps node ${compilerDir} $@`);
fs.chmodSync('chad', 0o700);

console.log('build complete. to install cp ./chad to /bin')

function copyFilesRecur(srcDir, targetDir, extensions) {
  let files = fs.readdirSync(srcDir)
  for (let file of files) {
    const srcFilePath = path.join(srcDir, file);
    const targetFilePath = path.join(targetDir, file);

    let stats = fs.statSync(srcFilePath);
    if (stats.isDirectory()) {
      if (!fs.existsSync(targetFilePath)) {
        fs.mkdirSync(targetFilePath);
      }
      copyFilesRecur(srcFilePath, targetFilePath, extensions);
    } 
    else {
      for (let extension of extensions) {
        if (srcFilePath.endsWith(extension)) {
          fs.copyFileSync(srcFilePath, targetFilePath);
        }
      }
    }
  };
}
