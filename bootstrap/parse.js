const fs = require('node:fs');
const MAPPING = [
  ['to', 'to', 0],
  ['+', 'add', 4], ['-', 'sub', 4], ['*', 'mul', 5], ['&&', 'and', 2], ['||', 'or', 1],
  ['/', 'div', 5], ['%', 'mod', 5], ['==', 'eq', 3], ['!=', 'ne', 3], ['<', 'lesser', 3],
  ['>', 'greater', 3], ['>=', 'greater_eq', 3], ['<=', 'lesser_eq', 3], ['is', 'is', 3]
];

let errorOccured = false;

function logError(line, message) {
  console.log(`error line: ${line + 1} ${message}`);
  errorOccured = true;
}

module.exports = {
  parse,
  getErrorOccured
}

function getErrorOccured() {
  return errorOccured;
}

function parse(sourceFilePath) {
  let text = getText(sourceFilePath);
  let lines = getLines(text);
  // console.log(lines);

  let parsed = parseLines(lines);
  return parsed;
}

function parseLines(lines) {
  let program = { fns: [], structs: [], enums: [] };
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    if (line.indent == 0) {
      parseTopLine(program, lines, i);
    }
  }

  return program;
}

function getLinesOfBody(lines, startIndex, bodyLevelIndent) {
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

function findLastBalanceIndex(tokens, openToken, closeToken) {
  let balance = 0;
  for (let i = tokens.length - 1; i >= 0; i--) {
    if (tokens[i] == openToken) {
      balance -= 1;
    }
    else if (tokens[i] == closeToken) {
      balance += 1;
    }
    
    if (balance == 0) {
      return i;
    }
  }

  return -1;
}

function findFirstBalanceIndex(tokens, openToken, closeToken) {
  let balance = 0;
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] == openToken) {
      balance -= 1;
    }
    else if (tokens[i] == closeToken) {
      balance += 1;
    }
    
    if (balance == 0) {
      return i;
    }
  }

  return -1;
}

function removeEndingToken(tokens, expectedToken) {
  tokens = Array.from(tokens);
  let lastToken = tokens[tokens.length - 1];
  if (lastToken == expectedToken) {
    tokens.pop();
  } else {
    tokens[tokens.length - 1] = lastToken.slice(0, -1);
  }

  return tokens;
}

function parseTopLine(program, lines, lineIndex) {
  let thisLine = lines[lineIndex];
  if (thisLine.tokens[0] == 'struct') {
    let structType = tryParseType(thisLine.tokens.slice(1));
    if (structType == null) {
      logError(lineIndex, 'invalid name in struct decl');
    }

    let bodyLines = getLinesOfBody(lines, lineIndex + 1, 1);
    let structFields = parseStructBody(bodyLines);
    program.structs.push({ name: structType, fields: structFields, sourceLine: lineIndex });
  }
  else if (thisLine.tokens[0] == 'enum') {
    let enumType = tryParseType(thisLine.tokens.slice(1));
    if (enumType == null) {
      logError(lineIndex, 'invalid name in enum decl');
    }

    let bodyLines = getLinesOfBody(lines, lineIndex + 1, 1);
    let enumFields = parseEnumBody(bodyLines);
    program.enums.push({ name: enumType, variants: enumFields, sourceLine: lineIndex });
  }
  else if (thisLine.tokens) {
    let fnHeader = parseFnHeader(thisLine);
    let bodyLines = getLinesOfBody(lines, lineIndex + 1, 1);
    let fnBody = parseInstBody(bodyLines);

    if (fnHeader != null && fnBody != null) {
      program.fns.push({ ...fnHeader, body: fnBody });
    }
  }
}

