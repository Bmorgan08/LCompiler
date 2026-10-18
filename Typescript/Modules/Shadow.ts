// Locals and parameters with the same name as a global get a name of their own.
//
// The emitter decides that a name is a global by the name alone, so a parameter or local called
// like a global read and wrote the global instead (B68): console_set_colour(u8 colour) changed the
// global `colour`, and so did every call passing a `colour` argument. This pass runs after
// validation (so errors still show the names as written) and before IR generation, and renames
// such a local and every use of it inside its scope: `colour` becomes `colour$1`.

import type { Node } from "./Parser";

// nodes whose `value` is the name of a variable being read or written
const NAME_NODES = new Set([
    "Identifier", "Assign", "ArrayAssign", "ArrayAccess", "ArrayLen", "ArraySlice",
    "ArrayAccess2D", "ArrayAssign2D", "PostfixInc", "PostfixDec",
    "Call",   // calling a local fn value: `f(x)` where f is a parameter
]);

export function renameShadowingLocals(program: Node): void {
    const globals = new Set(program.children.filter(c => c.type === "VarDecl").map(c => c.value!));
    if (globals.size === 0) return;
    let count = 0;

    type Scopes = Map<string, string>[];
    const lookup = (scopes: Scopes, name: string) => {
        for (let i = scopes.length - 1; i >= 0; i--) if (scopes[i].has(name)) return scopes[i].get(name);
        return undefined;
    };
    // a new local: a global's name gets a fresh one; any other name maps to itself, which hides a
    // renamed local of the same name in an outer block
    const declare = (scopes: Scopes, name: string) => {
        const renamed = globals.has(name) ? `${name}$${++count}` : name;
        scopes[scopes.length - 1].set(name, renamed);
        return renamed;
    };

    function walk(n: Node, scopes: Scopes): void {
        switch (n.type) {
            case "Function":
            case "StructMethod": {
                // a function sees the globals and its own names, nothing from where it is written
                const own: Scopes = [new Map()];
                const params = n.children.slice(0, -1);
                for (const p of params) if (p.type === "Identifier" && p.value) p.value = declare(own, p.value);
                walk(n.children[n.children.length - 1], own);
                return;
            }
            case "Block":
            case "For": {
                // a for's init variable belongs to the loop
                scopes.push(new Map());
                n.children.forEach(c => walk(c, scopes));
                scopes.pop();
                return;
            }
            case "ForIn": {
                walk(n.children[0], scopes);   // what is looped over is outside the loop
                scopes.push(new Map());
                n.value = declare(scopes, n.value!);
                n.children.slice(1).forEach(c => walk(c, scopes));
                scopes.pop();
                return;
            }
            case "VarDecl": {
                n.children.forEach(c => walk(c, scopes));   // its value is worked out before it exists
                if (scopes.length) n.value = declare(scopes, n.value!);
                return;
            }
        }
        if (NAME_NODES.has(n.type) && n.value !== undefined) {
            // a call on a variable is written into the name: a.push(1) is Call "a.push"
            const dot = n.type === "Call" ? n.value.indexOf(".") : -1;
            const name = dot >= 0 ? n.value.slice(0, dot) : n.value;
            const renamed = lookup(scopes, name);
            if (renamed !== undefined) n.value = renamed + (dot >= 0 ? n.value.slice(dot) : "");
        }
        n.children.forEach(c => walk(c, scopes));
    }

    // top-level globals keep their names; functions, and methods inside structs, are renamed within
    for (const c of program.children) if (c.type !== "VarDecl") walk(c, []);
}
