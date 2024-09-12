import arg from 'arg';
import { parseFile, ProgramUnit } from './parse';
import { analyze } from './analyze/analyze';
import { codegen, OutputFile } from './codegen/codegen';
import path from 'node:path';
import { execSync } from 'node:child_process'

import fs, { readdirSync } from 'node:fs';

export {
  logError, compilerError, NULL_POS, Position
}

interface Position {
  document: string
  line: number
  start: number
  end: number
}

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
  '-v': Boolean
});

// gets all of the parse units according to the file structure
function parseUnits(basePath: string, moduleName: string, outParseUnits: ProgramUnit[]) {
  let subPaths = readdirSync(basePath);
  for (let subPath of subPaths) {
    let fullPath = path.join(basePath, subPath);

    let stats = fs.statSync(fullPath);
    if (stats.isDirectory()) {
      let modBaseName = path.basename(fullPath);
      let nextModName = `${moduleName}.${modBaseName}`;
      parseUnits(fullPath, nextModName, outParseUnits);
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

let programUnits: ProgramUnit[] = [];

// compile the library files
let libNames: string[] = readdirSync('lib');
for (let libName of libNames) {
  let libPath = path.join('lib', libName);
  let stats = fs.statSync(libPath);
  if (!stats.isDirectory()) {
    continue;
  }
  parseUnits(libPath, libName, programUnits);
}

// compile the program files
parseUnits('src', '', programUnits);

let program = analyze(programUnits);
let fileNames: string[] = []
if (program != null) {
  let outputFiles: OutputFile[] = codegen(program);
  for (let file of outputFiles) {
    fileNames.push(file.name);
    fs.writeFileSync(path.join('build', file.name), file.data);
  }
}

// only if there are some files to codegen
if (fileNames.length > 0) {
  // compile all of the code into shared objects
  let objPaths = '';
  let includePath = path.join(__dirname, 'includes');
  for (let fileName of fileNames) {
    if (path.extname(fileName) != '.c') {
      continue;
    }

    let objPath = path.join('build', fileName.slice(0, -2) + '.o');
    let cSrcPath = path.join('build', fileName);
    execSync(`clang -c -fPIC ${cSrcPath} -o ${objPath} -I${includePath}`);
    objPaths += objPath + ' ';
  }

  let libuvPath = path.join(__dirname, 'libuv.so');
  let asyncPath = path.join(__dirname, 'async.o');
  let asmPath = path.join(__dirname, 'asm.o');

  let outputPath = path.join('build', 'output');
  execSync(`clang ${asyncPath} ${asmPath} ${libuvPath} ${objPaths} -o ${outputPath}`);
}

