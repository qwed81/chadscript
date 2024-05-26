import {
  ProgramUnit as ParseProgramUnit, Struct as ParseStruct,
  Type as ParseType, FnType as ParseFnType, Fn as ParseFn
} from '../parse';
import { logError } from '../index';
import { Type, GenericType, ConcreteType, VOID, STR, typeApplicable, typeEq } from './types';

export {
  UnitRefs, unitRefs, resolveType, lookupFn, getFnUniqueId
}

interface UnitRefs {
  units: ParseProgramUnit[],
  unitName: string,
  uses: string[]
}

function unitRefs(units: ParseProgramUnit[], unitName: string, uses: string[]) {
  return { units, unitName, uses };
}

type ParseStructLookup = { tag: 'struct' | 'enum', val: ParseStruct, unit: UnitRefs } | null; 
function lookupStructOrEnum(
  name: string,
  genericCount: number,
  table: UnitRefs,
  sourceLine: number
): ParseStructLookup {
  let possibleType: ParseStructLookup = null;
  let typeUnit: string | null = null;

  for (let unit of table.units) {
    if (unit.fullName != table.unitName && !table.uses.includes(unit.fullName)) {
      continue;
    }

    let items: ['struct' | 'enum', ParseStruct][] = Array.from(unit.structs).map(x => ['struct', x]);
    items.push(...Array.from(unit.enums).map(x => ['enum', x]) as ['enum', ParseStruct][]);

    let thisUnit = unitRefs(table.units, unit.fullName, unit.uses);
    for (let [tag, struct] of items) {
      if (struct.t.tag == 'generic') {
        if (struct.t.val.name != name || struct.t.val.generics.length != genericCount) {
          continue;
        }

        if (possibleType != null) {
          logError(sourceLine, `{} is ambiguous between ${typeUnit}.name and ${unit.fullName}.name`);
          return null;
        }

        possibleType = { tag: 'struct', val: struct, unit: thisUnit  };
        typeUnit = unit.fullName;
      } else if (struct.t.tag == 'basic' && genericCount == 0) {
        if (struct.t.val != name) {
          continue;
        }

        if (possibleType != null) {
          logError(sourceLine, `{} is ambiguous between ${typeUnit}.name and ${unit.fullName}.name`);
          return null;
        }

        possibleType = { tag, val: struct, unit: thisUnit };
        typeUnit = unit.fullName;
      }
    }

  }

  if (possibleType == null) {
    logError(sourceLine, `could not find ${name}. missing a use?`)
    return null;
  }

  return possibleType;
}

function resolveOptErr(
  subType: ParseType,
  table: UnitRefs,
  ctxGenerics: Set<string>,
  sourceLine: number
): Type | null {
    let t = resolveType(subType, table, ctxGenerics, sourceLine);
    if (t == null) {
      return null;
    }

    let fields: { name: string, type: ConcreteType }[];
    if (subType.tag == 'opt') {
      fields = [ { name: 'some', type: t as any }, { name: 'none', type: VOID } ];
    } else {
      fields = [ { name: 'ok', type: t as any }, { name: 'err', type: STR } ];
    }

    if (t.tag == 'generic') {
      let thisGeneric: GenericType = t.val;
      return { tag: 'generic', val: { tag: 'enum', val: { generics: [thisGeneric], id: subType.tag } } };
    } else if (t.tag == 'concrete'){
      let thisConcrete: ConcreteType = t.val;
      return { 
        tag: 'concrete',
        val: {
          tag: 'enum',
          val: { 
            generics: [thisConcrete],
            id: subType.tag ,
            fields: fields
          }
        } 
      }
    } 

    logError(-1, 'complier error resolveType');
    return null;
}

