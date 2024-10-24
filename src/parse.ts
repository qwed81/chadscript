import fs from 'node:fs';
import path from 'node:path';
import { logError, compilerError, NULL_POS, Position } from './util';

function parseDir(dirPath: string, parentModName: string | null): ProgramUnit[] | null {
  let modName;
  if (parentModName == null) {
    modName = '';
  } else {
    modName = parentModName + path.basename(dirPath) + '.';
  }

  let newProgramList: ProgramUnit[] = [];
  for (let p of fs.readdirSync(dirPath)) {
    let filePath = path.join(dirPath, p);
    if (fs.lstatSync(filePath).isDirectory()) {
      let progList = parseDir(filePath, modName);
      if (progList == null) {
        return null;
      }
      for (let p of progList) {
        newProgramList.push(p);
      }
    } else {
      if (p.endsWith('.chad') == false) {
        continue;
      }
      let fileName = modName + path.basename(p).slice(0, -5);
      let u = parseFile(filePath, fileName);
      if (u == null) {
        return null;
      }
      newProgramList.push(u);
    }
  }

  return newProgramList;
}

export {
  SourceLine, ProgramUnit, GenericType, FnType, Type, Fn, Var, Struct, CondBody,
  ForIn, Declare, Assign, FnCall, Inst, DotOp, LeftExpr, ArrOffset, StructInitField,
  BinExpr, Expr, parseDir, parseFile, FieldVisibility
}

interface SourceLine {
  position: Position
  indent: number
  tokens: Token[]
}

interface Token {
  position: Position
  val: string
}

interface Const {
  position: Position
  pub: boolean
  name: string
  type: Type
  expr: Expr
}

interface Use {
  unitName: string,
  as: string | null
}

interface ProgramUnit {
  fullName: string
  uses: Use[]
  fns: Fn[]
  consts: Const[]
  structs: Struct[]
  enums: Struct[]
}

interface GenericType {
  name: string
  generics: Type[]
}

interface FnType {
  returnType: Type
  paramTypes: Type[]
}

type Type = { tag: 'basic', val: string }
  | { tag: 'ptr', val: Type }
  | { tag: 'type_union', val0: Type, val1: Type }
  | { tag: 'generic', val: GenericType }
  | { tag: 'fn', val: FnType }
  | { tag: 'link', val: Type }

interface Fn {
  t: FnType
  paramNames: string[]
  defaultExprs: (Expr | null)[]
  pub: boolean
  name: string
  body: Inst[]
  position: Position
}

type FieldVisibility = 'pub' | 'get' | null 
interface Var {
  t: Type,
  name: string
  position: Position
  visibility: FieldVisibility
}

interface StructHeader {
  name: string,
  generics: string[]
  pub: boolean
}

interface Struct {
  header: StructHeader
  fields: Var[]
  position: Position
}

interface CondBody {
  cond: Expr,
  body: Inst[]
}

interface ForIn {
  varName: string
  iter: Expr
  body: Inst[]
}

interface Declare {
  t: Type,
  name: string,
  expr: Expr | null
}

interface Assign {
  op: string
  to: LeftExpr
  expr: Expr
}

interface FnCall {
  fn: LeftExpr
  exprs: Expr[]
  names: string[] // name will be '' in case of unamed expr
}

interface Macro {
  name: string
  body: string 
}

interface Include {
  lines: string[]
  types: Type[]
}

type Inst = { tag: 'if', val: CondBody, position: Position }
  | { tag: 'elif', val: CondBody, position: Position }
  | { tag: 'else', val: Inst[], position: Position }
  | { tag: 'while', val: CondBody, position: Position }
  | { tag: 'for_in', val: ForIn, position: Position }
  | { tag: 'break', position: Position }
  | { tag: 'continue', position: Position }
  | { tag: 'return_void', position: Position }
  | { tag: 'return', val: Expr, position: Position }
  | { tag: 'expr', val: Expr, position: Position }
  | { tag: 'declare', val: Declare, position: Position }
  | { tag: 'assign', val: Assign, position: Position }
  | { tag: 'macro', val: Macro, position: Position }
  | { tag: 'include', val: Include, position: Position }
  | { tag: 'arena', val: Inst[], position: Position }

interface DotOp {
  left: Expr,
  varName: string
}

interface ArrOffset {
  var: Expr,
  index: Expr
}

type LeftExpr = { tag: 'dot', val: DotOp }
  | { tag: 'prime', val: Expr }
  | { tag: 'arr_offset', val: ArrOffset }
  | { tag: 'var', val: string }

interface StructInitField {
  name: string
  expr: Expr
}

interface BinExpr {
  left: Expr
  right: Expr
  op: string
}

type Expr = { tag: 'bin', val: BinExpr, position: Position }
  | { tag: 'is', val: LeftExpr, right: Type, position: Position }
  | { tag: 'not', val: Expr, position: Position }
  | { tag: 'try', val: Expr, position: Position }
  | { tag: 'assert', val: Expr, position: Position }
  | { tag: 'fn_call', val: FnCall, position: Position }
  | { tag: 'struct_init', val: StructInitField[], position: Position }
  | { tag: 'list_init', val: Expr[], position: Position }
  | { tag: 'str_const', val: string, position: Position }
  | { tag: 'fmt_str', val: Expr[], position: Position }
  | { tag: 'char_const', val: string, position: Position }
  | { tag: 'int_const', val: number, position: Position }
  | { tag: 'nil_const', position: Position }
  | { tag: 'bool_const', val: boolean, position: Position }
  | { tag: 'num_const', val: number, position: Position }
  | { tag: 'left_expr', val: LeftExpr, position: Position }
  | { tag: 'cp', val: Expr, position: Position }
  | { tag: 'mv', val: Expr,  position: Position }

const MAPPING: [string, number][] = [
  [':', 0],
  ['||', 1],
  ['&&', 2], 
  ['|', 3],
  ['^', 4],
  ['&', 5],
  ['==', 6], ['!=', 6], ['<', 6], ['>', 6], ['>=', 6], ['<=', 6], ['is', 6],
  ['+',  7], ['-', 7],
  ['/', 8], ['%', 8], ['*', 8]
]; 

