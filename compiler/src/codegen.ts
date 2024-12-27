import { FnMode } from './parse';
import { Position, compilerError, logError, logMultiError, NULL_POS } from './util';
import { Type, toStr, isBasic, createTypeUnion, ERR, CHAR, NIL, STR, FMT, INT, typeEq, typeApplicable, getFields, isFloat } from './typeload';
import { Inst, LeftExpr, Expr, StructInitField, FnCall, Fn, FnImpl, GlobalImpl } from './analyze';
import { Program } from './replaceGenerics';

export {
  codegen, OutputFile
}

interface FnContext {
  returnType: Type
  unit: string,
  reservedVars: (Type | null)[]
  nextFnStmt: string | null
  createStmt: boolean
  deferStack: string[]
}

interface CodeGenExpr {
  statements: string[]
  output: string 
}

const includes = [
  'stdio.h', 'stdlib.h', 'string.h', 'stdbool.h', 'stdint.h', 'stdalign.h'
]

interface OutputFile {
  name: string,
  data: string
}

// generates the c output for the given program
function codegen(prog: Program, progIncludes: Set<string>): OutputFile[] {
  let chadDotH = '';
  let chadDotC = '';
  for (let include of includes) {
    chadDotH += '\n#include <' + include + '>';
  }

  for (let include of progIncludes) {
    if (include.startsWith('include/')) {
      chadDotC += `\n#include <${include.replace('include/', '')}>`;
    }

    chadDotC += '\n#include "../' + include + '"';
  }

  chadDotC += '\n#include "chad.h"';
  chadDotC += '\ndouble fabs(double); float fabsf(float);';

  chadDotC += '\n__thread struct StackFrame { const char* file; int64_t line; } frames[1024 * 1024]; __thread int frameIndex = 0; __thread uint64_t lastLine; __thread const char* lastFile;';
  chadDotC += '\nvoid chad_callstack_push() { frames[frameIndex] = (struct StackFrame){ .file = lastFile, .line = lastLine }; frameIndex += 1; }';
  chadDotC += '\nvoid chad_callstack_pop() { frameIndex -= 1; }';

  chadDotC += '\nvoid chad_panic(const char* file, int64_t line, const char* message) {'
  chadDotC += '\nfprintf(stderr, "%s in \'%s.chad\' line %ld\\n", message, file, line); for (int i = frameIndex - 1; i > 0; i--) {'
  chadDotC += 'fprintf(stderr, "in \'%s.chad\' line %ld\\n", frames[i].file, frames[i].line); } exit(-1); }'


  // forward declare all structs for pointers
  for (let type of prog.orderedTypes) {
    if (type.tag == 'struct' && !type.val.template.unit.endsWith('.h') && !isBasic(type)) {
      chadDotH += '\n' + codeGenType(type) + ';';
    }
  }

  for (let type of prog.orderedTypes) {
    if (type.tag == 'fn') {
      chadDotH += `\ntypedef ${codeGenType(type.returnType)} (*${codeGenType(type)})(`;
      for (let i = 0; i < type.paramTypes.length; i++) {
        chadDotH += `${codeGenType(type.paramTypes[i])}`;
        if (i != type.paramTypes.length - 1) {
          chadDotH += ', ';
        }
      }
      chadDotH += ');';
    }
  }

  for (let struct of prog.orderedTypes) {
    if (struct.tag != 'struct' || struct.val.template.unit.endsWith('.h') || isBasic(struct)) continue;
    chadDotH += codeGenStructDef(struct);
  }

  for (let global of prog.globals) {
    chadDotC += codeGenGlobal(global) + ';';
  }

  for (let fn of prog.fns) {
    chadDotH += codeGenFnHeader(fn.header) + ';';
  }

  for (let fn of prog.fns) {
    chadDotC += codeGenFn(fn);
  }

  let entry = prog.entry.header;
  let entryName = getFnUniqueId(entry.unit, entry.name, entry.mode, entry.paramTypes, entry.returnType);

  if (entry.paramTypes.length == 2 
    && typeEq(entry.paramTypes[0], INT) 
    && typeEq(entry.paramTypes[1], { tag: 'ptr', val: { tag: 'ptr', val: CHAR, const: false }, const: false })
    && typeEq(entry.returnType, INT)
  ) {
    chadDotC +=
    `
    int main(int argc, char** argv) {
      return ${entryName}(argc, argv);
    }
    `;
  }  
  else if (entry.paramTypes.length == 0
    && typeEq(entry.returnType, createTypeUnion(NIL, ERR))) {
    chadDotC +=
    `
    int main(int argc, char** argv) {
      ${codeGenType(createTypeUnion(NIL, ERR))} result = ${entryName}();
      if (result.tag == 1) {
        fprintf(stderr, "%s", result._val1._message._base);
        return -1;
      }
      return 0;
    }
    `;
  }
  else if (entry.paramTypes.length == 0
    && typeEq(entry.returnType, NIL)
  ) {
    chadDotC +=
    `
    int main(int argc, char** argv) {
      ${entryName}();
      return 0;
    }
    `;
  }
  else {
    let context = [
      "expected: fn main()",
      "expected: fn main() nil|err",
      "expected: fn main(int argc, **char argv) int",
    ];
    logMultiError(NULL_POS, 'main function is not the correct type', context)
    return [];
  }

  return [
    { name: 'chad.h', data: chadDotH },
    { name: 'chad.c', data: chadDotC },
  ];
}

