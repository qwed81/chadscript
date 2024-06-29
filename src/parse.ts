import fs from 'node:fs';
import path from 'node:path';
import { logError } from './index';

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
  SourceLine, ProgramUnit, GenericType, FnType, Type, Fn, Var, Struct, InstMeta, CondBody,
  ForIn, Declare, Assign, MatchBranch, Match, FnCall, Inst, DotOp, LeftExpr, ArrOffset, StructInitField,
  BinExpr, Expr, parseDir
}

interface SourceLine {
  sourceLine: number
  indent: number
  tokens: string[]
}

interface ProgramUnit {
  fullName: string
  uses: string[]
  fns: Fn[]
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
  | { tag: 'arr', val: Type }
  | { tag: 'const_arr', val: Type }
  | { tag: 'generic', val: GenericType }
  | { tag: 'fn', val: FnType }
  | { tag: 'link', val: Type }

interface Fn {
  t: FnType
  paramNames: string[]
  name: string
  body: InstMeta[]
  sourceLine: number
}

interface Var {
  t: Type,
  name: string
  sourceLine: number
}

interface StructHeader {
  name: string,
  generics: string[]
}

interface Struct {
  header: StructHeader
  fields: Var[]
  sourceLine: number
}

interface InstMeta {
  inst: Inst,
  sourceLine: number
}

interface CondBody {
  cond: Expr,
  body: InstMeta[]
}

interface ForIn {
  varName: string
  iter: Expr
  body: InstMeta[]
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

interface MatchBranch {
  enumVariant: string
  body: InstMeta[]
  sourceLine: number
}

interface Match {
  var: Expr
  branches: MatchBranch[]
}

interface FnCall {
  fn: LeftExpr
  exprs: Expr[]
}

interface Macro {
  name: string
  body: string 
}

interface Include {
  lines: string[]
  types: Type[]
}

type Inst = { tag: 'if', val: CondBody }
  | { tag: 'elif', val: CondBody }
  | { tag: 'else', val: InstMeta[] }
  | { tag: 'while', val: CondBody }
  | { tag: 'for_in', val: ForIn }
  | { tag: 'break' }
  | { tag: 'continue' }
  | { tag: 'return_void' }
  | { tag: 'return', val: Expr }
  | { tag: 'match', val: Match }
  | { tag: 'expr', val: Expr }
  | { tag: 'declare', val: Declare }
  | { tag: 'assign', val: Assign }
  | { tag: 'macro', val: Macro }
  | { tag: 'include', val: Include }

interface DotOp {
  left: Expr,
  varName: string
}

interface ArrOffset {
  var: LeftExpr,
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

type Expr = { tag: 'bin', val: BinExpr }
  | { tag: 'not', val: Expr }
  | { tag: 'try', val: Expr }
  | { tag: 'assert', val: Expr }
  | { tag: 'fn_call', val: FnCall }
  | { tag: 'struct_init', val: StructInitField[] }
  | { tag: 'arr_init', val: Expr[] }
  | { tag: 'str_const', val: string }
  | { tag: 'fmt_str', val: Expr[] }
  | { tag: 'char_const', val: string }
  | { tag: 'int_const', val: number }
  | { tag: 'bool_const', val: boolean }
  | { tag: 'num_const', val: number }
  | { tag: 'left_expr', val: LeftExpr }

const MAPPING: [string, number][] = [
  [':', 0],
  ['+',  4], ['-', 4], ['*', 5], ['&&', 2], ['||', 1],
  ['/', 5], ['%', 5], ['==', 3], ['!=', 3], ['<', 3],
  ['>', 3], ['>=', 3], ['<=', 3], ['is', 3]
]; 

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
function parse(unitText: string, progName: string): ProgramUnit | null {
  let lines = getLines(unitText);
  let program: ProgramUnit = { fullName: progName, uses: [], fns: [], structs: [], enums: [] };

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    if (line.indent == 0) {
      let body = getIndentedSegment(lines, i + 1, 1);
      if (line.tokens[0] == 'struct') {
        let struct = parseStruct(line, body);
        if (struct == null) {
          return null;
        }
        program.structs.push(struct);
      } else if (line.tokens[0] == 'enum') {
        let en = parseStruct(line, body);
        if (en == null) {
          return null;
        }
        program.enums.push(en);
      } else if (line.tokens[0] == 'use') {
        if (line.sourceLine != 0) {
          logError(line.sourceLine, 'uses must be at top of file');
          return null;
        }
        let uses = parseUses(line);
        if (uses == null) {
          return null;
        }
        program.uses = uses;
      } else {
        let fn = parseFn(line, body);
        if (fn == null) {
          return null;
        }
        program.fns.push(fn);
        
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
  tokens: string[],
  openToken: string,
  closeToken: string
): number {
  let balance = 0;
  for (let i = tokens.length - 1; i >= 0; i--) {
    if (tokens[i] == openToken) {
      balance -= 1;
    }
    else if (tokens[i] == closeToken) {
      balance += 1;
    }

    if (balance == 0 && tokens[i] == openToken) {
      return i;
    }
  }

  return -1;
}

// returns the index the first time the close character is
// balanced (equal open as closed). -1 if it does not occur
function getFirstBalanceIndex(
  tokens: string[],
  openToken: string,
  closeToken: string
): number {
  let balance = 0;
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] == openToken) {
      balance -= 1;
    }
    else if (tokens[i] == closeToken) {
      balance += 1;
    }

    if (balance == 0 && tokens[i] == closeToken) {
      return i;
    }
  }

