import { Program, Fn } from './analyze/analyze';
import { toStr } from './analyze/types';

export {
  docgen
}

function docgen(prog: Program): string {
  let outputStr: string = '';
  let units: Map<string, Fn[]> = new Map();
  for (let fn of prog.fns) {
    let toList: Fn[]; 
    if (units.has(fn.unitName)) {
      toList = units.get(fn.unitName)!;
    } 
    else {
      toList = [];
      units.set(fn.unitName, toList);
    }
    toList.push(fn);
  }

  for (let unit of units) {
    let unitName = unit[0];
    let fns = unit[1];
    outputStr += `<h1>${unitName}</h1>`;

    for (let fn of fns) {
      if (fn.type.tag != 'fn') {
        continue;
      }

      outputStr += '\n<code><pre>' + fn.name + '('
      for (let i = 0; i < fn.paramNames.length; i++) {
        if (fn.unitName != 'std') {
          continue;
        }
        outputStr += toStr(fn.type.val.paramTypes[i]);
        outputStr += ' ' + fn.paramNames[i];
        if (i != fn.paramNames.length - 1) {
          outputStr += ', ';
        }
      }
      outputStr += ') ';
      let retType = fn.type.val.returnType;
      if (retType.tag != 'primative' && retType.val != 'void') {
        outputStr += toStr(fn.type.val.returnType);
      }

      outputStr += '</pre></code>';
    }
  }

  return outputStr
} 