function codeGenGlobal(global: GlobalImpl): string {
  let ctx: FnContext = {
    unit: global.header.unit,
    returnType: NIL,
    reservedVars: [],
    nextFnStmt: null,
    createStmt: false,
    deferStack: []
  };
  let expr = codeGenExpr(global.expr, ctx, global.position);
  if (expr.statements.length > 0) {
    logError(global.position, 'expression must be compile time');
  }

  let mode = ''; 
  if (global.header.mode == 'const') {
    mode = 'const';
  }
  else if (global.header.mode == 'local') {
    mode = '__thread';
  }

  let name = getGlobalUniqueId(global.header.unit, global.header.name)
  return `\n${mode} ${codeGenType(global.header.type)} ${name} = ${expr.output}`;
}

function codeGenFn(fn: FnImpl) {
  let ctx: FnContext = { returnType: fn.header.returnType, reservedVars: [], unit: fn.header.unit, nextFnStmt: null, createStmt: true, deferStack: [] };
  let fnCode = codeGenFnHeader(fn.header) + ' {\n';
  let bodyStr = '\n';

  bodyStr += '\tchad_callstack_push();';
  for (let i = 0; i < fn.body.length; i++) {
    bodyStr += codeGenInst(fn.body, i, 1, ctx);
  }

  for (let i = ctx.deferStack.length - 1; i >= 0; i--) {
    bodyStr += ctx.deferStack[i];
  }

  let retType = fn.header.returnType;
  if (retType.tag == 'struct' && retType.val.template.name == 'nil') {
    bodyStr += '\n\tchad_callstack_pop(); return;'
  }
  else if (typeApplicable(NIL, retType, false)) {
    bodyStr += `\n\tchad_callstack_pop(); return (${codeGenType(fn.header.returnType)}){ 0 };`
  }

  if (fn.header.returnType.tag == 'struct' 
    && fn.header.returnType.val.template.name == 'TypeUnion'
    && fn.header.returnType.val.template.unit == 'std/core'
  ) {
    if (typeApplicable(NIL, fn.header.returnType.val.generics[1], false)) {
      bodyStr += `\n\treturn (${codeGenType(fn.header.returnType)}){ .tag = 1 };`;
    }
  }
  bodyStr += '\n};';

  for (let i = 0; i < ctx.reservedVars.length; i++) {
    let reserved = ctx.reservedVars[i];
    if (reserved != null) {
      fnCode += `${codeGenType(reserved)} __expr_${i};`;
    }
  }

  return fnCode + bodyStr;
}

function replaceAll(s: string, find: string, replace: string) {
  while (s.includes(find)) {
    s = s.replace(find, replace);
  }
  return s;
}

