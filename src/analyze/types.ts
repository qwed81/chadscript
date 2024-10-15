import { logError, compilerError, Position, NULL_POS } from '../index'
import * as Parse from '../parse';

export {
  INT, RANGE_FIELDS, RANGE, BOOL, VOID, CHAR, NUM, STR, BYTE, FMT as STR_BUF, ERR,
  Field, Struct, Type, toStr, typeApplicable, typeApplicableStateful, isGeneric,
  applyGenericMap, canMath, canCompare as canOrder, canEq, canGetIndex, canSetIndex, RefTable,
  getUnitReferences, resolveType, resolveFn, createList, FnResult,
  isRes, createRes, getVariantIndex, NamedParam, getFnNamedParams,
  OperatorResult, getUnitNameOfStruct, standardizeType, isComplex
}

const INT: Type = { tag: 'primative', val: 'int' };
const RANGE_FIELDS: Field[] = [{ name: 'start', type: INT, visibility: null }, { name: 'end', type: INT, visibility: null }];
const RANGE: Type = { tag: 'struct', val: { generics: [], fields: RANGE_FIELDS, id: 'std.core.range' } };
const BOOL: Type = { tag: 'primative', val: 'bool' };
const VOID: Type = { tag: 'primative', val: 'void' }
const CHAR: Type = { tag: 'primative', val: 'char' };
const NUM: Type = { tag: 'primative', val: 'num' };
const BYTE: Type = { tag: 'primative', val: 'byte' };

const STR: Type = {
  tag: 'struct',
  val: {
    fields: [
      { visibility: 'get', name: 'base', type: { tag: 'ptr', val: CHAR } },
      { visibility: 'get', name: 'len', type: INT }
    ],
    generics: [],
    id: 'std.core.str'
  }
}

const ERR: Type = { 
  tag: 'struct',
  val: {
    fields: [
      { visibility: null, name: 'message', type: STR }
    ],
    generics: [],
    id: 'std.core.err'
  }
}

const FMT: Type = {
  tag: 'struct',
  val: {
    fields: [
      { visibility: 'get', name: 'base', type: { tag: 'ptr', val: CHAR } },
      { visibility: 'get', name: 'len', type: INT },
      { visibility: 'get', name: 'capacity', type: INT }
    ],
    generics: [],
    id: 'std.core.Fmt'
  }
}

interface Field {
  visibility: Parse.FieldVisibility
  name: string
  type: Type
}

interface Struct {
  fields: Field[]
  generics: Type[]
  id: string
}

type Type = { tag: 'primative', val: 'bool' | 'void' | 'int' | 'char' | 'num' | 'byte' }
  | { tag: 'generic', val: string }
  | { tag: 'ptr', val: Type }
  | { tag: 'struct', val: Struct }
  | { tag: 'enum', val: Struct }
  | { tag: 'fn', val: { returnType: Type, paramTypes: Type[], linkedParams: boolean[] } }

function getUnitNameOfStruct(struct: Struct): string {
  let lastDot = struct.id.lastIndexOf('.');
  return struct.id.slice(0, lastDot)
}

function createRes(genericType: Type, errorType: Type): Type {
  return {
    tag: 'enum',
    val: {
      id: 'std.core.TypeUnion',
      fields: [
        { name: 'val0', type: genericType, visibility: null },
        { name: 'val1', type: errorType, visibility: null }
      ],
      generics: [genericType, errorType]
    }
  }
}

function createList(genericType: Type): Type {
  return {
    tag: 'struct',
    val: {
      fields: [
        { visibility: 'get', name: 'base', type: { tag: 'ptr', val: genericType } },
        { visibility: 'get', name: 'len', type: INT },
        { visibility: 'get', name: 'capacity', type: INT }
      ],
      generics: [genericType],
      id: 'std.core.Arr'
    }
  }
}

function createTypeUnion(val0Type: Type, val1Type: Type): Type {
  return {
    tag: 'enum',
    val: {
      fields: [
        { visibility: 'pub', name: 'val0', type: val0Type },
        { visibility: 'pub', name: 'val1', type: val1Type },
      ],
      generics: [val0Type, val1Type],
      id: 'std.core.TypeUnion'
    }
  }
}

