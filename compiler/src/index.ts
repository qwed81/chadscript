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

interface Args {
  libs: string[]
  rename: Map<string, string>,
  entryPoints: string[],
  mode: 'default' | 'build' | 'lsp',
  outputName: string
}

function parseArgs(args: string[]): Args | null {
  let parsedArgs: Args = {
    libs: [],
    rename: new Map(),
    entryPoints: [],
    mode: 'default',
    outputName: 'build/output'
  }

  if (args.length > 0) {
    if (args[0] == 'lsp') parsedArgs.mode = 'lsp';
    else if (args[0] == 'build') parsedArgs.mode = 'build';
  }

  for (let i = 0; i < args.length; i++) {
    let arg = args[i];
    if (arg == '--rename') {
      if (args.length == i) {
        console.error('expected rename files');
        return null;
      }
      let renameFiles = args[i + 1].split(':');
      if (renameFiles.length != 2) {
        console.error('expected rename file:file');
        return null;
      }
      parsedArgs.rename.set(renameFiles[0], renameFiles[1]);
      i += 1;
      continue;
    }

    if (arg == '-o') {
      if (i == args.length - 1) {
        console.error('exepected name');
      }
      parsedArgs.outputName = args[i + 1];
    }

    if (arg.endsWith('chad')) {
      parsedArgs.entryPoints.push(arg);
    }

    if (arg.endsWith('.o') || arg.endsWith('.a') || arg.endsWith('.so')) {
      parsedArgs.libs.push(arg);
    }
  }

  return parsedArgs;
}

if (!fs.existsSync('build/')) {
  fs.mkdirSync('build');
}

let args = parseArgs(process.argv.slice(2));
if (args == null) {
  console.log('could not parse args');
  process.exit(-1);
}

if (args.entryPoints.length == 0) {
  let result: string;
  try {
    execSync(`node ${__dirname}/index.js -- -o build/build-script build.chad`, { encoding: 'utf-8' });
    result = execSync('./build/build-script', { encoding: 'utf-8' }).toString();
  } catch (e) {
    process.exit(-1);
  }

  let lines = result.split('\n');
  for (let line of lines) {
    let scriptArgs = line.split(/\s/);
    scriptArgs = scriptArgs.filter(arg => arg.length > 0);

    if (scriptArgs[0] == 'chad:' && (args.mode == 'build' || args.mode == 'default')) {
      scriptArgs = scriptArgs.slice(1);
      let outputCommand = '> chad ';
      for (let arg of scriptArgs) {
        outputCommand += arg + ' ';
      }

      console.log(outputCommand);
      let scriptParsedArgs = parseArgs(scriptArgs);
      if (scriptParsedArgs == null) {
        console.error('invalid command');
        break;
      }
      build(scriptParsedArgs);
    }
    else if (scriptArgs[0] == 'lsp:' && args.mode == 'lsp') {
      scriptArgs = scriptArgs.slice(1);
      let scriptParsedArgs = parseArgs(scriptArgs);
      if (scriptParsedArgs == null) {
        console.error('invalid command');
        break;
      }

      if (scriptParsedArgs.entryPoints.length == 0) {
        console.error('lsp expected entry points');
      }
      else {
        Lsp.run(scriptParsedArgs.entryPoints);
      }
    }
  }
}
else if (args.mode == 'build' || args.mode == 'default') {
  build(args);
}
else if (args.mode == 'lsp'){
  Lsp.run(args.entryPoints);
}

function build(args: Args) {
  let program = analyzeProgram(args.entryPoints, new Map())
  if (program != null) {
    compileProgram(args, program);
  }
  else {
    console.log('could not finish build');
    process.exit(-1);
  }
}

interface AnalysisResult {
  includes: Set<string>,
  program: Program
}

function analyzeProgram(
  entryPoints: string[],
  replaceFile: Map<string, string>
): AnalysisResult | null {
  // determine which files should be analyzed based on entry point
  let alreadyParsed: Set<string> = new Set();
  let filePathStack: string[] = ['std/core.chad', ...entryPoints]
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
        if (!fs.existsSync(filePath)) logError(NULL_POS, `could not load file '${filePath}'. no file`);
        else logError(NULL_POS, `could not load unit '${filePath}'. does it compile?`);

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
          logError(NULL_POS, `could not load file '${filePath}'`);
          programUnits.push(blankUnit(fileName));
        } 
        else {
          programUnits.push(progUnit);
        }
      }
      else {
        let progUnit = parseFile(filePath, fileName);
        if (progUnit == null) {
          logError(NULL_POS, `could not load file '${filePath}'`);
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

function compileProgram(args: Args, program: AnalysisResult) {
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
      execSync(`clang -c -fPIC ${cSrcPath} -o ${objPath} -I${includePath} -Wno-incompatible-pointer-types`);
    } catch {}
    objPaths += objPath + ' ';
  }

  let libPaths = '';
  for (let i = 0; i < args.libs.length; i++) {
    libPaths += args.libs[i] + ' ';
  }

  let outputPath = args.outputName;
  try {
    execSync(`clang -lm ${objPaths} ${libPaths} -o ${outputPath} -Wno-parentheses-equality`);
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
