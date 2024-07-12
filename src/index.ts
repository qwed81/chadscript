import arg from 'arg';
import { parseDir } from './parse';
import { analyze } from './analyze/analyze';
import { codegen } from './codegen/codegen';
import { docgen } from './docgen';

import fs from 'node:fs';

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
  '-d': String,
  '-v': Boolean
});

compile();

function compile() {
  let sourceDir: string = args._[0];

  // console.log(sourceDir);
  let parsedProgram = parseDir(sourceDir, null);

  if (parsedProgram == null) {
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

  let output = codegen(analyzedProgram);
  let outputPath;
  if (args['-o']) {
    outputPath = args['-o'];
  } else {
    outputPath = './a.out';
  }

  let docs = docgen(analyzedProgram);
  let docsPath;
  if (args['-d']) {
    docsPath = args['-d'];
  } else {
    docsPath = './docs.html';
  }

  fs.writeFileSync(docsPath, docs);
  fs.writeFileSync(outputPath, output);
  if (args['-v']) {
    console.log(output);
  }
}