  return -1;
}

// returns two segments of tokens split by op, or the entire token stream
// as the first element of the array if the operator does not exist at the 
// current balance level
function balancedSplitTwo(tokens: string[], op: string): string[][] {
  let oParenCount = 0;
  let oSquareCount = 0;
  let oCurlyCount = 0;

  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] == '(') {
      oParenCount += 1;
    } else if (tokens[i] == ')') {
      oParenCount -= 1;
    } else if (tokens[i] == '[') {
      oSquareCount += 1;
    } else if (tokens[i] == ']') {
      oSquareCount -= 1;
    } else if (tokens[i] == '{') {
      oCurlyCount += 1;
    } else if (tokens[i] == '}') {
      oCurlyCount -= 1;
    }

    if (tokens[i] == op && oParenCount == 0 && oSquareCount == 0 && oCurlyCount == 0) {
      return [tokens.slice(0, i), tokens.slice(i + 1)];
    }
  }

  return [tokens];
}

// returns an array of token arrays which are a balanced split of the operator
function balancedSplit(tokens: string[], op: string): string[][] {
  let oParenCount = 0;
  let oSquareCount = 0;
  let oCurlyCount = 0;

  let splits = [];
  let tokenStart = 0;
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] == '(') {
      oParenCount += 1;
    }
    else if (tokens[i] == ')') {
      oParenCount -= 1;
    }
    else if (tokens[i] == '[') {
      oSquareCount += 1;
    }
    else if (tokens[i] == ']') {
      oSquareCount -= 1;
    }
    else if (tokens[i] == '{') {
      oCurlyCount += 1;
    }
    else if (tokens[i] == '}') {
      oCurlyCount -= 1;
    }

    if (tokens[i] == op && oParenCount == 0 && oSquareCount == 0 && oCurlyCount == 0) {
      if (tokenStart != i) {
        splits.push(tokens.slice(tokenStart, i));
      }
      tokenStart = i + 1;
    }
  }

  splits.push(tokens.slice(tokenStart));
  return splits;
}

function parseUses(header: SourceLine): string[] | null {
  if (header.tokens[0] != 'use') {
    return null;
  }

  let uses = [];
  let splits = balancedSplit(header.tokens.slice(1), ',');
  for (let modName of splits) {
    if (modName.length == 0) {
      return null;
    }

    uses.push(modName.join());
  }

  return uses;
} 

