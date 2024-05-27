import { logError } from '../index'

export {
  INT, BOOL, VOID, CHAR, CHAR_SLICE, RANGE, Type, ConcreteType, GenericType,
  GenericStruct, ConcreteStruct, ConcreteField,
  typeEq, typeApplicable, toStr, replaceGenerics
}

const CHAR_SLICE: ConcreteType = { tag: 'slice', val: { tag: 'primative', val: 'char' } }
const INT: ConcreteType = { tag: 'primative', val: 'int' };
const RANGE_FIELDS: ConcreteField[] = [{ name: 'start', type: INT }, { name: 'end', type: INT }];
const RANGE: ConcreteType = { tag: 'struct', val: { generics: [], fields: RANGE_FIELDS, id: 'Range' } };
const BOOL: ConcreteType = { tag: 'primative', val: 'bool' };
const VOID: ConcreteType = { tag: 'primative', val: 'void' }
const CHAR: ConcreteType = { tag: 'primative', val: 'char' };

interface ConcreteField {
  name: string
  type: ConcreteType
}

interface ConcreteStruct {
  fields: ConcreteField[]
  generics: ConcreteType[]
  id: string
}

type ConcreteType = { tag: 'primative', val: 'bool' | 'void' | 'int' | 'char' }
  | { tag: 'slice', val: ConcreteType }
  | { tag: 'struct', val: ConcreteStruct }
  | { tag: 'enum', val: ConcreteStruct }
  | { tag: 'fn', val: { returnType: ConcreteType, paramTypes: ConcreteType[] } }

interface GenericField {
  name: string
  type: Type
}

interface GenericStruct {
  fields: GenericField[]
  generics: GenericType[]
  id: string
}

type GenericType = { tag: 'generic', val: string }
  | { tag: 'slice', val: GenericType }
  | { tag: 'struct', val: GenericStruct }
  | { tag: 'enum', val: GenericStruct }
  | { tag: 'fn', val: { returnType: Type, paramTypes: Type[] } }

type Type = { tag: 'concrete', val: ConcreteType } | { tag: 'generic', val: GenericType }

/*
function genericEq(a: GenericType, b: GenericType): boolean {
  if (a.tag != b.tag) {
    return false
  }

  if (a.tag == 'generic') {
    return true;
  }

  if (a.tag == 'slice' && b.tag == 'slice') {
    return genericEq(a.val, b.val);
  }

  if (a.tag == 'struct' && b.tag == 'struct' || a.tag == 'enum' && b.tag == 'enum') {
    if (a.val.generics.length != b.val.generics.length) {
      return false;
    }

    if (a.val.id != b.val.id) {
      return false;
    }

    for (let i = 0; i < a.val.generics.length; i++) {
      if (genericEq(a.val.generics[i], b.val.generics[i]) == false) {
        return false;
      }
    }
  }

  // TODO
  if (a.tag == 'fn' && b.tag == 'fn') {
    if (a.val.returnType != b.val.returnType) {
      return false;
    }
    if (a.val.paramTypes.length != b.val.paramTypes.length) {
      return false;
    }
    for (let i = 0; i < a.val.paramTypes.length; i++) {
      if (genericEq(a.val.paramTypes[i], b.val.paramTypes[i]) == false) {
        return false;
      }
    }
  }

  return true;
}
*/

function toStr(t: ConcreteType | null): string {
  if (t == null) {
    return 'null';
  }
  
  if (t.tag == 'primative') {
    return t.val;
  }

  if (t.tag == 'slice') {
    return `${toStr(t.val)}*`;
  }

  if (t.tag == 'struct' || t.tag == 'enum') {
    return t.val.id;
  }

  if (t.tag == 'fn') {
    let s = '';
    for (let i = 0; i < t.val.paramTypes.length; i++) {
      s += toStr(t);
      if (i != t.val.paramTypes.length - 1) {
        s += ', ';
      }
    }
    return `(${s})${toStr(t.val.returnType)}`;
  }

  return '???';
}

function typeEq(a: ConcreteType, b: ConcreteType): boolean {
  if (a.tag != b.tag) {
    return false;
  }

  if (a.tag == 'primative') {
    return a.val == b.val;
  }

  if (a.tag == 'slice' && b.tag == 'slice') {
    return typeEq(a.val, b.val);
  }

  if (a.tag == 'enum' && b.tag == 'enum' || a.tag == 'struct' && b.tag == 'struct') {
    if (a.val.id != b.val.id) {
      return false;
    }

    if (a.val.fields.length != b.val.fields.length) {
      return false;
    }

    for (let i = 0; i < a.val.fields.length; i++) {
      if (typeEq(a.val.fields[i].type, b.val.fields[i].type) == false) {
        return false;
      }

      if (a.val.fields[i].name != b.val.fields[i].name) {
        return false;
      }
    }

    if (a.val.generics.length != b.val.generics.length) {
      return false;
    }

    for (let i = 0; i < a.val.generics.length; i++) {
      if (typeEq(a.val.generics[i], b.val.generics[i]) == false) {
        return false;
      }
    }

    return true;
  }

  if (a.tag == 'fn' && b.tag == 'fn') {
    if (typeEq(a.val.returnType, b.val.returnType) == false) {
      return false;
    }

    if (a.val.paramTypes.length != b.val.paramTypes.length) {
      return false;
    }
    for (let i = 0; i < a.val.paramTypes.length; i++) {
      if (typeEq(a.val.paramTypes[i], b.val.paramTypes[i]) == false) {
        return false;
      }
    }
    return true;
  }

  logError(-1, 'typeEq compiler bug');
  return false;
}

