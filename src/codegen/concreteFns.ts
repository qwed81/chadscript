import { Program, Fn, Inst, Expr, LeftExpr } from '../analyze/analyze';
import { logError, compilerError, NULL_POS } from '../index';
import {
  Type, typeApplicableStateful, applyGenericMap, standardizeType,
  getFnNamedParams, RefTable, resolveFn as typeResolveFn, typeApplicable,
  INT
} from '../analyze/types';
import { ensureExprValid, FnContext, newScope } from '../analyze/analyze';

export {
  replaceGenerics, CProgram, CFn, CStruct
}

interface CProgram {
  fns: CFn[]
  strTable: string[]
  orderedStructs: CStruct[]
  entry: CFn
}

type CStruct = { tag: 'arr', val: Type }
  | { tag: 'fn', val: Type }
  | { tag: 'struct', val: CStructImpl, manualRefCount: boolean }
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
  fnRefTable: RefTable,
  fnType: Type
}

interface ResolveContext {
  allFns: Fn[],
  fnResolveQueue: NeedResolveFn[],
  queuedFns: Set<string>
  typeResolveQueue: Type[]
  queuedTypes: Set<string>,
  // tells if the type with a key string has a manual reference count impl
  manualRefCount: Set<string>
}

function replaceGenerics(prog: Program): CProgram {
  let entries: Fn[] = prog.fns.filter(x => x.name == 'main');
  if (entries.length > 1) {
    logError(NULL_POS, 'more than one \'main\' function provided');
    return undefined!;
  }
  else if (entries.length == 0) {
    logError(NULL_POS, 'no \'main\' function provided');
    return undefined!;
  }
 
  let ctx: ResolveContext = {
    allFns: prog.fns,
    manualRefCount: new Set(),
    fnResolveQueue: [],
    queuedFns: new Set(),
    typeResolveQueue: [],
    queuedTypes: new Set()
  };

  let entry: CFn = resolveFn(entries[0], new Map(), ctx);

  let resolved: CFn[] = [];
  resolved.push(entry);

  while (ctx.fnResolveQueue.length > 0) {
    let dep = ctx.fnResolveQueue.pop()!;
    let genericMap: Map<string, Type>;
    let selectedIndex = -1;

    // find which function its referencing
    for (let i = 0; i < prog.fns.length; i++) {
      let map: Map<string, Type> = new Map();
      if (prog.fns[i].name == dep.fnName && prog.fns[i].unitName == dep.unitName) {
        if (typeApplicableStateful(dep.fnType, prog.fns[i].type, map, true)) {
          genericMap = map;
          selectedIndex = i;
          break;
        }
      }
    }

    let fnToResolve: Fn;
    // this is the default fn
    if (selectedIndex == -1) {
      if (dep.fnType.tag != 'fn') {
        compilerError('type should always be fn')
        continue;
      }
      
      let scope: FnContext = newScope(dep.fnType.val.returnType, new Set(), []);
      let defaultFn = createDefaultFn(dep, dep.fnRefTable, scope);
      if (defaultFn == null) {
        continue;
      }
      fnToResolve = defaultFn;
    }
    else {
      fnToResolve = prog.fns[selectedIndex]
    }

    let cFn = resolveFn(fnToResolve, genericMap!, ctx);
    resolved.push(cFn);
  }

  let orderedStructs = orderStructs(ctx.typeResolveQueue, ctx.manualRefCount);
  return { orderedStructs, fns: resolved, strTable: prog.strTable, entry };
}