function binOpSplitTwo(tokens, op) {
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

function binOpSplit(tokens, op) {
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

function tryParseType(tokens) {
  if (tokens.length == 0) {
    return null;
  }

  let lastChar = tokens[tokens.length - 1][tokens[tokens.length - 1].length - 1]; 
  if (lastChar == '!' || lastChar == '?' || lastChar == '&') {
    let newTokens = Array.from(tokens);
    newTokens[newTokens.length - 1] = newTokens[newTokens.length - 1].slice(0, -1);
    let innerType = tryParseType(newTokens);
    if (innerType == null) {
      return null;
    }

    if (lastChar == '!') {
      return { tag: 'err', err: innerType };
    }
    else if (lastChar == '?') {
      return { tag: 'opt', opt: innerType };
    }
    else if (lastChar == '&') {
      return { tag: 'link', link: innerType };
    }

  } else if (tokens[tokens.length - 1] == ')') {
    let fnParamBegin = findLastBalanceIndex(tokens, '(', ')') + 1;

    if (fnParamBegin == 0) {
      return null;
    }

    let returnType = tryParseType(tokens.slice(0, fnParamBegin - 1));
    if (returnType == null) {
      return null;
    }

    let paramsStr = tokens.slice(fnParamBegin, -1);
    let splits = binOpSplit(paramsStr, ',');
    let paramTypes = [];
    if (splits[0] != '') {
      for (let split of splits) {
        let paramType = tryParseType(split);
        if (paramType == null) {
          return null;
        }

        paramTypes.push(paramType);
      }
    }
    return { tag: 'fn', returnType, paramTypes };
  } else if (tokens[tokens.length - 1] == ']') {
    let inner = tokens.slice(2, -1);
    let splits = binOpSplit(inner, ',');

    let generics = [];
    for (let split of splits) {
      generics.push(tryParseType(split));
    }

    return { tag: 'generic', name: tokens[0], generics };
  }

  return { tag: 'basic', name: tokens[0] };
}

function parseStructBody(lines) {
  let varDecls = [];
  for (line of lines) {
    let name = line.tokens[line.tokens.length - 1];
    let t = tryParseType(line.tokens.slice(0, -1));
    if (t == null) {
      logError(line.sourceLine, 'struct name not valid')
    }
    varDecls.push({ t, name, sourceLine: line.sourceLine });
  }
  return varDecls;
}

function parseEnumBody(lines) {
  let varDecls = [];
  for (line of lines) {
    let name = line.tokens[line.tokens.length - 1];
    let t = tryParseType(line.tokens.slice(0, -1));
    if (t == null) {
      logError(line.sourceLine, 'enum name not valid')
    }
    varDecls.push({ t, name, sourceLine: line.sourceLine });
  }

  return varDecls;
}

function parseFnHeader(line) {
  let tokens = line.tokens;

  let paramStart = tokens.indexOf('(');
  if (paramStart == -1) {
    return null;
  }
  
  let name = tokens[paramStart - 1];

  let paramEnd = findFirstBalanceIndex(tokens.slice(paramStart), ')', '(');
  if (paramEnd == -1) {
    return null;
  }
  paramEnd = paramEnd + paramStart;

  let innerTokens = tokens.slice(paramStart + 1, paramEnd);
  let paramSplits = binOpSplit(innerTokens, ',');
  let params = [];

  // for () functions
  if (paramSplits[0] != '') {
    for (let param of paramSplits) {
      let name = param[param.length - 1];
      let t = tryParseType(param.slice(0, -1));
      params.push({ t, name });
    }
  }

  let returnTokens = tokens.slice(paramEnd + 1);
  let returnType = tryParseType('void');
  if (returnTokens.length != '0') {
    returnType = tryParseType(returnTokens);
    if (returnType == null) {
      return null;
    }
  }

  return { name, returnType, params, sourceLine: line.sourceLine };
}

function parseInstBody(lines) {
  if (lines.length == 0) {
    return [];
  }

  let indent = lines[0].indent;
  let insts = [];
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    if (line.indent != indent) {
      continue;
    }
    let body = getLinesOfBody(lines, i + 1, line.indent + 1);
    let inst = parseInst(line, body);
    insts.push(inst);
  }

  return insts;
}

function parseMatch(line, body) {
  if (line.tokens.length < 2) {
    logError(line.sourceLine, 'expected expression');
    return;
  }

  let expr = tryParseExpr(line.tokens.slice(1));
  if (expr == null) {
    logError(line.sourceLine, 'expected expression');
    return;
  }

  let vars = [];
  for (let i = 0; i < body.length; i++) {
    let bodyLine = body[i];
    if (bodyLine.indent != line.indent + 1) {
      continue;
    }

    if (bodyLine.tokens.length != 1) {
      logError(bodyLine.sourceLine, 'expected enum variant');
      return null;
    }

    let variantBodyLines = getLinesOfBody(body, i + 1, bodyLine.indent + 1);
    let insts = parseInstBody(variantBodyLines);
    vars.push({ inst_body: insts, name: bodyLine.tokens[0] });
  }

  return { tag: 'inst_match', expr, vars };
}

function tryParseFnCall(tokens) {
  if (tokens.length < 3 || tokens[tokens.length - 1] != ')') {
    return null;
  }

  let paramStart = findLastBalanceIndex(tokens, '(', ')');

  let leftExpr = tryParseLeftExpr(tokens.slice(0, paramStart));
  if (leftExpr == null) {
    return null;
  }

  let paramExprs = binOpSplit(tokens.slice(paramStart + 1, -1), ',');
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

  return { tag: 'fn_call', fn: leftExpr, exprs };
}

function parseInst(line, body) {
  let keyword = line.tokens[0];
  let tokens = line.tokens;
  if (keyword == 'if') {
    let cond = tryParseExpr(tokens.slice(1));
    if (cond == null) {
      logError(line.sourceLine, 'expected expression');
      return null;
    }
    return { tag: 'inst_if', cond, body: parseInstBody(body) };
  } else if (keyword == 'elif') {
    let cond = tryParseExpr(tokens.slice(1));
    if (cond == null) {
      logError(line.sourceLine, 'expected expression');
      return null;
    }
    return { tag: 'inst_elif', cond, body: parseInstBody(body) };
  } else if (keyword == 'else') {
    return { tag: 'inst_else', body: parseInstBody(body) }
  } else if (keyword == 'for') {
    if (line.tokens.includes('in')) {
      let splits = binOpSplitTwo(line.tokens.slice(1), 'in');
      if (splits[0].length != 1) {
        logError(line.sourceLine, 'expected var name');
        return null;
      }

      let expr = tryParseExpr(splits[1]);
      if (expr == null) {
        return null;
      }

      return { tag: 'inst_for_in', var_name: splits[0], iter: expr, body: parseInstBody(body) };
    } 
    let cond = tryParseExpr(tokens.slice(1));
    if (cond == null) {
      logError(line.sourceLine, 'expected expression');
      return null;
    }
    return { tag: 'inst_for', cond, body: parseInstBody(body) };
  } else if (keyword == 'break') {
    return { tag: 'inst_break' };
  } else if (keyword == 'continue') {
    return { tag: 'inst_continue' }
  } else if (keyword == 'inst_return') {
    if (tokens.length == 1) {
      return { tag: 'inst_return_void' }
    }
    let val = tryParseExpr(tokens.slice(1));
    if (val == null) {
      logError(line.sourceLine, 'expected expression');
    }
    return { tag: 'return', val };
  } else if (keyword == 'match') {
    return parseMatch(line, body)
  }

  let fnCall = tryParseFnCall(tokens);
  if (fnCall != null) {
    return fnCall;
  }

  let splits = binOpSplitTwo(tokens, '=');
  if (splits.length != 2) {
    logError(line.sourceLine, 'unexpected statement');
    return null;
  }

  let expr = tryParseExpr(splits[1]);

  // parse declare
  let left = splits[0];
  let type = tryParseType(left.slice(0, -1));
  let name = left[left.length - 1];
  if (left.length >= 2 && type != null) {
    return { tag: 'inst_declare', type, name, expr }
  }

  // assign
  return { tag: 'inst_assign', name, expr };
}

function tryParseStructInit(tokens) {
  if (tokens.length < 5 || tokens[0] != '{' || tokens[tokens.length - 1] != '}') {
    return null;
  }

  let props = [];
  let splits = binOpSplit(tokens.slice(1, -1), ',');
  for (let split of splits) {
    if (split.length < 3) {
      return null;
    }

    let newSplits = binOpSplit(split, '=');
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

  return { tag: 'struct_init', val: props };
}

function tryParseDotOp(tokens) {
  let splits = binOpSplitTwo(tokens, '.');
  if (splits.length != 2) {
    return null;
  }

  let expr1 = tryParseLeftExpr(splits[0]);
  let expr2 = tryParseLeftExpr(splits[1]);
  if (expr1 == null || expr2 == null) {
    return null;
  }

  return { tag: 'dot', expr1, expr2 };
}

function tryParseArrExpr(tokens) {
  if (tokens[tokens.length - 1] != ']') {
    return null;
  }

  let balanceIndex = findLastBalanceIndex(tokens, '[', ']');
  if (balanceIndex == -1) {
    return null;
  }

  let innerExpr = tryParseExpr(tokens.slice(balanceIndex + 1, -1));
  let leftExpr = tryParseLeftExpr(tokens.slice(0, balanceIndex));
  if (innerExpr == null || leftExpr == null) {
    return null;
  }

  return { tag: 'arr_offset', name: leftExpr, offset: innerExpr };
}

function tryParseLeftExpr(tokens) {
  if (tokens.length == 1) {
    return { tag: 'var', val: tokens[0] };
  }

  let dot = tryParseDotOp(tokens);
  if (dot != null) {
    return dot;
  }

  return tryParseArrExpr(tokens);
}

function tryParseExpr(tokens) {
  // parse all bin expr
  for (let i = 0; i < 6; i++) {
    for (let props of MAPPING) {
      if (props[2] != i) {
        continue;
      }

      let binOp = tryParseBinOp(tokens, props[0]);
      if (binOp != null) {
        return binOp;
      }
    }
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
    return fnCall;
  }

  let structInit = tryParseStructInit(tokens);
  if (structInit != null) {
    return structInit;
  }

  if (tokens.length == 1) {
    let ident = tokens[0];
    if (ident.length >= 2 && ident[0] == '"' && ident[ident.length - 1] == '"') {
      return { tag: 'str_const', val: ident.slice(1, -1) };
    }

    if (ident.length >= 2 && ident[0] == '\'' && ident[ident.length - 1] == '\'') {
      return { tag: 'char_const', val: ident.slice(1, -1) };
    }

    if (ident.length == 1 && ident[0] >= '0' && ident[0] <= '9') {
      return { tag: 'integer', val: parseInt(ident) };
    }

  }

  let leftExpr = tryParseLeftExpr(tokens);
  if (leftExpr != null) {
    return { tag: 'left_expr', leftExpr };
  }

  return null;
}

function tryParseBinOp(tokens, op) {
  let splits = binOpSplitTwo(tokens, op);
  if (splits.length == 1) {
    return null;
  }

  let expr1 = tryParseExpr(splits[0]);
  let expr2 = tryParseExpr(splits[1]);

  if (expr1 == null || expr2 == null) {
    return null;
  }

  return { tag: 'bin_expr', op, expr1, expr2 };
}

function getText(sourceFilePath) {
  let data;
  try {
    data = fs.readFileSync(sourceFilePath, 'utf8');
  } catch (err) {
    console.error(err);
  }

  return data;
}

function getLines(data) {
  let lines = data.split('\n');
  let sourceLines = [];
  for (let lineNumber = 0; lineNumber < lines.length; lineNumber++) {
    let line = lines[lineNumber];
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
 
    let tokens = [];
    let tokenStart = 0;
    const splitTokens = [' ', '.', ',', '(', ')', '[', ']', '{', '}'];
    for (let i = 0; i < line.length; i++) {
      if (line[i] == '"') {
        let possibleSlice = line.slice(tokenStart, i);
        if (possibleSlice.length != 0) {
          tokens.push(possibleSlice);
        }
        tokenStart = i + 1;
        i += 1;
        while (i < line.length && line[i] != '"') {
          i += 1;
        }
        tokens.push('"' + line.slice(tokenStart, i) + '"');
        tokenStart = i + 1;
      }

      if (line[i] == '\'') {
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

    // push the last token if it is not split token
    if (!splitTokens.includes(line[line.length - 1]) && line[line.length - 1] != '"' && line[line.length - 1] != '\'') {
      tokens.push(line.slice(tokenStart, line.length));
    }

    sourceLines.push({ sourceLine: lineNumber, indent, tokens });
  }

  return sourceLines;
}


