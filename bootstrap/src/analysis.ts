import {
  ProgramUnit as ParseProgramUnit, Struct as ParseStruct,
  Enum as ParseEnum, Fn as ParseFn, 
  Type as ParseType, InstMeta as ParseInstMeta, Expr as ParseExpr,
  LeftExpr as ParseLeftExpr, FnCall as ParseFnCall
} from './parse';

export { analyze, Program }

function analyze(units: ParseProgramUnit[]): Program | null {
  let program = { fns: [] };
  let validProgram = true;
  for (let i = 0; i < units.length; i++) {
    if (analyzeUnitDataTypes(units, i) == false) {
      validProgram = false;
    }
  }
  for (let i = 0; i < units.length; i++) {
    if (analyzeUnitFns(program, units, i) == false) {
      validProgram = false;
    }
  }

  let fnList = [];
  for (let unit of units) {
    for (let f of unit.fns) {
      fnList.push(f);
    }
  }

  if (validProgram == false) {
    return null;
  }
  return { fns: fnList };
}

interface Program {
  fns: ParseFn[]
}

function logError(line: number, message: string) {
  console.log(`error line: ${line + 1} ${message}`);
}

interface LookupTable {
  units: ParseProgramUnit[],
  unitName: string,
  uses: string[]
}

type ParseStructLookup = { tag: 'struct', val: ParseStruct } | { tag: 'enum', val: ParseEnum } | null; 
function lookupParseStructEnum(
  name: string,
  genericCount: number,
  table: LookupTable,
  sourceLine: number
): ParseStructLookup {
  let possibleType: ParseStructLookup = null;
  let typeUnit: string | null = null;

  for (let unit of table.units) {
    if (unit.fullName != table.unitName && !table.uses.includes(unit.fullName)) {
      continue;
    }

    for (let struct of unit.structs) {
      if (struct.t.tag == 'generic') {
        if (struct.t.val.name != name || struct.t.val.generics.length != genericCount) {
          continue;
        }

        if (possibleType != null) {
          logError(sourceLine, `{} is ambiguous between ${typeUnit}.name and ${unit.fullName}.name`);
          return null;
        }

        possibleType = { tag: 'struct', val: struct };
        typeUnit = unit.fullName;
      } else if (struct.t.tag == 'basic' && genericCount == 0) {
        if (struct.t.val != name) {
          continue;
        }

        if (possibleType != null) {
          logError(sourceLine, `{} is ambiguous between ${typeUnit}.name and ${unit.fullName}.name`);
          return null;
        }

        possibleType = { tag: 'struct', val: struct };
        typeUnit = unit.fullName;
      }
    }

    for (let en of unit.enums) {
      if (en.t.tag == 'generic') {
        if (en.t.val.name != name || en.t.val.generics.length != genericCount) {
          continue;
        }

        if (possibleType != null) {
          logError(sourceLine, `{} is ambiguous between ${typeUnit}.name and ${unit.fullName}.name`);
          return null;
        }

        possibleType = { tag: 'enum', val: en };
        typeUnit = unit.fullName;
      } else if (en.t.tag == 'basic' && genericCount == 0) {
        if (en.t.val != name) {
          continue;
        }

        if (possibleType != null) {
          logError(sourceLine, `{} is ambiguous between ${typeUnit}.name and ${unit.fullName}.name`);
          return null;
        }

        possibleType = { tag: 'enum', val: en };
        typeUnit = unit.fullName;
      }
    }
  }

  return possibleType;
}

const INT: Type = { tag: 'primative', val: 'int' };
const BOOL: Type = { tag: 'primative', val: 'bool' };
const VOID: Type = { tag: 'primative', val: 'void' }
const STR: Type = { tag: 'primative', val: 'str' };
const CHAR: Type = { tag: 'primative', val: 'char' };

type Type = { tag: 'primative', val: 'bool' | 'void' | 'int' | 'str' | 'char' }
  | { tag: 'view', val: Type }
  | { tag: 'struct', val: Map<string, Type> }
  | { tag: 'enum', val: Map<string, Type> }
  | { tag: 'fn', val: { returnType: Type, paramTypes: Type[] } }
  | { tag: 'generic', val: string };