function positionRange(tokens: Token[]): Position {
  if (tokens.length == 0) {
    return NULL_POS;
  }
  return { ...tokens[0].position, end: tokens[tokens.length - 1].position.end, start: tokens[0].position.start };
}

function parseFile(filePath: string, progName: string): ProgramUnit | null {
  let unitText;
  try {
    unitText = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    console.error(err);
    return null;
  }
  
  return parse(unitText, progName);
}

// returns the program, null if invalid syntax, and logs all errors to the console
function parse(unitText: string, documentName: string): ProgramUnit | null {
  let lines = getLines(unitText, documentName);
  let program: ProgramUnit = { fullName: documentName, uses: [], fns: [], structs: [], consts: [], enums: [] };

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    if (line.indent == 0) {
      let body = getIndentedSegment(lines, i + 1, 1);

      // determine how to parse based on 'pub'
      let pub = true;
      let start = 0;
      let newLine = line;
      if (line.tokens[0].val == 'pri') {
        pub = false;
        newLine = { ...line, tokens: line.tokens.slice(1) };
        start = 1;
      }

      if (line.tokens[start].val == 'struct') {
        let struct = parseStruct(newLine, body, pub);
        if (struct == null) {
          return null;
        }
        program.structs.push(struct);
      } else if (line.tokens[start].val == 'enum') {
        let en = parseStruct(newLine, body, pub);
        if (en == null) {
          return null;
        }
        program.enums.push(en);
      } else if (line.tokens[start].val == 'use') {
        if (line.position.line != 1) {
          logError(line.position, 'uses must be at top of file');
          return null;
        }
        let uses = parseUses(line);
        if (uses == null) {
          return null;
        }
        program.uses = uses;
      } else if (line.tokens[start].val == 'fn') {
        let fn = parseFn(line, body);
        if (fn == null) {
          return null;
        }
        program.fns.push(fn);
      }
      else if (line.tokens[start].val == 'const') {
        let c = parseConst(line, pub);
        if (body.length != 0) {
          logError(line.position, 'unexpected body');
          return null;
        }

        if (c == null) {
          return null
        }
        program.consts.push(c);
      }
      else {
        logError(line.position, 'unexepected statement');
        return null;
      }
    }
  }

  return program;
}

function isAlphaNumeric(str: string): boolean {
  for (var i = 0, len = str.length; i < len; i++) {
      var code = str.charCodeAt(i);
      if (!(code > 47 && code < 58) && // numeric (0-9)
          !(code > 64 && code < 91) && // upper alpha (A-Z)
          !(code > 96 && code < 123)) { // lower alpha (a-z)
          return false;
      }
  }
  return true;
}

// returns the segment of lines, starting from the start index until there
// is a line with less indent than the bodyLevelIndent
function getIndentedSegment(
  lines: SourceLine[],
  startIndex: number,
  bodyLevelIndent: number
): SourceLine[] {
  let bodyLines = [];
  for (let i = startIndex; i < lines.length; i++) {
    let line = lines[i];
    if (line.indent < bodyLevelIndent) {
      break;
    }
    bodyLines.push(line);
  }

  return bodyLines;
}

// returns the index the first time the open character is
// balanced (equal open as closed) starting from the end. -1 if it does not occur
function getFirstBalanceIndexFromEnd(
  tokens: Token[],
  openToken: string,
  closeToken: string
): number {
  let balance = 0;
  for (let i = tokens.length - 1; i >= 0; i--) {
    if (tokens[i].val == openToken) {
      balance -= 1;
    }
    else if (tokens[i].val == closeToken) {
      balance += 1;
    }

    if (balance == 0 && tokens[i].val == openToken) {
      return i;
    }
  }

  return -1;
}

// returns the index the first time the close character is
// balanced (equal open as closed). -1 if it does not occur
function getFirstBalanceIndex(
  tokens: Token[],
  openToken: string,
  closeToken: string
): number {
  let balance = 0;
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].val == openToken) {
      balance -= 1;
    }
    else if (tokens[i].val == closeToken) {
      balance += 1;
    }

    if (balance == 0 && tokens[i].val == closeToken) {
      return i;
    }
  }

  return -1;
}

// returns two segments of tokens split by op, or the entire token stream
// as the first element of the array if the operator does not exist at the 
// current balance level
function balancedSplitTwo(tokens: Token[], op: string): Token[][] {
  let oParenCount = 0;
  let oSquareCount = 0;
  let oCurlyCount = 0;

  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].val == '(') {
      oParenCount += 1;
    } else if (tokens[i].val == ')') {
      oParenCount -= 1;
    } else if (tokens[i].val == '[') {
      oSquareCount += 1;
    } else if (tokens[i].val == ']') {
      oSquareCount -= 1;
    } else if (tokens[i].val == '{') {
      oCurlyCount += 1;
    } else if (tokens[i].val == '}') {
      oCurlyCount -= 1;
    }

    if (tokens[i].val == op && oParenCount == 0 && oSquareCount == 0 && oCurlyCount == 0) {
      return [tokens.slice(0, i), tokens.slice(i + 1)];
    }
  }

  return [tokens];
}

function balancedSplitTwoBackwards(tokens: Token[], op: string): Token[][] {
  let oParenCount = 0;
  let oSquareCount = 0;
  let oCurlyCount = 0;

  for (let i = tokens.length - 1; i >= 0; i--) {
    if (tokens[i].val == ')') {
      oParenCount += 1;
    } else if (tokens[i].val == '(') {
      oParenCount -= 1;
    } else if (tokens[i].val == ']') {
      oSquareCount += 1;
    } else if (tokens[i].val == '[') {
      oSquareCount -= 1;
    } else if (tokens[i].val == '}') {
      oCurlyCount += 1;
    } else if (tokens[i].val == '{') {
      oCurlyCount -= 1;
    }

    if (tokens[i].val == op && oParenCount == 0 && oSquareCount == 0 && oCurlyCount == 0) {
      return [tokens.slice(0, i), tokens.slice(i + 1)];
    }
  }

  return [tokens];
}

