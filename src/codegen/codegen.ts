import { Program  } from '../analyze/analyze';
import { Inst, LeftExpr, Expr, StructInitField, FnCall } from '../analyze/analyze';
import { toStr, Type, RANGE, STR } from '../analyze/types';
import { replaceGenerics, CProgram, CFn } from './concreteFns';

export {
  codegen, codeGenType
}

interface FnContext {
  genericMap: Map<string, Type>,
  uniqueExprIndex: number
}

const includes = [
  'stdio.h', 'stdlib.h', 'string.h', 'sys/mman.h', 'fcntl.h', 
  'sys/stat.h', 'unistd.h', 'stdbool.h'
]

// generates the c output for the given program
function codegen(prog: Program): string {
  let newProg: CProgram = replaceGenerics(prog);

  let programStr = '';
  for (let include of includes) {
    programStr += '\n#include <' + include + '>';
  }

  // forward declare structs for pointers
  for (let struct of newProg.orderedStructs) {
    if (struct.tag == 'struct' || struct.tag == 'enum') {
      programStr += '\n' + codeGenType(struct.val.name) + ';';
    }
    else if (struct.tag == 'arr') {
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
      programStr += '\n};'
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
    else if (struct.tag == 'arr') {
      if (struct.val.tag != 'arr') {
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
    let ctx: FnContext = { uniqueExprIndex: 0, genericMap: fn.genericMap };
    let fnCode = codeGenFnHeader(fn) + codeGenBody(fn.body, 1, false, ctx);
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
    if (type.val == 'num') {
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
  typeStr = replaceAll(typeStr, '*', '_arr');
  typeStr = replaceAll(typeStr, '^', '_arr');

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
    paramStr += ' *_' + fn.paramNames[i];
    if (i != fn.paramNames.length - 1) {
      paramStr += ', ';
    }
  }
  return headerStr + paramStr + ')';
}

function codeGenBody(body: Inst[], indent: number, includeBreak: boolean, ctx: FnContext): string {
  let bodyStr = ' {\n'
  for (let i = 0; i < body.length; i++) {
    bodyStr += codeGenInst(body[i], indent, ctx);
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

function codeGenInst(inst: Inst, indent: number, ctx: FnContext): string {
  let tabs = '';
  for (let i = 0; i < indent; i++) {
    tabs += '  ';
  }

  let addInst: string[] = [];

  let instText;
  if (inst.tag == 'declare') {
    let type = inst.val.type;
    if (inst.val.expr != null) {
      let rightExpr = codeGenExpr(inst.val.expr, addInst, ctx);
      instText = `${codeGenType(type)} _${inst.val.name} = ${rightExpr};`;
    } else {
      instText = `${codeGenType(type)} _${inst.val.name};`;
    }
  } 
  else if (inst.tag == 'assign') {
    let rightExpr = codeGenExpr(inst.val.expr, addInst, ctx);
    instText = `${codeGenLeftExpr(inst.val.to, addInst, ctx)} ${inst.val.op} ${rightExpr};`;
  } 
  else if (inst.tag == 'if') {
    instText = `if (${ codeGenExpr(inst.val.cond, addInst, ctx) }) ${ codeGenBody(inst.val.body, indent + 1, false, ctx) }`;
  } 
  else if (inst.tag == 'elif') {
    instText = `else if (${ codeGenExpr(inst.val.cond, addInst, ctx) }) ${ codeGenBody(inst.val.body, indent + 1, false, ctx) }`;
  }
  else if (inst.tag == 'else') {
    instText = `else ${ codeGenBody(inst.val, indent + 1, false, ctx) }`;
  }
  else if (inst.tag == 'while') {
    instText = `while (${ codeGenExpr(inst.val.cond, addInst, ctx) }) ${ codeGenBody(inst.val.body, indent + 1, false, ctx) }`;
  }
  else if (inst.tag == 'expr') {
    instText = codeGenExpr(inst.val, addInst, ctx) + ';';
  }
  else if (inst.tag == 'return') {
    if (inst.val == null) {
      instText == 'return;'
    } else {
      instText = `return ${ codeGenExpr(inst.val, addInst, ctx) };`;
    }
  }
  else if (inst.tag == 'include') {
    let instText: string = '';
    let typeIndex = 0;
    for (let i = 0; i < inst.val.lines.length; i++) {
      instText += inst.val.lines[i].slice(2) + '\n';
      while (instText.includes('$')) {
        let typeStr = codeGenType(inst.val.types[typeIndex]);
        instText = instText.replace('$', typeStr);
        typeIndex += 1;
      }
    }
    return instText;
  }

  else if (inst.tag == 'match') {
    instText = `switch (${codeGenExpr(inst.val.var, addInst, ctx)}._tag) {\n`;
    for (let branch of inst.val.branches) {
      instText += `${tabs}case \'${branch.enumVariant}\':${ codeGenBody(branch.body, indent + 1, true, ctx) }\n`;
    }
    instText += tabs + '}\n';
  }
  else if (inst.tag == 'continue' || inst.tag == 'break') {
    instText = inst.tag + ';';
  } 
  else if (inst.tag == 'for_in') {
    let name = inst.val.varName;
    let inner = `for (int _${name} = __range_${name}._start; _${name} < __range_${name}._end; _${name}++)`;
    inner += '' + codeGenBody(inst.val.body, indent + 2, false, ctx);
    instText = `{\n${tabs} ${codeGenType(RANGE)} __range_${name} = `
    instText += `${codeGenExpr(inst.val.iter, addInst, ctx)};\n${tabs}  ${inner}\n${tabs}}`;
  }

  let outputText = '';
  for (let i of addInst) {
    outputText += tabs + i + '\n';
  }
  outputText += tabs + instText + '\n'; 
  return outputText;
}

function codeGenExpr(expr: Expr, addInst: string[], ctx: FnContext): string {
  ctx.uniqueExprIndex += 1;
  if (expr.tag == 'bin') {
    if (expr.val.op == ':') {
      return 'undefined';
    }
    return `${ codeGenExpr(expr.val.left, addInst, ctx) } ${ expr.val.op } ${ codeGenExpr(expr.val.right, addInst, ctx) }`;
  } else if (expr.tag == 'not') {
    return '!' + codeGenExpr(expr.val, addInst, ctx);
  } else if (expr.tag == 'try') {
    let optType;
    if (expr.val.type.tag == 'enum') {
      optType = expr.val.type
    } else {
      return 'undefined';
    }

    let varName = '__temp_' + ctx.uniqueExprIndex;
    addInst.push(`${ codeGenType(optType) } ${varName} = ${codeGenExpr(expr.val, addInst, ctx)};`);
    addInst.push(`if (${varName}.tag == 1) return ${varName};`);
    return `${varName}._ok`;
  } else if (expr.tag == 'assert') {
    let optType;
    if (expr.val.type.tag == 'enum') {
      optType = expr.val.type
    } else {
      return 'undefined';
    }

    let varName = '__temp_' + ctx.uniqueExprIndex;
    addInst.push(`${ codeGenType(optType) } ${varName} = ${codeGenExpr(expr.val, addInst, ctx)};`);
    addInst.push(`if (${varName}.tag == 1) { printf("panic: %s", ${varName}._err); exit(-1); }`);
    return `${varName}._ok`;
  } else if (expr.tag == 'assert_bool') {
    return `if (!(${codeGenExpr(expr.val, addInst, ctx)})) { printf("assertion failed"); exit(-1); }`;
  } else if (expr.tag == 'fn_call') {
    return codeGenFnCall(expr.val, addInst, ctx);
  } else if (expr.tag == 'struct_init') {
    return codeGenStructInit(expr, addInst, ctx)
  } else if (expr.tag == 'str_const') {
    return `(${ codeGenType(STR) }){ ._refCount = 2, ._ptr = "${expr.val}", ._len = strlen("${expr.val}") }`;
  } else if (expr.tag == 'fmt_str') {
    let exprs = expr.val;
    let str = codeGenType(STR);

    let total = `__temp_${ctx.uniqueExprIndex}`;
    let totalLen = `__temp_${ctx.uniqueExprIndex + 1}`;
    let output = `__temp_${ctx.uniqueExprIndex + 2}`;
    let idx = `__temp_${ctx.uniqueExprIndex + 3}`;
    ctx.uniqueExprIndex += 3;

    addInst.push(`${str}* ${total} = malloc(sizeof(${str}) * ${exprs.length});`);
    addInst.push(`size_t ${totalLen} = 0;`);

    for (let i = 0; i < exprs.length; i++) {
      addInst.push(`${total}[${i}] = ${ codeGenExpr(exprs[i], addInst, ctx) };`);
      addInst.push(`${totalLen} += ${total}[${i}]._len;`);
    }
    
    addInst.push(`char* ${output} = malloc(${totalLen});`);
    addInst.push(`size_t ${idx} = 0;`)
    for (let i = 0; i < exprs.length; i++) {
      addInst.push(`memcpy(${output} + ${idx}, ${total}[${i}]._ptr, ${total}[${i}]._len);`)
      addInst.push(`${idx} += ${total}[${i}]._len;`)
    }

    return `(${str}){ ._refCount = 1, ._ptr = ${output}, ._len = ${totalLen} }`;
  } else if (expr.tag == 'char_const') {
    return `'${expr.val}'`;
  } else if (expr.tag == 'int_const') {
    return `${expr.val}`;
  } else if (expr.tag == 'bool_const') {
    return `${expr.val}`;
  } else if (expr.tag == 'num_const') {
    return `${expr.val}`;
  } else if (expr.tag == 'left_expr') {
    return codeGenLeftExpr(expr.val, addInst, ctx);
  } else if (expr.tag == 'is') {
    return `${codeGenLeftExpr(expr.left, addInst, ctx)}.tag == ${expr.variantIndex}`;
  } else if (expr.tag == 'enum_init') {
    if (expr.fieldExpr != null) {
      return `(${ codeGenType(expr.type) }){ .tag = ${expr.variantIndex}, ._${expr.fieldName} = ${ codeGenExpr(expr.fieldExpr, addInst, ctx) } }`;
    } else {
      return `(${ codeGenType(expr.type) }){ .tag = '${expr.variantIndex}' }`;
    }
  }

  return 'undefined';
}

function codeGenStructInit(expr: Expr, addInst: string[], ctx: FnContext): string {
  if (expr.tag != 'struct_init') {
    return 'undefined';
  }

  let structInit: StructInitField[] = expr.val;
  let output = `(${codeGenType(expr.type)}){ `;
  for (let i = 0; i < structInit.length; i++) {
    let initField = structInit[i];
    output += `._${initField.name} = ${codeGenExpr(initField.expr, addInst, ctx)}`;
    if (i != structInit.length - 1) {
      output += ', ';
    }
  }

  return output + ' }'
}

function codeGenFnCall(fnCall: FnCall, addInst: string[], ctx: FnContext): string {
  let output = codeGenLeftExpr(fnCall.fn, addInst, ctx) + '(';
  for (let i = 0; i < fnCall.exprs.length; i++) {
    if (fnCall.exprs[i].tag == 'left_expr') {
      output += `&(${ codeGenExpr(fnCall.exprs[i], addInst, ctx) })`;
    }
    else {
      let temp = `__temp_${ctx.uniqueExprIndex}`;
      ctx.uniqueExprIndex += 1;
      addInst.push(`${codeGenType(fnCall.exprs[i].type)} ${temp} = ${ codeGenExpr(fnCall.exprs[i], addInst, ctx) };`);
      output += `&${temp}`;
    }
    if (i != fnCall.exprs.length - 1) {
      output += ', ';
    }
  }

  return output + ')'
}

function codeGenLeftExpr(leftExpr: LeftExpr, addInst: string[], ctx: FnContext): string {
  if (leftExpr.tag == 'dot') {
    return `${codeGenExpr(leftExpr.val.left, addInst, ctx)}._${leftExpr.val.varName}`;
  } 
  else if (leftExpr.tag == 'arr_offset_int') {
    let indexType = leftExpr.val.var.type.tag;
    if (indexType == 'arr') {
      return `${codeGenLeftExpr(leftExpr.val.var, addInst, ctx)}._ptr[${codeGenExpr(leftExpr.val.index, addInst, ctx)}]`;
    } else if (indexType == 'primative' && leftExpr.val.var.type.val == 'str') {
      return `${codeGenLeftExpr(leftExpr.val.var, addInst, ctx)}[${codeGenExpr(leftExpr.val.index, addInst, ctx)}]`;
    }

    return `${codeGenLeftExpr(leftExpr.val.var, addInst, ctx)}._arr._ptr[${codeGenExpr(leftExpr.val.index, addInst, ctx)}]`;
  } 
  else if (leftExpr.tag == 'arr_offset_slice') {
    let range = `__temp_${ctx.uniqueExprIndex}`;
    addInst.push(`${ codeGenType(leftExpr.val.range.type) } ${range} = ${codeGenExpr(leftExpr.val.range, addInst, ctx)};`);
    return `(${codeGenType(leftExpr.type)}){ ._ptr = ${codeGenLeftExpr(leftExpr.val.var, addInst, ctx)}._ptr + ${range}._start, ._len = ${range}._end - ${range}._start, ._refCount = 2 }`;
  }
  else if (leftExpr.tag == 'prime') {
    return `${ codeGenExpr(leftExpr.val, addInst, ctx) }._${leftExpr.variant}`;
  }
  else if (leftExpr.tag == 'fn') {
    return getFnUniqueId(leftExpr.unitName, leftExpr.fnName, leftExpr.type);
  }
  else {
    if (leftExpr.isParam) {
      return `(*_${leftExpr.val})`;
    }
    else {
      return `_${leftExpr.val}`;
    }
  }
}

// java implementation taken from https://stackoverflow.com/questions/6122571/simple-non-secure-hash-function-for-javascript
function getFnUniqueId(fnUnitName: string, fnName: string, fnType: Type): string {
  return ('_' + fnUnitName.replace('.', '_') + '_' + fnName + '_' + codeGenType(fnType)).replace(' ', '').replace('*', '_arr');
}

