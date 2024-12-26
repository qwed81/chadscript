import * as Parse from './parse';
import { logError, compilerError, Position, logMultiError } from './util';

export {
  UnitSymbols, loadUnits, resolveType, Type, Field, Struct,
  NIL, BOOL, resolveFnOrDecl, Fn, FnResult, ERR,
  CHAR, INT, I64, I16, I8, U64, U32, U16, U8, F64, F32, STR, FMT, RANGE,
  AMBIG_INT, AMBIG_FLOAT, AMBIG_NIL,
  typeApplicable, toStr, basic, isBasic, getFieldIndex, createArr, applyGenericMap,
  typeApplicableStateful, getTypeKey, createTypeUnion, resolveImpl, refType,
  typeEq, getIsolatedUnitSymbolsFromName, getIsolatedUnitSymbolsFromAs,
  getUnitSymbolsFromAs, getUnitSymbolsFromName, Global, resolveGlobal,
  resolveMacro, isGeneric, getFields, lookupFnOrDecl, getFoundFns, getExpectedFns, getCurrentFn,
  applyConstMap, createVec
}

type Modifier = 'pri' | 'pub';
type FieldModifier = 'pri' | 'pub' | 'get';

interface Field {
  name: string,
  type: Type,
  modifier: FieldModifier
}

interface StructTemplate {
  name: string,
  unit: string,
  fields: Field[]
  modifier: Modifier,
  structMode: Parse.StructMode
  generics: string[]
  constFieldNames: string[]
}

interface Struct {
  template: StructTemplate,
  generics: Type[],
  // fields will either be a value, or  
  // ANY in the case of a generic
  constFields: string[] 
}

type Type = { tag: 'generic', val: string }
  | { tag: 'ptr', val: Type, const: boolean }
  | { tag: 'link', val: Type }
  | { tag: 'struct', val: Struct }
  | { tag: 'ambig_int' }
  | { tag: 'ambig_float' }
  | { tag: 'ambig_nil' }
  | { tag: 'fn', returnType: Type, paramTypes: Type[] }

interface Fn {
  name: string
  unit: string
  paramTypes: Type[]
  paramNames: string[]
  returnType: Type
  mode: Parse.FnMode
}

interface Global {
  unit: string,
  name: string,
  type: Type,
  mode: Parse.GlobalMode
}

interface UnitSymbols {
  name: string,
  useUnits: UnitSymbols[]
  asUnits: Map<string, UnitSymbols>
  allUnits: UnitSymbols[]
  structs: Map<string, Struct>,
  fns: Map<string, Fn[]>
  macros: Map<string, Fn>,
  globals: Map<string, Global>
}

const AMBIG_INT: Type = { tag: 'ambig_int' }
const AMBIG_FLOAT: Type = { tag: 'ambig_float' }
const AMBIG_NIL: Type = { tag: 'ambig_nil' }

const NIL: Type = basic('nil');
const BOOL: Type = basic('bool');
const F32: Type = basic('f32');
const F64: Type = basic('f64');
const CHAR: Type = basic('char');
const INT: Type = basic('int');
const I64: Type = basic('i64');
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
      generics: [],
      constFields: [],
      template: {
        name,
        unit: 'std/core',
        modifier: 'pub',
        structMode: 'struct',
        fields: [],
        generics: [],
        constFieldNames: []
      }
    }
  }
}

function basicStruct(name: string): Struct {
  return { 
    generics: [],
    constFields: [],
    template: {
      name,
      unit: 'std/core',
      modifier: 'pub',
      structMode: 'struct',
      fields: [],
      generics: [],
      constFieldNames: []
    }
  }
}

const STR: Type = {
  tag: 'struct',
  val: {
    generics: [],
    constFields: [],
    template: {
      name: 'str',
      unit: 'std/core',
      modifier: 'pub',
      structMode: 'struct',
      fields: [
        { name: 'base', type: { tag: 'ptr', val: CHAR, const: true }, modifier: 'get' },
        { name: 'len', type: INT, modifier: 'get' }
      ],
      generics: [],
      constFieldNames: [],
    }
  }
};

const ERR: Type = {
  tag: 'struct',
  val: {
    generics: [],
    constFields: [],
    template: {
      name: 'err',
      unit: 'std/core',
      modifier: 'pub',
      structMode: 'struct',
      fields: [
        { name: 'message', type: STR, modifier: 'get' }
      ], 
      generics: [],
      constFieldNames: [],
    }
  }
};

const FMT: Type = {
  tag: 'struct',
  val: {
    generics: [],
    constFields: [],
    template: {
      name: 'Fmt',
      unit: 'std/core',
      modifier: 'pub',
      structMode: 'struct',
      fields: [],
      generics: [],
      constFieldNames: []
    }
  }
};

const RANGE: Type = {
  tag: 'struct',
  val: {
    generics: [],
    constFields: [],
    template: {
      name: 'Range',
      unit: 'std/core',
      modifier: 'pub',
      structMode: 'struct',
      fields: [
        { name: 'start', type: INT, modifier: 'pub' },
        { name: 'end', type: INT, modifier: 'pub' },
        { name: 'output', type: INT, modifier: 'pub' }
      ],
      generics: [],
      constFieldNames: [],
    }
  }
};

