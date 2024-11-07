import * as Parse from './parse';
import { logError, compilerError, Position } from './util';

export {
  UnitSymbols, loadUnits, resolveType, Type,
  NIL, BOOL, ANY, resolveFn, Fn, FnResult, ERR,
  CHAR, INT, I32, I16, I8, U64, U32, U16, U8, F64, F32, STR, FMT, RANGE,
  typeApplicable, toStr, basic, isBasic, getFieldIndex, createVec, applyGenericMap,
  typeApplicableStateful, serializeType, createTypeUnion, resolveImpl, refType,
  typeEq
}

type Modifier = 'pri' | 'pub';
type FieldModifier = 'pri' | 'pub' | 'get';

interface Field {
  name: string,
  type: Type,
  modifier: FieldModifier
}

interface Struct {
  name: string,
  unit: string,
  generics: Type[],
  fields: Field[]
  modifier: Modifier,
  isEnum: boolean
}

type Type = { tag: 'generic', val: string }
  | { tag: 'ptr', val: Type }
  | { tag: 'link', val: Type }
  | { tag: 'struct', val: Struct }
  | { tag: 'fn', returnType: Type, paramTypes: Type[] }

const ANY = {
  default: null,
  options: []
}

interface Fn {
  name: string
  unit: string
  paramTypes: Type[]
  paramNames: string[]
  returnType: Type
  mode: Parse.FnMode
}

interface UnitSymbols {
  name: string,
  useUnits: UnitSymbols[]
  namedUnits: Map<string, UnitSymbols>
  allUnits: UnitSymbols[]
  structs: Map<string, Struct>,
  fns: Map<string, Fn[]>
}

const NIL: Type = basic('nil');
const BOOL: Type = basic('bool');
const F32: Type = basic('f32');
const F64: Type = basic('f64');
const CHAR: Type = basic('char');
const INT: Type = basic('int');
const I32: Type = basic('i32');
const I16: Type = basic('i16'); 
const I8: Type = basic('i8');
const U64: Type =  basic('u64');
const U32: Type =  basic('u32');
const U16: Type =  basic('u16');
const U8: Type =  basic('u8');

function basic(name: string): Type {
  return { 
    tag: 'struct',
    val: {
      name,
      generics: [],
      unit: 'std/core',
      modifier: 'pub',
      isEnum: false,
      fields: []
    }
  }
}

const STR: Type = {
  tag: 'struct',
  val: {
    name: 'str',
    generics: [],
    unit: 'std/core',
    modifier: 'pub',
    isEnum: false,
    fields: [] 
  }
};

const ERR: Type = {
  tag: 'struct',
  val: {
    name: 'err',
    generics: [],
    unit: 'std/core',
    modifier: 'pub',
    isEnum: false,
    fields: [
      { name: 'message', type: STR, modifier: 'get' }
    ] 
  }
};

const FMT: Type = {
  tag: 'struct',
  val: {
    name: 'Fmt',
    generics: [],
    unit: 'std/core',
    modifier: 'pub',
    isEnum: false,
    fields: [] 
  }
};

const RANGE: Type = {
  tag: 'struct',
  val: {
    name: 'range',
    generics: [],
    unit: 'std/core',
    modifier: 'pub',
    isEnum: false,
    fields: [
      { name: 'start', type: INT, modifier: 'pub' },
      { name: 'end', type: INT, modifier: 'pub' },
      { name: 'output', type: INT, modifier: 'pub' }
    ] 
  }
};

const BASICS: Struct[] = [
  { name: 'i8', generics: [], unit: 'std/core', modifier: 'pub', isEnum: false, fields: [] },
  { name: 'i16', generics: [], unit: 'std/core', modifier: 'pub', isEnum: false, fields: [] },
  { name: 'i32', generics: [], unit: 'std/core', modifier: 'pub', isEnum: false, fields: [] },
  { name: 'int', generics: [], unit: 'std/core', modifier: 'pub', isEnum: false, fields: [] },
  { name: 'u8', generics: [], unit: 'std/core', modifier: 'pub', isEnum: false, fields: [] },
  { name: 'u16', generics: [], unit: 'std/core', modifier: 'pub', isEnum: false, fields: [] },
  { name: 'u32', generics: [], unit: 'std/core', modifier: 'pub', isEnum: false, fields: [] },
  { name: 'u64', generics: [], unit: 'std/core', modifier: 'pub', isEnum: false, fields: [] },
  { name: 'f32', generics: [], unit: 'std/core', modifier: 'pub', isEnum: false, fields: [] },
  { name: 'f64', generics: [], unit: 'std/core', modifier: 'pub', isEnum: false, fields: [] },
  { name: 'bool', generics: [], unit: 'std/core', modifier: 'pub', isEnum: false, fields: [] },
  { name: 'char', generics: [], unit: 'std/core', modifier: 'pub', isEnum: false, fields: [] },
  { name: 'nil', generics: [], unit: 'std/core', modifier: 'pub', isEnum: false, fields: [] }
];