// returns an array of token arrays which are a balanced split of the operator
function balancedSplit(tokens: Token[], op: string): Token[][] {
  let oParenCount = 0;
  let oSquareCount = 0;
  let oCurlyCount = 0;

  let splits = [];
  let tokenStart = 0;
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].val == '(') {
      oParenCount += 1;
    }
    else if (tokens[i].val == ')') {
      oParenCount -= 1;
    }
    else if (tokens[i].val == '[') {
      oSquareCount += 1;
    }
    else if (tokens[i].val == ']') {
      oSquareCount -= 1;
    }
    else if (tokens[i].val == '{') {
      oCurlyCount += 1;
    }
    else if (tokens[i].val == '}') {
      oCurlyCount -= 1;
    }

    if (tokens[i].val == op && oParenCount == 0 && oSquareCount == 0 && oCurlyCount == 0) {
      if (tokenStart != i) {
        splits.push(tokens.slice(tokenStart, i));
      }
      tokenStart = i + 1;
    }
  }

  splits.push(tokens.slice(tokenStart));
  return splits;
}

function parseUses(header: SourceLine): Use[] | null {
  if (header.tokens[0].val != 'use') {
    return null;
  }

  let uses: Use[] = [];
  let splits: Token[][] = balancedSplit(header.tokens.slice(1), ',');
  for (let modName of splits) {
    if (modName.length < 1) {
      logError(header.position, 'unexpected token');
      return null;
    }

    let modNameStr = modName[0].val;
    if (modNameStr.length < 2 || modNameStr[0] != '"' || modNameStr[modNameStr.length - 1] != '"') {
      logError(header.position, 'expected module path');
      return null;
    }

    if (modName.length > 2) {
      if (modName[1].val != 'as') {
        logError(header.position, 'expected as');
        return null;
      }

      if (!isAlphaNumeric(modName[2].val)) {
        logError(header.position, 'expected valid module name');
        return null;
      }

      uses.push({
        unitName: modNameStr.slice(1, -1),
        as: modName[2].val
      });
    }
    else {
      uses.push({
        unitName: modNameStr.slice(1, -1),
        as: null
      });
    }
  }

  return uses;
} 

function parseConst(header: SourceLine, pub: boolean): Const | null {
  if (header.tokens.length < 4) {
    logError(header.position, 'constant and assignemnt');
    return null;
  }

  if (header.tokens[0].val != 'const') {
    compilerError('expected const');
    return null;
  }

  let splitEq: Token[][] = balancedSplitTwo(header.tokens, '=');
  if (splitEq.length != 2) {
    logError(header.position, 'expected expression');
    return null;
  }

  let leftLen = splitEq[0].length;
  let name: string = splitEq[0][leftLen - 1].val;
  let type: Type | null = tryParseType(splitEq[0].slice(1, leftLen - 1));
  if (type == null) {
    logError(header.position, 'expected type');
    return null;
  }

  let expr: Expr | null = tryParseExpr(splitEq[1], positionRange(splitEq[1]));
  if (expr == null) {
    logError(header.position, 'expected expression');
    return null;
  }

  return { position: header.position, pub, name, type, expr };
}

// returns the struct if it could valid parse from the header and the body, logs errors
function parseStruct(header: SourceLine, body: SourceLine[], pub: boolean): Struct | null {
  if (header.tokens.length < 2) {
    logError(header.position, 'expected struct name');
    return null;
  }

  let generics = [];
  if (header.tokens.length > 3 && header.tokens[2].val == '[' && header.tokens[header.tokens.length - 1].val == ']') {
    let genericTokens = balancedSplit(header.tokens.slice(3, -1), ',');
    for (let i = 0; i < genericTokens.length; i++) {
      if (genericTokens[i][0].val.length != 1 || genericTokens[i][0].val.length != 1) {
        logError(genericTokens[i][0].position, 'generics must be 1 letter long');
        return null;
      }

      let letter = genericTokens[i][0].val;
      if (letter > 'Z' || letter < 'A') {
        logError(genericTokens[i][0].position, 'generics must be captial letter');
        return null;
      }
      generics.push(letter);
    }
  }

  let structName: StructHeader = { name: header.tokens[1].val, generics, pub };
  let structFields: Var[] = [];
  for (let line of body) {
    let name = line.tokens[line.tokens.length - 1].val;
    let visibility: FieldVisibility = null;
    let typeTokens = line.tokens.slice(0, -1);
    if (line.tokens[0].val == 'get') {
      visibility = line.tokens[0].val;
      typeTokens = line.tokens.slice(1, -1);
    }
    else if (line.tokens[0].val == 'pri') {
      visibility = null;
      typeTokens = line.tokens.slice(1, -1);
    }
    else {
      visibility = 'pub';
    }

    let t = tryParseType(typeTokens);
    if (t == null) {
      logError(positionRange(typeTokens), 'field type not valid')
      return null;
    }
    structFields.push({ t, name, position: line.position, visibility });
  }

  return { header: structName, fields: structFields, position: header.position };
}

// returns the fn if it could valid parse from the header and the body, logs errors
function parseFn(header: SourceLine, body: SourceLine[]): Fn | null {
  let fnHeader = parseFnHeader(header);
  if (fnHeader == null) {
    return null;
  }

  let { paramNames, name, t, pub, defaultExprs } = fnHeader;
  let fnBody = parseInstBody(body);
  if (fnBody == null) {
    return null;
  }

  return {
    name,
    paramNames,
    t,
    pub,
    body: fnBody,
    position: header.position,
    defaultExprs 
  };
}

