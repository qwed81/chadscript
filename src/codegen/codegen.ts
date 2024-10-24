import { Position, compilerError, logError, NULL_POS } from '../util';
import { Program  } from '../analyze/analyze';
import { Inst, LeftExpr, Expr, StructInitField, FnCall, Fn } from '../analyze/analyze';
import { toStr, Type, STR, VOID, ERR, createRes } from '../analyze/types';
import { replaceGenerics, CProgram, CStruct, CFn } from './concreteFns';

export {
  codegen, codeGenType, OutputFile
}

interface FnContext {
  strTable: string[]
  genericMap: Map<string, Type>,
  cstructMap: Map<string, CStruct> // maps the type to its CStruct
  vars: [Type, string][]
  varsNoStack: string[]
  returnType: Type
}

const includes = [
  'stdio.h', 'stdlib.h', 'string.h', 'stdbool.h', 'stdint.h'
]

interface OutputFile {
  name: string,
  data: string
}

// generates the c output for the given program
function codegen(prog: Program): OutputFile[] {
  let mainFns: Fn[] = prog.fns.filter(x => x.name == 'main');
  if (mainFns.length > 1) {
    logError(NULL_POS, 'more than one \'main\' function provided');
    return [];
  }
  else if (mainFns.length == 0) {
    logError(NULL_POS, 'no \'main\' function provided');
    return [];
  }
 
  let newProg: CProgram = replaceGenerics(prog, mainFns[0]);

  let chadDotH = 'char **uv_setup_args(int argc, char **argv); int initRuntime(int threadCount);';
  let chadDotC = '';
  for (let include of includes) {
    chadDotH += '\n#include <' + include + '>';
    chadDotC += '\n#include <' + include + '>';
  }

  for (let i = 0; i < prog.includes.length; i++) {
    chadDotC += '\n#include "../' + prog.includes[i] + '"';
  }

  chadDotH += '\nvoid chad_panic(const char* file, int64_t line, const char* message);'
  chadDotC += '\n#include "chad.h"';
  chadDotC += '\nvoid chad_panic(const char* file, int64_t line, const char* message) {'
  chadDotC += '\n\tfprintf(stderr, "panic in \'%s.chad\' line %ld: %s\\n", file, line, message); \nexit(-1); \n}'
  chadDotC += 'int initRuntime(int amt);';

  let cstructMap: Map<string, CStruct> = new Map();

  // forward declare structs for pointers
  for (let struct of newProg.orderedStructs) {
    if (struct.tag == 'struct' || struct.tag == 'enum') {
      cstructMap.set(JSON.stringify(struct.val.name), struct);
      if (struct.val.name.tag != 'struct' || struct.val.name.val.unit != 'extern') {
        chadDotH += '\n' + codeGenType(struct.val.name) + ';';
      }

    }
    if (struct.tag == 'fn' && struct.val.tag == 'fn') {
      let fnType = struct.val.val;
      chadDotH += `\ntypedef ${codeGenType(fnType.returnType)} (*${codeGenType(struct.val)})(`;
      for (let i = 0; i < fnType.paramTypes.length; i++) {
        chadDotH += `${codeGenType(fnType.paramTypes[i])}*`;
        if (i != fnType.paramTypes.length - 1) {
          chadDotH += ', ';
        }
      }
      chadDotH += ');';
    }
  }

  // generate implementations of types
  chadDotH += codeGenStructDefs(newProg.orderedStructs);
  chadDotC += codeGenRefcountImpls(newProg.orderedStructs);

  for (let c of newProg.consts) {
    chadDotH += `\nextern ${codeGenType(c.type)} ${getConstUniqueId(c.unitName, c.name)};`;
  }

  for (let fn of newProg.fns) {
    chadDotH += codeGenFnHeader(fn) + ';';
  }

  // generate all constants
  for (let c of newProg.consts) {
    chadDotC += `\n${codeGenType(c.type)} ${getConstUniqueId(c.unitName, c.name)} = ${codeGenConst(c.expr)};`;
  }

  // generate all of the functions
  for (let fn of newProg.fns) {
    chadDotC += codeGenFn(fn, prog.strTable, cstructMap);
  }

  let entry = newProg.entry;
  let entryName = getFnUniqueId(entry.unitName, entry.name, entry.type);

  chadDotC +=
  `
  int main() {
  initRuntime(0);
  ${ codeGenType(createRes(VOID, ERR)) } result = ${entryName}();
  if (result.tag == 1) {
    fprintf(stderr, "%s\\n", result._val1._message._base);
  }
  return result.tag;
  }
  `;

  return [
    { name: 'chad.h', data: chadDotH },
    { name: 'chad.c', data: chadDotC },
  ];
}