function refType(type: Type): Type {
  return { tag: 'link', val: type };
}

function serializeType(type: Type): string {
  return toStr(type);
}

function isInt(type: Type) {
  if (type.tag == 'struct') {
    let name = type.val.name;
    return name == 'i8' || name == 'i16' || name == 'i32' || name == 'int'
      || name == 'u8' || name == 'u16' || name == 'u32' || name == 'u64'
  }
  return false;
}

function createTypeUnion(t1: Type, t2: Type): Type {
  return {
    tag: 'struct',
    val: {
      name: 'TypeUnion',
      generics: [t1, t2],
      unit: 'std/core',
      modifier: 'pub',
      isEnum: true,
      fields: [
        { name: 'val0', type: t1, modifier: 'pub' },
        { name: 'val1', type: t2, modifier: 'pub' }
      ]
    }
  };
}

function createVec(t1: Type): Type {
  return {
    tag: 'struct',
    val: {
      name: 'Vec',
      generics: [t1],
      unit: 'std/core',
      modifier: 'pub',
      isEnum: true,
      fields: [
        { name: 'val0', type: t1, modifier: 'pub' },
      ]
    }
  };
}

function getFieldIndex(type: Type, fieldName: string): number {
  if (type.tag != 'struct') return -1;
  for (let i = 0; i < type.val.fields.length; i++) {
    if (type.val.fields[i].name == fieldName) {
      return i;
    }
  }
  return -1;
}

function isBasic(type: Type): boolean {
  if (type.tag != 'struct' || type.val.unit != 'std/core') return false;
  for (let i = 0; i < BASICS.length; i++) {
    if (type.val.name == BASICS[i].name) return true;
  }
  return false;
}

function isGeneric(a: Type): boolean {
  if (a.tag == 'generic') return true;
  if (isBasic(a)) return false;
  if (a.tag == 'struct') {
    for (let generic of a.val.generics) {
      if (isGeneric(generic)) return false;
    }
  }
  if (a.tag == 'fn') {
    if (isGeneric(a.returnType)) return true;
    for (let paramType of a.paramTypes) {
      if (isGeneric(paramType)) return true;
    }
  }
  if (a.tag == 'ptr') {
    return isGeneric(a.val);
  }
  return false;
}

function typeEq(t1: Type, t2: Type) {
  return typeApplicableStateful(t1, t2, new Map(), true) 
    && typeApplicableStateful(t2, t1, new Map(), true);
}