function tryParseType(tokens: Token[]): Type | null {
  if (tokens.length == 0) {
    return null;
  }

  if (tokens[0].val == '&') {
    let inner = tryParseType(tokens.slice(1));
    if (inner == null) {
      return null;
    }
    return { tag: 'link', val: inner };
  }

  if (tokens[0].val == '*') {
    let inner = tryParseType(tokens.slice(1));
    if (inner == null) {
      return null;
    }
    return { tag: 'ptr', val: inner };
  }
  
  // parse it as a type union
  if (tokens.length >= 3) {
    let splits = balancedSplitTwo(tokens, '|');
    if (splits.length > 1) {
      let first = tryParseType(splits[0]);
      let second = tryParseType(splits[1]);
      if (first != null && second != null) {
        return { tag: 'type_union', val0: first, val1: second }
      }
    }
  }

  let lastToken = tokens[tokens.length - 1].val; 
  if (lastToken == '!' || lastToken == '?' || lastToken == '*') {
    let innerType = tryParseType(tokens.slice(0, -1));
    if (innerType == null) {
      return null;
    }
    if (lastToken == '!') {
      return { tag: 'generic', val: { name: 'res', generics: [innerType] } };
    }
    else if (lastToken == '?') {
      return { tag: 'generic', val: { name: 'opt', generics: [innerType] } };
    } 
    return null;
  }
  else if (lastToken == ')') { // parse fn
    let fnParamBegin = getFirstBalanceIndexFromEnd(tokens, '(', ')') + 1;

    if (fnParamBegin == 0) {
      return null;
    }

    let returnType = tryParseType(tokens.slice(0, fnParamBegin - 1));
    if (returnType == null) {
      return null;
    }

    let paramsStr = tokens.slice(fnParamBegin, -1);
    let splits = balancedSplit(paramsStr, ',');
    let paramTypes = [];
    if (splits[0].length > 0) {
      for (let split of splits) {
        let paramType = tryParseType(split);
        if (paramType == null) {
          return null;
        }
        paramTypes.push(paramType);
      }
    }
    return { tag: 'fn', val: { returnType, paramTypes } };
  } else if (tokens[tokens.length - 1].val == ']') { // parse generic or array
    let openIndex = getFirstBalanceIndexFromEnd(tokens, '[', ']');
    if (openIndex == -1) {
      return null;
    }

    let inner = tokens.slice(openIndex + 1, -1);

    // parse it as a generic
    let splits = balancedSplit(inner, ',');

    let generics: Type[] = [];
    for (let split of splits) {
      let parseType = tryParseType(split);
      if (parseType == null) {
        return null;
      }
      generics.push(parseType);
    }

    return { tag: 'generic', val: { name: tokens[0].val, generics } };
  }

  if (tokens.length != 1) {
    return null;
  }
  return { tag: 'basic', val: tokens[0].val };
}

function parseFnHeader(
  header: SourceLine
): {
  name: string,
  paramNames: string[],
  defaultExprs: (Expr | null)[]
  t: FnType 
  pub: boolean
} | null 
{
  let tokens = header.tokens;
  if (tokens.length == 0) {
    return null;
  }

  let pub: boolean = true;
  if (tokens[0].val == 'pri') {
    pub = false;
  }

  if (tokens[0].val != 'fn' && tokens[1].val != 'fn') {
    logError(header.position, 'fn keyword required');
    return null;
  }

  let paramStart = tokens.map(x => x.val).indexOf('(');
  if (paramStart == -1) {
    return null;
  }

  let name: string = tokens[paramStart - 1].val;

  let paramEnd = getFirstBalanceIndex(tokens.slice(paramStart), '(', ')');
  if (paramEnd == -1) {
    return null;
  }
  paramEnd = paramEnd + paramStart;

  let innerTokens = tokens.slice(paramStart + 1, paramEnd);
  let paramSplits = balancedSplit(innerTokens, ',');
  let paramTypes: Type[] = [];
  let paramNames: string[] = [];
  let defaultExprs: (Expr | null)[] = [];

  if (paramSplits[0].length > 0) { // for () functions
    for (let param of paramSplits) {
      let exprNameSplit: Token[][] = balancedSplitTwo(param, '=');
      let initExpr: Expr | null = null;
      if (exprNameSplit.length > 1) {
        initExpr = tryParseExpr(exprNameSplit[1], positionRange(exprNameSplit[1]));
        if (initExpr == null) {
          logError(header.position, 'expected expr');
          return null;
        }
      }
      param = exprNameSplit[0];

      let typeTokens = param.slice(0, -1);
      let t = tryParseType(typeTokens);
      if (t == null) {
        logError(positionRange(typeTokens), 'could not parse parameter\'s type');
        return null;
      }

      let paramName = param[param.length - 1].val;
      paramNames.push(paramName);
      paramTypes.push(t);
      defaultExprs.push(initExpr);
    }
  }

  let returnTokens = tokens.slice(paramEnd + 1);
  let returnType: Type | null = { tag: 'basic', val: 'void' };
  if (returnTokens.length != 0) {
    let possibleReturn: Type | null = null;
    // attempt to parse as named return
    if (returnTokens.length > 1) {
      let lastToken = returnTokens[returnTokens.length - 1];
      if (isAlphaNumeric(lastToken.val)) {
        let t = tryParseType(returnTokens.slice(0, -1));
        if (t != null) {
          possibleReturn = t;
        }
      }
    }

    if (possibleReturn == null) {
      possibleReturn = tryParseType(returnTokens);
    }

    returnType = possibleReturn;
  }
  if (returnType == null) {
    logError(header.position, 'could not parse return type');
    return null;
  }

  return {
    name,
    paramNames,
    pub,
    t: { returnType, paramTypes },
    defaultExprs
  };
}

function parseInstBody(lines: SourceLine[]): Inst[] | null {
  if (lines.length == 0) {
    return [];
  }

  let indent = lines[0].indent;
  let insts = [];
  let invalidInstruction = false;
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    if (line.indent != indent) {
      continue;
    }
    let body = getIndentedSegment(lines, i + 1, line.indent + 1);
    let inst = parseInst(line, body);
    if (inst == null) {
      invalidInstruction = true;
      logError(lines[i].position, "could not parse");
      continue;
    }

    insts.push(inst);
  }

  if (invalidInstruction) {
    return null;
  } else {
    return insts;
  }
}