function resolveFnType(
  fnType: ParseFnType,
  table: UnitRefs,
  ctxGenerics: Set<string>,
  sourceLine: number
): Type | null {
  let isGeneric = false;

  let returnType = resolveType(fnType.returnType, table, ctxGenerics, sourceLine);
  if (returnType == null) {
    return null;
  }
  if (returnType.tag == 'generic') {
    isGeneric = true;
  }

  let paramTypes = [];
  for (let param of fnType.paramTypes) {
    let paramType = resolveType(param, table, ctxGenerics, sourceLine);
    if (paramType == null) {
      return null;
    }
    if (paramType.tag == 'generic') {
      isGeneric = true;
    }
    paramTypes.push(paramType);
  }

  if (isGeneric) {
    return { tag: 'generic', val: { tag: 'fn', val: { returnType, paramTypes } } };
  } 

  let ret = returnType.val as ConcreteType;
  let params = paramTypes.map(p => p.val as ConcreteType);
  return { tag: 'concrete', val: { tag: 'fn', val: { returnType: ret, paramTypes: params } } };
}

// given a parseType, resolve it to a concrete or generic type
function resolveType(
  type: ParseType,
  table: UnitRefs,
  // when analyzing a function that has T as a type parameter,
  // a list[T] is not actually a generic type, where a list[V] is
  ctxGenerics: Set<string>,
  sourceLine: number
): Type | null {
  if (type.tag == 'link') {
    return resolveType(type.val, table, ctxGenerics, sourceLine);
  }

  if (type.tag == 'opt' || type.tag == 'err') {
    return resolveOptErr(type.val, table, ctxGenerics, sourceLine);
  } 

  if (type.tag == 'fn') {
    return resolveFnType(type.val, table, ctxGenerics, sourceLine);
  }

  // resolve struct type

  // the local definition of the struct is defined by the name and generics (name[generics[0] ... ])
  // this is used to both find the definition of the struct and resolve the concrete type of the local
  // struct given the struct def
  let localGenerics: ParseType[];
  let name: string = '';
  if (type.tag == 'basic') {
    if (type.val == 'bool' || type.val == 'void' || type.val == 'int' || type.val == 'str' || type.val == 'char') {
      return { tag: 'concrete', val: { tag: 'primative', val: type.val } };
    }

    if (type.val.length == 1) {
      return { tag: 'generic', val: { tag: 'generic', val: type.val } };
    }

    name = type.val;
    localGenerics = [];
  } else if (type.tag == 'generic') {
    name = type.val.name;
    localGenerics = type.val.generics;
  } else {
    logError(sourceLine, 'compiler bug');
    return null;
  }

  let structDef = lookupStructOrEnum(name, localGenerics.length, table, sourceLine);
  if (structDef == null) {
    return null;
  }

  // find the type of all the generics of the local definition
  let localGenericTypes: GenericType[] = [];
  let localGenericConcreteTypes: ConcreteType[] = [];
  for (let generic of localGenerics) {
    let genericType = resolveType(generic, table, ctxGenerics, sourceLine); 
    if (genericType == null) {
      return null;
    }

    if (genericType.tag == 'generic') {
      localGenericTypes.push(genericType.val);
    } else if (genericType.tag == 'concrete'){
      localGenericConcreteTypes.push(genericType.val);
    }
  }

  if (localGenericTypes.length > 0 && localGenericConcreteTypes.length > 0) {
    logError(sourceLine, `${name} can not be both concrete an generic`);
    return null;
  }

  if (localGenericTypes.length > 0) { // the struct can not fully be resolved so it is still generic (list[list[T]] or list[T])
    return { tag: 'generic', val: { tag: structDef.tag, val: { generics: localGenericTypes, id: name } } };
  }

  // every type of the struct is not generic so it can be used as a concrete type
  let template: ParseStruct = structDef.val;
  let defGenericMap: Map<string, ConcreteType> = new Map();

  // build out a mapping so generic fields can get their concrete type
  if (template.t.tag == 'generic') {
    let defGenerics: ParseType[] = template.t.val.generics;
    for (let i = 0; i < localGenericConcreteTypes.length; i++) {
      let parseType = defGenerics[i];
      if (parseType.tag != 'basic' || parseType.val.length != 1) {
        logError(sourceLine, 'compiler error. should have checked valid generics prior');
        return null;
      }

      let defGeneric: string = parseType.val;
      defGenericMap.set(defGeneric, localGenericConcreteTypes[i]);
    }
  }

  let concreteFields: { name: string, type: ConcreteType }[] = [];
  for (let field of template.fields) {
    if (defGenericMap.has(field.name)) { // resolve generic fields according to local generics
      concreteFields.push({ name: field.name, type: defGenericMap.get(field.name)! });
    } else {
      // resolve using the struct's definitions unit
      // additionally none of the local generics should interfere
      let fieldType = resolveType(field.t, structDef.unit, new Set(), sourceLine);
      if (fieldType == null) {
        logError(sourceLine, 'compiler error struct field not valid');
        return null;
      }

      if (fieldType.tag == 'concrete') {
        concreteFields.push({ name: field.name, type: fieldType.val });
      } else {
        logError(sourceLine, 'compiler error field not concrete type');
        return null;
      }
    }
  }

  let concreteType = { tag: structDef.tag,
    val: { 
      fields: concreteFields,
      generics: localGenericConcreteTypes,
      id: name 
    } 
  };
  return { tag: 'concrete', val: concreteType };
}

