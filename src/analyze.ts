import * as Parse from './parse';
import { logError, logMultiError, compilerError, Position } from './util'
import {
  Type, Fn, UnitSymbols, resolveType, typeApplicable,
  NIL, INT, BOOL, resolveFnOrDecl, FnResult, toStr,
  isBasic, basic, getFieldIndex, STR, F32, F64, CHAR, createVec,
  RANGE, resolveImpl, refType, typeEq, createTypeUnion,
  getIsolatedUnitSymbolsFromName, getIsolatedUnitSymbolsFromAs,
  getUnitSymbolsFromName, getUnitSymbolsFromAs, Global, resolveGlobal,
  resolveMacro, AMBIG_INT, AMBIG_FLOAT, getFields, lookupFnOrDecl,
  getFoundFns, getExpectedFns, getCurrentFn
} from './typeload'
import * as Enum from './enum';

export {
  analyze, newScope, ensureExprValid, FnContext, Program, Fn, Inst,
  StructInitField, FnCall, Expr, LeftExpr, Mode, FnImpl, GlobalImpl,
  MacroArg
}

interface FnImpl {
  header: Fn,
  body: Inst[]
}

interface GlobalImpl {
  header: Global,
  expr: Expr
  position: Position
}

interface Program {
  fns: FnImpl[]
  globals: GlobalImpl[]
}

interface CondBody {
  cond: Expr
  body: Inst[]
}

interface Declare {
  name: string
  expr: Expr
  type: Type
}

interface Assign {
  op: string
  to: LeftExpr,
  expr: Expr
}

interface ForIn {
  varName: string,
  iter: Expr
  body: Inst[]
  nextFn: Fn | null
}

interface Include {
  lines: string[],
  types: Type[]
}

type Inst = { tag: 'if', val: CondBody, position: Position }
  | { tag: 'elif', val: CondBody, position: Position }
  | { tag: 'while', val: CondBody, position: Position }
  | { tag: 'for_in', val: ForIn, position: Position }
  | { tag: 'expr', val: Expr, position: Position }
  | { tag: 'else', val: Inst[], position: Position }
  | { tag: 'return', val: Expr | null, position: Position }
  | { tag: 'break', position: Position }
  | { tag: 'continue', position: Position }
  | { tag: 'declare', val: Declare, position: Position }
  | { tag: 'assign', val: Assign, position: Position }
  | { tag: 'include', val: Include, position: Position }

interface FnCall {
  fn: LeftExpr
  exprs: Expr[],
  position: Position
}

interface StructInitField {
  name: string
  expr: Expr
}

type MacroArg = { tag: 'type', val: Type }
  | { tag: 'expr', val: Expr };

interface MacroCall {
  name: string,
  args: MacroArg[]
}

interface BinExpr {
  left: Expr
  right: Expr
  op: string
}

type Expr = { tag: 'bin', val: BinExpr, type: Type }
  | { tag: 'is', left: LeftExpr, variant: string, variantIndex: number, type: Type }
  | { tag: 'not', val: Expr, type: Type }
  | { tag: 'try', val: Expr, type: Type }
  | { tag: 'assert', val: Expr, type: Type }
  | { tag: 'fn_call', val: FnCall, type: Type }
  | { tag: 'macro_call', val: MacroCall, type: Type }
  | { tag: 'struct_init', val: StructInitField[], type: Type }
  | { tag: 'struct_zero', type: Type }
  | { tag: 'list_init', val: Expr[], type: Type }
  | { tag: 'enum_init', fieldName: string, variantIndex: number, fieldExpr: Expr | null, type: Type }
  | { tag: 'cast', val: Expr, type: Type }
  | { tag: 'str_const', val: string, type: Type }
  | { tag: 'fmt_str', val: Expr[], type: Type }
  | { tag: 'char_const', val: string, type: Type }
  | { tag: 'int_const', val: number, type: Type }
  | { tag: 'nil_const', type: Type }
  | { tag: 'bool_const', val: boolean, type: Type }
  | { tag: 'num_const', val: number, type: Type }
  | { tag: 'left_expr', val: LeftExpr, type: Type }
  | { tag: 'ptr', val: LeftExpr, type: Type }

interface DotOp {
  left: Expr
  varName: string
}

interface Index {
  var: Expr
  index: Expr
}

type Mode = 'C' | 'global' | 'none' | 'iter' | 'link' | 'field_iter'; 

type LeftExpr = { tag: 'dot', val: DotOp, type: Type }
  | { tag: 'index', val: Index, type: Type }
  | { tag: 'var', val: string, mode: Mode, unit: string | null, type: Type }
  | { tag: 'fn', unit: string, name: string, type: Type, mode: Parse.FnMode, isGeneric: boolean }

function analyze(
  units: Parse.ProgramUnit[],
  symbols: UnitSymbols[]
): Program | null {

  let validProgram: Program | null = {
    fns: [],
    globals: []
  };

  for (let i = 0; i < units.length; i++) {
    let unitFns: FnImpl[] | null = null;
    let unitGlobals: GlobalImpl[] | null = null;
    if (validProgram != null) {
      unitGlobals = analyzeUnitGlobals(symbols[i], units[i]);
    }

    if (validProgram != null) {
      unitFns = analyzeUnitFns(symbols[i], units[i]); 
    }

    if (unitFns == null || unitGlobals == null) {
      validProgram = null;
    } 
    else if (validProgram != null) {
      validProgram.fns.push(...unitFns);
      validProgram.globals.push(...unitGlobals);
    }
  }

  return validProgram;
}

function analyzeUnitGlobals(symbols: UnitSymbols, unit: Parse.ProgramUnit): GlobalImpl[] | null {
  let nullScope: FnContext = {
    returnType: NIL,
    inLoop: false,
    generics: new Set(),
    typeScope: [],
    variantScope: []
  };

  let output: GlobalImpl[] | null = [];
  for (let global of unit.globals) {
    let header = symbols.globals.get(global.name)!; 
    let type = header.type;
    let expr = ensureExprValid(symbols, global.expr, type, nullScope, global.position);
    if (expr == null) {
      output = null;
      continue;
    }
    if (output != null) {
      output.push({ header, expr, position: global.position });
    }
  }
  return output;
}

function analyzeUnitFns(symbols: UnitSymbols, unit: Parse.ProgramUnit): FnImpl[] | null {
  let fns: FnImpl[] | null = [];
  for (let fn of unit.fns) {
    let generics: Set<string> = new Set();
    for (let i = 0; i < fn.type.paramTypes.length; i++) {
      let paramType = fn.type.paramTypes[i]; 
      addGenerics(paramType, generics);
    }

    let returnType = resolveType(symbols, fn.type.returnType, fn.position);
    if (returnType == null) {
      logError(fn.position, 'could not resolve return type');
      return null;
    }

    let scope = newScope(returnType, generics);

    if (fn.mode == 'macro') continue;
    let validFn = analyzeFn(symbols, fn, scope);
    if (validFn == null) {
      fns = null;
    } 
    else if (fns != null) fns.push(validFn);
  }

  return fns;
}