function tryParseFnCall(tokens: Token[]): FnCall | null {
  if (tokens.length < 3 || tokens[tokens.length - 1].val != ')') {
    return null;
  }

  let paramStart = getFirstBalanceIndexFromEnd(tokens, '(', ')');
  let leftExprTokens = tokens.slice(0, paramStart);
  let leftExpr = tryParseLeftExpr(leftExprTokens, positionRange(leftExprTokens));
  if (leftExpr == null) {
    return null;
  }

  let paramExprs = balancedSplit(tokens.slice(paramStart + 1, -1), ',');
  let exprs = [];
  let names: string[] = [];
  if (tokens.length - paramStart != 2) {
    for (let param of paramExprs) {
      // for implicit params
      let splitParam: Token[][] = balancedSplitTwo(param, '=');
      if (splitParam.length == 1) {
        let expr = tryParseExpr(splitParam[0], positionRange(splitParam[0]));
        if (expr == null) {
          return null;
        }
        names.push('');
        exprs.push(expr);
      }
      else {
        let expr = tryParseExpr(splitParam[1], positionRange(splitParam[0]));
        if (expr == null) {
          return null;
        }
        if (splitParam[0].length != 1) {
          return null;
        }

        names.push(splitParam[0][0].val);
        exprs.push(expr);
      }
    }
  }

  return { fn: leftExpr, exprs, names };
}

function parseInst(line: SourceLine, body: SourceLine[]): Inst | null {
  let keyword: string = line.tokens[0].val;
  let tokens = line.tokens;
  if (keyword == 'if') {
    let exprTokens = tokens.slice(1);
    let cond = tryParseExpr(exprTokens, positionRange(exprTokens));
    if (cond == null) {
      logError(line.position, 'expected expression');
      return null;
    }
    let b = parseInstBody(body);
    if (b == null) {
      return null;
    }
    return { tag: 'if', val: { cond, body: b }, position: line.position };
  } 
  else if (keyword == 'arena') {
    if (tokens.length != 1) {
      logError(line.position, 'unexpected tokens');
      return null;
    }

    let b = parseInstBody(body);
    if (b == null) {
      return null;
    }
    return { tag: 'arena', val: b, position: line.position };
  }
  else if (line.tokens[0].val == '@') {
    if (tokens.length != 2) {
      logError(line.position, 'invalid macro');
      return null;
    }
    let name = tokens.slice(1)[0].val;

    let output = '';
    for (let i = 0; i < body.length; i++) {
      for (let j = 0; j < body[i].tokens.length; j++) {
        output += body[i].tokens[j] + ' ';
      }
      output += '\n';
    }

    return { tag: 'macro', val: { name, body: output }, position: line.position };
  }
  else if(keyword == 'include') {
    let lines: string[] = [];
    let types: Type[] = [];
    for (let line of body) {
      let result: string | null = parseIncludeLine(line.tokens[0].val, line.position, types);
      if (result == null) {
        logError(line.position, 'could not parse line');
        return null;
      }
      lines.push(result);
    }
    return { tag: 'include', val: { lines, types }, position: line.position };
  }
  else if (keyword == 'elif') {
    let exprTokens = tokens.slice(1);
    let cond = tryParseExpr(exprTokens, positionRange(exprTokens));
    if (cond == null) {
      logError(line.position, 'expected expression');
      return null;
    }
    let b = parseInstBody(body);
    if (b == null) {
      return null;
    }
    return { tag: 'elif', val: { cond, body: b }, position: line.position };
  } else if (keyword == 'else') {
    if (tokens.length != 1) {
      logError(line.position, 'unexpected token after \'else\'');
      return null;
    }

    let b = parseInstBody(body);
    if (b == null) {
      return null;
    }
    return { tag: 'else', val: b, position: line.position }
  } 
  else if (keyword == 'while') {
    let exprTokens = tokens.slice(1);
    let cond = tryParseExpr(exprTokens, positionRange(exprTokens));
    if (cond == null) {
      logError(line.position, 'expected expression');
      return null;
    }

    let b = parseInstBody(body);
    if (b == null) {
      return b;
    }
    return { tag: 'while', val: { cond, body: b }, position: line.position };
  } 
  else if (keyword == 'for') {
    if (tokens.length < 4 || tokens[2].val != 'in') {
      logError(line.position, 'expected for <var> in <iter>');
      return null;
    }

    let varName = tokens[1].val;
    let exprTokens = tokens.slice(3);
    let expr = tryParseExpr(exprTokens, positionRange(exprTokens));
    if (expr == null) {
      return null;
    }

    let b = parseInstBody(body);
    if (b == null) {
      return b;
    }
    return { tag: 'for_in', val: { varName, iter: expr, body: b }, position: line.position };
  } 
  else if (keyword == 'break') {
    return { tag: 'break', position: line.position };
  }
  else if (keyword == 'continue') {
    return { tag: 'continue', position: line.position }
  }
  else if (keyword == 'return') {
    if (tokens.length == 1) {
      return { tag: 'return_void', position: line.position };
    }

    let exprTokens = tokens.slice(1);
    let expr = tryParseExpr(exprTokens, positionRange(exprTokens));
    if (expr == null) {
      logError(line.position, 'expected expression');
      return null;
    }
    return { tag: 'return', val: expr, position: line.position  };
  } 

  let expression = tryParseExpr(tokens, line.position);
  if (expression != null) {
    return { tag: 'expr', val: expression, position: line.position };
  }

  if (!tokens.find(x => x.val == '=') && !tokens.find(x => x.val == '+=') && !tokens.find(x => x.val == '-=')) {
    let type = tryParseType(tokens.slice(0, -1));
    let name = tokens[tokens.length - 1].val;
    if (tokens.length > 1 && type != null) {
      return { tag: 'declare', val: { t: type, name, expr: null }, position: line.position };
    }
    return null;
  }

  let assignOp: string = '='; 
  if (tokens.find(x => x.val == '+=')) {
    assignOp = '+=';
  } else if (tokens.find(x => x.val == '-=')) {
    assignOp = '-=';
  }

  let splits = balancedSplitTwo(tokens, assignOp);
  if (splits.length != 2) {
    logError(line.position, 'unexpected statement');
    return null;
  }

  let expr = tryParseExpr(splits[1], positionRange(splits[1]));
  if (expr == null) {
    logError(line.position, 'expected expression')
    return null;
  }

  let left = splits[0];
  // try parse assign
  let leftExpr = tryParseLeftExpr(left, line.position);
  if (leftExpr != null) {
    return { tag: 'assign', val: { to: leftExpr, expr, op: assignOp }, position: line.position };
  }

  // parse declare
  let type = tryParseType(left.slice(0, -1));
  let name: string = left[left.length - 1].val;
  if (left.length >= 2 && type != null) {
    return { tag: 'declare', val: { t: type, name, expr }, position: line.position }
  }

  return null;
}

