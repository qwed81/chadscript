import * as Parse from '../parse';
import { logError } from '../index'
import * as Type from './types'
import * as Resolve from './resolve'

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
  to: Parse.LeftExpr,
  expr: Expr
}

type Inst = { tag: 'if', val: CondBody }
  | { tag: 'elif', val: CondBody }
  | { tag: 'for', val: CondBody }
  | { tag: 'else', val: Inst[] }
  | { tag: 'return', val: Expr | null }
  | { tag: 'break' }
  | { tag: 'continue' }
  | { tag: 'declare', val: Declare}
  | { tag: 'assign', val: Assign }
  | { tag: 'include', val: string }

interface FnCall {
  fn: Parse.LeftExpr
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

type Expr = { tag: 'bin', val: BinExpr }
  | { tag: 'not', val: Expr }
  | { tag: 'linked', val: Expr }
  | { tag: 'fn_call', val: FnCall }
  | { tag: 'struct_init', val: StructInitField[] }
  | { tag: 'str_const', val: string }
  | { tag: 'char_const', val: string }
  | { tag: 'int_const', val: number }
  | { tag: 'left_expr', val: Parse.LeftExpr }

export { analyze, Program, Fn, Inst, StructInitField, FnCall, Expr }

function analyze(units: Parse.ProgramUnit[]): Program | null {
  let entryName: string | null = null;
  for (let unit of units) {
    for (let fn of unit.fns) {
      if (fn.name == 'main') {
        if (entryName != null) {
          logError(fn.sourceLine, 'more than 1 main function found');
          return null;
        } 
        entryName = Resolve.getFnUniqueId(unit.fullName, fn);
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
    let validFn = analyzeFn(fn, lookupTable);
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


function verifyStructEnumHeader(struct: Parse.Struct): [boolean, string[]] {
  if (struct.t.tag == 'basic') {
    if (struct.t.val.length == 1) {
      logError(struct.sourceLine, 'single character names are reserved for generics');
      return [false, []];
    }
    return [true, []]
  } else if (struct.t.tag == 'generic') {
    if (struct.t.val.name.length == 1) {
      logError(struct.sourceLine, 'single character names are reserved for generics');
      return [false, []];
    }
    let genericNames = [];
    for (let g of struct.t.val.generics) {
      if (g.tag != 'basic' || g.val.length != 1) {
        logError(struct.sourceLine, 'generics must be single characters');
        return [false, []];
      } else {
        genericNames.push(g.val);
      }
    }
    return [true, genericNames];
  } else {
    logError(struct.sourceLine, 'unexpected struct type');
    return [false, []];
  }
}

// ensure that the parse type is actually valid
function verifyDataType(
  type: Parse.Type,
  sourceLine: number,
  table: Resolve.UnitRefs,
  validGenerics: string[]
): boolean {
  if (type.tag == 'basic') {
    if (type.val.length == 1 && validGenerics.includes(type.val) == false) {
      logError(sourceLine, 'generic not added to struct heading');
      return false;
    }
    let dataType = Resolve.resolveType(type, table, new Set(), sourceLine);
    if (dataType == null) {
      logError(sourceLine, 'could not find type ' + type.val)
      return false;
    }
    return true;
  } else if (type.tag == 'generic') {
    let dataType = Resolve.resolveType(type, table, new Set(), sourceLine);
    for (let g of type.val.generics) {
      if (verifyDataType(g, sourceLine, table, validGenerics) == false) {
        return false;
      }
    }
    if (dataType == null) {
      return false;
    }
    return true;
  } else if (type.tag == 'opt' || type.tag == 'err' || type.tag == 'link') {
    return verifyDataType(type.val, sourceLine, table, validGenerics);
  } else if (type.tag == 'fn') {
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

function verifyStruct(struct: Parse.Struct, table: Resolve.UnitRefs): boolean {
  let [valid, generics] = verifyStructEnumHeader(struct);
  if (!valid) {
    return false;
  }

  let invalidField = false;
  for (let field of struct.fields) {
    if (verifyDataType(field.t, field.sourceLine, table, generics) == false) {
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

function analyzeFn(fn: Parse.Fn, table: Resolve.UnitRefs): Fn | null {
  let generics: Set<string> = new Set();

  // TODO nested generics
  for (let i = 0; i < fn.t.paramTypes.length; i++) {
    let paramType = fn.t.paramTypes[i]; 
    if (paramType.tag == 'basic' && paramType.val.length == 1) {
      generics.add(paramType.val);
    }
  }

  let returnType = Resolve.resolveType(fn.t.returnType, table, generics, fn.sourceLine);
  if (returnType == null) {
    logError(fn.sourceLine, 'could not resolve return type');
    return null;
  }

  if (returnType.tag != 'concrete') {
    logError(fn.sourceLine, 'undeclared generic in return type');
    return null;
  }

  if (returnType == null) {
    return null;
  }

  let concreteReturn = returnType.val as Type.ConcreteType;
  let scope: Scope = { 
    varTypes: [],
    generics,
    validEnumVariants: [],
    returnType: concreteReturn,
    inLoop: false,
    varCounter: 0
  };

  enterScope(scope);
  for (let i = 0; i < fn.paramNames.length; i++) {
    let paramType = Resolve.resolveType(fn.t.paramTypes[i], table, generics, fn.sourceLine);
    if (paramType == null) {
      return null;
    }
    if (paramType.tag == 'generic') {
      logError(fn.sourceLine, 'compiler error expected resolved generic');
      return null;
    }
    setTypeToScope(scope, fn.paramNames[i], paramType.val as Type.ConcreteType);
  }

  let body: Inst[] | null = [];
  for (let instMeta of fn.body) {
    let inst = analyzeInst(instMeta, table, scope, concreteReturn); 
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

  let ident = Resolve.getFnUniqueId(table.unitName, fn);
  return { body, ident, paramNames: fn.paramNames };
}

function analyzeInstBody(
  body: Parse.InstMeta[],
  table: Resolve.UnitRefs,
  scope: Scope,
  returnType: Type.ConcreteType,
): Inst[] | null {
  enterScope(scope);

  let newBody: Inst[] | null = [];
  for (let i = 0; i < body.length; i++) {
    let inst = analyzeInst(body[i], table, scope, returnType);
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
  table: Resolve.UnitRefs,
  scope: Scope,
  returnType: Type.ConcreteType,
): Inst | null {
  let inst = instMeta.inst;
  if (inst.tag == 'if' || inst.tag == 'elif' || inst.tag == 'for') {
    let expr = ensureExprValid(inst.val.cond, Type.BOOL, table, scope, instMeta.sourceLine);
    if (expr == null) {
      return null;
    }

    if (inst.tag == 'for') {
      scope.inLoop = true;
    }

    let body = analyzeInstBody(inst.val.body, table, scope, returnType);
    if (body == null) {
      return null;
    }

    return { tag: inst.tag, val: { cond: expr.expr, body: body } };
  } 

  if (inst.tag == 'else') {
    let body = analyzeInstBody(inst.val, table, scope, returnType);
    if (body == null) {
      return null;
    }

    return { tag: 'else', val: body };
  }

  if (inst.tag == 'macro' && inst.val.name == 'js') {
    return { tag: 'include', val: inst.val.body };
  }

  if (inst.tag == 'break' || inst.tag == 'continue') {
    if (!scope.inLoop) {
      logError(instMeta.sourceLine, inst.tag + ' must be used in a loop');
      return null;
    }
    return { tag: inst.tag };
  } 

  if (inst.tag == 'return_void') {
    if (!Type.typeEq(returnType, Type.VOID)) {
      logError(instMeta.sourceLine, 'returning from non-void fn without expression');
      return null;
    }
    return { tag: 'return', val: null };
  } 

  if (inst.tag == 'return') {
    let expr = ensureExprValid(inst.val, returnType, table, scope, instMeta.sourceLine);
    if (expr == null) {
      return null;
    }
    return { tag: 'return', val: expr.expr };
  } 

  if (inst.tag == 'fn_call') {
    let exprTuple = ensureFnCallValid(inst.val, Type.VOID, table, scope, instMeta.sourceLine);
    if (exprTuple == null) {
      return null;
    }

    let to: Parse.LeftExpr =  { tag: 'var', val: '_' };
    return { tag: 'assign', val: { to, expr: exprTuple.expr } };
  } 

  if (inst.tag == 'declare') {
    let declareType = Resolve.resolveType(inst.val.t, table, scope.generics, instMeta.sourceLine);
    if (declareType == null) {
      return null;
    }

    if (declareType.tag != 'concrete') {
      logError(instMeta.sourceLine, 'declare values must be concrete');
      return null;
    }

    let concreteDeclareType = declareType.val as Type.ConcreteType;
    setTypeToScope(scope, inst.val.name, concreteDeclareType);

    let expr = ensureExprValid(inst.val.expr, concreteDeclareType, table, scope, instMeta.sourceLine);
    if (expr == null) {
      return null;
    }

    return { tag: 'declare', val: { name: inst.val.name, expr: expr.expr } };
  } 

  if (inst.tag == 'assign') {
    let to = ensureLeftExprValid(inst.val.to, table, scope, instMeta.sourceLine);
    if (to == null) {
      return null;
    }

    let expr = ensureExprValid(inst.val.expr, to.type, table, scope, instMeta.sourceLine);
    if (expr == null) {
      return null;
    }

    return { tag: 'assign', val: { to: to.expr , expr: expr.expr }};
  } 

  logError(instMeta.sourceLine, 'compiler error analyzeInst');
  return null;
}

interface LeftExprTuple {
  expr: Parse.LeftExpr,
  type: Type.ConcreteType
}

function ensureLeftExprValid(
  leftExpr: Parse.LeftExpr,
  table: Resolve.UnitRefs,
  scope: Scope,
  sourceLine: number
): LeftExprTuple | null {
  if (leftExpr.tag == 'dot') {
    let leftExprTuple = ensureLeftExprValid(leftExpr.val.left, table, scope, sourceLine);
    if (leftExprTuple == null) {
      return null;
    }

    if (leftExprTuple.type.tag != 'struct' && leftExprTuple.type.tag != 'enum') {
      logError(sourceLine, 'dot op only supported on structs and enums');
      return null;
    }

    for (let field of leftExprTuple.type.val.fields) {
      if (field.name == leftExpr.val.varName) {
        let dotOp: Parse.LeftExpr = { tag: 'dot', val: { left: leftExprTuple.expr, varName: field.name } };
        return { expr: dotOp, type: field.type };
      }
    }

    logError(sourceLine, `field ${leftExpr.val.varName} not in ${Type.toStr(leftExprTuple.type)}`);
    return null;
  } 

  if (leftExpr.tag == 'arr_offset') {
    let arr = ensureLeftExprValid(leftExpr.val.var, table, scope, sourceLine);
    if (arr == null) {
      return null;
    }

    if (arr.type.tag != 'view') {
      logError(sourceLine, 'only view can index');
      return null;
    }

    let indexType = ensureExprValid(leftExpr.val.index, Type.INT, table, scope, sourceLine);
    if (indexType == null) {
      return null;
    }

    return arr;
  } else if (leftExpr.tag == 'var') {
    let v = getVarFromScope(scope, leftExpr.val);
    if (v == null) {
      logError(sourceLine, `${leftExpr.val} not declared`);
      return null;
    }
    return { expr: { tag: 'var', val: leftExpr.val }, type: v.type };
  }

  logError(-1, 'compiler bug ensureLeftExprValid');
  return null;
}

// modifies fnCall to have proper link
function ensureFnCallValid(
  fnCall: Parse.FnCall,
  expectedReturn: Type.ConcreteType,
  table: Resolve.UnitRefs, 
  scope: Scope,
  sourceLine: number
): ExprTuple | null {

  let exprTypes: Type.ConcreteType[] = [];
  let paramExprs: Expr[] = [];
  for (let i = 0; i < fnCall.exprs.length; i++) {
    let exprTuple = ensureExprValid(fnCall.exprs[i], null, table, scope, sourceLine);
    if (exprTuple == null) {
      return null;
    }

    exprTypes.push(exprTuple.type);
    paramExprs.push(exprTuple.expr);
  }

  if (fnCall.fn.tag == 'dot' || fnCall.fn.tag == 'arr_offset') {
    let leftExpr = ensureLeftExprValid(fnCall.fn, table, scope, sourceLine);
    if (leftExpr == null) {
      return null;
    } 

    // TODO typecheck
    let fnCallExpr: Expr = { tag: 'fn_call', val: { fn: leftExpr.expr, exprs: paramExprs } };
    return { expr: fnCallExpr, type: expectedReturn };
  } else if (fnCall.fn.tag == 'var') {
    let v = getVarFromScope(scope, fnCall.fn.val); // first look in the scope for the value
    if (v == null) {
      // if you can't find the fn as a local variable lookup and try to find it in global scope
      let foundId = Resolve.lookupFn(fnCall.fn.val, exprTypes, expectedReturn, table, sourceLine);
      if (foundId == null) {
        logError(sourceLine, `could not find function ${fnCall.fn.val}`);
        return null;
      } 

      let newExpr: Expr = { tag: 'fn_call', val: { fn: { tag: 'var', val: foundId }, exprs: paramExprs  } };
      return { expr: newExpr, type: expectedReturn };
    } 

    console.log(fnCall.fn.val);
    
    // TODO type check
    return null;
  }

  logError(-1, 'compiler bug ensureFnCallValid');
  return null;
}

const OP_MAPPING: [string, Type.ConcreteType, Type.ConcreteType, Type.ConcreteType][] = [
  ['<', Type.INT, Type.INT, Type.BOOL],
  ['>', Type.INT, Type.INT, Type.BOOL],
  ['<=', Type.INT, Type.INT, Type.BOOL],
  ['>=', Type.INT, Type.INT, Type.BOOL],

  ['&&', Type.BOOL, Type.BOOL, Type.BOOL],
  ['||', Type.BOOL, Type.BOOL, Type.BOOL],

  ['*', Type.INT, Type.INT, Type.INT],
  ['/', Type.INT, Type.INT, Type.INT],
  ['+', Type.INT, Type.INT, Type.INT],
  ['-', Type.INT, Type.INT, Type.INT],
  ['%', Type.INT, Type.INT, Type.INT],

  ['==', Type.INT, Type.INT, Type.BOOL],
  ['==', Type.CHAR, Type.CHAR, Type.BOOL],
  ['==', Type.BOOL, Type.BOOL, Type.BOOL],
  ['==', Type.STR, Type.STR, Type.BOOL],

  ['!=', Type.INT, Type.INT, Type.BOOL],
  ['!=', Type.CHAR, Type.CHAR, Type.BOOL],
  ['!=', Type.BOOL, Type.BOOL, Type.BOOL],
  ['!=', Type.STR, Type.STR, Type.BOOL],
];

interface ExprTuple {
  expr: Expr,
  type: Type.ConcreteType
}

function ensureExprValid(
  expr: Parse.Expr, 
  // expected return is provided when the expression return type is known
  // which helps with struct typing and generic functions
  expectedReturn: Type.ConcreteType | null,
  table: Resolve.UnitRefs,
  scope: Scope,
  sourceLine: number
): ExprTuple | null {
  let computedExpr: ExprTuple | null = null; 

  if (expr.tag == 'bin') {
    let exprLeft = ensureExprValid(expr.val.left, null, table, scope, sourceLine);
    if (exprLeft == null) {
      return null;
    }

    if (expr.val.op == 'is') {
      if (exprLeft.expr.tag != 'left_expr') {
        logError(sourceLine, 'is operator only valid on enums');
        return null;
      }

      if (exprLeft.type.tag != 'enum') {
        logError(sourceLine, 'is operator only valid on enums');
        return null;
      }

      if (expr.val.right.tag != 'left_expr' || expr.val.right.val.tag != 'var') {
        logError(sourceLine, 'expected enum variant in is expr');
        return null;
      }

      let fieldName: string = expr.val.right.val.val;
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
                left: exprLeft.expr.val,
                varName: 'tag'
              }
            }
          },
          right: {
            tag: 'str_const',
            val: fieldName
          }
        }
      };

      computedExpr = { expr: convertedExpr, type: Type.BOOL };
    } else {

      let exprRight = ensureExprValid(expr.val.right, null, table, scope, sourceLine);
      if (exprRight == null) {
        return null;
      }

      for (let i = 0; i < OP_MAPPING.length; i++) {
        let thisOp = OP_MAPPING[i];
        if (expr.val.op != thisOp[0]) {
          continue;
        }

        if (Type.typeEq(exprLeft.type, exprRight.type) == false) {
          logError(sourceLine, 'types do not match');
          return null;
        }

        if (Type.typeEq(exprLeft.type, thisOp[1]) == true) {
          let newExpr: Expr = { tag: 'bin', val: { op: thisOp[0], left: exprLeft.expr, right: exprRight.expr } };
          computedExpr = { expr: newExpr, type: thisOp[3] };
        }
      }

      if (computedExpr == null) {
        logError(sourceLine, `operator ${expr.val.op} not defined for type ${Type.toStr(exprLeft.type)}`);
        return null;
      }
    }
  } 

  if (expr.tag == 'not') {
    let exprTuple = ensureExprValid(expr.val, Type.BOOL, table, scope, sourceLine);
    if (exprTuple == null) {
      return null;
    }
    computedExpr = { expr: exprTuple.expr, type: Type.BOOL };
  } 

  if (expr.tag == 'fn_call') {
    if (expectedReturn == null) {
      logError(sourceLine, 'function call return type must be known');
      return null;
    }

    // check if initialization of enum
    if (expectedReturn.tag == 'enum' && expr.val.fn.tag == 'var' && expr.val.exprs.length == 1) {
      let fieldIndex = expectedReturn.val.fields.map(f => f.name).indexOf(expr.val.fn.val);
      if (fieldIndex != -1) {
        let fieldType: Type.ConcreteType = expectedReturn.val.fields[fieldIndex].type;
        let fieldName: string = expectedReturn.val.fields[fieldIndex].name;

        let exprTuple = ensureExprValid(expr.val.exprs[0], fieldType, table, scope, sourceLine);
        if (exprTuple == null) {
          return null;
        }

        let createdExpr: Expr = {
          tag: 'struct_init',
          val: [
            { name: 'tag', expr: { tag: 'str_const', val: fieldName } },
            { name: fieldName, expr: exprTuple.expr }
          ]
        };
        computedExpr = { expr: createdExpr, type: expectedReturn };
      } 

    } else {
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

    let fieldMap = new Map<string, Type.ConcreteType>();
    let fieldExprs: Map<string, Expr> = new Map();
    for (let initField of expr.val) {
      let exprTuple = ensureExprValid(initField.expr, null, table, scope, sourceLine);
      if (exprTuple == null) {
        return null;
      }

      if (fieldMap.has(initField.name)) {
        logError(sourceLine, 'double initialization of field');
        return null;
      }

      fieldMap.set(initField.name, exprTuple.type);
      fieldExprs.set(initField.name, exprTuple.expr);
    }

    if (fieldMap.size != expectedReturn.val.fields.length) {
      for (let field of expectedReturn.val.fields) {
        if (!fieldMap.has(field.name)) {
          logError(sourceLine, `required field ${field.name}`);
          return null;
        }

        let fieldType = fieldMap.get(field.name)!;
        if (fieldType) {
          logError(sourceLine, `improper type for ${field.name}`);
          return null;
        }
      }
    }

    let fieldInits: StructInitField[] = [];
    for (let fName of fieldMap.keys()) {
      let fieldExpr = fieldExprs.get(fName)!;
      fieldInits.push({ name: fName, expr: fieldExpr });
    }
    let newExpr: Expr = { tag: 'struct_init', val: fieldInits };
    computedExpr = { type: expectedReturn, expr: newExpr }; 
  } 

  if (expr.tag == 'str_const') {
    computedExpr = { expr: { tag: 'str_const', val: expr.val }, type: Type.STR };
  } 

  if (expr.tag == 'char_const') {
    computedExpr = { expr: { tag: 'char_const', val: expr.val }, type: Type.CHAR };
  } 

  if (expr.tag == 'int_const') {
    computedExpr = { expr: { tag: 'int_const', val: expr.val }, type: Type.INT };
  } 

  if (expr.tag == 'left_expr') {
    // see if it is constant enum initialization of a void type
    if (expectedReturn != null && expectedReturn.tag == 'enum' && expr.val.tag == 'var') {
      let fieldIndex = expectedReturn.val.fields.map(f => f.name).indexOf(expr.val.val);
      if (fieldIndex != -1) {
        if (Type.typeEq(expectedReturn.val.fields[fieldIndex].type, Type.VOID)) {
          let fieldName = expectedReturn.val.fields[fieldIndex].name;
          let createdExpr: Expr = {
            tag: 'struct_init',
            val: [
              { name: 'tag', expr: { tag: 'str_const', val: fieldName } }
            ]
          };
          computedExpr = { expr: createdExpr, type: expectedReturn };
        } 
      } 
    } else { // normal left expr parsing
      let exprTuple = ensureLeftExprValid(expr.val, table, scope, sourceLine);
      if (exprTuple == null) {
        return null;
      }
      computedExpr = { expr: { tag: 'left_expr', val: exprTuple.expr }, type: exprTuple.type };
    } 
  }

  if (expectedReturn != null) {
    if (computedExpr == null) {
      logError(sourceLine, 'compiler bug');
      return null;
    }

    if (Type.typeEq(computedExpr.type, expectedReturn) == false) {
      logError(sourceLine, `expected ${Type.toStr(expectedReturn)} found ${Type.toStr(computedExpr.type)}`);
      return null;
    }
  }

  return computedExpr;
}

interface Var {
  type: Type.ConcreteType
  ident: number
}

interface Scope {
  varTypes: Map<string, Var>[]
  generics: Set<string>, 
  validEnumVariants: Map<string, string[]>[]
  returnType: Type.ConcreteType
  inLoop: boolean
  varCounter: number
};

function enterScope(scope: Scope) {
  scope.varTypes.push(new Map());
  scope.validEnumVariants.push(new Map());
}

function exitScope(scope: Scope) {
  scope.varTypes.pop();
  scope.validEnumVariants.pop();
}

function allowEnumVariant(scope: Scope, name: string, variant: string) {
  let list = scope.validEnumVariants[scope.validEnumVariants.length - 1].get(name);
  if (list == null) {
    list = [];
    scope.validEnumVariants[scope.validEnumVariants.length - 1].set(name, list);
  }
  list.push(variant);
}

function setTypeToScope(scope: Scope, name: string, type: Type.ConcreteType) {
  scope.varTypes[scope.varTypes.length - 1].set(name, { type, ident: scope.varCounter });
  scope.varCounter += 1;
}

function getVarFromScope(scope: Scope, name: string): Var | null {
  for (let i = scope.varTypes.length - 1; i >= 0; i--) {
    if (scope.varTypes[i].has(name)) {
      return scope.varTypes[i].get(name)!;
    }
  }
  return null;
}