// recursively add all the generics to the set given the parse type
function addGenerics(paramType: Parse.Type, generics: Set<string>) {
  if (paramType.tag == 'basic' && paramType.val.length == 1) generics.add(paramType.val);
  if (paramType.tag == 'ptr') addGenerics(paramType.val, generics);
  if (paramType.tag == 'link') addGenerics(paramType.val, generics);
  if (paramType.tag == 'generic') {
    for (let generic of paramType.val.generics) addGenerics(generic, generics);
  }
  if (paramType.tag == 'fn') {
    addGenerics(paramType.val.returnType, generics);
    for (let g of paramType.val.paramTypes) addGenerics(g, generics);
  }
}

function analyzeFn(
  symbols: UnitSymbols,
  fn: Parse.Fn,
  scope: FnContext,
): FnImpl | null {

  enterScope(scope);
  let paramTypes: Type[] = [];
  for (let i = 0; i < fn.paramNames.length; i++) {
    let mut = false;
    let resolvedParamType = resolveType(symbols, fn.type.paramTypes[i], fn.position);
    if (resolvedParamType == null) return null;

    setValToScope(scope, fn.paramNames[i], resolvedParamType, mut, resolvedParamType.tag == 'link' ? 'link' : 'none');
    paramTypes.push(resolvedParamType);
  }

  if (allElifFollowIf(fn.body) == false) return null;
  let body = analyzeInstBody(symbols, fn.body, scope);
  if (body == null) return null;

  if (fn.mode != 'decl' && !typeApplicable(NIL, scope.returnType, false) && allPaths(body, 'return') == false) {
    logError(fn.position, 'function does not always return');
    return null;
  }

  let fnList: Fn[] | undefined = symbols.fns.get(fn.name);
  let thisFn: Fn | null = null;
  if (fnList == undefined) return null;
  fnLoop: for (let i = 0; i < fnList.length; i++) {
    if (fnList[i].paramTypes.length != paramTypes.length) continue;
    if (!typeEq(fnList[i].returnType, scope.returnType)) continue;
    for (let j = 0; j < paramTypes.length; j++) {
      if (!typeEq(fnList[i].paramTypes[j], paramTypes[j])) continue fnLoop;
    }
    thisFn = fnList[i];
  }
  if (thisFn == null) {
    compilerError('fn should exist');
    return null;
  }

  return {
    header: thisFn,
    body
  };
}

function allElifFollowIf(body: Parse.Inst[]): boolean {
  for (let i = 0; i < body.length; i++) {
    let inst = body[i];
    let subBody: Parse.Inst[] | null = null;

    // check the condition
    let notFollowsIf = i == 0 || body[i - 1].tag != 'if' && body[i - 1].tag != 'elif';
    if ((inst.tag == 'elif' || inst.tag == 'else') && notFollowsIf) {
      logError(body[i].position, inst.tag + ' does not follow if');
      return false;
    }
    // recusrively enter every other body
    if (inst.tag == 'if' || inst.tag == 'for_in' || inst.tag == 'elif' || inst.tag == 'while') {
      subBody = inst.val.body;
    }
    if (inst.tag == 'else') {
      subBody = inst.val;
    }

    if (subBody != null && allElifFollowIf(subBody) == false) {
      return false;
    }
  }
  return true;
}

function allPaths(body: Inst[], instTag: 'return' | 'continue' | 'break'): boolean {
  let ifGroupings: Inst[][][] = [];
  let currentGroup: Inst[][] = [];
  for (let i = 0; i < body.length; i++) {
    let inst = body[i];
    if (inst.tag == instTag) {
      return true;
    }

    if (inst.tag == 'if') {
      currentGroup = [];
      currentGroup.push(inst.val.body);
    }
    else if (inst.tag == 'elif') {
      currentGroup.push(inst.val.body);
    }
    else if (inst.tag == 'else') {
      currentGroup.push(inst.val);
      ifGroupings.push(currentGroup);
      currentGroup = [];
    } else {
      currentGroup = [];
    }
  }

  for (let i = 0; i < ifGroupings.length; i++) {
    let thisGroupReturns = true;
    for (let j = 0; j < ifGroupings[i].length; j++) {
      if (allPaths(ifGroupings[i][j], instTag) == false) {
        thisGroupReturns = false;
        break;
      } 
    }
    if (thisGroupReturns && ifGroupings[i][ifGroupings.length - 1]) {
      return true;
    }
  }

  return false;
}

function analyzeInstBody(
  symbols: UnitSymbols,
  body: Parse.Inst[],
  scope: FnContext,
): Inst[] | null {
  enterScope(scope);

  let newBody: Inst[] = [];
  let isValid = true;
  for (let i = 0; i < body.length; i++) {
    let tag = body[i].tag;
    let inst;
    if (tag == 'if' || tag == 'while' || tag == 'elif' || tag == 'else') {
      inst = analyzeCond(symbols, body[i], newBody, scope);
    }
    else {
      inst = analyzeInst(symbols, body[i], scope);
    } 

    if (inst == null) {
      isValid = false;
    } 
    else if (newBody != null) newBody.push(inst);
  }

  exitScope(scope);
  if (isValid) {
    return newBody;
  }
  return null;
}

function analyzeCond(
  symbols: UnitSymbols,
  inst: Parse.Inst,
  prevInsts: Inst[], 
  scope: FnContext
): Inst | null {

  let ifChain: Expr[] = [];
  if (inst.tag == 'else' || inst.tag == 'elif') {
    for (let i = prevInsts.length - 1; i >= 0; i--) {
      let prevInst = prevInsts[i];
      if (prevInst.tag == 'if' || prevInst.tag == 'elif') {
        ifChain.push(prevInst.val.cond);
      }
    }
  }

  let cond: Expr | null = null;
  if (inst.tag == 'if' || inst.tag == 'elif' || inst.tag == 'while') {
    cond = ensureExprValid(symbols, inst.val.cond, BOOL, scope, inst.position);
    if (cond == null) {
      return null;
    }
  }

  if (inst.tag == 'while') {
    scope.inLoop = true;
  }

  Enum.enterScope(scope.variantScope);
  Enum.applyCond(scope.variantScope, cond, ifChain);
  let body: Inst[] | null = null;
  if (inst.tag == 'if' || inst.tag == 'elif' || inst.tag == 'while') {
    body = analyzeInstBody(symbols, inst.val.body, scope);
  }
  else if (inst.tag == 'else') {
    body = analyzeInstBody(symbols, inst.val, scope);
  }
  Enum.exitScope(scope.variantScope);

  if (body == null) {
    return null;
  }

  if (allPaths(body, 'return') || allPaths(body, 'continue') || allPaths(body, 'break')) {
    Enum.applyInverseCond(scope.variantScope, cond, ifChain);
  }

  if (inst.tag == 'if' || inst.tag == 'elif' || inst.tag == 'while') {
    return { tag: inst.tag, val: { cond: cond!, body: body }, position: inst.position };
  } else if (inst.tag == 'else') {
    return { tag: 'else', val: body, position: inst.position };
  }

  return null;
}