function tryParseArrInit(tokens: Token[], position: Position): Expr | null {
  if (tokens.length < 2 || tokens[0].val != '[' || tokens[tokens.length - 1].val != ']') {
    return null;
  } 

  let splits = balancedSplit(tokens.slice(1, -1), ',');
  if (splits.length == 1 && splits[0].length == 0) {
    return { tag: 'list_init', val: [], position };
  }

  let exprs: Expr[] = [];
  for (let split of splits) {
    let expr = tryParseExpr(split, positionRange(split));
    if (expr == null) {
      return null;
    }
    exprs.push(expr);
  }

  return { tag: 'list_init', val: exprs, position };
}

function tryParseStructInit(tokens: Token[], position: Position): Expr | null {
  if (tokens.length < 2 || tokens[0].val != '{' || tokens[tokens.length - 1].val != '}') {
    return null;
  }

  let props: StructInitField[] = [];
  let splits = balancedSplit(tokens.slice(1, -1), ',');
  if (splits[0].length != 0) {
    for (let split of splits) {
      if (split.length < 3) {
        return null;
      }

      let newSplits = balancedSplit(split, '=');
      if (newSplits.length != 2) {
        return null;
      }

      if (newSplits[0].length != 1) {
        return null;
      }

      let initExpr = tryParseExpr(newSplits[1], positionRange(newSplits[1]));
      if (initExpr == null) {
        return null;
      }

      props.push({ name: newSplits[0][0].val, expr: initExpr });
    }
  }

  return { tag: 'struct_init', val: props, position };
}

function tryParseDotOp(tokens: Token[]): LeftExpr | null {
  let splits = balancedSplitTwoBackwards(tokens, '.');
  if (splits.length != 2) {
    return null;
  }

  let left = tryParseExpr(splits[0], positionRange(splits[0]));
  if (left == null) {
    return null;
  }

  if (splits[1].length != 1) {
    return null;
  }

  return { tag: 'dot', val: { left, varName: splits[1][0].val } };
}

function tryParseArrExpr(tokens: Token[]): LeftExpr | null {
  if (tokens[tokens.length - 1].val != ']') {
    return null;
  }

  let balanceIndex = getFirstBalanceIndexFromEnd(tokens, '[', ']');
  if (balanceIndex == -1) {
    return null;
  }

  let innerTokens = tokens.slice(balanceIndex + 1, -1);
  if (innerTokens.length == 0) {
    return null;
  }
  let innerExpr = tryParseExpr(innerTokens, positionRange(innerTokens));
  if (innerExpr == null) {
    return null;
  }

  let exprTokens = tokens.slice(0, balanceIndex);
  let expr = tryParseExpr(exprTokens, positionRange(exprTokens));
  if (innerExpr == null || expr == null) {
    return null;
  }

  return { tag: 'arr_offset', val: { var: expr, index: innerExpr }};
}

function tryParseLeftExpr(tokens: Token[], position: Position): LeftExpr | null {
  if (tokens.length == 1) {
    return { tag: 'var', val: tokens[0].val };
  }

  let dot = tryParseDotOp(tokens);
  if (dot != null) {
    return dot;
  }

  if (tokens[tokens.length - 1].val == '\'') {
    let parsed = tryParseExpr(tokens.slice(0, -1), { ...position, end: position.end - 1 });
    if (parsed == null) {
      return null;
    }
    return { tag: 'prime', val: parsed };
  }

  return tryParseArrExpr(tokens);
}

function tryParseExpr(tokens: Token[], position: Position): Expr | null {
  if (tokens.length == 0) {
    return null;
  }

  if (tokens[0].val == 'try' || tokens[0].val == 'assert' || tokens[0].val == 'cp' || tokens[0].val == 'mv') {
    let parsed = tryParseExpr(tokens.slice(1), { ...position, start: position.start + 1 });
    if (parsed == null) {
      return null;
    }

    if (tokens[0].val == 'try') {
      return { tag: 'try', val: parsed, position };
    }
    else if (tokens[0].val == 'cp') {
      return { tag: 'cp', val: parsed, position };
    }
    else if (tokens[0].val == 'mv') {
      return { tag: 'mv', val: parsed, position };
    }
    else {
      return { tag: 'assert', val: parsed, position };
    }
  }

  // parse all bin expr
  for (let i = 0; i < 9; i++) {
    for (let props of MAPPING) {
      if (props[1] != i) {
        continue;
      }

      let binOp = tryParseBinOp(tokens, props[0], position);
      if (binOp != null) {
        return binOp;
      }
    }
  }

  if (tokens.length >= 2 && tokens[0].val == '(' && tokens[tokens.length - 1].val == ')') {
    return tryParseExpr(tokens.slice(1, -1), { ...position, start: position.start + 1, end: position.end + 1 });
  }

  // parse not
  if (tokens.length >= 2 && tokens[0].val == '!') {
    let expr = tryParseExpr(tokens.slice(1), { ...position, start: position.start + 1 });
    if (expr == null) {
      return null;
    }
    return { tag: 'not', val: expr, position };
  }

  let fnCall = tryParseFnCall(tokens);
  if (fnCall != null) {
    return { tag: 'fn_call', val: fnCall, position };
  }

  let arrInit = tryParseArrInit(tokens, position);
  if (arrInit != null) {
    return arrInit;
  } 

  let structInit = tryParseStructInit(tokens, position);
  if (structInit != null) {
    return structInit;
  }

  if (tokens.length == 3 && tokens.find(x => x.val == '.')) {
    if (tokens[0].val[0] >= '0' && tokens[0].val[0] <= '9' && tokens[1].val == '.'
      && tokens[2].val[0] >= '0' && tokens[2].val[0] <= '9') {

      let num;
      num = parseFloat(`${tokens[0].val}.${tokens[2].val}`) 
      if (Number.isNaN(num)) {
        logError(positionRange(tokens), 'could not parse number');
        return null;
      }
      return { tag: 'num_const', val: num, position };
    }
  }

  if (tokens.length == 1) {
    let ident = tokens[0].val;
    if (ident == 'true') {
      return { tag: 'bool_const', val: true, position };
    } else if (ident == 'false') {
      return { tag: 'bool_const', val: false, position };
    }
    else if (ident == 'nil') {
      return { tag: 'nil_const', position };
    }

    if (ident.length >= 2 && ident[0] == '"' && ident[ident.length - 1] == '"') {
      let str = ident.slice(1, -1);
      let parsed: Expr[] | null = tryParseFmtString(str, position);
      if (parsed == null) {
        return null;
      }

      if (parsed.length == 1) {
        return parsed[0];
      } else {
        return { tag: 'fmt_str', val: parsed, position };
      }
    }

    if (ident.length >= 2 && ident[0] == '\'' && ident[ident.length - 1] == '\'') {
      return { tag: 'char_const', val: ident.slice(1, -1), position };
    }

    if (ident.length >= 1 && ident[0] >= '0' && ident[0] <= '9'
      || ident.length >= 2 && ident[0] == '-' && ident[1] >= '0' && ident[1] <= '9') {

      let int;
      try {
        int = parseInt(ident);
      } catch (e) {
        return null;
      }
      return { tag: 'int_const', val: int, position };
    }
  }

  let leftExpr = tryParseLeftExpr(tokens, position);
  if (leftExpr != null) {
    return { tag: 'left_expr', val: leftExpr, position };
  }

  return null;
}

