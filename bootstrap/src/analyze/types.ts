import { logError } from '../index'

export {
  INT, BOOL, VOID, STR, CHAR, Type, ConcreteType, GenericType,
  GenericStruct, ConcreteStruct, ConcreteField,
  typeEq, typeApplicable, toStr
}

const INT: ConcreteType = { tag: 'primative', val: 'int' };
const BOOL: ConcreteType = { tag: 'primative', val: 'bool' };
const VOID: ConcreteType = { tag: 'primative', val: 'void' }
const STR: ConcreteType = { tag: 'primative', val: 'str' };
const CHAR: ConcreteType = { tag: 'primative', val: 'char' };

interface ConcreteField {
  name: string,
  type: ConcreteType
}

interface ConcreteStruct {
  fields: ConcreteField[]
  generics: ConcreteType[]
  id: string
}

type ConcreteType = { tag: 'primative', val: 'bool' | 'void' | 'int' | 'str' | 'char' }
  | { tag: 'view', val: ConcreteType }
  | { tag: 'struct', val: ConcreteStruct }
  | { tag: 'enum', val: ConcreteStruct }
  | { tag: 'fn', val: { returnType: ConcreteType, paramTypes: ConcreteType[] } }

interface GenericStruct {
  generics: GenericType[],
  id: string
}

type GenericType = { tag: 'generic', val: string }
  | { tag: 'view', val: GenericType }
  | { tag: 'struct', val: GenericStruct }
  | { tag: 'enum', val: GenericStruct }
  | { tag: 'fn', val: { returnType: Type, paramTypes: Type[] } }

type Type = { tag: 'concrete', val: ConcreteType } | { tag: 'generic', val: GenericType }


function genericEq(a: GenericType, b: GenericType): boolean {
  if (a.tag != b.tag) {
    return false
  }

  if (a.tag == 'generic') {
    return true;
  }

  if (a.tag == 'view' && b.tag == 'view') {
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

  /* TODO
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
  */

  return true;
}

function toStr(t: ConcreteType | null): string {
  if (t == null) {
    return 'null';
  }
  
  if (t.tag == 'primative') {
    return t.val;
  }

  if (t.tag == 'view') {
    return `view[${toStr(t)}]`;
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

  if (a.tag == 'enum' && b.tag == 'enum' || a.tag == 'struct' && b.tag == 'struct') {
    if (a.val.id != b.val.id) {
      return false;
    }

    return a.val.generics == b.val.generics;
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

function typeApplicable(sub: ConcreteType, supa: Type): boolean {
  if (supa.tag == 'generic') {
    return typeApplicableGeneric(sub, supa.val);
  } else if (supa.tag == 'concrete' ){
    return typeEq(sub, supa.val);
  }

  return false;
} 

function typeApplicableGeneric(sub: ConcreteType, supa: GenericType): boolean {
  // any -> T
  if (supa.tag == 'generic') {
    return true;
  } 

  // view[any] -> view[T]
  if (sub.tag == 'view') {
    if (supa.tag != 'view') {
      return false;
    }

    return typeApplicableGeneric(sub.val, supa.val);
  }

  if (sub.tag == 'struct' && supa.tag == 'struct' || sub.tag == 'enum' && supa.tag == 'enum') {
    if (sub.val.generics.length != supa.val.generics.length) {
      return false;
    }
    for (let i = 0; i < sub.val.generics.length; i++) {
      if (typeApplicableGeneric(sub.val.generics[i], supa.val.generics[i]) == false) {
        return false;
      }
    }
    // list[any] -> list[t]
    return sub.val.id == supa.val.id;
  }


  logError(-1, 'typeApplicable compiler bug');
  return false;
}

