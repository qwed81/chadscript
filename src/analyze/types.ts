import { logError, compilerError, Position, NULL_POS, allUnits } from '../util'
import { HeaderInclude, parseHeaderFile, ExternFn } from '../header';
import * as Parse from '../parse';

export {
  INT, RANGE_FIELDS, RANGE, BOOL, VOID, CHAR, STR, FMT as STR_BUF, ERR,
  Field, Struct, Type, toStr, typeApplicable, typeApplicableStateful, isGeneric,
  applyGenericMap, canMath, canCompare as canOrder, canEq, canGetIndex, canSetIndex, RefTable,
  getUnitReferences, resolveType, resolveFn, createList, FnResult,
  isRes, createRes, getVariantIndex, NamedParam, getFnNamedParams, primativeList,
  OperatorResult, getUnitNameOfStruct, isComplex, canBitwise, TYPE, FIELD, FN, STRUCT
}

const INT: Type = { tag: 'primative', val: 'int' };
const RANGE_FIELDS: Field[] = [{ name: 'start', type: INT, visibility: null, recursive: false }, { name: 'end', type: INT, visibility: null, recursive: false }];
const RANGE: Type = { tag: 'struct', val: { generics: [], fields: RANGE_FIELDS, id: 'std/core.range', unit: 'std/core' } };
const BOOL: Type = { tag: 'primative', val: 'bool' };
const VOID: Type = { tag: 'primative', val: 'void' }
const CHAR: Type = { tag: 'primative', val: 'char' };

const STR: Type = {
  tag: 'struct',
  val: {
    fields: [
      { visibility: 'get', name: 'base', type: { tag: 'ptr', val: CHAR }, recursive: false },
      { visibility: 'get', name: 'len', type: INT, recursive: false }
    ],
    generics: [],
    id: 'std/core.str',
    unit: 'std/core'
  },
}

const ERR: Type = { 
  tag: 'struct',
  val: {
    fields: [
      { visibility: null, name: 'message', type: STR, recursive: false }
    ],
    generics: [],
    id: 'std/core.err',
    unit: 'std/core'
  }
}

const FMT: Type = {
  tag: 'struct',
  val: {
    fields: [
      { visibility: 'get', name: 'base', type: { tag: 'ptr', val: CHAR }, recursive: false },
      { visibility: 'get', name: 'len', type: INT, recursive: false },
      { visibility: 'get', name: 'capacity', type: INT, recursive: false }
    ],
    generics: [],
    id: 'std/core.Fmt',
    unit: 'std/core'
  }
}


let _type: Type | null = null;
function TYPE(): Type {
  if (_type == null) {
    let table = getUnitReferencesFromName('std/core')!;
    _type = resolveStruct('Type', [], table, null);
  }
  return _type!;
}

let _field: Type | null = null;
function FIELD(): Type {
  if (_field == null) {
    let table = getUnitReferencesFromName('std/core')!;
    _field = resolveStruct('TypeField', [], table, null);
  }
  return _field!;
}

let _fn: Type | null = null;
function FN(): Type {
  if (_fn == null) {
    let table = getUnitReferencesFromName('std/core')!;
    _fn = resolveStruct('TypeFn', [], table, null);
  }
  return _fn!;
}

let _struct: Type | null = null;
function STRUCT(): Type {
  if (_struct == null) {
    let table = getUnitReferencesFromName('std/core')!;
    _struct = resolveStruct('TypeStruct', [], table, null);
  }
  return _struct!;
}

function primativeList(): Type[] {
  let primatives: Type[] = [];
  primatives.push({ tag: 'primative', val: 'bool' });
  primatives.push({ tag: 'primative', val: 'void' });
  primatives.push({ tag: 'primative', val: 'int' });
  primatives.push({ tag: 'primative', val: 'char' });
  primatives.push({ tag: 'primative', val: 'i8' });
  primatives.push({ tag: 'primative', val: 'i16' });
  primatives.push({ tag: 'primative', val: 'i32' });
  primatives.push({ tag: 'primative', val: 'u8' });
  primatives.push({ tag: 'primative', val: 'u16' });
  primatives.push({ tag: 'primative', val: 'u32' });
  primatives.push({ tag: 'primative', val: 'u64' });
  primatives.push({ tag: 'primative', val: 'f32' });
  primatives.push({ tag: 'primative', val: 'f64' });
  return primatives;
}