function queueType(ctx: ResolveContext, type: Type) {
  standardizeType(type);
  // all arrays need to have the same constant to work as keys
  if (type.tag == 'arr') {
    type.constant = false;
  }
  let key = JSON.stringify(type);
  if (ctx.queuedTypes.has(key)) {
    return;
  }

  // have to queue all the types recursively so that resolveManualRefCount
  // can be called prior to ordering structs
  if (type.tag == 'struct' || type.tag == 'enum') {
    for (let i = 0; i < type.val.fields.length; i++) {
      queueType(ctx, type.val.fields[i].type);
    }
  }
  else if (type.tag == 'fn') {
    for (let i = 0; i < type.val.paramTypes.length; i++) {
      queueType(ctx, type.val.paramTypes[i]);
    }
    queueType(ctx, type.val.returnType);
  }

  let isCounted = resolveManualRefCountImpl(type, ctx);
  ctx.typeResolveQueue.push(type);
  ctx.queuedTypes.add(key);
  if (isCounted) {
    ctx.manualRefCount.add(key);
  }
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

  let body: Inst[] = resolveInstBody(genericFn.body, genericMap, ctx);
  return {
    name: genericFn.name,
    paramNames: genericFn.paramNames,
    genericMap,
    unitName: genericFn.unitName,
    type: newType,
    body
  };
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
    return { tag: inst.tag, val: { cond, body }, position: inst.position };
  }
  else if (inst.tag == 'else') {
    let body = resolveInstBody(inst.val, genericMap, ctx);
    return { tag: 'else', val: body, position: inst.position };
  }
  else if (inst.tag == 'for_in') {
    let body = resolveInstBody(inst.val.body, genericMap, ctx);
    let iter = resolveExpr(inst.val.iter, genericMap, ctx);
    let nextFn = resolveLeftExpr(inst.val.nextFn, genericMap, ctx);
    return { tag: 'for_in', val: { varName: inst.val.varName, body, iter, nextFn }, position: inst.position };
  }
  else if (inst.tag == 'return') {
    if (inst.val != null) {
      return { tag: 'return', val: resolveExpr(inst.val, genericMap, ctx), position: inst.position };
    }
    return inst;
  }
  else if (inst.tag == 'expr') {
    let val = resolveExpr(inst.val, genericMap, ctx);
    return { tag: 'expr', val, position: inst.position };
  }
  else if (inst.tag == 'break' || inst.tag == 'continue') {
    return inst;
  }
  else if (inst.tag == 'declare') {
    let type = applyGenericMap(inst.val.type, genericMap);
    queueType(ctx, type);
    if (inst.val.expr != null) {
      let expr = resolveExpr(inst.val.expr, genericMap, ctx);
      return { tag: 'declare', val: { type, name: inst.val.name, expr }, position: inst.position }
    } 
    return { tag: 'declare', val: { type, name: inst.val.name, expr: null }, position: inst.position }
  }
  else if (inst.tag == 'assign') {
    let expr = resolveExpr(inst.val.expr, genericMap, ctx);
    let to = resolveLeftExpr(inst.val.to, genericMap, ctx);
    return { tag: 'assign', val: { op: inst.val.op, to, expr }, position: inst.position };
  }
  else if (inst.tag == 'include') {
    let newTypes: Type[] = [];
    for (let type of inst.val.types) {
      newTypes.push(applyGenericMap(type, genericMap));
    }
    return { tag: 'include', val: { lines: inst.val.lines, types: newTypes }, position: inst.position };
  }

  compilerError('resolveInst unreachable');
  return undefined!;
}

function addFnToResolve(ctx: ResolveContext, fnName: string, unitName: string, fnType: Type, refTable: RefTable) {
  standardizeType(fnType);
  if (fnType.tag != 'fn') {
    compilerError('expected fn type');
    return undefined;
  }
  for (let i = 0; i < fnType.val.linkedParams.length; i++) {
    fnType.val.linkedParams[i] = true;
  }

  // set a blank refTable to create proper key
  let newLeftExpr: LeftExpr = { tag: 'fn', fnName, unitName, type: fnType, refTable: undefined! };
  let key = JSON.stringify(newLeftExpr);
  // set the refTable back so its valid
  newLeftExpr.refTable = refTable;

  if (!ctx.queuedFns.has(key)) {
    ctx.fnResolveQueue.push({ fnName, unitName, fnType, fnRefTable: refTable });
    ctx.queuedFns.add(key);
  }
  return newLeftExpr;
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
  else if (expr.tag == 'arr_init') {
    let exprs: Expr[] = [];
    for (let e of expr.val) {
      let res = resolveExpr(e, genericMap, ctx);
      exprs.push(res);
    }

    let type = applyGenericMap(expr.type, genericMap);
    return { tag: 'arr_init', val: exprs, type: type }
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
  else if (expr.tag == 'fmt_str') {
    let resolvedExprs: Expr[] = [];
    for (let val of expr.val) {
      resolvedExprs.push(resolveExpr(val, genericMap, ctx));
    }
    return { tag: 'fmt_str', val: resolvedExprs, type: expr.type };
  }
  else if (expr.tag == 'char_const'
    || expr.tag == 'int_const'
    || expr.tag =='bool_const'
    || expr.tag == 'num_const'
    || expr.tag == 'str_const') {

    return expr;
  }

  compilerError('resolveExpr unreachable');
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
    let v = resolveExpr(leftExpr.val.var, genericMap, ctx);
    let type = applyGenericMap(leftExpr.type, genericMap);
    return { tag: 'arr_offset_int', val: { var: v, index }, type };
  }
  else if (leftExpr.tag == 'arr_offset_slice') {
    let range = resolveExpr(leftExpr.val.range, genericMap, ctx);
    let v = resolveExpr(leftExpr.val.var, genericMap, ctx);
    let type = applyGenericMap(leftExpr.type, genericMap);
    return { tag: 'arr_offset_slice', val: { var: v, range }, type };
  }
  else if (leftExpr.tag == 'var') {
    let type = applyGenericMap(leftExpr.type, genericMap);
    return { tag: 'var', val: leftExpr.val, mode: leftExpr.mode, type };
  }
  else if (leftExpr.tag == 'fn') {
    let depType = applyGenericMap(leftExpr.type, genericMap);
    addFnToResolve(ctx, leftExpr.fnName, leftExpr.unitName, depType, leftExpr.refTable);
    let newLeftExpr: LeftExpr = {
      tag: 'fn',
      type: depType,
      fnName: leftExpr.fnName,
      unitName: leftExpr.unitName,
      refTable: leftExpr.refTable 
    };

    return newLeftExpr;
  }

  compilerError('resolveLeftExpr unreachable');
  return undefined!;
}