function analyzeInst(
  symbols: UnitSymbols,
  inst: Parse.Inst,
  scope: FnContext,
): Inst | null {
  if (inst.tag == 'include') {
    let newTypes: Type[] = [];
    for (let type of inst.val.types) {
      let newType: Type | null = resolveType(symbols, type, inst.position);
      if (newType == null) return null;
      newTypes.push(newType);
    }
    return { tag: 'include', val: { lines: inst.val.lines, types: newTypes }, position: inst.position };
  }

  if (inst.tag == 'for_in') {
    let iterExpr = ensureExprValid(symbols, inst.val.iter, null, scope, inst.position);
    if (iterExpr == null) return null;

    let iterType: Type = NIL;
    let nextFn: Fn | null = null;
    if (inst.val.varName != 'field') {
      let fnResult = resolveImpl(symbols, 'next', [refType(iterExpr.type)], null, inst.position);
      if (fnResult == null || fnResult.resolvedType.tag != 'fn') {
        logError(inst.position, 'value is not an iterator');
        return null;
      }
      let returnType = fnResult.resolvedType.returnType;
      if (returnType.tag != 'ptr') {
        logError(inst.position, 'expected pointer in "next"');
        return null;
      }
      iterType = returnType.val;
      nextFn = fnResult.fnReference;
    }

    scope.inLoop = true;
    enterScope(scope);
    setValToScope(scope, inst.val.varName, iterType, false, inst.val.varName == 'field' ? 'field_iter' : 'iter');
    let body = analyzeInstBody(symbols, inst.val.body, scope);
    exitScope(scope);
    if (body == null) return null;

    return {
      tag: 'for_in',
      val: {
        varName: inst.val.varName,
        iter: iterExpr,
        body: body,
        nextFn
      },
      position: inst.position
    };
  }

  if (inst.tag == 'break' || inst.tag == 'continue') {
    if (!scope.inLoop) {
      logError(inst.position, inst.tag + ' must be used in a loop');
      return null;
    }
    return { tag: inst.tag, position: inst.position };
  } 

  if (inst.tag == 'return_void') {
    if (!typeApplicable(scope.returnType, NIL, false)) {
      logError(inst.position, 'returning from non-void fn without expression');
      return null;
    }
    return { tag: 'return', val: null, position: inst.position };
  } 

  if (inst.tag == 'return') {
    let expr = ensureExprValid(symbols, inst.val, scope.returnType, scope, inst.position);
    if (expr == null) return null;
    return { tag: 'return', val: expr, position: inst.position };
  } 

  if (inst.tag == 'expr') {
    if (inst.val.tag == 'assert' && inst.val.val.tag != 'fn_call') {
      let exprTuple = ensureExprValid(symbols, inst.val.val, BOOL, scope, inst.position);
      if (exprTuple == null) return null;

      Enum.applyCond(scope.variantScope, exprTuple, []);
      let expr: Expr = { tag: 'assert', val: exprTuple, type: NIL };
      return { tag: 'expr', val: expr, position: inst.position }
    }
    else if (inst.val.tag == 'assert' || inst.val.tag == 'try' || inst.val.tag == 'fn_call') {
      let exprTuple = ensureExprValid(symbols, inst.val, NIL, scope, inst.position);
      if (exprTuple == null) return null;
      return { tag: 'expr', val: exprTuple, position: inst.position }
    }

    logError(inst.position, 'expression can not be used as statement');
    return null;
  } 

  if (inst.tag == 'declare') {
    if (inst.val.t.tag == 'link') {
      logError(inst.position, 'ref not supported ');
      return null;
    }

    let declareType = resolveType(symbols, inst.val.t, inst.position);
    if (declareType == null) return null;
    setValToScope(scope, inst.val.name, declareType, true, 'none');

    let expr = ensureExprValid(symbols, inst.val.expr, declareType, scope, inst.position);
    if (expr == null) { 
      return null;
    }

    let leftExpr: LeftExpr = { tag: 'var', mode: 'none', unit: null, val: inst.val.name, type: declareType };
    Enum.remove(scope.variantScope, leftExpr);
    if (expr != null) Enum.recursiveAddExpr(scope.variantScope, leftExpr, expr);

    return {
      tag: 'declare',
      val: {
        name: inst.val.name,
        expr: expr,
        type: declareType
      },
      position: inst.position 
    };
  } 

  if (inst.tag == 'assign') {
    let to = ensureLeftExprValid(symbols, inst.val.to, scope, inst.position);
    if (to == null) return null;

    Enum.remove(scope.variantScope, to);
    if (inst.val.op == '++=') {
      if (to.type.tag == 'struct' && to.type.val.template.name == 'Fmt' && to.type.val.template.unit == 'std/core') {
        let expr = ensureExprValid(symbols, inst.val.expr, null, scope, inst.position);
        if (expr == null) return null;
        return { tag: 'assign', val: { to: to , expr: expr, op: inst.val.op }, position: inst.position };
      }

      let impl = resolveImpl(symbols, 'append', [refType(to.type), null], NIL, inst.position);
      if (impl == null) return null;
      if (impl.resolvedType.tag != 'fn' || impl.resolvedType.paramTypes.length != 2) {
        compilerError('expected valid append fn');
        return null;
      }
      let expr = ensureExprValid(symbols, inst.val.expr, impl.resolvedType.paramTypes[1], scope, inst.position);
      if (expr == null) return null;

      return { tag: 'assign', val: { to: to , expr: expr, op: inst.val.op }, position: inst.position };
    }
    else if (inst.val.op == '+=' || inst.val.op == '-=') {
      let expr = ensureExprValid(symbols, inst.val.expr, null, scope, inst.position);
      if (expr == null) return null;

      let exprType = expr.type;
      if (expr.type.tag == 'ambig_int' || expr.type.tag == 'ambig_float') {
        if (typeApplicable(expr.type, to.type, false)) {
          exprType = to.type;
        } 
      }

      if (to.type.tag == 'struct' && isBasic(to.type)
        && exprType.tag == 'struct' && isBasic(exprType)
        && to.type.val.template.name == exprType.val.template.name) {
        let name = to.type.val.template.name;
        if (name == 'bool' || name == 'nil') {
          logError(inst.position, `can not apply ${inst.val.op} to ${name}`);
          return null;
        }
      }
      else {
        resolveImpl(symbols, 'math', [to.type, expr.type], to.type, inst.position);
      }
    }

    let expr = ensureExprValid(symbols, inst.val.expr, to.type, scope, inst.position);
    if (expr == null) return null;

    if (inst.val.op == '=') Enum.recursiveAddExpr(scope.variantScope, to, expr);
    return { tag: 'assign', val: { to: to , expr: expr, op: inst.val.op }, position: inst.position };

    /*
    if (isComplex(expr.type) && expr.tag == 'left_expr') {
      logError(inst.position, 'assignment of complex type - mv or cp');
      return null;
    }
    */
    
    /*
    if (canMutate(to, table, scope) == false) {
      logError(inst.position, 'value can not be mutated');
      return null;
    }
    */
  } 

  logError(inst.position, 'compiler error analyzeInst');
  return null;
}

