import { Program  } from '../analyze/analyze';
import { Inst, LeftExpr, Expr, StructInitField, FnCall } from '../analyze/analyze';
import { toStr, Type, RANGE } from '../analyze/types';
import { replaceGenerics, CProgram, CFn } from './concreteFns';

export {
  codegen, codeGenType
}

// generates the c output for the given program
function codegen(prog: Program): string {
  let newProg: CProgram = replaceGenerics(prog);

  let programStr = '#include <stdio.h>\n#include <stdlib.h>\n#include <string.h>\n#include <sys/mman.h>\n#include <fcntl.h>\n#include <sys/stat.h>\n#include <unistd.h>';

  // forward declare structs for pointers
  for (let struct of newProg.orderedStructs) {
    if (struct.tag == 'struct' || struct.tag == 'enum') {
      programStr += '\n' + codeGenType(struct.val.name) + ';';
    }
    else if (struct.tag == 'slice') {
      programStr += '\n' + codeGenType(struct.val) + ';';
    }
  }

  // generate implementations of types
  for (let struct of newProg.orderedStructs) {
    if (struct.tag == 'struct') {
      programStr += '\n' + codeGenType(struct.val.name) + ' {';
      for (let i = 0; i < struct.val.fieldTypes.length; i++) {
        programStr += '\n  ' + codeGenType(struct.val.fieldTypes[i]) + ' _' + struct.val.fieldNames[i] + ';';
      }
      programStr += '\n};\n'
    }
    else if (struct.tag == 'enum') {
      programStr += '\n' + codeGenType(struct.val.name) + ' {';
      programStr += '\n  int tag;';
      programStr += '\n  union {';
      for (let i = 0; i < struct.val.fieldTypes.length; i++) {
        let typeStr = codeGenType(struct.val.fieldTypes[i]);
        if (typeStr == 'void') {
          typeStr = 'int';
        }
        programStr += '\n    ' + typeStr + ' _' + struct.val.fieldNames[i] + ';' 
      }
      programStr += '\n  };\n};'
    }
    else if (struct.tag == 'slice') {
      if (struct.val.tag != 'slice') {
        continue;
      }

      programStr += '\n' + codeGenType(struct.val) + ' {';
      programStr += '\n  ' + codeGenType(struct.val.val) + ' *_ptr;';
      programStr += '\n  int _len;'
      programStr += '\n  int _refCount;'
      programStr += '\n};'
    }
  }

  for (let fn of newProg.fns) {
    programStr += codeGenFnHeader(fn) + ';';
  }

  for (let fn of newProg.fns) {
    let fnCode = codeGenFnHeader(fn) + codeGenBody(fn.body, 1, false);
    programStr += fnCode;
  }

  let entry = newProg.entry;
  let entryName = getFnUniqueId(entry.unitName, entry.name, entry.type);
  programStr += `\nint main() { return ${entryName}(); }`;
  return programStr;
}

function replaceAll(s: string, find: string, replace: string) {
  while (s.includes(find)) {
    s = s.replace(find, replace);
  }
  return s;
}

function codeGenType(type: Type): string {
  if (type.tag == 'primative') {
    if (type.val == 'str') {
      return 'const char*';
    }
    else if (type.val == 'num') {
      return 'double';
    }
    else if (type.val == 'byte') {
      return 'unsigned char';
    }
    return type.val;
  }
  let typeStr = '_' + toStr(type);
  typeStr = replaceAll(typeStr, '(', '_op');
  typeStr = replaceAll(typeStr, ')', '_cp');
  typeStr = replaceAll(typeStr, '[', '_os');
  typeStr = replaceAll(typeStr, ']', '_cs');
  typeStr = replaceAll(typeStr, ',', '_c');
  typeStr = replaceAll(typeStr, '.', '_');
  typeStr = replaceAll(typeStr, '*', '_slice');

  return 'struct ' + typeStr.replace(' ', '');
}

function codeGenFnHeader(fn: CFn): string {
  if (fn.type.tag != 'fn') {
    return '';
  }

  let name = getFnUniqueId(fn.unitName, fn.name, fn.type);
  let headerStr = '\n' + codeGenType(fn.type.val.returnType) +  ' ' + name + '(';
  let paramStr = '';

  for (let i = 0; i < fn.paramNames.length; i++) {
    paramStr += codeGenType(fn.type.val.paramTypes[i]);
    paramStr += ' _' + fn.paramNames[i];
    if (i != fn.paramNames.length - 1) {
      paramStr += ', ';
    }
  }
  return headerStr + paramStr + ')';
}

function codeGenBody(body: Inst[], indent: number, includeBreak: boolean): string {
  let bodyStr = ' {\n'
  for (let i = 0; i < body.length; i++) {
    bodyStr += codeGenInst(body[i], indent);
  }

  let tabs = '';
  for (let i = 0; i < indent - 1; i++) {
    tabs += '  ';
  }

  if (includeBreak) {
    bodyStr += tabs + '  break;\n';
  }

  return bodyStr + tabs + '}'
}