const BASICS: Struct[] = [
  basicStruct('nil'),
  basicStruct('bool'),
  basicStruct('f32'),
  basicStruct('f64'),
  basicStruct('char'),
  basicStruct('int'),
  basicStruct('i64'),
  basicStruct('i16'),
  basicStruct('i8'),
  basicStruct('u64'),
  basicStruct('u32'),
  basicStruct('u16'),
  basicStruct('u8'),
];

function refType(type: Type): Type {
  return { tag: 'link', val: type };
}

function getTypeKey(t: Type): string {
  if (t == null) return 'null';
  if (t.tag == 'struct' && isBasic(t)) return t.val.template.name;
  if (t.tag == 'generic') return t.val;
  if (t.tag == 'ptr') return '*' + getTypeKey(t.val);
  if (t.tag == 'link') return '&' + getTypeKey(t.val);
  if (t.tag == 'ambig_int') return 'int';
  if (t.tag == 'ambig_float') return 'f64';
  if (t.tag == 'ambig_nil') return 'nil'

  if (t.tag == 'struct') {
    let generics: string = '[';
    for (let i = 0; i < t.val.generics.length; i++) {
      generics += getTypeKey(t.val.generics[i]);
      generics += ', ';
    }
    for (let i = 0; i < t.val.constFields.length; i++) {
      generics += t.val.constFields[i];
      generics += ', ';
    }

    if (t.val.generics.length == 0) {
      return t.val.template.name;
    }
    else {
      return t.val.template.name + generics + ']';
    }
  }

  if (t.tag == 'fn') {
    let s = '';
    for (let i = 0; i < t.paramTypes.length; i++) {
      s += getTypeKey(t.paramTypes[i]);
      if (i != t.paramTypes.length - 1) {
        s += ', ';
      }
    }
    return `fn(${s}) => ${getTypeKey(t.returnType)}`;
  }

  compilerError('typeKey fallthrough')
  return undefined!;
}

function getFields(type: Type): Field[] {
  if (type.tag != 'struct') {
    return []
  }

  let genericMap: Map<string, Type> = new Map(); 
  for (let i = 0; i < type.val.generics.length; i++) {
    genericMap.set(type.val.template.generics[i], type.val.generics[i]);
  }

  let newFields: Field[] = [];
  for (let i = 0; i < type.val.template.fields.length; i++) {
    let field = type.val.template.fields[i];
    let fieldType: Type = applyGenericMap(field.type, genericMap);
    newFields.push({ name: field.name, type: fieldType, modifier: field.modifier });
  }

  return newFields;
}

function createTypeUnion(t1: Type, t2: Type): Type {
  return {
    tag: 'struct',
    val: {
      generics: [t1, t2],
      constFields: [],
      template: {
        name: 'TypeUnion',
        unit: 'std/core',
        modifier: 'pub',
        structMode: 'enum',
        fields: [
          { name: 'val0', type: t1, modifier: 'pub' },
          { name: 'val1', type: t2, modifier: 'pub' }
        ],
        generics: ['T', 'K'],
        constFieldNames: []
      }
    }
  };
}

function createVec(t1: Type, size: number): Type {
  return {
    tag: 'struct',
    val: {
      generics: [t1],
      template: {
        constFieldNames: ['N'],
        name: 'vec',
        unit: 'std/core',
        modifier: 'pub',
        structMode: 'struct',
        fields: [],
        generics: ['T']
      },
      constFields: [(size + '')]
    }
  };
}

function createArr(t1: Type): Type {
  return {
    tag: 'struct',
    val: {
      generics: [t1],
      template: {
        constFieldNames: [],
        name: 'Arr',
        unit: 'std/core',
        modifier: 'pub',
        structMode: 'struct',
        fields: [
          { name: 'base', type: { tag: 'ptr', val: t1, const: false }, modifier: 'get' },
          { name: 'len', type: INT, modifier: 'get' },
          { name: 'capacity', type: INT, modifier: 'get' }
        ],
        generics: ['T']
      },
      constFields: []
    }
  };
}

function getFieldIndex(type: Type, fieldName: string): number {
  if (type.tag != 'struct') return -1;
  for (let i = 0; i < type.val.template.fields.length; i++) {
    if (type.val.template.fields[i].name == fieldName) {
      return i;
    }
  }
  return -1;
}

function isBasic(type: Type): boolean {
  if (type.tag != 'struct' || type.val.template.unit != 'std/core') return false;
  for (let i = 0; i < BASICS.length; i++) {
    if (type.val.template.name == BASICS[i].template.name) return true;
  }
  return false;
}

function isGeneric(a: Type): boolean {
  if (a.tag == 'generic') return true;
  if (isBasic(a)) return false;
  if (a.tag == 'struct') {
    for (let generic of a.val.generics) {
      if (isGeneric(generic)) return true;
    }
  }
  if (a.tag == 'fn') {
    if (isGeneric(a.returnType)) return true;
    for (let paramType of a.paramTypes) {
      if (isGeneric(paramType)) return true;
    }
  }
  if (a.tag == 'ptr' || a.tag == 'link') {
    return isGeneric(a.val);
  }
  return false;
}

