import fs from 'node:fs';
import { Type, INT, NUM, VOID, CHAR, BOOL, BYTE, Field } from './analyze/types';
import { execSync } from 'child_process';
import { compilerError } from './util';

export {
  HeaderInclude, parseHeaderFile, ExternFn
}

interface ExternFn {
  name: string
  type: Type
}

interface ExternVar {
  name: string
  type: Type
}

interface ExternDefine {
  name: string
  num: number
  type: Type
}

interface TypeDef {
  name: string
  type: Type
}

interface HeaderInclude {
  fns: ExternFn[]
  vars: ExternVar[]
  defs: ExternDefine[]
  typeDefs: TypeDef[]
  unitName: string
}

interface ASTType {
  qualType: string
}

interface ASTNode {
  kind: string
  name?: string
  inner?: ASTNode[]
  type: ASTType
}

function parseHeaderFile(headerPath: string): HeaderInclude | null {
  let astCommand = 'clang -Xclang -ast-dump=json -fsyntax-only ' + headerPath;
  let defCommand = 'clang -E -dM ' + headerPath;
  let astJson = execSync(astCommand, { encoding: 'utf8' });
  let defTexts = execSync(defCommand, { encoding: 'utf8'} );
  let ast: ASTNode = JSON.parse(astJson);
  let defs: string[] = defTexts.split('\n');

  let structTypeMap: Map<string, Type> = new Map();
  let symbols: HeaderInclude = {
    fns: [],
    defs: [],
    vars: [],
    typeDefs: [],
    unitName: headerPath
  };
  if (ast.inner == undefined) {
    return null;
  }

  // to prevent duplicate symbols
  let alreadyAdded: Set<string> = new Set();
  // parse AST for fns, structs, ect.
  for (let child of ast.inner) {
    if (child.name == undefined || alreadyAdded.has(child.name)) {
      continue;
    }

    if (child.kind == 'VarDecl') {
      let varType = parseCType(child.type.qualType, structTypeMap);
      symbols.vars.push({
        type: varType,
        name: child.name
      });
      alreadyAdded.add(child.name);
    }
    else if (child.kind == 'FunctionDecl') {
      let fnType = parseCType(child.type.qualType, structTypeMap);
      symbols.fns.push({
        type: fnType,
        name: child.name,
      });
      alreadyAdded.add(child.name);
    }
    else if (child.kind == 'RecordDecl') {
      let recordType = parseCRecord(child, structTypeMap);
      structTypeMap.set(child.name, recordType);
      symbols.fns.push({
        name: child.name,
        type: recordType
      });
      alreadyAdded.add(child.name);
    }
    else if (child.kind == 'TypedefDecl') {
      let typeDefType = parseCType(child.type.qualType, structTypeMap);
      symbols.typeDefs.push({
        name: child.name,
        type: typeDefType
      });
      alreadyAdded.add(child.name);
    }
  }

  // parse preprocessor defines to determine constants
  for (let def of defs) {
    let splitDef = def.split(' ');
    let name: string = splitDef[1];
    let val = splitDef[2];
    let cExpr: CExpr | null = parseCExpr(val);
    if (cExpr == null) {
      continue;
    }
    symbols.defs.push({
      name: name,
      num: cExpr.val ,
      type: cExpr.type 
    });
  }

  return symbols;
}

function parseCRecord(node: ASTNode, structTypeMap: Map<string, Type>): Type {
  let fields: Field[] = [];
  if (node.inner == undefined || node.name == undefined) {
    compilerError('malformed C type');
    return undefined!;
  }

  for (let cField of node.inner) {
    if (cField.name == undefined) {
      continue;
    }

    let fieldType = parseCType(cField.type.qualType, structTypeMap);
    fields.push({
      visibility: null,
      name: cField.name,
      type: fieldType
    })
  }

  return {
    tag: 'struct',
    val: {
      fields,
      generics: [],
      id: node.name
    }
  }
};

interface CExpr {
  val: number
  type: Type
}

function parseCExpr(val: string): CExpr | null {
  let result = Number(val);
  if (isNaN(result)) {
    return null;
  }
  if (result == Math.floor(result)) {
    return { type: INT, val: result };
  }
  
  return { type: NUM, val: result };
}

// splits to a(b) -> [a, b]
function splitLastParen(input: string): [string, string] {
  let numOpen = 0;
  for (let i = input.length - 1; i >= 0; i--) {
    if (input[i] == '(') {
      numOpen += 1;
    }
    if (input[i] == ')') {
      numOpen -= 1;
    }

    if (numOpen == 0) {
      let insideParen = input.slice(i + 1, input.length - 1);
      let outsideParen = input.slice(0, i - 1);
      return [outsideParen, insideParen]
    }
  }

  compilerError('malformed C type');
  return undefined!;
}

// splits items only insde commas
function splitComma(input: string): string[] {
  let output: string[] = [];

  let numOpen = 0;
  let strStart = 0;
  for (let i = 0; i < input.length; i++) {
    if (input[i] == '(') {
      numOpen += 1;
    }
    if (input[i] == ')') {
      numOpen -= 1;
    }

    if (numOpen == 0 && input[i] == ',') {
      output.push(input.slice(strStart, i));
      strStart = i + 1;
    }
  }

  if (strStart != input.length) {
    output.push(input.slice(strStart))
  }

  return output;
}

function parseCType(type: string, structTypeMap: Map<string, Type>): Type {
  type = type.trim();

  // parse function
  if (type.endsWith(')')) {
    let fnReturn = splitLastParen(type);
    let returnType = fnReturn[0];
    let paramTypesStr = fnReturn[1];

    let retType = parseCType(returnType, structTypeMap);
    let params = splitComma(paramTypesStr);

    let paramTypes: Type[] = [];
    for (let paramTypeStr of params) {
      let paramType = parseCType(paramTypeStr, structTypeMap);
      paramTypes.push(paramType);
    }

    let linkedParams: boolean[] = [];
    for (let i = 0; i < paramTypes.length; i++) {
      linkedParams.push(false)
    }

    return {
      tag: 'fn',
      val: {
        returnType: retType,
        paramTypes,
        linkedParams
      }
    }
  }

  if (type.startsWith('const')) {
    return parseCType(type.slice(6), structTypeMap);
  }

  if (type.startsWith('struct')) {
    return parseCType(type.slice(7), structTypeMap);
  }

  if (type.endsWith('*')) {
    let innerType = parseCType(type.slice(0, type.length - 1), structTypeMap);
    return { tag: 'ptr', val: innerType };
  }

  if (type == 'int' || type == 'long') {
    return INT;
  }
  else if (type == 'double') {
    return NUM;
  }
  else if (type == 'char') {
    return CHAR;
  }
  else if (type == 'uint8_t') {
    return BYTE;
  }
  else if (type == 'void') {
    return VOID;
  }

  let thisStruct: Type | undefined = structTypeMap.get(type);
  if (thisStruct != undefined) {
    return thisStruct;
  }

  return VOID;
}