function resolveType(
  type: ParseType,
  table: LookupTable,
  sourceLine: number
): Type | null {
  if (type.tag == 'link') {
    return resolveType(type.val, table, sourceLine);
  } else if (type.tag == 'opt') {
    let t = resolveType(type.val, table, sourceLine);
    if (t == null) {
      return null;
    }
    let optMap = new Map();
    optMap.set('some', t);
    optMap.set('none', VOID);
    return { tag: 'enum', val: optMap };
  } else if (type.tag == 'err') {
    let t = resolveType(type.val, table, sourceLine);
    if (t == null) {
      return null;
    }
    let resMap = new Map();
    resMap.set('ok', t);
    resMap.set('err', STR);
    return { tag: 'enum', val: resMap };
  } else if (type.tag == 'fn') {
    let returnType = resolveType(type.val.returnType, table, sourceLine);
    if (returnType == null) {
      return null;
    }
    let paramTypes = [];
    for (let param of type.val.paramTypes) {
      let paramType = resolveType(param, table, sourceLine);
      if (paramType == null) {
        return null;
      }
      paramTypes.push(paramType);
    }
    return { tag: 'fn', val: { returnType, paramTypes } };
  }

  let genericCount: number = -1;
  let name: string = '';
  if (type.tag == 'basic') {
    if (type.val == 'bool' || type.val == 'void' || type.val == 'int' || type.val == 'str' || type.val == 'char') {
      return { tag: 'primative', val: type.val };
    }

    if (type.val.length == 1) {
      return { tag: 'generic', val: type.val };
    }
    genericCount = 0;
    name = type.val;
  } else if (type.tag == 'generic') {
    genericCount = type.val.generics.length;
    name = type.val.name;
  }

  let result = lookupParseStructEnum(name, genericCount, table, sourceLine);
  if (result == null) {
    logError(sourceLine, `could not find ${name}`)
    return null;
  }

  let map = new Map<string, Type>();
  if (result.tag == 'enum') {
    for (let variant of result.val.variants) {
      let variantType = resolveType(variant.t, table, sourceLine);
      if (variantType == null) {
        return null;
      }
      map.set(variant.name, variantType);
    }

    return { tag: 'enum', val: map };
  } else if (result.tag == 'struct') {
    for (let field of result.val.fields) {
      let fieldType = resolveType(field.t, table, sourceLine);
      if (fieldType == null) {
        return null;
      }
      map.set(field.name, fieldType);
    }

    return  { tag: 'struct', val: map };
  } 

  logError(sourceLine, 'complier bug');
  return null;
}

function mapEq(map1: Map<string, Type>, map2: Map<string, Type>): boolean {
  if (map1.size != map2.size) {
    return false;
  }

  for (let key of map1.keys()) {
    if (!map2.has(key)) {
      return false;
    }
    if (typeEq(map2.get(key)!, map1.get(key)!) == false) {
      return false;
    }
  }
  return true;
}

function typeEq(sub: Type, supa: Type): boolean {
  if (sub.tag != supa.tag) {
    return false;
  }

  if (sub.tag == 'generic' || sub.tag == 'primative') {
    return sub.val == supa.val;
  }

  if (sub.tag == 'enum' && supa.tag == 'enum' || sub.tag == 'struct' && supa.tag == 'struct') {
    return mapEq(sub.val, supa.val);
  }

  if (sub.tag == 'fn' && supa.tag == 'fn') {
    if (typeEq(sub.val.returnType, supa.val.returnType) == false) {
      return false;
    }

    if (sub.val.paramTypes.length != supa.val.paramTypes.length) {
      return false;
    }
    for (let i = 0; i < sub.val.paramTypes.length; i++) {
      if (typeEq(sub.val.paramTypes[i], supa.val.paramTypes[i]) == false) {
        return false;
      }
    }
    return true;
  }

  logError(-1, 'typeEq compiler bug');
  return false;
}

