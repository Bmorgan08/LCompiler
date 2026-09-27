import { Node } from "./Parser";
import { SymbolEntry, Scope, resolve, createScope, define, registerStruct, StructDef, lookupStruct, StructField, tupleTypeParts, fnTypeParts, mapTypeParts } from "./Scope";
import { Ltype } from "./Scope";
import { findFreshFunctions, isFreshHeapExpr } from "./Fresh";

function err(node: Node, msg: string): never {
    const prefix = (node.line && node.col) ? `${node.line}:${node.col}: ` : "";
    throw new Error(prefix + msg);
}

// ── Types ──
// Scalars (int, float, bool, char) and strings are values: assigning one copies it. Arrays,
// structs and tuples are heap values that variables share by pointer.
// a function value (fn(int): int) is a plain address, copied like a number
const isScalar = (t: Ltype | undefined) => t === "int" || t === "float" || t === "bool" || t === "char" || t === "string" || !!t?.startsWith("fn(");
const isHeapType = (t: Ltype | undefined) => !!t && !isScalar(t) && t !== "unknown" && t !== "void";
const elemOf = (t: Ltype | undefined): Ltype | undefined => t?.endsWith("[]") ? t.slice(0, -2) : mapTypeParts(t)?.value;
const isMapType = (t: Ltype | undefined) => !!mapTypeParts(t);
// map keys are compared by value: numbers, chars, bools and strings
const MAP_KEY_TYPES = ["int", "float", "char", "bool", "string"];
const structName = (t: Ltype | undefined): string | undefined => t && /^[A-Z]/.test(t) && !t.endsWith("[]") ? t : undefined;

// ── Ownership ──
// A heap variable is either an owner (it was given a new value, which it frees) or a borrower
// (it was given a value something else owns: another variable, an array element, a struct
// field, a parameter, a global, or a call that may hand back one of its arguments). A borrower
// records the "roots" it points into. Freeing happens in Optimize.ts insertFrees; these checks
// make sure nothing is used after that:
//  - a borrower is stale once a root may have freed what it points at: the root was reassigned,
//    had an array/struct inside it replaced, was moved into a container, or was passed to a
//    function that may change it (or, for a global, one that may reassign it)
//  - a borrower can't outlive its roots, be stored into a container, or be returned when it
//    points into a local
//  - a global can only be given a value nothing else points to, and can't be moved, stored or
//    returned (its old value is freed when it is reassigned)
let moved = new Set<SymbolEntry>();                      // moved or stale: can't be used until reassigned
const staleReason = new Map<SymbolEntry, string>();
let borrows = new Map<SymbolEntry, Set<SymbolEntry>>();  // borrower -> roots it may point into
let ownedLocals = new Set<SymbolEntry>();                // locals holding a value nothing else points to
let iterating: SymbolEntry[] = [];                       // roots behind the for-in loops being checked
const symScope = new Map<SymbolEntry, Scope>();

let programScope: Scope | undefined;
let heapGlobalNames = new Set<string>();
const heapGlobals = new Set<SymbolEntry>();
let freshFunctions = new Set<string>();
let reassigns = new Map<string, Set<string>>();          // function (".name" for a method) -> globals it may reassign
let mutates = new Map<string, Set<number>>();            // function -> params whose contents it may replace (0 = this for a method)
let paramTypes = new Map<string, (string | undefined)[]>(); // function -> declared parameter types
let currentReturnType: Ltype | undefined;                // the declared return type of the function being checked
let methodParamTypes = new Map<string, (string | undefined)[]>();   // "Struct.method" -> declared parameter types

// built-ins' parameter types ("any" accepts anything)
const BUILTIN_PARAMS: Record<string, string[]> = {
    print: ["any"], printchar: ["int"], len: ["string"], inttostr: ["int"], strtoint: ["string"],
    chartostr: ["char"], str_upper: ["string"], str_lower: ["string"],
    str_find: ["string", "string"], str_contains: ["string", "string"], floattostr: ["float"],
};

// arguments must fit their parameters the way a value fits a variable: numbers convert, a child
// struct fits its parent, and strings, arrays, structs and tuples must match
function checkArgs(fn: string, want: (string | undefined)[] | undefined, args: Node[], scope: Scope) {
    want?.forEach((t, i) => {
        const arg = args[i];
        if (!t || t === "any" || t === "unknown" || !arg) return;
        adoptLiteralType(arg, t);
        const got = inferType(arg, scope);
        if (!fits(t, got)) err(arg, `Argument ${i + 1} of ${fn} should be ${t}, not ${got}`);
    });
}

// the declared parameter types of `method` on struct `s` (its own, or inherited)
function methodParams(s: string, method: string): (string | undefined)[] | undefined {
    for (let t: string | undefined = s; t; t = lookupStruct(t)?.parent) {
        const p = methodParamTypes.get(`${t}.${method}`);
        if (p) return p;
    }
    return undefined;
}

function scopeDepth(s: Scope | undefined): number {
    let d = 0;
    for (let c = s; c; c = c.parent) d++;
    return d;
}

function markStale(local: SymbolEntry, reason: string) {
    moved.add(local);
    staleReason.set(local, reason);
    borrows.delete(local);
}

// `root` may have freed (part of) what it pointed at: everything borrowing from it is stale
function rootChanged(root: SymbolEntry, node: Node, why: string) {
    if (iterating.includes(root)) {
        err(node, `${root.name} ${why} inside a for-in loop over it; what the loop is reading could be freed`);
    }
    for (const [local, roots] of borrows) {
        if (!roots.has(root)) continue;
        markStale(local, `${local.name} refers to ${root.name}'s value, which may have been freed when ${root.name} ${why}; assign ${local.name} a new value before using it again`);
    }
}

// the variable an lvalue/read like d.tags[i] or ps[i].x ultimately reads from
function baseVariable(node: Node): Node | undefined {
    switch (node.type) {
        case "Identifier": case "This": return node;
        case "ArrayAccess": case "ArrayAccess2D" as any: case "ArraySlice":
            return { type: "Identifier", value: node.value, children: [] };
        case "FieldAccess": case "IndexExpr": case "TupleAccess": case "SliceExpr": case "LenExpr":
            return baseVariable(node.children[0]);
        default: return undefined;
    }
}

// the roots `value` may point into (empty for a new value or a scalar)
function rootsBehind(value: Node, scope: Scope): Set<SymbolEntry> {
    const out = new Set<SymbolEntry>();
    const add = (s: Set<SymbolEntry>) => s.forEach(r => out.add(r));
    switch (value.type) {
        case "Identifier": case "This": {
            const sym = resolve(value.type === "This" ? "this" : value.value!, scope);
            if (!sym) break;
            const b = borrows.get(sym);
            if (b) add(b);
            else if (isHeapType(sym.type) || sym.structType || sym.type === "unknown") out.add(sym);
            break;
        }
        case "ArrayAccess": case "ArrayAccess2D" as any: case "FieldAccess": case "IndexExpr": case "TupleAccess": {
            const base = baseVariable(value);
            if (base) add(rootsBehind(base, scope));
            break;
        }
        case "Call":
            if (value.value!.includes(".")) {
                add(rootsBehind({ type: "Identifier", value: value.value!.split(".")[0], children: [] }, scope));
                value.children.forEach(a => add(rootsBehind(a, scope)));
            } else if (!freshFunctions.has(value.value!)) {
                value.children.forEach(a => add(rootsBehind(a, scope)));
            }
            break;
        case "MethodCall":
            value.children.forEach(a => add(rootsBehind(a, scope)));
            break;
    }
    return out;
}

const isGlobal = (sym: SymbolEntry) => heapGlobals.has(sym);
const isParam = (sym: SymbolEntry) => sym.kind === "param" || sym.name === "this";

