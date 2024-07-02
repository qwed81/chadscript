import * as Parse from '../parse';
import { logError } from '../index'
import * as Type from './types'
import * as Enum from './enum';

interface Program {
  fns: Fn[]
  strTable: string[]
}

interface Fn {
  name: string
  unitName: string,
  paramNames: string[]
  type: Type.Type 
  body: Inst[]
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
  body: Inst[]
}

interface Include {
  lines: string[],
  types: Type.Type[]
}

type Inst = { tag: 'if', val: CondBody, sourceLine: number }
  | { tag: 'elif', val: CondBody, sourceLine: number }
  | { tag: 'while', val: CondBody, sourceLine: number }
  | { tag: 'for_in', val: ForIn, sourceLine: number }
  | { tag: 'expr', val: Expr, sourceLine: number }
  | { tag: 'else', val: Inst[], sourceLine: number }
  | { tag: 'return', val: Expr | null, sourceLine: number }
  | { tag: 'break', sourceLine: number }
  | { tag: 'continue', sourceLine: number }
  | { tag: 'match', val: Match, sourceLine: number }
  | { tag: 'declare', val: Declare, sourceLine: number }
  | { tag: 'assign', val: Assign, sourceLine: number }
  | { tag: 'include', val: Include, sourceLine: number }

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
  | { tag: 'fn_call', val: FnCall, type: Type.Type }
  | { tag: 'struct_init', val: StructInitField[], type: Type.Type }
  | { tag: 'arr_init', val: Expr[], type: Type.Type }
  | { tag: 'enum_init', fieldName: string, variantIndex: number, fieldExpr: Expr | null, type: Type.Type }
  | { tag: 'str_const', val: number, type: Type.Type }
  | { tag: 'fmt_str', val: Expr[], type: Type.Type }
  | { tag: 'char_const', val: string, type: Type.Type }
  | { tag: 'int_const', val: number, type: Type.Type }
  | { tag: 'bool_const', val: boolean, type: Type.Type }
  | { tag: 'num_const', val: number, type: Type.Type }
  | { tag: 'left_expr', val: LeftExpr, type: Type.Type }

interface DotOp {
  left: Expr
  varName: string
}

interface ArrOffsetInt {
  var: LeftExpr
  index: Expr
}

interface ArrOffsetSlice {
  var: LeftExpr
  range: Expr
}

type LeftExpr = { tag: 'dot', val: DotOp, type: Type.Type }
  | { tag: 'prime', val: Expr, variant: string, variantIndex: number, type: Type.Type }
  | { tag: 'arr_offset_int', val: ArrOffsetInt, type: Type.Type }
  | { tag: 'arr_offset_slice', val: ArrOffsetSlice, type: Type.Type }
  | { tag: 'var', val: string, isParam: boolean, type: Type.Type }
  | { tag: 'fn', unitName: string, fnName: string, type: Type.Type }

export { analyze, Program, Fn, Inst, StructInitField, FnCall, Expr, LeftExpr, allPathsReturn }

function analyze(units: Parse.ProgramUnit[]): Program | null {
  let strTable: string[] = [];
  let validProgram: Program | null = { fns: [], strTable };

  for (let i = 0; i < units.length; i++) {
    if (analyzeUnitDataTypes(units, i) == false) {
      validProgram = null;
    }
  }

  for (let i = 0; i < units.length; i++) {
    let unitFns: Fn[] | null = analyzeUnitFns(units, i, strTable); 
    if (unitFns == null) {
      validProgram = null;
    } else if (validProgram != null) {
      for (let j = 0; j < unitFns.length; j++) {
        validProgram.fns.push(unitFns[j]);
      }
    }
  }

  return validProgram;
}

