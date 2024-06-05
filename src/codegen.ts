import { Program  } from './analyze/analyze';
import { Fn, Inst, LeftExpr, Expr, StructInitField, FnCall } from './analyze/analyze';

// generates the javascript output for the given program
function codegen(prog: Program): string {
  let programStr = `_${prog.entry}();`;
  for (let fn of prog.fns) {
    let fnCode = codeGenFnHeader(fn) + codeGenBody(fn.body, 1, false);
    programStr += fnCode;
  }

  return programStr;
}

export {
  codegen
}

function codeGenFnHeader(fn: Fn) {
  let headerStr = '\nasync function _' + fn.ident + '(';
  let paramStr = '';

  for (let i = 0; i < fn.paramNames.length; i++) {
    paramStr += '_' + fn.paramNames[i];
    if (i != fn.paramNames.length - 1) {
      paramStr += ', ';
    }
  }
  return headerStr + paramStr + ')';
}

function codeGenBody(body: Inst[], indent: number, includeBreak: boolean): string {
  let bodyStr = ' {\n'
  for (let i = 0; i < body.length; i++) {
    bodyStr += codeGenInst(body[i], indent);
  }

  let tabs = '';
  for (let i = 0; i < indent - 1; i++) {
    tabs += '  ';
  }

  if (includeBreak) {
    bodyStr += tabs + '  break;\n';
  }

  return bodyStr + tabs + '}'
}

function codeGenInst(inst: Inst, indent: number): string {
  let tabs = '';
  for (let i = 0; i < indent; i++) {
    tabs += '  ';
  }

  let addInst: string[] = [];

  let instText;
  if (inst.tag == 'declare') {
    let typeTag = inst.val.expr.type.tag;
    let rightExpr;

    // perform a copy on assignment of objects
    if (typeTag == 'struct' || typeTag == 'enum') {
      rightExpr = `Object.assign({}, ${codeGenExpr(inst.val.expr, addInst)})`;
    } else {
      rightExpr = codeGenExpr(inst.val.expr, addInst);
    }

    instText = `var _${inst.val.name} = ${rightExpr};`;
  } 
  else if (inst.tag == 'assign') {
    let typeTag = inst.val.expr.type.tag;
    let rightExpr;

    // perform a copy on assignment of objects
    if (typeTag == 'struct' || typeTag == 'enum') {
      rightExpr = `Object.assign({}, ${codeGenExpr(inst.val.expr, addInst)}`;
    } else {
      rightExpr = codeGenExpr(inst.val.expr, addInst);
    }

    instText = `${codeGenLeftExpr(inst.val.to, addInst)} ${inst.val.op} ${rightExpr};`;
  } 
  else if (inst.tag == 'if') {
    instText = `if (${ codeGenExpr(inst.val.cond, addInst) }) ${ codeGenBody(inst.val.body, indent + 1, false) }`;
  } 
  else if (inst.tag == 'elif') {
    instText = `else if (${ codeGenExpr(inst.val.cond, addInst) }) ${ codeGenBody(inst.val.body, indent + 1, false) }`;
  }
  else if (inst.tag == 'else') {
    instText = `else ${ codeGenBody(inst.val, indent + 1, false) }`;
  }
  else if (inst.tag == 'while') {
    instText = `while (${ codeGenExpr(inst.val.cond, addInst) }) ${ codeGenBody(inst.val.body, indent + 1, false) }`;
  }
  else if (inst.tag == 'return') {
    if (inst.val == null) {
      instText == 'return;'
    } else {
      instText = `return ${ codeGenExpr(inst.val, addInst) };`;
    }
  }
  else if (inst.tag == 'include') {
    let instText: string = tabs + '// include\n';
    for (let i = 0; i < inst.val.length; i++) {
      instText += inst.val[i] + '\n';
    }
    return instText + tabs + '// end include\n';
  }
  else if (inst.tag == 'match') {
    instText = `switch (${codeGenExpr(inst.val.var, addInst)}._tag) {\n`;
    for (let branch of inst.val.branches) {
      instText += `${tabs}case \'${branch.enumVariant}\':${ codeGenBody(branch.body, indent + 1, true) }\n`;
    }
    instText += tabs + '}\n';
  }
  else if (inst.tag == 'continue' || inst.tag == 'break') {
    instText = inst.tag + ';';
  } 
  else if (inst.tag == 'for_in') {
    let name = inst.val.varName;
    let inner = `for (let _${name} = __range_${name}._start; _${name} < __range_${name}._end; _${name}++)`;
    inner += '' + codeGenBody(inst.val.body, indent + 2, false);
    instText = `{\n${tabs}  var __range_${name} = `
    instText += `${codeGenExpr(inst.val.iter, addInst)};\n${tabs}  ${inner}\n${tabs}}`;
  }

  let outputText = '';
  for (let i of addInst) {
    outputText += tabs + i + '\n';
  }
  outputText += tabs + instText + '\n'; 
  return outputText;
}