// `sym` (a local, not a global) is given `value`: it becomes an owner, a borrower, or neither
function bind(sym: SymbolEntry, value: Node, scope: Scope, node: Node) {
    borrows.delete(sym);
    ownedLocals.delete(sym);
    if (isFreshHeapExpr(value, freshFunctions)) { ownedLocals.add(sym); return; }
    const t = inferType(value, scope);
    if (isScalar(t)) return;
    const roots = rootsBehind(value, scope);
    roots.delete(sym);
    if (roots.size === 0) return;
    for (const r of roots) {
        if (isGlobal(r) || isParam(r)) continue;
        if (scopeDepth(symScope.get(sym)) < scopeDepth(symScope.get(r))) {
            err(node, `${sym.name} would still refer to ${r.name}'s value after ${r.name} goes out of scope`);
        }
    }
    borrows.set(sym, roots);
}

// `value` is stored into an array, struct or tuple, which then owns (and frees) it
function markMoved(value: Node, scope: Scope) {
    if (isFreshHeapExpr(value, freshFunctions)) return;
    const t = inferType(value, scope);
    if (isScalar(t)) return;                        // copied (strings are copied in IR.ts)
    if (value.type !== "Identifier") {
        if (rootsBehind(value, scope).size > 0) {
            err(value, `this value belongs to another variable, array or struct, so it can't be stored here too`);
        }
        return;
    }
    const sym = resolve(value.value!, scope);
    if (!sym) return;
    if (isGlobal(sym) || [...(borrows.get(sym) ?? [])].some(isGlobal)) {
        err(value, `${value.value} holds a global's value, which can't be moved into an array, struct or tuple`);
    }
    if (borrows.has(sym)) {
        err(value, `${value.value} refers to a value owned elsewhere, so it can't be stored into an array, struct or tuple`);
    }
    if (isParam(sym)) {
        err(value, `${value.value} belongs to the caller, so it can't be stored into an array, struct or tuple`);
    }
    if (isHeapType(sym.type) || sym.structType) {
        rootChanged(sym, value, "was moved into an array or struct");
        moved.add(sym);
        staleReason.delete(sym);
        ownedLocals.delete(sym);
    }
}

function checkNotMoved(sym: SymbolEntry, node: Node) {
    if (moved.has(sym)) err(node, staleReason.get(sym) ?? `${sym.name} was stored into an array or struct; assign it a new value before using it again`);
}

function cloneBorrows() {
    return new Map([...borrows].map(([k, v]) => [k, new Set(v)]));
}

function mergeBorrows(into: Map<SymbolEntry, Set<SymbolEntry>>, from: Map<SymbolEntry, Set<SymbolEntry>>) {
    for (const [local, gs] of from) {
        const set = into.get(local) ?? new Set<SymbolEntry>();
        gs.forEach(g => set.add(g));
        into.set(local, set);
    }
}

// Each branch starts from the same state; afterwards a variable is moved (or a borrower) if any
// branch made it so. `mayRunNone` covers an `if` without an `else`.
function validateBranches(branches: (() => void)[], mayRunNone: boolean) {
    const before = moved;
    const after = new Set<SymbolEntry>(mayRunNone ? before : []);
    const borrowsBefore = cloneBorrows();
    const borrowsAfter = mayRunNone ? cloneBorrows() : new Map<SymbolEntry, Set<SymbolEntry>>();
    for (const run of branches) {
        moved = new Set(before);
        borrows = new Map([...borrowsBefore].map(([k, v]) => [k, new Set(v)]));
        run();
        for (const sym of moved) after.add(sym);
        mergeBorrows(borrowsAfter, borrows);
    }
    moved = after;
    borrows = borrowsAfter;
}

// A loop body runs zero or more times. Checking it twice catches a change late in the body
// followed by a use early in the next iteration; zero iterations keeps the state before it.
function validateLoopBody(parts: Node[], scope: Scope) {
    const before = new Set(moved);
    const borrowsBefore = cloneBorrows();
    for (let pass = 0; pass < 2; pass++) parts.forEach(p => validate(p, scope));
    for (const s of before) moved.add(s);
    mergeBorrows(borrows, borrowsBefore);
}

function calleeKey(call: Node): string {
    if (call.type === "MethodCall") return "." + call.value!;
    return call.value!.includes(".") ? "." + call.value!.split(".")[1] : call.value!;
}

// the value given to heap global `g` must be one nothing else points to
function checkGlobalValue(g: string, value: Node, scope: Scope) {
    if (isFreshHeapExpr(value, freshFunctions)) return;
    if (value.type === "Identifier") {
        const sym = resolve(value.value!, scope);
        if (sym && ownedLocals.has(sym)) {
            moved.add(sym);          // the local's value now belongs to the global
            staleReason.delete(sym);
            ownedLocals.delete(sym);
            return;
        }
    }
    err(value, `global ${g} can only be given a new value (new, a literal, a struct or tuple, a slice, a call to a function that always returns a new value, or a local that owns its value), since its old value is freed when it is reassigned`);
}

// top-level variables that hold an array, struct or tuple
function findHeapGlobalNames(ast: Node): Set<string> {
    const names = new Set<string>();
    for (const c of ast.children) {
        if (c.type !== "VarDecl") continue;
        const t = c.varType ?? "";
        if (t.endsWith("[]") || /^[A-Z]/.test(t) || isFreshHeapExpr(c.children[0], freshFunctions)) names.add(c.value!);
    }
    return names;
}

// every function and method body, keyed like calleeKey, with its parameter names (a method's
// receiver is "this", parameter 0)
function functionBodies(ast: Node): { key: string, params: string[], body: Node }[] {
    const out: { key: string, params: string[], body: Node }[] = [];
    for (const c of ast.children) {
        if (c.type === "Function") {
            out.push({ key: c.value!, params: c.children.filter(p => p.type === "Identifier").map(p => p.value!), body: c });
        }
        if (c.type === "StructDef") {
            (function methods(n: Node) {
                if (n.type === "StructMethod") {
                    out.push({ key: "." + n.value!, params: ["this", ...n.children.filter(p => p.type === "Identifier").map(p => p.value!)], body: n });
                }
                n.children.forEach(methods);
            })(c);
        }
    }
    return out;
}

// function -> the heap globals it may reassign, directly or through its calls
function findGlobalReassigns(ast: Node): Map<string, Set<string>> {
    const direct = new Map<string, Set<string>>();
    const calls = new Map<string, Set<string>>();
    for (const { key, body } of functionBodies(ast)) {
        if (!direct.has(key)) { direct.set(key, new Set()); calls.set(key, new Set()); }
        (function walk(n: Node) {
            if (n.type === "Assign" && heapGlobalNames.has(n.value!)) direct.get(key)!.add(n.value!);
            if (n.type === "Call" || n.type === "MethodCall") calls.get(key)!.add(calleeKey(n));
            n.children.forEach(walk);
        })(body);
    }
    // a call through a function value may do anything: assume it reassigns every heap global
    const known = (k: string) => direct.has(k) || k.startsWith(".") || resolve(k, programScope!)?.kind === "func";
    for (const [fn, callees] of calls) for (const callee of callees) if (!known(callee)) heapGlobalNames.forEach(g => direct.get(fn)!.add(g));
    let changed = true;
    while (changed) {
        changed = false;
        for (const [fn, callees] of calls) {
            for (const callee of callees) {
                for (const g of direct.get(callee) ?? []) {
                    if (!direct.get(fn)!.has(g)) { direct.get(fn)!.add(g); changed = true; }
                }
            }
        }
    }
    return direct;
}