function tryParseFmtString(lineExpr: string, position: Position): Expr[] | null {
  let exprs: Expr[] = [];
  let constStrStart = 0;
  for (let i = 0; i < lineExpr.length; i++) {
    if (lineExpr[i] == '{') {
      let constStr = lineExpr.slice(constStrStart, i);
      exprs.push({ tag: 'str_const', val: constStr, position });

      let exprStart = i + 1;
      let openCount = 0;
      while (i < lineExpr.length && (lineExpr[i] != '}' || openCount > 1)) {
        if (lineExpr[i] == '{') {
          openCount += 1;
        } else if (lineExpr[i] == '}'){
          openCount -= 1;
        }
        i += 1;
      }

      let exprStr = lineExpr.slice(exprStart, i);
      let tokens = splitTokens(exprStr, position.document, position.line);
      let expr = tryParseExpr(tokens, { ...position, start: exprStart, end: i });
      if (expr == null) {
        return null;
      }
      exprs.push(expr);
      constStrStart = i + 1;
    }
  }

  let constStr = lineExpr.slice(constStrStart);
  exprs.push({ tag: 'str_const', val: constStr, position });
  return exprs;
}

function tryParseBinOp(tokens: Token[], op: string, position: Position): Expr | null {
  let splits = balancedSplitTwoBackwards(tokens, op);
  if (splits.length == 1) {
    return null;
  }

  if (op == 'is') {
    let left = tryParseLeftExpr(splits[0], positionRange(splits[0]));
    if (left == null) {
      return null;
    }
    let right = tryParseType(splits[1]);
    if (right == null) {
      return null;
    }

    return { tag: 'is', val: left, right, position };
  }

  let left = tryParseExpr(splits[0], positionRange(splits[0]));
  if (left == null) {
    return null;
  }

  let right = tryParseExpr(splits[1], positionRange(splits[1]));
  if (right == null) {
    return null;
  }

  return { tag: 'bin', val: { op, left, right }, position};
}

function parseIncludeLine(
  line: string,
  position: Position,
  types: Type[]
): string | null {
  let outLine: string = '';
  while (true) {
    let nextIndex = line.indexOf('$(');
    if (nextIndex == -1) {
      break;
    }

    outLine += line.substring(0, nextIndex);

    let nextSegment = nextIndex + 2;
    let openCount = 1;
    while (openCount > 0 && nextSegment < line.length) {
      if (line[nextSegment] == '(') {
        openCount += 1;
      }
      else if (line[nextSegment] == ')') {
        openCount -= 1;
      }
      nextSegment += 1;
    }

    let typeStr = line.slice(nextIndex + 2, nextSegment - 1);
    let typeTokens = splitTokens(typeStr, position.document, position.line);
    let type = tryParseType(typeTokens);
    if (type == null) {
      logError(position, 'could not parse type');
      return null;
    }
    types.push(type);

    outLine += '$';
    line = line.substring(nextSegment);
  }

  outLine += line;

  return outLine;
}

