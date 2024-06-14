import { Program, Fn, Inst, Expr, LeftExpr } from '../analyze/analyze';
import { logError } from '../index';
import { Type, typeApplicableStateful, applyGenericMap, RANGE } from '../analyze/types';

export {
  replaceGenerics, CProgram, CFn
}

interface CProgram {
  fns: CFn[]
  orderedStructs: CStruct[]
  entry: CFn
}

type CStruct = { tag: 'arr', val: Type }
  | { tag: 'struct', val: CStructImpl }
  | { tag: 'enum', val: CStructImpl }

interface CStructImpl {
  name: Type
  fieldTypes: Type[],
  fieldNames: string[]
}

interface CFn {
  name: string
  genericMap: Map<string, Type>
  unitName: string
  type: Type
  paramNames: string[]
  body: Inst[]
}

interface NeedResolveFn {
  fnName: string,
  unitName: string,
  fnType: Type
}

interface ResolveContext {
  fnResolveQueue: NeedResolveFn[],
  queuedFns: Set<string>
  typeResolveQueue: Type[]
  queuedTypes: Set<string>,
}

function queueType(ctx: ResolveContext, type: Type) {
  let key = JSON.stringify(type);
  if (!ctx.queuedTypes.has(key)) {
    ctx.typeResolveQueue.push(type);
    ctx.queuedTypes.add(key);
  }
}

function replaceGenerics(prog: Program): CProgram {
  let entries: Fn[] = prog.fns.filter(x => x.name == 'main');
  if (entries.length > 1) {
    logError(-1, 'more than one \'main\' function provided');
    return undefined!;
  }
  else if (entries.length == 0) {
    logError(-1, 'no \'main\' function provided');
    return undefined!;
  }
 
  let ctx: ResolveContext = {
    fnResolveQueue: [],
    queuedFns: new Set(),
    typeResolveQueue: [],
    queuedTypes: new Set()
  };

  let entry = resolveFn(entries[0], new Map(), ctx);
  let resolved: CFn[] = [];
  resolved.push(entry);

  queueType(ctx, RANGE);

  while (ctx.fnResolveQueue.length > 0) {
    let dep = ctx.fnResolveQueue.pop()!;
    let genericMap: Map<string, Type>;
    let selectedIndex = -1;

    // find which function its referencing
    for (let i = 0; i < prog.fns.length; i++) {
      let map: Map<string, Type> = new Map();
      if (prog.fns[i].name == dep.fnName && prog.fns[i].unitName == dep.unitName) {
        if (typeApplicableStateful(dep.fnType, prog.fns[i].type, map)) {
          genericMap = map;
          selectedIndex = i;
          break;
        }
      }
    }

    if (selectedIndex == -1) {
      logError(-1, 'compiler error no matching fn replaceGenerics');
      continue;
    }

    let cFn = resolveFn(prog.fns[selectedIndex], genericMap!, ctx);
    resolved.push(cFn);
  }

  let orderedStructs = orderStructs(ctx.typeResolveQueue);
  return { orderedStructs, fns: resolved, entry };
}

function resolveFn(
  genericFn: Fn,
  genericMap: Map<string, Type>,
  ctx: ResolveContext
): CFn {
  let newType = applyGenericMap(genericFn.type, genericMap);
  if (newType.tag != 'fn') {
    return undefined!;
  }

  for (let type of newType.val.paramTypes) {
    queueType(ctx, type);
  }
  queueType(ctx, newType.val.returnType)

  return {
    name: genericFn.name,
    paramNames: genericFn.paramNames,
    genericMap,
    unitName: genericFn.unitName,
    type: newType,
    body: resolveInstBody(genericFn.body, genericMap, ctx),
  }
}

function resolveInstBody(
  body: Inst[],
  genericMap: Map<string, Type>,
  ctx: ResolveContext
): Inst[] {
  let resolvedBody: Inst[] = [];
  for (let inst of body) {
    let resolvedInst = resolveInst(inst, genericMap, ctx);
    resolvedBody.push(resolvedInst);
  }
  return resolvedBody;
}