/*
// IMPORTANT fnType can not be passed in as generic. Callee job to ensure valid
function lookupFn(name: string, table: LookupTable, fnType: ParseFnType, sourceLine: number): ParseFn | null {
  let possibleFn: ParseFn | null = null;
  let possibleFnUnit: string | null = null;

  for (let unit of table.units) {
    if (unit.fullName != table.unitName && !table.uses.includes(unit.fullName)) {
      continue;
    }

    for (let fn of unit.fns) {
      if (fn.name != name) {
        continue;
      }
      if (!typeEq(fn.t.returnType, fnType.returnType)) {
        continue;
      }
      if (fn.t.paramTypes.length != fnType.paramTypes.length) {
        continue;
      }

      // ensure all paremeters are allows to be converted
      let allValid = true;
      for (let i = 0; i < fnType.paramTypes.length; i++) {
        if (!typeEq(fn.t.paramTypes[i], fnType.paramTypes[i])) {
          allValid = false;
          break;
        }
      }

      if (allValid == false) {
        continue;
      }

      if (possibleFn != null) {
        logError(sourceLine, `ambiguous function call ${possibleFnUnit}.name and ${unit.fullName}.name`)
        return null;
      }

      possibleFn = fn;
      possibleFnUnit = unit.fullName;
    }
  }

  return possibleFn;
}
*/

// java implementation taken from https://stackoverflow.com/questions/6122571/simple-non-secure-hash-function-for-javascript
function hash(str: string): string {
  let hash = 0;
  for (let i = 0, len = str.length; i < len; i++) {
    let chr = str.charCodeAt(i);
    hash = (hash << 5) - hash + chr;
  }
  return hash + '';
}

function verifyStructEnumHeader(struct: ParseStruct | ParseEnum): [boolean, string[]] {
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
  type: ParseType,
  sourceLine: number,
  lookupTable: LookupTable,
  validGenerics: string[]
): boolean {
  if (type.tag == 'basic') {
    if (type.val.length == 1 && validGenerics.includes(type.val) == false) {
      logError(sourceLine, 'generic not added to struct heading');
      return false;
    }
    let dataType = resolveType(type, lookupTable, sourceLine);
    if (dataType == null) {
      logError(sourceLine, 'could not find type ' + type.val)
      return false;
    }
    return true;
  } else if (type.tag == 'generic') {
    let dataType = resolveType(type, lookupTable, sourceLine);
    for (let g of type.val.generics) {
      if (verifyDataType(g, sourceLine, lookupTable, validGenerics) == false) {
        return false;
      }
    }
    if (dataType == null) {
      return false;
    }
    return true;
  } else if (type.tag == 'opt' || type.tag == 'err' || type.tag == 'link') {
    return verifyDataType(type.val, sourceLine, lookupTable, validGenerics);
  } else if (type.tag == 'fn') {
    for (let i = 0; i < type.val.paramTypes.length; i++) {
      if (verifyDataType(type.val.paramTypes[i], sourceLine, lookupTable, validGenerics) == false) {
        return false;
      }
    }
    if (verifyDataType(type.val.returnType, sourceLine, lookupTable, validGenerics) == false) {
      return false;
    }
    return true;
  }
  return false;
}

function verifyStruct(struct: ParseStruct, lookupTable: LookupTable): boolean {
  let [valid, generics] = verifyStructEnumHeader(struct);
  if (!valid) {
    return false;
  }

  let invalidField = false;
  for (let field of struct.fields) {
    if (verifyDataType(field.t, field.sourceLine, lookupTable, generics) == false) {
      invalidField = true;
    }
  }
  return !invalidField;
}

function verifyEnum(en: ParseEnum, lookupTable: LookupTable): boolean {
  let [valid, generics] = verifyStructEnumHeader(en);
  if (!valid) {
    return false;
  }

  let invalidVariant = false;
  for (let variant of en.variants) {
    if (verifyDataType(variant.t, variant.sourceLine, lookupTable, generics) == false) {
      invalidVariant = true;
    }
  }

  for (let i = 0; i < en.variants.length; i++) {
    for (let j = 0; j < en.variants.length; j++) {
      if (i == j) {
        continue;
      }

      if (en.variants[i].name == en.variants[j].name) {
        logError(en.variants[j].sourceLine, 'repeated variant name in enum');
        return false;
      }
    }
  }

  return !invalidVariant;
}

function analyzeUnitDataTypes(units: ParseProgramUnit[], unitIndex: number): boolean {
  let unit = units[unitIndex];
  let lookupTable = { units, unitName: unit.fullName, uses: unit.uses };

  let invalidDataType = false;
  for (let struct of unit.structs) {
    if (verifyStruct(struct, lookupTable) == false) {
      invalidDataType = true;
    }
  }

  for (let en of unit.enums) {
    if (verifyEnum(en, lookupTable) == false) {
      invalidDataType = true;
    }
  }

  return !invalidDataType;
}

