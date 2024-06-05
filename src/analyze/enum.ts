import { LeftExpr, Inst, Expr, allPathsReturn } from './analyze';
import { logError } from '../index';
import { Type } from './types';

export { enumCheckBody }

// variable -> possibilities
interface VariantSet {
  key: string[],
  totalSet: string[],
  currentSet: string[]
}

// the key intersection, value union (typically ||)
function intersectingUnion(a: VariantSet[], b: VariantSet[]): VariantSet[] {
  let newSet: VariantSet[] = [];
  for (let entry of a) {
    let bIndex = indexOf(b, entry.key);
    if (bIndex == -1) {
      continue;
    }

    let aPossible: string[] = entry.currentSet;
    let bPossible: string[] = b[bIndex].currentSet;

    let newEntry: VariantSet = {
      key: entry.key,
      totalSet: entry.totalSet,
      currentSet: Array.from(new Set([...aPossible, ...bPossible]))
    };

    newSet.push(newEntry);
  }

  return newSet;
}

// the value union, key intersection (typically &&)
function unionsIntersection(a: VariantSet[], b: VariantSet[]): VariantSet[] {
  let newSet: VariantSet[] = [];
  for (let entry of a) {
    let bIndex = indexOf(b, entry.key);
    if (bIndex == -1) {
      let newEntry: VariantSet = {
        key: Array.from(entry.key),
        totalSet: entry.totalSet,
        currentSet: Array.from(entry.currentSet)
      };
      newSet.push(newEntry);
      continue;
    } 

    let aPossible: string[] = entry.currentSet;
    let bPossible: string[] = b[bIndex].currentSet;
    let newEntry: VariantSet = {
      key: entry.key,
      totalSet: entry.totalSet,
      currentSet: aPossible.filter(x => bPossible.includes(x))
    };
    newSet.push(newEntry);
  }

  for (let entry of b) {
    let aIndex = indexOf(a, entry.key);
    if (aIndex != -1) { // added before
      continue;
    }

    let newEntry: VariantSet = {
      key: entry.key,
      totalSet: entry.totalSet,
      currentSet: Array.from(entry.currentSet)
    }
    newSet.push(newEntry);
  }

  return newSet;
}

// the compliment of all of the values (typically !)
function innerCompliment(a: VariantSet[]): VariantSet[] {
  let newSet: VariantSet[] = [];
  for (let entry of a) {
    let compliment = entry.totalSet.filter(x => !entry.currentSet.includes(x));
    let newEntry: VariantSet = {
      key: Array.from(entry.key),
      currentSet: compliment,
      totalSet: entry.totalSet
    }
    newSet.push(newEntry)
  }
  return newSet;
}

function clone(set: VariantSet[]): VariantSet[] {
  return JSON.parse(JSON.stringify(set));
}

function add(
  set: VariantSet[],
  leftExpr: LeftExpr,
  current: string[],
  possible: string[]
) {
  let key = leftExprToKey(leftExpr);
  if (key == null) {
    return;
  }

  let newEntry: VariantSet = {
    key,
    currentSet: Array.from(current),
    totalSet: Array.from(possible) 
  };
  set.push(newEntry);
}

function indexOf(set: VariantSet[], key: string[]): number {
  for (let i = 0; i < set.length; i++) {
    let allMatch = true;
    for (let j = 0; j < set[i].key.length; j++) {
      if (set[i].key[j] != key[j]) {
        allMatch = false;
        break;
      }
    }
    if (allMatch) {
      return i;
    }
  }
  return -1;
}

function remove(set: VariantSet[], leftExpr: LeftExpr) {
  let key = leftExprToKey(leftExpr);
  if (key == null) {
    return;
  }

  for (let i = 1; i < key.length; i++) {
    let index = indexOf(set, key.slice(0, i));
    if (index == -1) {
      continue;
    }
    set.splice(index, 1);
  }
}

function getVariantPossibilities(set: VariantSet[], leftExpr: LeftExpr): string[] {
  let key = leftExprToKey(leftExpr);
  if (key == null) {
    return [];
  }

  let index = indexOf(set, key);
  if (index == -1) {
    return [];
  }

  return Array.from(set[index].currentSet.values());
}

