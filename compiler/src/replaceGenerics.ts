import { FnMode } from './parse';
import { FnImpl, Inst, Expr, LeftExpr, Program as AnalyzeProgram, GlobalImpl, MacroArg, CondBody } from './analyze';
import { compilerError, Position, logError } from './util';
import {
  Type, getTypeKey, applyGenericMap, resolveImpl, BOOL, typeApplicable,
  NIL, typeApplicableStateful, RANGE, isBasic, UnitSymbols, INT, FMT, STR,
  F64, getFields, isGeneric, toStr, Fn, typeEq, applyConstMap
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
  currentFieldAlias: string,
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

  // used so index can determine if it needs to verify
  inAssign: boolean[]
}

function replaceGenerics(prog: AnalyzeProgram, symbols: UnitSymbols[], mainFn: FnImpl): Program {
  let fnSet: FnSet = {
    fnTemplates: new Map(),
    types: new Map(),
    fns: new Map(),
    used: new Set(),
    symbols,
    fieldStack: [],
    genericCallStack: [],
    inAssign: [false]
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

  let entry = monomorphizeFn(mainFn, fnSet, new Map(), new Map());
  let orderedTypes = orderTypes(Array.from(fnSet.types.values()));

  let fns = Array.from(fnSet.fns.values());
  return {
    orderedTypes,
    fns,
    globals: prog.globals,
    entry
  };
}

/*
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
*/

function getFnImpl(
  set: FnSet,
  reference: Fn
): FnImpl | null {
  let fnList: FnImpl[] | undefined = set.fnTemplates.get(reference.name);
  if (fnList == undefined) return null;

  for (let i = 0; i < fnList.length; i++) {
    if (fnList[i].header == reference) return fnList[i];
  }
  
  return null;
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
  constMap: Map<string, string>
): FnImpl {
  let paramTypes: Type[] = [];
  for (let param of genericFn.header.paramTypes) {
    let newParam = applyGenericMap(param, genericMap);
    newParam = applyConstMap(newParam, constMap);
    addType(set, newParam);
    paramTypes.push(newParam);
  }
  let returnType = applyGenericMap(genericFn.header.returnType, genericMap);
  returnType = applyConstMap(returnType, constMap);
  addType(set, returnType);

  set.inAssign.push(false);
  let body = resolveInstBody(genericFn.body, set, genericMap, constMap);
  set.inAssign.pop();
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
  constMap: Map<string, string>,
): Inst[] {
  let resolvedBody: Inst[] = [];
  for (let inst of body) {
    let resolvedInst = resolveInst(inst, set, genericMap, constMap);
    if (resolvedInst == null) continue;
    resolvedBody.push(...resolvedInst);
  }
  return resolvedBody;
}

function resolveInst(
  inst: Inst,
  set: FnSet,
  genericMap: Map<string, Type>,
  constMap: Map<string, string>,
): Inst[] | null {
  if (inst.tag == 'if' || inst.tag == 'elif' || inst.tag == 'while') {
    let cond = resolveExpr(inst.val.cond, set, genericMap, constMap, inst.position);
    let body = resolveInstBody(inst.val.body, set, genericMap, constMap);
    if (cond == null) return null;
    return [{ tag: inst.tag, val: { cond, body }, position: inst.position }];
  }
  else if (inst.tag == 'else') {
    let body = resolveInstBody(inst.val, set, genericMap, constMap);
    return [{ tag: 'else', val: body, position: inst.position }];
  }
  else if (inst.tag == 'defer') {
    let body = resolveInstBody(inst.val, set, genericMap, constMap);
    return [{ tag: 'defer', val: body, position: inst.position }];
  }
  else if (inst.tag == 'for_in') {
    let iter = resolveExpr(inst.val.iter, set, genericMap, constMap, inst.position);
    if (iter == null) return null;
    if (inst.val.varName == 'field') {
      let output: Inst[] = [];
      let iterType: Type = iter.type;
      if (iter.type.tag == 'link') iterType = iter.type.val;

      if (iterType.tag == 'struct') {
        let fields = getFields(iterType);
        for (let i = 0; i < fields.length; i++) {
          let alias = fields[i].name;
          if (iterType.tag == 'struct' 
            && iterType.val.template.name == 'TypeUnion' 
            && iterType.val.template.unit == 'std/core') {
            alias = toStr(fields[i].type);
          }

          set.fieldStack.push({
            currentFieldAlias: alias,
            currentFieldName: fields[i].name,
            currentFieldType: fields[i].type,
            currentFieldExpr: iter,
          })
          genericMap.set('val', fields[i].type);

          let body = resolveInstBody(inst.val.body, set, genericMap, constMap);
          if (iterType.val.template.structMode == 'enum' && iter.tag == 'left_expr') {
            let cond: CondBody = {
              cond: { tag: 'is', left: iter.val, type: BOOL, variant: fields[i].name, variantIndex: i },
              body
            };

            let ifStmt: Inst = { tag: 'if', val: cond, position: inst.position };
            output.push(ifStmt);
          }
          else {
            output.push(...body);
          }
          set.fieldStack.pop();
        }
      }
      return output;
    }

    let body = resolveInstBody(inst.val.body, set, genericMap, constMap);
    let nf = inst.val.nextFn!;
    let nfType = inst.val.nextFnType!;

    let nextFn: LeftExpr = {
      tag: 'fn',
      unit: nf.unit,
      name: nf.name,
      mode: nf.mode,
      fnReference: nf,
      isGeneric: true,
      genericMap: new Map(),
      type: nfType
    };

    addType(set, RANGE); 
    let resolvedFn = resolveLeftExpr(nextFn, set, genericMap, constMap, inst.position);
    if (resolvedFn == null) return null;

    return [{ tag: 'for_in', val: { varName: inst.val.varName, body, iter, nextFn: inst.val.nextFn, nextFnType: nfType }, position: inst.position }];
  }
  else if (inst.tag == 'return') {
    if (inst.val != null) {
      return [{ tag: 'return', val: resolveExpr(inst.val, set, genericMap, constMap, inst.position), position: inst.position }];
    }
    return [inst];
  }
  else if (inst.tag == 'expr') {
    let val = resolveExpr(inst.val, set, genericMap, constMap, inst.position);
    if (val == null) return null;
    return [{ tag: 'expr', val, position: inst.position }];
  }
  else if (inst.tag == 'break' || inst.tag == 'continue') {
    return [inst];
  }
  else if (inst.tag == 'declare') {
    let type = applyGenericMap(inst.val.type, genericMap);
    type = applyConstMap(type, constMap);
    addType(set, type);
    let expr = resolveExpr(inst.val.expr, set, genericMap, constMap, inst.position);
    if (expr == null) return null;
    return [{ tag: 'declare', val: { type, name: inst.val.name, expr }, position: inst.position }]
  }
  else if (inst.tag == 'assign') {
    set.inAssign.push(true);
    let to = resolveLeftExpr(inst.val.to, set, genericMap, constMap, inst.position);
    set.inAssign.pop();
    let expr = resolveExpr(inst.val.expr, set, genericMap, constMap, inst.position);
    if (to == null || expr == null) return null;

    if (inst.val.op == '++=') {
      let toExpr: Expr = { tag: 'left_expr', val: to, type: to.type };
      if (to.type.tag == 'struct' && to.type.val.template.name == 'Fmt' && to.type.val.template.unit == 'std/core') {
        let impl = implToExpr(set, 'format', [to.type, expr.type], NIL, genericMap, [toExpr, expr], inst.position);
        if (impl == null) {
          compilerError('fmt should be implemented');
          return [];
        } 
        return [{ tag: 'expr', val: impl, position: inst.position }];
      }
    }

    return [{ tag: 'assign', val: { op: inst.val.op, to, expr }, position: inst.position }];
  }
  else if (inst.tag == 'include') {
    let newTypes: Type[] = [];
    for (let type of inst.val.types) {
      let newType = applyGenericMap(type, genericMap);
      newType = applyConstMap(newType, constMap);
      newTypes.push(newType);
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
  position: Position | null,
): Expr | null {
  let newParamTypes: Type[] = [];
  for (let i = 0; i < paramTypes.length; i++) {
    let t = paramTypes[i];
    if (t.tag == 'ambig_int') t = INT;
    else if (t.tag == 'ambig_float') t = F64;
    else if (t.tag == 'ambig_nil') t = NIL;
    newParamTypes.push(t);
  }

  let impl = resolveImpl(set.symbols[0], name, newParamTypes, returnType, null);
  if (impl == null) {
    if (position != null) {
      let pos = set.genericCallStack[set.genericCallStack.length - 1];
      if (pos == null) pos = position
      // to log the proper error
      resolveImpl(set.symbols[0], name, newParamTypes, returnType, pos);
    }

    return null;
  }

  let fnExpr: LeftExpr | null = {
    tag: 'fn',
    unit: impl.unit,
    name: impl.name,
    type: impl.resolvedType,
    mode: impl.mode,
    genericMap: impl.genericMap,
    fnReference: impl.fnReference,
    isGeneric: impl.isGeneric
  };

  fnExpr = resolveLeftExpr(fnExpr, set, genericMap, new Map(), position);
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
  constMap: Map<string, string>,
  position: Position | null
): Expr | null {
  if (expr.tag == 'bin') {
    let left = resolveExpr(expr.val.left, set, genericMap, constMap, position);
    let right = resolveExpr(expr.val.right, set, genericMap, constMap, position);
    if (left == null || right == null) return null;

    let op = expr.val.op;
    if ((op == '==' || op == '!=') && expr.val.left.type.tag == 'ptr') {
      if (expr.val.right.tag == 'nil_const') {
        return { tag: 'bin', val: { op: expr.val.op, left, right }, type: BOOL };
      }
    }

    if ((op == '==' || op == '!=') && !isBasic(expr.val.left.type) && expr.val.left.type.tag != 'ambig_int' && expr.val.left.type.tag != 'ambig_float') {
      let impl = implToExpr(set, 'eq', [left.type, right.type], BOOL, genericMap, [left, right], position);
      if (impl == null) return null;
      if (expr.val.op == '!=') return { tag: 'not', val: impl, type: BOOL };
      return impl;
    }

    if ((op == '>=' || op == '<=' || op == '>' || op == '<') && !isBasic(expr.val.left.type) && expr.val.left.type.tag != 'ambig_int' && expr.val.left.type.tag != 'ambig_float') {
      let impl = implToExpr(set, 'cmp', [left.type, right.type], INT, genericMap, [left, right], position);
      if (impl == null) return null;

      return { tag: 'bin', val: { op, left: impl, right: { tag: 'int_const', val: '0', type: INT }}, type: BOOL };
    }

    return { tag: 'bin', val: { op: expr.val.op, left, right }, type: expr.type };
  }
  else if (expr.tag == 'is') {
    let left = resolveLeftExpr(expr.left, set, genericMap, constMap, position);
    if (left == null) return null;
    return { tag: 'is', left, variant: expr.variant, variantIndex: expr.variantIndex, type: expr.type };
  }
  else if (expr.tag == 'not' || expr.tag == 'try' || expr.tag == 'assert' || expr.tag == 'cast') {
    let inner = resolveExpr(expr.val, set, genericMap, constMap, position);
    let type = applyGenericMap(expr.type, genericMap);
    type = applyConstMap(type, constMap);

    if (inner == null) return null;
    if (expr.tag == 'not') {
      return { tag: expr.tag, val: inner, type };
    }
    else if (expr.tag == 'cast') {
      addType(set, type);
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
        t = applyConstMap(t, constMap);
        args.push({ tag: 'type', val: t });
      }
      else if (arg.tag == 'expr') {
        let argExpr = resolveExpr(arg.val, set, genericMap, constMap, position);
        if (argExpr == null) return null;
        args.push({ tag: 'expr', val: argExpr });
      }
    }

    let returnType = applyGenericMap(expr.type, genericMap);
    returnType = applyConstMap(returnType, constMap);
    return { tag: 'macro_call', val: { name: expr.val.name, args }, type: returnType };
  }
  else if (expr.tag == 'fn_call') {
    let exprs: Expr[] = [];
    for (let param of expr.val.exprs) {
      let expr = resolveExpr(param, set, genericMap, constMap, position);
      if (expr == null) return null;
      exprs.push(expr);
    }

    let genericCall = expr.val.fn.tag == 'fn' && expr.val.fn.isGeneric && !isGeneric(expr.val.fn.type);
    if (genericCall) set.genericCallStack.push(expr.val.position);
    let fn = resolveLeftExpr(expr.val.fn, set, genericMap, constMap, position);
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
    returnType = applyConstMap(returnType, constMap);
    return { tag: 'fn_call', val: { fn, exprs, position: expr.val.position }, type: returnType };
  }
  else if (expr.tag == 'list_init') {
    let exprs: Expr[] = [];
    for (let e of expr.val) {
      let res = resolveExpr(e, set, genericMap, constMap, position);
      if (res == null) return null;
      exprs.push(res);
    }

    if (expr.type.tag != 'struct') {
      compilerError('expected list');
      return null;
    }

    let type = applyGenericMap(expr.type, genericMap);
    type = applyConstMap(type, constMap);

    // list init needs alloc to be available
    let allocRef: Fn = set.fnTemplates.get('alloc')!.find(x => x.header.paramTypes.length == 1 && x.header.unit == 'std/core')!.header;
    let allocMap = new Map();

    allocMap.set('T', type);
    let allocExpr: LeftExpr = {
      tag: 'fn',
      type: { tag: 'fn', paramTypes: [INT], returnType: { tag: 'ptr', val: expr.type.val.generics[0], const: false } },
      name: 'alloc',
      unit: 'std/core',
      mode: 'fn',
      genericMap: allocMap,
      fnReference: allocRef,
      isGeneric: false
    }
    resolveLeftExpr(
      allocExpr,
      set,
      allocMap,
      constMap,
      position
    );

    return { tag: 'list_init', val: exprs, type: type }
  }
  else if (expr.tag == 'struct_init') {
    let inits = [];
    for (let init of expr.val) {
      let initExpr = resolveExpr(init.expr, set, genericMap, constMap, position);
      if (initExpr == null) return null;
      inits.push({ name: init.name, expr: initExpr });
    }

    let type = applyGenericMap(expr.type, genericMap);
    type = applyConstMap(type, constMap);
    return { tag: 'struct_init', val: inits, type: type }
  }
  else if (expr.tag == 'struct_zero') {
    let type = applyGenericMap(expr.type, genericMap);
    type = applyConstMap(type, constMap);
    return { tag: 'struct_zero', type };
  }
  else if (expr.tag == 'enum_init') {
    let type = applyGenericMap(expr.type, genericMap);
    type = applyConstMap(type, constMap);
    if (expr.fieldExpr != null) {
      let fieldExpr = resolveExpr(expr.fieldExpr, set, genericMap, constMap, position);
      return { tag: 'enum_init', fieldName: expr.fieldName, variantIndex: expr.variantIndex, fieldExpr, type };
    }
    return { tag: 'enum_init', fieldName: expr.fieldName, variantIndex: expr.variantIndex, fieldExpr: null, type };
  }
  else if (expr.tag == 'left_expr') {
    if (expr.val.tag == 'var') {
      if (expr.val.mode == 'generic_const') {
        return { tag: 'int_const', val: constMap.get(expr.val.val)!, type: INT };
      }
    }

    if (expr.val.tag == 'dot') {
      let left = expr.val.val.left;
      let name = expr.val.val.varName;

      if (left.type.tag == 'struct' 
        && left.type.val.template.name == 'vec' 
        && left.type.val.template.unit == 'std/core'
      ) {
        return { tag: 'int_const', val: left.type.val.constFields[0], type: INT };
      }

      let field = set.fieldStack[set.fieldStack.length - 1];

      if (left.tag == 'left_expr' && left.val.tag == 'var' && left.val.mode == 'field_iter') {
        if (name == 'name') {
          return { tag: 'str_const', val: field.currentFieldAlias, type: STR };
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

    let val = resolveLeftExpr(expr.val, set, genericMap, constMap, position);
    if (val == null) return null;
    return { tag: 'left_expr', val, type: val.type };
  }
  else if (expr.tag == 'fmt_str') {
    let resolvedExprs: Expr[] = [];
    for (let innerExpr of expr.val) {
      let resolvedExpr = resolveExpr(innerExpr, set, genericMap, constMap, position);
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
    let val = resolveLeftExpr(expr.val, set, genericMap, constMap, position);
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
  constMap: Map<string, string>,
  position: Position | null
): LeftExpr | null {
  if (leftExpr.tag == 'fn') {
    let thisFnType = applyGenericMap(leftExpr.type, genericMap);
    thisFnType = applyConstMap(thisFnType, constMap);

    if (thisFnType.tag != 'fn') {
      compilerError('type should be fn');
      return undefined!;
    }

    let fnTemplateType: Type = {
      tag: 'fn',
      paramTypes: leftExpr.fnReference.paramTypes,
      returnType: leftExpr.fnReference.returnType
    }

    let newGenericMap = new Map();
    let newConstMap = new Map();
    typeApplicableStateful(thisFnType, fnTemplateType, newGenericMap, newConstMap, true, false);

    // prevent reuse of recursive functions
    let keyProps: FnKey = {
      name: leftExpr.name,
      unit: leftExpr.unit,
      type: getTypeKey({ tag: 'fn', returnType: thisFnType.returnType, paramTypes: thisFnType.paramTypes }) ,
      mode: leftExpr.mode
    };

    let key = JSON.stringify(keyProps);
    if (!set.used.has(key) && leftExpr.mode != 'decl') {
      set.used.add(key)
      let impl = getFnImpl(set, leftExpr.fnReference);
      if (impl != null) {
        monomorphizeFn(impl, set, newGenericMap, newConstMap);
      }
    }

    let newLeftExpr: LeftExpr = {
      tag: 'fn',
      type: thisFnType,
      name: leftExpr.name,
      unit: leftExpr.unit,
      mode: leftExpr.mode,
      fnReference: leftExpr.fnReference,
      genericMap: newGenericMap,
      isGeneric: leftExpr.isGeneric
    };

    return newLeftExpr;
  }
  else if (leftExpr.tag == 'dot') {
    let resolvedLeft = resolveExpr(leftExpr.val.left, set, genericMap, constMap, position);
    if (resolvedLeft == null) return null;
    let type = applyGenericMap(leftExpr.type, genericMap);
    type = applyConstMap(type, constMap);
    return { tag: 'dot', val: { left: resolvedLeft, varName: leftExpr.val.varName }, type };
  }
  else if (leftExpr.tag == 'index') {
    let index = resolveExpr(leftExpr.val.index, set, genericMap, constMap, position);
    let v = resolveExpr(leftExpr.val.var, set, genericMap, constMap, position);
    if (index == null || v == null) return null;

    let leftType = leftExpr.val.var.type;
    if (leftType.tag == 'ptr') {
      let type = applyGenericMap(leftExpr.type, genericMap);
      type = applyConstMap(type, constMap);
      return { tag: 'index', val: { var: v, index, const: leftType.const, verifyFn: null, verifyFnType: null, implReturnsPointer: true }, type };
    }

    if (leftType.tag == 'struct'
      && leftType.val.template.name == 'vec'
      && leftType.val.template.unit == 'std/core'
      && typeApplicable(index.type, INT, false)
    ) {
      let type = applyGenericMap(leftExpr.type, genericMap);
      type = applyConstMap(type, constMap);
      return { tag: 'index', val: { var: v, index, const: false, verifyFn: null, verifyFnType: null, implReturnsPointer: false }, type };
    }

    // inner is the fnCall expr for index
    let inner = implToExpr(set, 'index', [v.type, index.type], null, genericMap, [v, index], position);
    if (inner == null) return null;
    let verifyFn = null;
    let verifyFnType: Type | null = null;
    if (set.inAssign[set.inAssign.length - 1] == true && inner.tag == 'fn_call' && inner.val.fn.type.tag == 'fn') {
      let fnType = inner.val.fn.type;
      let verifyImpl = resolveImpl(set.symbols[0], 'verifyIndex', [v.type, fnType.returnType], null, null);
      if (verifyImpl != null) {
        verifyFn = verifyImpl.fnReference;
        let verifyLeftExpr: LeftExpr = {
          tag: 'fn',
          isGeneric: verifyImpl.isGeneric,
          fnReference: verifyImpl.fnReference,
          genericMap: verifyImpl.genericMap,
          type: verifyImpl.resolvedType,
          name: verifyImpl.name,
          unit: verifyImpl.unit,
          mode: verifyImpl.mode
        };
        let leftExpr = resolveLeftExpr(verifyLeftExpr, set, verifyImpl.genericMap, constMap, position);
        if (leftExpr != null) {
          verifyFnType = leftExpr.type;
        }
      }
    }

    if (leftExpr.val.implReturnsPointer == false || inner.type.tag != 'ptr') {
      return {
        tag: 'index',
        val: {
          var: inner,
          index: { tag: 'int_const', val: '0', type: INT },
          const: leftExpr.val.const,
          verifyFn,
          verifyFnType,
          implReturnsPointer: false
        },
        type: inner.type
      }
    }

    return {
      tag: 'index',
      val: {
        var: inner,
        index: { tag: 'int_const', val: '0', type: INT },
        const: leftExpr.val.const,
        verifyFn,
        verifyFnType,
        implReturnsPointer: true
      },
      type: inner.type.val
    }

  }
  else if (leftExpr.tag == 'var') {
    let type = applyGenericMap(leftExpr.type, genericMap);
    type = applyConstMap(type, constMap);
    return { tag: 'var', val: leftExpr.val, mode: leftExpr.mode, type, unit: leftExpr.unit };
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