function typeApplicable(
  sub: ConcreteType,
  supa: Type,
  // used for successive calls of typeApplicable
  // if the generic is already mapped a check of the same time will be performed, otherwise
  // it will be mapped so that nested generics are the same across a function
  // T(T, T) -> int(int, int) and can not be int(int, char)
  genericMap: Map<string, ConcreteType> | null
): boolean {
  if (supa.tag == 'generic') {
    return typeApplicableGeneric(sub, supa.val, genericMap);
  } else if (supa.tag == 'concrete' ){
    return typeEq(sub, supa.val);
  }

  return false;
} 

function replaceGenerics(
  type: GenericType,
  genericMap: Map<string, ConcreteType>
): ConcreteType | null {
  if (type.tag == 'generic') {
    if (genericMap.has(type.val) == false) {
      logError(-1, 'no generic');
      return null;
    }
    return genericMap.get(type.val)!;
  }

  if (type.tag == 'slice') {
    let replaced = replaceGenerics(type.val, genericMap);
    if (replaced == null) {
      return null;
    }
    return { tag: 'slice', val: replaced };
  }

  if (type.tag == 'struct' || type.tag == 'enum') {
    let concreteFields: ConcreteField[] = [];
    let concreteGenerics: ConcreteType[] = [];
    for (let i = 0; i < type.val.fields.length; i++) {
      let concreteFieldType;
      let fieldType = type.val.fields[i].type;
      if (fieldType.tag == 'generic') {
        let newField = replaceGenerics(fieldType.val, genericMap);
        if (newField == null) {
          return null;
        }
        concreteFieldType = newField;
      } else if (fieldType.tag == 'concrete') {
        concreteFieldType = fieldType.val;
      } else {
        return null;
      }

      concreteFields.push({ name: type.val.fields[i].name, type: concreteFieldType });
    }

    for (let i = 0; i < type.val.generics.length; i++) {
      let newGeneric = replaceGenerics(type.val.generics[i], genericMap);
      if (newGeneric == null) {
        return null;
      }
      concreteGenerics.push(newGeneric);
    }

    return { tag: 'struct', val: { id: type.val.id, generics: concreteGenerics, fields: concreteFields } };
  }

  if (type.tag == 'fn') {
    let returnType: ConcreteType;
    let paramTypes: ConcreteType[] = [];
    if (type.val.returnType.tag == 'generic') {
      let newType = replaceGenerics(type.val.returnType.val, genericMap);
      if (newType == null) {
        return null;
      }
      returnType = newType;
    } else if (type.val.returnType.tag == 'concrete') {
      returnType = type.val.returnType.val;
    } else {
      logError(-1, 'replaceGenerics compiler bug');
      return null;
    }

    for (let i = 0; i < type.val.paramTypes.length; i++) {
      let paramType = type.val.paramTypes[i];
      if (paramType.tag == 'generic') {
        let newType = replaceGenerics(paramType.val, genericMap);
        if (newType == null) {
          return null;
        }
        paramTypes.push(newType);
      } else if (paramType.tag == 'concrete') {
        paramTypes.push(paramType.val);
      } else {
        logError(-1, 'replaceGenerics compiler bug');
        return null;
      }
    }

    return { tag: 'fn', val: { returnType, paramTypes } };
  }

  logError(-1, 'replaceGenerics compiler bug');
  return null;
}

function typeApplicableGeneric(
  sub: ConcreteType,
  supa: GenericType,
  genericMap: Map<string, ConcreteType> | null
): boolean {
  // any -> T
  if (supa.tag == 'generic') {
    if (genericMap != null) {
      if (genericMap.has(supa.val) && !typeEq(sub, genericMap.get(supa.val)!)) {
        return false;
      }
      genericMap.set(supa.val, sub);
    }
    return true;
  } 

  // view[any] -> view[T]
  if (sub.tag == 'slice') {
    if (supa.tag != 'slice') {
      return false;
    }

    return typeApplicableGeneric(sub.val, supa.val, genericMap);
  }

  if (sub.tag == 'struct' && supa.tag == 'struct' || sub.tag == 'enum' && supa.tag == 'enum') {
    if (sub.val.generics.length != supa.val.generics.length) {
      return false;
    }
    for (let i = 0; i < sub.val.generics.length; i++) {
      if (typeApplicableGeneric(sub.val.generics[i], supa.val.generics[i], genericMap) == false) {
        return false;
      }
    }
    // list[any] -> list[t]
    return sub.val.id == supa.val.id;
  }

  if (sub.tag == 'fn') {
    logError(-1, 'compilerError not implemented');
    return false;
  }

  logError(-1, 'typeApplicable compiler bug');
  return false;
}