function typeEq(t1: Type, t2: Type): boolean {
  if (t1.tag == 'link') {
    return typeEq(t1.val, t2);
  }
  if (t2.tag == 'link') {
    return typeEq(t1, t2.val);
  }

  if (t1.tag == 'ambig_nil') {
    if (t2.tag == 'ptr') return true;
    if (t2.tag == 'struct' && t2.val.template.name == 'nil' && t2.val.template.unit == 'std/core') return true;
    return false;
  }

  if (t1.tag == 'ambig_int') {
    if (t2.tag == 'ambig_int') return true;
    if (t2.tag != 'struct' || !isBasic(t2)) return false;
    let name = t2.val.template.name;
    return name == 'i8' || name == 'i16' || name == 'int' || name == 'i64'
      || name == 'u8' || name == 'u16' || name == 'u32' || name == 'u64';
  }

  if (t1.tag == 'ambig_float') {
    if (t2.tag == 'ambig_float') return true;
    if (t2.tag != 'struct' || !isBasic(t2)) return false;
    let name = t2.val.template.name;
    return name == 'f32' || name == 'f64';
  }

  if (t1.tag != t2.tag) return false;
  if (t1.tag == 'struct' && t2.tag == 'struct') {
    if (t1.val.template.name != t2.val.template.name || t1.val.template.unit != t2.val.template.unit) return false;
    if (t1.val.generics.length != t2.val.generics.length) return false;
    if (t1.val.constFields.length != t2.val.constFields.length) return false;

    for (let i = 0; i < t1.val.generics.length; i++) {
      if (!typeEq(t1.val.generics[i], t2.val.generics[i])) {
        return false;
      }
    }
    for (let i = 0; i < t2.val.constFields.length; i++) {
      if (t1.val.constFields[i] != t2.val.constFields[i]) return false;
    }
    return true;
  }

  if (t1.tag == 'ptr' && t2.tag == 'ptr') {
    return typeEq(t1.val, t2.val);
  }

  if (t1.tag == 'generic' && t2.tag == 'generic') {
    return t1.val == t2.val;
  }

  if (t1.tag == 'fn' && t2.tag == 'fn') {
    if (t1.paramTypes.length != t2.paramTypes.length) return false;
    for (let i = 0; i < t1.paramTypes.length; i++) {
      if (!typeEq(t1.paramTypes[i], t2.paramTypes[i])) return false;
    }
    return typeEq(t1.returnType, t2.returnType);
  }

  return false;
}

// fnHeader field is used to calculate whether a generic should accept any type
function typeApplicableStateful(
  sub: Type,
  supa: Type,
  genericMap: Map<string, Type>,
  constMap: Map<string, string>,
  fnHeader: boolean,
  allowUnion: boolean = true
): boolean {
  if (sub.tag == 'link') {
    return typeApplicableStateful(sub.val, supa, genericMap, constMap, fnHeader, allowUnion);
  }
  if (supa.tag == 'link') {
    return typeApplicableStateful(sub, supa.val, genericMap, constMap, fnHeader, allowUnion);
  }

  if (supa.tag == 'struct' && supa.val.template.name == '...') return true;

  if (sub.tag == 'ambig_nil') {
    if (supa.tag == 'ptr') return true;
    if (supa.tag == 'struct' && supa.val.template.name == 'nil' && supa.val.template.unit == 'std/core') return true;
  }

  if (sub.tag == 'ambig_float') {
    if (supa.tag == 'ambig_float') return true;
    if (supa.tag == 'struct' && (supa.val.template.name == 'f32' || supa.val.template.name == 'f64') && supa.val.template.unit == 'std/core') return true;
  }

  if (sub.tag == 'ambig_int') {
    if (supa.tag == 'ambig_float' || supa.tag == 'ambig_int') return true;
    if (supa.tag == 'struct' && (supa.val.template.name == 'f32' || supa.val.template.name == 'f64') && supa.val.template.unit == 'std/core') return true;

    if (supa.tag == 'struct' && supa.val.template.unit == 'std/core') {
      let name = supa.val.template.name;
      if (name == 'i64' || name == 'int' || name == 'i16' || name == 'i8'
        || name == 'u64' || name == 'u32' || name == 'u16' || name == 'u8') return true;
    }
  }

  if (supa.tag == 'generic') {
    if (!fnHeader) {
      return sub.tag == 'generic' && supa.val == sub.val;
    } 

    if (genericMap.has(supa.val)) {
      return typeEq(sub, genericMap.get(supa.val)!);
    }
    genericMap.set(supa.val, sub);
    return true;
  }

  // T -> T|K is valid
  if (allowUnion == true 
    && supa.tag == 'struct' 
    && supa.val.template.name == 'TypeUnion' 
    && supa.val.template.unit == 'std/core'
  ) {
    let fields = getFields(supa);
    let firstApplicable = typeApplicableStateful(sub, fields[0].type, genericMap, constMap, fnHeader, false);
    let secondApplicable = typeApplicableStateful(sub, fields[1].type, genericMap, constMap, fnHeader, false);
    if (firstApplicable || secondApplicable) return true;
  }

  if (sub.tag != supa.tag) return false;

  if (isBasic(sub) && isBasic(supa)) return (sub as any).val.template.name == (supa as any).val.template.name;

  if (sub.tag == 'ptr' && supa.tag == 'ptr') {
    return typeApplicableStateful(sub.val, supa.val, genericMap, constMap, fnHeader, false);
  }
  if (sub.tag == 'struct' && supa.tag == 'struct') {
    if (sub.val.template.name != supa.val.template.name) return false;
    if (sub.val.template.unit != supa.val.template.unit) return false;
    if (sub.val.generics.length != supa.val.generics.length) return false;
    if (sub.val.constFields.length != supa.val.constFields.length) return false;
    for (let i = 0; i < sub.val.generics.length; i++) {
      if (!typeApplicableStateful(sub.val.generics[i], supa.val.generics[i], genericMap, constMap, fnHeader, false)) {
        return false;
      }
    }

    for (let i = 0; i < sub.val.constFields.length; i++) {
      if (supa.val.constFields[i] == 'ANY') {
        if (sub.val.constFields[i] != 'ANY') {
          constMap.set(supa.val.template.constFieldNames[i], sub.val.constFields[i]);
        }
      }
      else if (sub.val.constFields[i] != supa.val.constFields[i]) {
        return false;
      }
    }
    return true;
  }

  if (sub.tag == 'fn' && supa.tag == 'fn') {
    if (!typeApplicableStateful(sub.returnType, supa.returnType, genericMap, constMap, fnHeader, false)) {
      return false;
    }
    if (sub.paramTypes.length != supa.paramTypes.length) return false;

    for (let i = 0; i < sub.paramTypes.length; i++) {
      if (!typeApplicableStateful(sub.paramTypes[i], supa.paramTypes[i], genericMap, constMap, fnHeader, false)) {
        return false;
      }
    }
    return true;
  }

  compilerError('typeEq type not handled');
  return false;
}