// the default function is just a function with no named params
// that calls the template function with the default named params.
// used for resolve fns
function createDefaultFn(
  fnDep: NeedResolveFn,
  refTable: RefTable,
  scope: FnContext,
): Fn | null {
  if (fnDep.fnType.tag != 'fn') {
    return null;
  }

  let returnType: Type = fnDep.fnType.val.returnType;
  let paramTypes: Type[] = fnDep.fnType.val.paramTypes;
  let template = typeResolveFn(fnDep.fnName, returnType, paramTypes, refTable, NULL_POS);
  if (template == null) {
    return null;
  }

  let namedParams = getFnNamedParams(fnDep.unitName, fnDep.fnName, fnDep.fnType, refTable, NULL_POS);
  if (namedParams.length == 0) {
    return null;
  }

  let defaultParamNames: string[] = [];
  let defaultLinkedParams: boolean[] = [];
  let defaultParamTypes: Type[] = [];

  let defaultFnCallExprs: Expr[] = [];
  if (template.fnType.tag != 'fn') {
    return null;
  }

  for (let i = 0; i < template.paramNames.length; i++) {
    // the default expr can be a valid expr, null, or in the case of a resolve
    // fn it can be the string function name that should be resolved
    let defaultExpr: Expr | null | string = null;
    let paramType: Type | null = null;

    let paramIsNamed = false;
    for (let j = 0; j < namedParams.length; j++) {
      if (namedParams[j].name == template.paramNames[i]) {
        let parseExpr = namedParams[j].expr;
        if (namedParams[j].type.tag != 'fn' || parseExpr.tag != 'left_expr' || parseExpr.val.tag != 'var') {
          defaultExpr = ensureExprValid(parseExpr, namedParams[j].type, refTable, scope, NULL_POS);
          paramType = template.fnType.val.paramTypes[i];
        }
        else {
          defaultExpr = parseExpr.val.val; // the resolve string
          paramType = template.fnType.val.paramTypes[i];
        }
        paramIsNamed = true;
      }
    }

    if (paramIsNamed == false) {
      defaultLinkedParams.push(fnDep.fnType.val.linkedParams[i]);
      defaultParamTypes.push(fnDep.fnType.val.paramTypes[i]);
      defaultParamNames.push(template.paramNames[i]);
    }

    if (defaultExpr == null || paramType == null) {
      let expr: Expr = {
        tag: 'left_expr',
        val: {
          tag: 'var',
          val: template.paramNames[i],
          mode: 'param',
          type: fnDep.fnType.val.paramTypes[i]
        },
        type: fnDep.fnType.val.paramTypes[i]
      };
      defaultFnCallExprs.push(expr);
    }
    else {
      if (typeof defaultExpr === 'string') {
        if (paramType.tag != 'fn') {
          compilerError('resolve only valid on fn types');
          return null;
        }

        let returnType = paramType.val.returnType;
        let thisParamTypes = paramType.val.paramTypes;
        let fnResult = typeResolveFn(defaultExpr, returnType, thisParamTypes, refTable, NULL_POS);
        if (fnResult == null) {
          return null;
        }

        defaultExpr = {
          tag: 'left_expr',
          val: {
            tag: 'fn',
            type: paramType,
            refTable: fnDep.fnRefTable,
            fnName: fnResult.fnName,
            unitName: fnResult.unitName
          },
          type: paramType,
        };
      }

      defaultFnCallExprs.push(defaultExpr);
    }
  }

  let defaultFnType: Type = {
    tag: 'fn',
    val: {
      returnType: returnType,
      paramTypes: paramTypes,
      linkedParams: defaultLinkedParams
    }
  };

  let leftExpr: LeftExpr = {
    tag: 'fn',
    unitName: template.unitName,
    refTable: fnDep.fnRefTable,
    fnName: template.fnName,
    type: template.fnType
  };

  let callExpr: Expr = {
    tag: 'fn_call',
    type: template.fnType.val.returnType,
    val: {
      exprs: defaultFnCallExprs,
      fn: leftExpr
    } 
  };
  let callInst: Inst = {
    tag: 'return',
    val: callExpr,
    position: NULL_POS
  };
  let defaultFn: Fn = {
    name: fnDep.fnName,
    unitName: fnDep.unitName,
    paramNames: defaultParamNames,
    type: defaultFnType,
    body: [callInst],
    scope,
    refTable
  };

  return defaultFn;
}