interface Field {
  recursive: boolean,
  visibility: Parse.FieldVisibility
  name: string
  type: Type
}

interface Struct {
  fields: Field[]
  generics: Type[]
  id: string,
  unit: string
}

type Primatives = 'bool' | 'void' | 'int' | 'char'
  | 'i8' | 'i16' | 'i32'
  | 'u8' | 'u16' | 'u32' | 'u64'
  | 'f32' | 'f64';

type Type = { tag: 'primative', val: Primatives  }
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
      id: 'std/core.TypeUnion',
      fields: [
        { name: 'val0', type: genericType, visibility: null, recursive: false },
        { name: 'val1', type: errorType, visibility: null, recursive: false }
      ],
      generics: [genericType, errorType],
      unit: 'std/core'
    }
  }
}

function createList(genericType: Type): Type {
  return {
    tag: 'struct',
    val: {
      fields: [
        { visibility: 'get', name: 'base', type: { tag: 'ptr', val: genericType }, recursive: false },
        { visibility: 'get', name: 'len', type: INT, recursive: false },
        { visibility: 'get', name: 'capacity', type: INT, recursive: false }
      ],
      generics: [genericType],
      id: 'std/core.Arr',
      unit: 'std/core'
    }
  }
}

function createTypeUnion(val0Type: Type, val1Type: Type): Type {
  return {
    tag: 'enum',
    val: {
      fields: [
        { visibility: 'pub', name: 'val0', type: val0Type, recursive: false },
        { visibility: 'pub', name: 'val1', type: val1Type, recursive: false },
      ],
      generics: [val0Type, val1Type],
      id: 'std/core.TypeUnion',
      unit: 'std/core'
    }
  }
}

