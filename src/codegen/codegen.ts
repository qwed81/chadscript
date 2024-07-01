import { Program  } from '../analyze/analyze';
import { Inst, LeftExpr, Expr, StructInitField, FnCall } from '../analyze/analyze';
import { toStr, Type, RANGE, STR, VOID, createRes } from '../analyze/types';
import { replaceGenerics, CProgram, CStruct, CFn } from './concreteFns';

export {
  codegen, codeGenType
}

interface FnContext {
  strTable: string[]
  genericMap: Map<string, Type>,
  vars: [Type, string][]
  varsNoStack: string[]
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

  // reserve the strTable
  programStr += `\nchar *strTable[${prog.strTable.length}];`

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
  programStr += codeGenStructs(newProg.orderedStructs);

  for (let fn of newProg.fns) {
    programStr += codeGenFnHeader(fn) + ';';
  }

  // generate all of the functions
  for (let fn of newProg.fns) {
    programStr += codeGenFn(fn, prog.strTable);
  }

  let entry = newProg.entry;
  let entryName = getFnUniqueId(entry.unitName, entry.name, entry.type);

  // output the strTable
  let totalStrLen = 0;
  for (let i = 0; i < prog.strTable.length; i++) {
    totalStrLen += prog.strTable[i].length + 1
  }
  
  programStr += 
  `
int main() {
  char* totalStr = malloc(${totalStrLen});
  memset(totalStr, 0, ${totalStrLen});
  size_t index = 0;
  `
    for (let i = 0; i < prog.strTable.length; i++) {
      programStr +=
    `
  memcpy(&totalStr[index], "${prog.strTable[i]}", ${prog.strTable[i].length + 1});
  strTable[${i}] = &totalStr[index];
  index += 1 + ${prog.strTable[i].length};
    `
    }
  programStr +=
  `
  ${ codeGenType(createRes(VOID)) } result = ${entryName}();
  free(totalStr);
  return result.tag;
}
  `;
  return programStr;
}