/*
function canMutate(
  symbols: UnitSymbols,
  leftExpr: LeftExpr,
  scope: FnContext
): boolean {
  if (leftExpr.tag == 'dot') {
    let left: Expr = leftExpr.val.left;
    if (left.tag != 'left_expr') {
      return false;
    }

    if (left.type.tag == 'struct' && Type.getUnitNameOfStruct(left.type.val) != table.thisUnit.fullName) {
      for (let field of left.type.val.fields) {
        if (field.name == leftExpr.val.varName && field.visibility == 'get') {
          return false;
        }
      }
    }

    return canMutate(left.val, table, scope);
  } 
  if (leftExpr.tag == 'prime') {
    if (leftExpr.val.tag != 'left_expr') {
      return false;
    }
    return canMutate(leftExpr.val.val, table, scope);
  }
  else if (leftExpr.tag == 'var') {
    let v = getVar(scope, leftExpr.val, table);
    if (v == null) {
      return false;
    }
    return v.mut;
  } 
  else if (leftExpr.tag == 'arr_offset_int') {
    if (leftExpr.val.var.tag == 'left_expr') {
      return canMutate(leftExpr.val.var.val, table, scope);
    }
    return true;
  }
  else if (leftExpr.tag == 'arr_offset_slice')  {
    if (leftExpr.val.var.tag == 'left_expr') {
      return canMutate(leftExpr.val.var.val, table, scope);
    }
  }
  return false;
}
*/

function ensureLeftExprValid(
  symbols: UnitSymbols,
  leftExpr: Parse.LeftExpr,
  scope: FnContext,
  position: Position | null,
): LeftExpr | null {
  let computedExpr: LeftExpr | null = null;

  if (leftExpr.tag == 'dot') {
    let left = ensureExprValid(symbols, leftExpr.val.left, null, scope, position);
    if (left == null) return null;

    // for iter field
    if (left.tag == 'left_expr' && left.val.tag == 'var' && left.val.mode == 'field_iter') {
      if (leftExpr.val.varName == 'name') {
        computedExpr = { tag: 'dot', val: { left, varName: 'name' }, type: STR };
      }
      else if (leftExpr.val.varName == 'val') {
        computedExpr = { tag: 'dot', val: { left, varName: 'val' }, type: { tag: 'generic', val: 'val' } };
      }
    }

    let leftType = left.type;
    if (leftType.tag != 'struct') {
      if (position != null) logError(position, '');
      return null;
    }

    let fields = getFields(leftType);
    for (let i = 0; i < fields.length; i++) {
      if (fields[i].name != leftExpr.val.varName) continue;
      computedExpr = { tag: 'dot', val: { left, varName: leftExpr.val.varName }, type: fields[i].type }
    }

    if (computedExpr == null) {
      if (position != null) logError(position, `field does not exist on type ${toStr(left.type)}`);
      return null;
    }
  }
  else if (leftExpr.tag == 'index') {
    let left = ensureExprValid(symbols, leftExpr.val.var, null, scope, position);
    if (left == null) return null;
    let index = ensureExprValid(symbols, leftExpr.val.index, null, scope, position);
    if (index == null) return null;
    if (left.type.tag == 'ptr') {
      computedExpr = { tag: 'index', val: { var: left, index, }, type: left.type.val };
    }
    else {
      let trait = resolveImpl(symbols, 'index', [refType(left.type), index.type], null, position);
      if (trait == null || trait.resolvedType.tag != 'fn') return null;

      let retType = trait.resolvedType.returnType;
      if (retType.tag != 'ptr') {
        if (position != null) logError(position, 'index should return a pointer');
        return null;
      };
      computedExpr = { tag: 'index', val: { var: left, index, }, type: retType.val };
    }
  }
  else if (leftExpr.tag == 'var') {
    let v = getVar(symbols, scope, leftExpr.val, null);
    if (v == null) {
      if (position != null) logError(position, `could not find ${leftExpr.val}`);
      return null;
    }

    let changedType = v.type.tag == 'link' ? v.type.val : v.type;
    computedExpr = { tag: 'var', type: changedType, val: leftExpr.val, mode: v.mode, unit: v.unit };
  }
  else if (leftExpr.tag == 'scope_unit') {
    let newUnit = getIsolatedUnitSymbolsFromName(symbols, leftExpr.unit, position);
    if (newUnit == null) {
      if (position != null) logError(position, 'could not find unit');
      return null;
    }
    computedExpr = ensureLeftExprValid(newUnit, leftExpr.inner, scope, position);
  }
  else if (leftExpr.tag == 'scope_as') {
    let newUnit = getIsolatedUnitSymbolsFromAs(symbols, leftExpr.as, position);
    if (newUnit == null) {
      if (position != null) logError(position, 'could not find as');
      return null;
    }
    computedExpr = ensureLeftExprValid(newUnit, leftExpr.inner, scope, position);
  }

  if (computedExpr != null 
    && computedExpr.type.tag == 'struct'
    && computedExpr.type.val.template.name == 'TypeUnion'
    && computedExpr.type.val.template.unit == 'std/core'
  ) {
    let possible = Enum.getVariantPossibilities(scope.variantScope, computedExpr);
    if (possible.length == 1) {
      let fieldIndex = possible[0] == 'val0' ? 0 : 1;
      return {
        tag: 'dot',
        type: getFields(computedExpr.type)[fieldIndex].type,
        val: {
          left: { tag: 'left_expr', val: computedExpr, type: computedExpr.type },
          varName: possible[0]
        }
      };
    }
  }

  return computedExpr;
}