function isComplex(type: Type): boolean {
  if (type.tag == 'generic') {
    return true;
  }
  if (type.tag == 'struct' || type.tag == 'enum') {
    if (type.val.id == 'std.core.Arr') {
      return true;
    }
    for (let field of type.val.fields) {
      if (isComplex(field.type)) {
        return true;
      }
    }
  }
  return false;
}

// replaces all mutablility of the type so that it can be created into a key
function standardizeType(type: Type) {
  if (type.tag == 'struct' || type.tag == 'enum') {
    for (let i = 0; i < type.val.fields.length; i++) {
      standardizeType(type.val.fields[i].type);
    }
    for (let i = 0; i <type.val.generics.length; i++) {
      standardizeType(type.val.generics[i]);
    }
  }
  else if (type.tag == 'fn') {
    standardizeType(type.val.returnType);
    for (let i = 0; i < type.val.paramTypes.length; i++) {
      standardizeType(type.val.paramTypes[i]);
    }
  }
}

function getVariantIndex(type: Type, fieldName: string): number {
  if (type.tag != 'enum') {
    return -1;
  }

  for (let i = 0; i < type.val.fields.length; i++) {
    if (type.val.fields[i].name == fieldName) {
      return i;
    }
  }

  return -1;
}

function toStr(t: Type | null): string {
  if (t == null) {
    return 'null';
  }
  
  if (t.tag == 'primative') {
    return t.val;
  }

  if (t.tag == 'generic') {
    return t.val;
  }

  if (t.tag == 'ptr') {
    return toStr(t.val) + '*';
  }

  if (t.tag == 'struct' || t.tag == 'enum') {
    let generics: string = '[';
    for (let i = 0; i < t.val.generics.length; i++) {
      generics += toStr(t.val.generics[i]);
      if (i != t.val.generics.length - 1) {
        generics += ', ';
      }     
    }
    if (t.val.generics.length == 0) {
      return t.val.id;
    } else {
      return t.val.id + generics + ']';
    }
  }

  if (t.tag == 'fn') {
    let s = '';
    for (let i = 0; i < t.val.paramTypes.length; i++) {
      s += toStr(t.val.paramTypes[i]);
      if (i != t.val.paramTypes.length - 1) {
        s += ', ';
      }
    }
    return `${toStr(t.val.returnType)}(${s})`;
  }

  return JSON.stringify(t);
}

function isRes(type: Type): boolean {
  return type.tag == 'enum' && type.val.id == 'std.core.TypeUnion';
}

// fnHeader field is used to calculate whether a generic should accept any type
function typeApplicableStateful(
  sub: Type,
  supa: Type,
  genericMap: Map<string, Type>,
  fnHeader: boolean
): boolean {
  if (supa.tag == 'generic') {
    if (!fnHeader && supa.tag != sub.tag) {
      return false;
    }

    if (sub.tag == 'generic') {
      return true;
    }
    else if (genericMap.has(supa.val)) {
      return typeApplicableStateful(sub, genericMap.get(supa.val)!, genericMap, fnHeader);
    }
    genericMap.set(supa.val, sub);
    return true;
  }

  // T -> T|K is valid
  if (supa.tag == 'enum' && supa.val.id == 'std.core.TypeUnion') {
    let firstApplicable = typeApplicableStateful(sub, supa.val.fields[0].type, genericMap, fnHeader);
    let secondApplicable = typeApplicableStateful(sub, supa.val.fields[1].type, genericMap, fnHeader);
    if (firstApplicable || secondApplicable) {
      return true;
    }
  }

  if (sub.tag != supa.tag) {
    return false;
  }

  if (sub.tag == 'primative' && supa.tag == 'primative') {
    return sub.val == supa.val;
  }

  if (sub.tag == 'ptr' && supa.tag == 'ptr') {
    return typeApplicableStateful(sub.val, supa.val, genericMap, fnHeader);
  }

  if (sub.tag == 'enum' && supa.tag == 'enum' || sub.tag == 'struct' && supa.tag == 'struct') {
    if (sub.val.id != supa.val.id) {
      return false;
    }

    if (sub.val.generics.length != supa.val.generics.length) {
      return false;
    }

    for (let i = 0; i < sub.val.generics.length; i++) {
      if (!typeApplicableStateful(sub.val.generics[i], supa.val.generics[i], genericMap, fnHeader)) {
        return false;
      }
    }

    return true;
  }

  if (sub.tag == 'fn' && supa.tag == 'fn') {
    if (!typeApplicableStateful(sub.val.returnType, supa.val.returnType, genericMap, fnHeader)) {
      return false;
    }

    if (sub.val.paramTypes.length != supa.val.paramTypes.length) {
      return false;
    }
    for (let i = 0; i < sub.val.paramTypes.length; i++) {
      if (!typeApplicableStateful(sub.val.paramTypes[i], supa.val.paramTypes[i], genericMap, fnHeader)) {
        return false;
      }
    }
    return true;
  }

  compilerError('typeEq type not handled');
  return false;
}