// function -> the parameters whose contents it may change (assign into a field or element of,
// directly, through a local copied from it, or by passing it on to a function that does)
function findParamMutations(ast: Node): Map<string, Set<number>> {
    const result = new Map<string, Set<number>>();
    const passes: { from: string, param: number, callee: string, arg: number }[] = [];
    const rootName = (n: Node): string | undefined => {
        if (n.type === "This") return "this";
        const b = baseVariable(n);
        return b?.type === "This" ? "this" : b?.value;
    };
    for (const { key, params, body } of functionBodies(ast)) {
        const set = result.get(key) ?? new Set<number>();
        result.set(key, set);
        const alias = new Map<string, number>(params.map((p, i) => [p, i]));
        (function walk(n: Node) {
            if ((n.type === "VarDecl" || n.type === "Assign") && n.children[0]) {
                const r = rootName(n.children[0]);
                if (r !== undefined && alias.has(r)) alias.set(n.value!, alias.get(r)!);
            }
            if (["FieldAssign", "IndexAssign", "ArrayAssign", "ArrayAssign2D"].includes(n.type)) {
                const r = n.type === "ArrayAssign" || n.type === ("ArrayAssign2D" as any) ? n.value! : rootName(n.children[0]);
                if (r !== undefined && alias.has(r)) set.add(alias.get(r)!);
            }
            if ((n.type === "Call" && n.value!.includes(".")) || n.type === "MethodCall") {
                const method = n.type === "MethodCall" ? n.value! : n.value!.split(".")[1];
                const recv = n.type === "MethodCall" ? rootName(n.children[0]) : n.value!.split(".")[0];
                if ((method === "pop" || method === "remove") && recv !== undefined && alias.has(recv)) set.add(alias.get(recv)!);
            }
            if (n.type === "Call" || n.type === "MethodCall") {
                const args = n.type === "MethodCall" ? n.children
                    : n.value!.includes(".") ? [{ type: "Identifier", value: n.value!.split(".")[0], children: [] } as Node, ...n.children]
                    : n.children;
                args.forEach((a, i) => {
                    const r = rootName(a);
                    if (r !== undefined && alias.has(r)) passes.push({ from: key, param: alias.get(r)!, callee: calleeKey(n), arg: i });
                });
            }
            n.children.forEach(walk);
        })(body);
    }
    // passing a parameter to a function value's call: assume it changes it
    const knownFn = (k: string) => result.has(k) || k.startsWith(".") || resolve(k, programScope!)?.kind === "func";
    for (const p of passes) if (!knownFn(p.callee)) result.get(p.from)!.add(p.param);
    let changed = true;
    while (changed) {
        changed = false;
        for (const p of passes) {
            if (result.get(p.callee)?.has(p.arg) && !result.get(p.from)!.has(p.param)) {
                result.get(p.from)!.add(p.param);
                changed = true;
            }
        }
    }
    return result;
}

// a call: nothing passed in may be freed by it, and borrowers of what it changes go stale
// a call through a function value (or a function we know nothing about): assume it may reassign
// every heap global and change every argument
function isUnknownCallee(key: string): boolean {
    if (key.startsWith(".")) return false;               // methods are summarised by name
    return !reassigns.has(key) && resolve(key, programScope!)?.kind !== "func";
}

function checkCall(node: Node, args: Node[], scope: Scope) {
    const key = calleeKey(node);
    if (isUnknownCallee(key)) {
        for (const g of heapGlobals) rootChanged(g, node, "may have been reassigned by a function value's call");
        args.forEach(a => { for (const root of rootsBehind(a, scope)) rootChanged(root, node, `was passed to ${node.value}, which may change it`); });
        return;
    }
    const r = reassigns.get(key);
    if (r && r.size > 0) {
        for (const a of args) {
            for (const g of rootsBehind(a, scope)) {
                if (isGlobal(g) && r.has(g.name)) err(a, `${node.type === "MethodCall" ? node.value : node.value} may reassign ${g.name}, which would free the value passed here while it is still in use`);
            }
        }
        for (const g of heapGlobals) if (r.has(g.name)) rootChanged(g, node, "was reassigned");
    }
    const m = mutates.get(key);
    if (m && m.size > 0) {
        args.forEach((a, i) => {
            if (!m.has(i)) return;
            for (const root of rootsBehind(a, scope)) rootChanged(root, node, `was passed to ${node.value}, which may change it`);
        });
    }
}

function validateStructMethod(method: Node, structName: string, parentScope: Scope) {
    currentReturnType = method.varType;
    moved = new Set();
    borrows = new Map();
    ownedLocals = new Set();
    staleReason.clear();
    iterating = [];
    const methodScope = createScope(parentScope)

    define(methodScope, {
        name: "this",
        kind: "param",
        type: structName,
        structType: structName
    })

    method.children
        .filter(c => c.type === "Identifier")
        .forEach(p => {
            define(methodScope, {
                name: p.value!,
                kind: "param",
                type: p.varType ?? "unknown",
                structType: p.varType && /^[A-Z]/.test(p.varType) && !p.varType.endsWith("[]") ? p.varType : undefined
            });
        });

    const body = method.children.find(c => c.type === "Block")
    if(body) validate(body, methodScope)
}

// The type of a binary expression, rejecting operand types that don't fit its operator.
// int, float, char and bool mix freely (IR.ts converts the int side of a float operation);
// strings concatenate with strings and compare with strings (==, !=, <, <=, >, >=). An operand
// of unknown type (e.g. some call results) isn't checked.
function binaryType(node: Node, scope: Scope): Ltype {
    const op = node.value!;
    const left = inferType(node.children[0], scope);
    const right = inferType(node.children[1], scope);
    const numeric = (t: Ltype) => t === "int" || t === "float" || t === "char" || t === "bool";
    const known = left !== "unknown" && right !== "unknown";
    const bothNumeric = numeric(left) && numeric(right);
    const bothStrings = left === "string" && right === "string";
    const mismatch = (): never => err(node, `Type mismatch: can't use '${op}' on ${left} and ${right}`);

    if (op === "&&" || op === "||") {
        if (known && !bothNumeric) mismatch();
        return "bool";
    }
    if (op === "<" || op === "<=" || op === ">" || op === ">=") {
        if (known && !bothNumeric && !bothStrings) mismatch();
        return "bool";
    }
    if (left === "none" || right === "none") {
        const other = left === "none" ? right : left;
        if (op !== "==" && op !== "!=") err(node, `none can only be compared with == or !=`);
        if (other !== "unknown" && other !== "none" && isScalar(other) && other !== "string") err(node, `Can't compare ${other} with none`);
        return "bool";
    }
    if (op === "==" || op === "!=") {
        if (known && !bothNumeric && left !== right) mismatch();
        return "bool";
    }
    if (op === "+" && (left === "string" || right === "string")) {
        if (known && left !== right) mismatch();
        return "string";
    }
    if (op === "%" && (left === "float" || right === "float")) {
        err(node, `'%' needs whole numbers; use math_fmod for floats`);
    }
    if (!known) return left === "unknown" ? right : left;
    if (!bothNumeric) mismatch();
    return left === "float" || right === "float" ? "float" : "int";
}

// `child` is `ancestor` or extends it (directly or through its parents)
function isSubStruct(child: string, ancestor: string): boolean {
    for (let s: string | undefined = child; s; s = lookupStruct(s)?.parent) if (s === ancestor) return true;
    return false;
}

// the nearest struct that every one of `names` is or extends, if there is one
function commonAncestor(names: string[]): string | undefined {
    for (let s: string | undefined = names[0]; s; s = lookupStruct(s)?.parent) {
        if (names.every(n => isSubStruct(n, s!))) return s;
    }
    return undefined;
}

// a value of type `inferred` can go where `declared` is expected: equal, a struct that extends
// the declared struct, or a tuple whose elements each fit (an unknown element is accepted)
function fits(declared: string, inferred: string): boolean {
    if (declared === inferred || inferred === "unknown") return true;
    if (structName(declared) && structName(inferred)) return isSubStruct(inferred, declared);
    const numeric = (t: string) => t === "int" || t === "float" || t === "char" || t === "bool";
    if (numeric(declared) && numeric(inferred)) return true;
    if (declared.startsWith("(") && inferred.startsWith("(") && declared.endsWith(")") && inferred.endsWith(")")) {
        const d = tupleTypeParts(declared), i = tupleTypeParts(inferred);
        return d.length === i.length && d.every((t, k) => fits(t, i[k]));
    }
    return false;
}

