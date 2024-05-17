module.exports = {
  gen
}

let stdlib = `
function print(...args) {
  console.log(...args)
}

`;

function gen(prog) {
  program = prog;
  let programStr = stdlib;
  for (fn of program.fns) {
    let fnCode = codeGenFnHeader(fn) + codeGenBody(fn.body, 1);
    programStr += fnCode;
  }

  for (let en of program.enums) {
    for (let v of en.variants) {
      programStr += `function ${v.name}(input) { return { tag: '${v.name}', val: input } }\n`;
    }
  }

  return programStr + "main();\n";
}

function codeGenFnHeader(fn) {
  let headerStr = 'function ' + fn.name + '(';
  let paramStr = '';
  for (let i = 0; i < fn.params.length; i++) {
    paramStr += fn.params[i].name;
    if (i != fn.params.length - 1) {
      paramStr += ', ';
    }
  }
  return headerStr + paramStr + ')';
}

function codeGenBody(body, indent) {
  let bodyStr = ' {\n'
  for (let i = 0; i < body.length; i++) {
    bodyStr += codeGenInst(body[i], indent);
  }

  let tabs = '';
  for (let i = 0; i < indent - 1; i++) {
    tabs += '  ';
  }

  return bodyStr + tabs + '}\n'
}

function codeGenInst(inst, indent) {
  let tabs = '';
  for (let i = 0; i < indent; i++) {
    tabs += '  ';
  }

  if (inst.tag == 'inst_if') {
    return tabs + `if (${codeGenExpr(inst.cond)}) ` + codeGenBody(inst.body, indent + 1) + '\n';
  } else if (inst.tag == 'inst_elif') {
    return tabs + `else if (${codeGenExpr(inst.cond)}) ` + codeGenBody(inst.bod, indent + 1) + '\n';
  } else if (inst.tag == 'inst_else') {
    return tabs + 'else' + codeGenBody(inst.body) + '\n';
  } else if (inst.tag == 'inst_for') {
    return tabs + `while (${codeGenExpr(inst.cond)})` + codeGenBody(inst.body, indent + 1) + '\n';
  } else if (inst.tag == 'inst_for_in') {
    return null;
  } else if (inst.tag == 'inst_break') {
    return tabs + 'break;\n';
  } else if (inst.tag == 'inst_continue') {
    return tabs + 'continue;\n';
  } else if (inst.tag == 'inst_return') {
    return tabs + 'return ' + codeGenExpr(inst.val) + ';\n';
  } else if (inst.tag == 'inst_return_void') {
    return tabs + 'return;\n';
  } else if (inst.tag == 'inst_match') {
    return null;
  } else if (inst.tag == 'fn_call') {
    return tabs + codeGenFnCall(inst) + ';\n';
  } else if (inst.tag == 'inst_declare') {

    return tabs + `let ${inst.name} = ${codeGenExpr(inst.expr)};\n`;
  } else if (inst.tag == 'inst_assign') {
    return tabs + `${inst.name} = ${codeGenExpr(inst.expr)};\n`;
  }

  return null;
}

function codeGenExpr(expr) {
  if (expr.tag == 'bin_expr') {
    if (expr.op == 'is') {
      return `${expr.expr1}.tag == ${expr.expr2}`;
    }

    if (expr.op == 'to') {
      return null;
    }

    return `${codeGenExpr(expr.expr1)} ${expr.op} ${codeGenExpr(expr.expr2)}`;
  } else if (expr.tag == 'not') {
    return '!' + codeGenExpr(expr);
  } else if (expr.tag == 'fn_call') {
    return codeGenFnCall(expr);
  } else if (expr.tag == 'struct_init') {
    return codeGenStructInit(expr)
  } else if (expr.tag == 'str_const') {
    return `"${expr.val}"`;
  } else if (expr.tag == 'char_const') {
    return `"${expr.val}"`;
  } else if (expr.tag == 'integer') {
    return `${expr.val}`;
  } else if (expr.tag == 'left_expr') {
    return codeGenLeftExpr(expr.leftExpr);
  }
}

function codeGenStructInit(structInit) {
  let output = '{ ';
  for (let i = 0; i < structInit.val.length; i++) {
    let initField = structInit.val[i];
    output += `${initField.name}: ${codeGenExpr(initField.expr)}`;
    if (i != structInit.val.length - 1) {
      output += ', ';
    }
  }

  return output + ' }'
}

function codeGenFnCall(fnCall) {
  let output = codeGenLeftExpr(fnCall.fn) + '(';
  for (let i = 0; i < fnCall.exprs.length; i++) {
    output += codeGenExpr(fnCall.exprs[i]);
    if (i != fnCall.exprs.length - 1) {
      output += ', ';
    }
  }

  return output + ')'
}


function codeGenLeftExpr(leftExpr) {
  if (leftExpr.tag == 'dot') {
    return `${codeGenLeftExpr(leftExpr.expr1)}.${codeGenLeftExpr(leftExpr.expr2)}`;
  } else if (leftExpr.tag == 'arr_offset') {
    return `${codeGenLeftExpr(leftExpr.name)}[${codeGenExpr(leftExpr.offset)}]`;
  } else if (leftExpr.tag == 'var') {
    return leftExpr.val;
  }

  return null;
}


// TODO
function translateFnName(fn) {
  let paramStr = '';
  for (let i = 0; i < fn.params.length; i++) {
    paramStr += '$p_' + transteTypeName(fn.params[i].t);
  }

  let returnStr = '$r_' + translateTypeName(fn.return_type);
  return fn.name + paramStr + returnStr;
}

function translateTypeName(type) {
  if (type.tag == 'basic') {
    return  
  } else if (type.tag == 'generic') {
    
  } else if (type.tag == 'fn') {

  } else if (type.tag == 'opt') {

  } else if (type.tag == 'err') {

  } else if (type.tag == 'link') {

  }
}