// returns the struct if it could valid parse from the header and the body, logs errors
function parseStruct(header: SourceLine, body: SourceLine[]): Struct | null {
  if (header.tokens.length < 2) {
    logError(header.sourceLine, 'expected struct name');
    return null;
  }

  let generics = [];
  if (header.tokens.length > 3 && header.tokens[2] == '[' && header.tokens[header.tokens.length - 1] == ']') {
    let genericTokens = balancedSplit(header.tokens.slice(3, -1), ',');
    for (let i = 0; i < genericTokens.length; i++) {
      if (genericTokens[i][0].length != 1 || genericTokens[i][0].length != 1) {
        logError(header.sourceLine, 'generics must be 1 letter long');
        return null;
      }

      let letter = genericTokens[i][0];
      if (letter > 'Z' || letter < 'A') {
        logError(header.sourceLine, 'generics must be captial letter');
        return null;
      }
      generics.push(letter);
    }
  }

  let structName: StructHeader = { name: header.tokens[1], generics };
  let structFields = [];
  for (let line of body) {
    let name = line.tokens[line.tokens.length - 1];
    let t = tryParseType(line.tokens.slice(0, -1));
    if (t == null) {
      logError(line.sourceLine, 'field type not valid')
      return null;
    }
    structFields.push({ t, name, sourceLine: line.sourceLine });
  }

  return { header: structName, fields: structFields, sourceLine: header.sourceLine };
}

// returns the fn if it could valid parse from the header and the body, logs errors
function parseFn(header: SourceLine, body: SourceLine[]): Fn | null {
  let fnHeader = parseFnHeader(header);
  if (fnHeader == null) {
    return null;
  }

  let { paramNames, name, t } = fnHeader;
  let fnBody = parseInstBody(body);
  if (fnBody == null) {
    return null;
  }

  return { name, paramNames, t, body: fnBody, sourceLine: header.sourceLine };
}

function tryParseType(tokens: string[]): Type | null {
  if (tokens.length == 0) {
    return null;
  }

  let lastToken = tokens[tokens.length - 1]; 
  if (lastToken == '!' || lastToken == '&' || lastToken == '?' || lastToken == '*') {
    let innerType = tryParseType(tokens.slice(0, -1));
    if (innerType == null) {
      return null;
    }
    if (lastToken == '*') {
      return { tag: 'arr', val: innerType };
    }
    if (lastToken == '!') {
      return { tag: 'generic', val: { name: 'Res', generics: [innerType] } };
    }
    else if (lastToken == '?') {
      return { tag: 'generic', val: { name: 'Opt', generics: [innerType] } };
    } 
    else {
      return { tag: 'link', val: innerType };
    }
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
  } else if (tokens[tokens.length - 1] == ']') { // parse generic or array
    let inner = tokens.slice(2, -1);
    if (inner.length == 0 || inner.length == 1 && inner[0] == '&') {
      let end = tokens.length - 2;
      if (inner[0] == '&') {
        end = tokens.length - 3;
      }

      let restOfType: string[] = tokens.slice(0, end);
      let t: Type | null = tryParseType(restOfType);
      if (t == null) {
        return null;
      }

      if (inner[0] == '&') {
        return { tag: 'arr', val: t };
      } 
      else {
        return { tag: 'const_arr', val: t };
      }
    }

    let splits = balancedSplit(inner, ',');

    let generics: Type[] = [];
    for (let split of splits) {
      let parseType = tryParseType(split);
      if (parseType == null) {
        return null;
      }
      generics.push(parseType);
    }

    return { tag: 'generic', val: { name: tokens[0], generics }};
  }

  if (tokens.length != 1) {
    return null;
  }
  return { tag: 'basic', val: tokens[0] };
}