function ensureFnCallValid(
  symbols: UnitSymbols,
  expr: Parse.Expr,
  expectedReturn: Type | null,
  scope: FnContext,
  position: Position | null
): Expr | null {
  if (expr.tag != 'fn_call') {
    compilerError('should always be fn call');
    return null;
  }
  let fnCall = expr.val

  // figure out which unit these belong to
  let fnIsolatedSymbols: UnitSymbols = symbols;
  let isScoped = false;
  let fn: Parse.LeftExpr = fnCall.fn;
  if (fn.tag == 'scope_as') {
    let innerSymbols = getUnitSymbolsFromAs(symbols, fn.as, position);
    if (innerSymbols == null) return null;
    let lookupUnit = getIsolatedUnitSymbolsFromAs(symbols, fn.as, position);
    if (lookupUnit == null) return null;
    fnIsolatedSymbols = lookupUnit;
    isScoped = true;
    fn = fn.inner;
  }
  else if (fn.tag == 'scope_unit') {
    let innerSymbols = getUnitSymbolsFromName(symbols, fn.unit, position);
    if (innerSymbols == null) return null;
    let lookupUnit = getIsolatedUnitSymbolsFromName(symbols, fn.unit, position);
    if (lookupUnit == null) return null;
    fnIsolatedSymbols = lookupUnit;
    isScoped = true;
    fn = fn.inner;
  }

  if ((fn.tag != 'var' || getVar(fnIsolatedSymbols, scope, fn.val, null) != null) && !isScoped) {
    let leftExpr = ensureLeftExprValid(fnIsolatedSymbols, fn, scope, position);
    if (leftExpr == null) return null;
    if (leftExpr.type.tag != 'fn') {
      if (position != null) logError(position, 'type is not callable');
      return null;
    }
    let exprs: Expr[] = [];
    if (fnCall.exprs.length != leftExpr.type.paramTypes.length) {
      if (position != null) logError(position, 'mismatch parameter amount');
      return null;
    }
    for (let i = 0; i < fnCall.exprs.length; i++) {
      let expr = ensureExprValid(symbols, fnCall.exprs[i], leftExpr.type.paramTypes[i], scope, position);
      if (expr == null) return null;
      exprs.push(expr);
    }

    if (expectedReturn != null) {
      if (!typeApplicable(leftExpr.type.returnType, expectedReturn, false)) {
        if (position != null) logError(position, 'wrong return type');
        return null;
      }
    }

    return {
      tag: 'fn_call',
      type: leftExpr.type.returnType,
      val: { exprs, fn: leftExpr, position: expr.position }
    }
  }

  // the type must be determined for any global function
  let initialExprs: (Expr | null)[] = [];
  let initialTypes: (Type | null)[] = [];
  for (let i = 0; i < fnCall.exprs.length; i++) {
    let expr = ensureExprValid(symbols, fnCall.exprs[i], null, scope, null);
    if (expr == null) {
      initialExprs.push(null);
      initialTypes.push(null);
    } 
    else {
      initialExprs.push(expr);
      initialTypes.push(expr.type);
    }
  }

  let result = resolveFnOrDecl(fnIsolatedSymbols, (fn as any).val, initialTypes, expectedReturn, position);
  if (result == null || result.resolvedType.tag != 'fn') return null;
  let newTypes: Type[] = result.resolvedType.paramTypes;
  let resolvedExprs: Expr[] = []
  for (let i = 0; i < newTypes.length; i++) {
    let expr = ensureExprValid(symbols, fnCall.exprs[i], newTypes[i], scope, position);
    if (expr == null) return null;
    resolvedExprs.push(expr);
  }

  return {
    tag: 'fn_call',
    type: result.resolvedType.returnType,
    val: { 
      exprs: resolvedExprs,
      fn: {
        tag: 'fn',
        unit: result.unit,
        name: result.name,
        type: result.resolvedType,
        mode: result.mode,
        isGeneric: result.isGeneric
      },
      position: expr.position
    }
  }
}

function ensureBinOpValid(
  symbols: UnitSymbols,
  expr: Parse.BinExpr,
  expectedReturn: Type | null,
  scope: FnContext,
  position: Position | null
): Expr | null {

  let computedExpr: Expr | null = null; 
  if (expr.op == ':') {
    let leftTuple = ensureExprValid(symbols, expr.left, INT, scope, position);
    let rightTuple = ensureExprValid(symbols, expr.right, INT, scope, position);
    if (leftTuple == null || rightTuple == null) return null;

    let rangeInitExpr: Expr = {
      tag: 'struct_init',
      val: [
        { name: 'start', expr: leftTuple },
        { name: 'end', expr: rightTuple },
        { name: 'output', expr: { tag: 'int_const', val: 0, type: INT } }
      ],
      type: RANGE
    };
    computedExpr = rangeInitExpr;
  }
  else if (expr.op == '&&') {
    let exprLeft = ensureExprValid(symbols, expr.left, BOOL, scope, position);
    if (exprLeft == null) return null;

    // the left side of the && can be used on the right
    Enum.enterScope(scope.variantScope);
    Enum.applyCond(scope.variantScope, exprLeft, []);
    let exprRight = ensureExprValid(symbols, expr.right, BOOL,scope, position);
    Enum.exitScope(scope.variantScope);
    if (exprRight == null) return null;
    computedExpr = {
      tag: 'bin',
      val: {
        op: '&&',
        left: exprLeft,
        right: exprRight
      },
      type: BOOL
    }
  }
  else if (expr.op == '||') {
    let exprLeft = ensureExprValid(symbols, expr.left, BOOL, scope, position);
    if (exprLeft == null) return null;

    // the left side of the && can be used on the right
    Enum.enterScope(scope.variantScope);
    Enum.applyInverseCond(scope.variantScope, exprLeft, []);
    let exprRight = ensureExprValid(symbols, expr.right, BOOL, scope, position);
    Enum.exitScope(scope.variantScope);
    if (exprRight == null) return null;

    computedExpr = {
      tag: 'bin',
      val: {
        op: '||',
        left: exprLeft,
        right: exprRight
      },
      type: BOOL
    }
  }
  else {
    let left = ensureExprValid(symbols, expr.left, null, scope, position);
    if (left == null) return null;
    let right = ensureExprValid(symbols, expr.right, null, scope, position);
    if (right == null) return null;
    let op = expr.op;

    let leftType = left.type;
    let rightType = right.type;
    if ((left.type.tag == 'ambig_float' || left.type.tag == 'ambig_int')
      && (right.type.tag == 'ambig_int' || right.type.tag == 'ambig_float')) {

      if (op == '|' || op == '&' || op == '^' || op == '%') {
        if (left.type.tag == 'ambig_float' || right.type.tag == 'ambig_float') {
          if (position != null) logError(position, `can not ${op}'`);
          return null;
        }
      }

      let outputType: Type = left.type;
      if (op == '<' || op == '>' || op == '<=' || op == '>=' || op == '==' || op == '!=') {
        outputType = BOOL;
      }
      computedExpr = { tag: 'bin', type: outputType, val: { left, op, right } };
    }
    else if (left.type.tag == 'ambig_float' || left.type.tag == 'ambig_int') {
      if (typeApplicable(left.type, right.type, false)) leftType = rightType;
    }
    else if (right.type.tag == 'ambig_float' || right.type.tag == 'ambig_int') {
      if (typeApplicable(right.type, left.type, false)) rightType = leftType;
    }

    if (computedExpr == null) {
      if (leftType.tag == 'struct' && isBasic(leftType)
        && rightType.tag == 'struct' && isBasic(rightType)
        && leftType.val.template.name == rightType.val.template.name) {
        let t = rightType.val.template.name;
        if (op == '+' || op == '-' || op == '*' || op == '/'
          || op == '<' || op == '>' || op == '<=' || op == '>=') {
          if (t == 'bool' || t == 'nil') {
            if (position != null) logError(position, `can not ${op} on '${t}'`);
            return null;
          }
        }
        else if (op == '|' || op == '&' || op == '^' || op == '%' || op == '>>' || op == '<<') {
          if (t == 'bool' || t == 'nil' || t == 'f32' || t == 'f64') {
            if (position != null) logError(position, `can not ${op} on '${t}'`);
            return null;
          }
        }

        let outputType: Type = left.type;
        if (op == '<' || op == '>' || op == '<=' || op == '>=' || op == '==' || op == '!=') {
          outputType = BOOL;
        }
        computedExpr = { tag: 'bin', type: outputType, val: { left, op, right } };
      }
      else if (left.type.tag == 'ptr' && right.tag == 'nil_const' && op == '==' || op == '!=') {
        computedExpr = { tag: 'bin', type: BOOL, val: { left, op, right } };
      }
      else {
        let trait: FnResult | null = null;
        if (op == '+' || op == '-' || op == '*' || op == '/') {
          trait = resolveImpl(symbols, 'math', [left.type, right.type], expectedReturn, position);
        }
        else if (op == '<' || op == '>' || op == '<=' || op == '>=') {
          trait = resolveImpl(symbols, 'cmp', [left.type, right.type], BOOL, position);
        }
        else if (op == '==' || op == '!=') {
          trait = resolveImpl(symbols, 'eq', [left.type, right.type], BOOL, position);
        }
        else if (op == '|' || op == '&' || op == '^') {
          trait = resolveImpl(symbols, 'bitwise', [left.type, right.type], expectedReturn, position);
        }

        if (trait == null || trait.resolvedType.tag != 'fn') return null;
        computedExpr = { tag: 'bin', type: trait.resolvedType.returnType, val: { left, op, right } };
      }

    }
  }

  if (expectedReturn != null) {
    if (computedExpr == null) {
      compilerError('binExpr fallthrough');
      return null;
    }

    if (typeApplicable(computedExpr.type, expectedReturn, false) == false) {
      if (position != null) logError(position, `expected ${toStr(expectedReturn)} found ${toStr(computedExpr.type)}`);
      return null;
    }
  }
  return computedExpr;
}

