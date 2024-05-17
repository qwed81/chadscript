const parser = require('./parse');
const typeChecker = require('./typecheck');
const codegen = require('./codegen');

let verbose;
if (process.argv.includes('-v')) {
  verbose = true;
}

let program = parser.parse('example.chad');
if (!parser.getErrorOccured()) {
  // console.log(JSON.stringify(program, null, 2));
  let checked = program;
  if (verbose && !typeChecker.getErrorOccured()) {
    console.log(JSON.stringify(checked, null, 2));
  }

  output = codegen.gen(checked);
  if (verbose) {
    console.log('\n');
    console.log(output);
    console.log('\n');
  }

  eval(output);
}



