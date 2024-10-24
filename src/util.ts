import { ProgramUnit } from './parse';

export {
  logError, compilerError, NULL_POS, Position, allUnits, setAllUnits
}

let allUnits: ProgramUnit[] = []
function setAllUnits(units: ProgramUnit[]) {
  allUnits = units;
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