function ensureExprValid(
  symbols: UnitSymbols,
  expr: Parse.Expr, 
  // expected return is provided when the expression return type is known
  // which helps with struct typing and generic functions
  expectedReturn: Type | null,
  scope: FnContext,
  position: Position | null,
): Expr | null {
  let computedExpr: Expr | null = null; 

  if (expectedReturn != null
    && expectedReturn.tag == 'struct' 
    && expectedReturn.val.template.name == 'TypeUnion'
    && expectedReturn.val.template.unit == 'std/core') {

    let fields = getFields(expectedReturn);
    let first = ensureExprValid(symbols, expr, fields[0].type, scope, null);
    if (first != null) {
      return {
        tag: 'enum_init',
        type: expectedReturn,
        fieldExpr: first,
        fieldName: 'val0',
        variantIndex: 0
      };
    }

    let second = ensureExprValid(symbols, expr, fields[1].type, scope, null);
    if (second != null) {
      return {
        tag: 'enum_init',
        type: expectedReturn,
        fieldExpr: second,
        fieldName: 'val1',
        variantIndex: 1
      }
    }
  }

  if (expr.tag == 'ptr') {
    if (expr.val.tag != 'left_expr') {
      if (position != null) logError(expr.position, 'pointer on valid on left expr');
      return null;
    }
    let inner = ensureLeftExprValid(symbols, expr.val.val, scope, position);
    if (inner == null) return null;
    computedExpr = {
      tag: 'ptr',
      val: inner,
      type: { tag: 'ptr', val: inner.type }
    };
  }

  if (expr.tag == 'is') {
    let exprLeft = ensureLeftExprValid(symbols, expr.val, scope, position);
    if (exprLeft == null) return null;

    // if T|K is a known, should still be able to use 'is'
    if (exprLeft.type.tag != 'struct' || !exprLeft.type.val.template.isEnum) {
      if (position == null) {
        compilerError('can not use is with null position');
        return null;
      }
      let t = resolveType(symbols, expr.right, position);
      if (t == null) {
        if (position != null) logError(position, 'is operator only valid on enums');
        return null;
      }

      if (typeApplicable(t, exprLeft.type, false) 
        && typeApplicable(exprLeft.type, t, false)) {
        computedExpr = {
          tag: 'bool_const',
          val: true,
          type: BOOL
        }
      }

      if (computedExpr == null) {
        if (position != null) logError(position, '\'is\' will always be false');
        return null;
      }
    }

    if (exprLeft.type.tag == 'struct' && exprLeft.type.val.template.isEnum && expr.right.tag == 'basic') {
      let fieldName: string = expr.right.val;
      if (exprLeft.type.val.template.name == 'TypeUnion' && exprLeft.type.val.template.unit == 'std/core') {
        let fields = getFields(exprLeft.type);
        for (let i = 0; i < fields.length; i++) {
          let t = fields[i].type;
          if (t.tag == 'struct' && t.val.generics.length == 0 && t.val.template.name == fieldName) {
            computedExpr = {
              tag: 'is',
              left: exprLeft,
              variant: 'val' + i,
              variantIndex: i,
              type: BOOL
            }
          }
        }
      }

      if (computedExpr == null) {
        if (getFields(exprLeft.type).map(f => f.name).includes(fieldName) == false) {
          if (position != null) logError(position, `${fieldName} does not exist on enum ${toStr(exprLeft.type)}`);
          return null;
        }

        computedExpr = {
          tag: 'is',
          left: exprLeft,
          variant: fieldName,
          variantIndex: getFieldIndex(exprLeft.type, fieldName),
          type: BOOL 
        };
      }
    }

    if (exprLeft.type.tag == 'struct' && expr.right.tag != 'basic') {
      if (exprLeft.type.val.template.name != 'TypeUnion' || exprLeft.type.val.template.unit != 'std/core') {
        if (position != null) logError(position, 'expected enum variant');
        return null;
      }

      if (position == null) {
        compilerError('can not use is with null position');
        return null;
      }

      let t = resolveType(symbols, expr.right, position);
      if (t == null) return null;

      let fields = getFields(exprLeft.type);
      for (let i = 0; i < fields.length; i++) {
        if (typeApplicable(t, fields[i].type, false) && typeApplicable(fields[i].type, t, false)) {
          computedExpr = {
            tag: 'is',
            left: exprLeft,
            variant: 'val' + i,
            variantIndex: i,
            type: BOOL
          }
        }
      }
    }

    if (computedExpr == null) {
      if (position) logError(position, 'is does not match variants');
      return null;
    }
  } 

  if (expr.tag == 'bin') {
    computedExpr = ensureBinOpValid(symbols, expr.val, expectedReturn, scope, position);
    if (computedExpr == null) return null;
  } 

  if (expr.tag == 'try') {
    let errorType: Type | null = null;
    if (expr.tag == 'try') {
      if (scope.returnType.tag == 'struct' 
        && scope.returnType.val.template.name == 'TypeUnion'
        && scope.returnType.val.template.unit == 'std/core') {
        errorType = getFields(scope.returnType)[1].type;
      }
    }
    if (errorType == null) return null;

    let innerExpr: Expr | null;
    if (expectedReturn != null) {
      let typeUnion: Type = createTypeUnion(expectedReturn, errorType);
      innerExpr = ensureExprValid(symbols, expr.val, typeUnion, scope, position);
    }
    else {
      innerExpr = ensureExprValid(symbols, expr.val, null, scope, position);
    }

    if (innerExpr == null) return null;
    let successType: Type = getFields(innerExpr.type)[0].type;
    computedExpr = { tag: 'try', val: innerExpr, type: successType };
  }

  if (expr.tag == 'not') {
    let exprTuple = ensureExprValid(symbols, expr.val, BOOL, scope, position);
    if (exprTuple == null) return null;
    computedExpr = { tag: 'not', val: exprTuple, type: BOOL };
  } 

  if (expr.tag == 'macro_call') {
    let macro = resolveMacro(symbols, expr.val.name, position);
    if (macro == null) return null;

    let args: MacroArg[] = [];
    for (let i = 0; i < macro.paramTypes.length; i++) {
      let paramType = macro.paramTypes[i];

      if (paramType.tag == 'struct' && paramType.val.template.name == 'type' && paramType.val.template.unit == 'std/core') {
        let argType = expr.val.args[i].type;
        if (argType == null) {
          if (position != null) logError(position, 'expected type');
          return null;
        }

        let type = resolveType(symbols, argType, position);
        if (type == null) return null;
        args.push({ tag: 'type', val: type });
      }
      else {
        let argExpr = expr.val.args[i].expr;
        if (argExpr == null) {
          if (position != null) logError(position, 'expected expr');
          continue;
        }

        let validExpr = ensureExprValid(symbols, argExpr, null, scope, position);
        if (validExpr == null) return null;
        args.push({ tag: 'expr', val: validExpr }); 
      }
    }

    computedExpr = { tag: 'macro_call', val: { name: macro.name, args }, type: macro.returnType };
  }

  if (expr.tag == 'fn_call') {
    // check if builtin function
    if (expr.val.fn.tag == 'var') {
      let name = expr.val.fn.val;
      if (name == 'bool' || name == 'int' || name == 'char'
        || name == 'i8' || name == 'i16' || name == 'i64'
        || name == 'u8' || name == 'u16' || name == 'u32' || name == 'u64'
        || name == 'f32' || name == 'f64' || name == 'ptr') {

        if (expr.val.exprs.length != 1) {
          if (position != null) logError(expr.position, 'ptr expects 1 argument');
          return null;
        }
        let innerExpr = ensureExprValid(symbols, expr.val.exprs[0], null, scope, position);
        if (innerExpr == null) return null;

        if (innerExpr.type.tag == 'ptr' && name == 'ptr') {
          if (expectedReturn == null) {
            if (position != null) logError(position, 'pointer must be known');
            return null;
          }

          computedExpr = { 
            tag: 'cast',
            val: innerExpr, 
            type: expectedReturn
          };
        }

        if (innerExpr.type.tag == 'ptr' && name == 'u64') {
          computedExpr = { 
            tag: 'cast',
            val: innerExpr, 
            type: basic(name)
          };
        }

        if (computedExpr == null) {
          if (!isBasic(innerExpr.type) && innerExpr.type.tag != 'ambig_int' && innerExpr.type.tag != 'ambig_float') {
            if (position != null) logError(position, 'can not cast');
            return null;
          }

          computedExpr = { 
            tag: 'cast',
            val: innerExpr, 
            type: basic(name)
          };
        }
      }
    }

    // check if initialization of enum
    if (expectedReturn != null
      && expectedReturn.tag == 'struct' 
      && expectedReturn.val.template.isEnum
      && expr.val.fn.tag == 'var' 
      && expr.val.exprs.length == 1
    ) {
      let fields = getFields(expectedReturn);
      let fieldIndex = fields.map(f => f.name).indexOf(expr.val.fn.val);
      if (fieldIndex != -1) {
        let fieldType: Type = fields[fieldIndex].type;
        let fieldName: string = fields[fieldIndex].name;

        let fieldExpr = ensureExprValid(symbols, expr.val.exprs[0], fieldType, scope, position);
        if (fieldExpr == null) return null;

        computedExpr = {
          tag: 'enum_init',
          variantIndex: getFieldIndex(expectedReturn, fieldName),
          fieldName,
          fieldExpr,
          type: expectedReturn 
        };
      } 
    } 

    // if there was no enum variant treat it as a normal function call
    if (computedExpr == null) {
      let fnExpr = ensureFnCallValid(symbols, expr, expectedReturn, scope, position);
      if (fnExpr == null) return null;
      computedExpr = fnExpr;
    }
  } 

  if (expr.tag == 'list_init') {
    let exprType: Type | null = null;
    if (expectedReturn != null 
      && expectedReturn.tag == 'struct' 
      && expectedReturn.val.template.name == 'Vec'
      && expectedReturn.val.template.unit == 'std/core') {
      let ptrType = getFields(expectedReturn)[0].type;
      if (ptrType.tag != 'ptr') {
        compilerError('expected ptr field');
        return null;
      }
      exprType = ptrType.val;
    }
    else { 
      if (position != null) logError(position, 'type mismatch expected array');
      return null;
    }

    let newExprs: Expr[] = []
    for (let i = 0; i < expr.val.length; i++) {
      let e = ensureExprValid(symbols, expr.val[i], exprType, scope, position);
      if (e == null) {
        return null;
      }
      newExprs.push(e);
      exprType = e.type;
    }

    // ensure that the type is actually known when done
    if (exprType == null) {
      if (position != null) logError(position, "unknown vec type")
      return null;
    }

    computedExpr = { tag: 'list_init', val: newExprs, type: createVec(exprType) };
  }

  if (expr.tag == 'struct_init') {
    if (expectedReturn == null) {
      if (position != null) logError(position, 'struct initialization type is unknown');
      return null;
    }

    if (expectedReturn.tag != 'struct') {
      if (position != null) logError(position, `expected ${toStr(expectedReturn)}`);
      return null;
    }

    let retType: Type = expectedReturn;
    if (retType.tag != 'struct') {
      if (position != null) logError(position, `expected ${toStr(retType)}`);
      return null;
    }

    if (expr.val.length == 0) {
      return { tag: 'struct_zero', type: expectedReturn };
    }

    let exprFieldTypes = new Map<string, Type>();
    let exprFieldExprs: Map<string, Expr> = new Map();
    let fields = getFields(retType);
    for (let initField of expr.val) {
      let matchingFields = fields.filter(x => x.name == initField.name);
      if (matchingFields.length == 0) {
        if (position != null) logError(initField.expr.position, `field ${initField.name} does not exist on type`);
        return null;
      }

      let fieldType = matchingFields[0].type;
      let expr = ensureExprValid(symbols, initField.expr, fieldType, scope, position);
      if (expr == null) return null;

      if (exprFieldTypes.has(initField.name)) {
        if (position != null) logError(position, 'double initialization of field');
        return null;
      }

      exprFieldTypes.set(initField.name, expr.type);
      exprFieldExprs.set(initField.name, expr);
    }

    if (exprFieldTypes.size != fields.length) {
      if (position != null) logError(position, 'missing fields');
      return null;
    }

    for (let field of fields) {
      if (!exprFieldTypes.has(field.name)) {
        if (position != null) logError(position, `required field ${field.name}`);
        return null;
      }

      let exprFieldType = exprFieldTypes.get(field.name)!;
      if (typeApplicable(exprFieldType, field.type, false) == false) {
        if (position != null) logError(position, `improper type for ${toStr(retType)}.${field.name}`);
        return null;
      }
    }

    let fieldInits: StructInitField[] = [];
    for (let fName of exprFieldTypes.keys()) {
      let fieldExpr = exprFieldExprs.get(fName)!;
      fieldInits.push({ name: fName, expr: fieldExpr });
    }

    computedExpr = { tag: 'struct_init', val: fieldInits, type: retType };
  } 

  if (expr.tag == 'fmt_str') {
    let newExprs: Expr[] = [];
    for (let parseExpr of expr.val) {
      let fmtExpr: Expr | null = ensureExprValid(symbols, parseExpr, null, scope, position);
      if (fmtExpr == null) return null;
      newExprs.push(fmtExpr);
    }
    computedExpr = { tag: 'fmt_str', val: newExprs, type: STR }
  }

  if (expr.tag == 'bool_const') {
    computedExpr = { tag: 'bool_const', val: expr.val, type: BOOL };
  }

  if (expr.tag == 'str_const') {
    computedExpr = { tag: 'str_const', val: expr.val , type: STR };
  } 

  if (expr.tag == 'char_const') {
    computedExpr = { tag: 'char_const', val: expr.val, type: CHAR };
  } 

  if (expr.tag == 'int_const') {
    computedExpr = { tag: 'int_const', val: expr.val, type: AMBIG_INT };
  } 

  if (expr.tag == 'nil_const') {
    if (expectedReturn != null && expectedReturn.tag == 'ptr') {
      computedExpr = { tag: 'nil_const', type: expectedReturn };
    }
    else {
      computedExpr = { tag: 'nil_const', type: NIL }
    }
  }

  if (expr.tag == 'num_const') {
    computedExpr = { tag: 'num_const', val: expr.val, type: AMBIG_FLOAT };
  }

  if (expr.tag == 'left_expr') {

    // see if it is constant enum initialization of a void type
    if (expectedReturn != null 
      && expectedReturn.tag == 'struct' 
      && expectedReturn.val.template.isEnum
      && expr.val.tag == 'var'
    ) {
      let fields = getFields(expectedReturn);
      let fieldIndex = getFieldIndex(expectedReturn, expr.val.val);
      if (fieldIndex != -1 && typeApplicable(fields[fieldIndex].type, NIL, false)) {
        let fieldName = fields[fieldIndex].name;
        computedExpr = {
          tag: 'enum_init',
          variantIndex: getFieldIndex(expectedReturn, fieldName),
          fieldName,
          fieldExpr: null,
          type: expectedReturn
        };
      } 
    } 

    if (computedExpr == null) {
      let exprTuple = ensureLeftExprValid(symbols, expr.val, scope, null);
      if (exprTuple != null) {
        computedExpr = { tag: 'left_expr', val: exprTuple, type: exprTuple.type };
      }
      else {
        if (expr.val.tag != 'var') {
          ensureLeftExprValid(symbols, expr.val, scope, position); // log proper error
          return null;
        }

        let varName = expr.val.val;
        let paramTypes: (Type | null)[] | null = null; 
        let retType: Type | null = null; 
        if (expectedReturn != null && expectedReturn.tag == 'fn') {
          paramTypes = expectedReturn.paramTypes;
          retType = expectedReturn.returnType;
        }

        let fnResults = lookupFnOrDecl(symbols, varName, paramTypes, retType);
        if (fnResults.possibleFns.length == 1) {
          let fn = fnResults.possibleFns[0];
          computedExpr = {
            tag: 'left_expr',
            val: {
              tag: 'fn',
              unit: fn.unit,
              name: fn.name,
              type: fn.resolvedType,
              mode: fn.mode,
              isGeneric: fn.isGeneric
            },
            type: fn.resolvedType 
          };

          if (expectedReturn != null && expectedReturn.tag == 'fn') {
            if (fn.resolvedType.tag != 'fn') { compilerError('should always be fn'); return null; }
            if (expectedReturn.tag != 'fn') { compilerError('should always be fn'); return null; }

            for (let i = 0; i < fn.resolvedType.paramTypes.length; i++) {
              let fp = fn.resolvedType.paramTypes[i].tag;
              let ep = expectedReturn.paramTypes[i].tag;

              if (fp == 'link' && ep != 'link' || fp != 'link' && ep == 'link') {
                if (position != null) logError(position, 'references do not match');
                return null;
              }
            }
          }
        }
        else if (fnResults.possibleFns.length > 0) {
          if (position != null) {
            let context: string[] = []
            getFoundFns(fnResults, varName, context);
            getCurrentFn(varName, paramTypes, retType, context);
            logMultiError(position, varName + ' is an ambiguous fn', context);
          }
          return null
        }
        else if (fnResults.wrongTypeFns.length > 1) {
          let context: string[] = []
          if (position != null) {
            getFoundFns(fnResults, varName, context);
            logMultiError(position, varName + ' is an ambiguous fn', context);
          }
          return null
        }
        else {
          if (position != null) logError(position, 'could not find ' + varName);
          return null;
        }
      }
    }
  }

  if (expectedReturn != null) {
    if (computedExpr == null) {
      if (position != null) logError(position, 'ensureExprValid compiler bug');
      return null;
    }

    if (!typeApplicable(computedExpr.type, expectedReturn, false)) {
      if (position != null) logError(position, `expected ${toStr(expectedReturn)} found ${toStr(computedExpr.type)}`);
      return null;
    }
  }

  return computedExpr;
}