function typeApplicable(sub: Type, supa: Type, fnHeader: boolean): boolean {
  let genericMap = new Map<string, Type>();
  return typeApplicableStateful(sub, supa, genericMap, fnHeader);
}

function applyGenericMap(input: Type, map: Map<string, Type>): Type {
  if (input.tag == 'generic') {
    if (map.has(input.val)) {
      return map.get(input.val)!;
    }
    return input;
  }
  else if (input.tag == 'primative') {
    return input;
  }
  else if (input.tag == 'struct' || input.tag == 'enum') {
    let newGenerics: Type[] = [];
    let newFields: Field[] = [];
    for (let field of input.val.fields) {
      let fieldType = applyGenericMap(field.type, map);
      newFields.push({ name: field.name, type: fieldType, visibility: field.visibility });
    }
    for (let generic of input.val.generics) {
      newGenerics.push(applyGenericMap(generic, map));
    }
    return { tag: input.tag, val: { fields: newFields, generics: newGenerics, id: input.val.id }};
  }
  else if (input.tag == 'ptr') {
    return { tag: 'ptr', val: applyGenericMap(input.val, map) };
  }
  else if (input.tag == 'fn') {
    let newReturnType: Type = applyGenericMap(input.val.returnType, map);
    let newParamTypes: Type[] = []
    for (let paramType of input.val.paramTypes) {
      let newParamType = applyGenericMap(paramType, map);
      newParamTypes.push(newParamType);
    }
    return {
      tag: 'fn',
      val: {
        returnType: newReturnType,
        paramTypes: newParamTypes,
        linkedParams: input.val.linkedParams 
      } 
    };
  }

  return input;
}

function isGeneric(a: Type): boolean {
  if (a.tag == 'generic') {
    return true;
  }
  else if (a.tag == 'primative') {
    return false;
  }
  else if (a.tag == 'struct' || a.tag == 'enum') {
    for (let generic of a.val.generics) {
      if (isGeneric(generic)) {
        return false;
      }
    }
  }
  else if (a.tag == 'fn') {
    if (isGeneric(a.val.returnType)) {
      return true;
    }
    for (let paramType of a.val.paramTypes) {
      if (isGeneric(paramType)) {
        return true;
      }
    }
  }
  else if (a.tag == 'ptr') {
    return isGeneric(a.val);
  }
  return false;
}

type OperatorResult = { tag: 'default', returnType: Type }
  | { tag: 'fn', returnType: Type, fnType: Type, unitName: string, fnName: string }
  | null