function resolveInst(
  inst: Inst,
  genericMap: Map<string, Type>,
  ctx: ResolveContext
): Inst {
  if (inst.tag == 'if' || inst.tag == 'elif' || inst.tag == 'while') {
    let cond = resolveExpr(inst.val.cond, genericMap, ctx);
    let body = resolveInstBody(inst.val.body, genericMap, ctx);
    return { tag: inst.tag, val: { cond, body }, sourceLine: inst.sourceLine };
  }
  else if (inst.tag == 'else') {
    let body = resolveInstBody(inst.val, genericMap, ctx);
    return { tag: 'else', val: body, sourceLine: inst.sourceLine };
  }
  else if (inst.tag == 'for_in') {
    let body = resolveInstBody(inst.val.body, genericMap, ctx);
    let iter = resolveExpr(inst.val.iter, genericMap, ctx);
    return { tag: 'for_in', val: { varName: inst.val.varName, body, iter }, sourceLine: inst.sourceLine };
  }
  else if (inst.tag == 'return') {
    if (inst.val != null) {
      return { tag: 'return', val: resolveExpr(inst.val, genericMap, ctx), sourceLine: inst.sourceLine };
    }
    return inst;
  }
  else if (inst.tag == 'expr') {
    let val = resolveExpr(inst.val, genericMap, ctx);
    return { tag: 'expr', val, sourceLine: inst.sourceLine };
  }
  else if (inst.tag == 'break' || inst.tag == 'continue') {
    return inst;
  }
  else if (inst.tag == 'declare') {
    let type = applyGenericMap(inst.val.type, genericMap);
    queueType(ctx, type);
    if (inst.val.expr != null) {
      let expr = resolveExpr(inst.val.expr, genericMap, ctx);
      return { tag: 'declare', val: { type, name: inst.val.name, expr }, sourceLine: inst.sourceLine }
    } 
      return { tag: 'declare', val: { type, name: inst.val.name, expr: null }, sourceLine: inst.sourceLine }
  }
  else if (inst.tag == 'assign') {
    let expr = resolveExpr(inst.val.expr, genericMap, ctx);
    let to = resolveLeftExpr(inst.val.to, genericMap, ctx);
    return { tag: 'assign', val: { op: inst.val.op, to, expr }, sourceLine: inst.sourceLine };
  }
  else if (inst.tag == 'include') {
    let newTypes: Type[] = [];
    for (let type of inst.val.types) {
      newTypes.push(applyGenericMap(type, genericMap));
    }
    return { tag: 'include', val: { lines: inst.val.lines, types: newTypes }, sourceLine: inst.sourceLine };
  }

  logError(-1, 'compiler erorr resolveInst unreachable');
  return undefined!;
}

function resolveExpr(
  expr: Expr,
  genericMap: Map<string, Type>,
  ctx: ResolveContext
): Expr {
  if (expr.tag == 'bin') {
    let left = resolveExpr(expr.val.left, genericMap, ctx);
    let right = resolveExpr(expr.val.right, genericMap, ctx);
    let type = applyGenericMap(expr.type, genericMap);
    return { tag: 'bin', val: { op: expr.val.op, left, right }, type };
  }
  else if (expr.tag == 'is') {
    let left = resolveLeftExpr(expr.left, genericMap, ctx);
    return { tag: 'is', left, variant: expr.variant, variantIndex: expr.variantIndex, type: expr.type };
  }
  else if (expr.tag == 'not' || expr.tag == 'try' || expr.tag == 'assert' || expr.tag == 'assert_bool') {
    let inner = resolveExpr(expr.val, genericMap, ctx);
    if (expr.tag == 'not') {
      return { tag: expr.tag, val: inner, type: expr.type };
    }
    else if (expr.tag == 'try') {
      return { tag: expr.tag, val: inner, type: expr.type };
    }
    else if (expr.tag == 'assert') {
      return { tag: expr.tag, val: inner, type: expr.type };
    }
    else if (expr.tag == 'assert_bool') {
      return { tag: expr.tag, val: inner, type: expr.type };
    }
  }
  else if (expr.tag == 'fn_call') {
    let fn = resolveLeftExpr(expr.val.fn, genericMap, ctx);
    let exprs: Expr[] = [];
    for (let param of expr.val.exprs) {
      exprs.push(resolveExpr(param, genericMap, ctx));
    }
    let returnType = applyGenericMap(expr.type, genericMap);
    return { tag: 'fn_call', val: { fn, exprs }, type: returnType };
  }
  else if (expr.tag == 'struct_init') {
    let inits = [];
    for (let init of expr.val) {
      let initExpr = resolveExpr(init.expr, genericMap, ctx);
      inits.push({ name: init.name, expr: initExpr });
    }

    let type = applyGenericMap(expr.type, genericMap);
    return { tag: 'struct_init', val: inits, type: type }
  }
  else if (expr.tag == 'enum_init') {
    let type = applyGenericMap(expr.type, genericMap);
    if (expr.fieldExpr != null) {
      let fieldExpr = resolveExpr(expr.fieldExpr, genericMap, ctx);
      return { tag: 'enum_init', fieldName: expr.fieldName, variantIndex: expr.variantIndex, fieldExpr, type };
    }
    return { tag: 'enum_init', fieldName: expr.fieldName, variantIndex: expr.variantIndex, fieldExpr: null, type };
  }
  else if (expr.tag == 'left_expr') {
    let val = resolveLeftExpr(expr.val, genericMap, ctx);
    return { tag: 'left_expr', val, type: val.type };
  }
  else if (expr.tag == 'char_const'
    || expr.tag == 'int_const'
    || expr.tag =='bool_const'
    || expr.tag == 'num_const'
    || expr.tag == 'str_const') {

    return expr;
  }

  logError(-1, 'compiler error resolveExpr unreachable');
  return undefined!;
}

