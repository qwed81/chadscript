import arg from 'arg';
import { parseDir } from './parse';
import { analyze } from './analyze/analyze';
import { codegen } from './codegen/codegen';
import { docgen } from './docgen';

import fs from 'node:fs';

export {
  logError
}

function logError(line: number, message: string) {
  console.log(`error line ${line + 1}: ${message}`);
}

const args = arg({
	'-o': String, 
  '-d': String,
  '-v': Boolean
});

compile();

function compile() {
  let sourceDir: string = args._[0];

  // console.log('building: ')
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