function typeApplicable(sub: Type, supa: Type, fnHeader: boolean, allowUnion: boolean = true): boolean {
  let genericMap = new Map<string, Type>();
  let constMap = new Map<string, string>();
  return typeApplicableStateful(sub, supa, genericMap, constMap, fnHeader, allowUnion);
}

function toStr(t: Type | null): string {
  if (t == null) return 'null';
  if (t.tag == 'struct' && isBasic(t)) return t.val.template.name;
  if (t.tag == 'generic') return t.val;
  if (t.tag == 'ptr') return '*' + (t.const ? 'const ' : '') + toStr(t.val);
  if (t.tag == 'link') return '&' + toStr(t.val);
  if (t.tag == 'ambig_int') return 'NUMBER';
  if (t.tag == 'ambig_float') return 'FLOAT';
  if (t.tag == 'ambig_nil') return 'PTR|NIL';

  if (t.tag == 'struct') {
    let generics: string = '[';
    for (let i = 0; i < t.val.generics.length; i++) {
      generics += toStr(t.val.generics[i]);
      generics += ', ';
    }

    for (let i = 0; i < t.val.constFields.length; i++) {
      if (t.val.constFields[i] == 'ANY') {
        generics += 'int ' + t.val.template.constFieldNames[i];
      }
      else {
        generics += t.val.constFields[i];
      }
      generics += ', ';
    }

    if (t.val.generics.length == 0 && t.val.constFields.length == 0) {
      return t.val.template.name;
    }
    else {
      return t.val.template.name + generics.slice(0, -2) + ']';
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
    return `fn(${s}) => ${toStr(t.returnType)}`;
  }

  compilerError('toStr fallthrough')
  return undefined!;
}

function applyConstMap(
  input: Type,
  map: Map<string, string>,
): Type {
  if (input.tag == 'struct') {
    let constFields = [...input.val.constFields];

    for (let i = 0; i < input.val.constFields.length; i++) {
      if (map.has(input.val.template.constFieldNames[i])) {
        constFields[i] = map.get(input.val.template.constFieldNames[i])!;
      }
    }

    return {
      tag: input.tag,
      val: {
        generics: input.val.generics,
        constFields,
        template:  input.val.template
      }
    };
  }
  else if (input.tag == 'link') {
    return { tag: 'link', val: applyConstMap(input.val, map) };
  }
  else if (input.tag == 'ptr') {
    return { tag: 'ptr', val: applyConstMap(input.val, map), const: input.const };
  }
  else if (input.tag == 'fn') {
    let newReturnType: Type = applyConstMap(input.returnType, map);
    let newParamTypes: Type[] = []
    for (let paramType of input.paramTypes) {
      let newParamType = applyConstMap(paramType, map);
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

function applyGenericMap(
  input: Type,
  map: Map<string, Type>,
): Type {
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

    for (let generic of input.val.generics) {
      newGenerics.push(applyGenericMap(generic, map));
    }
    return {
      tag: input.tag,
      val: {
        generics: newGenerics,
        constFields: input.val.constFields,
        template: input.val.template
      }
    };
  }
  else if (input.tag == 'link') {
    return { tag: 'link', val: applyGenericMap(input.val, map) };
  }
  else if (input.tag == 'ptr') {
    return { tag: 'ptr', val: applyGenericMap(input.val, map), const: input.const };
  }
  else if (input.tag == 'fn') {
    let newReturnType: Type = applyGenericMap(input.returnType, map);
    let newParamTypes: Type[] = []
    for (let paramType of input.paramTypes) {
      let newParamType = applyGenericMap(paramType, map);
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

function loadUnits(units: Parse.ProgramUnit[], headerUnits: UnitSymbols[]): UnitSymbols[] {
  // map all of the units so they can be referenced by other units
  let unitSymbolsMap: Map<string, UnitSymbols> = new Map();
  for (let i = 0; i < units.length; i++) {
    let unitSymbols: UnitSymbols = {
      name: units[i].fullName,
      useUnits: [],
      allUnits: [],
      asUnits: new Map(),
      fns: new Map(),
      structs: new Map(),
      globals: new Map(),
      macros: new Map()
    };
    unitSymbolsMap.set(units[i].fullName, unitSymbols);
  }

  for (let i = 0; i < headerUnits.length; i++) {
    unitSymbolsMap.set(headerUnits[i].name, headerUnits[i]);
  }

  // set up the reference between units
  for (let i = 0; i < units.length; i++) {
    let thisUnitSymbols: UnitSymbols = unitSymbolsMap.get(units[i].fullName)!;
    for (let use of units[i].uses) {
      let otherUnitSymbols = unitSymbolsMap.get(use.unitName);
      if (otherUnitSymbols == undefined) {
        logError({ end: 0, line: 0, start: 0, document: '' }, 'could not find unit ' + use.unitName);
        return [];
      }

      if (use.as == null) {
        thisUnitSymbols.useUnits.push(otherUnitSymbols);
      }
      else {
        thisUnitSymbols.asUnits.set(use.as, otherUnitSymbols);
      }
    }
  }

  let symbols: UnitSymbols[] = [];
  for (let unitSymbols of unitSymbolsMap.values()) {
    if (unitSymbols.name.endsWith('.h')) {
      continue;
    }

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
  loadGlobals(units, symbols);
  loadFns(units, symbols);
  for (let i = 0; i < units.length; i++) {
    analyzeUnitDataTypes(symbols[i], units[i]);
  }

  for (let headerSymbols of headerUnits) {
    symbols.push(headerSymbols);
  }
  return symbols;
}

function loadGlobals(units: Parse.ProgramUnit[], to: UnitSymbols[]) {
  for (let i = 0; i < units.length; i++) {
    let unit = units[i];
    let symbols = to[i];
    for (let global of unit.globals) {
      let type = resolveType(symbols, global.type, global.position);
      if (type == null) continue;
      symbols.globals.set(global.name, {
        unit: unit.fullName,
        name: global.name,
        type,
        mode: global.mode
      })
    }
  }
}

function loadStructs(units: Parse.ProgramUnit[], to: UnitSymbols[]) {
  // map the units and names to a type reference
  for (let i = 0; i < units.length; i++) {
    let unit = units[i];
    let unitTypeMap: Map<string, Struct> = new Map();
    for (let struct of unit.structs) {
      let modifier: Modifier = struct.header.pub ? 'pub' : 'pri';
      let s: Struct = { 
        generics: [],
        constFields: [],
        template: {
          name: struct.header.name,
          unit: unit.fullName,
          modifier: modifier,
          structMode: struct.header.structMode,
          fields: [],
          generics: [],
          constFieldNames: []
        }
      };
      for (let generic of struct.header.generics) {
        if (generic.tag == 'generic') {
          s.generics.push({ tag: 'generic', val: generic.name });
          s.template.generics.push(generic.name);
        }
        else if (generic.tag == 'int') {
          s.template.constFieldNames.push(generic.name);
        }
      }
      unitTypeMap.set(struct.header.name, s);
    }

    // load basic types
    if (unit.fullName == 'std/core') {
      for (let basic of BASICS) {
        unitTypeMap.set(basic.template.name, basic);
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
        struct.template.fields.push({
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

      if (fn.mode == 'macro') {
        symbols.macros.set(fn.name, {
          mode: fn.mode,
          name: fn.name,
          unit: unit.fullName,
          paramNames: fn.paramNames,
          returnType,
          paramTypes
        });
        continue;
      }

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

function getIsolatedUnitSymbolsFromName(
  base: UnitSymbols,
  unitName: string,
  position: Position | null
): UnitSymbols | null {
  for (let unit of base.allUnits) {
    if (unit.name != unitName) continue;
    return {
      name: unitName,
      allUnits: base.allUnits,
      fns: unit.fns,
      macros: new Map(),
      structs: unit.structs,
      globals: unit.globals,
      asUnits: new Map(),
      useUnits: [],
    }
  }
  if (position != null) logError(position, 'could not find ' + unitName);
  return null;
}

function getUnitSymbolsFromName(
  base: UnitSymbols,
  unitName: string,
  position: Position | null
): UnitSymbols | null {
  for (let unit of base.allUnits) {
    if (unit.name != unitName) continue;
    return unit;
  }
  if (position != null) logError(position, 'could not find ' + unitName);
  return null;
}

function getIsolatedUnitSymbolsFromAs(
  base: UnitSymbols,
  as: string,
  position: Position | null
): UnitSymbols | null {
  let unit: UnitSymbols | undefined = base.asUnits.get(as);
  if (unit == undefined) {
    if (position != null) logError(position, 'could not find ' + as);
    return null;
  }
  return {
    name: unit.name,
    allUnits: base.allUnits,
    fns: unit.fns,
    macros: new Map(),
    structs: unit.structs,
    globals: unit.globals,
    asUnits: new Map(),
    useUnits: []
  }
}

function getUnitSymbolsFromAs(
  base: UnitSymbols,
  as: string,
  position: Position | null
): UnitSymbols | null {
  let unit: UnitSymbols | undefined = base.asUnits.get(as);
  if (unit == undefined) {
    if (position != null) logError(position, 'could not find ' + as);
    return null;
  }
  return {
    name: unit.name,
    allUnits: base.allUnits,
    fns: unit.fns,
    macros: new Map(),
    structs: unit.structs,
    globals: unit.globals,
    asUnits: new Map(),
    useUnits: []
  }
}

function resolveGlobal(unit: UnitSymbols, name: string, position: Position | null): Global | null {
  let global: Global | undefined = unit.globals.get(name);
  if (global != undefined) return global;
  for (let useUnit of unit.useUnits) {
    global = useUnit.globals.get(name);
    if (global != undefined) return global;
  }

  if (position != null) logError(position, 'could not find global ' + name);
  return null;
}

function resolveType(unit: UnitSymbols, parseType: Parse.Type, position: Position | null): Type | null {
  let types: Type[] | null = resolveTypeInternal(unit, parseType, position);
  // return with no message
  if (types == null) {
    return null;
  }
  if (types.length == 0) {
    if (position != null) logError(position, 'could not find type ');
    return null;
  }
  else if (types.length > 1) {
    if (position != null) logError(position, 'type is ambiguous');
    return null;
  }

  return types[0];
}

function resolveMacro(
  unit: UnitSymbols,
  name: string,
  position: Position | null
): Fn | null {
  let macro: Fn | undefined = unit.macros.get(name);
  if (macro != undefined) return macro
  for (let symbols of unit.useUnits) {
    macro = symbols.macros.get(name);
    if (macro != undefined) return macro;
  }

  if (position != null) logError(position, 'could not find macro ' + name);
  return null;
}

interface FnResult {
  name: string,
  unit: string,
  mode: Parse.FnMode,
  resolvedType: Type
  fnReference: Fn,
  isGeneric: boolean,
  genericMap: Map<string, Type>
}

interface FnLookupResult {
  possibleFns: FnResult[],
  wrongTypeFns: Fn[]
}

function getExpectedFns(
  results: FnLookupResult,
  name: string,
  context: string[]
) {
  for (let i = 0; i < results.wrongTypeFns.length; i++) {
    let line: string = 'expected: ' + name + '(';
    let t = results.wrongTypeFns[i];
    for (let j = 0; j < t.paramTypes.length; j++) {
      line += toStr(t.paramTypes[j]);
      if (j != t.paramTypes.length - 1) line += ', '
    }
    line += ')'
    if (t.returnType.tag != 'struct' || t.returnType.val.template.name != 'nil') {
      line += ' ' + toStr(t.returnType);
    }
    context.push(line);
  }
}

function getFoundFns(
  results: FnLookupResult,
  name: string,
  context: string[]
) {
  for (let i = 0; i < results.possibleFns.length; i++) {
    let line: string = 'expected: ' + name + '(';
    let t = results.possibleFns[i].resolvedType;
    if (t.tag != 'fn') {
      compilerError('expected fn');
      return;
    }

    for (let j = 0; j < t.paramTypes.length; j++) {
      line += toStr(t.paramTypes[j]);
      if (j != t.paramTypes.length - 1) line += ', '
    }
    line += ')'
    if (t.returnType.tag != 'struct' || t.returnType.val.template.name != 'nil') {
      line += ' ' + toStr(t.returnType);
    }
    context.push(line);
  }
}

function getCurrentFn(
  name: string,
  paramTypes: (Type | null)[] | null,
  retType: Type | null,
  context: string[]
) {
  let line: string = 'found: ' + name + '(';
  if (paramTypes != null) {
    for (let j = 0; j < paramTypes.length; j++) {
      if (paramTypes[j] == null) line += 'ANY'
      else line += toStr(paramTypes[j]);

      if (j != paramTypes.length - 1) line += ', '
    }
  }
  else {
    line += '...';
  }

  line += ')'

  if (retType != null && (retType.tag != 'struct' || retType.val.template.name != 'nil')) {
    line += ' ' + toStr(retType);
  }
  context.push(line)
}

function resolveFnOrDecl(
  unit: UnitSymbols,
  name: string,
  paramTypes: (Type | null)[] | null,
  retType: Type | null,
  position: Position | null
): FnResult | null {
  let results = lookupFnOrDecl(unit, name, paramTypes, retType);
  if (results.possibleFns.length == 1) return results.possibleFns[0];
  if (results.possibleFns.length > 1) {
    let context: string[] = [];
    getFoundFns(results, name, context);
    getCurrentFn(name, paramTypes, retType, context);
    if (position != null) logMultiError(position, 'function is ambiguous', context);
    return null
  }
  if (results.wrongTypeFns.length > 0) {
    let context: string[] = [];
    getExpectedFns(results, name, context);
    getCurrentFn(name, paramTypes, retType, context);
    if (position != null) logMultiError(position, 'function is wrong type', context);
    return null
  }
  if (position != null) logError(position, 'unknown function ' + name);
  return null;
}

interface ImplResult {
  paramPrios: number[],
  retPrio: number,
  fnResult: FnResult
}

// given the concrete types, of the trait, return the implementation
// that is needed
function resolveImpl(
  symbols: UnitSymbols,
  name: string,
  paramTypes: (Type | null)[],
  retType: Type | null,
  position: Position | null
): FnResult | null {

  let lookupFns: Fn[] = [];
  for (let unit of symbols.allUnits) {
    let fns: Fn[] | undefined = unit.fns.get(name);
    if (fns != undefined) lookupFns.push(...fns);
  }

  let wrongTypeFns: Fn[] = []; 
  let possibleImpl: ImplResult[] = [];
  fnLoop: for (let fn of lookupFns) {
    if (fn.mode != 'impl' && fn.mode != 'declImpl') continue;
    if (fn.paramTypes.length != paramTypes.length) continue;
    let genericMap: Map<string, Type> = new Map();
    let constMap: Map<string, string> = new Map();
    for (let i = 0; i < paramTypes.length; i++) {
      let pType = paramTypes[i];
      if (pType == null) continue;
      if (!typeApplicableStateful(pType, fn.paramTypes[i], genericMap, constMap, true, false)) {
        wrongTypeFns.push(fn);
        continue fnLoop;
      }
    }
    if (retType != null) {
      if (!typeApplicableStateful(retType, fn.returnType, genericMap, constMap, true, false)) {
        wrongTypeFns.push(fn);
        continue fnLoop;
      }
    }

    let fnType: Type = { tag: 'fn', returnType: fn.returnType, paramTypes: fn.paramTypes };
    let resolvedType: Type = applyGenericMap(fnType, genericMap);
    resolvedType = applyConstMap(resolvedType, constMap);

    let fnResult: FnResult = {
      fnReference: fn,
      name: fn.name,
      unit: fn.unit,
      resolvedType,
      genericMap,
      mode: fn.mode,
      isGeneric: genericMap.size != 0
    };

    let paramPrios: number[] = [];
    for (let i = 0; i < fnType.paramTypes.length; i++) {
      let prio = implGenericPriority(fnType.paramTypes[i]);
      paramPrios.push(prio);
    }
    let retPrio = implGenericPriority(fnType.returnType);
    possibleImpl.push({
      fnResult,
      paramPrios,
      retPrio
    });
  }

  if (possibleImpl.length == 0) {
    if (wrongTypeFns.length > 0) {
      if (position != null) logError(position, 'impl is wrong type');
      return null
    }
    if (wrongTypeFns.length == 0) {
      if (position != null) logError(position, 'unknown impl ' + name);
      return null;
    }
  }

  // determine which impl is greater than all the others
  // greater is defined as having 1 parameter > than the others
  // while the others are >=
  // if none are greater then it is ambiguous
  let greatestImpl = possibleImpl[0];
  for (let i = 1; i < possibleImpl.length; i++) {
    let isGreater: boolean = false;
    let isEqual: boolean = true;
    for (let j = 0; j < greatestImpl.paramPrios.length; j++) {
      if (possibleImpl[i].paramPrios[j] > greatestImpl.paramPrios[j]) {
        isGreater = true;
        isEqual = false;
        break;
      }
    }

    for (let j = 0; j < greatestImpl.paramPrios.length; j++) {
      if (possibleImpl[i].paramPrios[j] < greatestImpl.paramPrios[j]) {
        if (isGreater) {
          if (position != null) logError(position, 'impl is ambiguous');
          return null
        }
        isEqual = false;
      }
    }

    if (isEqual) {
      if (position != null) logError(position, 'impl is ambiguous');
      return null
    }

    if (isGreater) greatestImpl = possibleImpl[i];
  }

  return greatestImpl.fnResult;
}

function implGenericPriority(type: Type): number {
  if (type.tag == 'link') {
    return implGenericPriority(type.val)
  }
  if (type.tag == 'generic') {
    return 0;
  }

  if (type.tag == 'ptr') {
    return implGenericPriority(type.val) + 2;
  }

  if (type.tag == 'struct') {
    if (type.val.template.name == 'TypeUnion' 
      && type.val.template.unit == 'std/core'
    ) {
      let tPrio = implGenericPriority(type.val.generics[0]);
      let kPrio = implGenericPriority(type.val.generics[1]);
      return Math.min(tPrio, kPrio) + 1;
    }
    else {
      let min = 0;
      if (type.val.generics.length > 0) min = implGenericPriority(type.val.generics[0]);
      for (let i = 1; i < type.val.generics.length; i++) {
        let inner = implGenericPriority(type.val.generics[i]);
        if (inner < min) inner = min;
      }
      return 2 + min;
    }
  }

  return 2;
}

function lookupFnOrDecl(
  unit: UnitSymbols,
  name: string,
  paramTypes: (Type | null)[] | null,
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
    if (!['fn', 'decl', 'declImpl'].includes(fn.mode)) continue;
    let genericMap: Map<string, Type> = new Map();
    let constMap: Map<string, string> = new Map();

    if (paramTypes != null) {
      let lastParam = fn.paramTypes[fn.paramTypes.length - 1];
      let varArgs = false;
      let paramLen = fn.paramTypes.length;
      if (fn.paramTypes.length > 0 && lastParam.tag == 'struct' && lastParam.val.template.name == '...') {
        varArgs = true;
        paramLen -= 1;
      }

      if (fn.paramTypes.length != paramTypes.length && !varArgs) {
        wrongTypeFns.push(fn);
        continue fnLoop;
      };
      for (let i = 0; i < paramLen; i++) {
        let pType = paramTypes[i];
        if (pType == null) continue;
        if (!typeApplicableStateful(pType, fn.paramTypes[i], genericMap, constMap, true)) {
          wrongTypeFns.push(fn);
          continue fnLoop;
        }
      }
    }

    if (retType != null) {
      if (!typeApplicableStateful(retType, fn.returnType, genericMap, constMap, true)) {
        wrongTypeFns.push(fn);
        continue fnLoop;
      }
    }

    let fnType: Type = { tag: 'fn', returnType: fn.returnType, paramTypes: fn.paramTypes };
    let resolvedType: Type = applyGenericMap(fnType, genericMap);
    resolvedType = applyConstMap(resolvedType, constMap);

    possibleFns.push({
      fnReference: fn,
      name: fn.name,
      unit: fn.unit,
      resolvedType,
      genericMap,
      mode: fn.mode,
      isGeneric: true
    });
  }
  return { possibleFns, wrongTypeFns };
}

// returns the amount of types applicable, null if already printed error
function resolveTypeInternal(
  unit: UnitSymbols,
  parseType: Parse.Type,
  position: Position | null
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

    if (parseType.unitMode == 'none') {
      let struct: Struct | undefined = unit.structs.get(name);
      if (struct != undefined) allStructs.push(struct);
      for (let useUnit of unit.useUnits) {
        struct = useUnit.structs.get(name);
        if (struct != undefined) allStructs.push(struct);
      }
    }
    else if (parseType.unitMode == 'as') {
      let symbols = getIsolatedUnitSymbolsFromAs(unit, parseType.unit, position);
      if (symbols == null) return null;
      let struct: Struct | undefined = symbols.structs.get(name);
      if (struct == undefined) return [];
      allStructs = [struct];
    }
    else if (parseType.unitMode == 'unit') {
      let symbols = getIsolatedUnitSymbolsFromName(unit, parseType.unit, position);
      if (symbols == null) return null;
      let struct: Struct | undefined = symbols.structs.get(name);
      if (struct == undefined) return [];
      allStructs = [struct];
    }

    // add the generics for this type
    for (let struct of allStructs) {
      if (parseType.tag == 'generic') {
        if (parseType.val.generics.length != struct.template.generics.length + struct.template.constFieldNames.length) { return null; } 

        let generics: Type[] = [];
        let constFields: string[] = [];
        for (let i = 0; i < parseType.val.generics.length; i++) {
          let g = parseType.val.generics[i];
          if (g.tag == 'const') {
            constFields.push(g.val);
          }
          else if (g.tag == 'int') {
            constFields.push('ANY');
          }
          else {
            let genericType = resolveType(unit, g, position);
            if (genericType == null) return null;
            generics.push(genericType);
          }
        }

        types.push({ tag: 'struct', val: { generics, constFields, template: struct.template } });
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
    return [{ tag: 'ptr', val: inner, const: parseType.const }];
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

    if (struct.header.structMode == 'enum') {
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
  validGenerics: string[],
  allowRef: boolean
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
    let firstTypeValid = verifyDataType(symbols, type.val0, position, validGenerics, allowRef);
    let secondTypeValid = verifyDataType(symbols, type.val1, position, validGenerics, allowRef);
    return firstTypeValid && secondTypeValid;
  }

  if (type.tag == 'ptr') {
    return verifyDataType(symbols, type.val, position, validGenerics, allowRef);
  }

  if (type.tag == 'generic') {
    let dataType = resolveType(symbols, type, position);
    for (let g of type.val.generics) {
      if (g.tag == 'const') {
        continue;
      }

      if (verifyDataType(symbols, g, position, validGenerics, allowRef) == false) {
        logError(position, 'unknown datatype');
        return false;
      }
    }
    if (dataType == null) return false;
    return true;
  } 

  if (type.tag == 'link') {
    if (!allowRef) {
      logError(position, 'ref not allowed in struct definitions');
      return false;
    }
    return verifyDataType(symbols, type.val, position, validGenerics, allowRef);
  } 

  if (type.tag == 'fn') {
    for (let i = 0; i < type.val.paramTypes.length; i++) {
      if (verifyDataType(symbols, type.val.paramTypes[i], position, validGenerics, true) == false) {
        logError(position, 'unknown datatype');
        return false;
      }
    }
    if (verifyDataType(symbols, type.val.returnType, position, validGenerics, true) == false) {
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
    let genericNames = [];
    for (let i = 0; i < struct.header.generics.length; i++) {
      let g = struct.header.generics[i];
      if (g.tag == 'generic') genericNames.push(g.name);
    }

    if (verifyDataType(symbols, field.t, field.position, genericNames, false) == false) {
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