function isComplex(type: Type): boolean {
  if (type.tag == 'generic') {
    return true;
  }
  if (type.tag == 'struct' || type.tag == 'enum') {
    if (type.val.id == 'std/core.Arr') {
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
// function standardizeType(type: Type, recursive: Set<Type> = new Set()) {}

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
    return '*' + toStr(t.val);
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
  return type.tag == 'enum' && type.val.id == 'std/core.TypeUnion';
}

// fnHeader field is used to calculate whether a generic should accept any type
function typeApplicableStateful(
  sub: Type,
  supa: Type,
  genericMap: Map<string, Type>,
  fnHeader: boolean,
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
  if (supa.tag == 'enum' && supa.val.id == 'std/core.TypeUnion') {
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
        console.log(sub.val.generics, supa.val.generics, genericMap, fnHeader);
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

function applyGenericMap(input: Type, map: Map<string, Type>, recursive: Set<Type> = new Set()): Type {
  if (recursive.has(input)) {
    return input;
  }
  recursive.add(input);

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

    let copySet = new Set(recursive);
    for (let field of input.val.fields) {
      let fieldType = applyGenericMap(field.type, map, copySet);
      newFields.push({ name: field.name, type: fieldType, visibility: field.visibility, recursive: field.recursive });
    }
    for (let generic of input.val.generics) {
      newGenerics.push(applyGenericMap(generic, map, recursive));
    }
    return { tag: input.tag, val: { fields: newFields, generics: newGenerics, id: input.val.id, unit: input.val.unit }};
  }
  else if (input.tag == 'ptr') {
    return { tag: 'ptr', val: applyGenericMap(input.val, map, recursive) };
  }
  else if (input.tag == 'fn') {
    let newReturnType: Type = applyGenericMap(input.val.returnType, map, recursive);
    let newParamTypes: Type[] = []
    for (let paramType of input.val.paramTypes) {
      let newParamType = applyGenericMap(paramType, map, recursive);
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

function canBitwise(a: Type, b: Type, refTable: RefTable): OperatorResult {
  if (a.tag != 'primative' || b.tag != 'primative') {
    return null;
  }

  if (a.tag != b.tag) {
    return null;
  }

  if (a.val == 'i32' || a.val == 'i16' || a.val == 'i8'
    || a.val == 'u64'|| a.val == 'u32' || a.val == 'u16' || a.val == 'u8'
    || a.val == 'int' || a.val == 'char') {
    return { tag: 'default', returnType: a };
  }

  return null;
}

function canMath(a: Type, b: Type, refTable: RefTable): OperatorResult {
  if (a.tag != 'primative' || b.tag != 'primative') {
    return null;
  }

  if (a.tag != b.tag) {
    return null;
  }

  if (a.val == 'int' || a.val == 'i32' || a.val == 'i16' || a.val == 'i8'
    || a.val == 'u64'|| a.val == 'u32' || a.val == 'u16' || a.val == 'u8'
    || a.val == 'f64' || a.val == 'f32' || a.val == 'char') {
    return { tag: 'default', returnType: a };
  }

  return null;
}

function canCompare(a: Type, b: Type, refTable: RefTable): OperatorResult {
  if (a.val == 'int' || a.val == 'i32' || a.val == 'i16' || a.val == 'i8'
    || a.val == 'u64'|| a.val == 'u32' || a.val == 'u16' || a.val == 'u8'
    || a.val == 'f64' || a.val == 'f32' || a.val == 'char') {
    return { tag: 'default', returnType: BOOL };
  }

  let fnResult = resolveFn('compare', null, null, [a, b], refTable, null);
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
  if (a.val == 'int' || a.val == 'i32' || a.val == 'i16' || a.val == 'i8'
    || a.val == 'u64'|| a.val == 'u32' || a.val == 'u16' || a.val == 'u8'
    || a.val == 'f64' || a.val == 'f32' || a.val == 'char') {
    return { tag: 'default', returnType: BOOL };
  }

  let fnResult = resolveFn('eq', null, BOOL, [a, b], refTable, null);
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

function isInt(a: Type): boolean {
  return a.val == 'int' || a.val == 'i32' || a.val == 'i16' || a.val == 'i8'
    || a.val == 'u64'|| a.val == 'u32' || a.val == 'u16' || a.val == 'u8';
}

function canGetIndex(struct: Type, index: Type, refTable: RefTable): OperatorResult | null {
  if (struct.tag == 'ptr' && isInt(index)) {
    return { tag: 'default', returnType: struct.val };
  }
  else if (struct.tag == 'struct' && isInt(index)) {
    if (struct.val.id == 'std/core.Arr') {
      return { tag: 'default', returnType: struct.val.generics[0] };
    }
    if (struct.val.id == 'std/core.str') {
      return { tag: 'default', returnType: CHAR }
    }
    if (struct.val.id == 'std/core.Fmt') {
      return { tag: 'default', returnType: CHAR }
    }
  }
  else if (struct.tag == 'struct' && index.tag == 'struct' && index.val.id == 'std/core.range') {
    if (struct.val.id == 'std/core.Arr') {
      return { tag: 'default', returnType: struct.val.generics[0] };
    }
    if (struct.val.id == 'std/core.str') {
      return { tag: 'default', returnType: CHAR }
    }
    if (struct.val.id == 'std/core.Fmt') {
      return { tag: 'default', returnType: CHAR }
    }
  }

  let fnResult = resolveFn('getIndex', null, null, [struct, index], refTable, null);
  if (fnResult != null && fnResult.fnType.tag == 'fn' && fnResult.fnType.val.returnType.tag == 'ptr') {
    return {
      tag: 'fn',
      returnType: fnResult.fnType.val.returnType,
      fnName: fnResult.fnName,
      fnType: fnResult.fnType,
      unitName: fnResult.unitName
    };
  }

  return null;
}

function canSetIndex(struct: Type, index: Type, exprType: Type, refTable: RefTable): OperatorResult | null {
  if (struct.tag == 'ptr' && isInt(index)) {
    return { tag: 'default', returnType: struct.val };
  }
  else if (struct.tag == 'struct' && isInt(index)) {
    if (struct.val.id == 'std/core.Arr') {
      return { tag: 'default', returnType: struct.val.generics[0] };
    }
    if (struct.val.id == 'std/core.Fmt') {
      return { tag: 'default', returnType: CHAR }
    }
  }
  else if (struct.tag == 'struct' && index.tag == 'struct' && index.val.id == 'std/core.range') {
    if (struct.val.id == 'std/core.Arr') {
      return { tag: 'default', returnType: struct };
    }
    if (struct.val.id == 'std/core.Fmt') {
      return { tag: 'default', returnType: STR }
    }
  }

  let fnResult = resolveFn('prepareIndex', null, null, [struct, index, exprType], refTable, null);
  if (fnResult != null && fnResult.fnType.tag == 'fn' && fnResult.fnType.val.returnType.tag == 'ptr') {
    return {
      tag: 'fn',
      returnType: fnResult.fnType.val.returnType,
      fnName: fnResult.fnName,
      fnType: fnResult.fnType,
      unitName: fnResult.unitName
    };
  }

  return null;
}

// all headers that have been parsed already
let parsedHeaders: Map<string, HeaderInclude> = new Map();

interface RefTable {
  units: Parse.ProgramUnit[]
  globalUnits: boolean[] // determines which units are 'non global'
  thisUnit: Parse.ProgramUnit
  allUnits: Parse.ProgramUnit[]
  includes: HeaderInclude[]
}

function getUnitReferencesFromName(name: string): RefTable | null {
  let thisUnit: Parse.ProgramUnit | null = null;
  for (let i = 0; i < allUnits.length; i++) {
    if (allUnits[i].fullName == name) {
      thisUnit = allUnits[i];
      return getUnitReferences(thisUnit);
    }
  }
  return null;
}

function getUnitReferences(
  thisUnit: Parse.ProgramUnit,
): RefTable {
  let newUnits: Parse.ProgramUnit[] = [thisUnit];
  let globalUnits: boolean[] = [true];
  let includes: HeaderInclude[] = [];

  for (let i = 0; i < allUnits.length; i++) {
    let addCore = allUnits[i].fullName == 'std/core' && thisUnit.fullName != 'std/core';
    if (addCore) {
      newUnits.push(allUnits[i]);
      globalUnits.push(true)
      continue;
    }

    for (let use of thisUnit.uses) {
      if (use.unitName == allUnits[i].fullName) {
        newUnits.push(allUnits[i]);
        globalUnits.push(use.as == null);
        break;
      }
    }
  }

  // parse the C header files
  for (let use of thisUnit.uses) {
    if (!use.unitName.endsWith('.h')) {
      continue;
    }

    // cache the value so header files don't need to be parsed every time
    let include: HeaderInclude | null = null;
    if (parsedHeaders.has(use.unitName)) {
      include = parsedHeaders.get(use.unitName)!;
    }
    else {
      include = parseHeaderFile(use.unitName);
    }

    if (include != null) {
      parsedHeaders.set(use.unitName, include);
      includes.push(include)
    }
  }

  return {
    units: newUnits,
    globalUnits: globalUnits,
    allUnits,
    thisUnit,
    includes 
  };
}

function resolveType(
  def: Parse.Type,
  refTable: RefTable,
  // if position is null do not display errors
  position: Position | null,
): Type | null {
  if (def.tag == 'basic') {
    if (def.val == 'int' || def.val == 'bool' || def.val == 'char' || def.val == 'void'
      || def.val == 'i32' || def.val == 'i16' || def.val == 'i8'
      || def.val == 'u64' || def.val == 'u32' || def.val == 'u16' || def.val == 'u8'
      || def.val == 'f64' || def.val == 'f32'
      ) {
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
  else if (def.tag == 'ptr') {
    let innerType = resolveType(def.val, refTable, position);
    if (innerType == null) {
      return null;
    }
    return { tag: 'ptr', val: innerType };
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

function serializeGenerics(generics: Type[]): string {
  let genericStr = '';
  for (let i = 0; i < generics.length; i++) {
    genericStr += toStr(generics[i]) + '|';
  }
  return genericStr;
}

let typeCache: Map<string, Type> = new Map();
function resolveStruct(
  name: string,
  generics: Type[],
  refTable: RefTable,
  // if position is null do not display errors
  position: Position | null,
): Type | null {
  let key = JSON.stringify({ name, generics: serializeGenerics(generics), unit: refTable.thisUnit.fullName });
  let cached = typeCache.get(key);
  if (cached != undefined) {
    return cached;
  }

 // requires skipping type checking to satisfy recursive type
  let outputType: Type = {} as any;
  typeCache.set(key, outputType);

  let possibleStructs: Type[] = [];
  for (let unit of refTable.units) {
    let unitRefTable = getUnitReferences(unit);

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
        fields.push({ name: field.name, type: concreteFieldType, visibility: field.visibility, recursive: field.recursive });
      }

      let thisStructId = unit.fullName + '.' + structDef.header.name;
      let thisStruct: Type = {
        tag: item[0],
        val: {
          fields,
          generics,
          id: thisStructId,
          unit: unit.fullName,
        } 
      };
      possibleStructs.push(thisStruct);
    }
  }

  // resolve C types
  for (let include of refTable.includes) {
    for (let typeDef of include.typeDefs) {
      if (typeDef.name != name) {
        continue;
      }
      possibleStructs.push(typeDef.type);
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

  let thisStruct = possibleStructs[0];
  if (thisStruct.tag != 'struct' && thisStruct.tag != 'enum') {
    return null;
  }

  outputType.tag = thisStruct.tag;
  outputType.val = {
    fields: thisStruct.val.fields,
    generics: thisStruct.val.generics,
    id: thisStruct.val.id,
    unit: thisStruct.val.unit
  };
  return outputType;
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
    if (unitName != refTable.units[i].fullName) {
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
      // standardizeType(fnTypeReturnType);
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
  isGeneric: boolean
  unitName: string
  fnName: string,
  paramNames: string[]
  extern: boolean
}

type WrongTypeFn = { tag: 'chad', val: Parse.Fn } | { tag: 'c', val: ExternFn } 

function resolveFn(
  name: string,
  inUnit: string | null,
  returnType: Type | null,
  paramTypes: (Type | null)[] | null,
  // if refTable is null, it can be found in any unit
  refTable: RefTable | null,
  // if calleePosition is null then do not display errors
  calleePosition: Position | null
): FnResult | null {
  let possibleFns: FnResult[] = [];
  let wrongTypeFns: WrongTypeFn[] = [];

    // go through the chadscript functions in scope
  if (refTable != null) {
    for (let i = 0; i < refTable.units.length; i++) {
      let unit = refTable.units[i];

      if (inUnit != null && inUnit != unit.fullName) {
        continue;
      }

      // can not be used as global variable
      if (inUnit == null && refTable.globalUnits[i] == false) {
        continue;
      }

      // tests the fn against 
      testFnType(
        unit,
        name,
        returnType,
        paramTypes,
        false,
        refTable,
        calleePosition,
        wrongTypeFns,
        possibleFns
      );
    }
  }

  // determine if the function can be found with a trait
  let firstParamUnit: Parse.ProgramUnit | null = null;
  if (paramTypes != null && paramTypes.length > 0) {
    let param = paramTypes[0]; 
    if (param != null && param.tag == 'struct') {
      firstParamUnit = null;
      for (let i = 0; i < allUnits.length; i++) {
        if (allUnits[i].fullName != param.val.unit) {
          firstParamUnit = allUnits[i];
          break;
        }
      }
    }
  }

  if (firstParamUnit != null) {
    testFnType(
      firstParamUnit,
      name,
      returnType,
      paramTypes,
      true,
      refTable,
      calleePosition,
      wrongTypeFns,
      possibleFns
    )
  }

  if (refTable == null) {
    for (let i = 0; i < allUnits.length; i++) {
      testFnType(
        allUnits[i],
        name,
        returnType,
        paramTypes,
        false,
        refTable,
        calleePosition,
        wrongTypeFns,
        possibleFns
      )
    }
  }

  if (refTable != null) {
    // go through the imported C functions
    for (let include of refTable.includes) {
      for (let fn of include.fns) {
        if (fn.name != name || fn.type.tag != 'fn') {
          continue;
        }

        if (returnType != null) {
          if (!typeApplicable(fn.type.val.returnType, returnType, true)) {
            wrongTypeFns.push({
              tag: 'c',
              val: fn
            });
            continue;
          }
        }

        if (paramTypes != null) {
          if (paramTypes.length != fn.type.val.paramTypes.length) {
            wrongTypeFns.push({
              tag: 'c',
              val: fn
            });
            continue;
          }

          for (let i = 0; i < paramTypes.length; i++) {
            let paramType = paramTypes[i];
            if (paramType == null) {
              continue;
            }

            if (!typeApplicable(fn.type.val.paramTypes[i], paramType, false)) {
              wrongTypeFns.push({
                tag: 'c',
                val: fn
              });
              break;
            }
          }
        }

        possibleFns.push({
          fnType: fn.type,
          unitName: include.unitName,
          paramNames: [],
          isGeneric: false,
          fnName: fn.name,
          extern: true
        });
      }
    }
  }

  if (possibleFns.length == 1) {
    return possibleFns[0];
  }

  // give a useful error about why it can't resolve the function
  if (possibleFns.length > 1) {
    if (refTable == null) {
      return possibleFns[0];
    }

    let nonGeneric = [];
    for (let i = 0; i < possibleFns.length; i++) {
      if (possibleFns[i].isGeneric) nonGeneric.push(possibleFns[i])
    }
    if (nonGeneric.length == 1) {
      return nonGeneric[0];
    }

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

function testFnType(
  unit: Parse.ProgramUnit,
  name: string,
  returnType: Type | null,
  paramTypes: (Type | null)[] | null,
  requiresTrait: boolean,
  refTable: RefTable | null,
  calleePosition: Position | null,
  outWrongTypeFns: WrongTypeFn[],
  outPossibleFns: FnResult[]
) {

  if (refTable == null) {
    refTable = getUnitReferences(unit);
  }

  let unitRefTable = getUnitReferences(unit);
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
      outWrongTypeFns.push({ tag: 'chad', val: fnDef });
      continue;
    }

    let linkedParams: boolean[] = [];
    let concreteParamTypes: Type[] = [];
    let paramNames: string[] = [];
    let allParamsOk = true;
    let fnIsGeneric = false;
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
      if (isGeneric(defParamType)) {
        fnIsGeneric = true;
      }

      // named parameters influence the type of the function but can not
      // be used in generics
      if (paramTypes != null) {
        let paramType = paramTypes[i];
        if (fnDef.defaultExprs[i] == null && paramType != null && !typeApplicableStateful(paramType, defParamType, genericMap, true)) {
          outWrongTypeFns.push({ tag: 'chad', val: fnDef });
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
        outWrongTypeFns.push({ tag: 'chad', val: fnDef });
        continue;
      }
    }

    if (isGeneric(defReturnType)) {
      fnIsGeneric = true;
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

    if (requiresTrait && fnDef.mode != 'trait') {
      continue;
    }

    outPossibleFns.push({
      paramNames,
      unitName: unit.fullName,
      fnName: fnDef.name,
      isGeneric: fnIsGeneric,
      fnType,
      extern: false
    });
  }

}