function canMath(a: Type, b: Type, refTable: RefTable): OperatorResult {
  if (typeApplicable(a, INT, false)) {
    if (typeApplicable(b, INT, false)) {
      return { tag: 'default', returnType: INT };
    } else if (typeApplicable(b, NUM, false)) {
      return { tag: 'default', returnType: NUM };
    } else if (typeApplicable(b, BYTE, false)) {
      return { tag: 'default', returnType: INT };
    } else if (typeApplicable(b, CHAR, false)) {
      return { tag: 'default', returnType: INT };
    }
  }
  else if (typeApplicable(a, BYTE, false)) {
    if (typeApplicable(b, INT, false)) {
      return { tag: 'default', returnType: INT };
    } else if (typeApplicable(b, BYTE, false)) {
      return { tag: 'default', returnType: BYTE };
    }
  }
  else if (typeApplicable(a, CHAR, false)) {
    if (typeApplicable(b, INT, false)) {
      return { tag: 'default', returnType: INT };
    } else if (typeApplicable(b, CHAR, false)) {
      return { tag: 'default', returnType: CHAR };
    }
  }
  else if (typeApplicable(a, NUM, false)) {
    if (typeApplicable(b, INT, false) || typeApplicable(b, NUM, false)) {
      return { tag: 'default', returnType: NUM };
    }
  }

  return null;
}

function canCompare(a: Type, b: Type, refTable: RefTable): OperatorResult {
  if (typeApplicable(a, INT, false) && typeApplicable(b, INT, false)) {
    return { tag: 'default', returnType: BOOL };
  }
  if (typeApplicable(a, NUM, false) && typeApplicable(b, NUM, false)) {
    return { tag: 'default', returnType: BOOL };
  }

  let fnResult = resolveFn('compare', null, [a, b], refTable, null);
  if (fnResult == null || fnResult.fnType.tag != 'fn') {
    return null;
  }

  return {
    tag: 'fn',
    returnType: fnResult.fnType.val.returnType,
    fnName: fnResult.fnName,
    fnType: fnResult.fnType,
    unitName: fnResult.unitName
  };
}

function canEq(a: Type, b: Type, refTable: RefTable): OperatorResult {
  if (typeApplicable(a, INT, false) && typeApplicable(b, INT, false)) {
    return { tag: 'default', returnType: BOOL };
  }
  if (typeApplicable(a, CHAR, false) && typeApplicable(b, CHAR, false)) {
    return { tag: 'default', returnType: BOOL };
  }
  if (typeApplicable(a, BOOL, false) && typeApplicable(b, BOOL, false)) {
    return { tag: 'default', returnType: BOOL };
  }
  if (typeApplicable(a, BYTE, false) && typeApplicable(b, BYTE, false)) {
    return { tag: 'default', returnType: BOOL };
  }

  let fnResult = resolveFn('eq', BOOL, [a, b], refTable, null);
  if (fnResult == null) {
    return null;
  }
  return {
    tag: 'fn',
    returnType: BOOL,
    fnName: fnResult.fnName,
    fnType: fnResult.fnType,
    unitName: fnResult.unitName
  };
}

function canGetIndex(struct: Type, index: Type, refTable: RefTable): OperatorResult | null {
  if (struct.tag == 'ptr') {
    return { tag: 'default', returnType: struct.val };
  }

  let fnResult = resolveFn('getIndex', null, [struct, index], refTable, null);
  if (fnResult != null && fnResult.fnType.tag == 'fn' && fnResult.fnType.val.returnType.tag == 'ptr') {
    return {
      tag: 'fn',
      returnType: fnResult.fnType.val.returnType,
      fnName: fnResult.fnName,
      fnType: fnResult.fnType,
      unitName: fnResult.unitName
    };
  }

  // try to index with options
  if (index.tag == 'enum' && index.val.id == 'std.core.opt') {
    let retry = canGetIndex(struct, index.val.fields[1].type, refTable);
    if (retry != null) {
      return retry;
    }
  }
  if (struct.tag == 'enum' && struct.val.id == 'std.core.opt') {
    let retry = canGetIndex(struct.val.fields[1].type, index, refTable);
    if (retry != null) {
      return retry;
    }
  }

  // try to index with results
  if (index.tag == 'enum' && index.val.id == 'std.core.res') {
    let retry = canGetIndex(struct, index.val.fields[0].type, refTable);
    if (retry != null) {
      return retry;
    }
  }
  if (struct.tag == 'enum' && struct.val.id == 'std.core.res') {
    let retry = canGetIndex(struct.val.fields[0].type, index, refTable);
    if (retry != null) {
      return retry;
    }
  }

  return null;
}

