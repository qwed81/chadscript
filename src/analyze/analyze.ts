import * as Parse from '../parse';
import { logError, compilerError, Position } from '../util'
import * as Type from './types'
import * as Enum from './enum';

interface Program {
  includes: string[]
  fns: Fn[]
  consts: Const[]
  strTable: string[]
}

interface Const {
  position: Position
  pub: boolean
  name: string
  unitName: string
  type: Type.Type
  expr: Expr
}

interface Fn {
  name: string
  unitName: string,
  paramNames: string[]
  type: Type.Type 
  body: Inst[]
  refTable: Type.RefTable,
  scope: FnContext
}

interface CondBody {
  cond: Expr
  body: Inst[]
}

interface Declare {
  name: string
  expr: Expr | null
  type: Type.Type
}

interface Assign {
  op: string
  to: LeftExpr,
  expr: Expr
}

interface MatchBranch {
  enumVariant: string
  body: Inst[]
}

interface Match {
  var: Expr
  branches: MatchBranch[]
}

interface ForIn {
  varName: string,
  iter: Expr
  nextFn: LeftExpr
  body: Inst[]
}

interface Include {
  lines: string[],
  types: Type.Type[]
}

type Inst = { tag: 'if', val: CondBody, position: Position }
  | { tag: 'elif', val: CondBody, position: Position }
  | { tag: 'while', val: CondBody, position: Position }
  | { tag: 'for_in', val: ForIn, position: Position }
  | { tag: 'expr', val: Expr, position: Position }
  | { tag: 'else', val: Inst[], position: Position }
  | { tag: 'arena', val: Inst[], position: Position }
  | { tag: 'return', val: Expr | null, position: Position }
  | { tag: 'break', position: Position }
  | { tag: 'continue', position: Position }
  | { tag: 'match', val: Match, position: Position }
  | { tag: 'declare', val: Declare, position: Position }
  | { tag: 'assign', val: Assign, position: Position }
  | { tag: 'include', val: Include, position: Position }

interface FnCall {
  fn: LeftExpr
  exprs: Expr[],
}

interface StructInitField {
  name: string
  expr: Expr
}

interface BinExpr {
  left: Expr
  right: Expr
  op: string
}

type Expr = { tag: 'bin', val: BinExpr, type: Type.Type }
  | { tag: 'is', left: LeftExpr, variant: string, variantIndex: number, type: Type.Type }
  | { tag: 'not', val: Expr, type: Type.Type }
  | { tag: 'try', val: Expr, type: Type.Type }
  | { tag: 'assert', val: Expr, type: Type.Type }
  | { tag: 'assert_bool', val: Expr, type: Type.Type }
  | { tag: 'resolve', val: Expr, type: Type.Type }
  | { tag: 'fn_call', val: FnCall, type: Type.Type }
  | { tag: 'struct_init', val: StructInitField[], type: Type.Type }
  | { tag: 'list_init', val: Expr[], type: Type.Type }
  | { tag: 'enum_init', fieldName: string, variantIndex: number, fieldExpr: Expr | null, type: Type.Type }
  | { tag: 'cast', val: Expr, type: Type.Type }
  | { tag: 'str_const', val: string, type: Type.Type }
  | { tag: 'fmt_str', val: Expr[], type: Type.Type }
  | { tag: 'char_const', val: string, type: Type.Type }
  | { tag: 'int_const', val: number, type: Type.Type }
  | { tag: 'nil_const', type: Type.Type }
  | { tag: 'bool_const', val: boolean, type: Type.Type }
  | { tag: 'num_const', val: number, type: Type.Type }
  | { tag: 'left_expr', val: LeftExpr, type: Type.Type }
  | { tag: 'ptr', val: LeftExpr, type: Type.Type }
  | { tag: 'cfn_call', fnName: string, exprs: Expr[], type: Type.Type }
  | { tag: 'cp', val: Expr, type: Type.Type }
  | { tag: 'mv', val: Expr, type: Type.Type }

interface DotOp {
  left: Expr
  varName: string
}

interface ArrOffsetInt {
  var: Expr
  index: Expr
}

interface ArrOffsetSlice {
  var: Expr
  range: Expr
}

type Mode = 'C' | 'none' | 'param' | 'iter' | 'iter_copy' | { tag: 'const', unitName: string};

type LeftExpr = { tag: 'dot', val: DotOp, type: Type.Type }
  | { tag: 'prime', val: Expr, variant: string, variantIndex: number, type: Type.Type }
  | { tag: 'arr_offset_int', val: ArrOffsetInt, type: Type.Type }
  | { tag: 'arr_offset_slice', val: ArrOffsetSlice, type: Type.Type }
  | { tag: 'var', val: string, mode: Mode, type: Type.Type }
  | { tag: 'fn', unitName: string, refTable: Type.RefTable, fnName: string, extern: boolean, type: Type.Type }

export { analyze, newScope, ensureExprValid, FnContext, Program, Fn, Inst, StructInitField, FnCall, Expr, LeftExpr, Mode, Const }

function analyze(units: Parse.ProgramUnit[]): Program | null {
  let strTable: string[] = [];
  let includes: Set<string> = new Set();
  for (let unit of units) {
    for (let include of unit.uses) {
      if (include.unitName.endsWith('.h')) {
        includes.add(include.unitName);
      }
    }
  }

  let validProgram: Program | null = {
    includes: [...includes],
    fns: [],
    consts: [],
    strTable 
  };

  for (let i = 0; i < units.length; i++) {
    if (analyzeUnitDataTypes(units, i) == false) {
      validProgram = null;
    }
  }

  for (let i = 0; i < units.length; i++) {
    let unitConsts: Const[] | null = analyzeUnitConsts(units, i); 
    if (unitConsts == null) {
      validProgram = null;
    } 
    else if (validProgram != null) {
      for (let j = 0; j < unitConsts.length; j++) {
        validProgram.consts.push(unitConsts[j]);
      }
    }
  }

  for (let i = 0; i < units.length; i++) {
    let unitFns: Fn[] | null = null;
    if (validProgram != null) {
      unitFns = analyzeUnitFns(units, i, validProgram.consts); 
    }
    if (unitFns == null) {
      validProgram = null;
    } 
    else if (validProgram != null) {
      for (let j = 0; j < unitFns.length; j++) {
        validProgram.fns.push(unitFns[j]);
      }
    }
  }

  return validProgram;
}

function analyzeUnitConsts(units: Parse.ProgramUnit[], unitIndex: number): Const[] | null {
  let unit = units[unitIndex];
  let table = Type.getUnitReferences(units[unitIndex]);

  // scope outside of a fn
  let scope: FnContext = {
    typeScope: [],
    generics: new Set(),
    returnType: Type.VOID,
    inLoop: false,
    variantScope: [],
    consts: []
  };
  let consts: Const[] | null = [];
  for (let c of unit.consts) {
    let type = Type.resolveType(c.type, table, c.position);
    if (type == null) {
      consts = null;
      break;
    }

    if (type.tag != 'primative') {
      logError(c.position, 'only primatives supported in constants');
      return null;
    }

    let expr = ensureExprValid(c.expr, type, table, scope, c.position, false);
    if (expr == null) {
      consts = null;
      break;
    }

    if (!exprIsConst(expr)) {
      logError(c.position, 'expression may not be constant');
      return null;
    }

    consts.push({
      type,
      expr,
      position: c.position,
      pub: c.pub,
      name: c.name,
      unitName: unit.fullName
    });
  }

  return consts;
}

function exprIsConst(expr: Expr): boolean {
  if (expr.tag == 'bin') {
    return exprIsConst(expr.val.left) && exprIsConst(expr.val.right);
  }
  return expr.tag == 'str_const' || expr.tag == 'int_const' || expr.tag == 'char_const' || expr.tag == 'num_const' || expr.tag == 'nil_const';
}
 
