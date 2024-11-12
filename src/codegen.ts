import { FnMode } from './parse';
import { Position, compilerError } from './util';
import { Type, toStr, isBasic, createTypeUnion, ERR, NIL, STR, FMT, typeApplicable } from './typeload';
import { Inst, LeftExpr, Expr, StructInitField, FnCall, Fn, FnImpl, GlobalImpl } from './analyze';
import { Program } from './replaceGenerics';

export {
  codegen, OutputFile
}

interface FnContext {
  returnType: Type
  unit: string,
  amtReserved: number
}

interface CodeGenExpr {
  statements: string[]
  output: string 
}

const includes = [
  'stdio.h', 'stdlib.h', 'string.h', 'stdbool.h', 'stdint.h'
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
    chadDotC += '\n#include "../' + include + '"';
  }

  chadDotC += '\n#include "chad.h"';
  chadDotC += '\nvoid chad_panic(const char* file, int64_t line, const char* message) {'
  chadDotC += '\n\tfprintf(stderr, "panic in \'%s.chad\' line %ld: %s\\n", file, line, message); \nexit(-1); \n}'

  // forward declare all structs for pointers
  for (let type of prog.orderedTypes) {
    if (type.tag == 'struct' && !isBasic(type)) {
      chadDotC += '\n' + codeGenType(type) + ';';
    }
    if (type.tag == 'fn') {
      chadDotH += `\ntypedef ${codeGenType(type.returnType)} (*${codeGenType(type)})(`;
      for (let i = 0; i < type.paramTypes.length; i++) {
        chadDotH += `${codeGenType(type.paramTypes[i])}*`;
        if (i != type.paramTypes.length - 1) {
          chadDotH += ', ';
        }
      }
      chadDotH += ');';
    }
  }

  for (let struct of prog.orderedTypes) {
    if (struct.tag != 'struct' || isBasic(struct)) continue;
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

  chadDotC +=
  `
  int main(int argc, char** argv) {
  int64_t argcCast = argc;
  ${ codeGenType(createTypeUnion(NIL, ERR)) } result = ${entryName}(argcCast, argv);
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

function codeGenGlobal(global: GlobalImpl): string {
  let expr = '{0}';
  if (global.expr.tag == 'int_const') {
    expr = '' + global.expr.val;
  }
  else if (global.expr.tag == 'num_const') {
    expr = '' + global.expr.val;
  }
  else if (global.expr.tag == 'str_const') {
    expr = `{ ._base = "${global.expr.val}" , ._len = ${strLen(global.expr.val)}}`;
  }

  let mode = ''; 
  if (global.header.mode == 'const') {
    mode = 'const';
  }
  else if (global.header.mode == 'local') {
    mode = '__thread';
  }

  let name = getGlobalUniqueId(global.header.unit, global.header.name)
  return `${mode} ${codeGenType(global.header.type)} ${name} = ${expr}`;
}

function codeGenFn(fn: FnImpl) {
  let ctx: FnContext = { returnType: fn.header.returnType, amtReserved: 0, unit: fn.header.unit };
  let fnCode = codeGenFnHeader(fn.header) + ' {';
  let bodyStr = '\n';

  for (let i = 0; i < fn.body.length; i++) {
    bodyStr += codeGenInst(fn.body, i, 1, ctx);
  }

  let retType = fn.header.returnType;
  if (retType.tag == 'struct' && retType.val.name == 'nil') {
    bodyStr += '\n\treturn 0;'
  }
  else if (typeApplicable(NIL, retType, false)) {
    bodyStr += `\n\treturn (${codeGenType(fn.header.returnType)}){ 0 };`
  }
  bodyStr += '\n};';

  return fnCode + bodyStr;
}

function replaceAll(s: string, find: string, replace: string) {
  while (s.includes(find)) {
    s = s.replace(find, replace);
  }
  return s;
}

// TODO
function codeGenType(type: Type): string {
  if (type.tag == 'struct' && isBasic(type)) {
    if (type.val.name == 'int') return 'int64_t';
    else if (type.val.name == 'nil') return 'int';
    else if (type.val.name == 'i32') return 'int32_t';
    else if (type.val.name == 'i16') return 'int16_t';
    else if (type.val.name == 'i8') return 'int8_t';
    else if (type.val.name == 'u64') return 'uint16_t';
    else if (type.val.name == 'u32') return 'uint32_t';
    else if (type.val.name == 'u16') return 'uint16_t';
    else if (type.val.name == 'u8') return 'uint8_t';
    else if (type.val.name == 'f64') return 'double';
    else if (type.val.name == 'f32') return 'float';
    return type.val.name;
  }
  if (type.tag == 'ptr') {
    return codeGenType(type.val) + '*';
  }
  if (type.tag == 'link') {
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
  typeStr = replaceAll(typeStr, '&', '*');
  typeStr = replaceAll(typeStr, ' ', '');

  if (type.tag == 'struct') return 'struct ' + typeStr;
  return typeStr;
}

function codeGenFnHeader(fn: Fn): string {
  let name = getFnUniqueId(fn.unit, fn.name, fn.mode, fn.paramTypes, fn.returnType);
  let headerStr = '\n ' + codeGenType(fn.returnType) +  ' ' + name + '(';
  let paramStr = '';

  for (let i = 0; i < fn.paramNames.length; i++) {
    paramStr += `${codeGenType(fn.paramTypes[i])} _${fn.paramNames[i]}`;
    if (i != fn.paramNames.length - 1) {
      paramStr += ', ';
    }
  }
  return headerStr + paramStr + ')';
}

function codeGenBody(body: Inst[], indent: number, includeBraces: boolean, ctx: FnContext): string {
  let bodyStr = includeBraces ? '{\n' : '';
  for (let i = 0; i < body.length; i++) {
    bodyStr += codeGenInst(body, i, indent, ctx);
  }

  let tabs = '';
  for (let i = 0; i < indent - 1; i++) {
    tabs += '  ';
  }
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
    let type = codeGenType(inst.val.type);
    let rightExpr = codeGenExpr(inst.val.expr, ctx, inst.position);
    let name = `_${inst.val.name}`;
    statements.push(...rightExpr.statements);
    statements.push(`${type} ${name} = ${rightExpr.output};`);
  } 
  else if (inst.tag == 'assign') {
    let rightExpr = codeGenExpr(inst.val.expr, ctx, inst.position);
    let leftExpr = codeGenLeftExpr(inst.val.to, ctx, inst.position);

    statements.push(...rightExpr.statements);
    statements.push(...statements);
    statements.push(`${leftExpr.output} ${inst.val.op} ${rightExpr.output};`);
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
    statements.push(`while (true) {`);
    let bodyText = codeGenBody(inst.val.body, indent + 1, false, ctx);
    let condName = codeGenExpr(inst.val.cond, ctx, inst.position);
    statements.push(...condName.statements);
    statements.push(`if (!(${condName.output})) break;`);
    statements.push(bodyText + `${tabs}}`);
  }
  else if (inst.tag == 'expr') {
    let expr = codeGenExpr(inst.val, ctx, inst.position);
    statements.push(...expr.statements);
    statements.push(expr.output + ';');
  }
  else if (inst.tag == 'return') {
    if (inst.val == null) {
      statements.push('return 0;');
    }
    else {
      let expr = codeGenExpr(inst.val, ctx, inst.position);
      statements.push(...expr.statements);
      statements.push(`return ${expr.output};`)
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
    statements.push(inst.tag + ';');
  } 
  else if (inst.tag == 'for_in') {
    let varName = `_${inst.val.varName}_for`;
    let iterExpr = codeGenExpr(inst.val.iter, ctx, inst.position);
    statements.push(...iterExpr.statements);

    let itemType = inst.val.nextFn.returnType;
    let itemTypeStr = codeGenType(itemType);
    let paramTypes = inst.val.nextFn.paramTypes;
    let nextFnName = getFnUniqueId(inst.val.nextFn.unit, inst.val.nextFn.name, inst.val.nextFn.mode, paramTypes, itemType);

    let iterSaved = uniqueVarName(ctx);
    statements.push(`${codeGenType(inst.val.iter.type)} ${iterSaved} = ${iterExpr.output};`);
    statements.push(`for (${itemTypeStr} ${varName} = ${nextFnName}(&${iterSaved}); ${varName} != 0; ${varName} = ${nextFnName}(&${iterSaved})) {`);
    statements.push(codeGenBody(inst.val.body, indent + 1, false, ctx));
    statements.push('}');
  }

  let outputText = '';
  for (let i of statements) {
    outputText += tabs + i + '\n';
  }
  return outputText;
}

function uniqueVarName(ctx: FnContext): string {
  let name = `__expr_${ctx.amtReserved}`;
  ctx.amtReserved += 1;
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

      statements = exprA.statements;
      statements.push(`if (${expr.val.op == '||' ? '!' : ''}${exprA.output}) {`)
      statements.push(...exprB.statements);
      statements.push('}')
      exprText = `${exprA.output} ${ expr.val.op } ${exprB.output}`;
    }
    else {
      let left = codeGenExpr(expr.val.left, ctx, position);
      let right = codeGenExpr(expr.val.right, ctx, position);
      statements = left.statements;
      statements.push(...right.statements);
      exprText = `${left.output} ${ expr.val.op } ${right.output}`;
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
    let innerExpr = codeGenExpr(expr.val, ctx, position);
    statements = innerExpr.statements;
    statements.push(`if (${innerExpr.output}.tag == 1) return (${ codeGenType(ctx.returnType) }){ .tag = 1, ._val1 = ${innerExpr.output}._val1 };`);
    // because this is a leftExpr, it shouldn't save the value to the stack
    if (expr.type.tag == 'struct' && expr.type.val.name == 'nil') {
      return { statements , output: '' };
    }
    return { statements, output: `${innerExpr.output}._val0` };
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
  else if (expr.tag == 'list_init') {
    if (expr.type.tag != 'struct') {
      return undefined!;
    }

    let ptrType = expr.type.val.fields[0].type;
    if (ptrType.tag != 'ptr') {
      compilerError('expected ptr field');
      return undefined!;
    }

    let type = codeGenType(ptrType.val);
    let ptr = uniqueVarName(ctx);
    let typedPtr = uniqueVarName(ctx);
    statements.push(`void *${ptr} = malloc(${expr.val.length} * sizeof(${type}));`);
    statements.push(`${type} *${typedPtr} = (${type}*)(${ptr});`);
    for (let i = 0; i < expr.val.length; i++) {
      let innerExpr = codeGenExpr(expr.val[i], ctx, position);
      statements.push(...innerExpr.statements);
      statements.push(`${typedPtr}[${i}] = ${innerExpr.output};`);
    }
    exprText = `(${ codeGenType(expr.type) }){ ._base = ${typedPtr}, ._len = ${expr.val.length}, ._capacity = ${expr.val.length} }`;
  }
  else if (expr.tag == 'fmt_str') {
    let fmtName = uniqueVarName(ctx);
    statements.push(`${codeGenType(FMT)} _${fmtName} = {0};`);
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
          val: fmtName,
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
      output: `(${codeGenType(STR)}){ ._base=_${fmtName}._base, ._len =_${fmtName}._len }`,
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
    exprText = `${expr.val}`;
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
    let leftExpr = codeGenLeftExpr(expr.left, ctx, position);
    statements = leftExpr.statements;
    exprText = `${leftExpr.output}.tag == ${expr.variantIndex}`;
  }
  else if (expr.tag == 'enum_init') {
    if (expr.fieldExpr != null) {
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
    // doesn't need to store var on stack (already stored)
    return codeGenLeftExpr(expr.val, ctx, position);
  }
  else if (expr.tag == 'ptr') {
    let innerExpr = codeGenLeftExpr(expr.val, ctx, position);
    statements.push(...innerExpr.statements);
    exprText = `&(${innerExpr.output})`;
  }

  return { output: exprText, statements };
}

function codeGenStructInit(expr: Expr, ctx: FnContext, position: Position): CodeGenExpr {
  if (expr.tag != 'struct_init') {
    return undefined!;
  }

  let structInit: StructInitField[] = expr.val;
  let statements: string[] = [];
  let output: string = `(${codeGenType(expr.type)}){ `;
  for (let i = 0; i < structInit.length; i++) {
    let initField = structInit[i];
    let innerExpr = codeGenExpr(initField.expr, ctx, position);
    statements.push(...innerExpr.statements);

    output += `._${initField.name} = ${innerExpr.output}`;
    if (i != structInit.length - 1) {
      output += ', ';
    }
  }

  return { output: output + '}', statements };
}

function codeGenFnCall(fnCall: FnCall, ctx: FnContext, position: Position): CodeGenExpr {
  if (fnCall.fn.type.tag != 'fn') return undefined!;

  let statements: string[] = [];
  let output = codeGenLeftExpr(fnCall.fn, ctx, position).output + '(';
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

function codeGenLeftExpr(leftExpr: LeftExpr, ctx: FnContext, position: Position): CodeGenExpr {
  let statements: string[] = [];
  let leftExprText: string = '';

  if (leftExpr.tag == 'dot') {
    let innerExpr = codeGenExpr(leftExpr.val.left, ctx, position);
    statements = innerExpr.statements;
    leftExprText = `${innerExpr.output}._${leftExpr.val.varName}`;
  } 
  else if (leftExpr.tag == 'index') {
    let leftName = codeGenExpr(leftExpr.val.var, ctx, position);
    let innerName = codeGenExpr(leftExpr.val.index, ctx, position);
    statements.push(...leftName.statements);
    statements.push(...innerName.statements);
    leftExprText = `${leftName.output}[${innerName.output}]`;
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
  }

  return { output: leftExprText, statements }
}

function typeAsName(type: Type): string {
  return replaceAll(replaceAll(codeGenType(type), ' ', '_'), '*', '_ptr');
}

function getGlobalUniqueId(unit: string, name: string): string {
  if (unit.endsWith('.h')) {
    return name;
  }
  return `_${replaceAll(unit, '/', '_')}_${name}`;
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
  return `_${replaceAll(unit, '/', '_')}_${mode}_${name}_${paramTypesStr}_${returnTypeStr}`;
}

function codeGenStructDef(struct: Type): string {
  if (struct.tag != 'struct') {
    return undefined!;
  }

  let structStr = '';
  structStr += '\n' + codeGenType(struct) + ' {';
  if (struct.val.isEnum) {
    structStr += '\n\tint64_t tag;'
    structStr += '\n\tunion {;'
  }

  for (let i = 0; i < struct.val.fields.length; i++) {
    structStr += '\n  ' + codeGenType(struct.val.fields[i].type);
    structStr += ' _' + struct.val.fields[i].name + ';';
  }
  if (struct.val.isEnum) {
    structStr += '\n};'
  }

  structStr += '\n};'
  return structStr;
}
