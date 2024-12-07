import { FnMode } from './parse';
import { FnImpl, Inst, Expr, LeftExpr, Program as AnalyzeProgram, GlobalImpl, MacroArg } from './analyze';
import { compilerError, Position, logError } from './util';
import {
  Type, getTypeKey, applyGenericMap, resolveImpl, BOOL, typeApplicable,
  NIL, typeApplicableStateful, RANGE, isBasic, UnitSymbols, INT, FMT, STR,
  F64, getFields, isGeneric
} from './typeload';

export {
  replaceGenerics, Program
}

interface Program {
  fns: FnImpl[]
  globals: GlobalImpl[]
  orderedTypes: Type[]
  entry: FnImpl
}

interface FnKey {
  name: string,
  unit: string,
  // serializeType
  type: string 
  // to prevent double declaration
  mode: FnMode
}

interface CurrentField {
  currentFieldName: string,
  currentFieldType: Type,
  currentFieldExpr: Expr,
}

interface FnSet {
  fnTemplates: Map<string, FnImpl[]>
  // maps via serializeType(type)
  types: Map<string, Type>,
  // maps via json(FnKey)
  fns: Map<string, FnImpl>,

  // maps via json(FnKey)
  used: Set<string>

  // to be able to lookup impls
  symbols: UnitSymbols[],

  // for field in iter
  fieldStack: CurrentField[]

  // to determine position of impl
  genericCallStack: (Position | null)[]
}

function replaceGenerics(prog: AnalyzeProgram, symbols: UnitSymbols[], mainFn: FnImpl): Program {
  let fnSet: FnSet = {
    fnTemplates: new Map(),
    types: new Map(),
    fns: new Map(),
    used: new Set(),
    symbols,
    fieldStack: [],
    genericCallStack: []
  };

  for (let i = 0; i < prog.fns.length; i++) {
    let fnName = prog.fns[i].header.name;
    if (fnSet.fnTemplates.get(fnName) == undefined) {
      fnSet.fnTemplates.set(fnName, []);
    }
    fnSet.fnTemplates.get(fnName)!.push(prog.fns[i]);
  }

  for (let i = 0; i < prog.globals.length; i++) {
    addType(fnSet, prog.globals[i].header.type);
  }

  addType(fnSet, STR);

  let entry = monomorphizeFn(mainFn, fnSet, new Map());
  let orderedTypes = orderTypes(Array.from(fnSet.types.values()));

  let fns = Array.from(fnSet.fns.values());
  return {
    orderedTypes,
    fns,
    globals: prog.globals,
    entry
  };
}

function shouldResolveFn(
  set: FnSet,
  name: string,
  unit: string,
  mode: FnMode,
  type: Type
): boolean {
  let fnTemplates: FnImpl[] | undefined = set.fnTemplates.get(name); 
  if (fnTemplates == undefined) {
    return false;
  }

  let keyProps: FnKey = { name, unit, type: getTypeKey(type), mode };
  let key = JSON.stringify(keyProps);
  for (let i = 0; i < fnTemplates.length; i++) {
    let header = fnTemplates[i].header;
    if (header.mode != mode) continue;
    if (header.unit != unit) continue;
    let fnType: Type = { tag: 'fn', paramTypes: header.paramTypes, returnType: header.returnType };
    if (!typeApplicable(type, fnType, true)) continue;

    return !(set.fns.has(key) || set.used.has(key));
  }

  return false;
}