// the struct a value is an instance of, if it is one
function structOf(node: Node, scope: Scope): string | undefined {
    if (node.type === "This") return resolve("this", scope)?.structType;
    if (node.type === "Identifier") {
        const sym = resolve(node.value!, scope);
        return sym?.structType ?? structName(sym?.type);
    }
    return structName(inferType(node, scope));
}

// the field being accessed; undefined when the value's type isn't known here (e.g. the result of
// a user function call: IR.ts knows those and reports an unknown field itself)
function fieldOf(obj: Node, fieldName: string, scope: Scope, at: Node): StructField | undefined {
    const s = structOf(obj, scope);
    if (!s && obj.type !== "Identifier" && obj.type !== "This" && inferType(obj, scope) === "unknown") return undefined;
    if (!s) err(at, `'${obj.type === "Identifier" ? obj.value : "this value"}' is not a struct`);
    const def = lookupStruct(s);
    if (!def) err(at, `Unknown struct type: ${s}`);
    const field = def.fields.find(f => f.name === fieldName);
    if (!field) err(at, `Unknown field '${fieldName}' on struct '${s}'`);
    return field;
}

function inferType(node: Node, scope: Scope): Ltype {
    switch (node.type) {
        case "Number":
            return node.varType === "float" ? "float" : node.varType === "bool" ? "bool" : "int";

        case "String":
            return "string";

        case "Char":
            return "char";

        case "None":
            return "none";

        case "ArrayLiteral": {
            if (node.varType) return node.varType;
            const types = node.children.map(c => inferType(c, scope)).filter(t => t !== "unknown");
            if (types.length === 0) return "int[]";
            if (types.every(t => t === "int" || t === "float" || t === "char" || t === "bool")) {
                return types.includes("float") ? "float[]" : types.every(t => t === "char") ? "char[]" : "int[]";
            }
            if (types.some(t => t !== types[0])) {
                // structs from one family make an array of their nearest common parent
                const common = types.every(t => structName(t)) ? commonAncestor(types) : undefined;
                if (common) return `${common}[]`;
                err(node, `Array elements must all have the same type (got ${[...new Set(types)].join(" and ")})`);
            }
            return `${types[0]}[]`;
        }

        case "ArrayNew":
            return node.varType ?? "int[]";

        case "MapLiteral": {
            if (node.varType) return node.varType;
            if (node.children.length === 0) return "unknown";   // {} takes its type from where it goes
            return `map<${inferType(node.children[0], scope)},${inferType(node.children[1], scope)}>`;
        }

        case "ArrayLen":
        case "LenExpr":
            return "int";

        case "ArrayAccess": {
            const sym = resolve(node.value!, scope);
            if (!sym) err(node, `Undefined identifier: ${node.value}`);
            if (sym.type === "string") return "char";
            if (isMapType(sym.type)) return elemOf(sym.type)!;
            return elemOf(sym.type) ?? "int";
        }

        case "ArrayAccess2D" as any: {
            const sym = resolve(node.value!, scope);
            return elemOf(elemOf(sym?.type)) ?? "int";
        }

        case "IndexExpr": {
            const base = inferType(node.children[0], scope);
            if (base === "string") return "char";
            return elemOf(base) ?? "unknown";
        }

        case "ArraySlice": {
            const sym = resolve(node.value!, scope);
            return sym?.type ?? "unknown";
        }

        case "SliceExpr":
            return inferType(node.children[0], scope);

        case "Identifier": {
            const sym = resolve(node.value!, scope);
            if (!sym) err(node, `Undefined identifier: ${node.value}`);
            if (sym.kind === "func") return functionValueType(node.value!, node);
            return sym.type ?? sym.structType ?? "unknown";
        }

        case "This":
            return resolve("this", scope)?.structType ?? "unknown";

        case "FieldAccess": {
            const s = structOf(node.children[0], scope);
            const field = s ? lookupStruct(s)?.fields.find(f => f.name === node.value) : undefined;
            return field?.type ?? "unknown";
        }

        case "StructInstantiate":
            return node.value!;

        case "Tuple":
            return `(${node.children.map(c => inferType(c, scope)).join(",")})`;

        case "TupleAccess": {
            const t = inferType(node.children[0], scope);
            if (!t.startsWith("(") || !t.endsWith(")")) return "unknown";
            const parts = tupleTypeParts(t);
            const i = Number(node.value);
            if (i >= parts.length) err(node, `Tuple of ${parts.length} elements has no element ${i}`);
            return parts[i];
        }

        case "Unary":
            return inferType(node.children[0], scope);

        case "Binary":
            return binaryType(node, scope);

        case "MethodCall": {
            const recv = inferType(node.children[0], scope);
            if (isArrayType(recv)) return node.value === "pop" || node.value === "remove" ? (elemOf(recv) ?? "unknown") : "void";
            if (isMapType(recv)) return mapMethodType(recv, node.value!);
            const s = structName(recv);
            return (s && lookupStruct(s)?.methods.get(node.value!)?.returnType) || "unknown";
        }

        case "Call": {
            if (node.value!.includes(".")) {
                const [obj, method] = node.value!.split(".");
                const recv = obj === "this" ? "unknown" : (resolve(obj, scope)?.type ?? "unknown");
                if (isArrayType(recv)) return method === "pop" || method === "remove" ? (elemOf(recv) ?? "unknown") : "void";
                if (isMapType(recv)) return mapMethodType(recv, method);
                const s = obj === "this" ? resolve("this", scope)?.structType : (resolve(obj, scope)?.structType ?? structName(recv));
                return (s && lookupStruct(s)?.methods.get(method)?.returnType) || "unknown";
            }
            const sym = resolveCallee(node.value!, scope);
            const fnType = sym && sym.kind !== "func" ? fnTypeParts(String(sym.type ?? "")) : undefined;
            if (fnType) return fnType.ret;
            return sym?.type ?? "unknown";
        }

        default:
            return "unknown";
    }
}

// an assignment `target = value` into an array element or struct field: check the value fits,
// move it into the container, and mark borrowers stale if a heap value there is replaced
// an empty literal ({} or []) takes its type from where it goes
function adoptLiteralType(value: Node, t: Ltype | undefined) {
    if (!t) return;
    if (value.type === "MapLiteral" && isMapType(t) && (value.children.length === 0 || !value.varType)) value.varType = t;
    if (value.type === "ArrayLiteral" && t.endsWith("[]") && value.children.length === 0) value.varType = t;
}

function assignIntoContainer(slotType: Ltype | undefined, base: Node, value: Node, scope: Scope, node: Node) {
    adoptLiteralType(value, slotType);
    if (value.type === "None") {
        if (slotType && slotType !== "unknown" && (isScalar(slotType) && slotType !== "string")) err(value, `${/^[aeiou]/.test(slotType) ? "An" : "A"} ${slotType} field can't be none (only string, array and struct fields can)`);
        const b = baseVariable(base);
        if (b) for (const root of rootsBehind(b, scope)) rootChanged(root, node, "had part of it replaced");
        return;
    }
    const valueType = inferType(value, scope);
    const numeric = (t: Ltype | undefined) => t === "int" || t === "float" || t === "char" || t === "bool";
    if (slotType && slotType !== "unknown" && valueType !== "unknown" && slotType !== valueType &&
        !(numeric(slotType) && numeric(valueType)) && !fits(String(slotType), valueType)) {
        err(node, `Type mismatch: can't store ${valueType} where ${slotType} is expected`);
    }
    markMoved(value, scope);
    if (!isScalar(slotType)) {
        const b = baseVariable(base);
        if (b) for (const root of rootsBehind(b, scope)) rootChanged(root, node, "had part of it replaced");
    }
}