function leftExprToKey(leftExpr: LeftExpr): string[] | null {
  let currExpr = leftExpr;
  let output: string[] = [];
  while (true) {
    if (currExpr.tag == 'var') {
      output.push(currExpr.val);
      break;
    } 
    else if (currExpr.tag == 'dot') {
      if (currExpr.val.left.tag == 'left_expr') {
        output.push(currExpr.val.varName);
        currExpr = currExpr.val.left.val;
      } else {
        return null;
      }
    }
    else if (currExpr.tag == 'arr_offset_int') {
      output.push(currExpr.val.index + '');
      currExpr = currExpr.val.var;
    }
    else {
      return null;
    }
  }
  return output.reverse();
}

function getReverseExprSet(expr: Expr): VariantSet[] {
  if (expr.tag == 'bin' && expr.val.op == '||') {
    let left = getReverseExprSet(expr.val.left);
    let right = getReverseExprSet(expr.val.right);
    return unionsIntersection(left, right);
  }
  else if (expr.tag == 'bin' && expr.val.op == '&&') {
    let left = getReverseExprSet(expr.val.left);
    let right = getReverseExprSet(expr.val.right);
    return intersectingUnion(left, right);
  }
  else if (expr.tag == 'is') {
    if (expr.left.type.tag == 'enum') {
      let key = expr.left;
      let newSet: VariantSet[] = [];
      let possible = expr.left.type.val.fields.map(x => x.name);
      let current: string[] = possible.filter(x => x != expr.variant);
      add(newSet, key, current, possible);
      return newSet;
    }
    else {
      logError(-1, 'compiler error non enum type in is');
      return [];
    }
  }
  else if (expr.tag == 'not') {
    return getExprSet(expr);
  }

  return [];
}

// used for if/while/elif statements to get the new
// set that can be used. note that enumCheckExpr should
// be called before getExprSet or the errors may be weird
function getExprSet(expr: Expr): VariantSet[] {
  if (expr.tag == 'bin' && expr.val.op == '||') {
    let left = getExprSet(expr.val.left);
    let right = getExprSet(expr.val.right);
    return intersectingUnion(left, right);
  }
  else if (expr.tag == 'bin' && expr.val.op == '&&') {
    let left = getExprSet(expr.val.left);
    let right = getExprSet(expr.val.right);
    return unionsIntersection(left, right);
  }
  else if (expr.tag == 'is') {
    if (expr.left.type.tag == 'enum') {
      let key = expr.left;
      let newSet: VariantSet[] = [];
      let possible = expr.left.type.val.fields.map(x => x.name);
      add(newSet, key, [expr.variant], possible);
      return newSet;
    }
    else {
      logError(-1, 'compiler error non enum type in is');
      return [];
    }
  }
  else if (expr.tag == 'not') {
    return getReverseExprSet(expr);
  }

  return [];
}

function enumCheckLeftExpr(
  set: VariantSet[],
  leftExpr: LeftExpr,
  sourceLine: number
): boolean {
  if (leftExpr.tag == 'arr_offset_int' || leftExpr.tag == 'arr_offset_slice') {
    return enumCheckLeftExpr(set, leftExpr.val.var, sourceLine);
  }
  else if (leftExpr.tag == 'dot') {
    if (leftExpr.val.left.tag == 'left_expr' && leftExpr.val.left.type.tag == 'enum') {
      let possible = getVariantPossibilities(set, leftExpr.val.left.val);
      if (possible.length == 0 || !possible.includes(leftExpr.val.varName)) {
        logError(sourceLine, `enum can not be "${leftExpr.val.varName}"`)
        
        return false;
      }
      else if (possible.length > 1 || possible[0] != leftExpr.val.varName) {
        logError(sourceLine, `enum can be ${JSON.stringify(possible)}`);
        return false;
      }
    } else {
      return enumCheckExpr(set, leftExpr.val.left, sourceLine);
    }
  }

  // single variables are always valid
  return true;
}