function parseFnHeader(
  header: SourceLine
): { name: string, paramNames: string[], t: FnType } | null 
{
  let tokens = header.tokens;

  let paramStart = tokens.indexOf('(');
  if (paramStart == -1) {
    return null;
  }

  let name = tokens[paramStart - 1];

  let paramEnd = getFirstBalanceIndex(tokens.slice(paramStart), '(', ')');
  if (paramEnd == -1) {
    return null;
  }
  paramEnd = paramEnd + paramStart;

  let innerTokens = tokens.slice(paramStart + 1, paramEnd);
  let paramSplits = balancedSplit(innerTokens, ',');
  let paramTypes: Type[] = [];
  let paramNames = [];

  if (paramSplits[0].length > 0) { // for () functions
    for (let param of paramSplits) {
      let name = param[param.length - 1];
      let t = tryParseType(param.slice(0, -1));
      if (t == null) {
        logError(header.sourceLine, 'could not parse parameters');
        return null;
      }
      paramTypes.push(t);
      paramNames.push(name);
    }
  }

  let returnTokens = tokens.slice(paramEnd + 1);
  let returnType: Type | null = { tag: 'basic', val: 'void' };
  if (returnTokens.length != 0) {
    let possibleReturn: Type | null = null;
    // attempt to parse as 
    if (returnTokens.length > 1) {
      let lastToken = returnTokens[returnTokens.length - 1];
      if (isAlphaNumeric(lastToken)) {
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
    logError(header.sourceLine, 'could not parse return type');
    return null;
  }

  return { name, paramNames, t: { returnType, paramTypes } };
}

function parseInstBody(lines: SourceLine[]): InstMeta[] | null {
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
    }

    insts.push({ inst: inst!, sourceLine: line.sourceLine });
  }

  if (invalidInstruction) {
    return null;
  } else {
    return insts;
  }
}

function parseMatch(line: SourceLine, body: SourceLine[]): Inst | null {
  if (line.tokens.length < 2) {
    logError(line.sourceLine, 'expected expression');
    return null;
  }

  let expr = tryParseExpr(line.tokens.slice(1));
  if (expr == null) {
    logError(line.sourceLine, 'expected expression');
    return null;
  }

  let branches: MatchBranch[] = [];
  for (let i = 0; i < body.length; i++) {
    let bodyLine = body[i];
    if (bodyLine.indent != line.indent + 1) {
      continue;
    }

    if (bodyLine.tokens.length != 1) {
      logError(bodyLine.sourceLine, 'expected enum variant');
      return null;
    }

    let variantBodyLines = getIndentedSegment(body, i + 1, bodyLine.indent + 1);
    let insts = parseInstBody(variantBodyLines);
    if (insts == null) {
      return null;
    }

    branches.push({ body: insts, enumVariant: bodyLine.tokens[0], sourceLine: bodyLine.sourceLine });
  }

  return { tag: 'match', val: { var: expr, branches } };
}

function tryParseFnCall(tokens: string[]): FnCall | null {
  if (tokens.length < 3 || tokens[tokens.length - 1] != ')') {
    return null;
  }

  let paramStart = getFirstBalanceIndexFromEnd(tokens, '(', ')');
  let leftExpr = tryParseLeftExpr(tokens.slice(0, paramStart));
  if (leftExpr == null) {
    return null;
  }

  let paramExprs = balancedSplit(tokens.slice(paramStart + 1, -1), ',');
  let exprs = [];
  if (tokens.length - paramStart != 2) {
    for (let param of paramExprs) {
      let expr = tryParseExpr(param);
      if (expr == null) {
        return null;
      }
      exprs.push(expr);
    }
  }

  return { fn: leftExpr, exprs };
}