function ensureConcreteType(p: Type): boolean {
  if (p.tag == 'primative') {
    return true;
  } else if (p.tag == 'struct' || p.tag == 'enum') {
    for (let val of p.val.values()) {
      if (ensureConcreteType(val) == false) {
        return false;
      }
    }
    return true;
  } else if (p.tag == 'fn') {
    if (ensureConcreteType(p.val.returnType)) {
      return false;
    }
    for (let val of p.val.paramTypes) {
      if (ensureConcreteType(val)) {
        return false;
      }
    }
    return true;
  } else if (p.tag == 'generic') {
    return false;
  }

  logError(-1, 'compiler error ensureConcreteType');
  return false;
}

function analyzeFn(fn: ParseFn, lookupTable: LookupTable): boolean {
  let scope: Scope = [];
  enterScope(scope);
  for (let i = 0; i < fn.paramNames.length; i++) {
    let paramType = resolveType(fn.t.paramTypes[i], lookupTable, fn.sourceLine);
    if (paramType == null) {
      return false;
    }
    setTypeToScope(scope, fn.paramNames[i], paramType);
  }

  let invalidInst = false;
  let returnType = resolveType(fn.t.returnType, lookupTable, fn.sourceLine);
  if (returnType == null) {
    return false;
  }

  for (let instMeta of fn.body) {
    if (analyzeInst(instMeta, lookupTable, scope, returnType, false) == false) {
      invalidInst = true;
    }
  }

  exitScope(scope);
  return !invalidInst;
}

function analyzeInstBody(
  body: ParseInstMeta[],
  lookupTable: LookupTable,
  scope: Scope,
  returnType: Type,
  inLoop: boolean
): boolean {
  enterScope(scope);

  let isValid = true;
  for (let i = 0; i < body.length; i++) {
    let inst = analyzeInst(body[i], lookupTable, scope, returnType, inLoop);
    if (inst == null) {
      isValid = false;
    }   
  }
  exitScope(scope);

  return !isValid;
}

function analyzeInst(
  instMeta: ParseInstMeta,
  lookupTable: LookupTable,
  scope: Scope,
  returnType: Type,
  inLoop: boolean
): boolean {
  let inst = instMeta.inst;
  if (inst.tag == 'if' || inst.tag == 'elif' || inst.tag == 'for') {
    let exprType = ensureExprValid(inst.val.cond, lookupTable, scope, instMeta.sourceLine);
    if (exprType == null) {
      return false;
    }
    if (typeEq(exprType, BOOL) == false) {
      logError(instMeta.sourceLine, 'expected boolean');
      return false;
    } 
    return analyzeInstBody(inst.val.body, lookupTable, scope, returnType, inst.tag == 'for');
  } else if (inst.tag == 'break' || inst.tag == 'continue') {
    if (!inLoop) {
      logError(instMeta.sourceLine, inst.tag + ' must be used in a loop');
      return false;
    }
    return true;
  } else if (inst.tag == 'return_void') {
    if (returnType != VOID) {
      logError(instMeta.sourceLine, 'expected expr');
      return false;
    }
  } else if (inst.tag == 'return') {
    let exprType = ensureExprValid(inst.val, lookupTable, scope, instMeta.sourceLine);
    if (exprType == null) {
      return false;
    }
    if (typeEq(exprType, returnType) == false) {
      logError(instMeta.sourceLine, 'return type does not match fn signature');
      return false;
    }
  } else if (inst.tag == 'fn_call') {
    let expr = ensureFnCallValid(inst.val, lookupTable, scope, instMeta.sourceLine);
    if (expr == null) {
      return false;
    }
    return true;
  } else if (inst.tag == 'declare') {
    let declareType = resolveType(inst.val.t, lookupTable, instMeta.sourceLine);
    if (declareType == null) {
      return false;
    }

    if (ensureConcreteType(declareType) == false) {
      logError(instMeta.sourceLine, 'declaration must be concrete type');
      return false;
    }

    let exprType = ensureExprValid(inst.val.expr, lookupTable, scope, instMeta.sourceLine);
    if (exprType == null) {
      return false;
    }
    if (typeEq(exprType, declareType) == false) {
      logError(instMeta.sourceLine, 'expression type does not match declaration type');
      return false;
    }
    setTypeToScope(scope, inst.val.name, declareType);
    return true;
  } else if (inst.tag == 'assign') {
    let toType = ensureLeftExprValid(inst.val.to, lookupTable, scope, instMeta.sourceLine);
    if (toType == null) {
      return false;
    }

    let exprType = ensureExprValid(inst.val.expr, lookupTable, scope, instMeta.sourceLine);
    if (exprType == null) {
      return false;
    }

    if (typeEq(exprType, toType) == false) {
      logError(instMeta.sourceLine, 'expression type does not match var type');
      return false;
    }

    return true;
  } else {
    logError(-1, 'compiler error analyzeInst');
    return false;
  }


  logError(-1, 'compiler error analyzeInst');
  return false;
}

