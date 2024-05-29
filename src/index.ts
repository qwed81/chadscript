import arg from 'arg';
import { parseDir } from './parse';
import { analyze } from './analyze/analyze';
import { codegen } from './codegen';
import fs from 'node:fs';

export {
  logError
}

function logError(line: number, message: string) {
  console.log(`error line ${line + 1}: ${message}`);
}

const args = arg({
	'-o': String, 
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
    return;
  } 

  let analyzedProgram = analyze(parsedProgram);
  if (analyzedProgram == null) {
    if (args['-v']) {
      console.log('parse tree: ')
      console.log(JSON.stringify(parsedProgram, null, 2));
    }
    console.log('invalid program');
    return;
  } 

  let output = codegen(analyzedProgram);
  let outputPath;
  if (args['-o']) {
    outputPath = args['-o'];
  } else {
    outputPath = './a.out';
  }

  fs.writeFileSync(outputPath, output);
  if (args['-v']) {
    console.log(output);
  }
}