function getFnTemplate(
  set: FnSet,
  name: string,
  unit: string,
  mode: FnMode,
  type: Type
): FnImpl {
  let fnList: FnImpl[] = set.fnTemplates.get(name)!;
  for (let i = 0; i < fnList.length; i++) {
    if (fnList[i].header.unit != unit) continue;
    if (fnList[i].header.mode != mode) continue;
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
  let key = getTypeKey(type);
  if (set.types.has(key)) {
    return;
  }
  set.types.set(key, type);
  let fields = getFields(type);
  if (type.tag == 'struct') {
    for (let i = 0; i < fields.length; i++) {
      addType(set, fields[i].type);
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
    type: getTypeKey({ tag: 'fn', returnType, paramTypes}) ,
    mode: genericFn.header.mode
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
    if (resolvedInst == null) continue;
    resolvedBody.push(...resolvedInst);
  }
  return resolvedBody;
}

function resolveInst(
  inst: Inst,
  set: FnSet,
  genericMap: Map<string, Type>,
): Inst[] | null {
  if (inst.tag == 'if' || inst.tag == 'elif' || inst.tag == 'while') {
    let cond = resolveExpr(inst.val.cond, set, genericMap, inst.position);
    let body = resolveInstBody(inst.val.body, set, genericMap);
    if (cond == null) return null;
    return [{ tag: inst.tag, val: { cond, body }, position: inst.position }];
  }
  else if (inst.tag == 'else') {
    let body = resolveInstBody(inst.val, set, genericMap);
    return [{ tag: 'else', val: body, position: inst.position }];
  }
  else if (inst.tag == 'for_in') {
    let iter = resolveExpr(inst.val.iter, set, genericMap, inst.position);
    if (iter == null) return null;
    if (inst.val.varName == 'field') {
      let output: Inst[] = [];
      if (iter.type.tag == 'struct') {
        let fields = getFields(iter.type);
        for (let i = 0; i < fields.length; i++) {
          set.fieldStack.push({
            currentFieldName: fields[i].name,
            currentFieldType: fields[i].type,
            currentFieldExpr: iter,
          })
          genericMap.set('val', fields[i].type);
          let body = resolveInstBody(inst.val.body, set, genericMap);
          output.push(...body);
          set.fieldStack.pop();
        }
      }
      return output;
    }

    let body = resolveInstBody(inst.val.body, set, genericMap);
    let nf = inst.val.nextFn!;
    let type: Type = { tag: 'fn', paramTypes: nf.paramTypes, returnType: nf.returnType };
    let nextFn: LeftExpr = {
      tag: 'fn',
      unit: nf.unit,
      name: nf.name,
      mode: nf.mode,
      isGeneric: true,
      type
    };
    addType(set, RANGE); 
    resolveLeftExpr(nextFn, set, genericMap, inst.position);

    return [{ tag: 'for_in', val: { varName: inst.val.varName, body, iter, nextFn: inst.val.nextFn }, position: inst.position }];
  }
  else if (inst.tag == 'return') {
    if (inst.val != null) {
      return [{ tag: 'return', val: resolveExpr(inst.val, set, genericMap, inst.position), position: inst.position }];
    }
    return [inst];
  }
  else if (inst.tag == 'expr') {
    let val = resolveExpr(inst.val, set, genericMap, inst.position);
    if (val == null) return null;
    return [{ tag: 'expr', val, position: inst.position }];
  }
  else if (inst.tag == 'break' || inst.tag == 'continue') {
    return [inst];
  }
  else if (inst.tag == 'declare') {
    let type = applyGenericMap(inst.val.type, genericMap);
    addType(set, type);
    let expr = resolveExpr(inst.val.expr, set, genericMap, inst.position);
    if (expr == null) return null;
    return [{ tag: 'declare', val: { type, name: inst.val.name, expr }, position: inst.position }]
  }
  else if (inst.tag == 'assign') {
    let to = resolveLeftExpr(inst.val.to, set, genericMap, inst.position);
    let expr = resolveExpr(inst.val.expr, set, genericMap, inst.position);
    if (to == null || expr == null) return null;

    if (inst.val.op == '++=') {
      if (to.type.tag == 'struct' && to.type.val.template.name == 'Fmt' && to.type.val.template.unit == 'std/core') {
        let toExpr: Expr = { tag: 'left_expr', val: to, type: to.type };
        let impl = implToExpr(set, 'format', [to.type, expr.type], NIL, genericMap, [toExpr, expr], inst.position);
        if (impl == null) return [];
        return [{
          tag: 'expr',
          val: impl,
          position: inst.position
        }];
      }

      let toExpr: Expr = { tag: 'left_expr', val: to, type: to.type };
      let impl = implToExpr(set, 'append', [to.type, expr.type], NIL, genericMap, [toExpr, expr], inst.position);
      if (impl == null) return [];
      return [{
        tag: 'expr',
        val: impl,
        position: inst.position
      }];
    }

    return [{ tag: 'assign', val: { op: inst.val.op, to, expr }, position: inst.position }];
  }
  else if (inst.tag == 'include') {
    let newTypes: Type[] = [];
    for (let type of inst.val.types) {
      newTypes.push(applyGenericMap(type, genericMap));
    }
    return [{ tag: 'include', val: { lines: inst.val.lines, types: newTypes }, position: inst.position }];
  }

  compilerError('resolveInst unreachable');
  return undefined!;
}

function implToExpr(
  set: FnSet,
  name: string,
  paramTypes: Type[],
  returnType: Type | null,
  genericMap: Map<string, Type>,
  exprs: Expr[],
  position: Position,
): Expr | null {
  let newParamTypes: Type[] = [];
  for (let i = 0; i < paramTypes.length; i++) {
    let t = paramTypes[i];
    if (t.tag == 'ambig_int') t = INT;
    else if (t.tag == 'ambig_float') t = F64;
    newParamTypes.push(t);
  }

  let impl = resolveImpl(set.symbols[0], name, newParamTypes, returnType, null);
  if (impl == null) {
    let pos = set.genericCallStack[set.genericCallStack.length - 1];
    if (pos == null) {
      pos = position
    }

    logError(pos, 'no valid implementation for ' + name);
    return null;
  }

  let fnExpr: LeftExpr | null = {
    tag: 'fn',
    unit: impl.unit,
    name: impl.name,
    type: impl.resolvedType,
    mode: impl.mode,
    isGeneric: impl.isGeneric
  };

  fnExpr = resolveLeftExpr(fnExpr, set, genericMap, position);
  if (fnExpr == null) return null;

  if (impl.resolvedType.tag != 'fn') {
    compilerError('should always be fn');
    return null;
  }

  return {
    tag: 'fn_call',
    val: {
      fn: fnExpr,
      exprs,
      position: { start: 0, end: 0, line: 0, document: '' }
    }, 
    type: impl.resolvedType.returnType 
  };
}

function resolveExpr(
  expr: Expr,
  set: FnSet,
  genericMap: Map<string, Type>,
  position: Position
): Expr | null {
  if (expr.tag == 'bin') {
    let left = resolveExpr(expr.val.left, set, genericMap, position);
    let right = resolveExpr(expr.val.right, set, genericMap, position);
    if (left == null || right == null) return null;

    if ((expr.val.op == '==' || expr.val.op == '!=') && expr.val.left.type.tag == 'ptr') {
      if (expr.val.right.tag == 'nil_const') {
        return { tag: 'bin', val: { op: expr.val.op, left, right }, type: BOOL };
      }
    }

    if ((expr.val.op == '==' || expr.val.op == '!=') && !isBasic(expr.val.left.type) && expr.val.left.type.tag != 'ambig_int' && expr.val.left.type.tag != 'ambig_float') {
      let impl = implToExpr(set, 'eq', [left.type, right.type], BOOL, genericMap, [left, right], position);
      if (impl == null) return null;
      if (expr.val.op == '!=') return { tag: 'not', val: impl, type: BOOL };
      return impl;
    }

    return { tag: 'bin', val: { op: expr.val.op, left, right }, type: BOOL };
  }
  else if (expr.tag == 'is') {
    let left = resolveLeftExpr(expr.left, set, genericMap, position);
    if (left == null) return null;
    return { tag: 'is', left, variant: expr.variant, variantIndex: expr.variantIndex, type: expr.type };
  }
  else if (expr.tag == 'not' || expr.tag == 'try' || expr.tag == 'assert' || expr.tag == 'cast') {
    let inner = resolveExpr(expr.val, set, genericMap, position);
    let type = applyGenericMap(expr.type, genericMap);
    if (inner == null) return null;
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
  else if (expr.tag == 'macro_call') {
    let args: MacroArg[] = [];
    for (let arg of expr.val.args) {
      if (arg.tag == 'type') {
        let t = applyGenericMap(arg.val, genericMap);
        args.push({ tag: 'type', val: t });
      }
      else if (arg.tag == 'expr') {
        let argExpr = resolveExpr(arg.val, set, genericMap, position);
        if (argExpr == null) return null;
        args.push({ tag: 'expr', val: argExpr });
      }
    }

    let returnType = applyGenericMap(expr.type, genericMap);
    return { tag: 'macro_call', val: { name: expr.val.name, args }, type: returnType };
  }
  else if (expr.tag == 'fn_call') {
    let exprs: Expr[] = [];
    for (let param of expr.val.exprs) {
      let expr = resolveExpr(param, set, genericMap, position);
      if (expr == null) return null;
      exprs.push(expr);
    }

    let genericCall = expr.val.fn.tag == 'fn' && expr.val.fn.isGeneric && !isGeneric(expr.val.fn.type);
    if (genericCall) set.genericCallStack.push(expr.val.position);
    let fn = resolveLeftExpr(expr.val.fn, set, genericMap, position);
    if (genericCall) set.genericCallStack.pop();

    if (fn == null) return null;

    if (fn.tag == 'fn' && (fn.mode == 'decl' || fn.mode == 'declImpl')) {
      if (fn.type.tag != 'fn') {
        compilerError('should always be fn')
        return null;
      }

      let paramTypes = exprs.map(x => x.type);
      return implToExpr(set, fn.name, paramTypes, fn.type.returnType, genericMap, exprs, position);
    }

    let returnType = applyGenericMap(expr.type, genericMap);
    return { tag: 'fn_call', val: { fn, exprs, position: expr.val.position }, type: returnType };
  }
  else if (expr.tag == 'list_init') {
    let exprs: Expr[] = [];
    for (let e of expr.val) {
      let res = resolveExpr(e, set, genericMap, position);
      if (res == null) return null;
      exprs.push(res);
    }

    if (expr.type.tag != 'struct') {
      compilerError('expected list');
      return null;
    }

    // list init needs alloc to be available
    let allocExpr: LeftExpr = {
      tag: 'fn',
      type: { tag: 'fn', paramTypes: [INT], returnType: getFields(expr.type)[0].type },
      name: 'alloc',
      unit: 'std/core',
      mode: 'fn',
      isGeneric: false
    }
    resolveLeftExpr(
      allocExpr,
      set,
      genericMap,
      position
    );

    let type = applyGenericMap(expr.type, genericMap);
    return { tag: 'list_init', val: exprs, type: type }
  }
  else if (expr.tag == 'struct_init') {
    let inits = [];
    for (let init of expr.val) {
      let initExpr = resolveExpr(init.expr, set, genericMap, position);
      if (initExpr == null) return null;
      inits.push({ name: init.name, expr: initExpr });
    }

    let type = applyGenericMap(expr.type, genericMap);
    return { tag: 'struct_init', val: inits, type: type }
  }
  else if (expr.tag == 'struct_zero') {
    let type = applyGenericMap(expr.type, genericMap);
    return { tag: 'struct_zero', type };
  }
  else if (expr.tag == 'enum_init') {
    let type = applyGenericMap(expr.type, genericMap);
    if (expr.fieldExpr != null) {
      let fieldExpr = resolveExpr(expr.fieldExpr, set, genericMap, position);
      return { tag: 'enum_init', fieldName: expr.fieldName, variantIndex: expr.variantIndex, fieldExpr, type };
    }
    return { tag: 'enum_init', fieldName: expr.fieldName, variantIndex: expr.variantIndex, fieldExpr: null, type };
  }
  else if (expr.tag == 'left_expr') {
    if (expr.val.tag == 'dot') {
      let left = expr.val.val.left;
      let name = expr.val.val.varName;
      let field = set.fieldStack[set.fieldStack.length - 1];

      if (left.tag == 'left_expr' && left.val.tag == 'var' && left.val.mode == 'field_iter') {
        if (name == 'name') {
          return { tag: 'str_const', val: field.currentFieldName, type: STR };
        }
        else if (name == 'val') {
          return {
            tag: 'left_expr',
            val: {
              tag: 'dot',
              val: {
                varName: field.currentFieldName,
                left: field.currentFieldExpr
              },
              type: field.currentFieldType 
            },
            type: field.currentFieldType 
          };
        }
      }
    }

    let val = resolveLeftExpr(expr.val, set, genericMap, position);
    if (val == null) return null;
    return { tag: 'left_expr', val, type: val.type };
  }
  else if (expr.tag == 'fmt_str') {
    let resolvedExprs: Expr[] = [];
    for (let innerExpr of expr.val) {
      let resolvedExpr = resolveExpr(innerExpr, set, genericMap, position);
      if (resolvedExpr == null) return null;
      let impl = implToExpr(set, 'format', [FMT, resolvedExpr.type], null, genericMap, [undefined!, resolvedExpr], position);
      if (impl == null) return null;
      resolvedExprs.push(impl);
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
    let val = resolveLeftExpr(expr.val, set, genericMap, position);
    if (val == null) return null;
    if (expr.type.tag != 'ptr') { compilerError('expected pointer'); return null; }
    return { tag: 'ptr', val, type: { tag: 'ptr', val: val.type, const: expr.type.const } };
  }

  compilerError('resolveExpr unreachable');
  return undefined!;
}

function resolveLeftExpr(
  leftExpr: LeftExpr,
  set: FnSet,
  genericMap: Map<string, Type>,
  position: Position
): LeftExpr | null {
  if (leftExpr.tag == 'dot') {
    let resolvedLeft = resolveExpr(leftExpr.val.left, set, genericMap, position);
    if (resolvedLeft == null) return null;
    let type = applyGenericMap(leftExpr.type, genericMap);
    return { tag: 'dot', val: { left: resolvedLeft, varName: leftExpr.val.varName }, type };
  }
  else if (leftExpr.tag == 'index') {
    let index = resolveExpr(leftExpr.val.index, set, genericMap, position);
    let v = resolveExpr(leftExpr.val.var, set, genericMap, position);
    if (index == null || v == null) return null;

    if (leftExpr.val.var.type.tag != 'ptr') {
      let inner = implToExpr(set, 'index', [v.type, index.type], null, genericMap, [v, index], position);
      if (inner == null) return null;
      if (inner.type.tag != 'ptr') {
        compilerError('should always be pointer');
        return null;
      }

      return {
        tag: 'index',
        val: {
          var: inner,
          index: { tag: 'int_const', val: 0, type: INT }
        },
        type: inner.type.val
      }
    }

    let type = applyGenericMap(leftExpr.type, genericMap);
    return { tag: 'index', val: { var: v, index }, type };
  }
  else if (leftExpr.tag == 'var') {
    let type = applyGenericMap(leftExpr.type, genericMap);
    return { tag: 'var', val: leftExpr.val, mode: leftExpr.mode, type, unit: leftExpr.unit };
  }
  else if (leftExpr.tag == 'fn') {
    let shouldResolve = shouldResolveFn(set, leftExpr.name, leftExpr.unit, leftExpr.mode, leftExpr.type);
    let thisFnType = applyGenericMap(leftExpr.type, genericMap);

    let fnType: Type;
    if (shouldResolve) {
      let genericFn = getFnTemplate(set, leftExpr.name, leftExpr.unit, leftExpr.mode, leftExpr.type);
      let genericType: Type = { tag: 'fn', paramTypes: genericFn.header.paramTypes, returnType: genericFn.header.returnType };
      let newFnGenericMap: Map<string, Type> = new Map();

      if (!typeApplicableStateful(thisFnType, genericType, newFnGenericMap, true)) {
        compilerError('fn should be applicable ' + leftExpr.name);
      }

      let implType = applyGenericMap(genericType, newFnGenericMap);
      fnType = implType;

      if (implType.tag != 'fn') {
        compilerError('type should be fn');
        return undefined!;
      }

      // prevent reuse of recursive functions
      let keyProps: FnKey = {
        name: leftExpr.name,
        unit: leftExpr.unit,
        type: getTypeKey({ tag: 'fn', returnType: implType.returnType, paramTypes: implType.paramTypes }) ,
        mode: leftExpr.mode
      };

      let key = JSON.stringify(keyProps);
      if (!set.used.has(key) && leftExpr.mode != 'decl') {
        set.used.add(key)
        monomorphizeFn(genericFn, set, newFnGenericMap);
      }
    }
    else {
      fnType = leftExpr.type
    }

    let newLeftExpr: LeftExpr = {
      tag: 'fn',
      type: fnType,
      name: leftExpr.name,
      unit: leftExpr.unit,
      mode: leftExpr.mode,
      isGeneric: leftExpr.isGeneric
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
    let typeKey = getTypeKey(type);
    if (alreadyGenned.has(typeKey)) return;
    typeTreeRecur(type.returnType, inStack, alreadyGenned, output, queue);
    for (let i = 0; i < type.paramTypes.length; i++) {
      typeTreeRecur(type.paramTypes[i], inStack, alreadyGenned, output, queue);
    }
    alreadyGenned.add(typeKey);
    output.push(type);
  }

  if (type.tag == 'ptr' || type.tag == 'link') {
    let typeKey = getTypeKey(type.val);
    if (alreadyGenned.has(typeKey)) return;
    queue.push(type.val);
  }

  if (type.tag != 'struct') {
    return;
  }

  let typeKey = getTypeKey(type);
  if (inStack.has(typeKey)) {
    compilerError('recusive struct ' + typeKey);
    return;
  }
  if (alreadyGenned.has(typeKey)) return;
  alreadyGenned.add(typeKey);

  let fields = getFields(type);
  inStack.add(typeKey);
  for (let field of fields) {
    typeTreeRecur(field.type, inStack, alreadyGenned, output, queue);
  }
  inStack.delete(typeKey);

  let fieldTypes: Type[] = [];
  let fieldNames: string[] = [];
  for (let field of fields) {
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

