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

execSync('npm run build', { cwd: 'compiler' });
copyFilesRecur('std', 'compiler/build/std', ['.chad']);
if (!process.argv.includes('compiler')) {
  execSync('npm run build', { cwd: 'vscode' });
}

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
