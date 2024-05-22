import { Program,  } from './analysis';
import { Fn, InstMeta, Expr, StructInitField, FnCall, LeftExpr } from './parse';

// generates the javascript output for the given program
function codegen(prog: Program): string {
  let programStr = '';
  for (let fn of prog.fns) {
    let fnCode = codeGenFnHeader(fn) + codeGenBody(fn.body, 1);
    programStr += fnCode;
  }

  return programStr + "main();\n";
}

export {
  codegen
}

function codeGenFnHeader(fn: Fn) {
  let headerStr = 'function ' + fn.name + '(';
  let paramStr = '';
  for (let i = 0; i < fn.paramNames.length; i++) {
    paramStr += fn.paramNames[i];
    if (i != fn.paramNames.length - 1) {
      paramStr += ', ';
    }
  }
  return headerStr + paramStr + ')';
}

function codeGenBody(body: InstMeta[], indent: number): string {
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

function codeGenInst(instMeta: InstMeta, indent: number): string {
  let sourceLine = instMeta.sourceLine;
  let inst = instMeta.inst;

  let instText;
  if (inst.tag == 'declare') {
    instText = `let ${inst.val.name} = ${codeGenExpr(inst.val.expr)};`;
  } else if (inst.tag == 'assign') {
    instText = `${codeGenLeftExpr(inst.val.to)} = ${codeGenExpr(inst.val.expr)};`;
  } else if (inst.tag == 'if') {
    instText = `if (${ codeGenExpr(inst.val.cond) }) ${ codeGenBody(inst.val.body, indent + 1) }`;
  } else if (inst.tag == 'elif') {
    instText = `else if (${ codeGenExpr(inst.val.cond) }) ${ codeGenBody(inst.val.body, indent + 1) }`;
  } else if (inst.tag == 'else') {
    instText = `else ${ codeGenBody(inst.val, indent + 1) }`;
  } else if (inst.tag == 'for') {
    instText = `while (${ codeGenExpr(inst.val.cond) }) ${ codeGenBody(inst.val.body, indent + 1) }`;
  } else if (inst.tag == 'return') {
    instText = `return ${ codeGenExpr(inst.val) };`;
  } else if (inst.tag == 'return_void') {
    instText = 'return;'
  }

  let tabs = '';
  for (let i = 0; i < indent; i++) {
    tabs += '  ';
  }

  return tabs + instText + ' //' + sourceLine + '\n';
}

function codeGenExpr(expr: Expr): string {
  if (expr.tag == 'bin') {
    if (expr.val.op == 'is') {
      return `${expr.val.left}.tag == ${expr.val.right}`;
    }
    if (expr.val.op == 'to') {
      return 'undefined';
    }
    return `${ codeGenExpr(expr.val.left) } ${ expr.val.op } ${ codeGenExpr(expr.val.right) }`;
  } else if (expr.tag == 'not') {
    return '!' + codeGenExpr(expr);
  } else if (expr.tag == 'fn_call') {
    return codeGenFnCall(expr.val);
  } else if (expr.tag == 'struct_init') {
    return codeGenStructInit(expr.val)
  } else if (expr.tag == 'str_const') {
    return `"${expr.val}"`;
  } else if (expr.tag == 'char_const') {
    return `"${expr.val}"`;
  } else if (expr.tag == 'int_const') {
    return `${expr.val}`;
  } else if (expr.tag == 'left_expr') {
    return codeGenLeftExpr(expr.val);
  }

  return 'undefined';
}

function codeGenStructInit(structInit: StructInitField[]): string {
  let output = '{ ';
  for (let i = 0; i < structInit.length; i++) {
    let initField = structInit[i];
    output += `${initField.name}: ${codeGenExpr(initField.expr)}`;
    if (i != structInit.length - 1) {
      output += ', ';
    }
  }

  return output + ' }'
}

function codeGenFnCall(fnCall: FnCall): string {
  let output = codeGenLeftExpr(fnCall.fn) + '(';
  for (let i = 0; i < fnCall.exprs.length; i++) {
    output += codeGenExpr(fnCall.exprs[i]);
    if (i != fnCall.exprs.length - 1) {
      output += ', ';
    }
  }

  return output + ')'
}

function codeGenLeftExpr(leftExpr: LeftExpr): string {
  if (leftExpr.tag == 'dot') {
    return `${codeGenLeftExpr(leftExpr.val.left)}.${codeGenLeftExpr(leftExpr.val.right)}`;
  } else if (leftExpr.tag == 'arr_offset') {
    return `${codeGenLeftExpr(leftExpr.val.var)}[${codeGenExpr(leftExpr.val.index)}]`;
  } else {
    return leftExpr.val;
  }
}