function resolveLeftExpr(
  leftExpr: LeftExpr,
  genericMap: Map<string, Type>,
  ctx: ResolveContext
): LeftExpr {
  if (leftExpr.tag == 'dot') {
    let left = resolveExpr(leftExpr.val.left, genericMap, ctx);
    let type = applyGenericMap(leftExpr.type, genericMap);
    return { tag: 'dot', val: { left, varName: leftExpr.val.varName }, type };
  }
  else if (leftExpr.tag == 'prime') {
    let val = resolveExpr(leftExpr.val, genericMap, ctx);
    return { 
      tag: 'prime',
      val,
      variantIndex: leftExpr.variantIndex,
      variant: leftExpr.variant,
      type: applyGenericMap(leftExpr.type, genericMap) 
    };
  }
  else if (leftExpr.tag == 'arr_offset_int') {
    let index = resolveExpr(leftExpr.val.index, genericMap, ctx);
    let v = resolveLeftExpr(leftExpr.val.var, genericMap, ctx);
    let type = applyGenericMap(leftExpr.type, genericMap);
    return { tag: 'arr_offset_int', val: { var: v, index }, type };
  }
  else if (leftExpr.tag == 'arr_offset_slice') {
    let start = resolveExpr(leftExpr.val.start, genericMap, ctx);
    let end = resolveExpr(leftExpr.val.end, genericMap, ctx);
    let v = resolveLeftExpr(leftExpr.val.var, genericMap, ctx);
    let type = applyGenericMap(leftExpr.type, genericMap);
    return { tag: 'arr_offset_slice', val: { var: v, start, end }, type };
  }
  else if (leftExpr.tag == 'var') {
    let type = applyGenericMap(leftExpr.type, genericMap);
    return { tag: 'var', val: leftExpr.val, type };
  }
  else if (leftExpr.tag == 'fn') {
    let depType = applyGenericMap(leftExpr.type, genericMap);
    let newLeftExpr: LeftExpr = { tag: 'fn', fnName: leftExpr.fnName, unitName: leftExpr.unitName, type: depType };
    let key = JSON.stringify(newLeftExpr);
    if (!ctx.queuedFns.has(key)) {
      ctx.fnResolveQueue.push({ fnName: leftExpr.fnName, unitName: leftExpr.unitName, fnType: depType });
      ctx.queuedFns.add(key);
    }
    return newLeftExpr;
  }

  logError(-1, 'compiler erorr resolveLeftExpr unreachable');
  return undefined!;
}

function typeTreeRecur(type: Type, inStack: Set<string>, alreadyGenned: Set<string>, output: CStruct[]) {
  if (type.tag == 'arr') {
    typeTreeRecur(type.val, inStack, alreadyGenned, output);

    let typeKey = JSON.stringify(type);
    if (alreadyGenned.has(typeKey)) {
      return;
    }
    alreadyGenned.add(typeKey);
    output.push({ tag: 'arr', val: type });
    return;
  }

  if (type.tag != 'struct' && type.tag != 'enum') {
    return;
  }

  let typeKey = JSON.stringify(type, null, 2);
  if (inStack.has(typeKey)) {
    logError(-1, 'recusive struct' + typeKey);
    return;
  }
  if (alreadyGenned.has(typeKey)) {
    return;
  }
  alreadyGenned.add(typeKey);

  inStack.add(typeKey);
  for (let field of type.val.fields) {
    typeTreeRecur(field.type, inStack, alreadyGenned, output);
  }
  inStack.delete(typeKey);

  let fieldTypes: Type[] = [];
  let fieldNames: string[] = [];
  for (let field of type.val.fields) {
    fieldTypes.push(field.type);
    fieldNames.push(field.name);
  }

  let cStruct = { 
    tag: type.tag,
    val: {
      name: type,
      fieldTypes,
      fieldNames
    }
  };

  output.push(cStruct);
}

function orderStructs(typeResolveQueue: Type[]): CStruct[] {
  let alreadyGenned: Set<string> = new Set();
  let output: CStruct[] = [];
  for (let type of typeResolveQueue) {
    typeTreeRecur(type, new Set(), alreadyGenned, output);
  }

  return output;
}