interface Var {
  unit: string | null
  type: Type
  mode: Mode
  mut: boolean
}

interface FnContext {
  typeScope: Map<string, Var>[]
  generics: Set<string>, 
  returnType: Type
  inLoop: boolean
  variantScope: Enum.VariantScope 
};

function newScope(returnType: Type, generics: Set<string>): FnContext {
  return {
    typeScope: [],
    variantScope: [[]],
    generics,
    returnType: returnType,
    inLoop: false,
  };
}

function enterScope(scope: FnContext) {
  scope.typeScope.push(new Map());
}

function exitScope(scope: FnContext) {
  scope.typeScope.pop();
}

function setValToScope(scope: FnContext, name: string, type: Type, mut: boolean, mode: Mode) {
  scope.typeScope[scope.typeScope.length - 1].set(name, { type, mut, mode, unit: null });
}

function getVar(
  symbols: UnitSymbols,
  scope: FnContext,
  name: string,
  position: Position | null
): Var | null {
  for (let i = scope.typeScope.length - 1; i >= 0; i--) {
    if (scope.typeScope[i].has(name)) return scope.typeScope[i].get(name)!;
  }
  let global: Global | null = resolveGlobal(symbols, name, position);
  if (global == null) return null;
  return {
    type: global.type,
    mode: symbols.name.endsWith('.h') ? 'C' : 'global',
    mut: true,
    unit: global.unit
  }
}