function resolveManualRefCountImpl(type: Type, ctx: ResolveContext): boolean {
  for (let fn of ctx.allFns) {
    if (fn.name != 'unsafeChangeRefCount') {
      continue;
    }

    if (fn.type.tag != 'fn') {
      compilerError('expected fn type');
      return false;
    }

    let paramTypes = fn.type.val.paramTypes;
    if (paramTypes.length < 2 || !typeApplicable(paramTypes[1], INT, false)) {
      logError(NULL_POS, 'invalid type signature for unsafeChangeRefCount');
      return false;
    }

    let genericMap: Map<string, Type> = new Map();
    if (!typeApplicableStateful(type, paramTypes[0], genericMap, true)) {
      continue;
    }

    let newFnType = applyGenericMap(fn.type, genericMap)
    addFnToResolve(ctx, fn.name, fn.unitName, newFnType, fn.refTable);
    return true;
  }

  return false;
}

function typeTreeRecur(
  type: Type,
  inStack: Set<string>,
  alreadyGenned: Set<string>,
  output: CStruct[],
  manualRefCountSet: Set<string>
) {
  if (type.tag == 'arr') {
    typeTreeRecur(type.val, inStack, alreadyGenned, output, manualRefCountSet);

    let typeKey = JSON.stringify(type);
    if (alreadyGenned.has(typeKey)) {
      return;
    }
    alreadyGenned.add(typeKey);
    output.push({ tag: 'arr', val: type });
    return;
  }
  else if (type.tag == 'fn') {
    let typeKey = JSON.stringify(type);
    if (alreadyGenned.has(typeKey)) {
      return;
    }
    typeTreeRecur(type.val.returnType, inStack, alreadyGenned, output, manualRefCountSet);
    for (let i = 0; i < type.val.paramTypes.length; i++) {
      typeTreeRecur(type.val.paramTypes[i], inStack, alreadyGenned, output, manualRefCountSet);
    }
    alreadyGenned.add(typeKey);
    output.push({ tag: 'fn', val: type });
  }

  if (type.tag != 'struct' && type.tag != 'enum') {
    return;
  }

  let typeKey = JSON.stringify(type);
  if (inStack.has(typeKey)) {
    compilerError('recusive struct' + typeKey);
    return;
  }
  if (alreadyGenned.has(typeKey)) {
    return;
  }
  alreadyGenned.add(typeKey);

  inStack.add(typeKey);
  for (let field of type.val.fields) {
    typeTreeRecur(field.type, inStack, alreadyGenned, output, manualRefCountSet);
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
    },
    manualRefCount: manualRefCountSet.has(typeKey)
  };

  output.push(cStruct);
}

function orderStructs(typeResolveQueue: Type[], manualRefCountSet: Set<string>): CStruct[] {
  let alreadyGenned: Set<string> = new Set();
  let output: CStruct[] = [];
  for (let type of typeResolveQueue) {
    typeTreeRecur(type, new Set(), alreadyGenned, output, manualRefCountSet);
  }

  return output;
}

