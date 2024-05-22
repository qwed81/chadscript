import arg from 'arg';
import { parseDir } from './parse';
import { analyze } from './analysis';
import { codegen } from './codegen';
import fs from 'node:fs';

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
    console.log('invalid program :/')
    console.log('parse tree: ')
    console.log(JSON.stringify(parsedProgram, null, 2));
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
  console.log(output);
}