// TODO
function codeGenType(type: Type, decl: boolean = false, includeConst: boolean = false): string {
  if (type.tag == 'struct' && isBasic(type)) {
    let name = type.val.template.name;
    if (name == 'int') return 'int32_t';
    else if (name == 'nil' && !decl) return 'void';
    else if (name == 'nil' && decl) return 'uint8_t';
    else if (name == 'i64') return 'int64_t';
    else if (name == 'i16') return 'int16_t';
    else if (name == 'i8') return 'int8_t';
    else if (name == 'u64') return 'uint64_t';
    else if (name == 'u32') return 'uint32_t';
    else if (name == 'u16') return 'uint16_t';
    else if (name == 'u8') return 'uint8_t';
    else if (name == 'f64') return 'double';
    else if (name == 'f32') return 'float';
    return name;
  }
  if (type.tag == 'ambig_int') return 'int32_t';
  if (type.tag == 'ambig_float') return 'double';
  if (type.tag == 'ambig_nil' && !decl) return 'void';
  if (type.tag == 'ambig_nil' && decl) return 'uint8_t';

  if (type.tag == 'ptr') {
    return (type.const && includeConst ? 'const ' : '') + codeGenType(type.val) + '*';
  }
  if (type.tag == 'link') {
    return codeGenType(type.val) + '*';
  }

  let typeStr = '';
  if (type.tag == 'struct') {
    let generics: string = '_os_';
    for (let i = 0; i < type.val.generics.length; i++) {
      generics += typeAsName(type.val.generics[i]);
      generics += '_c_';
    }
    for (let i = 0; i < type.val.constFields.length; i++) {
      generics += type.val.constFields[i];
      generics += '_c_';
    }

    if (type.val.generics.length == 0) {
      typeStr = type.val.template.name;
    }
    else {
      typeStr = type.val.template.name + generics + '_cs_';
    }

    let structMode = 'struct';
    if (type.val.template.structMode == 'union') {
      structMode = 'union';
    }
    if (!type.val.template.unit.endsWith('.h')) {
      typeStr = structMode + ' _' + typeStr;
    }
    else {
      typeStr = structMode + ' ' + typeStr;
    }

    return typeStr;
  }

  if (type.tag == 'fn') {
    let s = 'fn_op_';
    for (let i = 0; i < type.paramTypes.length; i++) {
      s += codeGenType(type.paramTypes[i]);
      if (i != type.paramTypes.length - 1) {
        s += '_c_';
      }
    }
    s += `_cp_${codeGenType(type.returnType)}`;
    s = replaceAll(s, ' ', '');
    s = replaceAll(s, '*', '_p_');
    return s;
  }

  throw new Error(":(");
  // compilerError('codegen type fallthrough ' + JSON.stringify(type));
  return 'T';
}

function codeGenFnHeader(fn: Fn): string {
  let name = getFnUniqueId(fn.unit, fn.name, fn.mode, fn.paramTypes, fn.returnType);
  let headerStr = '\n ' + codeGenType(fn.returnType) +  ' ' + name + '(';
  let paramStr = '';

  for (let i = 0; i < fn.paramNames.length; i++) {
    paramStr += `${codeGenType(fn.paramTypes[i], true)} _${fn.paramNames[i]}`;
    if (i != fn.paramNames.length - 1) {
      paramStr += ', ';
    }
  }
  return headerStr + paramStr + ')';
}

function codeGenBody(body: Inst[], indent: number, includeBraces: boolean, ctx: FnContext): string {
  let bodyStr = includeBraces ? '{\n' : '';
  let deferStack = ctx.deferStack;
  ctx.deferStack = [];

  for (let i = 0; i < body.length; i++) {
    bodyStr += codeGenInst(body, i, indent, ctx);
  }

  let tabs = '';
  for (let i = 0; i < indent - 1; i++) {
    tabs += '  ';
  }

  for (let i = ctx.deferStack.length - 1; i >= 0; i--) {
    bodyStr += ctx.deferStack[i];
  }
  ctx.deferStack = deferStack;

  if (includeBraces) return bodyStr + tabs + '}'
  return bodyStr;
}