function ensureLeftExprValid(
  leftExpr: ParseLeftExpr,
  lookupTable: LookupTable,
  scope: Scope,
  sourceLine: number
): Type | null {
  if (leftExpr.tag == 'dot') {
    let leftType = ensureLeftExprValid(leftExpr.val.left, lookupTable, scope, sourceLine);
    if (leftType == null) {
      return null;
    }

    if (leftType.tag != 'struct' && leftType.tag != 'enum') {
      logError(sourceLine, 'dot op only supported on structs and enums');
      return null;
    }

    let map: Map<string, Type> = leftType.val;
    enterScope(scope);
    for (let [name, type] of map.entries()) {
      setTypeToScope(scope, name, type);
    }
    let rightType = ensureLeftExprValid(leftExpr.val.right, lookupTable, scope, sourceLine);
    exitScope(scope);

    if (rightType == null) {
      return null;
    }
    return rightType;
  } else if (leftExpr.tag == 'arr_offset') {
    let arrType = ensureLeftExprValid(leftExpr.val.var, lookupTable, scope, sourceLine);
    if (arrType == null) {
      return null;
    }

    if (arrType.tag != 'view') {
      logError(sourceLine, 'only view can index');
      return null;
    }

    let indexType = ensureExprValid(leftExpr.val.index, lookupTable, scope, sourceLine);
    if (indexType == null) {
      return null;
    }

    if (typeEq(indexType, INT) == false) {
      logError(sourceLine, 'indexing can only be done with integers');
      return null
    }

    return arrType;
  } else if (leftExpr.tag == 'var') {
    let t = getTypeFromScope(scope, leftExpr.val);
    if (t == null) {
      logError(sourceLine, `${leftExpr.val} not declared`);
      return null;
    }
    return t;
  }

  logError(-1, 'compiler bug ensureLeftExprValid');
  return null;
}

// TODO
/*
function resolveGenerics(concreteType: Type, genericType: Type): Map<string, Type> | null {
  if (genericType.tag == 'generic') {
    let newMap = new Map<string, Type>();
    newMap.set(genericType.val, concreteType);
    return newMap;
  } else {
    if (concreteType.tag != genericType.tag) {
      return null;
    }
  }
}
*/

function ensureFnCallValid(
  fnCall: ParseFnCall,
  lookupTable: LookupTable, 
  scope: Scope,
  sourceLine: number
): Type | null {
  let fnType = ensureLeftExprValid(fnCall.fn, lookupTable, scope, sourceLine);
  if (fnType == null) {
    return null;
  }

  if (fnType.tag != 'fn') {
    return null;
  }

  if (fnCall.exprs.length != fnType.val.paramTypes.length) {
    logError(sourceLine, 'invalid number of parameters');
    return null;
  }

  let exprTypes = [];
  for (let i = 0; i < exprTypes.length; i++) {
    let exprType = ensureExprValid(fnCall.exprs[i], lookupTable, scope, sourceLine);
    if (exprType == null) {
      return null;
    }

    if (ensureConcreteType(exprType) == false) {
      logError(sourceLine, 'concrete type required in fn call');
      return null;
    }

    if (ensureConcreteType(fnType.val.paramTypes[i]) == false) {
      logError(sourceLine, 'generics not implements');
      return null;
    }
    exprTypes.push(exprType);
  }

  return fnType.val.returnType;
}

function computeBinExpr(
  left: ParseExpr,
  right: ParseExpr,
  opParamType: Type,
  lookupTable: LookupTable,
  scope: Scope,
  sourceLine: number
): boolean {
  let expr1 = ensureExprValid(left, lookupTable, scope, sourceLine);
  if (expr1 == null) {
    return false;
  } else if (typeEq(expr1, opParamType) == false) {
    logError(sourceLine, 'expected ' + opParamType.tag);
    return false;
  }

  let expr2 = ensureExprValid(right, lookupTable, scope, sourceLine);
  if (expr2 == null) {
    return false;
  } else if (typeEq(expr2, opParamType) == false) {
    logError(sourceLine, 'expected ' + opParamType.tag);
    return false;
  }
  return true;
}