// a slice copies its elements: numbers and strings can be copied, but arrays and structs are
// owned by the array they're in, so a slice of them would share (and double-free) them
function checkSliceable(t: Ltype, node: Node) {
    const elem = elemOf(t);
    if (elem && isHeapType(elem)) err(node, `Can't slice an array of ${elem}: its elements can't be copied`);
}

const ARRAY_METHODS: Record<string, number> = { push: 1, pop: 0, insert: 2, remove: 1 };

// a.push(v), a.pop(), a.insert(i, v), a.remove(i)
function validateArrayMethod(receiver: Node, method: string, args: Node[], scope: Scope, node: Node) {
    const arrType = inferType(receiver, scope);
    if (!(method in ARRAY_METHODS)) err(node, `Arrays have push, pop, insert and remove, not '${method}'`);
    forgetSize(receiver, scope);
    if (args.length !== ARRAY_METHODS[method]) err(node, `${method} takes ${ARRAY_METHODS[method]} argument${ARRAY_METHODS[method] === 1 ? "" : "s"}, got ${args.length}`);
    args.forEach(a => validate(a, scope));
    const elem = elemOf(arrType);
    const numeric = (t: Ltype) => t === "int" || t === "char" || t === "bool" || t === "unknown";
    if ((method === "insert" || method === "remove") && !numeric(inferType(args[0], scope))) err(args[0], `An array index must be a whole number`);
    if (method === "push" || method === "insert") {
        const value = args[args.length - 1];
        adoptLiteralType(value, elem);
        const t = inferType(value, scope);
        if (elem && t !== "unknown" && !fits(elem, t)) err(value, `Type mismatch: can't store ${t} where ${elem} is expected`);
        markMoved(value, scope);
    } else {
        // the element leaves the array: anything pointing into it may lose what it points at
        const b = baseVariable(receiver);
        if (b) for (const root of rootsBehind(b, scope)) rootChanged(root, node, `had an element removed`);
    }
}

const isArrayType = (t: Ltype) => t.endsWith("[]");
// the arrays `new int[r][c]` makes: indexed with name[i][j] directly
const is2D = (t: Ltype | undefined) => t === "int[][]" || t === "float[][]" || t === "char[][]" || t === "unknown" || t === undefined;

const MAP_METHODS: Record<string, number> = { has: 1, remove: 1, keys: 0, len: 0 };
function mapMethodType(t: Ltype, method: string): Ltype {
    const m = mapTypeParts(t)!;
    return method === "has" || method === "len" ? "int" : method === "keys" ? `${m.key}[]` : "void";
}

// m.has(k), m.remove(k), m.keys(), m.len()
function validateMapMethod(receiver: Node, method: string, args: Node[], scope: Scope, node: Node) {
    const m = mapTypeParts(inferType(receiver, scope))!;
    if (!(method in MAP_METHODS)) err(node, `Maps have has, remove, keys and len, not '${method}'`);
    if (args.length !== MAP_METHODS[method]) err(node, `${method} takes ${MAP_METHODS[method]} argument${MAP_METHODS[method] === 1 ? "" : "s"}, got ${args.length}`);
    args.forEach(a => validate(a, scope));
    if (args[0]) checkMapKey(m.key, args[0], scope);
    if (method === "remove") {
        const b = baseVariable(receiver);
        if (b) for (const root of rootsBehind(b, scope)) rootChanged(root, node, "had an entry removed");
    }
}

function checkMapKey(want: string, key: Node, scope: Scope) {
    const got = inferType(key, scope);
    if (!fits(want, got)) err(key, `This map's keys are ${want}, not ${got}`);
}

// a map type's key must be a number, char, bool or string
function checkMapType(t: Ltype | undefined, at: Node) {
    const m = mapTypeParts(t);
    if (!m) return;
    if (!MAP_KEY_TYPES.includes(m.key)) err(at, `A map's keys must be int, float, char, bool or string (not ${m.key}): keys are compared by value`);
    checkMapType(m.value, at);
    if (t?.endsWith("[]")) checkMapType(t.slice(0, -2), at);
}

// the array in `node` may change length: stop checking constant indexes against its old size
function forgetSize(node: Node, scope: Scope) {
    const b = baseVariable(node);
    const sym = b?.type === "Identifier" ? resolve(b.value!, scope) : undefined;
    if (sym) sym.size = undefined;
}

// none is only allowed as a struct field's value (a field assignment, a struct literal, a default)
// and as an operand of == / != ; those places check for it themselves, so validating a None node
// anywhere else is an error
function validateUnlessNone(n: Node, scope: Scope) {
    if (n.type !== "None") validate(n, scope);
}

function checkMethodArgs(s: string, method: string, args: Node[], node: Node, scope: Scope) {
    const want = methodParams(s, method);
    if (want && args.length !== want.length) err(node, `Method ${method} expects ${want.length} args, got ${args.length}`);
    checkArgs(`${s}.${method}`, want, args, scope);
}

// what a call `name(...)` calls: the function of that name if there is one (a local variable
// can share a function's name), otherwise a variable holding a function
function resolveCallee(name: string, scope: Scope): SymbolEntry | null {
    for (let s: Scope | undefined = scope; s; s = s.parent) {
        const found = s.symbols.get(name);
        if (found?.kind === "func") return found;
    }
    return resolve(name, scope);
}

// the type of function `name` used as a value, e.g. fn(int,float):int. Built-ins aren't real
// functions; parameters need types; a function returning an array/struct must always return a new
// one (the caller of the value owns what it returns)
function functionValueType(name: string, at: Node): Ltype {
    const params = paramTypes.get(name);
    const userFn = params !== undefined && !(name in BUILTIN_PARAMS);
    if (!userFn) err(at, `${name} is a built-in and can't be used as a value`);
    if (params.some(p => !p)) err(at, `${name} can only be used as a value if all its parameters have types`);
    const ret = resolve(name, programScope!)?.type ?? "unknown";
    if (isHeapType(ret) && !freshFunctions.has(name)) err(at, `${name} can only be used as a value if it always returns a new ${ret}`);
    return `fn(${params.join(",")}):${ret}`;
}

function checkConst(sym: SymbolEntry, node: Node) {
    if (sym.isConst) err(node, `Cannot assign to const variable '${sym.name}'`);
}

