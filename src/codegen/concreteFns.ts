import { Program, Fn, Inst, Expr, LeftExpr } from '../analyze/analyze';
import { logError } from '../index';
import { Type, typeApplicableStateful, applyGenericMap } from '../analyze/types';

export {
  replaceGenerics, CProgram, CFn
}

interface CProgram {
  fns: CFn[]
  enums: CStruct[]
  structs: CStruct[]
  slices: Type[]
}

interface CStruct {
  name: Type
  fieldTypes: Type[],
  fieldNames: string[]
}

interface CFn {
  name: string
  returnType: Type
  paramTypes: Type[]
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
  typeMap: Map<string, Type>,
}

function queueType(ctx: ResolveContext, type: Type) {
  let key = JSON.stringify(type);
  ctx.typeMap.set(key, type);
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
    typeMap: new Map()
  };

  let cFn = resolveFn(entries[0], new Map(), ctx);
  let resolved: CFn[] = [];
  resolved.push(cFn);

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

  let cStructs: CStruct[] = [];
  let cEnums: CStruct[] = [];
  for (let struct of ctx.typeMap.values()) {
    if (struct.tag != 'struct' && struct.tag != 'enum') {
      continue;
    }

    let fieldTypes: Type[] = [];
    let fieldNames: string[] = [];
    for (let field of struct.val.fields) {
      fieldTypes.push(field.type);
      fieldNames.push(field.name);
    }

    let cStruct = {
      name: struct,
      fieldTypes,
      fieldNames
    };

    if (struct.tag == 'struct') {
      cStructs.push(cStruct);
    }
    else if (struct.tag == 'enum') {
      cEnums.push(cStruct);
    }
  }

  let slices: Type[] = [];
  for (let struct of ctx.typeMap.values()) {
    if (struct.tag == 'slice') {
      slices.push(struct);
    }
  }

  return { structs: cStructs, enums: cEnums, fns: resolved, slices };
}

function resolveFn(
  genericFn: Fn,
  genericMap: Map<string, Type>,
  ctx: ResolveContext
): CFn {
  if (genericFn.type.tag != 'fn') {
    return undefined!;
  }

  for (let type of genericFn.type.val.paramTypes) {
    queueType(ctx, type);
  }
  queueType(ctx, genericFn.type.val.returnType)

  return {
    name: genericFn.name,
    paramNames: genericFn.paramNames,
    paramTypes: genericFn.type.val.paramTypes,
    returnType: genericFn.type.val.returnType,
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
  else if (inst.tag == 'fn_call') {
    let fn = resolveLeftExpr(inst.val.fn, genericMap, ctx);
    let exprs: Expr[] = [];
    for (let param of inst.val.exprs) {
      exprs.push(resolveExpr(param, genericMap, ctx));
    }

    return { tag: 'fn_call', val: { fn, exprs }, sourceLine: inst.sourceLine };
  }
  else if (inst.tag == 'break' || inst.tag == 'continue') {
    return inst;
  }
  else if (inst.tag == 'declare') {
    let type = applyGenericMap(inst.val.type, genericMap);
    let expr = resolveExpr(inst.val.expr, genericMap, ctx);
    queueType(ctx, type);
    return { tag: 'declare', val: { type, name: inst.val.name, expr }, sourceLine: inst.sourceLine }
  }
  else if (inst.tag == 'assign') {
    let expr = resolveExpr(inst.val.expr, genericMap, ctx);
    let to = resolveLeftExpr(inst.val.to, genericMap, ctx);
    return { tag: 'assign', val: { op: inst.val.op, to, expr }, sourceLine: inst.sourceLine };
  }
  else if (inst.tag == 'include') {
    return inst;
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
  else if (expr.tag == 'not' || expr.tag == 'try' || expr.tag == 'assert') {
    let inner = resolveExpr(expr.val, genericMap, ctx);
    return { tag: 'not', val: inner, type: expr.type };
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
    let key = JSON.stringify(leftExpr);
    if (!ctx.queuedFns.has(key)) {
      ctx.fnResolveQueue.push({ fnName: leftExpr.fnName, unitName: leftExpr.unitName, fnType: depType });
      ctx.queuedFns.add(key);
    }
    return { tag: 'fn', fnName: leftExpr.fnName, unitName: leftExpr.unitName, type: depType };
  }

  logError(-1, 'compiler erorr resolveLeftExpr unreachable');
  return undefined!;
}