function ensureExprValid(
  expr: ParseExpr, 
  lookupTable: LookupTable,
  scope: Scope,
  sourceLine: number
): Type | null {
  if (expr.tag == 'bin') {
    let op = expr.val.op;
    if (op == '+' || op == '*' || op == '-' || op == '/' || op == '%' ||
      op == '<' || op == '>' || op == '<=' || op == '>=') {
      if (computeBinExpr(expr.val.left, expr.val.right, INT, lookupTable, scope, sourceLine)) {
        return INT;
      }
      return null;
    } else if (op == '==' || op == '!=') {
      let type = ensureExprValid(expr.val.left, lookupTable, scope, sourceLine);
      if (type == null) {
        return null;
      }
      if (typeEq(type, INT)) {
        if (computeBinExpr(expr.val.left, expr.val.right, INT, lookupTable, scope, sourceLine)) {
          return INT;
        }
      }
      if (typeEq(type, CHAR)) {
        if (computeBinExpr(expr.val.left, expr.val.right, CHAR, lookupTable, scope, sourceLine)) {
          return CHAR;
        }
      }
      if (typeEq(type, BOOL)) {
        if (computeBinExpr(expr.val.left, expr.val.right, BOOL, lookupTable, scope, sourceLine)) {
          return BOOL;
        }
      }
      return null;
    } else if (op == '&&' || op == '||') {
      if (computeBinExpr(expr.val.left, expr.val.right, BOOL, lookupTable, scope, sourceLine)) {
        return BOOL;
      }
    } else if (op == 'is') {
      throw 'not implemented'
    }
  } else if (expr.tag == 'not') {
    let exprType = ensureExprValid(expr.val, lookupTable, scope, sourceLine);
    if (exprType == null) {
      return null;
    }
    if (typeEq(exprType, BOOL) == false) {
      logError(sourceLine, 'not operator on non boolean');
      return null;
    }
  } else if (expr.tag == 'fn_call') {
    return ensureFnCallValid(expr.val, lookupTable, scope, sourceLine);
  } else if (expr.tag == 'struct_init') {
    let fieldMap = new Map<string, Type>();
    for (let initField of expr.val) {
      let exprType = ensureExprValid(initField.expr, lookupTable, scope, sourceLine);
      if (exprType == null) {
        return null;
      }

      if (ensureConcreteType(exprType) == false) {
        logError(sourceLine, 'initializations to fields must not be generic');
        return null;
      }

      fieldMap.set(initField.name, exprType);
    }
    return { tag: 'struct', val: fieldMap };
  } else if (expr.tag == 'str_const') {
    return STR;
  } else if (expr.tag == 'char_const') {
    return CHAR;
  } else if (expr.tag == 'int_const') {
    return INT;
  } else if (expr.tag == 'left_expr') {
    return ensureLeftExprValid(expr.val, lookupTable, scope, sourceLine);
  } 

  logError(-1, 'compiler bug ensureExprValid');
  return null;
}

// outputs to the program the values generated by this unit
function analyzeUnitFns(prog: Program, units: ParseProgramUnit[], unitIndex: number): boolean {
  let unit = units[unitIndex];
  let lookupTable = { units, unitName: unit.fullName, uses: unit.uses };

  let invalidFn = false;
  for (let fn of unit.fns) {
    let validFn = analyzeFn(fn, lookupTable);
    if (validFn == null) {
      invalidFn = true;
    }
  }

  return !invalidFn;
}

type Scope = Map<string, Type>[];

function enterScope(scope: Scope) {
  scope.push(new Map());
}

function exitScope(scope: Scope) {
  scope.pop();
}

function setTypeToScope(scope: Scope, name: string, type: Type) {
  scope[scope.length - 1].set(name, type);
}

function getTypeFromScope(scope: Scope, name: string): Type | null {
  for (let i = scope.length - 1; i >= 0; i--) {
    if (scope[i].has(name)) {
      return scope[i].get(name)!;
    }
  }
  return null;
}

