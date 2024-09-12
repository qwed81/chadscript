const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// create output directory
if (!fs.existsSync('chad')) {
  fs.mkdirSync('chad')
}

let rootDir = process.cwd();

process.chdir('build');
let buildDir = process.cwd()

if (!fs.existsSync('libuv')) {
  execSync('git clone https://github.com/libuv/libuv.git')
}

// build libuv
process.chdir('libuv');
if (!fs.existsSync('build')) {
  console.log('building libuv...');
  fs.mkdirSync('build');
  process.chdir('build');
  execSync('cmake ..');
  process.chdir('../');
  execSync('cmake --build build');
}
else {
  console.log('already built libuv');
}
process.chdir(buildDir)

// build async
if (!fs.existsSync('async')) {
  console.log('building async...');
  fs.mkdirSync('async') 

  process.chdir(rootDir);
  copyFilesRecur('async', 'build/async', ['.c', '.h', '.s']);

  process.chdir('build/async');
  execSync("clang -c -o async.o async.c -g -I../libuv/includes");
  execSync("nasm -f elf64 x64.s -o asm.o");
  execSync("ar rcs libasync.a async.o asm.o");
}
else {
  console.log('already built async');
}
process.chdir(rootDir);

// move the JS files from the TSC compiler to the chad dir
copyFilesRecur('build', 'chad', ['.js', '.map']);

// move the output files into the chad dir
copyFilesRecur('build/async', 'chad', ['.o', '.h']);
copyFilesRecur('build/libuv/build', 'chad', ['.so']);

copyFilesRecur('build/async/includes', 'chad/includes', ['.h']);
copyFilesRecur('build/libuv/include', 'chad/includes', ['.h']);

if (!fs.existsSync('chad/node_modules')) {
  fs.mkdirSync('chad/node_modules');
  copyFilesRecur('node_modules', 'chad/node_modules', ['.js']);
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