function enumCheckExpr(
  set: VariantSet[],
  expr: Expr,
  sourceLine: number
): boolean {
  if (expr.tag == 'bin') {
    let left: boolean = enumCheckExpr(set, expr.val.left, sourceLine);

    if (expr.val.op == '&&') {
      let leftSet = getExprSet(expr.val.left);
      set = unionsIntersection(set, leftSet);
    }

    let right: boolean = enumCheckExpr(set, expr.val.right, sourceLine);
    return left && right;
  }
  else if (expr.tag == 'not' || expr.tag == 'assert' || expr.tag == 'linked') {
    return enumCheckExpr(set, expr.val, sourceLine);
  }
  else if (expr.tag == 'struct_init') {
    for (let init of expr.val) {
      if (enumCheckExpr(set, init.expr, sourceLine) == false) {
        return false;
      }
    }
  }
  else if (expr.tag == 'fn_call') {
    for (let param of expr.val.exprs) {
      if (enumCheckExpr(set, param, sourceLine) == false) {
        return false;
      }
    }
  }
  else if (expr.tag == 'is') {
    let possible = getVariantPossibilities(set, expr.left);
    if (!possible.includes(expr.variant)) {
      logError(sourceLine, `enum can not be "${expr.variant}"`);
      return false;
    }

    return enumCheckLeftExpr(set, expr.left, sourceLine);
  }

  if (expr.tag == 'left_expr') {
    return enumCheckLeftExpr(set, expr.val, sourceLine);
  }

  // constants are always valid
  return true;
}

function enumCheckBody(body: Inst[]): boolean {
  let set: VariantSet[] = [];
  return enumCheckBodyRecur(set, body);
}

function enumCheckBodyRecur(set: VariantSet[], body: Inst[]): boolean {
  let allOk: boolean = true;
  for (let i = 0; i < body.length; i++) {
    let inst = body[i];

    // if statements can be broken into cond && !prevCondition
    // this holds the !previous condition
    let ifChain: VariantSet[] = [];
    // each elif / else will not be the previous if/elif's variants
    if (inst.tag == 'elif' || inst.tag == 'else') {
      for (let j = i - 1; j >= 0; j--) {
        let prevInst = body[j];
        if (prevInst.tag == 'if' || prevInst.tag == 'elif') {
          ifChain = unionsIntersection(ifChain, getReverseExprSet(prevInst.val.cond));
        }
      }
    }

    if (inst.tag == 'if' || inst.tag == 'elif' || inst.tag == 'while') {
      let bodySet = unionsIntersection(set, ifChain);
      if (enumCheckExpr(bodySet, inst.val.cond, inst.sourceLine) == false) {
        allOk = false;
        continue;
      }

      let condSet = unionsIntersection(getExprSet(inst.val.cond), bodySet);
      if (enumCheckBodyRecur(condSet, inst.val.body) == false) {
        allOk = false;
      }

      // if this path always returns, then everything after will not be this variant
      if (allPathsReturn(inst.val.body)) {
        let reverse = getReverseExprSet(inst.val.cond);
        let notCondSet = unionsIntersection(reverse, ifChain);
        set = unionsIntersection(set, notCondSet);
      }
    }
    else if (inst.tag == 'else') {
      let cloned = unionsIntersection(set, ifChain);
      if (enumCheckBodyRecur(cloned, inst.val) == false) {
        allOk = false;
      }

      if (allPathsReturn(inst.val)) {
        set = unionsIntersection(set, ifChain);
      }
    }
    else if (inst.tag == 'for_in') {
      let cloned = clone(set);
      if (enumCheckBodyRecur(cloned, inst.val.body) == false) {
        allOk = false;
      } 
    }
    else if (inst.tag == 'assign' || inst.tag == 'declare') {
      let leftExpr: LeftExpr = undefined!;
      if (inst.tag == 'assign') {
        leftExpr = inst.val.to;
      }
      else if (inst.tag == 'declare') {
        leftExpr = { tag: 'var', val: inst.val.name, type: inst.val.type };
      } 

      remove(set, leftExpr);
      if (enumCheckExpr(set, inst.val.expr, inst.sourceLine) == false) {
        allOk = false;
      }

      let expr = inst.val.expr;
      if (expr.tag == 'enum_init' && expr.type.tag == 'enum') {
        let possible = expr.type.val.fields.map(x => x.name);
        add(set, leftExpr, [expr.fieldName], possible);
      }
      else if (expr.type.tag == 'enum') {
        let possible = expr.type.val.fields.map(x => x.name);
        add(set, leftExpr, possible, possible);
      }
    } 
    else if (inst.tag == 'return' && inst.val != null) {
      if (enumCheckExpr(set, inst.val, inst.sourceLine) == false) {
        allOk = false;
      }
    } 
  }

  return allOk;
}