function parseInst(line: SourceLine, body: SourceLine[]): Inst | null {
  let keyword = line.tokens[0];
  let tokens = line.tokens;
  if (keyword == 'if') {
    let cond = tryParseExpr(tokens.slice(1));
    if (cond == null) {
      logError(line.sourceLine, 'expected expression');
      return null;
    }
    let b = parseInstBody(body);
    if (b == null) {
      return null;
    }
    return { tag: 'if', val: { cond, body: b }};
  } 
  else if (line.tokens[0] == '@') {
    if (tokens.length != 2) {
      logError(line.sourceLine, 'invalid macro');
      return null;
    }
    let name = tokens.slice(1)[0];

    let output = '';
    for (let i = 0; i < body.length; i++) {
      for (let j = 0; j < body[i].tokens.length; j++) {
        output += body[i].tokens[j] + ' ';
      }
      output += '\n';
    }

    return { tag: 'macro', val: { name, body: output } };
  }
  else if(keyword == 'include') {
    let lines: string[] = [];
    let types: Type[] = [];
    for (let line of body) {
      let result: string | null = parseIncludeLine(line.tokens[0], line.sourceLine, types);
      if (result == null) {
        logError(line.sourceLine, 'could not parse line');
        return null;
      }
      lines.push(result);
    }
    return { tag: 'include', val: { lines, types } };
  }
  else if (keyword == 'elif') {
    let cond = tryParseExpr(tokens.slice(1));
    if (cond == null) {
      logError(line.sourceLine, 'expected expression');
      return null;
    }
    let b = parseInstBody(body);
    if (b == null) {
      return null;
    }
    return { tag: 'elif', val: { cond, body: b }};
  } else if (keyword == 'else') {
    if (tokens.length != 1) {
      logError(line.sourceLine, 'unexpected token after \'else\'');
      return null;
    }

    let b = parseInstBody(body);
    if (b == null) {
      return null;
    }
    return { tag: 'else', val: b }
  } 
  else if (keyword == 'while') {
    let cond = tryParseExpr(tokens.slice(1));
    if (cond == null) {
      logError(line.sourceLine, 'expected expression');
      return null;
    }

    let b = parseInstBody(body);
    if (b == null) {
      return b;
    }
    return { tag: 'while', val: { cond, body: b }};
  } 
  else if (keyword == 'for') {
    if (tokens.length < 3) {
      logError(line.sourceLine, 'expected for <var> <iter>');
      return null;
    }

    let varName = tokens[1];
    let expr = tryParseExpr(tokens.slice(2));
    if (expr == null) {
      return null;
    }

    let b = parseInstBody(body);
    if (b == null) {
      return b;
    }
    return { tag: 'for_in', val: { varName, iter: expr, body: b }};
  } 
  else if (keyword == 'break') {
    return { tag: 'break' };
  }
  else if (keyword == 'continue') {
    return { tag: 'continue' }
  }
  else if (keyword == 'return') {
    if (tokens.length == 1) {
      return { tag: 'return_void' };
    }
    let val = tryParseExpr(tokens.slice(1));
    if (val == null) {
      logError(line.sourceLine, 'expected expression');
      return null;
    }
    return { tag: 'return', val };
  } 
  else if (keyword == 'match') {
    return parseMatch(line, body)
  }

  let expression = tryParseExpr(tokens);
  if (expression != null) {
    return { tag: 'expr', val: expression };
  }

  if (!tokens.includes('=') && !tokens.includes('+=') && !tokens.includes('-=')) {
    let type = tryParseType(tokens.slice(0, -1));
    let name = tokens[tokens.length - 1];
    if (tokens.length > 1 && type != null) {
      return { tag: 'declare', val: { t: type, name, expr: null } };
    }
    return null;
  }

  let assignOp: string = '='; 
  if (tokens.includes('+=')) {
    assignOp = '+=';
  } else if (tokens.includes('-=')) {
    assignOp = '-=';
  }

  let splits = balancedSplitTwo(tokens, assignOp);
  if (splits.length != 2) {
    logError(line.sourceLine, 'unexpected statement');
    return null;
  }

  let expr = tryParseExpr(splits[1]);
  if (expr == null) {
    logError(line.sourceLine, 'expected expression')
    return null;
  }

  let left = splits[0];
  // try parse assign
  let leftExpr = tryParseLeftExpr(left);
  if (leftExpr != null) {
    return { tag: 'assign', val: { to: leftExpr, expr, op: assignOp } };
  }

  // parse declare
  let type = tryParseType(left.slice(0, -1));
  let name = left[left.length - 1];
  if (left.length >= 2 && type != null) {
    return { tag: 'declare', val: { t: type, name, expr } }
  }

  return null;
}

