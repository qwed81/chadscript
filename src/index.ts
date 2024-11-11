import { parseFile, ProgramUnit } from './parse';
import { analyze } from './analyze';
import { codegen, OutputFile } from './codegen';
import { replaceGenerics } from './replaceGenerics';
import { loadUnits, UnitSymbols } from './typeload';
import { loadHeaderFile } from './header';
import path from 'node:path';
import { execSync } from 'node:child_process'
import * as Util from './util';
import fs from 'node:fs';

// gets all of the parse units according to the file structure
/*
function parseUnitsRecur(basePath: string, moduleName: string, outParseUnits: ProgramUnit[]) {
  let subPaths = readdirSync(basePath);
  for (let subPath of subPaths) {
    let fullPath = path.join(basePath, subPath);

    let stats = fs.statSync(fullPath);
    if (stats.isDirectory()) {
      let modBaseName = path.basename(fullPath);
      let nextModName = `${moduleName}.${modBaseName}`;
      parseUnitsRecur(fullPath, nextModName, outParseUnits);
    }
    else if (subPath.endsWith('.chad')) {
      let unitBaseName = path.basename(fullPath).slice(0, -5);
      let unitName = `${moduleName}.${unitBaseName}`;
      if (moduleName == '') {
        unitName = unitBaseName;
      }

      let parseUnit = parseFile(fullPath, unitName);
      if (parseUnit != null) {
        outParseUnits.push(parseUnit);
      }
    }
  }
}
*/

compileProgram()
function compileProgram() {
  let programUnits: ProgramUnit[] = [];
  let headerPaths: string[] = [];
  let symbols: UnitSymbols[] = [];
  for (let i = 2; i < process.argv.length; i++) {
    let filePath = process.argv[i];
    if (filePath.endsWith('.chad')) {
      let fileName = filePath.slice(0, -5);
      let progUnit = parseFile(filePath, fileName);
      if (progUnit == null) {
        continue;
      }
      programUnits.push(progUnit);
    }
    else if (filePath.endsWith('.h')) {
      let headerUnit = loadHeaderFile(filePath);
      if (headerUnit == null) {
        continue;
      }
      symbols.push(headerUnit);
    }
  }

  symbols = loadUnits(programUnits, symbols)

  let program = analyze(programUnits, symbols);
  if (program == null) {
    console.log('could not finish build');
    return;
  } 

  let mainFn = program.fns.find(x => x.header.name == 'main');
  if (mainFn == undefined) return;
  let implProgram = replaceGenerics(program, symbols, mainFn);
  let outputFiles: OutputFile[] = codegen(implProgram, new Set(headerPaths));

  let fileNames: string[]= [];
  for (let file of outputFiles) {
    fileNames.push(file.name);
    fs.writeFileSync(path.join('build', file.name), file.data);
  }

  // finish by compiling with clang
  if (fileNames.length == 0) return;
  let objPaths = '';
  let includePath = path.join(__dirname, 'includes');
  for (let fileName of fileNames) {
    if (path.extname(fileName) != '.c') {
      continue;
    }

    let objPath = path.join('build', fileName.slice(0, -2) + '.o');
    let cSrcPath = path.join('build', fileName);
    try {
      execSync(`clang -c -fPIC ${cSrcPath} -o ${objPath} -I${includePath}`);
    } catch {}
    objPaths += objPath + ' ';
  }

  let libPaths = '';
  for (let i = 2; i < process.argv.length; i++) {
    let input = process.argv[i];
    if (input.endsWith('.so') || input.endsWith('.a')) {
      libPaths += process.argv[i] + ' ';
    }
  }

  let libuvPath = path.join(__dirname, 'libuv.so');
  let asyncPath = path.join(__dirname, 'async.o');
  let asmPath = path.join(__dirname, 'asm.o');

  let outputPath = path.join('build', 'output');
  try {
    execSync(`clang ${asyncPath} ${asmPath} ${libuvPath} ${objPaths} ${libPaths} -o ${outputPath}`);
  } catch {}
}