function analyzeUnitFns(units: Parse.ProgramUnit[], unitIndex: number, consts: Const[]): Fn[] | null {
  let unit = units[unitIndex];
  let lookupTable = Type.getUnitReferences(units[unitIndex]);

  let fns: Fn[] | null = [];
  for (let fn of unit.fns) {
    let generics: Set<string> = new Set();

    for (let i = 0; i < fn.t.paramTypes.length; i++) {
      let paramType = fn.t.paramTypes[i]; 
      addGenerics(paramType, generics);
    }

    let returnType = Type.resolveType(fn.t.returnType, lookupTable, fn.position);
    if (returnType == null) {
      logError(fn.position, 'could not resolve return type');
      return null;
    }

    let scope = newScope(returnType, generics, consts);
    let validFn = analyzeFn(fn, lookupTable, unit, scope);

    if (validFn == null) {
      fns = null;
    } else if (fns != null) {
      fns.push(validFn);
    }
  }

  return fns;
}

function analyzeUnitDataTypes(units: Parse.ProgramUnit[], unitIndex: number): boolean {
  let unit = units[unitIndex];
  let lookupTable = Type.getUnitReferences(units[unitIndex]);

  let invalidDataType = false;
  for (let struct of unit.structs) {
    if (verifyStruct(struct, lookupTable) == false) {
      invalidDataType = true;
    }
  }

  for (let en of unit.enums) {
    for (let i = 0; i < en.fields.length; i++) {
      if (en.fields[i].visibility == 'get' || en.fields[i].visibility == null) {
        logError(en.fields[i].position, 'enum fields can not have visibility modifier');
        invalidDataType = true;
      }
    }

    if (verifyStruct(en, lookupTable) == false) {
      invalidDataType = true;
    }
  }

  return !invalidDataType;
}

// ensure that the parse type is actually valid
function verifyDataType(
  type: Parse.Type,
  position: Position,
  table: Type.RefTable,
  validGenerics: string[]
): boolean {
  if (type.tag == 'basic') {
    if (type.val.length == 1 && validGenerics.includes(type.val) == false) {
      logError(position, 'generic not added to struct heading');
      return false;
    }
    let dataType = Type.resolveType(type, table, position);
    if (dataType == null) {
      return false;
    }
    return true;
  } 

  if (type.tag == 'type_union') {
    let firstTypeValid = verifyDataType(type.val0, position, table, validGenerics);
    let secondTypeValid = verifyDataType(type.val1, position, table, validGenerics);
    return firstTypeValid && secondTypeValid;
  }

  if (type.tag == 'ptr') {
    return verifyDataType(type.val, position, table, validGenerics);
  }

  if (type.tag == 'generic') {
    let dataType = Type.resolveType(type, table, position);
    for (let g of type.val.generics) {
      if (verifyDataType(g, position, table, validGenerics) == false) {
        return false;
      }
    }
    if (dataType == null) {
      return false;
    }
    return true;
  } 

  if (type.tag == 'link') {
    logError(position, 'ref not allowed in struct definitions');
    return false;
  } 

  if (type.tag == 'fn') {
    for (let i = 0; i < type.val.paramTypes.length; i++) {
      if (verifyDataType(type.val.paramTypes[i], position, table, validGenerics) == false) {
        return false;
      }
    }
    if (verifyDataType(type.val.returnType, position, table, validGenerics) == false) {
      return false;
    }
    return true;
  }

  logError(position, 'unknown datatype');
  return false;
}

function verifyStruct(struct: Parse.Struct, table: Type.RefTable): boolean {
  let invalidField = false;
  for (let field of struct.fields) {
    if (verifyDataType(field.t, field.position, table, struct.header.generics) == false) {
      invalidField = true;
    }
  }

  for (let i = 0; i < struct.fields.length; i++) {
    for (let j = 0; j < struct.fields.length; j++) {
      if (i == j) {
        continue;
      }

      if (struct.fields[i].name == struct.fields[j].name) {
        logError(struct.fields[j].position, 'repeated field');
        return false;
      }
    }
  }
  
  return !invalidField;
}

// recursively add all the generics to the set given the parse type
function addGenerics(paramType: Parse.Type, generics: Set<string>) {
  if (paramType.tag == 'basic' && paramType.val.length == 1) {
    generics.add(paramType.val);
  }

  if (paramType.tag == 'ptr') {
    addGenerics(paramType.val, generics);
  }

  if (paramType.tag == 'link') {
    addGenerics(paramType.val, generics);
  }

  if (paramType.tag == 'generic') {
    for (let generic of paramType.val.generics) {
      addGenerics(generic, generics);
    }
  }

  if (paramType.tag == 'fn') {
    addGenerics(paramType.val.returnType, generics);
    for (let g of paramType.val.paramTypes) {
      addGenerics(g, generics);
    }
  }
}

