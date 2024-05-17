
module.exports = {
  typeCheck,
  getErrorOccured
}

const BOOL = { tag: 'basic', val: 'bool' };
const INT = { tag: 'basic', val: 'int' };
const STR = { tag: 'basic', val: 'str' };
const RANGE = { tag: 'basic', val: 'range' };

let errorOccured = false;
let scope = []; 
let structMap = []; // { name, type, fields}
let enumMap = []; // { name, type, variants }
let returnType = null;
let loopNest = 0;

function logError(line, message) {
  console.log(`error line: ${line + 1} ${message}`);
  errorOccured = true;
}

function getErrorOccured() {
  return errorOccured;
}

// ensures that the type uses template generics and returns the name
function ensureStructInitType(type, sourceLine) {
  let name;
  if (type.tag == 'basic') {
    name = type.name;
  } else if (type.tag == 'generic') {
    name = type.name;
    let genericNameList = [];
    for (let generic of type.generics) {
      if (generic.tag != 'basic') {
        logError(sourceLine, 'generic expected');
        return null;
      }

      if (generic.val.length != 1) {
        logError(sourceLine, 'generics must be length of 1');
        return null;
      }

      if (genericNameList.includes(generic.val)) {
        logError(sourceLine, 'generic type already added');
        return null;
      }

      genericNameList.push(generic.val);
    }
  } else {
    logError(sourceLine, 'invalid name');
    return null;
  }

  if (name.length == 1) {
    logError(struct.sourceLine, 'single variable names reserved for generics');
    return null;
  }

  return name;
}

function typeCheck(program) {
  let scope = [];
  let checkedProgram = {};
  enterScope(scope);

  for (let struct of program.structs) {
    let name = ensureStructInitType(struct.name);
    structMap.push({ name, type: struct.name, fields: struct.fields })
  }

  for (let en of program.enums) {
    let name = ensureStructInitType(en.name);
    enumMap.push({ name, type: en.name, variants: en.variants })
  }

  for (let fn of program.fns) {
    let paramTypes = [];
    for (let param in fn.params) {
      paramTypes.push(param.type);
    }

    let fnType = { tag: 'fn', returnType: fn.returnType, paramTypes };
    setTypeToScope(scope, fn.name, fnType);
  }

  // console.log(scope);
  // TODO
  return program;
}

function typeCheckExpr(expr, expectedType, sourceLine) {
  if (expr.tag == 'bin_expr') {
    typeCheckBinExpr(expr, expectedType, sourceLine);
  } else if (expr.tag == 'not') {
    if (expectedType != BOOL) {
      logError(sourceLine, 'expected a bool')
    }
    typeCheckExpr(expr.val, BOOL, sourceLine);
  } else if (expr.tag == 'fn_call') {

  } else if (expr.tag == 'struct_init') {
    throw 'not implemented';
  } else if (expr.tag == 'str_const') {
    if (expectedType != STR) {
      logError(sourceLine, 'expected string');
    }
  } else if (expr.tag == 'integer') {
    if (expectedType != INT) {
      logError(sourceLine, 'expected int');
    }
  } else if (expr.tag == 'left_expr') {
    typeCheckLeftExpr(expr, expectedType, sourceLine)
  }
}

function typeCheckLeftExpr(expr, expectedType, sourceLine) {
  throw 'not implemented';
}

function typeCheckBinOp(expr, expectedType, sourceLine) {
  throw 'not implemented';
}

function typeCheckBody(insts) {
  enterScope();
  for (let inst of insts) {
    typeCheckInst(inst);
  }
  exitScope();
}

function typeCheckInst(inst) {
  if (inst.tag == 'inst_if' || tag == 'inst_elif') {
    typeCheckExpr(inst.expr, BOOL, inst.sourceLine);
    typeCheckBody(inst.body);
  } else if (inst.tag == 'isnt_else') {
    typeCheckBody(inst.val);
  } else if (inst.tag == 'inst_for') {
    typeCheckExpr(inst.expr, BOOL, inst.sourceLine);
    loopNest += 1;
    typeCheckBody(inst.body);
    loopNest -= 1;
  } else if (inst.tag == 'inst_for_in') {
    typeCheckExpr(inst.expr, RANGE, inst.sourceLine);
    loopNest += 1;
    typeCheckBody(inst.body);
    loopNest -= 1;
  } else if (inst.tag == 'inst_return') {
    typeCheckExpr(inst.val, returnType, inst.sourceLine);
  } else if (inst.tag == 'inst_match') {
    throw 'not implemented';
  } else if (inst.tag == 'inst_continue' || inst.tag == 'inst_break') {
    if (loopNest == 0) {
      logError(inst.sourceLine, 'must be inside a loop');
    }
  } else if (inst.tag == 'inst_assign') {

  } else if (inst.tag == 'inst_declare') {

  }
}

function lookupStruct(name) {
  for (struct of structMap) {
    if (struct.name == name) {
      return struct;
    }
  }

  return null;
}

function getStructFieldType(name, structType, fieldName) {
}

function getEnumVarType(enumMap, enumType, fieldName) {

}

function enterScope() {
  scope.push(new Map())
}

function exitScope() {
  scope.pop();
}

function setTypeToScope(name, type) {
  scope[scope.length - 1].set(name, type);
}

function getTypeFromScope(name) {
  for (let i = scope.length - 1; i >= 0; i--) {
    if (scope.has(name)) {
      return scope.get(name);
    }
  }

  return null;
}