function tryParseArrInit(tokens:  string[]): Expr | null {
  if (tokens.length < 2 || tokens[0] != '[' || tokens[tokens.length - 1] != ']') {
    return null;
  } 

  let splits = balancedSplit(tokens.slice(1, -1), ',');
  let exprs: Expr[] = [];
  for (let split of splits) {
    let expr = tryParseExpr(split);
    if (expr == null) {
      return null;
    }
    exprs.push(expr);
  }

  return { tag: 'arr_init', val: exprs };
}

function tryParseStructInit(tokens: string[]): Expr | null {
  if (tokens.length < 2 || tokens[0] != '{' || tokens[tokens.length - 1] != '}') {
    return null;
  }

  let props = [];
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

      let initExpr = tryParseExpr(newSplits[1])
      if (initExpr == null) {
        return null;
      }

      props.push({ name: newSplits[0][0], expr: initExpr });
    }
  }

  return { tag: 'struct_init', val: props };
}

function tryParseDotOp(tokens: string[]): LeftExpr | null {
  let splits = balancedSplitTwo(tokens, '.');
  if (splits.length != 2) {
    return null;
  }

  let left = tryParseExpr(splits[0]);
  if (left == null) {
    return null;
  }

  if (splits[1].length != 1) {
    return null;
  }

  return { tag: 'dot', val: { left, varName: splits[1][0] } };
}

function tryParseArrExpr(tokens: string[]): LeftExpr | null {
  if (tokens[tokens.length - 1] != ']') {
    return null;
  }

  let balanceIndex = getFirstBalanceIndexFromEnd(tokens, '[', ']');
  if (balanceIndex == -1) {
    return null;
  }

  let innerExpr = tryParseExpr(tokens.slice(balanceIndex + 1, -1));
  if (innerExpr == null) {
    return null;
  }

  let leftExpr = tryParseLeftExpr(tokens.slice(0, balanceIndex));
  if (innerExpr == null || leftExpr == null) {
    return null;
  }

  return { tag: 'arr_offset', val: { var: leftExpr, index: innerExpr }};
}

function tryParseLeftExpr(tokens: string[]): LeftExpr | null {
  if (tokens.length == 1) {
    return { tag: 'var', val: tokens[0] };
  }

  let dot = tryParseDotOp(tokens);
  if (dot != null) {
    return dot;
  }

  if (tokens[tokens.length - 1] == '\'') {
    let parsed = tryParseExpr(tokens.slice(0, -1));
    if (parsed == null) {
      return null;
    }
    return { tag: 'prime', val: parsed };
  }

  return tryParseArrExpr(tokens);
}