// fnHeader field is used to calculate whether a generic should accept any type
function typeApplicableStateful(
  sub: Type,
  supa: Type,
  genericMap: Map<string, Type>,
  fnHeader: boolean,
): boolean {
  if (sub.tag == 'link') {
    return typeApplicableStateful(sub.val, supa, genericMap, fnHeader);
  }
  if (supa.tag == 'link') {
    return typeApplicableStateful(sub, supa.val, genericMap, fnHeader);
  }

  if (supa.tag == 'generic') {
    if (!fnHeader && supa.tag != sub.tag) return false;
    if (sub.tag == 'generic') return true;
    else if (genericMap.has(supa.val)) {
      return typeApplicableStateful(sub, genericMap.get(supa.val)!, genericMap, fnHeader);
    }
    genericMap.set(supa.val, sub);
    return true;
  }

  // T -> T|K is valid
  if (supa.tag == 'struct' && supa.val.isEnum && supa.val.name == 'TypeUnion' && supa.val.unit == 'std/core') {
    let firstApplicable = typeApplicableStateful(sub, supa.val.fields[0].type, genericMap, fnHeader);
    let secondApplicable = typeApplicableStateful(sub, supa.val.fields[1].type, genericMap, fnHeader);
    if (firstApplicable || secondApplicable) return true;
  }

  if (sub.tag != supa.tag) return false;

  if (isBasic(sub) && isBasic(supa)) return (sub as any).val.name == (supa as any).val.name;
  if (sub.tag == 'ptr' && supa.tag == 'ptr') {
    return typeApplicableStateful(sub.val, supa.val, genericMap, fnHeader);
  }
  if (sub.tag == 'struct' && supa.tag == 'struct') {
    if (sub.val.name != supa.val.name) return false;
    if (sub.val.generics.length != supa.val.generics.length) return false;
    for (let i = 0; i < sub.val.generics.length; i++) {
      if (!typeApplicableStateful(sub.val.generics[i], supa.val.generics[i], genericMap, fnHeader)) {
        return false;
      }
    }
    return true;
  }

  if (sub.tag == 'fn' && supa.tag == 'fn') {
    if (!typeApplicableStateful(sub.returnType, supa.returnType, genericMap, fnHeader)) {
      return false;
    }
    if (sub.paramTypes.length != supa.paramTypes.length) return false;

    for (let i = 0; i < sub.paramTypes.length; i++) {
      if (!typeApplicableStateful(sub.paramTypes[i], supa.paramTypes[i], genericMap, fnHeader)) {
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

function toStr(t: Type | null): string {
  if (t == null) return 'null';
  if (t.tag == 'struct' && isBasic(t)) return t.val.name;
  if (t.tag == 'generic') return t.val;
  if (t.tag == 'ptr') return '*' + toStr(t.val);
  if (t.tag == 'link') return '&' + toStr(t.val);
  if (t.tag == 'struct') {
    let generics: string = '[';
    for (let i = 0; i < t.val.generics.length; i++) {
      generics += toStr(t.val.generics[i]);
      if (i != t.val.generics.length - 1) {
        generics += ', ';
      }     
    }
    if (t.val.generics.length == 0) {
      return t.val.name;
    }
    else {
      return t.val.name + generics + ']';
    }
  }

  if (t.tag == 'fn') {
    let s = '';
    for (let i = 0; i < t.paramTypes.length; i++) {
      s += toStr(t.paramTypes[i]);
      if (i != t.paramTypes.length - 1) {
        s += ', ';
      }
    }
    return `${toStr(t.returnType)}(${s})`;
  }

  compilerError('toStr fallthrough')
  return undefined!;
}

function applyGenericMap(
  input: Type,
  map: Map<string, Type>,
  recursive: Set<Type> = new Set()
): Type {
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
  else if (isBasic(input)) {
    return input;
  }
  else if (input.tag == 'struct') {
    let newGenerics: Type[] = [];
    let newFields: Field[] = [];

    let copySet = new Set(recursive);
    for (let field of input.val.fields) {
      let fieldType = applyGenericMap(field.type, map, copySet);
      newFields.push({ name: field.name, type: fieldType, modifier: field.modifier });
    }
    for (let generic of input.val.generics) {
      newGenerics.push(applyGenericMap(generic, map, recursive));
    }
    return {
      tag: input.tag,
      val: {
        fields: newFields,
        generics: newGenerics,
        name: input.val.name,
        unit: input.val.unit,
        isEnum: input.val.isEnum,
        modifier: input.val.modifier
      }
    };
  }
  else if (input.tag == 'ptr') {
    return { tag: 'ptr', val: applyGenericMap(input.val, map, recursive) };
  }
  else if (input.tag == 'fn') {
    let newReturnType: Type = applyGenericMap(input.returnType, map, recursive);
    let newParamTypes: Type[] = []
    for (let paramType of input.paramTypes) {
      let newParamType = applyGenericMap(paramType, map, recursive);
      newParamTypes.push(newParamType);
    }
    return {
      tag: 'fn',
      returnType: newReturnType,
      paramTypes: newParamTypes,
    };
  }

  return input;
}

function loadUnits(units: Parse.ProgramUnit[]): UnitSymbols[] {
  // map all of the units so they can be referenced by other units
  let unitSymbolsMap: Map<string, UnitSymbols> = new Map();
  for (let i = 0; i < units.length; i++) {
    let unitSymbols: UnitSymbols = {
      name: units[i].fullName,
      useUnits: [],
      allUnits: [],
      namedUnits: new Map(),
      fns: new Map(),
      structs: new Map()
    };
    unitSymbolsMap.set(units[i].fullName, unitSymbols);
  }

  // set up the reference between units
  for (let i = 0; i < units.length; i++) {
    let thisUnitSymbols: UnitSymbols = unitSymbolsMap.get(units[i].fullName)!;
    for (let use of units[i].uses) {
      let otherUnitSymbols = unitSymbolsMap.get(use.unitName)!;
      if (use.as == null) {
        thisUnitSymbols.useUnits.push(otherUnitSymbols);
      }
      else {
        thisUnitSymbols.namedUnits.set(use.as, otherUnitSymbols);
      }
    }
  }

  let symbols: UnitSymbols[] = [];
  for (let unitSymbols of unitSymbolsMap.values()) {
    symbols.push(unitSymbols);
    unitSymbols.allUnits = symbols;
  }

  let coreUnit = symbols.find(x => x.name == 'std/core');
  if (coreUnit == undefined) {
    compilerError('must include core unit');
    return [];
  }

  for (let i = 0; i < symbols.length; i++) {
    if (symbols[i].name == 'std/core') continue;
    let containsCore: boolean = false;
    for (let j = 0; j < symbols[i].useUnits.length; j++) {
      if (symbols[i].useUnits[j].name == 'std/core') {
        containsCore = true;
        break;
      }
    }
    if (!containsCore) symbols[i].useUnits.push(coreUnit);
  }

  loadStructs(units, symbols);
  loadFields(units, symbols);
  loadFns(units, symbols);
  for (let i = 0; i < units.length; i++) {
    analyzeUnitDataTypes(symbols[i], units[i]);
  }
  return symbols;
}

function loadStructs(units: Parse.ProgramUnit[], to: UnitSymbols[]) {
  // map the units and names to a type reference
  for (let i = 0; i < units.length; i++) {
    let unit = units[i];
    let unitTypeMap: Map<string, Struct> = new Map();
    for (let struct of unit.structs) {
      let modifier: Modifier = struct.header.pub ? 'pub' : 'pri';
      let s: Struct = { 
        name: struct.header.name,
        unit: unit.fullName,
        generics: [],
        modifier: modifier,
        isEnum: struct.header.isEnum,
        fields: [] 
      };
      for (let genericLetter of struct.header.generics) {
        s.generics.push({ tag: 'generic', val: genericLetter });
      }
      unitTypeMap.set(struct.header.name, s);
    }

    // load basic types
    if (unit.fullName == 'std/core') {
      for (let basic of BASICS) {
        unitTypeMap.set(basic.name, basic);
      }
    }
    to[i].structs = unitTypeMap;
  }
}

function loadFields(units: Parse.ProgramUnit[], symbols: UnitSymbols[]) {
  for (let i = 0; i < symbols.length; i++) {
    for (let parseStruct of units[i].structs) {
      let struct = symbols[i].structs.get(parseStruct.header.name);
      if (struct == undefined) continue;

      for (let field of parseStruct.fields) {
        let type = resolveType(symbols[i], field.t, field.position);
        if (type == null) {
          logError(field.position, 'invalid type');
          continue;
        };
        struct.fields.push({
          name: field.name,
          type,
          modifier: field.visibility
        })
      }
    }

  }
}

function loadFns(units: Parse.ProgramUnit[], to: UnitSymbols[]) {
  for (let i = 0; i < units.length; i++) {
    let unit = units[i];
    let symbols = to[i];
    for (let fn of unit.fns) {
      let paramTypes: Type[] = []
      for (let i = 0; i < fn.type.paramTypes.length; i++) {
        let t = resolveType(symbols, fn.type.paramTypes[i], fn.position);
        if (t == null) continue;
        paramTypes.push(t);
      }
      let returnType = resolveType(symbols, fn.type.returnType, fn.position);
      if (returnType == null) continue;
      if (!symbols.fns.has(fn.name)) symbols.fns.set(fn.name, []);
      symbols.fns.get(fn.name)!.push({
        mode: fn.mode,
        name: fn.name,
        unit: unit.fullName,
        paramNames: fn.paramNames,
        returnType,
        paramTypes
      });
    }
  }
}

function resolveType(unit: UnitSymbols, parseType: Parse.Type, position: Position): Type | null {
  let types: Type[] | null = resolveTypeInternal(unit, parseType, position);
  // return with no message
  if (types == null) {
    return null;
  }
  if (types.length == 0) {
    logError(position, 'could not find type');
    return null;
  }
  else if (types.length > 1) {
    logError(position, 'type is ambiguous');
    return null;
  }
  return types[0];
}

interface FnResult {
  name: string,
  unit: string,
  resolvedType: Type
  fnReference: Fn
  genericMap: Map<string, Type>
}

interface FnLookupResult {
  possibleFns: FnResult[],
  wrongTypeFns: Fn[]
}

function resolveFn(
  modeFilter: string[],
  unit: UnitSymbols,
  name: string,
  paramTypes: (Type | null)[],
  retType: Type | null,
  position: Position | null
): FnResult | null {
  let results = lookupFnInternal(modeFilter, unit, name, paramTypes, retType);
  if (results.possibleFns.length == 1) return results.possibleFns[0];
  if (results.possibleFns.length > 1) {
    if (position != null) logError(position, 'function is ambiguous');
    return null
  }
  if (results.wrongTypeFns.length > 0) {
    if (position != null) logError(position, 'function is wrong type');
    return null
  }
  if (position != null) logError(position, 'unknown function');
  return null;
}

// given the concrete types, of the trait, return the implementation
// that is needed
function resolveImpl(
  symbols: UnitSymbols,
  name: string,
  paramTypes: Type[],
  retType: Type | null,
  position: Position | null
): FnResult | null {
  let searchImpl = paramTypes[0];
  if (searchImpl.tag == 'link') searchImpl = searchImpl.val;
  if (searchImpl.tag != 'struct') {
    if (position != null) logError(position, 'invalid impl');
    return null; 
  }

  let unit: UnitSymbols | null = null;
  for (let testUnit of symbols.allUnits) {
    if (testUnit.name != searchImpl.val.unit) continue;
    unit = testUnit;
  }
  if (unit == null) {
    if (position != null) logError(position, 'invalid impl');
    return null; 
  }

  let unitFns: Fn[] | undefined = unit.fns.get(name);
  if (unitFns == undefined) {
    if (position != null) logError(position, 'unknown impl');
    return null; 
  }

  let wrongTypeFns: Fn[] = []; 
  let possibleFns: FnResult[] = [];
  let nonGenericPossibleFns: FnResult[] = [];
  fnLoop: for (let fn of unitFns) {
    if (fn.mode != 'impl') continue;
    if (fn.paramTypes.length != paramTypes.length) continue;
    let genericMap: Map<string, Type> = new Map();
    for (let i = 0; i < paramTypes.length; i++) {
      let pType = paramTypes[i];
      if (pType == null) continue;
      if (!typeApplicableStateful(pType, fn.paramTypes[i], genericMap, true)) {
        wrongTypeFns.push(fn);
        continue fnLoop;
      }
    }
    if (retType != null) {
      if (!typeApplicableStateful(retType, fn.returnType, genericMap, true)) {
        wrongTypeFns.push(fn);
        continue fnLoop;
      }
    }

    let fnType: Type = { tag: 'fn', returnType: fn.returnType, paramTypes: fn.paramTypes };
    let resolvedType: Type = applyGenericMap(fnType, genericMap);
    let possibleFn = {
      fnReference: fn,
      name: fn.name,
      unit: fn.unit,
      resolvedType,
      genericMap
    }
    if (isGeneric(fnType)) {
      possibleFns.push(possibleFn);
    }
    else {
      nonGenericPossibleFns.push(possibleFn);
    }
  }

  if (nonGenericPossibleFns.length == 1) return nonGenericPossibleFns[0];
  if (nonGenericPossibleFns.length > 1) {
    if (position != null) logError(position, 'impl is ambiguous');
    return null
  }

  if (possibleFns.length == 1) return possibleFns[0];
  if (possibleFns.length > 1) {
    if (position != null) logError(position, 'impl is ambiguous');
    return null
  }
  if (wrongTypeFns.length > 0) {
    if (position != null) logError(position, 'impl is wrong type');
    return null
  }
  if (position != null) logError(position, 'unknown impl');
  return null;
}

function lookupFnInternal(
  modeFilter: string[],
  unit: UnitSymbols,
  name: string,
  paramTypes: (Type | null)[],
  retType: Type | null,
): FnLookupResult {
  let fns: Fn[] = [];
  let unitFns: Fn[] | undefined = unit.fns.get(name);
  if (unitFns != undefined) fns.push(...unitFns);
  for (let useUnit of unit.useUnits) {
    unitFns = useUnit.fns.get(name);
    if (unitFns != undefined) fns.push(...unitFns);
  }

  let wrongTypeFns: Fn[] = []; 
  let possibleFns: FnResult[] = [];
  fnLoop: for (let fn of fns) {
    if (!modeFilter.includes(fn.mode)) continue;
    let genericMap: Map<string, Type> = new Map();
    if (fn.paramTypes.length != paramTypes.length) continue;
    for (let i = 0; i < paramTypes.length; i++) {
      let pType = paramTypes[i];
      if (pType == null) continue;
      if (!typeApplicableStateful(pType, fn.paramTypes[i], genericMap, true)) {
        wrongTypeFns.push(fn);
        continue fnLoop;
      }
    }

    if (retType != null) {
      if (!typeApplicableStateful(retType, fn.returnType, genericMap, true)) {
        wrongTypeFns.push(fn);
        continue fnLoop;
      }
    }

    let fnType: Type = { tag: 'fn', returnType: fn.returnType, paramTypes: fn.paramTypes };
    let resolvedType: Type = applyGenericMap(fnType, genericMap);
    possibleFns.push({
      fnReference: fn,
      name: fn.name,
      unit: fn.unit,
      resolvedType,
      genericMap
    });
  }
  return { possibleFns, wrongTypeFns };
}

// returns the amount of types applicable, null if already printed error
function resolveTypeInternal(
  unit: UnitSymbols,
  parseType: Parse.Type,
  position: Position
): Type[] | null {
  if (parseType.tag == 'basic' && parseType.val.length == 1 
    && parseType.val[0] >= 'A' && parseType.val[0] <= 'Z'
  ) {
    return [{ tag: 'generic', val: parseType.val }];
  }
  else if (parseType.tag == 'basic' || parseType.tag == 'generic') {
    let types: Type[] = [];

    let name = parseType.tag == 'basic' ? parseType.val : parseType.val.name; 
    let allStructs: Struct[] = [];
    let struct: Struct | undefined = unit.structs.get(name);
    if (struct != undefined) allStructs.push(struct);
    for (let useUnit of unit.useUnits) {
      struct = useUnit.structs.get(name);
      if (struct != undefined) allStructs.push(struct);
    }

    for (let struct of allStructs) {
      if (parseType.tag == 'generic') {
        let genericMap: Map<string, Type> = new Map();
        if (parseType.val.generics.length != struct.generics.length) {
          continue;
        }

        let newStruct: Struct = { 
          generics: [],
          name,
          unit: struct.unit,
          modifier: struct.modifier,
          fields: [],
          isEnum: struct.isEnum
        };
        for (let i = 0; i < struct.generics.length; i++) {
          let genericType = resolveType(unit, parseType.val.generics[i], position);
          if (genericType == null) return null;
          let g = struct.generics[i];
          if (g.tag != 'generic') {
            compilerError('expected generic');
            return null;
          }
          newStruct.generics.push(genericType);
          genericMap.set(g.val, genericType);
        }

        for (let i = 0; i < struct.fields.length; i++) {
          let newFieldType = applyGenericMap(struct.fields[i].type, genericMap);
          newStruct.fields.push({
            type: newFieldType,
            modifier: struct.fields[i].modifier,
            name: struct.fields[i].name
          });
        }
        types.push({ tag: 'struct', val: newStruct });
      }
      else {
        types.push({ tag: 'struct', val: struct });
      }
    }

    return types;
  }
  else if (parseType.tag == 'fn') {
    let paramTypes: Type[] = [];
    for (let i = 0; i < parseType.val.paramTypes.length; i++) {
      let paramType = resolveType(unit, parseType.val.paramTypes[i], position);
      if (paramType == null) return null;
      paramTypes.push(paramType);
    }
    let returnType = resolveType(unit, parseType.val.returnType, position);
    if (returnType == null) return null;
    return [{ tag: 'fn', paramTypes, returnType }];
  }
  else if (parseType.tag == 'ptr') {
    let inner = resolveType(unit, parseType.val, position);
    if (inner == null) return null;
    return [{ tag: 'ptr', val: inner }];
  }
  else if (parseType.tag == 'link') {
    let inner = resolveType(unit, parseType.val, position);
    if (inner == null) return null;
    return [{ tag: 'link', val: inner }];
  }
  else if (parseType.tag == 'type_union') {
    let first = resolveType(unit, parseType.val0, position);
    if (first == null) return null;
    let second = resolveType(unit, parseType.val1, position);
    if (second == null) return second;
    return [createTypeUnion(first, second)]
  }
  return null;
}  

function analyzeUnitDataTypes(symbols: UnitSymbols, unit: Parse.ProgramUnit): boolean {
  let invalidDataType = false;
  for (let struct of unit.structs) {
    if (verifyStruct(symbols, struct) == false) {
      invalidDataType = true;
    }

    if (struct.header.isEnum) {
      for (let i = 0; i < struct.fields.length; i++) {
        if (struct.fields[i].visibility == 'get' ||struct.fields[i].visibility == null) {
          logError(struct.fields[i].position, 'enum fields can not have visibility modifier');
          invalidDataType = true;
        }
      }
      if (verifyStruct(symbols, struct) == false) {
        invalidDataType = true;
      }
    }
  }

  return !invalidDataType;
}

// ensure that the parse type is actually valid
function verifyDataType(
  symbols: UnitSymbols,
  type: Parse.Type,
  position: Position,
  validGenerics: string[]
): boolean {
  if (type.tag == 'basic') {
    if (type.val.length == 1 && validGenerics.includes(type.val) == false) {
      logError(position, 'generic not added to struct heading');
      return false;
    }
    let dataType = resolveType(symbols, type, position);
    if (dataType == null) {
      logError(position, 'unknown datatype');
      return false;
    }
    return true;
  } 

  if (type.tag == 'type_union') {
    let firstTypeValid = verifyDataType(symbols, type.val0, position, validGenerics);
    let secondTypeValid = verifyDataType(symbols, type.val1, position, validGenerics);
    return firstTypeValid && secondTypeValid;
  }

  if (type.tag == 'ptr') {
    return verifyDataType(symbols, type.val, position, validGenerics);
  }

  if (type.tag == 'generic') {
    let dataType = resolveType(symbols, type, position);
    for (let g of type.val.generics) {
      if (verifyDataType(symbols, g, position, validGenerics) == false) {
        logError(position, 'unknown datatype');
        return false;
      }
    }
    if (dataType == null) return false;
    return true;
  } 

  if (type.tag == 'link') {
    logError(position, 'ref not allowed in struct definitions');
    return false;
  } 

  if (type.tag == 'fn') {
    for (let i = 0; i < type.val.paramTypes.length; i++) {
      if (verifyDataType(symbols, type.val.paramTypes[i], position, validGenerics) == false) {
        logError(position, 'unknown datatype');
        return false;
      }
    }
    if (verifyDataType(symbols, type.val.returnType, position, validGenerics) == false) {
      logError(position, 'unknown datatype');
      return false;
    }
    return true;
  }
  logError(position, 'unknown datatype');
  return false;
}

function verifyStruct(symbols: UnitSymbols, struct: Parse.Struct): boolean {
  let invalidField = false;
  for (let field of struct.fields) {
    if (verifyDataType(symbols, field.t, field.position, struct.header.generics) == false) {
      invalidField = true;
    }
  }
  for (let i = 0; i < struct.fields.length; i++) {
    for (let j = 0; j < struct.fields.length; j++) {
      if (i == j) continue;
      if (struct.fields[i].name == struct.fields[j].name) {
        logError(struct.fields[j].position, 'repeated field');
        return false;
      }
    }
  }
  return !invalidField;
}

