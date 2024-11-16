import { parseFile, parse, ProgramUnit } from './parse';
import { analyze } from './analyze';
import { codegen, OutputFile } from './codegen';
import { replaceGenerics, Program } from './replaceGenerics';
import { loadUnits, UnitSymbols } from './typeload';
import { loadHeaderFile } from './header';
import path from 'node:path';
import { execSync } from 'node:child_process'
import * as Util from './util';
import fs from 'node:fs';
import * as Lsp from './lsp';

export {
  analyzeProgram, getFilesRecur
}

let chadPaths: string[] = [];
let headerPaths: string[] = [];
for (let i = 2; i < process.argv.length; i++) {
  let fileName = process.argv[i]; 
  if (fileName.endsWith('.h')) {
    headerPaths.push(fileName);
  }
  else if (fileName.endsWith('.chad')) {
    chadPaths.push(fileName);
  }
}

if (process.argv.includes('--lsp')) {
  Lsp.startServer(chadPaths, headerPaths);
}
else {
  let program = analyzeProgram(chadPaths, headerPaths, new Map())
  if (program != null) {
    compileProgram(program, headerPaths);
  }
  else {
    console.log('could not finish build');
  }
}

function analyzeProgram(
  chadPaths: string[],
  headerPaths: string[],
  replaceFile: Map<string, string>
): Program | null {
  let programUnits: ProgramUnit[] = [];
  let symbols: UnitSymbols[] = [];
  for (let filePath of chadPaths) {
    let fileName = filePath.slice(0, -5);
    if (replaceFile.has(filePath)) {
      let progUnit = parse(replaceFile.get(filePath)!, fileName);
      if (progUnit == null) continue;
      programUnits.push(progUnit);
    }
    else {
      let progUnit = parseFile(filePath, fileName);
      if (progUnit == null) continue;
      programUnits.push(progUnit);
    }
  }

  for (let filePath of headerPaths) {
    let headerUnit = loadHeaderFile(filePath);
    if (headerUnit == null) {
      continue;
    }
    symbols.push(headerUnit);
  }

  symbols = loadUnits(programUnits, symbols)

  let program = analyze(programUnits, symbols);
  if (program == null) {
    return null;
  } 

  let mainFn = program.fns.find(x => x.header.name == 'main');
  if (mainFn == undefined) return null;
  return replaceGenerics(program, symbols, mainFn);
}

function compileProgram(program: Program, headerPaths: string[]) {
  let outputFiles: OutputFile[] = codegen(program, new Set(headerPaths));

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

  let outputPath = path.join('build', 'output');
  try {
    execSync(`clang ${objPaths} ${libPaths} -o ${outputPath}`);
  } catch {}
}

// gets all of the parse units according to the file structure
function getFilesRecur(filePath: string, namePath: string, chadPaths: string[], headerPaths: string[]) {
  let subPaths = fs.readdirSync(filePath);

  for (let subPath of subPaths) {
    let fullPath = path.join(filePath, subPath);
    let newNamePath = namePath + '/' + subPath;

    let stats = fs.statSync(fullPath);
    if (stats.isDirectory()) {
      getFilesRecur(fullPath, newNamePath, chadPaths, headerPaths);
    }
    else if (subPath.endsWith('.chad')) {
      headerPaths.push(namePath)
    }
    else if (subPath.endsWith('.h')) {
      headerPaths.push(namePath);
    }
  }
}