// given the function name and it's type, lookup in all units and find the matching function
// if it exists
function lookupFn(
  name: string,
  paramTypes: ConcreteType[],
  returnType: ConcreteType,
  units: UnitRefs,
  calleeLine: number
): string | null {
  let possibleFnId: string | null = null;
  let possibleFnUnit: string | null = null;

  for (let fnDefUnit of units.units) {
    if (fnDefUnit.fullName != units.unitName && !units.uses.includes(fnDefUnit.fullName)) {
      continue;
    }

    let fnDefLookuptable = { units: units.units, unitName: fnDefUnit.fullName, uses: fnDefUnit.uses };
    for (let fnDef of fnDefUnit.fns) {
      if (fnDef.name != name) {
        continue;
      }

      // get the type of this function
      let pt: ParseType = { tag: 'fn', val: fnDef.t };
      let fnDefType = resolveType(pt, fnDefLookuptable, new Set(), fnDef.sourceLine);
      if (fnDefType == null || fnDefType.val.tag != 'fn') {
        logError(fnDef.sourceLine, 'invalid fn');
        continue;
      }

      if (fnDefType.tag == 'generic' && !typeApplicable(returnType, fnDefType.val.val.returnType)) {
        continue;
      } else if (fnDefType.tag == 'concrete' && !typeEq(returnType, fnDefType.val.val.returnType)) {
        continue;
      }

      if (paramTypes.length != fnDefType.val.val.paramTypes.length) {
        continue;
      }
      // ensure all paremeters are allows to be converted
      let allValid = true;
      for (let i = 0; i < paramTypes.length; i++) {
        if (fnDefType.tag == 'generic' && !typeApplicable(returnType, fnDefType.val.val.returnType)) {
          allValid = false;
          break;
        } else if (fnDefType.tag == 'concrete' && !typeEq(returnType, fnDefType.val.val.returnType)) {
          allValid = false;
          break;
        }
      }

      if (allValid == false) {
        continue;
      }

      if (possibleFnId != null) {
        logError(calleeLine, `ambiguous function call ${possibleFnUnit}.name and ${fnDefUnit.fullName}.name`)
        return null;
      }

      possibleFnId = getFnUniqueId(fnDefUnit.fullName, fnDef);
      possibleFnUnit = fnDefUnit.fullName;
    }
  }

  return possibleFnId;
}

// java implementation taken from https://stackoverflow.com/questions/6122571/simple-non-secure-hash-function-for-javascript
function getFnUniqueId(fnUnitName: string, fn: ParseFn): string {
  let str = JSON.stringify({fnUnitName, fn: fn.name, t: fn.t });

  let hash = 0;
  for (let i = 0, len = str.length; i < len; i++) {
    let chr = str.charCodeAt(i);
    hash = (hash << 5) - hash + chr;
  }

  if (hash < 0) {
    hash = hash * -1;
  }
  return '$' + hash;
}