function splitTokens(line: string, documentName: string, lineNumber: number): Token[] {
  // split tokens based on special characters
  let tokens: Token[] = [];
  let tokenStart = 0;
  const splitTokens = [' ', '=', '.', ',', '(', ')', '[', ']', '{', '}', '&', '*', '!', '?', '@', ':', '^', '|'];
  for (let i = 0; i < line.length; i++) {
    // process string as a single token
    if (line[i] == '"') {
      let possibleSlice = line.slice(tokenStart, i);
      if (possibleSlice.length != 0) {
        tokens.push({ val: possibleSlice, position: { document: documentName, line: lineNumber, start: tokenStart, end: i } });
      }
      tokenStart = i + 1;
      i += 1;

      let openCount = 0;
      while (i < line.length && !(line[i] == '"' && openCount == 0)) {
        if (line[i] == '\\') {
          i += 2;
          continue;
        }
        if (line[i] == '{') {
          openCount += 1;
        }
        else if (line[i] == '}') {
          openCount -= 1;
        }
        i += 1;
      }

      tokens.push({ val: '"' + line.slice(tokenStart, i) + '"', position: { document: documentName, line: lineNumber, start: tokenStart, end: i } });
      tokenStart = i + 1;
    }

    // process chars as a single token
    if (line[i] == '\'' && (line[i - 1] == ' ' || line[i - 1] == '(' || line[i - 1] == '[')) {
      let possibleSlice = line.slice(tokenStart, i);
      if (possibleSlice.length != 0) {
        tokens.push({ val: possibleSlice, position: { document: documentName, line: lineNumber, start: tokenStart, end: i } });
      }
      tokenStart = i + 1;
      i += 1;
      while (i < line.length && line[i] != '\'') {
        if (line[i] == '\\') {
          i += 1;
        }
        i += 1;
      }
      tokens.push({ val: '\'' + line.slice(tokenStart, i) + '\'', position: { document: documentName, line: lineNumber, start: tokenStart, end: i } });
      tokenStart = i + 1;
    } else if (line[i] == '\''){
      let possibleSlice = line.slice(tokenStart, i);
      if (possibleSlice.length != 0) {
        tokens.push({ val: possibleSlice, position: { document: documentName, line: lineNumber, start: tokenStart, end: i } });
      }

      tokens.push({ val: '\'', position: { document: documentName, line: lineNumber, start: i, end: i + 1 } });
      tokenStart = i + 1;
    }

    if (splitTokens.includes(line[i])) {
      let possibleSlice = line.slice(tokenStart, i);
      // protects against double space and spaces trailing other splits
      if (possibleSlice.length != 0) {
        tokens.push({ val: possibleSlice, position: { document: documentName, line: lineNumber, start: tokenStart, end: i } });
      }
      tokenStart = i + 1;

      if (line[i] != ' ') {
        tokens.push({ val: line[i], position: { document: documentName, line: lineNumber, start: tokenStart, end: i } });
      }
    }
  }

  // push the last token if it does not follow a split token
  if (!splitTokens.includes(line[line.length - 1]) && line[line.length - 1] != '"' && line[line.length - 1] != '\'') {
    let token = line.slice(tokenStart, line.length);
    tokens.push({ val: token, position: { document: documentName, line: lineNumber, start: tokenStart, end: line.length } });
  }

  // combine the tokens that should not have been split
  for (let i = tokens.length - 1; i >= 1; i--) {
    if (tokens[i - 1].val == '!' && tokens[i].val == '=') {
      tokens.splice(i, 1);
      tokens[i - 1].val = '!=';
    }
    else if (tokens[i].val == '=' && (tokens[i - 1].val == '>' || tokens[i - 1].val == '<'
      || tokens[i - 1].val == '+' || tokens[i - 1].val == '-' || tokens[i - 1].val == '=')) {
      tokens[i - 1].val = tokens[i - 1].val + tokens[i].val;
      tokens.splice(i, 1);
    }
    else if (tokens[i - 1].val == '&' && tokens[i].val == '&') {
      tokens.splice(i, 1);
      tokens[i - 1].val = '&&';
      tokens[i - 1].position.end += 1;
    }
    else if (tokens[i - 1].val == '|' && tokens[i].val == '|') {
      tokens.splice(i, 1);
      tokens[i - 1].val = '||';
      tokens[i - 1].position.end += 1;
    }
  }

  return tokens;
}

function getLines(data: string, documentName: string): SourceLine[] {
  let lines = data.split('\n');
  let sourceLines: SourceLine[] = [];

  // the last line can be merged if the parens are not closed
  let merge: Token[] = [];

  // split lines based on spaces
  for (let lineNumber = 0; lineNumber < lines.length; lineNumber++) {
    let line = lines[lineNumber];
    let lineLength = line.length;

    if (line.startsWith('##')) {
      lineNumber++;
      while (!lines[lineNumber].startsWith('##') && lineNumber < lines.length) {
        lineNumber++;
      }
    }

    line = line.split('#')[0]; // ignore comments
    let indent = 0;
    for (let i = 0; i < line.length; i++) {
      if (line[i] != ' ') {
        break;
      }
      indent += 0.5;
    }

    line = line.trim();
    let linePosition: Position = { document: documentName, line: lineNumber + 1, start: indent * 2, end: lineLength };
    if (indent != Math.floor(indent)) {
      logError(linePosition, 'invalid tab amount ' + indent);
      continue;
    }

    if (line.trim().length == 0) {
      continue;
    }

    // parse the include block without processing tokens
    if (line == 'include') {
      let blockLineNumber = lineNumber + 1;
      let startingIndent = indent;
      sourceLines.push({ tokens: [{ val: line, position: linePosition }], indent, position: linePosition });
      for (; blockLineNumber < lines.length; blockLineNumber++) {
        let line = lines[blockLineNumber];
        if (line.trim() == '') {
          continue;
        }

        let indent = 0;
        for (let i = 0; i < line.length; i++) {
          if (line[i] != ' ') {
            break;
          }
          indent += 0.5;
        }

        if (indent != Math.floor(indent)) {
          logError(linePosition, 'invalid tab amount ' + indent);
          continue;
        }

        if (indent <= startingIndent) {
          if (blockLineNumber > lineNumber + 1) { // guard against include without body
            lineNumber = blockLineNumber - 1; // don't skip this line
          }
          break;
        }

        sourceLines.push({ tokens: [{ val: line, position: linePosition }], indent: startingIndent + 1, position: linePosition });
      }

      lineNumber = blockLineNumber - 1;
      continue;
    }

    let tokens: Token[] = splitTokens(line, documentName, lineNumber + 1);
    merge.push(...tokens)
    if (!bracketIsOpen(merge)) {
      sourceLines.push({ indent, tokens: merge, position: linePosition });
      merge = [];
    }
  }

  return sourceLines;
}

function bracketIsOpen(tokens: Token[]): boolean {
  let parenOpen = 0;
  let squareOpen = 0;
  let curlyOpen = 0;

  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].val == '(') {
      parenOpen += 1;
    }
    else if (tokens[i].val == ')') {
      parenOpen -= 1;
    }
    else if (tokens[i].val == '[') {
      squareOpen += 1;
    }
    else if (tokens[i].val == ']') {
      squareOpen -= 1;
    }
    else if (tokens[i].val == '{') {
      curlyOpen += 1;
    }
    else if (tokens[i].val == '}') {
      curlyOpen -= 1;
    }
  }

  return parenOpen != 0 || squareOpen != 0 || curlyOpen != 0;
}