function codeGenExpr(expr: Expr, addInst: string[]): string {
  if (expr.tag == 'bin') {
    if (expr.val.op == 'is') {
      return `${expr.val.left}.tag == ${expr.val.right}`;
    }
    if (expr.val.op == ':') {
      return 'undefined';
    }
    if (expr.val.op == '/' && expr.type.tag == 'primative' && expr.type.val == 'int') {
      return `(${ codeGenExpr(expr.val.left, addInst) } / ${ codeGenExpr(expr.val.right, addInst) } | 0)`
    }
    return `${ codeGenExpr(expr.val.left, addInst) } ${ expr.val.op } ${ codeGenExpr(expr.val.right, addInst) }`;
  } else if (expr.tag == 'not') {
    return '!' + codeGenExpr(expr.val, addInst);
  } else if (expr.tag == 'try') {
    let varName = '__temp_' + addInst.length;
    addInst.push(`var ${varName} = ${codeGenExpr(expr.val, addInst)};`);
    addInst.push(`if ('_err' in ${varName}) return ${varName};`);
    return `${varName}._ok`;
  } else if (expr.tag == 'assert') {
    let varName = '__temp_' + addInst.length;
    addInst.push(`var ${varName} = ${codeGenExpr(expr.val, addInst)};`);
    addInst.push(`if ('_err' in ${varName}) { console.error(${varName}._err); process.exit(-1) }`);
    return `${varName}._ok`;
  } else if (expr.tag == 'fn_call') {
    return codeGenFnCall(expr.val, addInst);
  } else if (expr.tag == 'struct_init') {
    return codeGenStructInit(expr.val, addInst)
  } else if (expr.tag == 'str_const') {
    return `"${expr.val}"`;
  } else if (expr.tag == 'char_const') {
    return `"${expr.val}"`;
  } else if (expr.tag == 'int_const') {
    return `${expr.val}`;
  } else if (expr.tag == 'bool_const') {
    return `${expr.val}`;
  } else if (expr.tag == 'num_const') {
    return `${expr.val}`;
  } else if (expr.tag == 'left_expr') {
    return codeGenLeftExpr(expr.val, addInst);
  } else if (expr.tag == 'is') {
    return `${codeGenLeftExpr(expr.left, addInst)}.tag == '${expr.variant}'`;
  } else if (expr.tag == 'enum_init') {
    if (expr.fieldExpr != null) {
      return `{ tag: '${expr.fieldName}', _${expr.fieldName}: ${ codeGenExpr(expr.fieldExpr, addInst) } }`;
    } else {
      return `{ tag: '${expr.fieldName}' }`;
    }
  }

  return 'undefined';
}

function codeGenStructInit(structInit: StructInitField[], addInst: string[]): string {
  let output = '{ ';
  for (let i = 0; i < structInit.length; i++) {
    let initField = structInit[i];
    output += `_${initField.name}: ${codeGenExpr(initField.expr, addInst)}`;
    if (i != structInit.length - 1) {
      output += ', ';
    }
  }

  return output + ' }'
}

function codeGenFnCall(fnCall: FnCall, addInst: string[]): string {
  let output = 'await ' + codeGenLeftExpr(fnCall.fn, addInst) + '(';
  for (let i = 0; i < fnCall.exprs.length; i++) {
    output += codeGenExpr(fnCall.exprs[i], addInst);
    if (i != fnCall.exprs.length - 1) {
      output += ', ';
    }
  }

  return output + ')'
}

function codeGenLeftExpr(leftExpr: LeftExpr, addInst: string[]): string {
  if (leftExpr.tag == 'dot') {
    return `${codeGenExpr(leftExpr.val.left, addInst)}._${leftExpr.val.varName}`;
  } 
  else if (leftExpr.tag == 'arr_offset_int') {
    return `${codeGenLeftExpr(leftExpr.val.var, addInst)}[${codeGenExpr(leftExpr.val.index, addInst)}]`;
  } 
  else if (leftExpr.tag == 'arr_offset_slice') {
    let start = codeGenExpr(leftExpr.val.start, addInst);
    let end = codeGenExpr(leftExpr.val.end, addInst);
    return `${codeGenLeftExpr(leftExpr.val.var, addInst)}.slice(${start}, ${end})`;
  }
  else {
    return '_' + leftExpr.val;
  }
}
