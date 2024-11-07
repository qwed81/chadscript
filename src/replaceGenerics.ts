import { FnImpl, Inst, Expr, LeftExpr, Program as AnalyzeProgram } from './analyze';
import { compilerError } from './util';
import {
  typeEq, Type, serializeType, applyGenericMap, resolveImpl, BOOL, typeApplicable,
  NIL, typeApplicableStateful, RANGE, isBasic, UnitSymbols, refType, INT
} from './typeload';

export {
  replaceGenerics, Program
}

interface Program {
  includes: string[]
  fns: FnImpl[]
  orderedTypes: Type[]
  entry: FnImpl
}

interface FnKey {
  name: string,
  unit: string,
  // serializeType
  type: string 
}

interface FnSet {
  fnTemplates: Map<string, FnImpl[]>
  // maps via serializeType(type)
  types: Map<string, Type>,
  // maps via json(FnKey)
  fns: Map<string, FnImpl>,
  // to be able to lookup traits
  symbols: UnitSymbols[]
}

function replaceGenerics(prog: AnalyzeProgram, mainFn: FnImpl): Program {
  let fnSet: FnSet = {
    fnTemplates: new Map(),
    types: new Map(),
    fns: new Map(),
    symbols: prog.symbols
  };

  for (let i = 0; i < prog.fns.length; i++) {
    let fnName = prog.fns[i].header.name;
    if (fnSet.fnTemplates.get(fnName) == undefined) {
      fnSet.fnTemplates.set(fnName, []);
    }
    fnSet.fnTemplates.get(fnName)!.push(prog.fns[i]);
  }

  let entry = monomorphizeFn(mainFn, fnSet, new Map());
  let orderedTypes = orderTypes(Array.from(fnSet.types.values()));

  let fns = Array.from(fnSet.fns.values());
  return {
    orderedTypes,
    includes: prog.includes,
    fns,
    entry
  };
}

function shouldResolveFn(
  set: FnSet,
  name: string,
  unit: string,
  type: Type
): boolean {
  let keyProps: FnKey = { name, unit, type: serializeType(type) };
  let key = JSON.stringify(keyProps);
  return !set.fns.has(key);
}

function getFnTemplate(
  set: FnSet,
  name: string,
  unit: string,
  type: Type
): FnImpl {
  let fnList: FnImpl[] = set.fnTemplates.get(name)!;
  for (let i = 0; i < fnList.length; i++) {
    if (fnList[i].header.unit != unit) continue;
    let templateType: Type = {
      tag: 'fn',
      returnType: fnList[i].header.returnType,
      paramTypes: fnList[i].header.paramTypes
    }

    if (!typeApplicable(type, templateType, true)) continue;
    return fnList[i];
  }

  compilerError('function should always exist')
  return undefined!;
}

function addType(set: FnSet, type: Type) {
  let key = serializeType(type);
  if (set.types.has(key)) {
    return;
  }
  set.types.set(key, type);
  if (type.tag == 'struct') {
    for (let i = 0; i < type.val.fields.length; i++) {
      addType(set, type.val.fields[i].type);
    }
  }
  else if (type.tag == 'fn') {
    for (let i = 0; i < type.paramTypes.length; i++) {
      addType(set, type.paramTypes[i]);
    }
    addType(set, type.returnType);
  }
}

function monomorphizeFn(
  genericFn: FnImpl,
  set: FnSet,
  genericMap: Map<string, Type>,
): FnImpl {
  let paramTypes: Type[] = [];
  for (let param of genericFn.header.paramTypes) {
    let newParam = applyGenericMap(param, genericMap);
    addType(set, newParam);
    paramTypes.push(newParam);
  }
  let returnType = applyGenericMap(genericFn.header.returnType, genericMap);
  addType(set, returnType);

  let body = resolveInstBody(genericFn.body, set, genericMap);
  let impl = {
    header: {
      returnType: returnType,
      paramTypes,
      paramNames: genericFn.header.paramNames,
      name: genericFn.header.name,
      unit: genericFn.header.unit,
      mode: genericFn.header.mode
    },
    body
  }

  let keyProps: FnKey = {
    name: genericFn.header.name,
    unit: genericFn.header.unit,
    type: serializeType({ tag: 'fn', returnType, paramTypes}) 
  };
  let key = JSON.stringify(keyProps);
  set.fns.set(key, impl)

  return impl;
}