function codeGenInst(inst: Inst, indent: number): string {
  let tabs = '';
  for (let i = 0; i < indent; i++) {
    tabs += '  ';
  }

  let addInst: string[] = [];

  let instText;
  if (inst.tag == 'declare') {
    let type = inst.val.type;
    if (inst.val.expr != null) {
      let rightExpr = codeGenExpr(inst.val.expr, addInst, inst.sourceLine);
      instText = `${codeGenType(type)} _${inst.val.name} = ${rightExpr};`;
    } else {
      instText = `${codeGenType(type)} _${inst.val.name};`;
    }
  } 
  else if (inst.tag == 'assign') {
    let rightExpr = codeGenExpr(inst.val.expr, addInst, inst.sourceLine);
    instText = `${codeGenLeftExpr(inst.val.to, addInst, inst.sourceLine)} ${inst.val.op} ${rightExpr};`;
  } 
  else if (inst.tag == 'if') {
    instText = `if (${ codeGenExpr(inst.val.cond, addInst, inst.sourceLine) }) ${ codeGenBody(inst.val.body, indent + 1, false) }`;
  } 
  else if (inst.tag == 'elif') {
    instText = `else if (${ codeGenExpr(inst.val.cond, addInst, inst.sourceLine) }) ${ codeGenBody(inst.val.body, indent + 1, false) }`;
  }
  else if (inst.tag == 'else') {
    instText = `else ${ codeGenBody(inst.val, indent + 1, false) }`;
  }
  else if (inst.tag == 'while') {
    instText = `while (${ codeGenExpr(inst.val.cond, addInst, inst.sourceLine) }) ${ codeGenBody(inst.val.body, indent + 1, false) }`;
  }
  else if (inst.tag == 'expr') {
    instText = codeGenExpr(inst.val, addInst, inst.sourceLine) + ';';
  }
  else if (inst.tag == 'return') {
    if (inst.val == null) {
      instText == 'return;'
    } else {
      instText = `return ${ codeGenExpr(inst.val, addInst, inst.sourceLine) };`;
    }
  }
  else if (inst.tag == 'include') {
    let instText: string = '';
    for (let i = 0; i < inst.val.length; i++) {
      instText += inst.val[i].slice(2) + '\n';
    }
    return instText;
  }
  else if (inst.tag == 'match') {
    instText = `switch (${codeGenExpr(inst.val.var, addInst, inst.sourceLine)}._tag) {\n`;
    for (let branch of inst.val.branches) {
      instText += `${tabs}case \'${branch.enumVariant}\':${ codeGenBody(branch.body, indent + 1, true) }\n`;
    }
    instText += tabs + '}\n';
  }
  else if (inst.tag == 'continue' || inst.tag == 'break') {
    instText = inst.tag + ';';
  } 
  else if (inst.tag == 'for_in') {
    let name = inst.val.varName;
    let inner = `for (int _${name} = __range_${name}._start; _${name} < __range_${name}._end; _${name}++)`;
    inner += '' + codeGenBody(inst.val.body, indent + 2, false);
    instText = `{\n${tabs} ${codeGenType(RANGE)} __range_${name} = `
    instText += `${codeGenExpr(inst.val.iter, addInst, inst.sourceLine)};\n${tabs}  ${inner}\n${tabs}}`;
  }

  let outputText = '';
  for (let i of addInst) {
    outputText += tabs + i + '\n';
  }
  outputText += tabs + instText + '\n'; 
  return outputText;
}

