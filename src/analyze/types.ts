import { logError } from '../index'
import * as Parse from '../parse';

export {
  INT, RANGE_FIELDS, RANGE, BOOL, VOID, CHAR, NUM, STR, BYTE,
  Field, Struct, Type, toStr, typeApplicable, typeApplicableStateful, isGeneric,
  applyGenericMap, canMath, canOrder, canEq, canIndex, canDot, RefTable,
  getUnitReferences, resolveType, resolveFn, 
  isRes, createRes, getVariantIndex
}

const STR: Type = { tag: 'arr', constant: true, val: { tag: 'primative', val: 'char' } }
const INT: Type = { tag: 'primative', val: 'int' };
const RANGE_FIELDS: Field[] = [{ name: 'start', type: INT }, { name: 'end', type: INT }];
const RANGE: Type = { tag: 'struct', val: { generics: [], fields: RANGE_FIELDS, id: 'std.Range' } };
const BOOL: Type = { tag: 'primative', val: 'bool' };
const VOID: Type = { tag: 'primative', val: 'void' }
const CHAR: Type = { tag: 'primative', val: 'char' };
const NUM: Type = { tag: 'primative', val: 'num' };
const BYTE: Type = { tag: 'primative', val: 'byte' };

interface Field {
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
  | { tag: 'arr', constant: boolean, val: Type }
  | { tag: 'struct', val: Struct }
  | { tag: 'enum', val: Struct }
  | { tag: 'fn', val: { returnType: Type, paramTypes: Type[], linkedParams: boolean[] } }

function createRes(genericType: Type): Type {
  return {
    tag: 'enum',
    val: {
      id: 'std.Res',
      fields: [
        { name: 'ok', type: genericType },
        { name: 'err', type: STR }
      ],
      generics: [genericType]
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

  if (t.tag == 'arr') {
    if (t.constant) {
      return `${toStr(t.val)}^`;
    } else {
      return `${toStr(t.val)}*`;
    }
  }
  
  if (t.tag == 'generic') {
    return t.val;
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
  return type.tag == 'enum' && type.val.id == 'std.Res';
}

function typeApplicableStateful(sub: Type, supa: Type, genericMap: Map<string, Type>): boolean {
  if (supa.tag == 'generic') {
    if (sub.tag != 'generic' && genericMap.has(supa.val)) {
      return typeApplicableStateful(sub, genericMap.get(supa.val)!, genericMap);
    }
    genericMap.set(supa.val, sub);
    return true;
  }

  if (sub.tag != supa.tag) {
    return false;
  }

  if (sub.tag == 'primative') {
    return sub.val == supa.val;
  }

  if (sub.tag == 'arr' && supa.tag == 'arr') {
    if (sub.constant && !supa.constant) {
      return false;
    }
    return typeApplicableStateful(sub.val, supa.val, genericMap);
  }

  if (sub.tag == 'enum' && supa.tag == 'enum' || sub.tag == 'struct' && supa.tag == 'struct') {
    if (sub.val.id != supa.val.id) {
      return false;
    }

    if (sub.val.generics.length != supa.val.generics.length) {
      return false;
    }

    for (let i = 0; i < sub.val.generics.length; i++) {
      if (typeApplicableStateful(sub.val.generics[i], supa.val.generics[i], genericMap) == false) {
        return false;
      }
    }

    return true;
  }

  if (sub.tag == 'fn' && supa.tag == 'fn') {
    if (typeApplicableStateful(sub.val.returnType, supa.val.returnType, genericMap) == false) {
      return false;
    }

    if (sub.val.paramTypes.length != supa.val.paramTypes.length) {
      return false;
    }
    for (let i = 0; i < sub.val.paramTypes.length; i++) {
      if (typeApplicableStateful(sub.val.paramTypes[i], supa.val.paramTypes[i], genericMap) == false) {
        return false;
      }
    }
    return true;
  }

  logError(-1, 'typeEq compiler bug');
  return false;
}

function typeApplicable(sub: Type, supa: Type): boolean {
  let genericMap = new Map<string, Type>();
  return typeApplicableStateful(sub, supa, genericMap);
}

function applyGenericMap(input: Type, map: Map<string, Type>): Type {
  if (input.tag == 'generic') {
    if (map.has(input.val)) {
      return map.get(input.val)!;
    }
  }
  else if (input.tag == 'primative') {
    return input;
  }
  else if (input.tag == 'struct' || input.tag == 'enum') {
    let newGenerics: Type[] = [];
    let newFields: Field[] = [];
    for (let field of input.val.fields) {
      let fieldType = applyGenericMap(field.type, map);
      newFields.push({ name: field.name, type: fieldType });
    }
    for (let generic of input.val.generics) {
      newGenerics.push(applyGenericMap(generic, map));
    }
    return { tag: input.tag, val: { fields: newFields, generics: newGenerics, id: input.val.id }};
  }
  else if (input.tag == 'arr') {
    return { tag: 'arr', constant: input.constant, val: applyGenericMap(input.val, map) };
  }
  else if (input.tag == 'fn') {
    let newReturnType: Type = applyGenericMap(input.val.returnType, map);
    let newParamTypes: Type[] = []
    for (let paramType of input.val.paramTypes) {
      newParamTypes.push(applyGenericMap(paramType, map));
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
  else if (a.tag == 'arr') {
    return isGeneric(a.val);
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
  return false;
}

function canMath(a: Type, b: Type): Type | null {
  if (typeApplicable(a, INT)) {
    if (typeApplicable(b, INT)) {
      return INT;
    } else if (typeApplicable(b, NUM)) {
      return NUM;
    } else if (typeApplicable(b, BYTE)) {
      return BYTE;
    } else if (typeApplicable(b, CHAR)) {
      return CHAR;
    }
  }
  else if (typeApplicable(a, BYTE)) {
    if (typeApplicable(b, INT)) {
      return INT;
    } else if (typeApplicable(b, BYTE)) {
      return BYTE;
    }
  }
  else if (typeApplicable(a, CHAR)) {
    if (typeApplicable(b, INT)) {
      return INT;
    } else if (typeApplicable(b, CHAR)) {
      return CHAR;
    }
  }
  else if (typeApplicable(a, NUM)) {
    if (typeApplicable(b, INT) || typeApplicable(b, NUM)) {
      return NUM;
    }
  }

  return null;
}

function canOrder(a: Type, b: Type): Type | null {
  if (typeApplicable(a, INT) && typeApplicable(b, INT)) {
    return BOOL;
  }
  if (typeApplicable(a, NUM) && typeApplicable(b, NUM)) {
    return BOOL;
  }
  return null;
}

function canEq(a: Type, b: Type): Type | null {
  if (typeApplicable(a, INT) && typeApplicable(b, INT)) {
    return BOOL;
  }
  if (typeApplicable(a, CHAR) && typeApplicable(b, CHAR)) {
    return BOOL;
  }
  if (typeApplicable(a, BOOL) && typeApplicable(b, BOOL)) {
    return BOOL;
  }
  return null;
}

function canIndex(a: Type): Type | null {
  if (a.tag == 'arr') {
    return a.val;
  }

  if (a.tag == 'struct' && a.val.id == 'std.List') {
    return a.val.generics[0];
  }

  return null;
}

function canDot(a: Type, field: string): Type | null {
  // TODO
  return null;
}

interface RefTable {
  units: Parse.ProgramUnit[]
  allUnits: Parse.ProgramUnit[]
}

function getUnitReferences(
  thisUnit: Parse.ProgramUnit,
  allUnits: Parse.ProgramUnit[]
): RefTable {
  let newUnits: Parse.ProgramUnit[] = [thisUnit];
  for (let i = 0; i < allUnits.length; i++) {
    if (thisUnit.uses.includes(allUnits[i].fullName)) {
      newUnits.push(allUnits[i]);
    }
  }
  return { units: newUnits, allUnits };
}

function resolveType(
  def: Parse.Type,
  refTable: RefTable,
  sourceLine: number
): Type | null {
  if (def.tag == 'basic') {
    if (def.val == 'int' || def.val == 'num' || def.val == 'bool' || def.val == 'char' || def.val == 'void' || def.val == 'byte') {
      return { tag: 'primative', val: def.val };
    }
    if (def.val.length == 1 && def.val >= 'A' && def.val <= 'Z') {
      return { tag: 'generic', val: def.val };
    }
    return resolveStruct(def.val, [],  refTable, sourceLine);
  } 
  else if (def.tag == 'link') {
    return resolveType(def.val, refTable, sourceLine);
  }
  else if (def.tag == 'arr') {
    let slice = resolveType(def.val, refTable, sourceLine);
    if (slice == null) {
      return null;
    }
    return { tag: 'arr', constant: false, val: slice };
  }
  else if (def.tag == 'const_arr') {
    let slice = resolveType(def.val, refTable, sourceLine);
    if (slice == null) {
      return null;
    }
    return { tag: 'arr', constant: true, val: slice };
  }
  else if (def.tag == 'generic') {
    let resolvedGenerics: Type[] = [];
    for (let generic of def.val.generics) {
      if (generic.tag == 'link') {
        logError(sourceLine, 'ref not supported in generics');
        return null;
      }

      let resolvedGeneric = resolveType(generic, refTable, sourceLine);
      if (resolvedGeneric == null) {
        return null;
      }
      resolvedGenerics.push(resolvedGeneric);
    }
    return resolveStruct(def.val.name, resolvedGenerics, refTable, sourceLine);
  } 
  else if (def.tag == 'fn') {
    let paramTypes: Type[] = [];
    let linked: boolean[] = [];
    for (let parseParam of def.val.paramTypes) {
      let resolvedParam = resolveType(parseParam, refTable, sourceLine);
      if (resolvedParam == null) {
        return null;
      }
      linked.push(parseParam.tag == 'link');
      paramTypes.push(resolvedParam);
    }
    let returnType = resolveType(def.val.returnType, refTable, sourceLine);
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
  sourceLine: number
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
        let fieldType = resolveType(field.t, unitRefTable, sourceLine);
        if (fieldType == null) {
          logError(sourceLine, 'compiler error, should have been checked prior');
          return null;
        }

        let concreteFieldType = applyGenericMap(fieldType, genericMap);
        fields.push({ name: field.name, type: concreteFieldType });
      }

      let thisStructId = unit.fullName + '.' + structDef.header.name;
      let thisStruct: Type = { tag: item[0], val: { fields, generics, id: thisStructId } };
      possibleStructs.push(thisStruct);
    }
  }

  if (possibleStructs.length > 1) {
    logError(sourceLine, 'ambiguous struct');
    return null;
  }

  if (possibleStructs.length == 0) {
    logError(sourceLine, `struct '${name}' could not be found`);
    return null;
  }

  return possibleStructs[0];
}

interface FnResult {
  fnType: Type,
  unitName: string
  fnName: string
}

function resolveFn(
  name: string,
  returnType: Type | null,
  paramTypes: (Type | null)[] | null,
  refTable: RefTable,
  calleeLine: number
): FnResult | null {

  let possibleFns: FnResult[] = [];
  let wrongTypeFns: Parse.Fn[] = [];
  for (let unit of refTable.units) {
    let unitRefTable = getUnitReferences(unit, refTable.allUnits);
    for (let fnDef of unit.fns) {
      if (fnDef.name != name) {
        continue;
      }
      
      let genericMap = new Map<string, Type>();
      if (paramTypes != null && fnDef.t.paramTypes.length != paramTypes.length) {
        wrongTypeFns.push(fnDef);
        continue;
      }

      let linkedParams: boolean[] = [];
      let concreteParamTypes: Type[] = [];
      let allParamsOk = true;
      for (let i = 0; i < fnDef.t.paramTypes.length; i++) {
        if (fnDef.t.paramTypes[i].tag == 'link') {
          linkedParams.push(true);
        } else {
          linkedParams.push(false);
        }

        let defParamType = resolveType(fnDef.t.paramTypes[i], refTable, calleeLine);
        if (defParamType == null) {
          logError(calleeLine, 'compiler error param type invalid (checked before)');
          return null;
        }

        if (paramTypes != null) {
          let paramType = paramTypes[i];
          if (paramType != null && !typeApplicableStateful(paramType, defParamType, genericMap)) {
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
      let defReturnType = resolveType(fnDef.t.returnType, unitRefTable, calleeLine);
      if (defReturnType == null) {
        logError(calleeLine, 'compiler error return type invalid (checked before)');
        return null;
      }
      if (returnType != null) {
        let wrongType = false;
        // TODO fix quick hack if it becomes a problem
        if (defReturnType.tag == 'arr' && returnType.tag == 'arr') {
          if (!typeApplicableStateful(returnType.val, defReturnType.val, genericMap) 
            && !returnType.constant && defReturnType.constant) {

            wrongType = true;
          }
        } else if (!typeApplicableStateful(returnType, defReturnType, genericMap)) { // backwards to allow generic returns
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

      possibleFns.push({ unitName: unit.fullName, fnName: fnDef.name, fnType });
    }
  }

  if (possibleFns.length == 1) {
    return possibleFns[0];
  }

  // give a useful error about why it can't resolve the function
  if (possibleFns.length > 1) {
    logError(calleeLine, 'function call is ambiguous');
    return null;
  }

  if (wrongTypeFns.length > 0) {
    logError(calleeLine, 'function does not match type signature');
    return null;
  }

  logError(calleeLine, `could not find ${name}`);
  return null;
}