function tryParseExpr(tokens: string[]): Expr | null {
  if (tokens.length == 0) {
    return null;
  }

  if (tokens[0] == 'try' || tokens[0] == 'assert') {
    let parsed = tryParseExpr(tokens.slice(1));
    if (parsed == null) {
      return null;
    }
    if (tokens[tokens.length - 1] == '?') {
      return { tag: 'try', val: parsed };
    } else {
      return { tag: 'assert', val: parsed };
    }
  }

  // parse all bin expr
  for (let i = 0; i < 6; i++) {
    for (let props of MAPPING) {
      if (props[1] != i) {
        continue;
      }

      let binOp = tryParseBinOp(tokens, props[0]);
      if (binOp != null) {
        return binOp;
      }
    }
  }

  if (tokens.length >= 2 && tokens[0] == '(' && tokens[tokens.length - 1] == ')') {
    return tryParseExpr(tokens.slice(1, -1));
  }

  // parse not
  if (tokens.length >= 2 && tokens[0] == '!') {
    let expr = tryParseExpr(tokens.slice(1));
    if (expr == null) {
      return null;
    }
    return { tag: 'not', val: expr };
  }

  let fnCall = tryParseFnCall(tokens);
  if (fnCall != null) {
    return { tag: 'fn_call', val: fnCall };
  }

  let arrInit = tryParseArrInit(tokens);
  if (arrInit != null) {
    return arrInit;
  } 

  let structInit = tryParseStructInit(tokens);
  if (structInit != null) {
    return structInit;
  }

  if (tokens.length == 3 && tokens.includes('.')) {
    if (tokens[0][0] >= '0' && tokens[0][0] <= '9' && tokens[1] == '.'
      && tokens[2][0] >= '0' && tokens[2][0] <= '9') {

      let num;
      try {
        num = parseFloat(`${tokens[0]}.${tokens[2]}`) 
      } catch(e) {
        return null;
      }
      return { tag: 'num_const', val: num };
    }
  }

  if (tokens.length == 1) {
    let ident = tokens[0];
    if (ident == 'true') {
      return { tag: 'bool_const', val: true };
    } else if (ident == 'false') {
      return { tag: 'bool_const', val: false };
    }

    if (ident.length >= 2 && ident[0] == '"' && ident[ident.length - 1] == '"') {
      let str = ident.slice(1, -1);
      let parsed: Expr[] | null = tryParseFmtString(str);
      if (parsed == null) {
        return null;
      }

      if (parsed.length == 1) {
        return parsed[0];
      } else {
        return { tag: 'fmt_str', val: parsed };
      }
    }

    if (ident.length >= 2 && ident[0] == '\'' && ident[ident.length - 1] == '\'') {
      return { tag: 'char_const', val: ident.slice(1, -1) };
    }

    if (ident.length >= 1 && ident[0] >= '0' && ident[0] <= '9'
      || ident.length >= 2 && ident[0] == '-' && ident[1] >= '0' && ident[1] <= '9') {

      let int;
      try {
        int = parseInt(ident);
      } catch (e) {
        return null;
      }
      return { tag: 'int_const', val: int };
    }
  }

  let leftExpr = tryParseLeftExpr(tokens);
  if (leftExpr != null) {
    return { tag: 'left_expr', val: leftExpr };
  }

  return null;
}

function tryParseFmtString(lineExpr: string): Expr[] | null {
  let exprs: Expr[] = [];
  let constStrStart = 0;
  for (let i = 0; i < lineExpr.length; i++) {
    if (lineExpr[i] == '{') {
      let constStr = lineExpr.slice(constStrStart, i);
      exprs.push({ tag: 'str_const', val: constStr });

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
      let tokens = splitTokens(exprStr);
      let expr = tryParseExpr(tokens);
      if (expr == null) {
        return null;
      }
      exprs.push(expr);
      constStrStart = i + 1;
    }
  }

  let constStr = lineExpr.slice(constStrStart);
  exprs.push({ tag: 'str_const', val: constStr });
  return exprs;
}

function tryParseBinOp(tokens: string[], op: string): Expr | null {
  let splits = balancedSplitTwo(tokens, op);
  if (splits.length == 1) {
    return null;
  }

  let left = tryParseExpr(splits[0]);
  let right = tryParseExpr(splits[1]);

  if (left == null || right == null) {
    return null;
  }

  return { tag: 'bin', val: { op, left, right }};
}

function parseIncludeLine(line: string, sourceLine: number, types: Type[]): string | null {
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
    let typeTokens = splitTokens(typeStr);
    let type = tryParseType(typeTokens);
    if (type == null) {
      logError(sourceLine, 'could not parse type');
      return null;
    }
    types.push(type);

    outLine += '$';
    line = line.substring(nextSegment);
  }

  outLine += line;

  return outLine;
}

