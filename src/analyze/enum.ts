import { LeftExpr,  Expr } from './analyze';
import { logError } from '../index';
import { getVariantIndex } from './types';

export {
  PossibleVariants, getVariantPossibilities, applyCond, applyInverseCond,
  recursiveAddExpr, remove, VariantScope, enterScope, exitScope, peek
}

// variable -> possibilities
interface VariantSet {
  key: string[],
  totalSet: string[],
  currentSet: string[]
}

type PossibleVariants = VariantSet[]

type VariantScope = PossibleVariants[]

// the key intersection, value union (typically ||)
function intersectingUnion(a: PossibleVariants, b: PossibleVariants): PossibleVariants {
  let newSet: PossibleVariants = [];
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
function unionsIntersection(a: PossibleVariants, b: PossibleVariants): PossibleVariants {
  let newSet: PossibleVariants = [];
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

function add(
  set: PossibleVariants,
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

function indexOf(set: PossibleVariants, key: string[]): number {
  for (let i = 0; i < set.length; i++) {
    let allMatch = key.length == set[i].key.length;
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

function remove(scope: VariantScope, leftExpr: LeftExpr) {
  let key = leftExprToKey(leftExpr);
  if (key == null) {
    return;
  }

  for (let i = scope.length - 1; i >= 0; i--) {
    for (let j = scope[i].length - 1; j >= 0; j--) {
      let entry = scope[i][j];
      if (key.length > entry.key.length) {
        continue;
      }

      // remove if entry.key starts with key
      let shouldRemove = true;
      for (let i = 0; i < key.length; i++) {
        if (entry.key[i] != key[i]) {
          shouldRemove = false;
          break;
        }
      }

      if (shouldRemove) {
        scope[i].splice(j, 1);
      }
    }
  }
}

function enterScope(scope: VariantScope) {
  scope.push([]);
}

function exitScope(scope: VariantScope) {
  scope.pop();
}

function peek(scope: VariantScope) {
  return scope[scope.length - 1];
}

function getVariantPossibilities(scope: VariantScope, leftExpr: LeftExpr): string[] {
  let key = leftExprToKey(leftExpr);
  if (key == null) {
    return [];
  }

  for (let i = scope.length - 1; i >= 0; i--) {
    let index = indexOf(scope[i], key);
    if (index != -1) {
      return Array.from(scope[i][index].currentSet.values());
    }
  }

  if (leftExpr.type.tag == 'enum') {
    return leftExpr.type.val.fields.map(x => x.name);
  } else {
    return [];
  }
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
    else if (currExpr.tag == 'prime') {
      if (currExpr.val.tag == 'left_expr') {
        output.push('\'');
        currExpr = currExpr.val.val;
      } else {
        return null;
      }
    }
    else {
      return null;
    }
  }
  return output.reverse();
}

function getInverseExprSet(expr: Expr): PossibleVariants {
  if (expr.tag == 'bin' && expr.val.op == '||') {
    let left = getInverseExprSet(expr.val.left);
    let right = getInverseExprSet(expr.val.right);
    return unionsIntersection(left, right);
  }
  else if (expr.tag == 'bin' && expr.val.op == '&&') {
    let left = getInverseExprSet(expr.val.left);
    let right = getInverseExprSet(expr.val.right);
    return intersectingUnion(left, right);
  }
  else if (expr.tag == 'is') {
    if (expr.left.type.tag == 'enum') {
      let key = expr.left;
      let newSet: PossibleVariants = [];
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
    return getExprSet(expr.val);
  }

  return [];
}

// used for if/while/elif statements to get the new
// set that can be used. note that enumCheckExpr should
// be called before getExprSet or the errors may be weird
function getExprSet(expr: Expr): PossibleVariants {
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
      let newSet: PossibleVariants = [];
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
    return getInverseExprSet(expr.val);
  }

  return [];
}

function applyCond(
  scope: VariantScope,
  cond: Expr | null,
  ifConds: Expr[],
) {

  // if statements can be broken into cond && !prevCondition
  // this holds the !previous condition
  let ifChainVariants: PossibleVariants = [];
  for (let i = 0; i < ifConds.length; i++) {
    ifChainVariants = unionsIntersection(ifChainVariants, getInverseExprSet(ifConds[i]));
  }

  let bodySet = unionsIntersection(scope[scope.length - 1], ifChainVariants);
  if (cond != null) {
    bodySet = unionsIntersection(getExprSet(cond), bodySet);
  }

  scope[scope.length - 1] = bodySet;
}

function applyInverseCond(
  scope: VariantScope,
  cond: Expr | null,
  ifConds: Expr[]
) {

  // if statements can be broken into cond && !prevCondition
  // this holds the !previous condition
  let ifChainVariants: PossibleVariants = [];
  for (let i = 0; i < ifConds.length; i++) {
    ifChainVariants = unionsIntersection(ifChainVariants, getInverseExprSet(ifConds[i]));
  }

  let notCondSet = ifChainVariants;
  if (cond != null) {
    let reverse = getInverseExprSet(cond);
    notCondSet = unionsIntersection(reverse, ifChainVariants);
  }

  scope[scope.length - 1] = unionsIntersection(scope[scope.length - 1], notCondSet);
}

function recursiveAddExpr(scope: VariantScope, leftExpr: LeftExpr, expr: Expr) {
  let set = scope[scope.length - 1];
  if (expr.tag == 'enum_init' && expr.type.tag == 'enum') {
    let possible = expr.type.val.fields.map(x => x.name);
    add(set, leftExpr, [expr.fieldName], possible);
    // handle int?? a = some(some(20)) where a'' is int
    if (expr.fieldExpr != null) {
      let newLeftExpr: LeftExpr = {
        tag: 'prime',
        val: {
          tag: 'left_expr',
          val: leftExpr,
          type: expr.fieldExpr.type
        },
        variant: expr.fieldName,
        variantIndex: getVariantIndex(expr.type, expr.fieldName),
        type: expr.fieldExpr.type
      };
      recursiveAddExpr(scope, newLeftExpr, expr.fieldExpr);
    }
  }
  else if (expr.tag == 'struct_init') {
    for (let field of expr.val) {
      let asExpr: Expr = { tag: 'left_expr', val: leftExpr, type: field.expr.type };
      let newLeftExpr: LeftExpr = {
        tag: 'dot',
        val: {
          varName: field.name,
          left: asExpr,
        },
        type: field.expr.type 
      }; 
      recursiveAddExpr(scope, newLeftExpr, field.expr);
    }
  }
}

/*
function enumCheckBodyRecur(set: PossibleVariants, body: Inst[]): boolean {
  let allOk: boolean = true;
  for (let i = 0; i < body.length; i++) {
    let inst = body[i];


    if (inst.tag == 'if' || inst.tag == 'elif' || inst.tag == 'while') {
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

      enumCheckLeftExpr(set, leftExpr, inst.sourceLine);

      if (enumCheckExpr(set, inst.val.expr, inst.sourceLine) == false) {
        allOk = false;
      }

      recursiveAddExpr(set, leftExpr, inst.val.expr);
    } 
    else if (inst.tag == 'return' && inst.val != null) {
      if (enumCheckExpr(set, inst.val, inst.sourceLine) == false) {
        allOk = false;
      }
    } 
    else if (inst.tag == 'fn_call') {
      for (let expr of inst.val.exprs) {
        if (enumCheckExpr(set, expr, inst.sourceLine) == false) {
          allOk = false;
        }
      }
      removeIfLinked(set, inst.val);
    }
  }

  return allOk;
}

*/

