export {
  logError, compilerError, logMultiError, Position, setLogger
}

interface Position {
  document: string
  line: number
  start: number
  end: number
}

let logger: (position: Position, message: string, context: string[]) => void;
logger = (position, message, context) => {
  console.error(`error in '${position.document}.chad' line: ${position.line}: ${message}`);
  for (let line of context) {
    console.error('\t' + line);
  }
}

function setLogger(newLogger: (position: Position, message: string, context: string[]) => void) {
  logger = newLogger;
}

function compilerError(message: string) {
  console.error(message);
  process.exit(-1)
}

function logMultiError(position: Position, message: string, context: string[]) {
  logger(position, message, context);
}

function logError(position: Position, message: string) {
  logger(position, message, []);
}

