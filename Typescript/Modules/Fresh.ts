import { Node } from "./Parser";

// true if `n` always evaluates to a new array/struct/tuple that nothing else points to
export function isFreshHeapExpr(n: Node, freshFunctions: Set<string>, freshLocals: Set<string> = new Set()): boolean {
    switch (n.type) {
        case "ArrayNew": case "ArrayLiteral": case "StructInstantiate": case "Tuple": case "ArraySlice": case "MapLiteral":
            return true;
        case "Call": return freshFunctions.has(n.value!.includes(".") ? "." + n.value!.split(".")[1] : n.value!);
        case "MethodCall": return freshFunctions.has("." + n.value!);
        case "Identifier": return freshLocals.has(n.value!);
        default: return false;
    }
}

// Functions every one of whose returns is a new array/struct/tuple, a call to another such
// function, or a local only ever given such values. The caller owns (and frees) what they return.
export function findFreshFunctions(ast: Node): Set<string> {
    const fresh = new Set<string>();

    // a method name counts as fresh only if every struct's version of it is
    const methodImpls = new Map<string, Node[]>();
    (function collect(n: Node) {
        if (n.type === "StructMethod") {
            const key = "." + n.value!;
            methodImpls.set(key, [...(methodImpls.get(key) ?? []), n]);
        }
        n.children.forEach(collect);
    })(ast);

    function returnsOnlyFresh(fn: Node): boolean {
        const body = fn.children.find(c => c.type === "Block");
        if (!body) return false;
        const decls: Node[] = [], assigns: Node[] = [], returns: Node[] = [];
        (function walk(n: Node) {
            if (n.type === "VarDecl") decls.push(n);
            if (n.type === "Assign") assigns.push(n);
            if (n.type === "Return") returns.push(n);
            n.children.forEach(walk);
        })(body);
        const freshLocals = new Set(decls.map(d => d.value!));
        for (const d of [...decls, ...assigns]) {
            if (!isFreshHeapExpr(d.children[0], fresh)) freshLocals.delete(d.value!);
        }
        return returns.length > 0 && returns.every(r => r.children[0] && isFreshHeapExpr(r.children[0], fresh, freshLocals));
    }

    // an array's pop()/remove(i) hands the caller an element it owns
    for (const m of ["pop", "remove", "keys"]) if (!methodImpls.has("." + m)) fresh.add("." + m);

    function visitMethods() {
        for (const [key, impls] of methodImpls) {
            if (!fresh.has(key) && impls.every(returnsOnlyFresh)) fresh.add(key);
        }
    }

    function visit(node: Node) {
        if (node === ast) visitMethods();
        if (node.type === "Function") {
            const body = node.children.find(c => c.type === "Block");
            if (body) {
                const decls: Node[] = [], assigns: Node[] = [], returns: Node[] = [];
                (function walk(n: Node) {
                    if (n.type === "VarDecl") decls.push(n);
                    if (n.type === "Assign") assigns.push(n);
                    if (n.type === "Return") returns.push(n);
                    n.children.forEach(walk);
                })(body);
                // a local is fresh only if every value it is given is fresh; copying another
                // variable into it (even a fresh one) makes a second pointer, so it doesn't count
                const freshLocals = new Set(decls.map(d => d.value!));
                for (const d of [...decls, ...assigns]) {
                    if (!isFreshHeapExpr(d.children[0], fresh)) freshLocals.delete(d.value!);
                }
                if (returns.length > 0 && returns.every(r => r.children[0] && isFreshHeapExpr(r.children[0], fresh, freshLocals))) {
                    fresh.add(node.value!);
                }
            }
        }
        node.children.forEach(visit);
    }

    // a fresh function can call one defined later in the file, so repeat until nothing changes
    let known: number;
    do {
        known = fresh.size;
        visit(ast);
    } while (fresh.size !== known);
    return fresh;
}
