import { parseFile, parse, ProgramUnit } from './parse';
import { analyze } from './analyze';
import { codegen, OutputFile } from './codegen';
import { replaceGenerics, Program } from './replaceGenerics';
import { loadUnits, UnitSymbols } from './typeload';
import { loadHeaderFile } from './header';
import path from 'node:path';
import { execSync } from 'node:child_process'
import { logError, NULL_POS } from './util';
import fs from 'node:fs';
import * as Lsp from './lsp';

export {
  analyzeProgram, getFilesRecur
}

let libs: string[] = []
let rename: Map<string, string> = new Map();
let entryPoint: string = ''
let mode: 'default' | 'build' | 'lsp' = 'default';

function processArgs(args: string[]): boolean {
  libs = []
  rename = new Map()
  entryPoint = '';

  for (let i = 0; i < args.length; i++) {
    let arg = args[i];
    if (arg == '--rename') {
      if (args.length == i) {
        console.error('expected rename files');
        return false;
      }
      let renameFiles = args[i + 1].split(':');
      if (renameFiles.length != 2) {
        console.error('expected rename file:file');
        return false;
      }
      rename.set(renameFiles[0], renameFiles[1]);
      i += 1;
      continue;
    }

    if (arg.endsWith('chad')) {
      if (entryPoint != '') {
        console.error('expected only 1 entry point')
        return false;
      }
      entryPoint = arg;
    }

    if (arg.endsWith('.o') || arg.endsWith('.a') || arg.endsWith('.so')) {
      libs.push(arg);
    }
  }

    return true;
}

if (process.argv.length > 2) {
  if (process.argv[2] == 'lsp') mode = 'lsp';
  else if (process.argv[2] == 'build') mode = 'build';
}

if (!fs.existsSync('build/')) {
  fs.mkdirSync('build');
}

processArgs(process.argv.slice(2));
if (entryPoint == '') {
  try {
    execSync(`node ${__dirname}/index.js -- build.chad`, { encoding: 'utf-8' });
    let result = execSync('./build/output', { encoding: 'utf-8' }).toString();
    let args = result.split(/\s/);
    args = args.filter(arg => arg.length > 0);
    let outputBuildCommand = 'chad ' + result; 
    console.log(outputBuildCommand);
    processArgs(args)
  } catch (e) {
    process.exit(-1);
  }
}

if (mode == 'default') {
  let program = analyzeProgram(new Map())
  if (program != null) {
    compileProgram(program);
  }
  else {
    console.log('could not finish build');
    process.exit(-1);
  }
}
else if (mode == 'build'){
  let program = analyzeProgram(new Map())
  if (program != null) {
    compileProgram(program);
  }
  else {
    console.log('could not finish build');
    process.exit(-1);
  }
}
else if (mode == 'lsp') {
  Lsp.startServer();
}

interface AnalysisResult {
  includes: Set<string>,
  program: Program
}

function analyzeProgram(
  replaceFile: Map<string, string>
): AnalysisResult | null {
  // determine which files should be analyzed based on entry point
  let alreadyParsed: Set<string> = new Set();
  let filePathStack: string[] = ['std/core.chad', entryPoint]
  let programUnits: ProgramUnit[] = [];
  let symbols: UnitSymbols[] = [];
  let headerFiles: Set<string> = new Set();

  while (filePathStack.length != 0) {
    let filePath = filePathStack.pop()!;
    if (alreadyParsed.has(filePath)) continue;
    alreadyParsed.add(filePath);

    if (filePath.endsWith('.h')) {
      let headerUnit = loadHeaderFile(filePath);
      if (headerUnit == null) {
        logError(NULL_POS, `could not load unit '${filePath}'`);
        symbols.push(blankSymbols(filePath))
      }
      else {
        symbols.push(headerUnit);
      }
      headerFiles.add(filePath);
    }
    else {
      let fileName = filePath.slice(0, -5);
      if (replaceFile.has(filePath)) {
        let progUnit = parse(replaceFile.get(filePath)!, fileName);
        if (progUnit == null) {
          logError(NULL_POS, `could not load unit '${filePath}'`);
          programUnits.push(blankUnit(fileName));
        } 
        else {
          programUnits.push(progUnit);
        }
      }
      else {
        let progUnit = parseFile(filePath, fileName);
        if (progUnit == null) {
          logError(NULL_POS, `could not load unit '${filePath}'`);
          programUnits.push(blankUnit(fileName));
        }
        else {
          programUnits.push(progUnit);
        }
      }

      for (let fileName of programUnits[programUnits.length - 1].referencedUnits) {
        if (fileName.endsWith('.h')) filePathStack.push(fileName);
        else filePathStack.push(fileName + '.chad');
      }
    }
  }

  symbols = loadUnits(programUnits, symbols)

  let program = analyze(programUnits, symbols);
  if (program == null) {
    return null;
  } 

  let mainFns = program.fns.filter(x => x.header.name == 'main');
  if (mainFns.length < 1) {
    logError(NULL_POS, 'no main function');
    return null;
  }
  if (mainFns.length > 1) {
    logError(NULL_POS, 'only 1 main function should be provided');
  }
  return { includes: headerFiles, program: replaceGenerics(program, symbols, mainFns[0]) };
}

function compileProgram(program: AnalysisResult) {
  let outputFiles: OutputFile[] = codegen(program.program, program.includes);

  let fileNames: string[] = [];
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
  for (let i = 0; i < libs.length; i++) {
    libPaths += libs[i] + ' ';
  }

  let outputPath = path.join('build', 'output');
  try {
    execSync(`clang ${objPaths} ${libPaths} -o ${outputPath} -Wno-parentheses-equality`);
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

function blankSymbols(name: string): UnitSymbols {
  return {
    name,
    fns: new Map(),
    macros: new Map(),
    asUnits: new Map(),
    globals: new Map(),
    structs: new Map(),
    allUnits: [],
    useUnits: []
  }
}

function blankUnit(name: string): ProgramUnit {
  return {
    structs: [],
    globals: [],
    fns: [],
    referencedUnits: new Set(),
    uses: [],
    fullName: name
  }
}