function splitTokens(line: string): string[] {
  // split tokens based on special characters
  let tokens: string[] = [];
  let tokenStart = 0;
  const splitTokens = [' ', '.', ',', '(', ')', '[', ']', '{', '}', '&', '*', '!', '?', '@', ':', '^'];
  for (let i = 0; i < line.length; i++) {
    // process string as a single token
    if (line[i] == '"') {
      let possibleSlice = line.slice(tokenStart, i);
      if (possibleSlice.length != 0) {
        tokens.push(possibleSlice);
      }
      tokenStart = i + 1;
      i += 1;

      let openCount = 0;
      while (i < line.length && !(line[i] == '"' && openCount == 0)) {
        if ((i == 0 || line[i - 1] != '\\') && line[i] == '{') {
          openCount += 1;
        }
        else if ((i == 0 || line[i - 1] != '\\') && line[i] == '}') {
          openCount -= 1;
        }
        i += 1;
      }
      tokens.push('"' + line.slice(tokenStart, i) + '"');
      tokenStart = i + 1;
    }

    // process chars as a single token
    if (line[i] == '\'' && (line[i - 1] == ' ' || line[i - 1] == '(' || line[i - 1] == '[')) {
      let possibleSlice = line.slice(tokenStart, i);
      if (possibleSlice.length != 0) {
        tokens.push(possibleSlice);
      }
      tokenStart = i + 1;
      i += 1;
      while (i < line.length && line[i] != '\'') {
        i += 1;
      }
      tokens.push('\'' + line.slice(tokenStart, i) + '\'');
      tokenStart = i + 1;
    } else if (line[i] == '\''){
      let possibleSlice = line.slice(tokenStart, i);
      if (possibleSlice.length != 0) {
        tokens.push(possibleSlice);
      }
      tokens.push('\'');
      tokenStart = i + 1;
    }

    if (splitTokens.includes(line[i])) {
      let possibleSlice = line.slice(tokenStart, i);
      // protects against double space and spaces trailing other splits
      if (possibleSlice.length != 0) {
        tokens.push(possibleSlice);
      }
      tokenStart = i + 1;

      if (line[i] != ' ') {
        tokens.push(line[i]);
      }
    }
  }

  // push the last token if it does not follow a split token
  if (!splitTokens.includes(line[line.length - 1]) && line[line.length - 1] != '"' && line[line.length - 1] != '\'') {
    tokens.push(line.slice(tokenStart, line.length));
  }

  // combine the tokens that should not have been split
  for (let i = tokens.length - 1; i >= 1; i--) {
    if (tokens[i - 1] == '!' && tokens[i] == '=') {
      tokens.splice(i, 1);
      tokens[i - 1] = '!=';
    }
    else if (tokens[i - 1] == '&' && tokens[i] == '&') {
      tokens.splice(i, 1);
      tokens[i - 1] = '&&';
    }
  }

  return tokens;
}

function getLines(data: string): SourceLine[] {
  let lines = data.split('\n');
  let sourceLines: SourceLine[] = [];
  // split lines based on spaces
  for (let lineNumber = 0; lineNumber < lines.length; lineNumber++) {
    let line = lines[lineNumber];
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
    if (indent != Math.floor(indent)) {
      logError(lineNumber, 'invalid tab amount ' + indent);
      continue;
    }

    if (line.trim().length == 0) {
      continue;
    }

    // parse the include block without processing tokens
    if (line == 'include') {
      let startingIndent = indent;
      sourceLines.push({ tokens: [line], indent, sourceLine: lineNumber });
      for (let blockLineNumber = lineNumber + 1; blockLineNumber < lines.length; blockLineNumber++) {
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
          logError(blockLineNumber, 'invalid tab amount ' + indent);
          continue;
        }

        if (indent <= startingIndent) {
          if (blockLineNumber > lineNumber + 1) { // guard against include without body
            lineNumber = blockLineNumber - 1; // don't skip this line
          }
          break;
        }

        sourceLines.push({ tokens: [line], indent: startingIndent + 1, sourceLine: blockLineNumber });
      }

      continue;
    }

    let tokens: string[] = splitTokens(line);
    sourceLines.push({ sourceLine: lineNumber, indent, tokens });
  }

  return sourceLines;
}
