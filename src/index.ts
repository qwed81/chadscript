import arg from 'arg';
import { parseFile, ProgramUnit } from './parse';
import { analyze } from './analyze/analyze';
import { codegen, OutputFile } from './codegen/codegen';
import path from 'node:path';
import { spawn } from 'node:child_process'
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
  files: ChadFile[],
  // the command to build any C libraries
  buildComands: Command[]
  // the name of the resulting object files to link to
  objectNames: string[] ,
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
  compile(buildArgs);
});

function compile(buildArgs: BuildArgs) {
  let parsedProgram: ProgramUnit[] = [];
  let parseError = false;
  for (let i = 0; i < buildArgs.files.length; i++) {
    let unit = parseFile(buildArgs.files[i].srcPath, buildArgs.files[i].unitName);
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

  let fileNames: string[] = [];
  for (let i = 0; i < output.length; i++) {
    let fileName = path.join(outputPath, output[i].name);
    if (!fileName.endsWith('.h')) {
      fileNames.push(fileName);
    }
    fs.writeFileSync(fileName, output[i].data);
  }

  console.log('no compile errors, building with clang...');
  let outputFileName = path.join(outputPath, buildArgs.exeName);
  let clangArgs = [...fileNames, '-o', outputFileName]; 
  console.log(clangArgs);
  let clang = spawn('clang', clangArgs);
  clang.stdout.on('data', (data) => {
    console.log(data.toString());
  });

  clang.stderr.on('data', (data) => {
    console.error(data.toString());
  });

  clang.on('close', (code) => {
    process.exit(code);
  });
}