function codeGenConst(expr: Expr): string {
  if (expr.tag == 'bin') {
    return `${codeGenConst(expr.val.left)} ${expr.val} ${codeGenConst(expr.val.right)}`;
  } else if (expr.tag == 'char_const') {
    return `'${expr.val}'`;
  } else if (expr.tag == 'int_const') {
    return `${expr.val}`;
  } else if (expr.tag == 'bool_const') {
    return `${expr.val}`;
  } else if (expr.tag == 'num_const') {
    return `${expr.val}`;
  } else if (expr.tag == 'str_const') {
    return `(${ codeGenType(STR) }){ ._base = "${expr.val}", ._len = ${ strLen(expr.val) } }`;
  }

  compilerError('unexpected expression in const');
  return 'undefined';
}

function defaultUnitData(): string {
  let unitData = '#include "chad.h"';
  let headers = ["stdio.h", "stdlib.h", "string.h", "stdbool.h", "uv.h", "async.h"];
  for (let i = 0; i < headers.length; i++) {
    unitData += `\n#include "${headers[i]}"`;
  }
  return unitData;
}

function codeGenFn(fn: CFn, strTable: string[], cstructMap: Map<string, CStruct>) {
  if (fn.type.tag != 'fn') {
    return;
  }
  
  let ctx: FnContext = { 
    varsNoStack: [],
    vars: [],
    genericMap: fn.genericMap,
    strTable: strTable,
    returnType: fn.type.val.returnType,
    cstructMap
  };
  let fnCode = codeGenFnHeader(fn) + ' {';
  let retType = fn.type.val.returnType;
  let bodyStr = '\n';
  if (retType.tag != 'primative' || retType.val != 'void') {
    if (retType.tag == 'enum' || retType.tag == 'struct') {
      fnCode += `\n  ${codeGenType(fn.type.val.returnType)} ret = { 0 };`;
    } 
    else {
      fnCode += `\n  ${codeGenType(fn.type.val.returnType)} ret;`;
    }
  }

  // must call codeGenInst before using ctx.vars
  for (let i = 0; i < fn.body.length; i++) {
    bodyStr += codeGenInst(fn.body, i, 1, ctx);
  }

  for (let i = 0; i < ctx.vars.length; i++) {
    fnCode += `${ '\n  ' + codeGenType(ctx.vars[i][0]) } ${ ctx.vars[i][1] }`;
    let tag = ctx.vars[i][0].tag;
    // required to ensure the safety of the program so a non-initialized value is not freed
    if (tag == 'struct'|| tag == 'enum') {
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
    if (type.val == 'int' || type.val == 'i64') return 'int64_t';
    else if (type.val == 'i32') return 'int32_t';
    else if (type.val == 'i16') return 'int16_t';
    else if (type.val == 'i8') return 'int8_t';
    else if (type.val == 'u64') return 'uint16_t';
    else if (type.val == 'u32') return 'uint32_t';
    else if (type.val == 'u16') return 'uint16_t';
    else if (type.val == 'u8') return 'uint8_t';
    else if (type.val == 'num' || type.val == 'f64') return 'double';
    else if (type.val == 'f32') return 'float';
    else if (type.val == 'byte') return 'unsigned char';
    return type.val;
  }
  if (type.tag == 'ptr') {
    return codeGenType(type.val) + '*';
  }

  let typeStr = toStr(type);
  if (type.tag != 'struct' || type.val.unit != 'extern') {
    typeStr = '_' + typeStr;
  }

  typeStr = replaceAll(typeStr, '(', '_op');
  typeStr = replaceAll(typeStr, ')', '_cp');
  typeStr = replaceAll(typeStr, '[', '_os');
  typeStr = replaceAll(typeStr, ']', '_cs');
  typeStr = replaceAll(typeStr, ',', '_c');
  typeStr = replaceAll(typeStr, '.', '_');
  typeStr = replaceAll(typeStr, '/', '_');
  typeStr = replaceAll(typeStr, '*', '_op_cp');
  typeStr = replaceAll(typeStr, '&', '');
  typeStr = replaceAll(typeStr, ' ', '');

  if (type.tag == 'struct' || type.tag == 'enum') {
    return 'struct ' + typeStr;
  }
  return typeStr;
}

function codeGenFnHeader(fn: CFn): string {
  if (fn.type.tag != 'fn') {
    return '';
  }

  // drop is a 'global' function as it does not really
  // exist in any unit because it is called by the compiler regardless of imports
  let unitName = fn.unitName;
  if (fn.name == 'drop') {
    unitName = '';
  }

  let name = getFnUniqueId(unitName, fn.name, fn.type);
  let headerStr = '\n ' + codeGenType(fn.type.val.returnType) +  ' ' + name + '(';
  let paramStr = '';

  for (let i = 0; i < fn.paramNames.length; i++) {
    let ref = true;
    if (fn.type.val.paramTypes[i].tag == 'fn') {
      ref = false;
    }
    paramStr += codeGenType(fn.type.val.paramTypes[i]);
    paramStr += ` ${ref ? '*' : ''}_${fn.paramNames[i]}`
    if (i != fn.paramNames.length - 1) {
      paramStr += ', ';
    }
  }
  return headerStr + paramStr + ')';
}

function codeGenBody(body: Inst[], indent: number, includeBreak: boolean, includeBraces: boolean, ctx: FnContext): string {
  let bodyStr = '';
  if (includeBraces) {
    bodyStr = ' {\n'
  } 

  for (let i = 0; i < body.length; i++) {
    bodyStr += codeGenInst(body, i, indent, ctx);
  }

  let tabs = '';
  for (let i = 0; i < indent - 1; i++) {
    tabs += '  ';
  }

  if (includeBreak) {
    bodyStr += tabs + '  break;\n';
  }

  if (includeBraces) {
    return bodyStr + tabs + '}'
  }
  return bodyStr;
}

interface AddInst {
  before: string[],
  after: string[]
}

function codeGenInst(insts: Inst[], instIndex: number, indent: number, ctx: FnContext): string {
  let tabs = '';
  for (let i = 0; i < indent; i++) {
    tabs += '  ';
  }

  let addInst: AddInst = {
    before: [],
    after: []
  };

  let instText;
  let inst = insts[instIndex];
  if (inst.tag == 'declare') {
    let type = inst.val.type;
    ctx.vars.push([type, '_' + inst.val.name]);

    if (inst.val.expr != null) {
      let rightExpr = codeGenExpr(inst.val.expr, addInst, ctx, inst.position);
      let leftExpr = `_${inst.val.name}`;
      // this should just become an assign as the value is declared prior

      changeRefCount(addInst.before, leftExpr, type, -1);
      instText = `${leftExpr} = ${rightExpr};`;
      changeRefCount(addInst.after, rightExpr, type, 1);
    }
    else {
      instText = '';
    }

  } 
  else if (inst.tag == 'arena') {
    instText = codeGenBody(inst.val, indent + 1, false, false, ctx);
  }
  else if (inst.tag == 'assign') {
    let rightExpr = codeGenExpr(inst.val.expr, addInst, ctx, inst.position);
    let leftExpr = codeGenLeftExpr(inst.val.to, addInst, ctx, inst.position);

    let type = inst.val.expr.type;
    changeRefCount(addInst.before, leftExpr, type, -1);
    instText = `${leftExpr} ${inst.val.op} ${rightExpr};`;
    changeRefCount(addInst.after, rightExpr, type, 1);
  } 
  else if (inst.tag == 'if') {
    instText = `if (${ codeGenExpr(inst.val.cond, addInst, ctx, inst.position) }) ${ codeGenBody(inst.val.body, indent + 1, false, true, ctx) }`;
    if (instIndex + 1 < insts.length) {
      let nextInst = insts[instIndex + 1];
      if (nextInst.tag == 'elif') {
        instText += 'else {'
        // treat the instruction as an if statement embedded in an else
        insts[instIndex + 1].tag = 'if';
        instText += codeGenInst(insts, instIndex + 1, indent + 1, ctx);
        insts[instIndex + 1].tag = 'elif';
        instText += '}';
      }
      else if (nextInst.tag == 'else') {
        instText += 'else {'
        instText += codeGenBody(nextInst.val, indent + 1, false, false, ctx);
        instText += '}';
      }
    }
  } 
  else if (inst.tag == 'elif') {
    // generated before
    instText = '';
  }
  else if (inst.tag == 'else') {
    // generated before
    instText = '';
  }
  else if (inst.tag == 'while') {
    addInst.before.push(`while (true) {`);
    let bodyText = '';
    let condName = codeGenExpr(inst.val.cond, addInst, ctx, inst.position);
    bodyText += `if (!${condName}) break;\n`
    instText = bodyText + `${tabs}}`;
  }
  else if (inst.tag == 'expr') {
    instText = codeGenExpr(inst.val, addInst, ctx, inst.position) + ';';
  }
  else if (inst.tag == 'return') {
    if (inst.val == null) {
      instText = 'goto cleanup;'
    } else {
      instText = `ret = ${ codeGenExpr(inst.val, addInst, ctx, inst.position) };`;
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
  else if (inst.tag == 'continue' || inst.tag == 'break') {
    instText = inst.tag + ';';
  } 
  else if (inst.tag == 'for_in') {
    if (inst.val.nextFn.type.tag != 'fn' || inst.val.nextFn.tag != 'fn') {
      return 'undefined';
    }

    let varName = `_${inst.val.varName}__opt`;
    let iterName = codeGenExpr(inst.val.iter, addInst, ctx, inst.position);
    let itemType = inst.val.nextFn.type.val.returnType;
    let nextFnName = getFnUniqueId(inst.val.nextFn.unitName, inst.val.nextFn.fnName, inst.val.nextFn.type);

    instText = `for (${codeGenType(itemType)} ${varName} = ${nextFnName}(&${iterName}); ${varName}.tag == 0; ${varName} = ${nextFnName}(&${iterName})) {`;
    instText += codeGenBody(inst.val.body, indent + 1, false, false, ctx);
    let addToList: string[] = [];
    changeRefCount(addToList, varName, itemType, -1);
    instText += addToList[0];
    instText += tabs + '}';
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

function strLen(expr: string) {
  let subCount = 0;
  for (let i = 0; i < expr.length; i++) {
    if (expr[i] == '\\') {
      subCount += 1;
    }
  }
  return expr.length - subCount;
}

// if the instruction is a left expr: returns the c syntax for accessing the variable
// if the instruction is a expr: reservers a variable and sets it to the expr, and then returns the reserved name
function codeGenExpr(expr: Expr, addInst: AddInst, ctx: FnContext, position: Position): string {
  let exprText: string = 'undefined';

  if (expr.tag == 'bin') {
    if (expr.val.op == ':') {
      return 'undefined';
    }
    else if (expr.val.op == '&&' || expr.val.op == '||') {
      // and and or are short cricut, so the second should not be evaluated in some cases
      let exprA =  codeGenExpr(expr.val.left, addInst, ctx, position);
      let insideIfAddInst: AddInst = { before: [], after: [] };
      let exprB = codeGenExpr(expr.val.right, insideIfAddInst, ctx, position) 
      addInst.before.push(`if (${expr.val.op == '||' ? '!' : ''}(${exprA})) {`)
      for (let i = 0; i < insideIfAddInst.before.length; i++) {
        addInst.before.push(insideIfAddInst.before[i]);
      }
      for (let i = 0; i < insideIfAddInst.after.length; i++) {
        addInst.after.push(insideIfAddInst.after[i]);
      }
      addInst.before.push('}')
      exprText = `${exprA} ${ expr.val.op } ${exprB}`;
    }
    else {
      exprText = `${ codeGenExpr(expr.val.left, addInst, ctx, position) } ${ expr.val.op } ${ codeGenExpr(expr.val.right, addInst, ctx, position) }`;
    }
  } 
  else if (expr.tag == 'mv') {
    let exprStr = codeGenExpr(expr.val, addInst, ctx, position);
    addInst.after.push(`${exprStr} = (${codeGenType(expr.type)}){0};`);
    exprText = exprStr;
  }
  else if (expr.tag == 'cp') {
    let cpAddInst: AddInst = { after: [], before: [] };
    let exprStr = codeGenExpr(expr.val, cpAddInst, ctx, position);
    let copiedStr = reserveVar(ctx, expr.type);

    codeGenCp(exprStr, copiedStr, expr.type, ctx, cpAddInst);
    addInst.before.push(`${copiedStr} = ${exprStr};`);
    addInst.before.push(...cpAddInst.before);
    addInst.before.push(...cpAddInst.after);

    exprText = copiedStr;
  }
  else if (expr.tag == 'not') {
    exprText = '!' + codeGenExpr(expr.val, addInst, ctx, position);
  } 
  else if (expr.tag == 'try') {
    let exprName = codeGenExpr(expr.val, addInst, ctx, position);
    changeRefCount(addInst.before, exprName, expr.val.type, 1);
    addInst.before.push(`if (${exprName}.tag == 1) { ret = (${ codeGenType(ctx.returnType) }){ .tag = 1, ._val1 = ${exprName}._val1 }; goto cleanup; }`);
    changeRefCount(addInst.before, exprName, expr.val.type, -1);
    // because this is a leftExpr, it shouldn't save the value to the stack
    if (expr.type.tag == 'primative' && expr.type.val == 'void') {
      return '';
    }
    return `${exprName}._val0`;
  }
  else if (expr.tag == 'assert') {
    let exprName = codeGenExpr(expr.val, addInst, ctx, position);
    addInst.before.push(`if (${exprName}.tag == 1) chad_panic("${position.document}", ${position.line}, ${exprName}._val1._message._base);`);
    // because this is a leftExpr, it shouldn't save the value to the stack
    return `${exprName}._val0`;
  }
  else if (expr.tag == 'assert_bool') {
    exprText = `if (!(${codeGenExpr(expr.val, addInst, ctx, position)})) chad_panic("${position.document}", ${position.line}, "assertion failed");`;
  }
  else if (expr.tag == 'fn_call') {
    exprText = codeGenFnCall(expr.val, addInst, ctx, position);
  }
  else if (expr.tag == 'cfn_call') {
    exprText = expr.fnName + '(';
    for (let i = 0; i < expr.exprs.length; i++) {
      exprText += codeGenExpr(expr.exprs[i], addInst, ctx, position);
      if (i != expr.exprs.length - 1) {
        exprText += ', ';
      }
    }
    exprText += ')';
  }
  else if (expr.tag == 'struct_init') {
    exprText = codeGenStructInit(expr, addInst, ctx, position);
  } 
  else if (expr.tag == 'list_init') {
    if (expr.type.tag != 'struct' || expr.type.val.id != 'std/core.Arr') {
      return 'undefined';
    }

    let ptrType = expr.type.val.fields[0].type;
    if (ptrType.tag != 'ptr') {
      compilerError('expected ptr field');
      return 'undefined';
    }
    let type = codeGenType(ptrType.val);

    let ptr = reserveVarNoStack(ctx);
    let typedPtr = reserveVarNoStack(ctx);
    addInst.before.push(`void *${ptr} = malloc(${expr.val.length} * sizeof(${type}));`);
    addInst.before.push(`${type} *${typedPtr} = (${type}*)(${ptr});`);
    for (let i = 0; i < expr.val.length; i++) {
      addInst.before.push(`${typedPtr}[${i}] = ${ codeGenExpr(expr.val[i], addInst, ctx, position) };`);
    }
    exprText = `(${ codeGenType(expr.type) }){ ._base = ${typedPtr}, ._len = ${expr.val.length}, ._capacity = ${expr.val.length} }`;
  }
  else if (expr.tag == 'str_const') {
    exprText = `(${ codeGenType(STR) }){ ._base = "${expr.val}", ._len = ${ strLen(expr.val) } }`;
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
      addInst.before.push(`${total}[${i}] = ${ codeGenExpr(exprs[i], addInst, ctx, position) };`);
      addInst.before.push(`${totalLen} += ${total}[${i}]._len;`);
    }
    
    addInst.before.push(`char* ${output} = malloc(${totalLen} + sizeof(int64_t));`);
    addInst.before.push(`size_t ${idx} = 0;`)
    for (let i = 0; i < exprs.length; i++) {
      addInst.before.push(`memcpy(${output} + ${idx}, ${total}[${i}]._base, ${total}[${i}]._len);`)
      addInst.before.push(`${idx} += ${total}[${i}]._len;`)
    }

    addInst.before.push(`free(${total});`);
    exprText = `(${strType}){ ._base = ${output}, ._len = ${totalLen} }`;
  } else if (expr.tag == 'char_const') {
    exprText = `'${expr.val}'`;
  } else if (expr.tag == 'int_const') {
    exprText = `${expr.val}`;
  } else if (expr.tag == 'nil_const') {
    exprText = '0';
  } else if (expr.tag == 'bool_const') {
    exprText = `${expr.val}`;
  } else if (expr.tag == 'num_const') {
    exprText = `${expr.val}`;
  }  else if (expr.tag == 'is') {
    exprText = `${codeGenLeftExpr(expr.left, addInst, ctx, position)}.tag == ${expr.variantIndex}`;
  } else if (expr.tag == 'enum_init') {
    if (expr.fieldExpr != null) {
      let generatedExpr = codeGenExpr(expr.fieldExpr, addInst, ctx, position);
      changeRefCount(addInst.after, generatedExpr, expr.fieldExpr.type, 1);
      exprText = `(${ codeGenType(expr.type) }){ .tag = ${expr.variantIndex}, ._${expr.fieldName} = ${ generatedExpr } }`;
    } else {
      exprText = `(${ codeGenType(expr.type) }){ .tag = ${expr.variantIndex} }`;
    }
  } 
  else if (expr.tag == 'left_expr') {
    exprText = codeGenLeftExpr(expr.val, addInst, ctx, position);

    // doesn't need to reserve the variable
    return exprText;
  }
  else if (expr.tag == 'ptr') {
    exprText = `&(${codeGenLeftExpr(expr.val, addInst, ctx, position)})`;
  }

  // void types do not need to reserve their spot or be saved to the stack
  if (expr.type.tag == 'primative' && expr.type.val == 'void') {
    return exprText;
  }

  // reserve a spot on the stack for the expression so it can be reference counted
  // and so it can be passed to a function by pointer
  let exprName = reserveVar(ctx, expr.type);
  changeRefCount(addInst.before, exprName, expr.type, -1);
  let exprAssign = `${ exprName } = ${ exprText }`; 
  addInst.before.push(`${exprAssign};`);

  return exprName;
}

// codeGenCp takes the prefix of the field (name of the variable) and then recursively
// sets the pointer to all of the arrays to a new malloc memcpy array
function codeGenCp(
  srcPrefix: string,
  destPrefix: string,
  type: Type,
  ctx: FnContext,
  addInst: AddInst
) {
  if (type.tag != 'struct') {
    return;
  }

  if (type.tag == 'struct' && type.val.id == 'std/core.Arr') {
    let arrReserve = reserveVarNoStack(ctx);
    let size = `${srcPrefix}._len * sizeof(${codeGenType(type.val.generics[0])})`;
    addInst.after.push(`void* ${arrReserve} = malloc(${size});`);
    addInst.after.push(`memcpy(${arrReserve}, ${srcPrefix}._base, ${size});`);
    addInst.after.push(`${destPrefix}._base = ${arrReserve};`);
  }

  for (let i = 0; i < type.val.fields.length; i++) {
    let fieldType = type.val.fields[i].type;
    let fieldName = type.val.fields[i].name;
    let fullSrcField = srcPrefix + fieldName;
    let fullDestField = destPrefix + fieldName;
    codeGenCp(fullSrcField, fullDestField, fieldType, ctx, addInst);
  } 
}

function codeGenStructInit(expr: Expr, addInst: AddInst, ctx: FnContext, position: Position): string {
  if (expr.tag != 'struct_init') {
    return 'undefined';
  }

  let structInit: StructInitField[] = expr.val;
  let output = `(${codeGenType(expr.type)}){ `;
  for (let i = 0; i < structInit.length; i++) {
    let initField = structInit[i];
    let exprText = codeGenExpr(initField.expr, addInst, ctx, position);

    if (expr.type.tag == 'struct' && expr.type.val.unit == 'extern') {
      output += `.${initField.name} = ${exprText}`;
    }
    else {
      output += `._${initField.name} = ${exprText}`;
    }

    // because the initExpr is stored on the stack, we need to inc the ref count here as well
    changeRefCount(addInst.after, exprText, initField.expr.type, 1);
    if (i != structInit.length - 1) {
      output += ', ';
    }
  }

  let cStruct = ctx.cstructMap.get(JSON.stringify(expr.type));
  let refCountVar = reserveVarNoStack(ctx);
  addInst.before.push(`int64_t* ${refCountVar} = malloc(sizeof(int64_t));`);
  addInst.before.push(`*${refCountVar} = 1;`)
  if (cStruct != undefined && cStruct.tag == 'struct' && cStruct.autoDrop) {
    output += `, .refCount = ${refCountVar}`;
  }

  return output + ' }'
}

function codeGenFnCall(fnCall: FnCall, addInst: AddInst, ctx: FnContext, position: Position): string {
  let output = codeGenLeftExpr(fnCall.fn, addInst, ctx, position) + '(';
  for (let i = 0; i < fnCall.exprs.length; i++) {
    let ref = true;
    if (fnCall.exprs[i].type.tag == 'fn') {
      ref = false;
    }
    if (fnCall.fn.tag == 'fn' && fnCall.fn.extern == true) {
      ref = false;
    }

    output += `${ref ? '&' : ''}${ codeGenExpr(fnCall.exprs[i], addInst, ctx, position) }`;
    if (i != fnCall.exprs.length - 1) {
      output += ', ';
    }
  }

  return output + ')'
}

function codeGenLeftExpr(leftExpr: LeftExpr, addInst: AddInst, ctx: FnContext, position: Position): string {
  if (leftExpr.tag == 'dot') {
    let assignType = leftExpr.val.left.type;
    if (assignType.tag == 'struct' && assignType.val.unit == 'extern') {
      return `${codeGenExpr(leftExpr.val.left, addInst, ctx, position)}.${leftExpr.val.varName}`;
    }
    return `${codeGenExpr(leftExpr.val.left, addInst, ctx, position)}._${leftExpr.val.varName}`;
  } 
  else if (leftExpr.tag == 'arr_offset_int') {
    let leftName = codeGenExpr(leftExpr.val.var, addInst, ctx, position);
    let innerName = codeGenExpr(leftExpr.val.index, addInst, ctx, position);

    if (leftExpr.val.var.type.tag == 'ptr') {
      return `${leftName}[${innerName}]`;
    }

    let memGuard = `if (${innerName} < 0 || ${leftName}._len <= ${innerName}) { `;
    memGuard += 'char __buf[128] = { 0 }; ';
    memGuard += `snprintf(__buf, 128, "invalid access of array with index %ld", ${innerName}); `
    memGuard += `chad_panic("${position.document}", ${position.line}, __buf); }`
    addInst.before.push(memGuard);
    return `${leftName}._start[${innerName}]`;
  } 
  else if (leftExpr.tag == 'arr_offset_slice') {
    let range = codeGenExpr(leftExpr.val.range, addInst, ctx, position);
    let fromVar = codeGenExpr(leftExpr.val.var, addInst, ctx, position);
    let memGuard = `if (${range}._end < ${range}._start || ${range}._start < 0 || ${fromVar}._len < ${range}._end) { `;
    memGuard += 'char __buf[128] = { 0 }; ';
    memGuard += `snprintf(__buf, 128, "invalid access of array with range %ld:%ld", ${range}._start, ${range}._end); `
    memGuard += `chad_panic("${position.document}", ${position.line}, __buf); }`
    addInst.before.push(memGuard);

    return `(${codeGenType(leftExpr.type)}){ ._ptr = ${fromVar}._ptr, ._start = ${fromVar}._ptr + ${range}._start, ._len = ${range}._end - ${range}._start, ._refCount = ${fromVar}._refCount }`;
  }
  else if (leftExpr.tag == 'prime') {
    return `${ codeGenExpr(leftExpr.val, addInst, ctx, position) }._${leftExpr.variant}`;
  }
  else if (leftExpr.tag == 'fn') {
    if (leftExpr.extern == true) {
      return leftExpr.fnName;
    }
    else {
      return getFnUniqueId(leftExpr.unitName, leftExpr.fnName, leftExpr.type);
    }
  }
  else {
    if (leftExpr.mode == 'param') {
      return `(*_${leftExpr.val})`;
    }
    else if (leftExpr.mode == 'iter') {
      return `(*_${leftExpr.val}__opt._val0._start)`;
    }
    else if (leftExpr.mode == 'iter_copy') {
      return `(_${leftExpr.val}__opt._val0)`
    }
    else if (leftExpr.mode == 'none') {
      return `_${leftExpr.val}`;
    }
    else if (leftExpr.mode == 'C') {
      return leftExpr.val;
    }
    else {
      // for constants
      return getConstUniqueId(leftExpr.mode.unitName, leftExpr.val);
    }
  }
}

function getConstUniqueId(unitName: string, constName: string) {
  return `_${unitName}_${constName}`.replace('.', '_').replace('/', '_');
}

function getFnUniqueId(fnUnitName: string, fnName: string, fnType: Type): string {
  return ('_' + fnUnitName.replace('.', '_').replace('/', '_') + '_' + fnName + '_' + codeGenType(fnType)).replace(' ', '').replace('*', '_arr');
}

function changeRefCount(addToList: string[], leftExpr: string, type: Type, amt: number) {
  let typeNoSpace = codeGenType(type);
  typeNoSpace = typeNoSpace.replace(' ', '');
  if (type.tag == 'enum' || type.tag == 'struct') {
    // addToList.push(`changeRefCount_${typeNoSpace}(&${leftExpr}, ${amt});`);
    addToList.push('');
  }
}

function codeGenArenaMoveImpls(structs: CStruct[]): string {
  let arenaMoveStr = '';

  return arenaMoveStr;
}

// belongs in the C file
function codeGenRefcountImpls(structs: CStruct[]): string {
  let refCountStr = '';

  for (let struct of structs) {
    let type: Type = { tag: 'primative', val: 'void' };
    if (struct.tag == 'enum' || struct.tag == 'struct') {
      type = struct.val.name;
    }
    if (type.tag == 'primative') {
      continue;
    }

    // generate out inc and dec reference count for every stryct
    let typeStr = codeGenType(type);
    let typeStrNoSpace = typeStr.replace(' ', '');

    // forward declare the __drop so it can be used
    let dropFn: Type = { tag: 'fn', val: { returnType: VOID, paramTypes: [type], linkedParams: [true] } };
    let dropName: string = getFnUniqueId('', 'drop', dropFn);
    if (struct.tag == 'struct' && struct.autoDrop) {
      refCountStr += `\nvoid ${dropName}(${typeStr} *s);`;
    }

    refCountStr += `\nvoid changeRefCount_${typeStrNoSpace}(${typeStr} *s, int64_t amt) {`
    if (struct.tag == 'struct'){
      if (type.tag != 'struct') {
        continue;
      }

      // drop will be called before all of its fields
      if (struct.autoDrop) {
        refCountStr += `if (s->refCount != NULL) { *s->refCount += amt; if (*s->refCount == 0) ${dropName}(s); }`
      }

      for (let i = 0; i < type.val.fields.length; i++) {
        let tag = type.val.fields[i].type.tag;
        if (tag == 'primative' || tag == 'fn' || tag == 'ptr') {
          continue;
        }

        let typeStrNoSpace = codeGenType(type.val.fields[i].type);
        typeStrNoSpace = typeStrNoSpace.replace(' ', '');
        // refCountStr += `\n  changeRefCount_${typeStrNoSpace}(&s->_${type.val.fields[i].name}, amt);`;
      }
    }
    else if (struct.tag == 'enum') {
      if (type.tag != 'enum') {
        continue;
      }

      for (let i = 0; i < type.val.fields.length; i++) {
        let tag = type.val.fields[i].type.tag;
        if (tag == 'primative' || tag == 'fn' || tag == 'ptr') {
          continue;
        }

        let typeStrNoSpace = codeGenType(type.val.fields[i].type);
        typeStrNoSpace = typeStrNoSpace.replace(' ', '');
        // refCountStr += `\n  if (s->tag == ${i}) changeRefCount_${typeStrNoSpace}(&s->_${type.val.fields[i].name}, amt);`;
      }
    }
    refCountStr += '\n}';
  }

  return refCountStr;
}

// belongs in the header
function codeGenStructDefs(structs: CStruct[]): string {
  let structStr = '';
  for (let struct of structs) {
    if (struct.tag == 'fn') {
      continue;
    }

    if (struct.tag == 'struct') {
      if (struct.val.name.tag == 'struct' && struct.val.name.val.unit == 'extern') {
        continue;
      }

      structStr += '\n' + codeGenType(struct.val.name) + ' {';
      for (let i = 0; i < struct.val.fieldTypes.length; i++) {
        structStr += '\n  ' + codeGenType(struct.val.fieldTypes[i]) + ' _' + struct.val.fieldNames[i] + ';';
      }
      if (struct.autoDrop) {
        structStr += '\n  int64_t* refCount;';
      }

      structStr += '\n};'
    }
    else if (struct.tag == 'enum') {
      structStr += '\n' + codeGenType(struct.val.name) + ' {';
      structStr += '\n  int64_t tag;';
      structStr += '\n  union {';
      for (let i = 0; i < struct.val.fieldTypes.length; i++) {
        let typeStr = codeGenType(struct.val.fieldTypes[i]);
        if (typeStr == 'void') {
          typeStr = 'int64_t';
        }
        structStr += '\n    ' + typeStr + ' _' + struct.val.fieldNames[i] + ';' 
      }
      structStr += '\n  };\n};'
    }

    let type: Type = { tag: 'primative', val: 'void' };
    if (struct.tag == 'enum' || struct.tag == 'struct') {
      type = struct.val.name;
    }
    let typeStr = codeGenType(type);
    let typeStrNoSpace = typeStr.replace(' ', '');

    // declare the refcount function for the header
    structStr += `\nvoid changeRefCount_${typeStrNoSpace}(${typeStr} *s, int64_t amt);`
  }

  return structStr;
}