function codeGenExpr(expr: Expr, addInst: string[], exprIndex: number): string {
  if (expr.tag == 'bin') {
    if (expr.val.op == ':') {
      return 'undefined';
    }
    return `${ codeGenExpr(expr.val.left, addInst, exprIndex + 1) } ${ expr.val.op } ${ codeGenExpr(expr.val.right, addInst, exprIndex + 2) }`;
  } else if (expr.tag == 'not') {
    return '!' + codeGenExpr(expr.val, addInst, exprIndex + 1);
  } else if (expr.tag == 'try') {
    let optType;
    if (expr.val.type.tag == 'enum') {
      optType = expr.val.type
    } else {
      return 'undefined';
    }

    let varName = '__temp_' + exprIndex;
    addInst.push(`${ codeGenType(optType) } ${varName} = ${codeGenExpr(expr.val, addInst, exprIndex + 1)};`);
    addInst.push(`if (${varName}.tag == 1) return ${varName};`);
    return `${varName}._ok`;
  } else if (expr.tag == 'assert') {
    let optType;
    if (expr.val.type.tag == 'enum') {
      optType = expr.val.type
    } else {
      return 'undefined';
    }

    let varName = '__temp_' + exprIndex;
    addInst.push(`${ codeGenType(optType) } ${varName} = ${codeGenExpr(expr.val, addInst, exprIndex + 1)};`);
    addInst.push(`if (${varName}.tag == 1) { printf("panic: %s", ${varName}._err); exit(-1); }`);
    return `${varName}._ok`;
  } else if (expr.tag == 'fn_call') {
    return codeGenFnCall(expr.val, addInst, exprIndex + 1);
  } else if (expr.tag == 'struct_init') {
    return codeGenStructInit(expr, addInst, exprIndex + 1)
  } else if (expr.tag == 'str_const') {
    return `"${expr.val}"`;
  } else if (expr.tag == 'char_const') {
    return `'${expr.val}'`;
  } else if (expr.tag == 'int_const') {
    return `${expr.val}`;
  } else if (expr.tag == 'bool_const') {
    return `${expr.val}`;
  } else if (expr.tag == 'num_const') {
    return `${expr.val}`;
  } else if (expr.tag == 'left_expr') {
    return codeGenLeftExpr(expr.val, addInst, exprIndex + 1);
  } else if (expr.tag == 'is') {
    return `${codeGenLeftExpr(expr.left, addInst, exprIndex + 1)}.tag == ${expr.variantIndex}`;
  } else if (expr.tag == 'enum_init') {
    if (expr.fieldExpr != null) {
      return `(${ codeGenType(expr.type) }){ .tag = ${expr.variantIndex}, ._${expr.fieldName} = ${ codeGenExpr(expr.fieldExpr, addInst, exprIndex + 1) } }`;
    } else {
      return `(${ codeGenType(expr.type) }){ .tag = '${expr.variantIndex}' }`;
    }
  }

  return 'undefined';
}

function codeGenStructInit(expr: Expr, addInst: string[], exprIndex: number): string {
  if (expr.tag != 'struct_init') {
    return 'undefined';
  }

  let structInit: StructInitField[] = expr.val;
  let output = `(${codeGenType(expr.type)}){ `;
  for (let i = 0; i < structInit.length; i++) {
    let initField = structInit[i];
    output += `._${initField.name} = ${codeGenExpr(initField.expr, addInst, exprIndex + 1 + i)}`;
    if (i != structInit.length - 1) {
      output += ', ';
    }
  }

  return output + ' }'
}

function codeGenFnCall(fnCall: FnCall, addInst: string[], exprIndex: number): string {
  let output = codeGenLeftExpr(fnCall.fn, addInst, exprIndex + 1) + '(';
  for (let i = 0; i < fnCall.exprs.length; i++) {
    output += codeGenExpr(fnCall.exprs[i], addInst, exprIndex);
    if (i != fnCall.exprs.length - 1) {
      output += ', ';
    }
  }

  return output + ')'
}

function codeGenLeftExpr(leftExpr: LeftExpr, addInst: string[], exprIndex: number): string {
  if (leftExpr.tag == 'dot') {
    return `${codeGenExpr(leftExpr.val.left, addInst, exprIndex + 1)}._${leftExpr.val.varName}`;
  } 
  else if (leftExpr.tag == 'arr_offset_int') {
    let indexType = leftExpr.val.var.type.tag;
    if (indexType == 'slice') {
      return `${codeGenLeftExpr(leftExpr.val.var, addInst, exprIndex + 1)}._ptr[${codeGenExpr(leftExpr.val.index, addInst, exprIndex + 2)}]`;
    } else if (indexType == 'primative' && leftExpr.val.var.type.val == 'str') {
      return `${codeGenLeftExpr(leftExpr.val.var, addInst, exprIndex + 1)}[${codeGenExpr(leftExpr.val.index, addInst, exprIndex + 2)}]`;
    }

    return `${codeGenLeftExpr(leftExpr.val.var, addInst, exprIndex + 1)}._arr._ptr[${codeGenExpr(leftExpr.val.index, addInst, exprIndex + 2)}]`;
  } 
  else if (leftExpr.tag == 'arr_offset_slice') {
    let start = codeGenExpr(leftExpr.val.start, addInst, exprIndex + 1);
    let end = codeGenExpr(leftExpr.val.end, addInst, exprIndex + 1);
    return `{ ._ptr = ${codeGenLeftExpr(leftExpr.val.var, addInst, exprIndex + 1)} + start, ._len = ${end} - ${start}, ._refCount = 2 }`;
  }
  else if (leftExpr.tag == 'prime') {
    return `${ codeGenExpr(leftExpr.val, addInst, exprIndex + 1) }._${leftExpr.variant}`;
  }
  else if (leftExpr.tag == 'fn') {
    return getFnUniqueId(leftExpr.unitName, leftExpr.fnName, leftExpr.type);
  }
  else {
    return '_' + leftExpr.val;
  }
}

// java implementation taken from https://stackoverflow.com/questions/6122571/simple-non-secure-hash-function-for-javascript
function getFnUniqueId(fnUnitName: string, fnName: string, fnType: Type): string {
  return ('_' + fnUnitName.replace('.', '_') + '_' + fnName + '_' + codeGenType(fnType)).replace(' ', '').replace('*', '_slice');
}