function analyzeUnitFns(units: Parse.ProgramUnit[], unitIndex: number, strTable: string[]): Fn[] | null {
  let unit = units[unitIndex];
  let lookupTable = Type.getUnitReferences(units[unitIndex], units);

  let fns: Fn[] | null = [];
  for (let fn of unit.fns) {
    let validFn = analyzeFn(fn, lookupTable, unit, strTable);
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
  let lookupTable = Type.getUnitReferences(units[unitIndex], units);

  let invalidDataType = false;
  for (let struct of unit.structs) {
    if (verifyStruct(struct, lookupTable) == false) {
      invalidDataType = true;
    }
  }

  for (let en of unit.enums) {
    if (verifyStruct(en, lookupTable) == false) {
      invalidDataType = true;
    }
  }

  return !invalidDataType;
}

// ensure that the parse type is actually valid
function verifyDataType(
  type: Parse.Type,
  sourceLine: number,
  table: Type.RefTable,
  validGenerics: string[]
): boolean {
  if (type.tag == 'basic') {
    if (type.val.length == 1 && validGenerics.includes(type.val) == false) {
      logError(sourceLine, 'generic not added to struct heading');
      return false;
    }
    let dataType = Type.resolveType(type, table, sourceLine);
    if (dataType == null) {
      return false;
    }
    return true;
  } 

  if (type.tag == 'arr' || type.tag == 'const_arr') {
    return verifyDataType(type.val, sourceLine, table, validGenerics);
  }

  if (type.tag == 'generic') {
    let dataType = Type.resolveType(type, table, sourceLine);
    for (let g of type.val.generics) {
      if (verifyDataType(g, sourceLine, table, validGenerics) == false) {
        return false;
      }
    }
    if (dataType == null) {
      return false;
    }
    return true;
  } 

  if (type.tag == 'link') {
    logError(sourceLine, 'ref not allowed in struct definitions');
    return false;
  } 

  if (type.tag == 'fn') {
    for (let i = 0; i < type.val.paramTypes.length; i++) {
      if (verifyDataType(type.val.paramTypes[i], sourceLine, table, validGenerics) == false) {
        return false;
      }
    }
    if (verifyDataType(type.val.returnType, sourceLine, table, validGenerics) == false) {
      return false;
    }
    return true;
  }

  return false;
}

function verifyStruct(struct: Parse.Struct, table: Type.RefTable): boolean {
  let invalidField = false;
  for (let field of struct.fields) {
    if (verifyDataType(field.t, field.sourceLine, table, struct.header.generics) == false) {
      invalidField = true;
    }
  }

  for (let i = 0; i < struct.fields.length; i++) {
    for (let j = 0; j < struct.fields.length; j++) {
      if (i == j) {
        continue;
      }

      if (struct.fields[i].name == struct.fields[j].name) {
        logError(struct.fields[j].sourceLine, 'repeated field');
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

  if (paramType.tag == 'arr' || paramType.tag == 'link') {
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
  strTable: string[]
): Fn | null {
  let generics: Set<string> = new Set();

  for (let i = 0; i < fn.t.paramTypes.length; i++) {
    let paramType = fn.t.paramTypes[i]; 
    addGenerics(paramType, generics);
  }

  let returnType = Type.resolveType(fn.t.returnType, table, fn.sourceLine);
  if (returnType == null) {
    logError(fn.sourceLine, 'could not resolve return type');
    return null;
  }

  let scope: FnContext = { 
    typeScope: [],
    variantScope: [[]],
    generics,
    returnType: returnType,
    inLoop: false,
    strTable
  };

  enterScope(scope);

  let paramTypes: Type.Type[] = [];
  let linkedParams: boolean[] = [];
  for (let i = 0; i < fn.paramNames.length; i++) {
    let paramType = fn.t.paramTypes[i];
    let mut = false;
    if (paramType.tag == 'link') {
      if (paramType.val.tag == 'arr' || paramType.val.tag == 'const_arr') {
        logError(fn.sourceLine, 'ref not valid for arrays');
        return null;
      }

      paramType = paramType.val;
      mut = true;
    }

    linkedParams.push(mut);

    let resolvedParamType = Type.resolveType(fn.t.paramTypes[i], table, fn.sourceLine);
    if (resolvedParamType == null) {
      return null;
    }

    setValToScope(scope, fn.paramNames[i], resolvedParamType, mut, true);
    paramTypes.push(resolvedParamType);
  }

  if (allElifFollowIf(fn.body) == false) {
    return null;
  }

  let body = analyzeInstBody(fn.body, table, scope);
  if (body == null) {
    return null;
  }

  if (!Type.typeApplicable(returnType, Type.VOID) && allPathsReturn(body) == false) {
    logError(fn.sourceLine, 'function does not always return');
    return null;
  }


  let fnType: Type.Type = { tag: 'fn', val: { paramTypes, returnType, linkedParams } };
  return {
    name: fn.name,
    unitName: unit.fullName,
    body,
    type: fnType,
    paramNames: fn.paramNames,
  };
}

function allElifFollowIf(body: Parse.InstMeta[]): boolean {
  for (let i = 0; i < body.length; i++) {
    let inst = body[i].inst;
    let subBody: Parse.InstMeta[] | null = null;

    // check the condition
    let notFollowsIf = i == 0 || body[i - 1].inst.tag != 'if' && body[i - 1].inst.tag != 'elif';
    if ((inst.tag == 'elif' || inst.tag == 'else') && notFollowsIf) {
      logError(body[i].sourceLine, inst.tag + ' does not follow if');
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

// recursively checks to make sure all paths return
function allPathsReturn(body: Inst[]): boolean {
  let ifGroupings: Inst[][][] = [];
  let currentGroup: Inst[][] = [];
  for (let i = 0; i < body.length; i++) {
    let inst = body[i];
    if (inst.tag == 'return') {
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
      if (allPathsReturn(ifGroupings[i][j]) == false) {
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
  body: Parse.InstMeta[],
  table: Type.RefTable,
  scope: FnContext,
): Inst[] | null {
  enterScope(scope);

  let newBody: Inst[] = [];
  let isValid = true;
  for (let i = 0; i < body.length; i++) {
    let tag = body[i].inst.tag;
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
  instMeta: Parse.InstMeta,
  prevInsts: Inst[], 
  table: Type.RefTable,
  scope: FnContext
): Inst | null {

  let inst = instMeta.inst;
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
    cond = ensureExprValid(inst.val.cond, Type.BOOL, table, scope, instMeta.sourceLine);
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

  if (allPathsReturn(body)) {
    Enum.applyInverseCond(scope.variantScope, cond, ifChain);
  }

  if (inst.tag == 'if' || inst.tag == 'elif' || inst.tag == 'while') {
    return { tag: inst.tag, val: { cond: cond!, body: body }, sourceLine: instMeta.sourceLine };
  } else if (inst.tag == 'else') {
    return { tag: 'else', val: body, sourceLine: instMeta.sourceLine };
  }

  return null;
}

function analyzeInst(
  instMeta: Parse.InstMeta,
  table: Type.RefTable,
  scope: FnContext,
): Inst | null {
  let inst = instMeta.inst;

  if (inst.tag == 'include') {
    let newTypes: Type.Type[] = [];
    for (let type of inst.val.types) {
      let newType: Type.Type | null = Type.resolveType(type, table, instMeta.sourceLine);
      if (newType == null) {
        return null;
      }
      newTypes.push(newType);
    }

    return { tag: 'include', val: { lines: inst.val.lines, types: newTypes }, sourceLine: instMeta.sourceLine };
  }

  if (inst.tag == 'for_in') {
    let iterExpr = ensureExprValid(inst.val.iter, Type.RANGE, table, scope, instMeta.sourceLine);
    if (iterExpr == null) {
      return null;
    }

    scope.inLoop = true;
    enterScope(scope);
    setValToScope(scope, inst.val.varName, Type.INT, false, false);
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
        body: body 
      },
      sourceLine: instMeta.sourceLine
    };
  }

  if (inst.tag == 'match') {
    let exprTuple = ensureExprValid(inst.val.var, null, table, scope, instMeta.sourceLine);
    if (exprTuple == null) {
      return null;
    }

    if (exprTuple.type.tag != 'enum') {
      logError(instMeta.sourceLine, 'match can only be done on enum');
      return null;
    }

    let newBranches: MatchBranch[] = [];
    let usedBranches = new Set<string>();
    let fieldNames: string[] = exprTuple.type.val.fields.map(f => f.name);
    for (let branch of inst.val.branches) {
      if (fieldNames.includes(branch.enumVariant) == false) {
        let errMsg = `'${branch.enumVariant}' is a not variant in enum ${Type.toStr(exprTuple.type)}`;
        logError(branch.sourceLine, errMsg);
        return null;
      }

      if (usedBranches.has(branch.enumVariant)) {
        logError(branch.sourceLine, 'repeated branch ' + branch.enumVariant);
        return null;
      }
      usedBranches.add(branch.enumVariant);

      let newBody: Inst[] | null = analyzeInstBody(branch.body, table, scope);
      if (newBody == null) {
        return null;
      }
      newBranches.push({ enumVariant: branch.enumVariant, body: newBody });
    }

    if (usedBranches.size != fieldNames.length) {
      logError(instMeta.sourceLine, `all variants not provided for enum ${Type.toStr(exprTuple.type)}`);
      return null;
    }

    return { tag: 'match', val: { var: exprTuple, branches: newBranches }, sourceLine: instMeta.sourceLine };
  }

  if (inst.tag == 'break' || inst.tag == 'continue') {
    if (!scope.inLoop) {
      logError(instMeta.sourceLine, inst.tag + ' must be used in a loop');
      return null;
    }
    return { tag: inst.tag, sourceLine: instMeta.sourceLine };
  } 

  if (inst.tag == 'return_void') {
    if (!Type.typeApplicable(scope.returnType, Type.VOID)) {
      logError(instMeta.sourceLine, 'returning from non-void fn without expression');
      return null;
    }
    return { tag: 'return', val: null, sourceLine: instMeta.sourceLine };
  } 

  if (inst.tag == 'return') {
    let expr = ensureExprValid(inst.val, scope.returnType, table, scope, instMeta.sourceLine);
    if (expr == null) {
      return null;
    }
    return { tag: 'return', val: expr, sourceLine: instMeta.sourceLine };
  } 

  if (inst.tag == 'expr') {
    if (inst.val.tag == 'assert' && inst.val.val.tag != 'fn_call') {
      let exprTuple = ensureExprValid(inst.val.val, Type.BOOL, table, scope, instMeta.sourceLine);
      if (exprTuple == null) {
        return null;
      }

      Enum.applyCond(scope.variantScope, exprTuple, []);
      let expr: Expr = { tag: 'assert_bool', val: exprTuple, type: Type.BOOL };
      return { tag: 'expr', val: expr, sourceLine: instMeta.sourceLine }
    }
    else if (inst.val.tag == 'assert' || inst.val.tag == 'try' || inst.val.tag == 'fn_call') {
      let exprTuple = ensureExprValid(inst.val, Type.VOID, table, scope, instMeta.sourceLine);
      if (exprTuple == null) {
        return null;
      }
      return { tag: 'expr', val: exprTuple, sourceLine: instMeta.sourceLine }
    }

    logError(instMeta.sourceLine, 'expression can not be used as statement');
    return null;
  } 

  if (inst.tag == 'declare') {
    if (inst.val.t.tag == 'link') {
      logError(instMeta.sourceLine, 'ref not supported ');
      return null;
    }

    let declareType = Type.resolveType(inst.val.t, table, instMeta.sourceLine);
    if (declareType == null) {
      return null;
    }

    setValToScope(scope, inst.val.name, declareType, true, false);

    let expr = null;
    if (inst.val.expr) {
      expr = ensureExprValid(inst.val.expr, declareType, table, scope, instMeta.sourceLine);
      if (expr == null) {
        return null;
      }
    }

    let leftExpr: LeftExpr = { tag: 'var', isParam: false, val: inst.val.name, type: declareType };
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
      sourceLine: instMeta.sourceLine 
    };
  } 

  if (inst.tag == 'assign') {
    let to = ensureLeftExprValid(inst.val.to, null, table, scope, instMeta.sourceLine);
    if (to == null) {
      return null;
    }

    if (to.tag == 'arr_offset_slice') {
      logError(instMeta.sourceLine, 'can not assign to a slice');
      return null;
    }

    if (canMutate(to, scope) == false) {
      logError(instMeta.sourceLine, 'value can not be mutated');
      return null;
    }

    let expr = ensureExprValid(inst.val.expr, to.type, table, scope, instMeta.sourceLine);
    if (expr == null) {
      return null;
    }

    if (inst.val.op == '+=' || inst.val.op == '-=') {
      if (Type.canMath(to.type, expr.type) == null) {
        logError(instMeta.sourceLine, inst.val.op + ` is not supported on type ${Type.toStr(to.type)}`);
        return null;
      }
    }

    Enum.remove(scope.variantScope, to);
    if (inst.val.op == '=') {
      Enum.recursiveAddExpr(scope.variantScope, to, expr);
    }

    return { tag: 'assign', val: { to: to , expr: expr, op: inst.val.op }, sourceLine: instMeta.sourceLine };
  } 

  logError(instMeta.sourceLine, 'compiler error analyzeInst');
  return null;
}

function canMutate(leftExpr: LeftExpr, scope: FnContext): boolean {
  if (leftExpr.type.tag == 'arr' && leftExpr.type.constant == true) {
    return false;
  }

  if (leftExpr.tag == 'dot') {
    if (leftExpr.val.left.tag != 'left_expr') {
      return false;
    }
    return canMutate(leftExpr.val.left.val, scope);
  } 
  if (leftExpr.tag == 'prime') {
    if (leftExpr.val.tag != 'left_expr') {
      return false;
    }
    return canMutate(leftExpr.val.val, scope);
  }
  else if (leftExpr.tag == 'var') {
    let v = getVar(scope, leftExpr.val);
    if (v == null) {
      return false;
    }
    return v.mut;
  } 
  else if (leftExpr.tag == 'arr_offset_int') {
    return leftExpr.val.var.type.tag == 'arr' || canMutate(leftExpr.val.var, scope);
  }
  else if (leftExpr.tag == 'arr_offset_slice')  {
    return leftExpr.val.var.type.tag == 'arr' || canMutate(leftExpr.val.var, scope);
  }
  return false;
}

interface FnTypeHint {
  paramTypes: (Type.Type | null)[]
  returnType: Type.Type | null
}

function ensureLeftExprValid(
  leftExpr: Parse.LeftExpr,
  // gives the leftExpr permission to do a search in the global scope
  // to find the correct function
  fnTypeHint: FnTypeHint | null,
  table: Type.RefTable,
  scope: FnContext,
  sourceLine: number
): LeftExpr | null {

  if (leftExpr.tag == 'dot') {
    let validLeftExpr = ensureExprValid(leftExpr.val.left, null, table, scope, sourceLine);
    if (validLeftExpr == null) {
      return null;
    }

    if (validLeftExpr.type.tag != 'struct') {
      logError(sourceLine, `dot op not applicable to ${Type.toStr(validLeftExpr.type)}`);
      return null;
    }

    for (let field of validLeftExpr.type.val.fields) {
      if (field.name == leftExpr.val.varName) {
        let dotOp: LeftExpr = {
          tag: 'dot',
          val: {
            left: validLeftExpr,
            varName: field.name 
          },
          type: field.type
        };
        return dotOp;
      }
    }

    logError(sourceLine, `field ${leftExpr.val.varName} not in ${Type.toStr(validLeftExpr.type)}`);
    return null;
  } 
  else if (leftExpr.tag == 'arr_offset') {
    let arr = ensureLeftExprValid(leftExpr.val.var, null, table, scope, sourceLine);
    if (arr == null) {
      return null;
    }

    let innerType = Type.canIndex(arr.type); 
    if (innerType == null) {
      logError(sourceLine, 'index not defined on type');
      return null;
    }

    let index = ensureExprValid(leftExpr.val.index, null, table, scope, sourceLine);
    if (index == null) {
      return null;
    }

    if (Type.typeApplicable(index.type, Type.INT)) {
      let newExpr: LeftExpr = { 
        tag: 'arr_offset_int',
        val: {
          var: arr,
          index: index
        },
        type: innerType
      };
      return newExpr;
    } else if (Type.typeApplicable(index.type, Type.RANGE)) {
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

    logError(sourceLine, 'arr must be indexed with range or int');
    return null;
  } 
  else if (leftExpr.tag == 'var') {
    let v = getVar(scope, leftExpr.val);
    if (v != null) { // possible bug? seems fine
      return { tag: 'var', val: leftExpr.val, isParam: v.isParam, type: v.type };
    }

    if (fnTypeHint != null) {
      let fn = Type.resolveFn(
        leftExpr.val,
        fnTypeHint.returnType,
        fnTypeHint.paramTypes,
        table,
        sourceLine
      );

      if (fn == null) {
        return null;
      }

      return { tag: 'fn', fnName: fn.fnName, unitName: fn.unitName, type: fn.fnType };
    } 

    let fn = Type.resolveFn(leftExpr.val, null, null, table, sourceLine);
    if (fn == null) {
      return null;
    }

    return { tag: 'fn', fnName: fn.fnName, unitName: fn.unitName, type: fn.fnType };
  }
  else if (leftExpr.tag == 'prime') {
    let expr = ensureExprValid(leftExpr.val, null, table, scope, sourceLine);
    if (expr == null) {
      return null;
    }

    if (expr.type.tag != 'enum') {
      logError(sourceLine, 'prime operator only used on enums');
      return null;
    }

    if (expr.tag == 'left_expr') {
      let possibleVariants = Enum.getVariantPossibilities(scope.variantScope, expr.val);
      if (possibleVariants.length == 0) {
        logError(sourceLine, 'no variant possible');
        return null;
      }
      else if (possibleVariants.length > 1) {
        logError(sourceLine, `enum can be ${ JSON.stringify(possibleVariants) }`);
        return null;
      }

      let innerType = expr.type.val.fields.filter(x => x.name == possibleVariants[0])[0].type;
      return {
        tag: 'prime',
        val: expr,
        variantIndex: Type.getVariantIndex(expr.type, possibleVariants[0]),
        variant: possibleVariants[0],
        type: innerType 
      };
    }

    logError(sourceLine, 'prime operator not supported on this expr');
    return null;
  }

  logError(-1, 'compiler bug ensureLeftExprValid');
  return null;
}

// modifies fnCall to have proper link
function ensureFnCallValid(
  fnCall: Parse.FnCall,
  expectedReturn: Type.Type | null,
  table: Type.RefTable, 
  scope: FnContext,
  sourceLine: number
): Expr | null {

  // setup check the types of params for use later
  let paramTypes: Type.Type[] = [];
  let paramExprs: Expr[] = [];
  for (let i = 0; i < fnCall.exprs.length; i++) {
    let expr: Parse.Expr = fnCall.exprs[i] ;
    let validExpr = ensureExprValid(expr, null, table, scope, sourceLine);
    if (validExpr == null) {
      return null;
    }
    paramTypes.push(validExpr.type);
    paramExprs.push(validExpr);
  }

  let fnTypeHint: FnTypeHint = { returnType: expectedReturn , paramTypes };
  let fnResult = ensureLeftExprValid(fnCall.fn, fnTypeHint, table, scope, sourceLine);
  if (fnResult == null) {
    return null;
  } 

  let fnType = fnResult.type;

  // it is a function declared in the scope, ensure that fnType fits the params and return type
  if (fnType.tag != 'fn') {
    logError(sourceLine, 'type is not a function');
    return null;
  }

  if (fnType.val.paramTypes.length != paramTypes.length) {
    logError(sourceLine, 'invalid parameter number');
    return null;
  }

  for (let i = 0; i < paramTypes.length; i++) {
    if (Type.typeApplicable(paramTypes[i], fnType.val.paramTypes[i]) == false) {
      logError(sourceLine, `invalid type for parameter ${i}`);
      return null;
    }
  }

  if (expectedReturn != null && Type.typeApplicable(fnType.val.returnType, expectedReturn) == false) {
    if (Type.typeApplicable(expectedReturn, Type.VOID)) {
      logError(sourceLine, 'return value must be handled');
      return null;
    }

    logError(sourceLine, 'invalid return type');
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

  let newExpr: Expr = { 
    tag: 'fn_call',
    val: {
      fn: fnResult,
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
  sourceLine: number
): Expr | null {

  let computedExpr: Expr | null = null; 
  if (expr.op == ':') {
    let leftTuple = ensureExprValid(expr.left, Type.INT, table, scope, sourceLine);
    let rightTuple = ensureExprValid(expr.right, Type.INT, table, scope, sourceLine);
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
  else if (expr.op == 'is') {
    let exprLeft = ensureExprValid(expr.left, null, table, scope, sourceLine);
    if (exprLeft == null) {
      return null;
    }

    if (exprLeft.tag != 'left_expr') {
      logError(sourceLine, 'is operator only valid on enums');
      return null;
    }

    if (exprLeft.type.tag != 'enum') {
      logError(sourceLine, 'is operator only valid on enums');
      return null;
    }

    if (expr.right.tag != 'left_expr' || expr.right.val.tag != 'var') {
      logError(sourceLine, 'expected enum variant in is expr');
      return null;
    }

    let fieldName: string = expr.right.val.val;
    if (exprLeft.type.val.fields.map(f => f.name).includes(fieldName) == false) {
      logError(sourceLine, `${fieldName} does not exist on enum ${Type.toStr(exprLeft.type)}`);
      return null;
    }

    computedExpr = {
      tag: 'is',
      left: exprLeft.val,
      variant: fieldName,
      variantIndex: Type.getVariantIndex(exprLeft.type, fieldName),
      type: Type.BOOL 
    };
  } 
  else if (expr.op == '&&') {
    let exprLeft = ensureExprValid(expr.left, Type.BOOL, table, scope, sourceLine);
    if (exprLeft == null) {
      return null;
    }

    // the left side of the && can be used on the right
    Enum.enterScope(scope.variantScope);
    Enum.applyCond(scope.variantScope, exprLeft, []);
    let exprRight = ensureExprValid(expr.right, Type.BOOL, table, scope, sourceLine);
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
  else {
    let exprLeft = ensureExprValid(expr.left, null, table, scope, sourceLine);
    if (exprLeft == null) {
      return null;
    }

    let exprRight = ensureExprValid(expr.right, null, table, scope, sourceLine);
    if (exprRight == null) {
      return null;
    }

    let op = expr.op;
    let testFn: (a: Type.Type, b: Type.Type) => Type.Type | null = () => null;
    if (op == '+' || op == '-' || op == '*' || op == '/' || op == '%') {
      testFn = Type.canMath;
    }
    else if (op == '<' || op == '>' || op == '<=' || op == '>=') {
      testFn = Type.canOrder;
    }
    else if (op == '==' || op == '!=') {
      testFn = Type.canEq;
    }
    else if (op == '||') {
      testFn = (a, b) => {
        if (Type.typeApplicable(a, Type.BOOL) && Type.typeApplicable(b, Type.BOOL)) {
          return Type.BOOL;
        }
        return null;
      }
    }

    let exprType = testFn(exprLeft.type, exprRight.type);
    if (exprType == null) {
      logError(sourceLine, `operator ${expr.op} not defined for type ${Type.toStr(exprLeft.type)}, ${Type.toStr(exprRight.type)}`);
      return null;
    }

    computedExpr = {
      tag: 'bin',
      val: {
        op,
        left: exprLeft,
        right: exprRight
      },
      type: exprType 
    }
  }

  if (expectedReturn != null) {
    if (computedExpr == null) {
      logError(sourceLine, 'ensureExprValid compiler bug');
      return null;
    }

    if (Type.typeApplicable(computedExpr.type, expectedReturn) == false) {
      logError(sourceLine, `expected ${Type.toStr(expectedReturn)} found ${Type.toStr(computedExpr.type)}`);
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
  sourceLine: number
): Expr | null {
  let computedExpr: Expr | null = null; 

  if (expr.tag == 'bin') {
    computedExpr = ensureBinOpValid(expr.val, expectedReturn, table, scope, sourceLine);
    if (computedExpr == null) {
      return null;
    }
  } 

  if (expr.tag == 'try' || expr.tag == 'assert') {
    if (Type.isRes(scope.returnType) == false) {
      logError(sourceLine, `${expr.tag} operator can only be used in a function returning result`);
      return null;
    }

    let newExpectedType = null;
    if (expectedReturn != null) {
      newExpectedType = Type.createRes(expectedReturn);
    }
    let validExpr = ensureExprValid(expr.val, newExpectedType, table, scope, sourceLine);
    if (validExpr == null) {
      return null;
    }
    if (Type.isRes(validExpr.type) == false) {
      logError(sourceLine, `${expr.tag} operator can only be used on results`);
      return null;
    }

    if (validExpr.type.tag != 'enum') {
      logError(sourceLine, 'compiler error');
      return null;
    }

    let resInnerType = validExpr.type.val.fields.filter(f => f.name == 'ok')[0].type;
    if (expr.tag == 'try') {
      return { tag: 'try', val: validExpr, type: resInnerType };
    } else {
      return { tag: 'assert', val: validExpr, type: resInnerType };
    }
  }

  if (expr.tag == 'not') {
    let exprTuple = ensureExprValid(expr.val, Type.BOOL, table, scope, sourceLine);
    if (exprTuple == null) {
      return null;
    }
    computedExpr = { tag: 'not', val: exprTuple, type: Type.BOOL };
  } 

  if (expr.tag == 'fn_call') {
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

        let fieldExpr = ensureExprValid(expr.val.exprs[0], fieldType, table, scope, sourceLine);
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
      let fnExpr = ensureFnCallValid(expr.val, expectedReturn, table, scope, sourceLine);
      if (fnExpr == null) {
        return null;
      }

      computedExpr = fnExpr;
    }
  } 

  if (expr.tag == 'arr_init') {
    let exprType: Type.Type | null = null;
    if (expectedReturn != null) {
      if (expectedReturn.tag != 'arr') {
        logError(sourceLine, 'arr not expected');
        return null;
      }
      exprType = expectedReturn.val;
    }

    let newExprs: Expr[] = []
    for (let i = 0; i < expr.val.length; i++) {
      let e = ensureExprValid(expr.val[i], exprType, table, scope, sourceLine);
      if (e == null) {
        return null;
      }
      newExprs.push(e);
      exprType = e.type;
    }

    // ensure that the type is actually known when done
    if (exprType == null) {
      logError(sourceLine, "unknown arr type")
      return null;
    }

    let type: Type.Type = { tag: 'arr', constant: false, val: exprType };
    computedExpr = { tag: 'arr_init', val: newExprs, type };
  }

  if (expr.tag == 'struct_init') {
    if (expectedReturn == null) {
      logError(sourceLine, 'struct initialization type is unknown');
      return null;
    }

    if (expectedReturn.tag != 'struct') {
      logError(sourceLine, 'unexpected struct init');
      return null;
    }

    let exprFieldTypes = new Map<string, Type.Type>();
    let exprFieldExprs: Map<string, Expr> = new Map();
    for (let initField of expr.val) {
      let fieldType = expectedReturn.val.fields.filter(x => x.name == initField.name)[0].type;
      let expr = ensureExprValid(initField.expr, fieldType, table, scope, sourceLine);
      if (expr == null) {
        return null;
      }

      if (exprFieldTypes.has(initField.name)) {
        logError(sourceLine, 'double initialization of field');
        return null;
      }

      exprFieldTypes.set(initField.name, expr.type);
      exprFieldExprs.set(initField.name, expr);
    }

    if (exprFieldTypes.size != expectedReturn.val.fields.length) {
      logError(sourceLine, 'missing fields');
      return null;
    }

    for (let field of expectedReturn.val.fields) {
      if (!exprFieldTypes.has(field.name)) {
        logError(sourceLine, `required field ${field.name}`);
        return null;
      }

      let exprFieldType = exprFieldTypes.get(field.name)!;
      if (Type.typeApplicable(exprFieldType, field.type) == false) {
        logError(sourceLine, `improper type for ${Type.toStr(expectedReturn)}.${field.name}`);
        return null;
      }
    }

    let fieldInits: StructInitField[] = [];
    for (let fName of exprFieldTypes.keys()) {
      let fieldExpr = exprFieldExprs.get(fName)!;
      fieldInits.push({ name: fName, expr: fieldExpr });
    }
    let newExpr: Expr = { tag: 'struct_init', val: fieldInits, type: expectedReturn };
    computedExpr = newExpr; 
  } 

  if (expr.tag == 'bool_const') {
    computedExpr = { tag: 'bool_const', val: expr.val, type: Type.BOOL };
  }

  if (expr.tag == 'str_const') {
    computedExpr = { tag: 'str_const', val: scope.strTable.length, type: Type.STR };
    scope.strTable.push(expr.val);
  } 

  if (expr.tag == 'fmt_str') {
    let newExprs: Expr[] = [];
    for (let fmtExpr of expr.val) {
      let e: Expr | null = ensureExprValid(fmtExpr, null, table, scope, sourceLine);

      if (e == null) {
        return null;
      }

      // if the type is not a string, look of the implementation of str and use
      // that instead
      if (!Type.typeApplicable(e.type, Type.STR)) {
        let fn = Type.resolveFn('str', Type.STR, [e.type], table, sourceLine);
        if (fn == null) {
          logError(sourceLine, `hint: no implementation of str(${Type.toStr(e.type)})`)
          return null;
        }

        let fnLiteral: LeftExpr = {
          tag: 'fn',
          unitName: fn.unitName,
          fnName: fn.fnName,
          type: fn.fnType
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
    computedExpr = { tag: 'fmt_str', val: newExprs, type: Type.MUT_STR }
  }

  if (expr.tag == 'char_const') {
    computedExpr = { tag: 'char_const', val: expr.val, type: Type.CHAR };
  } 

  if (expr.tag == 'int_const') {
    computedExpr = { tag: 'int_const', val: expr.val, type: Type.INT };
  } 

  if (expr.tag == 'num_const') {
    computedExpr = { tag: 'num_const', val: expr.val, type: Type.NUM };
  }

  if (expr.tag == 'left_expr') {
    // see if it is constant enum initialization of a void type
    if (expectedReturn != null && expectedReturn.tag == 'enum' && expr.val.tag == 'var') {
      let fieldIndex = expectedReturn.val.fields.map(f => f.name).indexOf(expr.val.val);
      if (fieldIndex != -1) {
        if (Type.typeApplicable(expectedReturn.val.fields[fieldIndex].type, Type.VOID)) {
          let fieldName = expectedReturn.val.fields[fieldIndex].name;
          computedExpr = {
            tag: 'enum_init',
            variantIndex: Type.getVariantIndex(expectedReturn, fieldName),
            fieldName,
            fieldExpr: null,
            type: expectedReturn
          };
        } 
      } 
    }

    if (computedExpr == null) { // normal left expr parsing
      let fnTypeHint: FnTypeHint | null = null;
      if (expectedReturn != null && expectedReturn.tag == 'fn') {
        fnTypeHint = {
          paramTypes: expectedReturn.val.paramTypes,
          returnType: expectedReturn.val.returnType
        };
      }

      let exprTuple = ensureLeftExprValid(expr.val, fnTypeHint, table, scope, sourceLine);
      if (exprTuple == null) {
        return null;
      }
      computedExpr = { tag: 'left_expr', val: exprTuple, type: exprTuple.type };
    } 
  }

  if (expectedReturn != null) {
    if (computedExpr == null) {
      logError(sourceLine, 'ensureExprValid compiler bug');
      return null;
    }

    if (Type.typeApplicable(computedExpr.type, expectedReturn) == false) {
      logError(sourceLine, `expected ${Type.toStr(expectedReturn)} found ${Type.toStr(computedExpr.type)}`);
      return null;
    }
  }

  return computedExpr;
}

interface Var {
  type: Type.Type
  isParam: boolean
  mut: boolean
}

interface FnContext {
  typeScope: Map<string, Var>[]
  generics: Set<string>, 
  returnType: Type.Type
  inLoop: boolean
  variantScope: Enum.VariantScope 
  strTable: string[]
};

function enterScope(scope: FnContext) {
  scope.typeScope.push(new Map());
}

function exitScope(scope: FnContext) {
  scope.typeScope.pop();
}

function setValToScope(scope: FnContext, name: string, type: Type.Type, mut: boolean, isParam: boolean) {
  scope.typeScope[scope.typeScope.length - 1].set(name, { type, mut, isParam });
}

function getVar(scope: FnContext, name: string): Var | null {
  for (let i = scope.typeScope.length - 1; i >= 0; i--) {
    if (scope.typeScope[i].has(name)) {
      return scope.typeScope[i].get(name)!;
    }
  }
  return null;
}
