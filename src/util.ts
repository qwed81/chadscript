import { ProgramUnit } from './parse';

export {
  logError, compilerError, Position
}

interface Position {
  document: string
  line: number
  start: number
  end: number
}

function compilerError(message: string) {
  console.error(message);
  process.exit(-1)
}

function logError(position: Position, message: string) {
  console.error(`error in '${position.document}.chad' line: ${position.line}: ${message}`);
}

