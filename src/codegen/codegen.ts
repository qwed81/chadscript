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

  let programStr = '#include <stdio.h>\n#include <stdlib.h>\n#include <string.h>';

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


function codeGenType(type: Type): string {
  if (type.tag == 'primative') {
    if (type.val == 'str') {
      return 'const char*';
    }
    else if (type.val == 'num') {
      return 'double';
    }

    return type.val;
  }
  let typeStr = '_' + toStr(type);
  typeStr = typeStr.replace('(', '_op');
  typeStr = typeStr.replace(')', '_cp');
  typeStr = typeStr.replace('[', '_os');
  typeStr = typeStr.replace(']', '_cs');
  typeStr = typeStr.replace(',', '_c')
  typeStr = typeStr.replace('.', '_');
  typeStr = typeStr.replace('*', '_slice')

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
      let rightExpr = codeGenExpr(inst.val.expr, addInst);
      instText = `${codeGenType(type)} _${inst.val.name} = ${rightExpr};`;
    } else {
      instText = `${codeGenType(type)} _${inst.val.name};`;
    }
  } 
  else if (inst.tag == 'assign') {
    let rightExpr = codeGenExpr(inst.val.expr, addInst);
    instText = `${codeGenLeftExpr(inst.val.to, addInst)} ${inst.val.op} ${rightExpr};`;
  } 
  else if (inst.tag == 'if') {
    instText = `if (${ codeGenExpr(inst.val.cond, addInst) }) ${ codeGenBody(inst.val.body, indent + 1, false) }`;
  } 
  else if (inst.tag == 'elif') {
    instText = `else if (${ codeGenExpr(inst.val.cond, addInst) }) ${ codeGenBody(inst.val.body, indent + 1, false) }`;
  }
  else if (inst.tag == 'else') {
    instText = `else ${ codeGenBody(inst.val, indent + 1, false) }`;
  }
  else if (inst.tag == 'while') {
    instText = `while (${ codeGenExpr(inst.val.cond, addInst) }) ${ codeGenBody(inst.val.body, indent + 1, false) }`;
  }
  else if (inst.tag == 'fn_call') {
    instText = codeGenFnCall(inst.val, addInst) + ';';
  }
  else if (inst.tag == 'return') {
    if (inst.val == null) {
      instText == 'return;'
    } else {
      instText = `return ${ codeGenExpr(inst.val, addInst) };`;
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
    instText = `switch (${codeGenExpr(inst.val.var, addInst)}._tag) {\n`;
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
    instText += `${codeGenExpr(inst.val.iter, addInst)};\n${tabs}  ${inner}\n${tabs}}`;
  }

  let outputText = '';
  for (let i of addInst) {
    outputText += tabs + i + '\n';
  }
  outputText += tabs + instText + '\n'; 
  return outputText;
}

function codeGenExpr(expr: Expr, addInst: string[]): string {
  if (expr.tag == 'bin') {
    if (expr.val.op == ':') {
      return 'undefined';
    }
    return `${ codeGenExpr(expr.val.left, addInst) } ${ expr.val.op } ${ codeGenExpr(expr.val.right, addInst) }`;
  } else if (expr.tag == 'not') {
    return '!' + codeGenExpr(expr.val, addInst);
  } else if (expr.tag == 'try') {
    let innerType;
    if (expr.type.tag == 'enum') {
      innerType = expr.type.val.fields[0].type
    } else {
      return 'undefined';
    }

    let varName = '__temp_' + addInst.length;
    addInst.push(`${innerType} ${varName} = ${codeGenExpr(expr.val, addInst)};`);
    addInst.push(`if (${varName}.tag == 1) return ${varName};`);
    return `${varName}._ok`;
  } else if (expr.tag == 'assert') {
    let innerType;
    if (expr.type.tag == 'enum') {
      innerType = expr.type.val.fields[0].type
    } else {
      return 'undefined';
    }

    let varName = '__temp_' + addInst.length;
    addInst.push(`${innerType} ${varName} = ${codeGenExpr(expr.val, addInst)};`);
    addInst.push(`if (${varName}.tag == 1) { printf("panic"); exit(-1); }`);
    return `${varName}._ok`;
  } else if (expr.tag == 'fn_call') {
    return codeGenFnCall(expr.val, addInst);
  } else if (expr.tag == 'struct_init') {
    return codeGenStructInit(expr, addInst)
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
    return codeGenLeftExpr(expr.val, addInst);
  } else if (expr.tag == 'is') {
    return `${codeGenLeftExpr(expr.left, addInst)}.tag == ${expr.variantIndex}`;
  } else if (expr.tag == 'enum_init') {
    if (expr.fieldExpr != null) {
      return `{ .tag = ${expr.variantIndex}, ._${expr.fieldName} = ${ codeGenExpr(expr.fieldExpr, addInst) } }`;
    } else {
      return `{ .tag = '${expr.variantIndex}' }`;
    }
  }

  return 'undefined';
}

function codeGenStructInit(expr: Expr, addInst: string[]): string {
  if (expr.tag != 'struct_init') {
    return 'undefined';
  }

  let structInit: StructInitField[] = expr.val;
  let output = `(${codeGenType(expr.type)}){ `;
  for (let i = 0; i < structInit.length; i++) {
    let initField = structInit[i];
    output += `._${initField.name} = ${codeGenExpr(initField.expr, addInst)}`;
    if (i != structInit.length - 1) {
      output += ', ';
    }
  }

  return output + ' }'
}

function codeGenFnCall(fnCall: FnCall, addInst: string[]): string {
  let output = codeGenLeftExpr(fnCall.fn, addInst) + '(';
  for (let i = 0; i < fnCall.exprs.length; i++) {
    output += codeGenExpr(fnCall.exprs[i], addInst);
    if (i != fnCall.exprs.length - 1) {
      output += ', ';
    }
  }

  return output + ')'
}

function codeGenLeftExpr(leftExpr: LeftExpr, addInst: string[]): string {
  if (leftExpr.tag == 'dot') {
    return `${codeGenExpr(leftExpr.val.left, addInst)}._${leftExpr.val.varName}`;
  } 
  else if (leftExpr.tag == 'arr_offset_int') {
    let indexType = leftExpr.val.var.type.tag;
    if (indexType == 'slice') {
      return `${codeGenLeftExpr(leftExpr.val.var, addInst)}._ptr[${codeGenExpr(leftExpr.val.index, addInst)}]`;
    } else if (indexType == 'primative' && leftExpr.val.var.type.val == 'str') {
      return `${codeGenLeftExpr(leftExpr.val.var, addInst)}[${codeGenExpr(leftExpr.val.index, addInst)}]`;
    }

    return `${codeGenLeftExpr(leftExpr.val.var, addInst)}._arr._ptr[${codeGenExpr(leftExpr.val.index, addInst)}]`;
  } 
  else if (leftExpr.tag == 'arr_offset_slice') {
    let start = codeGenExpr(leftExpr.val.start, addInst);
    let end = codeGenExpr(leftExpr.val.end, addInst);
    return `{ ._ptr = ${codeGenLeftExpr(leftExpr.val.var, addInst)} + start, ._len = ${end} - ${start}, ._refCount = 2 }`;
  }
  else if (leftExpr.tag == 'prime') {
    return `${ codeGenExpr(leftExpr.val, addInst) }._${leftExpr.variant}`;
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
  return ('_' + fnUnitName.replace('.', '_') + '_' + fnName + '_' + codeGenType(fnType)).replace(' ', '');
}