function canSetIndex(struct: Type, index: Type, exprType: Type, refTable: RefTable): OperatorResult | null {
  if (struct.tag == 'ptr') {
    return { tag: 'default', returnType: struct.val };
  }

  let fnResult = resolveFn('prepareIndex', null, [struct, index, exprType], refTable, null);
  if (fnResult != null && fnResult.fnType.tag == 'fn' && fnResult.fnType.val.returnType.tag == 'ptr') {
    return {
      tag: 'fn',
      returnType: fnResult.fnType.val.returnType,
      fnName: fnResult.fnName,
      fnType: fnResult.fnType,
      unitName: fnResult.unitName
    };
  }

  // try to index with options
  if (index.tag == 'enum' && index.val.id == 'std.core.opt') {
    let retry = canSetIndex(struct, index.val.fields[1].type, exprType, refTable);
    if (retry != null) {
      return retry;
    }
  }
  if (struct.tag == 'enum' && struct.val.id == 'std.core.opt') {
    let retry = canSetIndex(struct.val.fields[1].type, index, exprType, refTable);
    if (retry != null) {
      return retry;
    }
  }

  // try to index with results
  if (index.tag == 'enum' && index.val.id == 'std.core.res') {
    let retry = canSetIndex(struct, index.val.fields[0].type, exprType, refTable);
    if (retry != null) {
      return retry;
    }
  }
  if (struct.tag == 'enum' && struct.val.id == 'std.core.res') {
    let retry = canSetIndex(struct.val.fields[0].type, index, exprType, refTable);
    if (retry != null) {
      return retry;
    }
  }

  return null;
}

interface RefTable {
  units: Parse.ProgramUnit[]
  thisUnit: Parse.ProgramUnit
  allUnits: Parse.ProgramUnit[]
}

function getUnitReferences(
  thisUnit: Parse.ProgramUnit,
  allUnits: Parse.ProgramUnit[]
): RefTable {
  let newUnits: Parse.ProgramUnit[] = [thisUnit];
  for (let i = 0; i < allUnits.length; i++) {
    let addCore = allUnits[i].fullName == 'std.core' && thisUnit.fullName != 'std.core';
    if (thisUnit.uses.includes(allUnits[i].fullName) || addCore) {
      newUnits.push(allUnits[i]);
    }
  }

  return { units: newUnits, allUnits, thisUnit };
}

function resolveType(
  def: Parse.Type,
  refTable: RefTable,
  // if position is null do not display errors
  position: Position | null
): Type | null {
  if (def.tag == 'basic') {
    if (def.val == 'int' || def.val == 'num' || def.val == 'bool' || def.val == 'char' || def.val == 'void' || def.val == 'byte') {
      return { tag: 'primative', val: def.val };
    }
    if (def.val == 'nil') {
      return { tag: 'primative', val: 'void' };
    }
    if (def.val.length == 1 && def.val >= 'A' && def.val <= 'Z') {
      return { tag: 'generic', val: def.val };
    }
    return resolveStruct(def.val, [],  refTable, position);
  } 
  else if (def.tag == 'link') {
    return resolveType(def.val, refTable, position);
  }
  else if (def.tag == 'type_union') {
    let val1 = resolveType(def.val0, refTable, position);
    let val2 = resolveType(def.val1, refTable, position);
    if (val1 == null || val2 == null) {
      return null;
    }
    return createTypeUnion(val1, val2);
  }
  else if (def.tag == 'generic') {
    let resolvedGenerics: Type[] = [];
    for (let generic of def.val.generics) {
      if (generic.tag == 'link') {
        if (position != null) {
          logError(position, 'ref not supported in generics');
        }
        return null;
      }

      let resolvedGeneric = resolveType(generic, refTable, position);
      if (resolvedGeneric == null) {
        return null;
      }
      resolvedGenerics.push(resolvedGeneric);
    }

    if (def.val.name == 'ptr') {
      if (resolvedGenerics.length != 1 && position != null) {
        logError(position, 'pointer expected 1 generic');
      }
      return { tag: 'ptr', val: resolvedGenerics[0] }
    }

    return resolveStruct(def.val.name, resolvedGenerics, refTable, position);
  } 
  else if (def.tag == 'fn') {
    let paramTypes: Type[] = [];
    let linked: boolean[] = [];
    for (let parseParam of def.val.paramTypes) {
      let resolvedParam = resolveType(parseParam, refTable, position);
      if (resolvedParam == null) {
        return null;
      }
      linked.push(parseParam.tag == 'link');
      paramTypes.push(resolvedParam);
    }
    let returnType = resolveType(def.val.returnType, refTable, position);
    if (returnType != null) {
      return { tag: 'fn', val: { paramTypes, returnType, linkedParams: linked } };
    }
  }

  return null;
}