function analyzeFn(
  fn: Parse.Fn,
  table: Type.RefTable,
  unit: Parse.ProgramUnit,
  scope: FnContext,
): Fn | null {

  enterScope(scope);

  let paramTypes: Type.Type[] = [];
  let linkedParams: boolean[] = [];
  for (let i = 0; i < fn.paramNames.length; i++) {
    let paramType = fn.t.paramTypes[i];
    let mut = false;
    if (paramType.tag == 'link') {
      paramType = paramType.val;
      mut = true;
    }

    linkedParams.push(mut);

    let resolvedParamType = Type.resolveType(fn.t.paramTypes[i], table, fn.position);
    if (resolvedParamType == null) {
      return null;
    }

    setValToScope(scope, fn.paramNames[i], resolvedParamType, mut, 'param');
    paramTypes.push(resolvedParamType);
  }

  if (allElifFollowIf(fn.body) == false) {
    return null;
  }

  let body = analyzeInstBody(fn.body, table, scope);
  if (body == null) {
    return null;
  }

  if (!Type.typeApplicable(Type.VOID, scope.returnType, false) && allPaths(body, 'return') == false) {
    logError(fn.position, 'function does not always return');
    return null;
  }


  let fnType: Type.Type = { 
    tag: 'fn',
    val: {
      paramTypes,
      returnType: scope.returnType,
      linkedParams 
    }
  };
  return {
    name: fn.name,
    unitName: unit.fullName,
    body,
    type: fnType,
    paramNames: fn.paramNames,
    scope,
    refTable: table
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
  body: Parse.Inst[],
  table: Type.RefTable,
  scope: FnContext,
): Inst[] | null {
  enterScope(scope);

  let newBody: Inst[] = [];
  let isValid = true;
  for (let i = 0; i < body.length; i++) {
    let tag = body[i].tag;
    let inst;
    if (tag == 'if' || tag == 'while' || tag == 'elif' || tag == 'else') {
      inst = analyzeCond(body[i], newBody, table, scope);
    } else {
      inst = analyzeInst(body[i], table, scope);
    }

    if (inst == null) {
      isValid = false;
    } else if (newBody != null) {
      newBody.push(inst);
    }
  }

  exitScope(scope);
  if (isValid) {
    return newBody;
  }
  return null;
}

function analyzeCond(
  inst: Parse.Inst,
  prevInsts: Inst[], 
  table: Type.RefTable,
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
    cond = ensureExprValid(inst.val.cond, Type.BOOL, table, scope, inst.position);
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
    body = analyzeInstBody(inst.val.body, table, scope);
  }
  else if (inst.tag == 'else') {
    body = analyzeInstBody(inst.val, table, scope);
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
  inst: Parse.Inst,
  table: Type.RefTable,
  scope: FnContext,
): Inst | null {
  if (inst.tag == 'include') {
    let newTypes: Type.Type[] = [];
    for (let type of inst.val.types) {
      let newType: Type.Type | null = Type.resolveType(type, table, inst.position);
      if (newType == null) {
        return null;
      }
      newTypes.push(newType);
    }

    return { tag: 'include', val: { lines: inst.val.lines, types: newTypes }, position: inst.position };
  }

  if (inst.tag == 'for_in') {
    let iterExpr = ensureExprValid(inst.val.iter, null, table, scope, inst.position);
    if (iterExpr == null) {
      return null;
    }

    let fnResult =  Type.resolveFn('next', null, null, [iterExpr.type], table, inst.position);
    if (fnResult == null || fnResult.fnType.tag != 'fn') {
      logError(inst.position, 'value can not be used as an iterator');
      return null;
    }

    let returnType = fnResult.fnType.val.returnType;
    if (returnType.tag == 'ptr') {
      let iterType = returnType.val;
      scope.inLoop = true;
      enterScope(scope);
      setValToScope(scope, inst.val.varName, iterType, false, 'iter');
      let body = analyzeInstBody(inst.val.body, table, scope);
      exitScope(scope);
      if (body == null) {
        return null;
      }

      return {
        tag: 'for_in',
        val: {
          varName: inst.val.varName,
          iter: iterExpr,
          nextFn: {
            tag: 'fn',
            refTable: table,
            fnName: fnResult.fnName,
            unitName: fnResult.unitName,
            type: fnResult.fnType,
            extern: false
          },
          body: body 
        },
        position: inst.position
      };
    }

    logError(inst.position, 'expected pointer in "next"');
    return null;
  }

  if (inst.tag == 'arena') {
    let body = analyzeInstBody(inst.val, table, scope);
    if (body == null) {
      return null;
    }
    return { tag: 'arena', val: body, position: inst.position };
  }

  if (inst.tag == 'break' || inst.tag == 'continue') {
    if (!scope.inLoop) {
      logError(inst.position, inst.tag + ' must be used in a loop');
      return null;
    }
    return { tag: inst.tag, position: inst.position };
  } 

  if (inst.tag == 'return_void') {
    if (!Type.typeApplicable(scope.returnType, Type.VOID, false)) {
      logError(inst.position, 'returning from non-void fn without expression');
      return null;
    }
    return { tag: 'return', val: null, position: inst.position };
  } 

  if (inst.tag == 'return') {
    let expr = ensureExprValid(inst.val, scope.returnType, table, scope, inst.position);
    if (expr == null) {
      return null;
    }
    return { tag: 'return', val: expr, position: inst.position };
  } 

  if (inst.tag == 'expr') {
    if (inst.val.tag == 'assert' && inst.val.val.tag != 'fn_call') {
      let exprTuple = ensureExprValid(inst.val.val, Type.BOOL, table, scope, inst.position);
      if (exprTuple == null) {
        return null;
      }

      Enum.applyCond(scope.variantScope, exprTuple, []);
      let expr: Expr = { tag: 'assert_bool', val: exprTuple, type: Type.VOID };
      return { tag: 'expr', val: expr, position: inst.position }
    }
    else if (inst.val.tag == 'assert' || inst.val.tag == 'try' || inst.val.tag == 'fn_call') {
      let exprTuple = ensureExprValid(inst.val, Type.VOID, table, scope, inst.position);
      if (exprTuple == null) {
        return null;
      }
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

    let declareType = Type.resolveType(inst.val.t, table, inst.position);
    if (declareType == null) {
      return null;
    }

    setValToScope(scope, inst.val.name, declareType, true, 'none');

    let expr = null;
    if (inst.val.expr) {
      expr = ensureExprValid(inst.val.expr, declareType, table, scope, inst.position);
      if (expr == null) {
        return null;
      }
    }

    let leftExpr: LeftExpr = { tag: 'var', mode: 'none', val: inst.val.name, type: declareType };
    Enum.remove(scope.variantScope, leftExpr);
    if (expr != null) {
      Enum.recursiveAddExpr(scope.variantScope, leftExpr, expr);
    }

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
    // note that direct assign is not checked yet this just validates the leftExpr
    // works isolated
    let to = ensureLeftExprValid(inst.val.to, null, null, table, scope, inst.position);
    if (to == null) {
      return null;
    }

    if (to.tag == 'arr_offset_slice') {
      logError(inst.position, 'can not assign to a slice');
      return null;
    }

    if (canMutate(to, table, scope) == false) {
      logError(inst.position, 'value can not be mutated');
      return null;
    }

    if (inst.val.op == '+=' && Type.typeApplicable(to.type, Type.STR_BUF, false)) {
      let expr = ensureExprValid(inst.val.expr, null, table, scope, inst.position);
      if (expr == null) {
        return null;
      }

      let strImpl = Type.resolveFn('str', null, Type.STR, [expr.type], table, inst.position);
      if (strImpl == null) {
        return null;
      }

      let implFnExpr: Expr = {
        tag: 'left_expr',
        val: {
          tag: 'fn',
          unitName: strImpl.unitName,
          fnName: strImpl.fnName,
          refTable: table,
          extern: false,
          type: strImpl.fnType
        },
        type: strImpl.fnType
      }

      let appendFn = Type.resolveFn('append', null, Type.VOID, [Type.STR_BUF, expr.type], table, inst.position);
      if (appendFn == null) {
        logError(inst.position, "could not find 'append'");
        return null;
      }
      return {
        tag: 'expr',
        position: inst.position,
        val: {
          tag: 'fn_call',
          val: {
            exprs: [
              {
                tag: 'left_expr',
                val: to,
                type: to.type
              },
              expr,
              implFnExpr
            ],
            fn: {
              tag: 'fn',
              unitName: appendFn.unitName,
              fnName: appendFn.fnName,
              type: appendFn.fnType,
              extern: false,
              refTable: table
            }
          },
          type: Type.VOID
        }
      };
    }

    if (inst.val.op == '+=' && to.type.tag != 'primative') {
      let expr = ensureExprValid(inst.val.expr, null, table, scope, inst.position);
      if (expr == null) {
        return null;
      }

      let appendFn = Type.resolveFn('append', null, Type.VOID, [to.type, expr.type], table, inst.position);
      if (appendFn == null) {
        logError(inst.position, "'append' does not exist");
        return null;
      }

      return {
        tag: 'expr',
        position: inst.position,
        val: {
          tag: 'fn_call',
          val: {
            exprs: [
              {
                tag: 'left_expr',
                val: to,
                type: to.type
              },
              expr
            ],
            fn: {
              tag: 'fn',
              unitName: appendFn.unitName,
              fnName: appendFn.fnName,
              type: appendFn.fnType,
              refTable: table,
              extern: false
            }
          },
          type: Type.VOID
        }
      };
    }

    let expr = ensureExprValid(inst.val.expr, to.type, table, scope, inst.position);
    if (expr == null) {
      return null;
    }

    // give it the value to use in the direct assign
    to = ensureLeftExprValid(inst.val.to, null, expr, table, scope, inst.position);
    if (to == null) {
      return null;
    }

    // += on strbuf
    if (inst.val.op == '+=' || inst.val.op == '-=') {
      if (Type.canMath(to.type, expr.type, table) == null) {
        logError(inst.position, inst.val.op + ` is not supported on type ${Type.toStr(to.type)}`);
        return null;
      }
    }

    if (Type.isComplex(expr.type) && expr.tag == 'left_expr') {
      logError(inst.position, 'assignment of complex type - mv or cp');
      return null;
    }

    Enum.remove(scope.variantScope, to);
    if (inst.val.op == '=') {
      Enum.recursiveAddExpr(scope.variantScope, to, expr);
    }

    return { tag: 'assign', val: { to: to , expr: expr, op: inst.val.op }, position: inst.position };
  } 

  logError(inst.position, 'compiler error analyzeInst');
  return null;
}

function canMutate(leftExpr: LeftExpr, table: Type.RefTable, scope: FnContext): boolean {
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

interface FnTypeHint {
  paramTypes: (Type.Type | null)[]
  returnType: Type.Type | null
  resolve: boolean
}

function ensureLeftExprValid(
  leftExpr: Parse.LeftExpr,
  // gives the leftExpr permission to do a search in the global scope
  // to find the correct function
  fnTypeHint: FnTypeHint | null,
  // if the leftExpr is used directly on the left side of an assign
  // instruction it may be used differently (ex: getIndex vs setIndex)
  directAssign: Expr | null,
  table: Type.RefTable,
  scope: FnContext,
  position: Position,
  ignoreErrors: boolean = false
): LeftExpr | null {

  let modName: string | null = null;
  let modVarName: string | null = null;
  if (leftExpr.tag == 'dot') {
    modName = isModule(scope, leftExpr.val.left, table)
    modVarName = leftExpr.val.varName;
  }

  if (leftExpr.tag == 'var') {
    let v = getVar(scope, leftExpr.val, table);
    if (v != null) {
      let validLeftExpr: LeftExpr = { tag: 'var', val: leftExpr.val, mode: v.mode, type: v.type };
      // try to turn type union in to proper type
      if (v.type.tag == 'enum' && v.type.val.id == 'std/core.TypeUnion') {
        let possible = Enum.getVariantPossibilities(scope.variantScope, validLeftExpr);
        if (possible.length == 0) {
          if (!ignoreErrors) {
            logError(position, 'no variant possible');
          }
          return null;
        }
        else if (possible.length > 1) {
          return validLeftExpr;
        }

        let fieldIndex = v.type.val.fields.findIndex(x => x.name == possible[0]);
        let currentVariantType = v.type.val.fields[fieldIndex].type;

        return {
          tag: 'prime',
          val: {
            tag: 'left_expr',
            val: validLeftExpr,
            type: v.type
          },
          variant: possible[0],
          variantIndex: fieldIndex,
          type: currentVariantType  
        };
      }
      return validLeftExpr;
    }
  }

  if (leftExpr.tag == 'var' || modName != null) {
    let varName: string = '';
    if (modVarName != null) {
      varName = modVarName;
    }
    else if (leftExpr.tag == 'var') {
      varName = leftExpr.val;
    }

    if (fnTypeHint != null) {
      let fn = Type.resolveFn(
        varName,
        modName,
        fnTypeHint.returnType,
        fnTypeHint.paramTypes,
        fnTypeHint.resolve ? null : table,
        ignoreErrors ? null : position
      );

      if (fn == null) {
        return null;
      }

      return { 
        tag: 'fn',
        fnName: fn.fnName,
        unitName: fn.unitName,
        type: fn.fnType,
        refTable: table,
        extern: fn.extern
      };
    } 

    let fn = Type.resolveFn(
      varName,
      modName,
      null,
      null,
      table,
      ignoreErrors ? null : position
    );
    if (fn == null) {
      return null;
    }

    return {
      tag: 'fn',
      fnName: fn.fnName,
      unitName: fn.unitName,
      type: fn.fnType,
      refTable: table,
      extern: fn.extern
    };
  }
  else if (leftExpr.tag == 'dot') {
    let validExpr = ensureExprValid(leftExpr.val.left, null, table, scope, position);
    if (validExpr == null) {
      return null;
    }

    if (validExpr.type.tag == 'enum') {
      if (validExpr.tag == 'left_expr') {
        let possibleVariants = Enum.getVariantPossibilities(scope.variantScope, validExpr.val);
        if (possibleVariants.length == 0) {
          if (!ignoreErrors) {
            logError(position, 'no variant possible');
          }
          return null;
        }
        else if (possibleVariants.length > 1) {
          if (!ignoreErrors) {
            logError(position, `enum can be ${ JSON.stringify(possibleVariants) }`);
          }
          return null;
        }

        let hasField = validExpr.type.val.fields.findIndex(x => x.name == leftExpr.val.varName) != -1;
        if (hasField && possibleVariants[0] != leftExpr.val.varName) {
          if (!ignoreErrors) {
            logError(position, `invalid access of variant '${leftExpr.val.varName}' - value is '${possibleVariants[0]}'`)
          }
          return null;
        }

        if (validExpr.type.tag == 'enum') {
          let innerType = validExpr.type.val.fields.filter(x => x.name == possibleVariants[0])[0].type;
          return {
            tag: 'prime',
            val: validExpr,
            variantIndex: Type.getVariantIndex(validExpr.type, possibleVariants[0]),
            variant: possibleVariants[0],
            type: innerType 
          };
        }

        if (!ignoreErrors) {
          logError(position, 'enum variant does not exist');
        }
        return null;
      }
    }

    if (validExpr.type.tag != 'struct') {
      if (!ignoreErrors) {
        logError(position, `dot op not applicable to ${Type.toStr(validExpr.type)}`);
      }
      return null;
    }

    let unitName = Type.getUnitNameOfStruct(validExpr.type.val);
    let inSameUnit: boolean = unitName == table.thisUnit.fullName;
    for (let field of validExpr.type.val.fields) {
      if (field.name == leftExpr.val.varName) {
        if (field.visibility == null && !inSameUnit) {
          if (!ignoreErrors) {
            logError(position, `access of private field '${field.name}'`);
          }
          return null;
        }

        let dotOp: LeftExpr = {
          tag: 'dot',
          val: {
            left: validExpr,
            varName: field.name 
          },
          type: field.type
        };
        return dotOp;
      }
    }

    if (!ignoreErrors) {
      logError(position, `field ${leftExpr.val.varName} not in ${Type.toStr(validExpr.type)}`);
    }
    return null;
  } 
  else if (leftExpr.tag == 'arr_offset') {
    let arr = ensureExprValid(leftExpr.val.var, null, table, scope, position);
    if (arr == null) {
      return null;
    }

    let index = ensureExprValid(leftExpr.val.index, null, table, scope, position);
    if (index == null) {
      return null;
    }

    let operation: Type.OperatorResult;
    if (directAssign == null) {
      operation = Type.canGetIndex(arr.type, index.type, table); 
    }
    else {
      operation = Type.canSetIndex(arr.type, index.type, directAssign.type, table); 
    }

    if (operation == null && directAssign == null) {
      if (!ignoreErrors) {
        logError(position, `getIndex not defined for ${Type.toStr(arr.type)} with ${Type.toStr(index.type)}`);
      }
      return null;
    }
    else if (operation == null) {
      if (!ignoreErrors) {
        logError(position, `prepareIndex not defined for ${Type.toStr(arr.type)} with ${Type.toStr(index.type)}`);
      }
      return null;
    }
    else if (operation.tag == 'default') {
      if (index.type.tag == 'primative') {
        let newExpr: LeftExpr = { 
          tag: 'arr_offset_int',
          val: {
            var: arr,
            index: index
          },
          type: operation.returnType
        };
        return newExpr;
      }
      else {
        let newExpr: LeftExpr = { 
          tag: 'arr_offset_slice',
          val: {
            var: arr,
            range: index
          },
          type: arr.type  
        };
        return newExpr;
      }
    }
    else if (operation.tag == 'fn' && directAssign == null) {
      if (operation.fnType.tag != 'fn') {
        compilerError('fn type should be fn');
        return null;
      }

      // check again based on the type (turning option into results)
      let recalcArr = ensureExprValid(leftExpr.val.var, operation.fnType.val.paramTypes[0], table, scope, position);
      let recalcIndex = ensureExprValid(leftExpr.val.index, operation.fnType.val.paramTypes[1], table, scope, position);
      if (recalcIndex == null || recalcArr == null) {
        compilerError('should always be valid');
        return null;
      }

      let memLoc: Expr = {
        tag: 'fn_call',
        val: {
          fn: {
            tag: 'fn',
            fnName: operation.fnName,
            refTable: table,
            unitName: operation.unitName,
            type: operation.fnType,
            extern: false
          },
          exprs: [recalcArr, recalcIndex]
        },
        type: operation.returnType
      }

      if (operation.returnType.tag != 'ptr') {
        logError(leftExpr.val.var.position, 'expected a ptr');
        return null;
      }

      return {
        tag: 'arr_offset_int',
        val: {
          var: memLoc,
          index: { tag: 'int_const', val: 0, type: Type.INT }
        },
        type: operation.returnType.val
      }
    }
    else if (operation.tag == 'fn' && directAssign != null) {
      if (operation.fnType.tag != 'fn') {
        compilerError('fn type should be fn');
        return null;
      }

      // check again based on the type (turning option into results)
      let recalcArr = ensureExprValid(leftExpr.val.var, operation.fnType.val.paramTypes[0], table, scope, position);
      let recalcIndex = ensureExprValid(leftExpr.val.index, operation.fnType.val.paramTypes[1], table, scope, position);
      if (recalcIndex == null || recalcArr == null) {
        compilerError('should always be valid');
        return null;
      }

      let memLoc: Expr = {
        tag: 'fn_call',
        val: {
          fn: {
            tag: 'fn',
            refTable: table,
            fnName: operation.fnName,
            unitName: operation.unitName,
            extern: false,
            type: operation.fnType,
          },
          exprs: [recalcArr, recalcIndex, directAssign]
        },
        type: operation.returnType
      }
      if (operation.returnType.tag != 'ptr') {
        logError(leftExpr.val.var.position, 'expected a ptr');
        return null;
      }

      return {
        tag: 'arr_offset_int',
        val: {
          var: memLoc,
          index: { tag: 'int_const', val: 0, type: Type.INT }
        },
        type: operation.returnType.val
      }
    }

    if (!ignoreErrors) {
      logError(position, 'arr must be indexed with range or int');
    }
    return null;
  } 
  else if (leftExpr.tag == 'prime') {
    compilerError('prime not supported anymore')
    return null;
  }

  compilerError('ensureLeftExprValid left expression not handled');
  return null;
}

function ensureFnCallValid(
  fnCall: Parse.FnCall,
  expectedReturn: Type.Type | null,
  table: Type.RefTable, 
  scope: FnContext,
  position: Position,
  ignoreErrors: boolean = false
): Expr | null {

  // setup check the types of params for use in attempting
  // to determine which function will be called
  let initParamTypes: (Type.Type | null)[] = [];
  let resolve = false;
  for (let i = 0; i < fnCall.exprs.length; i++) {
    // skip named params to resolve later
    if (fnCall.names[i] != '') {
      continue;
    }

    let expr: Parse.Expr = fnCall.exprs[i] ;
    let validExpr = ensureExprValid(expr, null, table, scope, position, true);
    if (validExpr == null) {
      initParamTypes.push(null);
    }
    else {
      if (validExpr.tag == 'resolve') {
        initParamTypes.push(null);
        resolve = true;
      }
      else {
        initParamTypes.push(validExpr.type);
      }
    }
  }

  let fnTypeHint: FnTypeHint = { returnType: expectedReturn, paramTypes: initParamTypes, resolve };
  let fnResult = ensureLeftExprValid(fnCall.fn, fnTypeHint, null, table, scope, position, ignoreErrors);
  if (fnResult == null) {
    return null;
  } 

  // now that the function is found, we can use the param types of that function
  // to determine the types of the expressions
  let fnType = fnResult.type;

  // it is a function declared in the scope, ensure that fnType fits the params and return type
  if (fnType.tag != 'fn') {
    if (!ignoreErrors) {
      logError(position, `${Type.toStr(fnType)} type is not a function`);
    }
    return null;
  }

  let paramTypes: Type.Type[] = [];
  let paramExprs: Expr[] = [];
  for (let i = 0; i < fnCall.exprs.length; i++) {
    // skip named params to resolve later
    if (fnCall.names[i] != '') {
      continue;
    }

    let resolvedExpr = ensureExprValid(fnCall.exprs[i], fnType.val.paramTypes[i], table, scope, position, false);
    if (resolvedExpr == null) {
      return null;
    }
    paramExprs.push(resolvedExpr);
    paramTypes.push(resolvedExpr.type);
  }

  if (fnResult.tag == 'fn') {
    // we now have the function so we can do analysis on named params
    let namedParams: Type.NamedParam[] = Type.getFnNamedParams(fnResult.unitName, fnResult.fnName, fnResult.type, table, position);

    for (let i = 0; i < namedParams.length; i++) {
      let namedParamExpr: Parse.Expr = namedParams[i].expr;
      let overruled = false;
      for (let j = 0; j < fnCall.names.length; j++) {
        if (namedParams[i].name == fnCall.names[j]) {
          // overrule the named parameter expression
          namedParamExpr = fnCall.exprs[j];
          overruled = true;
        }
      }

      let expr: Expr;
      let paramType = namedParams[i].type;
      // for fn='resolve'
      if (!overruled && namedParamExpr.tag == 'left_expr' && paramType.tag == 'fn') {
        if (namedParamExpr.val.tag != 'var') {
          if (!ignoreErrors) {
            logError(position, 'function named parameter must have a name');
          }
          return null;
        }

        // the name of the function that will be resolved
        let resolveName: string = namedParamExpr.val.val;

        let returnType = paramType.val.returnType;
        let thisParamTypes = paramType.val.paramTypes;
        let fnResult = Type.resolveFn(resolveName, null, returnType, thisParamTypes, table, position);
        if (fnResult == null) {
          return null;
        }

        expr = {
          tag: 'left_expr',
          val: {
            tag: 'fn',
            refTable: table,
            type: paramType,
            fnName: fnResult.fnName,
            unitName: fnResult.unitName,
            extern: false
          },
          type: paramType,
        };
      }
      else {
        let exprResult = ensureExprValid(namedParamExpr, namedParams[i].type, table, scope, position);
        if (exprResult == null) {
          return null;
        }
        expr = exprResult;
      }

      paramExprs.push(expr);
      paramTypes.push(paramType);
    }
  }

  if (fnType.val.paramTypes.length != paramTypes.length) {
    if (!ignoreErrors) {
      logError(position, 'invalid parameter number');
    }
    return null;
  }

  /*
  for (let i = 0; i < paramTypes.length; i++) {
    if (Type.typeApplicable(paramTypes[i], fnType.val.paramTypes[i], true) == false) {
      if (!ignoreErrors) {
        logError(position, `invalid type for parameter ${i}`);
      }
      return null;
    }
  }
  */

  if (expectedReturn != null && Type.typeApplicable(fnType.val.returnType, expectedReturn, true) == false) {
    if (Type.typeApplicable(expectedReturn, Type.VOID, false)) {
      if (!ignoreErrors) {
        logError(position, 'return value must be handled');
      }
      return null;
    }

    if (!ignoreErrors) {
      logError(position, 'invalid return type');
    }
    return null;
  }

  // remove all linked parameters from valid enums
  if (fnType.tag == 'fn') {
    for (let i = 0; i < paramExprs.length; i++) {
      let expr = paramExprs[i];
      if (fnType.val.linkedParams[i] && expr.tag == 'left_expr') {
        Enum.remove(scope.variantScope, expr.val);
      }
    }
  }

  let newLeftExpr: LeftExpr = JSON.parse(JSON.stringify(fnResult));
  if (newLeftExpr.type.tag != 'fn') {
    compilerError('should always be fn type');
    return null;
  }

  // overwrite in case of generic default params
  newLeftExpr.type.val.paramTypes = paramTypes;

  let newExpr: Expr = { 
    tag: 'fn_call',
    val: {
      fn: newLeftExpr,
      exprs: paramExprs  
    },
    type: fnType.val.returnType
  };
  return newExpr;
}

function ensureBinOpValid(
  expr: Parse.BinExpr,
  expectedReturn: Type.Type | null,
  table: Type.RefTable,
  scope: FnContext,
  position: Position
): Expr | null {

  let computedExpr: Expr | null = null; 
  if (expr.op == ':') {
    let leftTuple = ensureExprValid(expr.left, Type.INT, table, scope, position);
    let rightTuple = ensureExprValid(expr.right, Type.INT, table, scope, position);
    if (leftTuple == null || rightTuple == null) {
      return null;
    }

    let rangeInitExpr: Expr = {
      tag: 'struct_init',
      val: [
        { name: 'start', expr: leftTuple },
        { name: 'end', expr: rightTuple }
      ],
      type: Type.RANGE
    };

    computedExpr = rangeInitExpr;
  }
  else if (expr.op == '&&') {
    let exprLeft = ensureExprValid(expr.left, Type.BOOL, table, scope, position);
    if (exprLeft == null) {
      return null;
    }

    // the left side of the && can be used on the right
    Enum.enterScope(scope.variantScope);
    Enum.applyCond(scope.variantScope, exprLeft, []);
    let exprRight = ensureExprValid(expr.right, Type.BOOL, table, scope, position);
    Enum.exitScope(scope.variantScope);
    if (exprRight == null) {
      return null;
    }

    computedExpr = {
      tag: 'bin',
      val: {
        op: '&&',
        left: exprLeft,
        right: exprRight
      },
      type: Type.BOOL
    }
  }
  else if (expr.op == '||') {
    let exprLeft = ensureExprValid(expr.left, Type.BOOL, table, scope, position);
    if (exprLeft == null) {
      return null;
    }

    // the left side of the && can be used on the right
    Enum.enterScope(scope.variantScope);
    Enum.applyInverseCond(scope.variantScope, exprLeft, []);
    let exprRight = ensureExprValid(expr.right, Type.BOOL, table, scope, position);
    Enum.exitScope(scope.variantScope);
    if (exprRight == null) {
      return null;
    }

    computedExpr = {
      tag: 'bin',
      val: {
        op: '||',
        left: exprLeft,
        right: exprRight
      },
      type: Type.BOOL
    }
  }
  else {
    let exprLeft = ensureExprValid(expr.left, null, table, scope, position);
    if (exprLeft == null) {
      return null;
    }

    let exprRight = ensureExprValid(expr.right, null, table, scope, position);
    if (exprRight == null) {
      return null;
    }

    let op = expr.op;
    let testFn: (a: Type.Type, b: Type.Type, table: Type.RefTable) => Type.OperatorResult = () => null;
    if (op == '+' || op == '-' || op == '*' || op == '/' || op == '%') {
      testFn = Type.canMath;
    }
    else if (op == '<' || op == '>' || op == '<=' || op == '>=') {
      testFn = Type.canOrder;
    }
    else if (op == '==' || op == '!=') {
      testFn = Type.canEq;
    }
    else if (op == '|' || op == '&' || op == '^') {
      testFn = Type.canBitwise
    }

    let operation = testFn(exprLeft.type, exprRight.type, table);
    if (operation == null) {
      logError(position, `operator ${expr.op} not defined for type ${Type.toStr(exprLeft.type)}, ${Type.toStr(exprRight.type)}`);
      return null;
    }
    else if (operation.tag == 'default') {
      computedExpr = {
        tag: 'bin',
        val: {
          op,
          left: exprLeft,
          right: exprRight
        },
        type: operation.returnType
      }
    }
    else if (operation.tag == 'fn') {
      let exprs: Expr[] = [exprLeft, exprRight];

      computedExpr = {
        tag: 'fn_call',
        val: {
          fn: {
            tag: 'fn',
            fnName: operation.fnName,
            refTable: table,
            unitName: operation.unitName,
            type: operation.fnType,
            extern: false
          },
          exprs
        },
        type: operation.returnType
      }

      if (op == '!=') {
        computedExpr = {
          tag: 'not',
          val: computedExpr,
          type: Type.BOOL,
        }
      }

      if (op == '>' || op == '<' || op == '>=' || op == '<=') {
        computedExpr = {
          tag: 'bin',
          val: {
            op,
            left: computedExpr,
            right: { tag: 'int_const', val: 0, type: Type.INT }
          },
          type: Type.BOOL
        }
      }
    }
  }

  if (expectedReturn != null) {
    if (computedExpr == null) {
      logError(position, 'ensureExprValid compiler bug');
      return null;
    }

    if (Type.typeApplicable(computedExpr.type, expectedReturn, false) == false) {
      logError(position, `expected ${Type.toStr(expectedReturn)} found ${Type.toStr(computedExpr.type)}`);
      return null;
    }
  }
  return computedExpr;
}

function ensureExprValid(
  expr: Parse.Expr, 
  // expected return is provided when the expression return type is known
  // which helps with struct typing and generic functions
  expectedReturn: Type.Type | null,
  table: Type.RefTable,
  scope: FnContext,
  position: Position,
  ignoreErrors: boolean = false
): Expr | null {
  let computedExpr: Expr | null = null; 

  if (expectedReturn != null && expectedReturn.tag == 'enum' 
    && expectedReturn.val.id == 'std/core.TypeUnion') {

    let fields = expectedReturn.val.fields;
    let first = ensureExprValid(expr, fields[0].type, table, scope, position, true);
    if (first != null) {
      return {
        tag: 'enum_init',
        type: expectedReturn,
        fieldExpr: first,
        fieldName: 'val0',
        variantIndex: 0
      };
    }

    let second = ensureExprValid(expr, fields[1].type, table, scope, position, true);
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
      logError(expr.position, 'pointer on valid on left expr');
      return null;
    }
    let inner = ensureLeftExprValid(expr.val.val, null, null, table, scope, position, false);
    if (inner == null) {
      return null;
    }
    computedExpr = {
      tag: 'ptr',
      val: inner,
      type: { tag: 'ptr', val: inner.type }
    };
  }

  if (expr.tag == 'resolve') {
    let inner = ensureExprValid(expr.val, null, table, scope, position, false);
    if (inner == null) {
      return null;
    }

    if (inner.type.tag != 'generic') {
      logError(position, 'expected generic on resolve');
      return null;
    }

    computedExpr = {
      tag: 'resolve',
      val: inner,
      type: inner.type
    };
  }

  if (expr.tag == 'is') {
    let exprLeft = ensureLeftExprValid(expr.val, null, null, table, scope, position, false);
    if (exprLeft == null) {
      return null;
    }

    // T|K when variant is K should be able to T|K is K
    if (exprLeft.type.tag != 'enum') {
      let t = Type.resolveType(expr.right, table, position);
      if (t == null) {
        if (!ignoreErrors) {
          logError(position, 'is operator only valid on enums');
        }
        return null;
      }

      if (Type.typeApplicable(t, exprLeft.type, false) 
        && Type.typeApplicable(exprLeft.type, t, false)) {
        computedExpr = {
          tag: 'bool_const',
          val: true,
          type: Type.BOOL
        }
      }

      if (computedExpr == null) {
        if (!ignoreErrors) {
          logError(position, '\'is\' will always be false');
        }
        return null;
      }
    }

    if (exprLeft.type.tag == 'enum' && expr.right.tag == 'basic') {
      let fieldName: string = expr.right.val;
      if (exprLeft.type.val.id == 'std/core.TypeUnion') {
        let fields = exprLeft.type.val.fields;
        for (let i = 0; i < fields.length; i++) {
          let t = fields[i].type;
          // structs with 0 generics
          if ((t.tag == 'struct' || t.tag == 'enum') && t.val.generics.length == 0 && t.val.id == fieldName
            || t.tag == 'primative' && t.val == fieldName) {
            computedExpr = {
              tag: 'is',
              left: exprLeft,
              variant: 'val' + i,
              variantIndex: i,
              type: Type.BOOL
            }
          }
        }
      }

      if (computedExpr == null) {
        if (exprLeft.type.val.fields.map(f => f.name).includes(fieldName) == false) {
          if (!ignoreErrors) {
            logError(position, `${fieldName} does not exist on enum ${Type.toStr(exprLeft.type)}`);
          }
          return null;
        }

        computedExpr = {
          tag: 'is',
          left: exprLeft,
          variant: fieldName,
          variantIndex: Type.getVariantIndex(exprLeft.type, fieldName),
          type: Type.BOOL 
        };
      }
    }

    if (exprLeft.type.tag == 'enum' && expr.right.tag != 'basic') {
      if (exprLeft.type.val.id != 'std/core.TypeUnion') {
        logError(position, 'expected enum variant');
        return null;
      }
      let fields = exprLeft.type.val.fields;
      for (let i = 0; i < fields.length; i++) {
        let t = Type.resolveType(expr.right, table, position);
        if (t == null) {
          return null;
        }

        if (Type.typeApplicable(t, fields[i].type, false) 
          && Type.typeApplicable(fields[i].type, t, false)) {
          computedExpr = {
            tag: 'is',
            left: exprLeft,
            variant: 'val' + i,
            variantIndex: i,
            type: Type.BOOL
          }
        }
      }
    }

    if (computedExpr == null) {
      if (!ignoreErrors) {
        logError(position, 'is does not match variants');
      }
      return null;
    }
  } 

  if (expr.tag == 'bin') {
    computedExpr = ensureBinOpValid(expr.val, expectedReturn, table, scope, position);
    if (computedExpr == null) {
      return null;
    }
  } 

  if (expr.tag == 'mv' || expr.tag == 'cp') {
    let inner = ensureExprValid(expr.val, expectedReturn, table, scope, position);
    if (inner == null) {
      return null;
    }
    if (expr.tag == 'mv') {
      computedExpr = { tag: 'mv', val: inner, type: inner.type };
    }
    else if (expr.tag == 'cp') {
      computedExpr = { tag: 'cp', val: inner, type: inner.type };
    }
  }

  if (expr.tag == 'try' || expr.tag == 'assert') {
    let errorType: Type.Type | null = null;
    if (expr.tag == 'try') {
      if (scope.returnType.tag == 'enum' && scope.returnType.val.id == 'std/core.TypeUnion') {
        errorType = scope.returnType.val.fields[1].type;
      }
      else {
        if (!ignoreErrors) {
          logError(position, `${expr.tag} operator can only be used in a function returning result`);
        }
        return null;
      }
    }

    let newExpectedType = null;
    if (expectedReturn != null && errorType != null) {
      newExpectedType = Type.createRes(expectedReturn, errorType);
    }

    let validExpr = ensureExprValid(expr.val, newExpectedType, table, scope, position);
    if (validExpr == null) {
      return null;
    }
    if (Type.isRes(validExpr.type) == false) {
      if (!ignoreErrors) {
        logError(position, `${expr.tag} operator can only be used on results`);
      }
      return null;
    }

    if (validExpr.type.tag != 'enum') {
      if (!ignoreErrors) {
        logError(position, 'compiler error');
      }
      return null;
    }

    let resInnerType = validExpr.type.val.fields[0].type;
    if (expr.tag == 'try') {
      return { tag: 'try', val: validExpr, type: resInnerType };
    } else {
      return { tag: 'assert', val: validExpr, type: resInnerType };
    }
  }

  if (expr.tag == 'not') {
    let exprTuple = ensureExprValid(expr.val, Type.BOOL, table, scope, position);
    if (exprTuple == null) {
      return null;
    }
    computedExpr = { tag: 'not', val: exprTuple, type: Type.BOOL };
  } 

  if (expr.tag == 'fn_call') {

    // check if builtin function
    if (expr.val.fn.tag == 'var') {
      let name = expr.val.fn.val;
      if (name == 'bool' || name == 'int' || name == 'char'
        || name == 'i8' || name == 'i16' || name == 'i32'
        || name == 'u8' || name == 'u16' || name == 'u32' || name == 'u64'
        || name == 'f32' || name == 'f64') {

        if (expr.val.exprs.length != 1) {
          if (!ignoreErrors) {
            logError(expr.position, 'ptr expects 1 argument');
          }
          return null;
        }
        let variable = ensureExprValid(expr.val.exprs[0], null, table, scope, position, false);
        if (variable == null) {
          return null;
        }

        if (variable.type.tag != 'primative') {
          if (!ignoreErrors) {
            logError(expr.position, 'cast must be on primitive type');
          }
          return null;
        }

        computedExpr = { 
          tag: 'cast',
          val: variable, 
          type: { tag: 'primative', val: name } 
        };
      }
    }

    // check if it was a C fn
    if (expr.val.fn.tag == 'dot') {
      let mod = expr.val.fn.val.left;
      if (mod.tag == 'left_expr' && mod.val.tag == 'var' && mod.val.val == 'C') {
        let validExprs: Expr[] = [];
        for (let i = 0; i < expr.val.exprs.length; i++) {
          let callExpr = ensureExprValid(expr.val.exprs[i], null, table, scope, position, false);
          if (callExpr == null) {
            return null;
          }
          validExprs.push(callExpr);
        }

        if (expectedReturn == null) {
          if (!ignoreErrors) {
            logError(position, 'C fn can not disambiguate return type');
          }
          return null;
        }

        computedExpr = {
          tag: 'cfn_call',
          exprs: validExprs,
          type: expectedReturn,
          fnName: expr.val.fn.val.varName
        };
      }
    }
    
    // check if initialization of enum
    if (expectedReturn != null
      && expectedReturn.tag == 'enum' 
      && expr.val.fn.tag == 'var' 
      && expr.val.exprs.length == 1
    ) {

      let fieldIndex = expectedReturn.val.fields.map(f => f.name).indexOf(expr.val.fn.val);
      if (fieldIndex != -1) {
        let fieldType: Type.Type = expectedReturn.val.fields[fieldIndex].type;
        let fieldName: string = expectedReturn.val.fields[fieldIndex].name;

        let fieldExpr = ensureExprValid(expr.val.exprs[0], fieldType, table, scope, position);
        if (fieldExpr == null) {
          return null;
        }

        computedExpr = {
          tag: 'enum_init',
          variantIndex: Type.getVariantIndex(expectedReturn, fieldName),
          fieldName,
          fieldExpr,
          type: expectedReturn 
        };
      } 
    } 

    // if there was no enum variant treat it as a normal function call
    if (computedExpr == null) {
      let fnExpr = ensureFnCallValid(expr.val, expectedReturn, table, scope, position, ignoreErrors);
      if (fnExpr == null) {
        return null;
      }

      computedExpr = fnExpr;
    }
  } 

  if (expr.tag == 'list_init') {
    // determine what should be the type of the inner values
    let exprType: Type.Type | null = null;
    if (expectedReturn != null && expectedReturn.tag == 'struct' && expectedReturn.val.id == 'std/core.Arr') {
      let ptrType = expectedReturn.val.fields[0].type;
      if (ptrType.tag != 'ptr') {
        compilerError('expected ptr field');
        return null;
      }
      exprType = ptrType.val;
    }
    else if (!ignoreErrors) {
      logError(position, 'type mismatch expected array');
      return null;
    }

    let newExprs: Expr[] = []
    for (let i = 0; i < expr.val.length; i++) {
      let e = ensureExprValid(expr.val[i], exprType, table, scope, position);
      if (e == null) {
        return null;
      }

      if (Type.isComplex(e.type) && e.tag == 'left_expr') {
        if (!ignoreErrors) {
          logError(expr.val[i].position, 'assignment of complex type - mv or cp');
        }
        return null;
      }

      newExprs.push(e);
      exprType = e.type;
    }

    // ensure that the type is actually known when done
    if (exprType == null) {
      if (!ignoreErrors) {
        logError(position, "unknown arr type")
      }
      return null;
    }

    computedExpr = { tag: 'list_init', val: newExprs, type: Type.createList(exprType) };
  }

  if (expr.tag == 'struct_init') {
    if (expectedReturn == null) {
      if (!ignoreErrors) {
        logError(position, 'struct initialization type is unknown');
      }
      return null;
    }

    if (expectedReturn.tag != 'struct' && !(expectedReturn.tag == 'enum')) {
      if (!ignoreErrors) {
        logError(position, `expected ${Type.toStr(expectedReturn)}`);
      }
      return null;
    }

    let retType: Type.Type = expectedReturn;
    if (retType.tag != 'struct') {
      if (!ignoreErrors) {
        logError(position, `expected ${Type.toStr(retType)}`);
      }
      return null;
    }

    let exprFieldTypes = new Map<string, Type.Type>();
    let exprFieldExprs: Map<string, Expr> = new Map();
    for (let initField of expr.val) {
      let matchingFields = retType.val.fields.filter(x => x.name == initField.name);
      if (matchingFields.length == 0) {
        if (!ignoreErrors) {
          logError(initField.expr.position, `field ${initField.name} does not exist on type`);
        }
        return null;
      }

      let fieldType = matchingFields[0].type;
      let expr = ensureExprValid(initField.expr, fieldType, table, scope, position);
      if (expr == null) {
        return null;
      }

      if (Type.isComplex(expr.type) && expr.tag == 'left_expr') {
        if (!ignoreErrors) {
          logError(initField.expr.position, 'assignment of complex type - mv or cp');
        }
        return null;
      }

      if (exprFieldTypes.has(initField.name)) {
        if (!ignoreErrors) {
          logError(position, 'double initialization of field');
        }
        return null;
      }

      exprFieldTypes.set(initField.name, expr.type);
      exprFieldExprs.set(initField.name, expr);
    }

    if (exprFieldTypes.size != retType.val.fields.length) {
      if (!ignoreErrors) {
        logError(position, 'missing fields');
      }
      return null;
    }

    for (let field of retType.val.fields) {
      if (!exprFieldTypes.has(field.name)) {
        if (!ignoreErrors) {
          logError(position, `required field ${field.name}`);
        }
        return null;
      }

      let exprFieldType = exprFieldTypes.get(field.name)!;
      if (Type.typeApplicable(exprFieldType, field.type, false) == false) {
        if (!ignoreErrors) {
          logError(position, `improper type for ${Type.toStr(retType)}.${field.name}`);
        }
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

  if (expr.tag == 'bool_const') {
    computedExpr = { tag: 'bool_const', val: expr.val, type: Type.BOOL };
  }

  if (expr.tag == 'str_const') {
    computedExpr = { tag: 'str_const', val: expr.val , type: Type.STR };
  } 

  if (expr.tag == 'fmt_str') {
    let newExprs: Expr[] = [];
    for (let fmtExpr of expr.val) {
      let e: Expr | null = ensureExprValid(fmtExpr, null, table, scope, position);

      if (e == null) {
        return null;
      }

      // if the type is not a string, look of the implementation of str and use
      // that instead
      if (!Type.typeApplicable(e.type, Type.STR, false)) {
        let fn = Type.resolveFn('str', null, Type.STR, [e.type], table, position);
        if (fn == null) {
          if (e.type.tag == 'generic' && !ignoreErrors) {
            logError(position, `hint: no implementation of toStr(${Type.toStr(e.type)}). generic may not have toStr`)
          }
          else if (!ignoreErrors) {
            logError(position, `hint: no implementation of toStr(${Type.toStr(e.type)})`)
          }
          return null;
        }

        let fnLiteral: LeftExpr = {
          tag: 'fn',
          unitName: fn.unitName,
          fnName: fn.fnName,
          type: fn.fnType,
          refTable: table,
          extern: false
        };

        let fnCall: Expr = {
          tag: 'fn_call',
          val: {
            fn: fnLiteral,
            exprs: [e]
          },
          type: Type.STR
        };
        e = fnCall;
      }
      newExprs.push(e);
    }
    computedExpr = { tag: 'fmt_str', val: newExprs, type: Type.STR }
  }

  if (expr.tag == 'char_const') {
    computedExpr = { tag: 'char_const', val: expr.val, type: Type.CHAR };
  } 

  if (expr.tag == 'int_const') {
    if (expectedReturn != null && expectedReturn.tag == 'primative') {
      let t = expectedReturn.val;
      if (t == 'i32' || t == 'i16' || t == 'i8' || t == 'u64' || t == 'u32' || t == 'u16' || t == 'u8'
        || t == 'f32' || t == 'f64') {
        computedExpr = { tag: 'int_const', val: expr.val, type: expectedReturn };
      }
    }

    if (computedExpr == null) {
      computedExpr = { tag: 'int_const', val: expr.val, type: Type.INT };
    }
  } 

  if (expr.tag == 'nil_const') {
    if (expectedReturn != null && expectedReturn.tag == 'ptr') {
      computedExpr = { tag: 'nil_const', type: expectedReturn };
    }
    else {
      computedExpr = { tag: 'nil_const', type: Type.VOID }
    }
  }

  if (expr.tag == 'num_const') {
    if (expectedReturn != null && expectedReturn.tag == 'primative' && expectedReturn.val == 'f32') {
      computedExpr = { tag: 'num_const', val: expr.val, type: { tag: 'primative', val: 'f32' } };
    }
    else {
      computedExpr = { tag: 'num_const', val: expr.val, type: { tag: 'primative', val: 'f64' } };
    }
  }

  if (expr.tag == 'left_expr') {
    // see if it is constant enum initialization of a void type
    if (expectedReturn != null && expectedReturn.tag == 'enum' && expr.val.tag == 'var') {
      let fieldIndex = expectedReturn.val.fields.map(f => f.name).indexOf(expr.val.val);
      if (fieldIndex != -1) {
        if (Type.typeApplicable(expectedReturn.val.fields[fieldIndex].type, Type.VOID, false)) {
          let fieldName = expectedReturn.val.fields[fieldIndex].name;
          computedExpr = {
            tag: 'enum_init',
            variantIndex: Type.getVariantIndex(expectedReturn, fieldName),
            fieldName,
            fieldExpr: null,
            type: expectedReturn
          };
        } 
        else {
          if (!ignoreErrors) {
            logError(expr.position, 'enum init expects value - non-void variant');
          }
          return null;
        }
      } 
    }

    // check if it is C namespace
    if (expr.val.tag == 'dot' &&
      expr.val.val.left.tag == 'left_expr'
      && expr.val.val.left.val.tag == 'var'
      && expr.val.val.left.val.val == 'C') {

      if (expectedReturn == null) {
        if (!ignoreErrors) {
          logError(expr.position, 'can not type check C value');
        }
        return null;
      }
      return { 
        tag: 'left_expr',
        val: {
          tag: 'var',
          val: 'none',
          mode: 'C',
          type: expectedReturn
        },
        type: expectedReturn
      }
    }

    if (computedExpr == null) { // normal left expr parsing
      let fnTypeHint: FnTypeHint | null = null;
      if (expectedReturn != null && expectedReturn.tag == 'fn') {
        fnTypeHint = {
          paramTypes: expectedReturn.val.paramTypes,
          returnType: expectedReturn.val.returnType,
          resolve: false
        };
      }

      let exprTuple = ensureLeftExprValid(expr.val, fnTypeHint, null, table, scope, position, ignoreErrors);
      if (exprTuple == null) {
        return null;
      }
      computedExpr = { tag: 'left_expr', val: exprTuple, type: exprTuple.type };
    } 
  }

  if (expectedReturn != null) {
    if (computedExpr == null) {
      if (!ignoreErrors) {
        logError(position, 'ensureExprValid compiler bug');
      }
      return null;
    }
    else if (computedExpr.tag == 'resolve') {
      return computedExpr;
    }

    if (Type.typeApplicable(computedExpr.type, expectedReturn, false) == false) {
      // can not autocast so just error
      if (!ignoreErrors) {
        logError(position, `expected ${Type.toStr(expectedReturn)} found ${Type.toStr(computedExpr.type)}`);
      }
      return null;
    }

  }

  return computedExpr;
}

interface Var {
  type: Type.Type
  mode: Mode
  mut: boolean
}

interface FnContext {
  typeScope: Map<string, Var>[]
  generics: Set<string>, 
  returnType: Type.Type
  inLoop: boolean
  variantScope: Enum.VariantScope 
  consts: Const[]
};

function newScope(returnType: Type.Type, generics: Set<string>, consts: Const[]): FnContext {
  return {
    typeScope: [],
    variantScope: [[]],
    generics,
    returnType: returnType,
    inLoop: false,
    consts
  };
}

function enterScope(scope: FnContext) {
  scope.typeScope.push(new Map());
}

function exitScope(scope: FnContext) {
  scope.typeScope.pop();
}

function setValToScope(scope: FnContext, name: string, type: Type.Type, mut: boolean, mode: Mode) {
  scope.typeScope[scope.typeScope.length - 1].set(name, { type, mut, mode });
}

function getVar(scope: FnContext, name: string, table: Type.RefTable): Var | null {
  for (let i = scope.typeScope.length - 1; i >= 0; i--) {
    if (scope.typeScope[i].has(name)) {
      return scope.typeScope[i].get(name)!;
    }
  }

  // look for it as a constant
  for (let c of scope.consts) {
    if (c.name != name) {
      continue;
    }

    let constInScope = c.unitName == table.thisUnit.fullName;
    for (let use of table.thisUnit.uses) {
      if (use.unitName == c.unitName) {
        constInScope = true;
        break;
      }
    }

    if (constInScope) {
      return {
        type: c.type,
        mut: false,
        mode: { tag: 'const', unitName: c.unitName }
      }
    }
  }

  for (let include of table.includes) {
    if (include.enumConsts.includes(name)) {
      return { type: Type.INT, mut: false, mode: 'C' }
    }
  }
  return null;
}

function isModule(scope: FnContext, expr: Parse.Expr, table: Type.RefTable): string | null {
  if (expr.tag != 'left_expr' || expr.val.tag != 'var') {
    return null;
  }

  let modName = expr.val.val;
  if (getVar(scope, modName, table) != null) {
    return null;
  }

  let uses = table.thisUnit.uses;
  for (let i = 0; i < uses.length; i++) {
    if (uses[i].as == modName) {
      return uses[i].unitName;
    }
  }

  return null;
}
