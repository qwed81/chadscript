import * as Parse from '../parse';
import { logError } from '../index'
import * as Type from './types'

interface Program {
  fns: Fn[]
  entry: string
}

interface Fn {
  ident: string
  paramNames: string[]
  body: Inst[]
}

interface CondBody {
  cond: Expr
  body: Inst[]
}

interface Declare {
  name: string
  expr: Expr
}

interface Assign {
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

type Inst = { tag: 'if', val: CondBody }
  | { tag: 'elif', val: CondBody }
  | { tag: 'while', val: CondBody }
  | { tag: 'for_in', val: ForIn }
  | { tag: 'else', val: Inst[] }
  | { tag: 'return', val: Expr | null }
  | { tag: 'break' }
  | { tag: 'continue' }
  | { tag: 'match', val: Match }
  | { tag: 'declare', val: Declare}
  | { tag: 'assign', val: Assign }
  | { tag: 'include', val: string[] }

interface FnCall {
  fn: LeftExpr
  exprs: Expr[]
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
  | { tag: 'not', val: Expr, type: Type.Type }
  | { tag: 'try', val: Expr, type: Type.Type }
  | { tag: 'assert', val: Expr, type: Type.Type }
  | { tag: 'linked', val: Expr, type: Type.Type }
  | { tag: 'fn_call', val: FnCall, type: Type.Type }
  | { tag: 'struct_init', val: StructInitField[], type: Type.Type }
  | { tag: 'str_const', val: string, type: Type.Type }
  | { tag: 'char_const', val: string, type: Type.Type }
  | { tag: 'int_const', val: number, type: Type.Type }
  | { tag: 'bool_const', val: boolean, type: Type.Type }
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
  start: Expr
  end: Expr
}

type LeftExpr = { tag: 'dot', val: DotOp }
  | { tag: 'arr_offset_int', val: ArrOffsetInt }
  | { tag: 'arr_offset_slice', val: ArrOffsetSlice }
  | { tag: 'var', val: string }


export { analyze, Program, Fn, Inst, StructInitField, FnCall, Expr, LeftExpr }

function analyze(units: Parse.ProgramUnit[]): Program | null {
  let entryName: string | null = null;
  for (let unit of units) {
    for (let fn of unit.fns) {
      if (fn.name == 'main') {
        if (entryName != null) {
          logError(fn.sourceLine, 'more than 1 main function found');
          return null;
        } 
        entryName = Type.getFnUniqueId(unit.fullName, fn);
      }
    }
  }

  if (entryName == null) {
    logError(-1, 'could not find main function');
    return null;
  }

  let validProgram: Program | null = { fns: [], entry: entryName };

  for (let i = 0; i < units.length; i++) {
    if (analyzeUnitDataTypes(units, i) == false) {
      validProgram = null;
    }
  }

  for (let i = 0; i < units.length; i++) {
    let unitFns: Fn[] | null = analyzeUnitFns(units, i); 
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

function analyzeUnitFns(units: Parse.ProgramUnit[], unitIndex: number): Fn[] | null {
  let unit = units[unitIndex];
  let lookupTable = { units, unitName: unit.fullName, uses: unit.uses };

  let fns: Fn[] | null = [];
  for (let fn of unit.fns) {
    let validFn = analyzeFn(fn, lookupTable, unit);
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
  let lookupTable = { units, unitName: unit.fullName, uses: unit.uses };

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

  if (type.tag == 'slice') {
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

  if (paramType.tag == 'slice' || paramType.tag == 'link') {
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
  unit: Parse.ProgramUnit
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

  let scope: Scope = { 
    varTypes: [],
    generics,
    returnType: returnType,
    inLoop: false,
    varCounter: 0
  };

  enterScope(scope);
  for (let i = 0; i < fn.paramNames.length; i++) {
    let paramType = fn.t.paramTypes[i];
    let mut = false;
    if (paramType.tag == 'link') {
      paramType = paramType.val;
      mut = true;
    }

    let resolvedParamType = Type.resolveType(fn.t.paramTypes[i], table, fn.sourceLine);
    if (resolvedParamType == null) {
      return null;
    }

    let isRefable = (resolvedParamType.tag == 'struct' || resolvedParamType.tag == 'enum' || resolvedParamType.tag == 'slice');
    if (fn.t.paramTypes[i].tag == 'link' && !isRefable) {
      logError(fn.sourceLine, 'type can not be used as referece');
      return null;
    }

    setValToScope(scope, fn.paramNames[i], resolvedParamType, mut);
  }

  let body: Inst[] | null = [];
  for (let instMeta of fn.body) {
    let inst = analyzeInst(instMeta, table, scope); 
    if (inst == null) {
      body = null;
    } else if (body != null) {
      body.push(inst)
    }
  }

  exitScope(scope);
  if (body == null) {
    return null;
  }

  let ident = Type.getFnUniqueId(unit.fullName, fn);
  return { body, ident, paramNames: fn.paramNames };
}

function analyzeInstBody(
  body: Parse.InstMeta[],
  table: Type.RefTable,
  scope: Scope,
): Inst[] | null {
  enterScope(scope);

  let newBody: Inst[] | null = [];
  for (let i = 0; i < body.length; i++) {
    let inst = analyzeInst(body[i], table, scope);
    if (inst == null) {
      newBody = null;
    } else if (newBody != null) {
      newBody.push(inst);
    }
  }

  exitScope(scope);
  return newBody;
}

function analyzeInst(
  instMeta: Parse.InstMeta,
  table: Type.RefTable,
  scope: Scope,
): Inst | null {
  let inst = instMeta.inst;
  if (inst.tag == 'if' || inst.tag == 'elif' || inst.tag == 'while') {
    let expr = ensureExprValid(inst.val.cond, Type.BOOL, table, scope, instMeta.sourceLine);
    if (expr == null) {
      return null;
    }

    if (inst.tag == 'while') {
      scope.inLoop = true;
    }

    let body = analyzeInstBody(inst.val.body, table, scope);
    if (body == null) {
      return null;
    }

    return { tag: inst.tag, val: { cond: expr, body: body } };
  } 

  if (inst.tag == 'include') {
    return { tag: 'include', val: inst.val };
  }

  if (inst.tag == 'for_in') {
    let iterExpr = ensureExprValid(inst.val.iter, Type.RANGE, table, scope, instMeta.sourceLine);
    if (iterExpr == null) {
      return null;
    }

    scope.inLoop = true;
    enterScope(scope);
    setValToScope(scope, inst.val.varName, Type.INT, false);
    let body = analyzeInstBody(inst.val.body, table, scope);
    exitScope(scope);
    if (body == null) {
      return null;
    }

    return {
      tag: 'for_in',
      val: {
        varName: inst.val.varName, iter: iterExpr, body: body 
      }
    };
  }

  if (inst.tag == 'else') {
    let body = analyzeInstBody(inst.val, table, scope);
    if (body == null) {
      return null;
    }

    return { tag: 'else', val: body };
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

    return { tag: 'match', val: { var: exprTuple, branches: newBranches } };
  }

  if (inst.tag == 'break' || inst.tag == 'continue') {
    if (!scope.inLoop) {
      logError(instMeta.sourceLine, inst.tag + ' must be used in a loop');
      return null;
    }
    return { tag: inst.tag };
  } 

  if (inst.tag == 'return_void') {
    if (!Type.typeApplicable(scope.returnType, Type.VOID)) {
      logError(instMeta.sourceLine, 'returning from non-void fn without expression');
      return null;
    }
    return { tag: 'return', val: null };
  } 

  if (inst.tag == 'return') {
    let expr = ensureExprValid(inst.val, scope.returnType, table, scope, instMeta.sourceLine);
    if (expr == null) {
      return null;
    }
    return { tag: 'return', val: expr };
  } 

  if (inst.tag == 'fn_call') {
    let exprTuple = ensureFnCallValid(inst.val, Type.VOID, table, scope, instMeta.sourceLine);
    if (exprTuple == null) {
      return null;
    }

    let to: LeftExpr =  { tag: 'var', val: '_' };
    return { tag: 'assign', val: { to, expr: exprTuple } };
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

    if (Type.isGeneric(declareType)) {
      logError(instMeta.sourceLine, 'declare values must be concrete');
      return null;
    }

    setValToScope(scope, inst.val.name, declareType, true);

    let expr = ensureExprValid(inst.val.expr, declareType, table, scope, instMeta.sourceLine);
    if (expr == null) {
      return null;
    }

    return { tag: 'declare', val: { name: inst.val.name, expr: expr } };
  } 

  if (inst.tag == 'assign') {
    let to = ensureLeftExprValid(inst.val.to, null, table, scope, instMeta.sourceLine);
    if (to == null) {
      return null;
    }

    if (to.expr.tag == 'arr_offset_slice') {
      logError(instMeta.sourceLine, 'can not assign to a slice');
      return null;
    }

    if (canMutate(to.expr, scope) == false) {
      logError(instMeta.sourceLine, 'value can not be mutated');
      return null;
    }

    let expr = ensureExprValid(inst.val.expr, to.type, table, scope, instMeta.sourceLine);
    if (expr == null) {
      return null;
    }

    return { tag: 'assign', val: { to: to.expr , expr: expr }};
  } 

  logError(instMeta.sourceLine, 'compiler error analyzeInst');
  return null;
}

function canMutate(leftExpr: LeftExpr, scope: Scope): boolean {
  if (leftExpr.tag == 'dot') {
    if (leftExpr.val.left.tag != 'left_expr') {
      return false;
    }
    return canMutate(leftExpr.val.left.val, scope);
  } 
  else if (leftExpr.tag == 'var') {
    let v = getVar(scope, leftExpr.val);
    if (v == null) {
      return false;
    }
    return v.mut;
  } 
  else if (leftExpr.tag == 'arr_offset_int') {
    return canMutate(leftExpr.val.var, scope);
  }
  else if (leftExpr.tag == 'arr_offset_slice')  {
    return canMutate(leftExpr.val.var, scope);
  }
  return false;
}

interface LeftExprTuple {
  expr: LeftExpr,
  type: Type.Type
}

interface FnTypeHint {
  paramTypes: Type.Type[]
  returnType: Type.Type | null
}

function ensureLeftExprValid(
  leftExpr: Parse.LeftExpr,
  // gives the leftExpr permission to do a search in the global scope
  // to find the correct function
  fnTypeHint: FnTypeHint | null,
  table: Type.RefTable,
  scope: Scope,
  sourceLine: number
): LeftExprTuple | null {

  if (leftExpr.tag == 'dot') {
    let validLeftExpr = ensureExprValid(leftExpr.val.left, null, table, scope, sourceLine);
    if (validLeftExpr == null) {
      return null;
    }

    if (validLeftExpr.type.tag != 'struct' && validLeftExpr.type.tag != 'enum') {
      logError(sourceLine, 'dot op only supported on structs and enums');
      return null;
    }

    for (let field of validLeftExpr.type.val.fields) {
      if (field.name == leftExpr.val.varName) {
        let dotOp: LeftExpr = { tag: 'dot', val: { left: validLeftExpr, varName: field.name } };
        return { expr: dotOp, type: field.type };
      }
    }

    logError(sourceLine, `field ${leftExpr.val.varName} not in ${Type.toStr(validLeftExpr.type)}`);
    return null;
  } 

  if (leftExpr.tag == 'arr_offset') {
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
          var: arr.expr,
          index: index
        } 
      };
      return { expr: newExpr, type: innerType };
    } else if (Type.typeApplicable(index.type, Type.RANGE)) {
      let start: Expr = {
        tag: 'left_expr',
        val: {
          tag: 'dot',
          val: {
            left: index,
            varName: 'start'
          } 
        },
        type: Type.INT
      };
      let end: Expr = {
        tag: 'left_expr',
        val: {
          tag: 'dot',
          val: {
            left: index,
            varName: 'end'
          }
        },
        type: Type.INT
      };
      let newExpr: LeftExpr = { 
        tag: 'arr_offset_slice',
        val: {
          var: arr.expr,
          start,
          end
        } 
      };
      return { expr: newExpr, type: arr.type };
    }

    logError(sourceLine, 'slice must be indexed with range or int');
    return null;
  } else if (leftExpr.tag == 'var') {
    let v = getVar(scope, leftExpr.val);
    if (v != null) {
      return { expr: { tag: 'var', val: leftExpr.val }, type: v.type };
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

      return { expr: { tag: 'var', val: fn.uniqueName}, type: fn.fnType };
    }

    logError(sourceLine, `could not find ${leftExpr.val}`);
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
  scope: Scope,
  sourceLine: number
): Expr | null {

  // setup check the types of params for use later
  let paramTypes: Type.Type[] = [];
  let paramExprs: Expr[] = [];
  let linked: boolean[] = []
  for (let i = 0; i < fnCall.exprs.length; i++) {
    let expr: Parse.Expr = fnCall.exprs[i] ;
    if (expr.tag == 'linked') {
      expr = expr.val;
      linked.push(true);
    } else {
      linked.push(false);
    }

    let validExpr = ensureExprValid(expr, null, table, scope, sourceLine);
    if (validExpr == null) {
      return null;
    }

    if (fnCall.exprs[i].tag == 'linked') {
      let t = validExpr.type.tag;
      if ((t == 'slice' || t == 'enum' || t == 'struct') == false) {
        logError(sourceLine, 'type can not be turned into a reference');
        return null;
      }
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
    /*
    if (linked[i] == false && fnResult.linkedParams[i] == true) {
      logError(sourceLine, 'expected ref');
      return null;
    }
    else if (linked[i] == true && fnResult.linkedParams[i] == false) {
      logError(sourceLine, 'unexpected ref');
      return null;
    }
    */

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

  let newExpr: Expr = { 
    tag: 'fn_call',
    val: {
      fn: fnResult.expr,
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
  scope: Scope,
  sourceLine: number
): Expr | null {

  let computedExpr: Expr | null = null; 
  if (expr.op == 'to') {
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

    // convert to <expr as leftExpr>.tag == ${fieldName}
    let convertedExpr: Expr = {
      tag: 'bin', 
      val: {
        op: '==',
        left: {
          tag: 'left_expr',
          val: {
            tag: 'dot',
            val: {
              left: exprLeft,
              varName: 'tag'
            }
          },
          type: Type.CHAR_SLICE // TODO? not sure if this is right
        },
        right: {
          tag: 'str_const',
          val: fieldName,
          type: Type.CHAR_SLICE
        }
      },
      type: Type.BOOL
    };

    computedExpr = convertedExpr;
  } else {
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
    else if (op == '&&' || op == '||') {
      testFn = (a, b) => {
        if (Type.typeApplicable(a, Type.BOOL) && Type.typeApplicable(b, Type.BOOL)) {
          return Type.BOOL;
        }
        return null;
      }
    }

    let exprType = testFn(exprLeft.type, exprRight.type);
    if (exprType == null) {
      logError(sourceLine, `operator ${expr.op} not defined for type ${Type.toStr(exprLeft.type)}`);
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
  scope: Scope,
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
    return { tag: expr.tag, val: validExpr, type: resInnerType };
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

        let createdExpr: Expr = {
          tag: 'struct_init',
          val: [
            { name: 'tag', expr: { tag: 'str_const', val: fieldName, type: Type.CHAR_SLICE } },
            { name: fieldName, expr: fieldExpr }
          ],
          type: expectedReturn
        };
        computedExpr = createdExpr;
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
    computedExpr = { tag: 'str_const', val: expr.val, type: Type.CHAR_SLICE };
  } 

  if (expr.tag == 'char_const') {
    computedExpr = { tag: 'char_const', val: expr.val, type: Type.CHAR };
  } 

  if (expr.tag == 'int_const') {
    computedExpr = { tag: 'int_const', val: expr.val, type: Type.INT };
  } 

  if (expr.tag == 'left_expr') {
    // see if it is constant enum initialization of a void type
    if (expectedReturn != null && expectedReturn.tag == 'enum' && expr.val.tag == 'var') {
      let fieldIndex = expectedReturn.val.fields.map(f => f.name).indexOf(expr.val.val);
      if (fieldIndex != -1) {
        if (Type.typeApplicable(expectedReturn.val.fields[fieldIndex].type, Type.VOID)) {
          let fieldName = expectedReturn.val.fields[fieldIndex].name;
          let createdExpr: Expr = {
            tag: 'struct_init',
            val: [
              { name: 'tag', expr: { tag: 'str_const', val: fieldName, type: Type.BOOL } }
            ],
            type: expectedReturn
          };
          computedExpr = createdExpr;
        } 
      } 
    } else { // normal left expr parsing
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
      computedExpr = { tag: 'left_expr', val: exprTuple.expr, type: exprTuple.type };
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
  mut: boolean
}

interface Scope {
  varTypes: Map<string, Var>[]
  generics: Set<string>, 
  returnType: Type.Type
  inLoop: boolean
  varCounter: number
};

function enterScope(scope: Scope) {
  scope.varTypes.push(new Map());
}

function exitScope(scope: Scope) {
  scope.varTypes.pop();
}

function setValToScope(scope: Scope, name: string, type: Type.Type, mut: boolean) {
  scope.varTypes[scope.varTypes.length - 1].set(name, { type, mut });
  scope.varCounter += 1;
}

function getVar(scope: Scope, name: string): Var | null {
  for (let i = scope.varTypes.length - 1; i >= 0; i--) {
    if (scope.varTypes[i].has(name)) {
      return scope.varTypes[i].get(name)!;
    }
  }
  return null;
}