function resolveStruct(
  name: string,
  generics: Type[],
  refTable: RefTable,
  // if position is null do not display errors
  position: Position | null
): Type | null {
  let possibleStructs: Type[] = [];
  for (let unit of refTable.units) {
    let unitRefTable = getUnitReferences(unit, refTable.allUnits);

    let items: ['struct' | 'enum', Parse.Struct][] = Array.from(unit.structs).map(x => ['struct', x]);
    items.push(...Array.from(unit.enums).map(x => ['enum', x]) as ['enum', Parse.Struct][]);
    for (let item of items) {
      let structDef = item[1];
      if (structDef.header.name != name) {
        continue;
      }

      if (structDef.header.pub == false && unit.fullName != refTable.thisUnit.fullName) {
        continue;
      }

      if (structDef.header.generics.length != generics.length) {
        continue;
      }
      
      let genericMap = new Map<string, Type>();
      for (let i = 0; i < generics.length; i++) {
        let genericName = structDef.header.generics[i]
        genericMap.set(genericName, generics[i]);
      }

      let fields: Field[] = [];
      for (let field of structDef.fields) {
        let fieldType = resolveType(field.t, unitRefTable, position);
        if (fieldType == null) {
          compilerError('should have been checked prior');
          return null;
        }

        let concreteFieldType = applyGenericMap(fieldType, genericMap);
        fields.push({ name: field.name, type: concreteFieldType, visibility: field.visibility });
      }

      let thisStructId = unit.fullName + '.' + structDef.header.name;
      let thisStruct: Type = { tag: item[0], val: { fields, generics, id: thisStructId } };
      possibleStructs.push(thisStruct);
    }
  }

  if (possibleStructs.length > 1) {
    if (position != null) {
      logError(position, 'ambiguous struct');
    }
    return null;
  }

  if (possibleStructs.length == 0) {
    if (position != null) {
      logError(position, `struct '${name}' could not be found`);
    }
    return null;
  }

  return possibleStructs[0];
}

interface NamedParam {
  name: string,
  type: Type,
  expr: Parse.Expr
}

// this will perform a lookup including the named param types
// which should be unique as there is no overloading with normal
// and named parameters
function getFnNamedParams(
  unitName: string,
  fnName: string,
  fnType: Type,
  refTable: RefTable,
  position: Position
): NamedParam[] {
  if (fnType.tag != 'fn') {
    compilerError('should be fn type');
    return [];
  }

  for (let i = 0; i < refTable.units.length; i++) {
    if (refTable.units[i].fullName != unitName) {
      continue;
    }
    for (let fn of refTable.units[i].fns) {
      if (fn.name != fnName) {
        continue;
      }

      let genericMap: Map<string, Type> = new Map();
      let returnType = resolveType(fn.t.returnType, refTable, position);
      if (returnType == null) {
        compilerError('return type should have been checked earlier');
        return [];
      }

      // to standardize the named param function
      let fnTypeReturnType = JSON.parse(JSON.stringify(fnType.val.returnType));
      standardizeType(fnTypeReturnType);
      if (!typeApplicableStateful(fnTypeReturnType, returnType, genericMap, true)) {
        continue;
      }

      let namedParams: NamedParam[] = [];
      let fnMatches = true;
      for (let j = 0; j < fn.paramNames.length; j++) {
        let paramType = resolveType(fn.t.paramTypes[j], refTable, position);
        if (paramType == null) {
          fnMatches = false;
          break;
        }

        if (j < fnType.val.paramTypes.length 
          && !typeApplicableStateful(fnType.val.paramTypes[j], paramType, genericMap, true)) {
          fnMatches = false;
          break;
        }

        if (fn.defaultExprs[j] != null) {
          namedParams.push({
            name: fn.paramNames[j],
            type: applyGenericMap(paramType, genericMap),
            expr: fn.defaultExprs[j]!
          });
        }
      }

      if (fnMatches) {
        return namedParams;
      }
    }
  }

  return [];
}

