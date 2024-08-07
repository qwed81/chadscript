import arg from 'arg';
import { parseFile, ProgramUnit } from './parse';
import { analyze } from './analyze/analyze';
import { codegen, OutputFile } from './codegen/codegen';
import path from 'node:path';
import { execSync } from 'node:child_process'
import { docgen } from './docgen';

import fs from 'node:fs';

export {
  logError, compilerError, NULL_POS, Position, BuildArgs
}

interface Position {
  document: string
  line: number
  start: number
  end: number
}

// build args are sent through stdin in this format to tell
// the compiler how to treat the code
interface BuildArgs {
  exeName: string,
  chadFiles: ChadFile[],
  libs: Lib[]
}

interface Lib {
  name: string,
  includes: string[],
  source: string,
  buildCommands: Command[],
  libPaths: string[]
  dependsOn: string[],
}

interface ChadFile {
  // how the file is treated in src (std, time, ect.)
  unitName: string,
  // path to the file
  srcPath: string
  // header files to include in chadscript code
  headers: string[]
}

type Command = string[]

// used when a function requires a position for error checking
// but the function should never fail with the parameters being called
const NULL_POS: Position = {
  document: '',
  line: 0,
  start: 0,
  end: 0
}

function compilerError(message: string) {
  console.error(message);
  process.exit(-1)
}

function logError(position: Position, message: string) {
  console.error(`error in '${position.document}.chad' line: ${position.line}: ${message}`);
}

const args = arg({
	'-o': String, 
  '-d': String,
  '-v': Boolean
});

let stdin = process.stdin;
let inputChunks: Buffer[] = []

stdin.resume();
stdin.setEncoding('utf8');

stdin.on('data', function (chunk) {
    inputChunks.push(chunk);
});

stdin.on('end', function () {
  let inputJSON = inputChunks.join();
  let buildArgs: BuildArgs = JSON.parse(inputJSON);
  buildLibs(buildArgs);
  compile(buildArgs);
});


// builds all the required libraries in order
function buildLibs(buildArgs: BuildArgs) {
  let alreadyBuilt: Set<string> = new Set();
  let inStack: Set<string> = new Set();
  for (let i = 0; i < buildArgs.libs.length; i++) {
    let lib: Lib = buildArgs.libs[i];
    orderLibRecur(buildArgs, lib, alreadyBuilt, inStack);
  }
}

// will recursively try to build the dependencies first
function orderLibRecur(buildArgs: BuildArgs, lib: Lib, alreadyBuilt: Set<string>, inStack: Set<string>) {
  if (alreadyBuilt.has(lib.source)) {
    return;
  }

  if (inStack.has(lib.source)) {
    compilerError('recursive dependencies');
    return;
  }

  inStack.add(lib.source);
  for (let i = 0; i < lib.dependsOn.length; i++) {
    let foundLib: Lib | null = null;
    for (let j = 0; j < buildArgs.libs.length; j++) {
      if (lib.dependsOn[i] == buildArgs.libs[j].name) {
        foundLib = buildArgs.libs[j];
      }
    }

    if (foundLib == null) {
      compilerError('can not find ' + lib.dependsOn[i]);
      return;
    }

    orderLibRecur(buildArgs, foundLib, alreadyBuilt, inStack);
  }

  buildLib(lib);
  alreadyBuilt.add(lib.source);
}

function buildLib(lib: Lib) {
  let saveDir = process.cwd();
  let destName = path.join('build', lib.name);

  if (!fs.existsSync(destName)) {
    if (lib.source.startsWith("git@")) {
      process.chdir('build');
      execProgram('git', ['clone', lib.source]);
      process.chdir('../')
    }
  }

  if (!lib.source.startsWith("git")) {
    fs.cpSync(lib.source, destName, {recursive: true});
  }

  process.chdir(destName);
  for (let i = 0; i < lib.buildCommands.length; i++) {
    let progName = lib.buildCommands[i][0];
    let args = lib.buildCommands[i].slice(1);
    execProgram(progName, args);
  }
  process.chdir(saveDir);
}

// compiles the chadscript
function compile(buildArgs: BuildArgs) {
  let parsedProgram: ProgramUnit[] = [];
  let parseError = false;
  for (let i = 0; i < buildArgs.chadFiles.length; i++) {
    let chadFile = buildArgs.chadFiles[i];
    let unit = parseFile(chadFile.srcPath, chadFile.unitName);
    if (unit != null) {
      parsedProgram.push(unit);
    }
    else {
      parseError = true;
    }
  }

  if (parseError) {
    console.log('invalid program :/ could not parse')
    process.exit(-1);
  } 

  let analyzedProgram = analyze(parsedProgram);
  if (args['-v']) {
    console.log('parse tree: ')
    console.log(JSON.stringify(parsedProgram, null, 2));
  }
  if (analyzedProgram == null) {
    console.log('invalid program');
    process.exit(-1);
  } 

  let output: OutputFile[] = codegen(analyzedProgram, buildArgs);
  let outputPath;
  if (args['-o']) {
    outputPath = args['-o'];
  } else {
    outputPath = './build';
  }

  if (args['-v']) {
    console.log(output);
  }

  console.log('no compile errors, building with clang...');
  let fileNames: string[] = [];
  for (let i = 0; i < output.length; i++) {
    let fileName = path.join(outputPath, output[i].name);
    if (!fileName.endsWith('.h')) {
      fileNames.push(fileName);
    }
    fs.writeFileSync(fileName, output[i].data);
  }

  let allLibs: string[] = []; 
  let allIncludes: string[] = [];
  for (let lib of buildArgs.libs) {
    let libRoot = path.join('build', lib.name);
    for (let libPath of lib.libPaths) {
      let archivePath = path.resolve(path.join(libRoot, libPath));
      allLibs.push(archivePath);
    }
    for (let include of lib.includes) {
      let includePath = path.join(libRoot, include);
      allIncludes.push('-I./' + includePath);
    }
  }

  console.log(process.cwd());
  let outputFileName = path.join(outputPath, buildArgs.exeName);
  let clangArgs = [...fileNames, ...allIncludes, ...allLibs, '/home/josh/repos/chadscript/build/libuv/.libs/libuv.so'];
  clangArgs = ['-g', '-o', outputFileName, ...clangArgs]; 
  console.log(clangArgs);
  execProgram('clang', clangArgs)
}

function execProgram(programName: string, programArgs: string[]) {
  try {
    let command = programName + ' ' + programArgs.join(' ')
    console.log(command);
    execSync(command);
  } catch (error: any) {
    console.error(error.message);
  }
}