export function validate(node: Node, scope: Scope) {
    switch (node.type) {
        case "StructDef":
        const fields: StructField[] = []
        const methods = new Map<string, { params: number, returnType?: string }>()

        node.children.filter(c => c.type === "StructField")
            .forEach(f => {
                fields.push({
                    name: f.value as string,
                    type: f.varType ?? "unknown" as any,
                    isConst: f.isConst ?? false,
                    default: f.children[0]
                })
            })

        node.children
            .filter(c => c.type === "StructMethod")
            .forEach(m => {
                const paramCount = m.children.filter( c => c.type === "Identifier").length
                methods.set(m.value!, { params: paramCount, returnType: m.varType })
            })

        node.children
            .filter(c => c.type === "StructOverrides")
            .forEach( o => {
                o.children.forEach(m => {
                    const paramCount = m.children.filter( c => c.type === "Identifier").length
                    methods.set(m.value!, { params: paramCount, returnType: m.varType } )
                })
            })

            let parentFields: StructField[] = []
            if(node.parent) {
                const parentDef = lookupStruct(node.parent)
                if (!parentDef) err(node, `Unknown parent struct: ${node.parent}`)
                parentFields = parentDef.fields
                parentDef.methods.forEach((v, k) => {
                    if (!methods.has(k)) methods.set(k, v)
                })
            }

            const def: StructDef = {
                fields: [...parentFields, ...fields],
                methods,
                parent: node.parent
            }

            registerStruct(node.value!, def)

            // defaults: checked against the field's type; a heap field's default must be a new
            // value (it is evaluated again for every struct that uses it)
            for (const f of fields) {
                const d = f.default;
                if (!d) continue;
                if (d.type === "ArrayLiteral" && String(f.type).endsWith("[]")) d.varType = f.type;
                adoptLiteralType(d, f.type);
                if (d.type === "None") {
                    if (isScalar(f.type) && f.type !== "string") err(d, `${/^[aeiou]/.test(String(f.type)) ? "An" : "A"} ${f.type} field can't be none (only string, array and struct fields can)`);
                    continue;
                }
                validate(d, scope);
                const t = inferType(d, scope);
                if (!fits(String(f.type), t)) err(d, `Default for ${node.value}.${f.name} should be ${f.type}, not ${t}`);
                if (isHeapType(f.type) && !isFreshHeapExpr(d, freshFunctions)) {
                    err(d, `Default for ${node.value}.${f.name} must be a new value (a literal, new, a struct, or a call that returns a new value)`);
                }
            }

            node.children
                .filter(c => c.type === "StructMethod" || c.type === "StructOverrides")
                .forEach(c => {
                    if(c.type === "StructOverrides") {
                        c.children.forEach(m => validateStructMethod(m, node.value!, scope))
                    } else {
                        validateStructMethod(c, node.value!, scope)
                    }
                })
            break

        case "StructInstantiate": {
            const structDef = lookupStruct(node.value!)
            if(!structDef) err(node, `Unknown struct: ${node.value}`)
            node.children.forEach(f => {
                const fieldDef = structDef.fields.find( sf => sf.name === f.value)
                if (!fieldDef) err(f, `Unknown field '${f.value}' on struct '${node.value}'`)
                validateUnlessNone(f.children[0], scope)
                assignIntoContainer(fieldDef.type, { type: "Identifier", value: "__new", children: [] }, f.children[0], scope, f)
            })
            break
        }

        case "FieldAccess": {
            const obj = node.children[0]
            validate(obj, scope)
            fieldOf(obj, node.value!, scope, node)
            break
        }

        case "FieldAssign": {
            const obj = node.children[0]
            validate(obj, scope)
            const field = fieldOf(obj, node.value!, scope, node)
            if (field?.isConst) err(node, `Cannot assign to const field '${node.value}'`);
            validateUnlessNone(node.children[1], scope)
            assignIntoContainer(field?.type, obj, node.children[1], scope, node)
            break
        }

        case "This":
            break

        case "StructField":
            break

        case "StructMethod":
            break

        case "StructOverrides":
            break

        case "Program":
            programScope = scope;
            freshFunctions = findFreshFunctions(node);
            heapGlobalNames = findHeapGlobalNames(node);
            reassigns = findGlobalReassigns(node);
            mutates = findParamMutations(node);
            paramTypes = new Map(node.children.filter(c => c.type === "Function")
                .map(f => [f.value!, f.children.filter(c => c.type === "Identifier").map(c => c.varType)]));
            for (const [name, types] of Object.entries(BUILTIN_PARAMS)) if (!paramTypes.has(name)) paramTypes.set(name, types);
            methodParamTypes = new Map();
            for (const c of node.children) {
                if (c.type !== "StructDef") continue;
                (function methods(n: Node) {
                    if (n.type === "StructMethod") methodParamTypes.set(`${c.value}.${n.value}`, n.children.filter(p => p.type === "Identifier").map(p => p.varType));
                    n.children.forEach(methods);
                })(c);
            }
            node.children.forEach(c => validate(c, scope));
            break;

        case "Function": {
            currentReturnType = node.varType
            moved = new Set()  // reset for each function
            borrows = new Map()
            ownedLocals = new Set()
            staleReason.clear()
            iterating = []
            const fnScope = createScope(scope);
            node.children.forEach(c => {
                if (c.type === "Identifier") {
                    define(fnScope, {
                        name: c.value!,
                        kind: "param",
                        type: c.varType ?? "unknown",
                        structType: c.varType && /^[A-Z]/.test(c.varType) && !c.varType.endsWith("[]") ? c.varType : undefined
                    });
                    symScope.set(resolve(c.value!, fnScope)!, fnScope);
                }
            });
            node.children.forEach(c => validate(c, fnScope));
            break;
        }

        case "Block": {
            const blockScope = createScope(scope);
            node.children.forEach(c => validate(c, blockScope));
            break;
        }

        case "VarDecl": {
            validate(node.children[0], scope);
            const init = node.children[0];
            // a float[] declared from a literal of ints: IR.ts converts the elements
            if (node.varType === "float[]" && init.type === "ArrayLiteral" && inferType(init, scope) === "int[]") {
                init.varType = "float[]";
            }
            if (init.type === "MapLiteral" && isMapType(node.varType) && (init.children.length === 0 || !init.varType)) init.varType = node.varType;
            if (node.varType) checkMapType(node.varType, node);
            // an empty literal takes its element type from the declaration (var string[] xs = [];), and
            // a literal of structs can be declared as an array of their parent (var Animal[] zoo = [dog, cat];)
            if (node.varType?.endsWith("[]") && init.type === "ArrayLiteral" &&
                (init.children.length === 0 || fits(elemOf(node.varType)!, elemOf(inferType(init, scope)) ?? "unknown"))) {
                init.varType = node.varType;
            }
            const inferredType = inferType(init, scope);
            const compatible = (declared: string, inferred: string) =>
                (declared === "int" && inferred === "bool") ||   // bool→int ok
                (declared === "int" && inferred === "float") ||  // float→int truncates
                (declared === "float" && inferred === "int") ||  // int→float widens
                (declared === "int" && inferred === "char") ||
                (declared === "char" && inferred === "int");
            if (node.varType && node.varType !== inferredType && inferredType !== "unknown"
                && !compatible(node.varType, inferredType) && !fits(node.varType, inferredType)) {
                err(node, `Type annotation mismatch: declared ${node.varType}, inferred ${inferredType}`);
            }
            const finalType = node.varType ?? inferredType;
            let arraySize: number | undefined;
            if (init.type === "ArrayLiteral") {
                arraySize = init.children.length;
            } else if (init.type === "ArrayNew" && init.children[0].type === "Number") {
                arraySize = Number(init.children[0].value);
            }
            let structType: string | undefined
            if (init.type === "StructInstantiate") {
                structType = init.value
            } else if (structName(node.varType)) {
                structType = node.varType   // e.g. 'var Point p = makePoint();'
            } else if (structName(inferredType)) {
                structType = inferredType
            }
            // a local may take the name of a function (var int len = len(s);)
            if (!resolve(node.value!, scope) || resolve(node.value!, scope)!.kind === "func") {
                define(scope, {
                    name: node.value!,
                    kind: "var",
                    type: finalType,
                    size: arraySize,
                    structType,
                    isConst: node.isConst ?? false
                });
                symScope.set(resolve(node.value!, scope)!, scope);
            }
            const declared = resolve(node.value!, scope)!;
            if (node.isConst) declared.isConst = true;   // globals are declared (by Declare.ts) before this runs
            if (scope === programScope) {
                if (heapGlobalNames.has(node.value!)) {
                    heapGlobals.add(declared);
                    checkGlobalValue(node.value!, init, scope);
                }
            } else {
                bind(declared, init, scope, node);
            }
            break;
        }

        case "Unary":
            validate(node.children[0], scope);
            break;

        case "Return": {
            const value = node.children[0];
            validate(value, scope);
            if (currentReturnType) {
                adoptLiteralType(value, currentReturnType);
                const got = inferType(value, scope);
                if (!fits(String(currentReturnType), got)) err(value, `This function returns ${currentReturnType}, not ${got}`);
            }
            const roots = rootsBehind(value, scope);
            if ([...roots].some(isGlobal)) {
                err(value, `can't return a global's value: the caller would keep it after the global is reassigned and its old value freed`);
            }
            // returning an owned local hands it to the caller; anything pointing into a local
            // would be freed when this function returns
            const own = value.type === "Identifier" ? resolve(value.value!, scope) : undefined;
            const ownedHere = !!own && !borrows.has(own) && !isParam(own);
            if (!ownedHere && !isScalar(inferType(value, scope))) {
                const local = [...roots].find(r => !isGlobal(r) && !isParam(r));
                if (local) err(value, `can't return this: it points into ${local.name}, which is freed when the function returns`);
            }
            break;
        }

        case "Call": {
            if(node.value!.includes(".")) {
                const [objName, methodName] = node.value!.split(".")
                const receiver: Node = objName === "this" ? { type: "This", children: [] } : { type: "Identifier", value: objName, children: [], line: node.line, col: node.col }
                validate(receiver, scope)
                if (isArrayType(inferType(receiver, scope))) {
                    validateArrayMethod(receiver, methodName, node.children, scope, node);
                    break;
                }
                if (isMapType(inferType(receiver, scope))) {
                    validateMapMethod(receiver, methodName, node.children, scope, node);
                    break;
                }
                const s = structOf(receiver, scope)
                if (!s) err(node, `'${objName}' is not a struct`)
                const structDef = lookupStruct(s)
                if (!structDef) err(node, `Unknown struct type: ${s}`);
                if (!structDef.methods.has(methodName)) {
                    err(node, `Unknown method '${methodName}' on struct '${s}'`);
                }
                node.children.forEach(a => validate(a, scope));
                checkMethodArgs(s, methodName, node.children, node, scope);
                checkCall(node, [receiver, ...node.children], scope);
                break;
            }
            const sym = resolveCallee(node.value!, scope);
            // a call through a variable holding a function
            const fnType = sym && sym.kind !== "func" ? fnTypeParts(String(sym.type ?? "")) : undefined;
            if (sym && fnType) {
                checkNotMoved(sym, node);
                if (node.children.length !== fnType.params.length) err(node, `${node.value} expects ${fnType.params.length} args, got ${node.children.length}`);
                node.children.forEach(a => validate(a, scope));
                node.children.forEach(a => forgetSize(a, scope));
                checkArgs(node.value!, fnType.params, node.children, scope);
                checkCall(node, node.children, scope);
                break;
            }
            if (!sym || sym.kind !== "func") {
                err(node, `Undefined function: ${node.value}`);
            }
            if (sym.params !== undefined && node.children.length !== sym.params) {
                err(node, `Function ${node.value} expects ${sym.params} args, got ${node.children.length}`);
            }
            node.children.forEach(a => validate(a, scope));
            node.children.forEach(a => forgetSize(a, scope));   // the function may push to or pop from it
            checkArgs(node.value!, paramTypes.get(node.value!), node.children, scope);
            checkCall(node, node.children, scope);
            break;
        }

        case "MethodCall": {
            const receiver = node.children[0];
            validate(receiver, scope);
            if (isArrayType(inferType(receiver, scope))) {
                validateArrayMethod(receiver, node.value!, node.children.slice(1), scope, node);
                break;
            }
            if (isMapType(inferType(receiver, scope))) {
                validateMapMethod(receiver, node.value!, node.children.slice(1), scope, node);
                break;
            }
            const s = structOf(receiver, scope);
            const unknownReceiver = !s && receiver.type !== "Identifier" && inferType(receiver, scope) === "unknown";
            if (!s && !unknownReceiver) err(node, `'${node.value}' is called on something that is not a struct`);
            if (s) {
                const structDef = lookupStruct(s);
                if (!structDef) err(node, `Unknown struct type: ${s}`);
                if (!structDef.methods.has(node.value!)) err(node, `Unknown method '${node.value}' on struct '${s}'`);
            }
            if (s) checkMethodArgs(s, node.value!, node.children.slice(1), node, scope);
            node.children.slice(1).forEach(a => validate(a, scope));
            checkCall(node, node.children, scope);
            break;
        }

        case "Binary":
            if (node.value === "==" || node.value === "!=") {
                validateUnlessNone(node.children[0], scope);
                validateUnlessNone(node.children[1], scope);
            } else {
                validate(node.children[0], scope);
                validate(node.children[1], scope);
            }
            binaryType(node, scope);
            break;

        case "None":
            err(node, `none can only be stored in a struct field or compared with == / !=`);

        case "Identifier": {
            const sym = resolve(node.value!, scope);
            if (!sym) err(node, `Undefined identifier: ${node.value}`);
            if (sym.kind === "func") functionValueType(node.value!, node);   // checks it can be one
            checkNotMoved(sym, node);
            break;
        }

        case "Number":
        case "String":
            break;

        case "Assign": {
            const sym = resolve(node.value!, scope);
            if (!sym) err(node, `Undefined variable: ${node.value}`);
            checkConst(sym, node);
            const assigned = node.children[0];
            if (assigned.type === "MapLiteral" && isMapType(sym.type) && assigned.children.length === 0) assigned.varType = sym.type;
            if (sym.type?.endsWith("[]") && assigned.type === "ArrayLiteral" && assigned.children.length === 0) assigned.varType = sym.type;
            validate(node.children[0], scope);
            moved.delete(sym);  // assignment gives the variable a new value, so it is no longer "moved"
            staleReason.delete(sym);
            if (isGlobal(sym)) {
                checkGlobalValue(node.value!, node.children[0], scope);
                rootChanged(sym, node, "was reassigned");
            } else {
                // an owner's (or parameter's) old value may be freed; a borrower frees nothing
                if (!borrows.has(sym)) rootChanged(sym, node, "was reassigned");
                bind(sym, node.children[0], scope, node);
            }
            // the array may now have a different size; leave later indexes to the runtime check
            sym.size = undefined;
            const inferredType = inferType(node.children[0], scope);
            const compatibleAssign = (declared: string, inferred: string) =>
                (declared === "int" && inferred === "bool") ||
                (declared === "int" && inferred === "float") ||
                (declared === "float" && inferred === "int") ||
                (declared === "int" && inferred === "char") ||
                (declared === "char" && inferred === "int");
            // "unknown" on either side (e.g. a variable initialised from a call) is not checked
            if (sym.type && sym.type !== "unknown" && sym.type !== inferredType && inferredType !== "unknown"
                && !compatibleAssign(sym.type, inferredType) && !fits(sym.type, inferredType)) {
                err(node, `Type mismatch in assignment to ${node.value}: ${sym.type} vs ${inferredType}`);
            }
            break;
        }

        case "ArrayLiteral": {
            const elem = elemOf(inferType(node, scope));
            if (!node.varType && elem && structName(elem)) node.varType = `${elem}[]`;   // tells IR.ts the common parent
            node.children.forEach(c => {
                validate(c, scope);
                assignIntoContainer(elem, { type: "Identifier", value: "__new", children: [] }, c, scope, c);
            });
            break;
        }

        case "MapLiteral": {
            const t = inferType(node, scope);
            const m = mapTypeParts(t);
            for (let i = 0; i < node.children.length; i += 2) {
                validate(node.children[i], scope);
                validate(node.children[i + 1], scope);
                if (m) {
                    checkMapKey(m.key, node.children[i], scope);
                    assignIntoContainer(m.value, { type: "Identifier", value: "__new", children: [] }, node.children[i + 1], scope, node.children[i + 1]);
                }
            }
            if (m) checkMapType(t, node);
            break;
        }

        case "ArrayNew":
            node.children.forEach(c => validate(c, scope));
            if (node.children.length > 1 && !["int[][]", "float[][]", "char[][]"].includes(node.varType ?? "")) {
                err(node, `2-D arrays hold numbers only (int, float or char)`);
            }
            break;

        case "ArrayAccess": {
            const sym = resolve(node.value!, scope);
            if (!sym) err(node, `Undefined variable: ${node.value}`);
            checkNotMoved(sym, node);
            validate(node.children[0], scope);
            if (isMapType(sym.type)) { checkMapKey(mapTypeParts(sym.type)!.key, node.children[0], scope); break; }
            if (node.children[0].type === "Number") {
                const idx = Number(node.children[0].value);
                if (idx < 0) err(node.children[0], `Array index out of bounds: negative index ${idx} for '${node.value}'`);
                if (sym.size !== undefined && idx >= sym.size) {
                    err(node.children[0], `Array index out of bounds: index ${idx} >= size ${sym.size} for '${node.value}'`);
                }
            }
            break;
        }

        case "IndexExpr": {
            validate(node.children[0], scope);
            validate(node.children[1], scope);
            const base = inferType(node.children[0], scope);
            if (isMapType(base)) { checkMapKey(mapTypeParts(base)!.key, node.children[1], scope); break; }
            if (base !== "unknown" && base !== "string" && !base.endsWith("[]")) err(node, `Can't index a value of type ${base}`);
            break;
        }

        case "ArrayAssign": {
            const sym = resolve(node.value!, scope);
            if (!sym) err(node, `Undefined variable: ${node.value}`);
            checkNotMoved(sym, node);
            if (sym.type === "string") err(node, `Strings can't be changed in place; build a new string instead`);
            validate(node.children[0], scope); // index
            validate(node.children[1], scope); // value
            if (isMapType(sym.type)) checkMapKey(mapTypeParts(sym.type)!.key, node.children[0], scope);
            assignIntoContainer(elemOf(sym.type), { type: "Identifier", value: node.value, children: [] }, node.children[1], scope, node);
            break;
        }

        case "IndexAssign": {
            validate(node.children[0], scope);
            validate(node.children[1], scope);
            validate(node.children[2], scope);
            const base = inferType(node.children[0], scope);
            if (base === "string") err(node, `Strings can't be changed in place; build a new string instead`);
            if (isMapType(base)) checkMapKey(mapTypeParts(base)!.key, node.children[1], scope);
            else if (base !== "unknown" && !base.endsWith("[]")) err(node, `Can't index a value of type ${base}`);
            assignIntoContainer(elemOf(base), node.children[0], node.children[2], scope, node);
            break;
        }

        case "ArrayLen": {
            const sym = resolve(node.value!, scope);
            if (!sym) err(node, `Undefined variable: ${node.value}`);
            checkNotMoved(sym, node);
            break;
        }

        case "LenExpr": {
            validate(node.children[0], scope);
            const base = inferType(node.children[0], scope);
            if (base !== "unknown" && base !== "string" && !base.endsWith("[]") && !isMapType(base)) err(node, `.len() needs an array, map or string, not ${base}`);
            break;
        }

        case "If":
            validate(node.children[0], scope);
            validateBranches(node.children.slice(1).map(c => () => validate(c, scope)), node.children.length < 3);
            break;

        case "While":
            validate(node.children[0], scope);
            validateLoopBody([node.children[1]], scope);
            break;

        case "For":
            validate(node.children[0], scope);
            validate(node.children[1], scope);
            validateLoopBody([node.children[3],node.children[2]], scope);
            break;

        case "ArrayAccess2D" as any: {
            const sym = resolve(node.value!, scope);
            if (!sym) err(node, `Undefined variable: ${node.value}`);
            // name[a][b] on anything but a 2-D number array (a map of maps, a string[] ...) is two
            // ordinary index steps
            if (!is2D(sym.type)) {
                const inner: Node = { type: "ArrayAccess", value: node.value, children: [node.children[0]], line: node.line, col: node.col };
                Object.assign(node, { type: "IndexExpr", value: undefined, children: [inner, node.children[1]] });
                validate(node, scope);
                break;
            }
            checkNotMoved(sym, node);
            validate(node.children[0], scope);
            validate(node.children[1], scope);
            break;
        }

        case "ArrayAssign2D" as any: {
            const sym = resolve(node.value!, scope);
            if (!sym) err(node, `Undefined variable: ${node.value}`);
            if (!is2D(sym.type)) {
                const inner: Node = { type: "ArrayAccess", value: node.value, children: [node.children[0]], line: node.line, col: node.col };
                Object.assign(node, { type: "IndexAssign", value: undefined, children: [inner, node.children[1], node.children[2]] });
                validate(node, scope);
                break;
            }
            checkNotMoved(sym, node);
            validate(node.children[0], scope);
            validate(node.children[1], scope);
            validate(node.children[2], scope);
            break;
        }

        case "Break":
        case "Continue":
            break;

        case "Char":
            break;

        case "CompoundAssign": {
            const lhs = node.children[0];
            const sym = resolve(lhs.value!, scope);
            if (!sym) err(lhs, `Undefined variable: ${lhs.value}`);
            checkConst(sym, node);
            checkNotMoved(sym, lhs);
            validate(node.children[1], scope);
            binaryType({ type: "Binary", value: node.value!.slice(0, -1), children: [lhs, node.children[1]], line: node.line, col: node.col }, scope);
            break;
        }

        case "PostfixInc":
        case "PostfixDec": {
            const sym = resolve(node.value!, scope);
            if (!sym) err(node, `Undefined variable: ${node.value}`);
            checkConst(sym, node);
            break;
        }

        case "ForIn": {
            const forInScope = createScope(scope);
            validate(node.children[0], scope);
            const arrType = inferType(node.children[0], scope);
            if (arrType !== "unknown" && !arrType.endsWith("[]") && !isMapType(arrType)) err(node, `for-in needs an array or a map, not ${arrType}`);
            // for (k in m) goes over a map's keys
            const elemType = isMapType(arrType) ? mapTypeParts(arrType)!.key : (elemOf(arrType) ?? "int");
            define(forInScope, {
                name: node.value!, kind: "var", type: elemType,
                structType: structName(elemType)
            });
            const loopVar = resolve(node.value!, forInScope)!;
            symScope.set(loopVar, forInScope);
            // the loop variable refers into the array (for arrays, structs and tuples)
            const over = new Set(rootsBehind(node.children[0], scope));
            const src = node.children[0].type === "Identifier" ? resolve(node.children[0].value!, scope) : undefined;
            if (src) over.add(src);
            if (isHeapType(elemType) && over.size > 0) borrows.set(loopVar, new Set(over));
            iterating.push(...over);
            validateLoopBody([node.children[1]], forInScope);
            iterating.length -= over.size;
            break;
        }

        case "Match": {
            validate(node.children[0], scope);
            validateBranches(node.children.slice(1).map(arm => () => {
                const armScope = createScope(scope);
                arm.children.forEach(c => validate(c, armScope));
            }), true);
            break;
        }

        case "MatchArm":
            node.children.forEach(c => validate(c, scope));
            break;

        case "Tuple":
            node.children.forEach(c => {
                validate(c, scope);
                assignIntoContainer(undefined, { type: "Identifier", value: "__new", children: [] }, c, scope, c);
            });
            break;

        case "TupleAccess":
            validate(node.children[0], scope);
            inferType(node, scope);    // checks the index is within the tuple
            break;

        case "ArraySlice": {
            const sym = resolve(node.value!, scope);
            if (!sym) err(node, `Undefined variable: ${node.value}`);
            checkNotMoved(sym, node);
            validate(node.children[0], scope);
            validate(node.children[1], scope);
            checkSliceable(sym.type ?? "unknown", node);
            break;
        }

        case "SliceExpr": {
            node.children.forEach(c => validate(c, scope));
            const base = inferType(node.children[0], scope);
            if (base !== "unknown" && base !== "string" && !base.endsWith("[]")) err(node, `Can't slice a value of type ${base}`);
            checkSliceable(base, node);
            break;
        }
    }
}

module.exports = { validate };