function codeGenFn(fn: CFn, strTable: string[]) {
  if (fn.type.tag != 'fn') {
    return;
  }
  
  let ctx: FnContext = { 
    varsNoStack: [],
    vars: [],
    genericMap: fn.genericMap,
    strTable: strTable 
  };
  let fnCode = codeGenFnHeader(fn) + ' {';
  let retType = fn.type.val.returnType;
  let bodyStr = '\n';
  if (retType.tag != 'primative' || retType.val != 'void') {
    if (retType.tag == 'enum' || retType.tag == 'struct' || retType.tag == 'arr') {
      fnCode += `\n  ${codeGenType(fn.type.val.returnType)} ret = { 0 };`;
    } 
    else {
      fnCode += `\n  ${codeGenType(fn.type.val.returnType)} ret;`;
    }
  }

  // must call codeGenInst before using ctx.vars
  for (let i = 0; i < fn.body.length; i++) {
    bodyStr += codeGenInst(fn.body[i], 1, ctx);
  }

  for (let i = 0; i < ctx.vars.length; i++) {
    fnCode += `${ '\n  ' + codeGenType(ctx.vars[i][0]) } ${ ctx.vars[i][1] }`;
    let tag = ctx.vars[i][0].tag;
    // required to ensure the safety of the program so a non-initialized value is not freed
    if (tag == 'struct' || tag == 'arr' || tag == 'enum') {
      fnCode += ' = { 0 }';
    }
    fnCode += ';';
  }

  fnCode += bodyStr;
  fnCode += 'cleanup:';
  let refCountChanges: string[] = [];
  for (let i = 0; i < ctx.vars.length; i++) {
    // decrease the reference count of everything on the stack by 1 to cleanup
    changeRefCount(refCountChanges, ctx.vars[i][1], ctx.vars[i][0], -1);
  }

  for (let i = 0; i < refCountChanges.length; i++) {
    fnCode += '\n  ' + refCountChanges[i];
  }

  if (retType.tag != 'primative' || retType.val != 'void') {
    fnCode += '\n  return ret;';
  }
  else {
    fnCode += '\n  return;'
  }
  fnCode += '\n}';

  return fnCode;
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
  let headerStr = '\n static ' + codeGenType(fn.type.val.returnType) +  ' ' + name + '(';
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

interface AddInst {
  before: string[],
  after: string[]
}

function codeGenInst(inst: Inst, indent: number, ctx: FnContext): string {
  let tabs = '';
  for (let i = 0; i < indent; i++) {
    tabs += '  ';
  }

  let addInst: AddInst = {
    before: [],
    after: []
  };

  let instText;
  if (inst.tag == 'declare') {
    let type = inst.val.type;
    ctx.vars.push([type, '_' + inst.val.name]);

    if (inst.val.expr != null) {
      let rightExpr = codeGenExpr(inst.val.expr, addInst, ctx, false);
      let leftExpr = `_${inst.val.name}`;
      // this should just become an assign as the value is declared prior

      changeRefCount(addInst.before, leftExpr, type, -1);
      instText = `${leftExpr} = ${rightExpr};`;
      changeRefCount(addInst.after, rightExpr, type, 1);
    }
  } 
  else if (inst.tag == 'assign') {
    let rightExpr = codeGenExpr(inst.val.expr, addInst, ctx, false);
    let leftExpr = codeGenLeftExpr(inst.val.to, addInst, ctx);

    let type = inst.val.expr.type;
    changeRefCount(addInst.before, leftExpr, type, -1);
    instText = `${leftExpr} ${inst.val.op} ${rightExpr};`;
    changeRefCount(addInst.after, rightExpr, type, 1);
  } 
  else if (inst.tag == 'if') {
    instText = `if (${ codeGenExpr(inst.val.cond, addInst, ctx, false) }) ${ codeGenBody(inst.val.body, indent + 1, false, ctx) }`;
  } 
  else if (inst.tag == 'elif') {
    instText = `else if (${ codeGenExpr(inst.val.cond, addInst, ctx, false) }) ${ codeGenBody(inst.val.body, indent + 1, false, ctx) }`;
  }
  else if (inst.tag == 'else') {
    instText = `else ${ codeGenBody(inst.val, indent + 1, false, ctx) }`;
  }
  else if (inst.tag == 'while') {
    instText = `while (${ codeGenExpr(inst.val.cond, addInst, ctx, true) }) ${ codeGenBody(inst.val.body, indent + 1, false, ctx) }`;
  }
  else if (inst.tag == 'expr') {
    instText = codeGenExpr(inst.val, addInst, ctx, false) + ';';
  }
  else if (inst.tag == 'return') {
    if (inst.val == null) {
      instText == 'goto cleanup;'
    } else {
      instText = `ret = ${ codeGenExpr(inst.val, addInst, ctx, false) };`;
      changeRefCount(addInst.after, 'ret', inst.val.type, 1);
      addInst.after.push('goto cleanup;');
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
    instText = `switch (${codeGenExpr(inst.val.var, addInst, ctx, false)}._tag) {\n`;
    for (let branch of inst.val.branches) {
      instText += `${tabs}case \'${branch.enumVariant}\':${ codeGenBody(branch.body, indent + 1, true, ctx) }\n`;
    }
    instText += tabs + '}\n';
  }
  else if (inst.tag == 'continue' || inst.tag == 'break') {
    instText = inst.tag + ';';
  } 
  else if (inst.tag == 'for_in') {
    let varName = inst.val.varName;
    let iterName = codeGenExpr(inst.val.iter, addInst, ctx, false);
    instText = `for (int _${varName} = ${iterName}._start; _${varName} < ${iterName}._end; _${varName}++)`;
    instText += codeGenBody(inst.val.body, indent + 1, false, ctx);
  }

  let outputText = '';
  for (let i of addInst.before) {
    outputText += tabs + i + '\n';
  }
  outputText += tabs + instText + '\n'; 
  for (let i of addInst.after) {
    outputText += tabs + i + '\n';
  }
  return outputText;
}

// used by exprs to get a unique name
function reserveVar(ctx: FnContext, type: Type): string {
  let name = `__expr_${ctx.vars.length}`;
  ctx.vars.push([type, name]);
  return name;
}

function reserveVarNoStack(ctx: FnContext): string {
  let name = `__temp_${ctx.varsNoStack.length}`;
  ctx.varsNoStack.push(name);
  return name;
}

// if the instruction is a left expr: returns the c syntax for accessing the variable
// if the instruction is a expr: reservers a variable and sets it to the expr, and then returns the reserved name
function codeGenExpr(expr: Expr, addInst: AddInst, ctx: FnContext, inline: boolean): string {
  let exprText: string = 'undefined';

  if (expr.tag == 'bin') {
    if (expr.val.op == ':') {
      return 'undefined';
    }
    exprText = `${ codeGenExpr(expr.val.left, addInst, ctx, true) } ${ expr.val.op } ${ codeGenExpr(expr.val.right, addInst, ctx, true) }`;
  } 
  else if (expr.tag == 'not') {
    exprText = '!' + codeGenExpr(expr.val, addInst, ctx, false);
  } 
  else if (expr.tag == 'try') {
    let exprName = codeGenExpr(expr.val, addInst, ctx, false);
    addInst.before.push(`if (${exprName}.tag == 1) return ${exprName};`);
    exprText = `${exprName}._ok`;
  }
  else if (expr.tag == 'assert') {
    let exprName = codeGenExpr(expr.val, addInst, ctx, false);
    addInst.before.push(`if (${exprName}.tag == 1) { printf("panic: %s", ${exprName}._err); exit(-1); }`);
    exprText = `${exprName}._ok`;
  }
  else if (expr.tag == 'assert_bool') {
    exprText = `if (!(${codeGenExpr(expr.val, addInst, ctx, false)})) { printf("assertion failed"); exit(-1); }`;
  }
  else if (expr.tag == 'fn_call') {
    exprText = codeGenFnCall(expr.val, addInst, ctx);
  }
  else if (expr.tag == 'struct_init') {
    exprText = codeGenStructInit(expr, addInst, ctx)
  } 
  else if (expr.tag == 'arr_init') {
    if (expr.type.tag != 'arr') {
      return 'undefined';
    }
    let type = codeGenType(expr.type.val);
    let ptr = reserveVarNoStack(ctx);
    let refCount = reserveVarNoStack(ctx);
    let typedPtr = reserveVarNoStack(ctx);
    addInst.before.push(`void *${ptr} = malloc(${expr.val.length} * sizeof(${type}) + sizeof(int));`);
    addInst.before.push(`${type} *${typedPtr} = (${type}*)(${ptr});`);
    addInst.before.push(`int *${refCount} = (int*)(${typedPtr} + ${expr.val.length});`);
    addInst.before.push(`*${refCount} = 1;`);
    for (let i = 0; i < expr.val.length; i++) {
      addInst.before.push(`${typedPtr}[${i}] = ${ codeGenExpr(expr.val[i], addInst, ctx, false) };`);
    }
    exprText = `(${ codeGenType(expr.type) }){ ._ptr = ${typedPtr}, ._len = ${expr.val.length}, ._refCount = ${refCount} }`;
  }
  else if (expr.tag == 'str_const') {
    exprText = `(${ codeGenType(STR) }){ ._ptr = strTable[${expr.val}], ._len = ${ ctx.strTable[expr.val].length }, ._refCount = NULL }`;
  }
  else if (expr.tag == 'fmt_str') {
    let exprs = expr.val;
    let strType = codeGenType(STR);

    let total = reserveVarNoStack(ctx);
    let totalLen = reserveVarNoStack(ctx);
    let output = reserveVarNoStack(ctx);
    let idx = reserveVarNoStack(ctx);

    addInst.before.push(`${strType}* ${total} = malloc(sizeof(${strType}) * ${exprs.length});`);
    addInst.before.push(`size_t ${totalLen} = 0;`);

    for (let i = 0; i < exprs.length; i++) {
      addInst.before.push(`${total}[${i}] = ${ codeGenExpr(exprs[i], addInst, ctx, false) };`);
      addInst.before.push(`${totalLen} += ${total}[${i}]._len;`);
    }
    
    addInst.before.push(`char* ${output} = malloc(${totalLen});`);
    addInst.before.push(`size_t ${idx} = 0;`)
    for (let i = 0; i < exprs.length; i++) {
      addInst.before.push(`memcpy(${output} + ${idx}, ${total}[${i}]._ptr, ${total}[${i}]._len);`)
      addInst.before.push(`${idx} += ${total}[${i}]._len;`)
    }

    return `(${strType}){ ._ptr = ${output}, ._len = ${totalLen} }`;
  } else if (expr.tag == 'char_const') {
    exprText = `'${expr.val}'`;
  } else if (expr.tag == 'int_const') {
    exprText = `${expr.val}`;
  } else if (expr.tag == 'bool_const') {
    exprText = `${expr.val}`;
  } else if (expr.tag == 'num_const') {
    exprText = `${expr.val}`;
  }  else if (expr.tag == 'is') {
    exprText = `${codeGenLeftExpr(expr.left, addInst, ctx)}.tag == ${expr.variantIndex}`;
  } else if (expr.tag == 'enum_init') {
    if (expr.fieldExpr != null) {
      let generatedExpr = codeGenExpr(expr.fieldExpr, addInst, ctx, false);
      changeRefCount(addInst.after, generatedExpr, expr.fieldExpr.type, 1);
      exprText = `(${ codeGenType(expr.type) }){ .tag = ${expr.variantIndex}, ._${expr.fieldName} = ${ generatedExpr } }`;
    } else {
      exprText = `(${ codeGenType(expr.type) }){ .tag = ${expr.variantIndex} }`;
    }
  } 
  else if (expr.tag == 'left_expr') {
    exprText = codeGenLeftExpr(expr.val, addInst, ctx);

    // doesn't need to reserve the variable
    return exprText;
  }

  // void types do not need to reserve their spot or be saved to the stack
  if (expr.type.tag == 'primative' && expr.type.val == 'void') {
    return exprText;
  }

  // reserve a spot on the stack for the expression so it can be reference counted
  // and so it can be passed to a function by pointer
  let exprName = reserveVar(ctx, expr.type);
  let exprAssign = `${ exprName } = ${ exprText }`; 
  if (inline) {
    return `(${exprAssign})`;
  }

  addInst.before.push(`${exprAssign};`);
  return exprName;
}

function codeGenStructInit(expr: Expr, addInst: AddInst, ctx: FnContext): string {
  if (expr.tag != 'struct_init') {
    return 'undefined';
  }

  let structInit: StructInitField[] = expr.val;
  let output = `(${codeGenType(expr.type)}){ `;
  for (let i = 0; i < structInit.length; i++) {
    let initField = structInit[i];
    let exprText = codeGenExpr(initField.expr, addInst, ctx, false);
    output += `._${initField.name} = ${exprText}`;

    // because the initExpr is stored on the stack, we need to inc the ref count here as well
    changeRefCount(addInst.after, exprText, initField.expr.type, 1);
    if (i != structInit.length - 1) {
      output += ', ';
    }
  }

  return output + ' }'
}

function codeGenFnCall(fnCall: FnCall, addInst: AddInst, ctx: FnContext): string {
  let output = codeGenLeftExpr(fnCall.fn, addInst, ctx) + '(';
  for (let i = 0; i < fnCall.exprs.length; i++) {
    output += `&${ codeGenExpr(fnCall.exprs[i], addInst, ctx, false) }`;
    if (i != fnCall.exprs.length - 1) {
      output += ', ';
    }
  }

  return output + ')'
}

function codeGenLeftExpr(leftExpr: LeftExpr, addInst: AddInst, ctx: FnContext): string {
  if (leftExpr.tag == 'dot') {
    return `${codeGenExpr(leftExpr.val.left, addInst, ctx,  false)}._${leftExpr.val.varName}`;
  } 
  else if (leftExpr.tag == 'arr_offset_int') {
    let indexType = leftExpr.val.var.type.tag;
    if (indexType == 'arr') {
      return `${codeGenLeftExpr(leftExpr.val.var, addInst, ctx)}._ptr[${codeGenExpr(leftExpr.val.index, addInst, ctx, false)}]`;
    } else if (indexType == 'primative' && leftExpr.val.var.type.val == 'str') {
      return `${codeGenLeftExpr(leftExpr.val.var, addInst, ctx)}[${codeGenExpr(leftExpr.val.index, addInst, ctx, false)}]`;
    }

    return `${codeGenLeftExpr(leftExpr.val.var, addInst, ctx)}._arr._ptr[${codeGenExpr(leftExpr.val.index, addInst, ctx, false)}]`;
  } 
  else if (leftExpr.tag == 'arr_offset_slice') {
    let range = codeGenExpr(leftExpr.val.range, addInst, ctx, false);
    let fromVar = codeGenLeftExpr(leftExpr.val.var, addInst, ctx);
    return `(${codeGenType(leftExpr.type)}){ ._ptr = ${fromVar}._ptr + ${range}._start, ._len = ${range}._end - ${range}._start, ._refCount = ${fromVar}._refCount }`;
  }
  else if (leftExpr.tag == 'prime') {
    return `${ codeGenExpr(leftExpr.val, addInst, ctx, false) }._${leftExpr.variant}`;
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

function changeRefCount(addToList: string[], leftExpr: string, type: Type, amt: number) {
  let typeNoSpace = codeGenType(type);
  typeNoSpace = typeNoSpace.replace(' ', '');
  if (type.tag == 'enum' || type.tag == 'struct' || type.tag == 'arr') {
    addToList.push(`changeRefCount_${typeNoSpace}(&${leftExpr}, ${amt});`);
  }
}

function codeGenStructs(structs: CStruct[]): string {
  let structStr = '';
  for (let struct of structs) {
    let type: Type = { tag: 'primative', val: 'void' };
    if (struct.tag == 'struct') {
      type = struct.val.name;
      structStr += '\n' + codeGenType(struct.val.name) + ' {';
      for (let i = 0; i < struct.val.fieldTypes.length; i++) {
        structStr += '\n  ' + codeGenType(struct.val.fieldTypes[i]) + ' _' + struct.val.fieldNames[i] + ';';
      }
      structStr += '\n};'
    }
    else if (struct.tag == 'enum') {
      type = struct.val.name;
      structStr += '\n' + codeGenType(struct.val.name) + ' {';
      structStr += '\n  int tag;';
      structStr += '\n  union {';
      for (let i = 0; i < struct.val.fieldTypes.length; i++) {
        let typeStr = codeGenType(struct.val.fieldTypes[i]);
        if (typeStr == 'void') {
          typeStr = 'int';
        }
        structStr += '\n    ' + typeStr + ' _' + struct.val.fieldNames[i] + ';' 
      }
      structStr += '\n  };\n};'
    }
    else if (struct.tag == 'arr') {
      type = struct.val;
      if (struct.val.tag != 'arr') {
        continue;
      }

      structStr += '\n' + codeGenType(struct.val) + ' {';
      structStr += '\n  ' + codeGenType(struct.val.val) + ' *_ptr;';
      structStr += '\n  int *_refCount;';
      structStr += '\n  int _len;'
      structStr += '\n};'
    }

    // generate out inc and dec reference count for every stryct
    let typeStr = codeGenType(type);
    let typeStrNoSpace = typeStr.replace(' ', '');
    structStr += `\nstatic void changeRefCount_${typeStrNoSpace}(${typeStr} *s, int amt) {`
    if (struct.tag == 'arr') {
      if (type.tag != 'arr') {
        continue;
      }

      structStr += 
      `
  if (s->_refCount == NULL) return;
  *s->_refCount += amt;
  if (*s->_refCount == 0) {
  `
      if (type.val.tag != 'primative') {
        structStr +=
        `
    for (size_t i = 0; i < s->_len; i++) {
      changeRefCount_${codeGenType(type.val)}(&s[i], amt);
    }`
      }
      structStr += `  free(s->_ptr);\n  }`
    }
    else if (struct.tag == 'struct'){
      if (type.tag != 'struct') {
        continue;
      }
      for (let i = 0; i < type.val.fields.length; i++) {
        if (type.val.fields[i].type.tag == 'primative') {
          continue;
        }

        let typeStrNoSpace = codeGenType(type.val.fields[i].type);
        typeStrNoSpace = typeStrNoSpace.replace(' ', '');
        structStr += `\n  changeRefCount_${typeStrNoSpace}(&s->_${type.val.fields[i].name}, amt);`;
      }
    }
    else if (struct.tag == 'enum') {
      if (type.tag != 'enum') {
        continue;
      }
      for (let i = 0; i < type.val.fields.length; i++) {
        if (type.val.fields[i].type.tag == 'primative') {
          continue;
        }

        let typeStrNoSpace = codeGenType(type.val.fields[i].type);
        typeStrNoSpace = typeStrNoSpace.replace(' ', '');
        structStr += `\n  if (s->tag == ${i}) changeRefCount_${typeStrNoSpace}(&s->_${type.val.fields[i].name}, amt);`;
      }
    }
    structStr += '\n}';
  }

  return structStr;
}