interface FnResult {
  fnType: Type,
  unitName: string
  fnName: string,
  paramNames: string[]
}

function resolveFn(
  name: string,
  returnType: Type | null,
  paramTypes: (Type | null)[] | null,
  refTable: RefTable,
  // if calleePosition is null then do not display errors
  calleePosition: Position | null
): FnResult | null {

  let possibleFns: FnResult[] = [];
  let wrongTypeFns: Parse.Fn[] = [];
  for (let unit of refTable.units) {
    let unitRefTable = getUnitReferences(unit, refTable.allUnits);
    for (let fnDef of unit.fns) {
      if (fnDef.name != name) {
        continue;
      }

      if (fnDef.pub == false && unit.fullName != refTable.thisUnit.fullName) {
        continue;
      }
      
      let genericMap = new Map<string, Type>();
      let namedParamCount = 0;
      for (let i = 0; i < fnDef.defaultExprs.length; i++) {
        if (fnDef.defaultExprs[i] != null) {
          namedParamCount += 1;
        }
      }
      if (paramTypes != null && fnDef.t.paramTypes.length - namedParamCount != paramTypes.length) {
        wrongTypeFns.push(fnDef);
        continue;
      }

      let linkedParams: boolean[] = [];
      let concreteParamTypes: Type[] = [];
      let paramNames: string[] = [];
      let allParamsOk = true;
      for (let i = 0; i < fnDef.t.paramTypes.length; i++) {
        if (fnDef.t.paramTypes[i].tag == 'link') {
          linkedParams.push(true);
        } else {
          linkedParams.push(false);
        }

        paramNames.push(fnDef.paramNames[i]);

        let defParamType = resolveType(fnDef.t.paramTypes[i], refTable, calleePosition);
        if (defParamType == null) {
          compilerError('param type invalid (checked before)');
          return null;
        }

        // named parameters influence the type of the function but can not
        // be used in generics
        if (paramTypes != null) {
          let paramType = paramTypes[i];
          if (fnDef.defaultExprs[i] == null && paramType != null && !typeApplicableStateful(paramType, defParamType, genericMap, true)) {
            wrongTypeFns.push(fnDef);
            allParamsOk = false;
            break;
          }
        }
        concreteParamTypes.push(applyGenericMap(defParamType, genericMap));
      }
      if (!allParamsOk) {
        continue;
      }
      let defReturnType = resolveType(fnDef.t.returnType, unitRefTable, calleePosition);
      if (defReturnType == null) {
        compilerError('return type invalid (checked before)');
        return null;
      }
      if (returnType != null) {
        let wrongType = false;
        if (!typeApplicableStateful(returnType, defReturnType, genericMap, true)) {
          wrongType = true;
        }

        if (wrongType) {
          wrongTypeFns.push(fnDef);
          continue;
        }
      }
      let concreteReturnType: Type = applyGenericMap(defReturnType, genericMap);
      let fnType: Type = {
        tag: 'fn',
        val: {
          returnType: concreteReturnType,
          paramTypes: concreteParamTypes, 
          linkedParams 
        }
      };

      possibleFns.push({
        paramNames,
        unitName: unit.fullName,
        fnName: fnDef.name,
        fnType,
      });
    }
  }

  if (possibleFns.length == 1) {
    return possibleFns[0];
  }

  // give a useful error about why it can't resolve the function
  if (possibleFns.length > 1) {
    if (calleePosition != null) {
      logError(calleePosition, 'function call is ambiguous');
    }
    return null;
  }

  if (wrongTypeFns.length > 0) {
    if (calleePosition != null) {
      logError(calleePosition, 'function does not match type signature');
    }
    return null;
  }

  if (calleePosition != null) {
    logError(calleePosition, `could not find ${name}`);
  }
  return null;
}