function codeGenInst(insts: Inst[], instIndex: number, indent: number, ctx: FnContext): string {
  let tabs = '';
  for (let i = 0; i < indent; i++) {
    tabs += '  ';
  }

  let statements: string[] = [];
  let inst: Inst = insts[instIndex];

  if (inst.tag == 'declare') {
    let type = codeGenType(inst.val.type, true);
    let rightExpr = codeGenExpr(inst.val.expr, ctx, inst.position);
    let name = `_${inst.val.name}`;
    statements.push(...rightExpr.statements);
    statements.push(`${type} ${name} = ${rightExpr.output};`);
  } 
  else if (inst.tag == 'assign') {
    let rightExpr = codeGenExpr(inst.val.expr, ctx, inst.position);
    if (inst.val.to.tag == 'index' && inst.val.to.val.verifyFn != null) {
      let fnCall = inst.val.to.val.var;
      let ptrName = uniqueVarName(ctx, fnCall.type);
      if (fnCall.tag != 'fn_call') { compilerError('should be fn call'); return undefined!; }
      let indexFnType = fnCall.val.fn.type;
      if (indexFnType.tag != 'fn') { compilerError('should be fn'); return undefined!; }

      let leftExpr = codeGenExpr(fnCall, ctx, inst.position);

      statements.push(...rightExpr.statements);
      statements.push(...leftExpr.statements);

      statements.push(`${ptrName} = ${leftExpr.output};`)
      statements.push(`${ptrName}[0] ${inst.val.op} ${rightExpr.output};`);

      let verifyFn = inst.val.to.val.verifyFn;
      let verifyFnType = inst.val.to.val.verifyFnType!;
      if (verifyFnType.tag != 'fn') { compilerError('should be fn'); return undefined!; }
      let verifyFnName = getFnUniqueId(verifyFn.unit, verifyFn.name, verifyFn.mode, verifyFnType.paramTypes, verifyFnType.returnType);
      
      let expr = codeGenExpr(fnCall.val.exprs[0], ctx, inst.position);
      statements.push(...expr.statements);
      statements.push(`${verifyFnName}(&${expr.output}, ${ptrName});`);
    }
    else {
      let leftExpr = codeGenLeftExpr(inst.val.to, ctx, inst.position, false);
      statements.push(...rightExpr.statements);
      statements.push(...leftExpr.statements);
      statements.push(`${leftExpr.output} ${inst.val.op} ${rightExpr.output};`);
    }
  } 
  else if (inst.tag == 'defer') {
    let bodyStr = '{';
    for (let i = 0; i < inst.val.length; i++) {
      bodyStr += codeGenInst(inst.val, i, 0, ctx);
    }
    ctx.deferStack.push(bodyStr + '}');
  }
  else if (inst.tag == 'if') {
    let condition = codeGenExpr(inst.val.cond, ctx, inst.position);
    statements.push(...condition.statements);
    statements.push(`if (${condition.output}) ${ codeGenBody(inst.val.body, indent + 1, true, ctx) }`);

    if (instIndex + 1 < insts.length) {
      let nextInst = insts[instIndex + 1];
      if (nextInst.tag == 'elif') {
        statements.push('else {')
        // treat the instruction as an if statement embedded in an else
        insts[instIndex + 1].tag = 'if';
        statements.push(codeGenInst(insts, instIndex + 1, indent + 1, ctx));
        insts[instIndex + 1].tag = 'elif';
        statements.push('}')
      }
      else if (nextInst.tag == 'else') {
        statements.push('else {')
        statements.push(codeGenBody(nextInst.val, indent + 1, false, ctx));
        statements.push('}');
      }
    }

  } 
  // generated before
  else if (inst.tag == 'elif' || inst.tag == 'else') {}
  else if (inst.tag == 'while') {
    let saveNextFnStmt = ctx.nextFnStmt;
    statements.push(`while (true) {`);
    let bodyText = codeGenBody(inst.val.body, indent + 1, false, ctx);
    let condName = codeGenExpr(inst.val.cond, ctx, inst.position);
    statements.push(...condName.statements);
    statements.push(`if (!(${condName.output})) break;`);
    ctx.nextFnStmt = saveNextFnStmt;
    statements.push(bodyText + `${tabs}}`);
  }
  else if (inst.tag == 'expr') {
    let expr = codeGenExpr(inst.val, ctx, inst.position);
    statements.push(...expr.statements);
    statements.push(expr.output + ';');
  }
  else if (inst.tag == 'return') {
    if (inst.val == null) {
      statements.push('chad_callstack_pop(); return;');
    }
    else {
      let expr = codeGenExpr(inst.val, ctx, inst.position);
      statements.push(...expr.statements);
      statements.push(`chad_callstack_pop(); return ${expr.output};`)
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
    if (inst.tag == 'continue' && ctx.nextFnStmt != null) {
      statements.push(ctx.nextFnStmt);
    }
    statements.push(inst.tag + ';');
  } 
  else if (inst.tag == 'for_in') {
    statements.push('{')
    let varName = `_${inst.val.varName}_for`;
    let iterExpr = codeGenExpr(inst.val.iter, ctx, inst.position);
    statements.push(...iterExpr.statements);

    let nextFnType = inst.val.nextFnType!;
    if (nextFnType.tag != 'fn') {
      compilerError('expected fn');
      return undefined!;
    }

    let itemType = nextFnType.returnType;
    let itemTypeStr = codeGenType(itemType);
    let paramTypes = nextFnType.paramTypes;

    if (inst.val.nextFn == null) { compilerError('nextFn should not be null'); return undefined!; };
    let nextFnName = getFnUniqueId(inst.val.nextFn.unit, inst.val.nextFn.name, inst.val.nextFn.mode, paramTypes, itemType);

    let iterSaved = uniqueVarName(ctx, inst.val.iter.type);
    let saveNextFnStmt = ctx.nextFnStmt;
  
    ctx.nextFnStmt = `lastLine = ${inst.position.line}; lastFile = "${inst.position.document}"; ${varName} = ${nextFnName}(&${iterSaved});`;
    statements.push(`${iterSaved} = ${iterExpr.output};`);
    statements.push(`lastLine = ${inst.position.line}; lastFile = "${inst.position.document}"; ${itemTypeStr} ${varName} = ${nextFnName}(&${iterSaved});`);
    statements.push(`while (${varName} != 0) {`);
    statements.push(codeGenBody(inst.val.body, indent + 1, false, ctx));
    statements.push(ctx.nextFnStmt);
    statements.push('}');
    ctx.nextFnStmt = saveNextFnStmt;
    statements.push('}')
  }

  let outputText = '';
  if (inst.tag == 'return' || inst.tag == 'break' || inst.tag == 'continue') {
    for (let i = ctx.deferStack.length - 1; i >= 0; i--) {
      outputText += ctx.deferStack[i];
    }
  }
  for (let i of statements) {
    outputText += tabs + i + '\n';
  }

  return outputText;
}

function uniqueVarName(ctx: FnContext, type: Type | null): string {
  let name = `__expr_${ctx.reservedVars.length}`;
  ctx.reservedVars.push(type);
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
function codeGenExpr(
  expr: Expr,
  ctx: FnContext,
  position: Position,
): CodeGenExpr {
  let exprText: string = 'undefined';
  let statements: string[] = [];

  if (expr.tag == 'bin') {
    if (expr.val.op == ':') {
      return undefined!;
    }
    else if (expr.val.op == '&&' || expr.val.op == '||') {
      // and and or are short cricut, so the second should not be evaluated in some cases
      let exprA = codeGenExpr(expr.val.left, ctx, position);
      let exprB = codeGenExpr(expr.val.right, ctx, position) 

      statements.push(...exprA.statements);
      statements.push(`if (${expr.val.op == '||' ? '!' : ''}${exprA.output}) {`)
      statements.push(...exprB.statements);
      statements.push('}')
      exprText = `(${exprA.output}) ${ expr.val.op } (${exprB.output})`;
    }
    else if (expr.val.op == '==' && isFloat(expr.val.left.type) && isFloat(expr.val.right.type)) {
      let exprA = codeGenExpr(expr.val.left, ctx, position);
      let exprB = codeGenExpr(expr.val.right, ctx, position) 
      statements.push(...exprA.statements);
      statements.push(...exprB.statements);
      if (expr.val.left.type.tag == 'struct' && expr.val.left.type.val.template.name == 'f64') {
        exprText = `fabs(${exprA.output} - ${exprB.output}) > ${2.22e-16}`;
      }
      else {
        exprText = `fabsf(${exprA.output} - ${exprB.output}) > ${1.19e-07}f`;
      }
    }
    else {
      let left = codeGenExpr(expr.val.left, ctx, position);
      let right = codeGenExpr(expr.val.right, ctx, position);
      statements = left.statements;
      statements.push(...right.statements);
      exprText = `(${left.output}) ${ expr.val.op } (${right.output})`;
    }
  } 
  else if (expr.tag == 'cast') {
    let innerExpr = codeGenExpr(expr.val, ctx, position);
    statements = innerExpr.statements;
    exprText = `(${codeGenType(expr.type)})${innerExpr.output}`;
  }
  else if (expr.tag == 'not') {
    let innerExpr = codeGenExpr(expr.val, ctx, position);
    statements = innerExpr.statements;
    exprText = `!(${innerExpr.output})`;
  } 
  else if (expr.tag == 'try') {
    if (expr.val.type.tag != 'struct') {
      compilerError('expected struct');
      return undefined!;
    }

    let innerExpr = codeGenExpr(expr.val, ctx, position);
    statements = innerExpr.statements;
    let name = uniqueVarName(ctx, expr.val.type);
    statements.push(`${name} = ${innerExpr.output};`);

    let deferStmts = ''
    for (let i = ctx.deferStack.length - 1; i >= 0; i--) {
      deferStmts += ctx.deferStack[i];
    }

    statements.push(`if (${name}.tag == 1) { chad_callstack_pop(); ${deferStmts} return (${ codeGenType(ctx.returnType) }){ .tag = 1, ._val1 = ${name}._val1 }; }`);

    // because this is a leftExpr, it shouldn't save the value to the stack
    if (expr.type.tag == 'struct' && expr.type.val.template.name == 'nil') {
      return { statements , output: '' };
    }
    return { statements, output: `${name}._val0` };
  }
  else if (expr.tag == 'assert') {
    let innerExpr = codeGenExpr(expr.val, ctx, position);
    statements = innerExpr.statements;
    exprText = `if (!(${innerExpr.output})) chad_panic("${position.document}", ${position.line}, "assertion failed")`;
  }
  else if (expr.tag == 'fn_call') {
    let result = codeGenFnCall(expr.val, ctx, position);
    exprText = result.output;
    statements = result.statements;
  }
  else if (expr.tag == 'struct_init') {
    let result = codeGenStructInit(expr, ctx, position);
    exprText = result.output;
    statements = result.statements;
  } 
  else if (expr.tag == 'struct_zero') {
    exprText = `(${codeGenType(expr.type)}){0}`;
  }
  else if (expr.tag == 'macro_call') {
    let macro = codeGenMacroCall(expr, ctx, position);
    exprText = macro.output;
    statements = macro.statements;
  }
  else if (expr.tag == 'list_init') {
    if (expr.type.tag != 'struct') {
      return undefined!;
    }

    if (expr.type.val.template.name == 'vec') {
      exprText = `(${ codeGenType(expr.type) }){`;
      for (let i = 0; i < expr.val.length; i++) {
        let innerExpr = codeGenExpr(expr.val[i], ctx, position);
        statements.push(...innerExpr.statements);
        exprText += innerExpr.output;
        if (i < expr.val.length - 1) {
          exprText += ', ';
        }
      }
      exprText += '}';
    }
    else {
      let ptrType = getFields(expr.type)[0].type;
      if (ptrType.tag != 'ptr') {
        compilerError('expected ptr field');
        return undefined!;
      }

      let type = codeGenType(ptrType.val);
      let ptr = uniqueVarName(ctx, null);
      let typedPtr = uniqueVarName(ctx, ptrType);
      let allocName = getFnUniqueId('std/core', 'alloc', 'fn', [INT], ptrType);

      statements.push(`void *${ptr} = ${allocName}(${expr.val.length});`);
      statements.push(`${typedPtr} = (${type}*)(${ptr});`);
      for (let i = 0; i < expr.val.length; i++) {
        let innerExpr = codeGenExpr(expr.val[i], ctx, position);
        statements.push(...innerExpr.statements);
        statements.push(`${typedPtr}[${i}] = ${innerExpr.output};`);
      }
      exprText = `(${ codeGenType(expr.type) }){ ._base = ${typedPtr}, ._len = ${expr.val.length}, ._capacity = ${expr.val.length} }`;
    }

  }
  else if (expr.tag == 'fmt_str') {
    let fmtName = uniqueVarName(ctx, FMT);
    statements.push(`${fmtName} = (${codeGenType(FMT)}){0};`);
    for (let i = 0; i < expr.val.length; i++) {
      let fnCall = expr.val[i];
      if (fnCall.tag != 'fn_call') {
        compilerError('fmt should be fn calls');
        return undefined!;
      }

      fnCall.val.exprs[0] = {
        tag: 'left_expr',
        val: {
          tag: 'var',
          val: fmtName.slice(1),
          mode: 'none',
          type: FMT,
          unit: null
        },
        type: FMT
      };
      let innerExpr = codeGenExpr(expr.val[i], ctx, position);
      statements.push(...innerExpr.statements);
      statements.push(innerExpr.output + ';');
    }

    return {
      output: `(${codeGenType(STR)}){ ._base=${fmtName}._base, ._len =${fmtName}._len }`,
      statements
    }
  } 
  else if (expr.tag == 'str_const') {
    exprText = `(${ codeGenType(STR) }){ ._base = "${expr.val}", ._len = ${ strLen(expr.val) } }`;
  }
  else if (expr.tag == 'char_const') {
    exprText = `'${expr.val}'`;
  }
  else if (expr.tag == 'int_const') {
    if (expr.type.tag == 'struct' && isBasic(expr.type)) {
      let name = expr.type.val.template.name;
      if (name == 'u64' || name == 'u32' || name == 'u16' || name == 'u8') {
        exprText = `${expr.val}u`;
      }
      else {
        exprText = `${expr.val}`;
      }
    }
    else {
      exprText = `${expr.val}`;
    }
  }
  else if (expr.tag == 'nil_const') {
    exprText = '0';
  }
  else if (expr.tag == 'bool_const') {
    exprText = `${expr.val}`;
  }
  else if (expr.tag == 'num_const') {
    exprText = `${expr.val}`;
  }
  else if (expr.tag == 'is') {
    let leftExpr = codeGenLeftExpr(expr.left, ctx, position, false);
    statements = leftExpr.statements;
    exprText = `${leftExpr.output}.tag == ${expr.variantIndex}`;
  }
  else if (expr.tag == 'enum_init') {
    let fields = getFields(expr.type);
    let variant = fields[expr.variantIndex].type;
    let isNil = variant.tag == 'struct' && variant.val.template.name == 'nil' && variant.val.template.unit == 'std/core';
    if (expr.fieldExpr != null && !isNil) {
      if (expr.type.tag != 'struct') {
        return undefined!;
      }
      let generatedExpr = codeGenExpr(expr.fieldExpr, ctx, position);
      statements = generatedExpr.statements;
      exprText = `(${ codeGenType(expr.type) }){ .tag = ${expr.variantIndex}, ._${expr.fieldName} = ${ generatedExpr.output } }`;
    } 
    else {
      exprText = `(${ codeGenType(expr.type) }){ .tag = ${expr.variantIndex} }`;
    }
  } 
  else if (expr.tag == 'left_expr') {
    let leftExpr = codeGenLeftExpr(expr.val, ctx, position, false);
    statements.push(...leftExpr.statements);
    exprText = leftExpr.output;
  }
  else if (expr.tag == 'ptr') {


    let innerExpr = codeGenLeftExpr(expr.val, ctx, position, false);
    statements.push(...innerExpr.statements);
    exprText = `&(${innerExpr.output})`;
  }

  if (expr.tag != 'left_expr') {
    if (ctx.createStmt && (expr.type.tag != 'struct' || expr.type.val.template.name != 'nil' || expr.type.val.template.unit != 'std/core')) {
      let exprOnStack = uniqueVarName(ctx, expr.type);

      let cast = '';
      if (expr.type.tag == 'fn') {
        cast = '(void*)';
      }

      statements.push(`${exprOnStack} = ${exprText};`)
      return { output: cast + exprOnStack, statements };
    }
  }

  if (expr.type.tag == 'fn' && expr.tag != 'fn_call') {
    exprText = '(void*)' + exprText;
  }

  return { output: exprText, statements };
}

function codeGenMacroCall(expr: Expr, ctx: FnContext, position: Position): CodeGenExpr {
  if (expr.tag != 'macro_call') {
    compilerError('expected macro call');
    return undefined!;
  }

  if (expr.val.name == 'sizeOf') {
    let arg = expr.val.args[0];
    if (arg.tag != 'type') {
      compilerError('should always be type');
      return undefined!;
    }
    return { output: `sizeof(${codeGenType(arg.val)})`, statements: [] };
  }

  if (expr.val.name == 'alignOf') {
    let arg = expr.val.args[0];
    if (arg.tag != 'type') {
      compilerError('should always be type');
      return undefined!;
    }
    return { output: `alignof(${codeGenType(arg.val)})`, statements: [] };
  }

  return { output: '', statements: [] }
}

function codeGenStructInit(expr: Expr, ctx: FnContext, position: Position): CodeGenExpr {
  if (expr.tag != 'struct_init') {
    compilerError('expected struct init');
    return undefined!;
  }

  let structInit: StructInitField[] = expr.val;
  let statements: string[] = [];
  let output: string = `(${codeGenType(expr.type)}){ `;
  for (let i = 0; i < structInit.length; i++) {
    let initField = structInit[i];
    let innerExpr = codeGenExpr(initField.expr, ctx, position);
    statements.push(...innerExpr.statements);
    if (expr.type.tag == 'struct' && expr.type.val.template.unit.endsWith('.h')) {
      output += `.${initField.name} = ${innerExpr.output}`;
    }
    else {
      output += `._${initField.name} = ${innerExpr.output}`;
    }

    if (i != structInit.length - 1) {
      output += ', ';
    }
  }

  return { output: output + '}', statements };
}

function codeGenFnCall(fnCall: FnCall, ctx: FnContext, position: Position): CodeGenExpr {
  if (fnCall.fn.type.tag != 'fn') return undefined!;

  let leftExpr = codeGenLeftExpr(fnCall.fn, ctx, position, true); 
  let statements: string[] = leftExpr.statements;
  statements.push(`lastLine = ${position.line}; lastFile = "${position.document}";`);

  let output = leftExpr.output + '(';
  for (let i = 0; i < fnCall.exprs.length; i++) {
    if (fnCall.fn.type.paramTypes[i].tag == 'link') output += '&';
    let paramExpr = codeGenExpr(fnCall.exprs[i], ctx, position);
    statements.push(...paramExpr.statements);
    output += paramExpr.output;
    if (i != fnCall.exprs.length - 1) {
      output += ', ';
    }
  }

  return { output: output + ')', statements };
}

function codeGenLeftExpr(leftExpr: LeftExpr, ctx: FnContext, position: Position, fnCall: boolean): CodeGenExpr {
  let statements: string[] = [];
  let leftExprText: string = '';

  if (leftExpr.tag == 'dot') {
    let innerExpr = codeGenExpr(leftExpr.val.left, ctx, position);
    statements = innerExpr.statements;
    let leftType = leftExpr.val.left.type;
    if (leftType.tag == 'struct' && leftType.val.template.unit.endsWith('.h')) {
      leftExprText = `${innerExpr.output}.${leftExpr.val.varName}`;
    }
    else {
      leftExprText = `${innerExpr.output}._${leftExpr.val.varName}`;
    }
  } 
  else if (leftExpr.tag == 'index') {
    let leftName = codeGenExpr(leftExpr.val.var, ctx, position);
    let innerName = codeGenExpr(leftExpr.val.index, ctx, position);
    statements.push(...leftName.statements);
    statements.push(...innerName.statements);

    if (leftExpr.val.var.type.tag == 'struct'
      && leftExpr.val.var.type.val.template.name == 'vec'
      && leftExpr.val.var.type.val.template.unit == 'std/core'
    ) {

      let guard = `if (${innerName.output} < 0 || ${innerName.output} >= ${leftExpr.val.var.type.val.constFields[0]}) chad_panic("${position.document}", ${position.line}, "out of bounds");`;
      statements.push(guard);
      leftExprText = `${leftName.output}.val0[${innerName.output}]`;
    }
    else if (leftExpr.val.implReturnsPointer == false) {
      leftExprText = `${leftName.output}`;
    }
    else {
      leftExprText = `${leftName.output}[${innerName.output}]`;
    }
  } 
  else if (leftExpr.tag == 'fn') {
    if (leftExpr.type.tag != 'fn') return undefined!;
    leftExprText = getFnUniqueId(leftExpr.unit, leftExpr.name, leftExpr.mode, leftExpr.type.paramTypes, leftExpr.type.returnType);
  }
  else {
    if (leftExpr.mode == 'link') {
      leftExprText = `(*_${leftExpr.val})`;
    }
    else if (leftExpr.mode == 'C') {
      leftExprText = leftExpr.val;
    }
    else if (leftExpr.mode == 'iter') {
      leftExprText = `(*_${leftExpr.val}_for)`;
    }
    else if (leftExpr.mode == 'none') {
      leftExprText = `_${leftExpr.val}`;
    }
    else if (leftExpr.mode == 'global') {
      leftExprText = getGlobalUniqueId(leftExpr.unit!, leftExpr.val);
    }
    else if (leftExpr.mode == 'field_iter') {
      leftExprText = `(${codeGenType(STR)}){ ._base = "${leftExpr.val}", ._len = strLen(${leftExpr.val}) }`;
    }
  }

  return { output: leftExprText, statements }
}

function typeAsName(type: Type): string {
  let name = codeGenType(type, false, false);
  name = replaceAll(name, ' ', '_')
  return replaceAll(name, '*', '_ptr');
}

function normalizeUnitName(name: string): string {
  name = replaceAll(name, '/', '_'), 
  name = replaceAll(name, '-', '_d_');
  name = replaceAll(name, '"', '_q_');
  name = replaceAll(name, '\'', '_a_');
  name = replaceAll(name, '.', '_p_');
  return name;
}

function getGlobalUniqueId(unit: string, name: string): string {
  if (unit.endsWith('.h')) {
    return name;
  }
  return `_${normalizeUnitName(unit)}_${name}`;
}

function getFnUniqueId(unit: string, name: string, mode: FnMode, paramTypes: Type[], returnType: Type): string {
  if (unit.endsWith('.h')) {
    return name;
  }

  let paramTypesStr = '';
  for (let i = 0; i < paramTypes.length; i++) {
    paramTypesStr += typeAsName(paramTypes[i]) + '_';
  }
  let returnTypeStr = typeAsName(returnType);
  return `_${normalizeUnitName(unit)}_${mode}_${name}_${paramTypesStr}_${returnTypeStr}`;
}

function codeGenStructDef(struct: Type): string {
  if (struct.tag != 'struct') {
    return undefined!;
  }

  let structStr = '';
  structStr += '\n' + codeGenType(struct) + ' {';
  if (struct.val.template.unit == 'std/core'
    && struct.val.template.name == 'vec') {

    let genericType = struct.val.generics[0];
    let n = parseInt(struct.val.constFields[0]);
    structStr += codeGenType(genericType) + ` val0[${n}];`;

    return structStr + '\n};';
  }

  if (struct.val.template.structMode == 'enum') {
    structStr += '\n\tint64_t tag;'
    structStr += '\n\tunion {;'
  }

  let fields = getFields(struct);
  for (let i = 0; i < fields.length; i++) {
    structStr += '\n  ' + codeGenType(fields[i].type, true);
    structStr += ' _' + fields[i].name + ';';
  }
  if (struct.val.template.structMode == 'enum') {
    structStr += '\n};'
  }

  structStr += '\n};'
  return structStr;
}