function resolveInstBody(
  body: Inst[],
  set: FnSet,
  genericMap: Map<string, Type>,
): Inst[] {
  let resolvedBody: Inst[] = [];
  for (let inst of body) {
    let resolvedInst = resolveInst(inst, set, genericMap);
    resolvedBody.push(resolvedInst);
  }
  return resolvedBody;
}

function resolveInst(
  inst: Inst,
  set: FnSet,
  genericMap: Map<string, Type>,
): Inst {
  if (inst.tag == 'if' || inst.tag == 'elif' || inst.tag == 'while') {
    let cond = resolveExpr(inst.val.cond, set, genericMap);
    let body = resolveInstBody(inst.val.body, set, genericMap);
    return { tag: inst.tag, val: { cond, body }, position: inst.position };
  }
  else if (inst.tag == 'else') {
    let body = resolveInstBody(inst.val, set, genericMap);
    return { tag: 'else', val: body, position: inst.position };
  }
  else if (inst.tag == 'for_in') {
    let body = resolveInstBody(inst.val.body, set, genericMap);
    let iter = resolveExpr(inst.val.iter, set, genericMap);
    let nf = inst.val.nextFn;
    let type: Type = { tag: 'fn', paramTypes: nf.paramTypes, returnType: nf.returnType };
    let nextFn: LeftExpr = {
      tag: 'fn',
      unit: nf.unit,
      name: nf.name,
      type
    };
    addType(set, RANGE); 
    resolveLeftExpr(nextFn, set, genericMap);

    return { tag: 'for_in', val: { varName: inst.val.varName, body, iter, nextFn: inst.val.nextFn }, position: inst.position };
  }
  else if (inst.tag == 'return') {
    if (inst.val != null) {
      return { tag: 'return', val: resolveExpr(inst.val, set, genericMap), position: inst.position };
    }
    return inst;
  }
  else if (inst.tag == 'expr') {
    let val = resolveExpr(inst.val, set, genericMap);
    return { tag: 'expr', val, position: inst.position };
  }
  else if (inst.tag == 'break' || inst.tag == 'continue') {
    return inst;
  }
  else if (inst.tag == 'declare') {
    let type = applyGenericMap(inst.val.type, genericMap);
    addType(set, type);
    let expr = resolveExpr(inst.val.expr, set, genericMap);
    return { tag: 'declare', val: { type, name: inst.val.name, expr }, position: inst.position }
  }
  else if (inst.tag == 'assign') {
    let expr = resolveExpr(inst.val.expr, set, genericMap);
    let to = resolveLeftExpr(inst.val.to, set, genericMap);
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

function resolveExpr(
  expr: Expr,
  set: FnSet,
  genericMap: Map<string, Type>,
): Expr {
  if (expr.tag == 'bin') {
    let left = resolveExpr(expr.val.left, set, genericMap);
    let right = resolveExpr(expr.val.right, set, genericMap);
    if ((expr.val.op == '==' || expr.val.op == '!=') && !isBasic(expr.val.left.type)) {
      let impl = resolveImpl(set.symbols[0], 'eq', [left.type, right.type], BOOL, null);
      if (impl == null) {
        compilerError('always can resovle trait');
        return undefined!;
      }
      let eq: LeftExpr = {
        tag: 'fn',
        unit: impl.unit,
        name: impl.name,
        type: impl.resolvedType
      };
      resolveLeftExpr(eq, set, genericMap);
      return {
        tag: 'fn_call',
        val: {
          fn: eq,
          exprs: [left, right] 
        }, 
        type: BOOL 
      };
    }

    let type = applyGenericMap(expr.type, genericMap);
    return { tag: 'bin', val: { op: expr.val.op, left, right }, type };
  }
  else if (expr.tag == 'is') {
    let left = resolveLeftExpr(expr.left, set, genericMap);
    return { tag: 'is', left, variant: expr.variant, variantIndex: expr.variantIndex, type: expr.type };
  }
  else if (expr.tag == 'not' || expr.tag == 'try' || expr.tag == 'assert' || expr.tag == 'cast') {

    let inner = resolveExpr(expr.val, set, genericMap);
    let type = applyGenericMap(expr.type, genericMap);
    if (expr.tag == 'not') {
      return { tag: expr.tag, val: inner, type };
    }
    else if (expr.tag == 'cast') {
      return { tag: expr.tag, val: inner, type };
    }
    else if (expr.tag == 'try') {
      return { tag: expr.tag, val: inner, type };
    }
    else if (expr.tag == 'assert') {
      return { tag: expr.tag, val: inner, type};
    }
  }
  else if (expr.tag == 'nil_const') {
    return { tag: 'nil_const', type: NIL };
  }
  else if (expr.tag == 'fn_call') {
    let fn = resolveLeftExpr(expr.val.fn, set, genericMap);
    let exprs: Expr[] = [];
    for (let param of expr.val.exprs) {
      exprs.push(resolveExpr(param, set, genericMap));
    }

    let returnType = applyGenericMap(expr.type, genericMap);
    return { tag: 'fn_call', val: { fn, exprs }, type: returnType };
  }
  else if (expr.tag == 'list_init') {
    let exprs: Expr[] = [];
    for (let e of expr.val) {
      let res = resolveExpr(e, set, genericMap);
      exprs.push(res);
    }

    let type = applyGenericMap(expr.type, genericMap);
    return { tag: 'list_init', val: exprs, type: type }
  }
  else if (expr.tag == 'struct_init') {
    let inits = [];
    for (let init of expr.val) {
      let initExpr = resolveExpr(init.expr, set, genericMap);
      inits.push({ name: init.name, expr: initExpr });
    }

    let type = applyGenericMap(expr.type, genericMap);
    return { tag: 'struct_init', val: inits, type: type }
  }
  else if (expr.tag == 'enum_init') {
    let type = applyGenericMap(expr.type, genericMap);
    if (expr.fieldExpr != null) {
      let fieldExpr = resolveExpr(expr.fieldExpr, set, genericMap);
      return { tag: 'enum_init', fieldName: expr.fieldName, variantIndex: expr.variantIndex, fieldExpr, type };
    }
    return { tag: 'enum_init', fieldName: expr.fieldName, variantIndex: expr.variantIndex, fieldExpr: null, type };
  }
  else if (expr.tag == 'left_expr') {
    let val = resolveLeftExpr(expr.val, set, genericMap);
    return { tag: 'left_expr', val, type: val.type };
  }
  else if (expr.tag == 'fmt_str') {
    let resolvedExprs: Expr[] = [];
    for (let val of expr.val) {
      resolvedExprs.push(resolveExpr(val, set, genericMap));
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
  else if (expr.tag == 'ptr') {
    let val = resolveLeftExpr(expr.val, set, genericMap);
    return { tag: 'ptr', val, type: { tag: 'ptr', val: val.type } };
  }

  compilerError('resolveExpr unreachable');
  return undefined!;
}

function resolveLeftExpr(
  leftExpr: LeftExpr,
  set: FnSet,
  genericMap: Map<string, Type>,
): LeftExpr {
  if (leftExpr.tag == 'dot') {
    let left = resolveExpr(leftExpr.val.left, set, genericMap);
    let type = applyGenericMap(leftExpr.type, genericMap);
    return { tag: 'dot', val: { left, varName: leftExpr.val.varName }, type };
  }
  else if (leftExpr.tag == 'index') {
    let index = resolveExpr(leftExpr.val.index, set, genericMap);
    let v = resolveExpr(leftExpr.val.var, set, genericMap);
    if (leftExpr.val.var.type.tag != 'ptr') {
      let impl = resolveImpl(set.symbols[0], 'index', [refType(v.type), index.type], null, null);
      if (impl == null) {
        compilerError('always can resovle trait');
        return undefined!;
      }
      let eq: LeftExpr = {
        tag: 'fn',
        unit: impl.unit,
        name: impl.name,
        type: impl.resolvedType
      };
      resolveLeftExpr(eq, set, genericMap);
      let fnCall: Expr = {
        tag: 'fn_call',
        val: {
          fn: eq,
          exprs: [v, index] 
        }, 
        type: BOOL 
      };
      return {
        tag: 'index',
        val: {
          var: fnCall,
          index: { tag: 'int_const', val: 0, type: INT }
        },
        type: leftExpr.type
      }
    }

    let type = applyGenericMap(leftExpr.type, genericMap);
    return { tag: 'index', val: { var: v, index }, type };
  }
  else if (leftExpr.tag == 'var') {
    let type = applyGenericMap(leftExpr.type, genericMap);
    return { tag: 'var', val: leftExpr.val, mode: leftExpr.mode, type };
  }
  else if (leftExpr.tag == 'fn') {
    let shouldResolve = shouldResolveFn(set, leftExpr.name, leftExpr.unit, leftExpr.type);
    let fnType: Type;

    if (shouldResolve) {
      let genericFn = getFnTemplate(set, leftExpr.name, leftExpr.unit, leftExpr.type);
      let genericType: Type = { tag: 'fn', paramTypes: genericFn.header.paramTypes, returnType: genericFn.header.returnType };
      let newFnGenericMap: Map<string, Type> = new Map();
      if (!typeApplicableStateful(leftExpr.type, genericType, newFnGenericMap, true)) {
        compilerError('fn should be applicable');
      }
      monomorphizeFn(genericFn, set, newFnGenericMap);
      let implType = applyGenericMap(genericType, newFnGenericMap);
      fnType = implType;
    }
    else {
      fnType = leftExpr.type
    }

    let newLeftExpr: LeftExpr = {
      tag: 'fn',
      type: fnType,
      name: leftExpr.name,
      unit: leftExpr.unit,
    };

    return newLeftExpr;
  }

  compilerError('resolveLeftExpr unreachable');
  return undefined!;
}

function typeTreeRecur(
  type: Type,
  inStack: Set<string>,
  alreadyGenned: Set<string>,
  output: Type[],
  queue: Type[],
) {
  if (type.tag == 'fn') {
    let typeKey = serializeType(type);
    if (alreadyGenned.has(typeKey)) return;
    typeTreeRecur(type.returnType, inStack, alreadyGenned, output, queue);
    for (let i = 0; i < type.paramTypes.length; i++) {
      typeTreeRecur(type.paramTypes[i], inStack, alreadyGenned, output, queue);
    }
    alreadyGenned.add(typeKey);
    output.push(type);
  }

  if (type.tag == 'ptr') {
    let typeKey = serializeType(type.val);
    if (alreadyGenned.has(typeKey)) return;
    queue.push(type.val);
  }

  if (type.tag != 'struct') {
    return;
  }

  let typeKey = serializeType(type);
  if (inStack.has(typeKey)) {
    compilerError('recusive struct ' + typeKey);
    return;
  }
  if (alreadyGenned.has(typeKey)) return;
  alreadyGenned.add(typeKey);

  inStack.add(typeKey);
  for (let field of type.val.fields) {
    typeTreeRecur(field.type, inStack, alreadyGenned, output, queue);
  }
  inStack.delete(typeKey);

  let fieldTypes: Type[] = [];
  let fieldNames: string[] = [];
  for (let field of type.val.fields) {
    fieldTypes.push(field.type);
    fieldNames.push(field.name);
  }

  output.push(type);
}

function orderTypes(queue: Type[]): Type[] {
  let alreadyGenned: Set<string> = new Set();
  let output: Type[] = [];
  while (queue.length != 0) {
    let type = queue.pop()!;
    typeTreeRecur(type, new Set(), alreadyGenned, output, queue);
  }
  return output;
}
