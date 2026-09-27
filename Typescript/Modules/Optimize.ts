import { Node } from "./Parser";
import { IR, isHeapT } from "./IR";

export function fold(node: Node): Node {
    switch (node.type) {
        case "Binary": {
            const left = fold(node.children[0]);
            const right = fold(node.children[1]);

            if (left.type === "Number" && right.type === "Number") {
                const l = parseFloat(left.value! as string);
                const r = parseFloat(right.value! as string);

                if (["+", "-", "*", "/"].includes(node.value!)) {
                    // a float operand makes a float result
                    if (left.varType === "float" || right.varType === "float") {
                        const f = node.value === "+" ? l + r : node.value === "-" ? l - r : node.value === "*" ? l * r : l / r;
                        return { type: "Number", value: f.toString(), varType: "float", children: [] };
                    }
                    // ints: 64-bit wrapping arithmetic, and '/' truncates towards zero like idiv
                    if (/^-?\d+$/.test(left.value!) && /^-?\d+$/.test(right.value!)) {
                        const a = BigInt(left.value!);
                        const b = BigInt(right.value!);
                        if (node.value === "/" && b === 0n) {
                            return { ...node, children: [left, right] };   // leave it to fail at runtime
                        }
                        const n = node.value === "+" ? a + b : node.value === "-" ? a - b : node.value === "*" ? a * b : a / b;
                        return { type: "Number", value: BigInt.asIntN(64, n).toString(), children: [] };
                    }
                    return { ...node, children: [left, right] };
                }

                // two ints compare exactly (as 64-bit values), not as JS numbers
                if (/^-?\d+$/.test(left.value!) && /^-?\d+$/.test(right.value!) && left.varType !== "float" && right.varType !== "float") {
                    const a = BigInt.asIntN(64, BigInt(left.value!)), b = BigInt.asIntN(64, BigInt(right.value!));
                    const cmp: Record<string, boolean> = { "==": a === b, "!=": a !== b, "<": a < b, ">": a > b, "<=": a <= b, ">=": a >= b };
                    if (node.value! in cmp) return { type: "Number", value: cmp[node.value!] ? "1" : "0", varType: "bool", children: [] };
                }
                switch (node.value) {
                    case "==":
                        return { type: "Number", value: (l === r ? "1" : "0"), varType: "bool", children: [] };
                    case "!=":
                        return { type: "Number", value: (l !== r ? "1" : "0"), varType: "bool", children: [] };
                    case "<":
                        return { type: "Number", value: (l < r ? "1" : "0"), varType: "bool", children: [] };
                    case ">":
                        return { type: "Number", value: (l > r ? "1" : "0"), varType: "bool", children: [] };
                    case "<=":
                        return { type: "Number", value: (l <= r ? "1" : "0"), varType: "bool", children: [] };
                    case ">=":
                        return { type: "Number", value: (l >= r ? "1" : "0"), varType: "bool", children: [] };
                }
            }

            return { ...node, children: [left, right] };
        }

        case "Unary": {
            const operand = fold(node.children[0]);
            if (operand.type === "Number") {
                switch (node.value) {
                    case "+":
                        return operand;
                    case "-":
                        // an int negates as a 64-bit value (parseFloat would round it above 2^53)
                        if (operand.varType !== "float" && /^-?\d+$/.test(operand.value!)) {
                            return { type: "Number", value: BigInt.asIntN(64, -BigInt(operand.value!)).toString(), varType: operand.varType, children: [] };
                        }
                        return { type: "Number", value: (parseFloat(operand.value!) * -1).toString(), varType: operand.varType, children: [] };
                }
            }
            return { ...node, children: [operand] };
        }

        default:
            return { ...node, children: node.children.map(fold) };
    }
}

export function DCE(node: Node): Node{
    switch (node.type) {
        case "Block": {
            const newChildrem: Node[] = [];
            for (const child of node.children) {
                newChildrem.push(DCE(child) ?? child);
                if (child.type === "Return" || child.type === "Break" || child.type === "Continue") break; // remove everything after return
            }
            return { ...node, children: newChildrem };
        }

        case "If": {
            const condition = DCE(node.children[0]);
            if (condition?.type === "Number") {
                if (Number(condition.value) !== 0) {
                    return DCE(node.children[1]) ?? node.children[1]; // fold if(true) { ... }
                } else {
                    return node.children[2] ? DCE(node.children[2]) : { type: "Block", children: [] }; // fold if(false) { ... } else { ... }
                }
            }
            return { ...node, children: node.children.map(DCE) }
        }
        
        default:
            return { ...node, children: node.children.map(DCE) };
    }
}

export function copyProp(IR: IR[]): IR[] {

    // Pre-pass: find temps that are assigned more than once (loop-carried variables).
    // These must NOT be dropped from the output even when they look like pure aliases.
    const assignCount = new Map<string, number>();
    for (const instr of IR) {
        if ("dst" in instr) {
            const dst = (instr as any).dst as string;
            assignCount.set(dst, (assignCount.get(dst) ?? 0) + 1);
        }
    }
    const multiAssigned = new Set<string>(
        [...assignCount.entries()].filter(([, n]) => n > 1).map(([k]) => k)
    );

    // Globals are the named variables written before the first function (the same
    // rule the emitter uses). Any call may change them, so their values are never
    // recorded in the environment.
    const globals = new Set<string>();
    for (const instr of IR) {
        if (instr.op === "enter") break;
        const dst = (instr as any).dst;
        if (typeof dst === "string" && !/^(t\d+|__lit_.*)$/.test(dst)) globals.add(dst);
    }

    const env = new Map<string, string | number>();
    const stringTemps = new Set<string>();

    function resolve(v: any): any {
        while (typeof v === "string" && env.has(v)) {
            const next = env.get(v);

            if (typeof next === "string" || typeof next === "number") {
                v = next;
            } else {
                break;
            }
        }
        return v;
    }

    // index of the last instruction that reads each name
    const lastUse = new Map<string, number>();
    const nonOperands = new Set(["op", "dst", "name", "target", "fn", "structName", "methodName", "implName", "text", "type"]);
    IR.forEach((instr, idx) => {
        for (const [key, val] of Object.entries(instr)) {
            if (nonOperands.has(key)) continue;
            if (typeof val === "string") lastUse.set(val, idx);
            else if (Array.isArray(val)) val.forEach(v => { if (typeof v === "string") lastUse.set(v, idx); });
        }
    });

    const out: IR[] = [];
    const elided = new Set<string>();   // temps whose defining mov was dropped
    let pos = 0;                        // index of the instruction being processed

    // Called before `name` is redefined. Anything recorded as a copy of it must
    // stop resolving to it; a dropped temp that is still read later is written
    // out first so it keeps the value it was meant to copy.
    function killAliases(name: string) {
        for (const [k, v] of [...env]) {
            if (v !== name) continue;
            if (elided.has(k) && (lastUse.get(k) ?? -1) > pos) {
                out.push({ op: "mov", dst: k, src: name });
                elided.delete(k);
            }
            env.delete(k);
        }
    }

    for (const [idx, instr] of IR.entries()) {
        pos = idx;

        // functions share nothing, and control flow merges at labels
        if (instr.op === "jmp" || instr.op === "label" || instr.op === "enter") {
            env.clear();
            out.push(instr);
            continue;
        }

        if (instr.op === "jz" || instr.op === "jnz") {
            const resolvedCond = resolve((instr as any).cond);
            env.clear();
            out.push({ ...instr, cond: resolvedCond } as any);
            continue;
        }

        if (
            instr.op === "array_new" ||
            instr.op === "array_store" ||
            instr.op === "array_load" ||
            instr.op === "array_len"
        ) {
            const resolved: any = { ...instr };
            if ("dst" in instr) killAliases((instr as any).dst);
            if (instr.op === "array_load") {
                resolved.index = String(resolve((instr as any).index));
                env.delete((instr as any).dst);
            }
            if (instr.op === "array_store") {
                resolved.index = String(resolve((instr as any).index));
                resolved.src = String(resolve((instr as any).src));
                }
            if (instr.op === "array_new" && typeof (instr as any).size === "string") {
                resolved.size = resolve((instr as any).size);
                env.delete((instr as any).dst);
            }
                if (instr.op === "array_len") {
                env.delete((instr as any).dst);
            }
            out.push(resolved);
            continue;
        }       

        const copy: any = { ...instr };

        for (const key in copy) {
            // type names and messages aren't operands (a variable could share a struct's name)
            if (["op", "dst", "args", "type", "elemType", "fieldType", "retType", "structName", "message", "name", "fn"].includes(key)) continue;
            // nor is a literal's value ("x" must stay "x" even when a variable x is a copy of something);
            // ret's value is an operand, though
            if (key === "value" && (instr.op === "string_const" || instr.op === "const" || instr.op === "fconst")) continue;
            copy[key] = resolve(copy[key]);
        }

        // a method call's receiver and arguments are resolved like a plain call's
        if (instr.op === "call" || instr.op === "vtable_call" || instr.op === "call_indirect") {
            copy.args = (instr as any).args.map((arg: string) => {
                let resolved = arg;
                while (env.has(resolved)) {
                    const next = env.get(resolved) as string;
                    if (/^t\d+$/.test(next)) {
                        resolved = next;
                    } else {
                        resolved = next;
                        break;
                    }
                }
                return resolved;
            });
            // the callee may change any global
            for (const g of globals) killAliases(g);
        }

        if (instr.op === "mov") {
            const resolved = resolve(instr.src);
            if (stringTemps.has(instr.src) || typeof resolved === "string" && stringTemps.has(resolved)) {
                stringTemps.add(instr.dst);
            }
    
            if (/^t\d+$/.test(instr.dst) && !multiAssigned.has(instr.dst)) {
                env.set(instr.dst, instr.src);
                elided.add(instr.dst);
                continue;
            }

            killAliases(instr.dst);

            if (globals.has(instr.dst)) {
                env.delete(instr.dst);
                out.push({ ...copy, src: String(resolved) });
                continue;
            }

            env.set(instr.dst, resolved);
            out.push({ ...copy, src: String(resolved) });
            continue;
        }

        if (instr.op === "const") {
            killAliases(instr.dst);
            // a bigint is kept as its decimal text, which later stages treat as a literal
            env.set(instr.dst, typeof instr.value === "bigint" ? instr.value.toString() : instr.value);
            out.push(instr);
            continue;
        }

        if ("dst" in instr) {
            killAliases((instr as any).dst);
            env.delete((instr as any).dst);
        }       

        out.push(copy);
    }

    return out;
}

export function insertFrees(ir: IR[]): IR[] {
    const result: IR[] = [];
    let i = 0;

    // globals (named variables written before the first function) outlive every
    // function, so a heap value moved into one is never freed here
    const globals = new Set<string>();
    for (const instr of ir) {
        if (instr.op === "enter") break;
        const dst = (instr as any).dst;
        if (typeof dst === "string" && !/^(t\d+|__lit_.*)$/.test(dst)) globals.add(dst);
    }

    while (i < ir.length) {
        const instr = ir[i];

        if (instr.op === "enter") {
            const fnInstrs: IR[] = [];
            let j = i;
            while (j < ir.length && ir[j].op !== "leave") {
                fnInstrs.push(ir[j]);
                j++;
            }
            if (j < ir.length) fnInstrs.push(ir[j]);

            function isHeapAlloc(fi: IR): string | null {
                if (fi.op === "array_new") return fi.dst;
                if (fi.op === "struct_alloc") return fi.dst;
                if (fi.op === "str_concat") return fi.dst
                if (fi.op === "str_dup") return fi.dst;
                if (fi.op === "str_sub") return fi.dst;
                if (fi.op === "alloc") return fi.dst;
                if (fi.op === "call" && fi.dst && (fi.fn === "inputstr" || fi.fn === "inttostr" || fi.returns_string || fi.returns_heap)) return fi.dst;
                if (fi.op === "vtable_call" && (fi.returns_string || fi.returns_heap)) return fi.dst;
                if (fi.op === "call_indirect" && (fi.returns_string || fi.returns_heap)) return fi.dst;
                if (fi.op === "map_new" || fi.op === "map_keys") return fi.dst;
                // a popped/removed element now belongs to whoever took it
                if ((fi.op === "array_pop" || fi.op === "array_remove") && isHeapT(fi.elemType)) return fi.dst;
                return null;
            }

            // the type of what an allocation creates, so it is freed along with everything it owns
            function allocType(fi: IR): string | undefined {
                if (fi.op === "array_new") return fi.type;
                if (fi.op === "struct_alloc") return fi.structName;
                if (fi.op === "alloc") return fi.type;
                if ((fi.op === "call" || fi.op === "vtable_call" || fi.op === "call_indirect") && fi.returns_heap) return fi.retType;
                if (fi.op === "array_pop" || fi.op === "array_remove") return fi.elemType;
                if (fi.op === "map_new" || fi.op === "map_keys") return fi.type;
                return undefined;
            }

            // Detect 2D arrays by the arr2d_end label pattern.
            // Scan for arr2d_end_N label; the final owner is the mov immediately after it.
            // Scan backwards to find the nearest arr2d_init label, then the outer array_new before it.
            // Map: owner var -> row count (number or slot name as string)
            const array2dRows = new Map<string, string>();
            for (let k = 0; k < fnInstrs.length; k++) {
                const cur = fnInstrs[k];
                if (cur.op === "label" && cur.name.startsWith("arr2d_end")) {
                    const movInstr = fnInstrs[k + 1];
                    if (!movInstr || movInstr.op !== "mov") continue;
                    const owner = (movInstr as any).dst as string;
                    for (let m = k - 1; m >= 0; m--) {
                        const prev = fnInstrs[m];
                        if (prev.op === "label" && prev.name.startsWith("arr2d_init")) {
                            for (let n = m - 1; n >= 0; n--) {
                                if (fnInstrs[n].op === "array_new") {
                                    const rowCount = String((fnInstrs[n] as any).size);
                                    array2dRows.set(owner, rowCount);
                                    break;
                                }
                                if (fnInstrs[n].op === "label") break;
                            }
                            break;
                        }
                    }
                }
            }

            // Build a map: var -> scope depth that owns it.
            // ownership transfer via mov removes src, so only the final owner is freed.
            // A named variable is owned at the depth it was declared at (its decl mov,
            // or its first assignment), not where it was last assigned: a variable
            // declared before a loop and reassigned inside it must survive the loop.
            const varScope = new Map<string, number>();
            const declDepth = new Map<string, number>();
            const heldBy = new Map<string, string>(); 
            const fieldsOf = new Map<string, number[]>()
            // movs that give a global a value it owns; the global's old value is freed first.
            // Validate.ts makes sure nothing else still points at that old value
            const globalStores = new Set<IR>()
            // movs that give a local a value it doesn't own (a global, a struct field, another
            // variable's value); a local that also owns values at other times gets an ownership flag
            const borrowMovs = new Set<IR>()
            // owner -> the type of what it owns (see allocType); the emitter frees by type
            const ownerType = new Map<string, string>();
            const freeOp = (v: string): IR =>
                ownerType.has(v) ? { op: "free", addr: v, type: ownerType.get(v)! }
                : array2dRows.has(v) ? {op: "array_free_2d", arr: v, rows: array2dRows.get(v)!}
                : fieldsOf.has(v) ? { op: "free", addr: v, fields: fieldsOf.get(v)!}
                : { op: "free", addr: v }
            const heapStores = new Set<IR>();
            const isLoopStart = (name: string) => /^(while|for|forin)_start/.test(name);
            const loopEnd = new Map<string, string>();
            for (let k = 0; k + 1< fnInstrs.length; k++) {
                const cur = fnInstrs[k], next = fnInstrs[k + 1];
                if (cur.op === "jmp" && isLoopStart(cur.target) && next.op === "label") loopEnd.set(cur.target, next.name);
            }
            {
                let depth = 0;
                const depthStack: string[] = [];
                for (const fi of fnInstrs) {
                    if (fi.op === "label" && isLoopStart(fi.name)) {
                        depth++;
                        depthStack.push(fi.name);
                    }
                    if (fi.op === "label" && depthStack.length > 0 && fi.name === loopEnd.get(depthStack[depthStack.length - 1])) {
                        depthStack.pop();
                        depth--;
                    }
                    const dst = isHeapAlloc(fi);
                    if (dst) varScope.set(dst, depth);
                    if (dst && (fi.op === "struct_alloc" || fi.op === "alloc") && fi.heapFields?.length) fieldsOf.set(dst, fi.heapFields)
                    if (dst && allocType(fi)) ownerType.set(dst, allocType(fi)!)
                    if (fi.op === "arg") declDepth.set(fi.dst, depth);
                    if (fi.op === "mov" && !/^t\d+$/.test(fi.dst) && (fi.decl || !declDepth.has(fi.dst))) {
                        declDepth.set(fi.dst, depth);
                    }
                    if (fi.op === "mov" && !fi.dst.startsWith("__")) {
                        // copyProp may have replaced a local moved into a global by the temp it came from
                        if (globals.has(fi.dst) && !varScope.has(fi.src)) {
                            const holder = heldBy.get(fi.src);
                            if (holder !== undefined && varScope.has(holder)) {
                                if (fieldsOf.has(holder)) fieldsOf.set(fi.dst, fieldsOf.get(holder)!);
                                if (ownerType.has(holder)) ownerType.set(fi.dst, ownerType.get(holder)!);
                                varScope.delete(holder);
                                globalStores.add(fi);
                            }
                        }
                        const borrowsVariable = !/^t\d+$/.test(fi.src) && !fi.src.startsWith("__") &&
                            !/^t\d+$/.test(fi.dst) && !globals.has(fi.dst);
                        const srcDepth = borrowsVariable ? undefined : varScope.get(fi.src);
                        if (srcDepth === undefined && !/^t\d+$/.test(fi.dst) && !globals.has(fi.dst) && !/^-?\d+$/.test(fi.src)) {
                            borrowMovs.add(fi);
                        }
                        if (srcDepth !== undefined) {
                            varScope.delete(fi.src); // src no longer owns the allocation
                            if (fieldsOf.has(fi.src)) fieldsOf.set(fi.dst, fieldsOf.get(fi.src)!);
                            if (ownerType.has(fi.src)) ownerType.set(fi.dst, ownerType.get(fi.src)!);
                            if (globals.has(fi.dst)) globalStores.add(fi);
                            if (!globals.has(fi.dst)) {
                                const ownerDepth = /^t\d+$/.test(fi.dst) ? srcDepth : (declDepth.get(fi.dst) ?? srcDepth);
                                varScope.set(fi.dst, ownerDepth);
                            }
                            if (!/^t\d+$/.test(fi.dst)) heldBy.set(fi.src, fi.dst); // src is now held by dst
                        }
                    }
                    // array_store transfers ownership of src into the array — don't free src separately
                    // push/insert move the value into the array, like a store (nothing is overwritten)
                    if (fi.op === "array_push" || fi.op === "array_insert" || fi.op === "map_set") {
                        const holder = heldBy.get(fi.src);
                        varScope.delete(fi.src);
                        if (holder) varScope.delete(holder);
                    }
                    if (fi.op === "array_store" || fi.op === "field_store") {
                        const holder = heldBy.get(fi.src);
                        if ((varScope.has(fi.src) || (holder !== undefined && varScope.has(holder))))  {
                            heapStores.add(fi);
                        }
                        varScope.delete(fi.src)
                        if (holder) varScope.delete(holder); // the holder no longer owns it either
                    }
                }
            }

            const allHeapVars = new Set(varScope.keys());
            // heap owners that sometimes hold a borrowed value: their frees check __owns_<name>
            const mixedVars = new Set<string>();
            for (const fi of borrowMovs) if (fi.op === "mov" && allHeapVars.has(fi.dst)) mixedVars.add(fi.dst);
            let ownSkipCount = 0;
            const guardedFree = (v: string) => {
                if (!mixedVars.has(v)) { result.push(freeOp(v)); return; }
                const skip = `__own_skip_${ownSkipCount++}`;
                result.push({ op: "jz", cond: `__owns_${v}`, target: skip });
                result.push(freeOp(v));
                result.push({ op: "label", name: skip });
            };

            // Build forward mov chain: src -> final owner (to resolve ret value through movs)
            const movForward = new Map<string, string>();
            for (const fi of fnInstrs) {
                if (fi.op === "mov") movForward.set(fi.src, fi.dst);
            }
            function resolveOwner(name: string): string {
                let cur = name;
                while (movForward.has(cur)) cur = movForward.get(cur)!;
                return cur;
            }

            let loopDepth = 0;
            let oldCount = 0
            const loopLabelStack: string[] = [];
            const paramsAwaitingCopy = new Set<string>();

            for (const fi of fnInstrs) {

                // The frees below are placed by position, not by path, so a variable can
                // be freed on a path where it was never allocated. Start every heap owner
                // as NULL (before the args are read) so that is a free(NULL) no-op.
                if (fi.op === "mov" && globalStores.has(fi)) result.push(freeOp(fi.dst));
                if (fi.op === "arg") paramsAwaitingCopy.add(fi.dst);
                if (fi.op === "mov" && allHeapVars.has(fi.dst) && !/^t\d+$/.test(fi.dst)) {
                    if (paramsAwaitingCopy.has(fi.dst)) {
                        paramsAwaitingCopy.delete(fi.dst);
                    } else { guardedFree(fi.dst) }
                    if (mixedVars.has(fi.dst)) {
                        result.push(fi);
                        result.push({ op: "const", dst: `__owns_${fi.dst}`, value: borrowMovs.has(fi) ? 0 : 1 });
                        continue;
                    }
                }
                if (fi.op === "array_push" || fi.op === "array_insert" || fi.op === "map_set") {
                    result.push(fi);
                    const holder = heldBy.get(fi.src) ?? fi.src;
                    if (allHeapVars.has(holder)) result.push({ op: "const", dst: holder, value: 0 });
                    continue;
                }
                if (fi.op === "array_store" || fi.op === "field_store") {
                    if (heapStores.has(fi)) {
                        const old = `__old_${oldCount++}`;
                        result.push(fi.op === "array_store"
                            ? { op: "array_load", dst: old, arr: fi.arr, index: fi.index }
                            : { op: "field_load", dst: old, base: fi.base, offset: fi.offset });
                        result.push({ op: "free", addr: old, type: fi.op === "array_store" ? fi.elemType : fi.fieldType });
                    }

                    result.push(fi);
                    const holder = heldBy.get(fi.src) ?? fi.src;
                    if (holder && allHeapVars.has(holder)) result.push({ op: "const", dst: holder, value: 0 });
                    continue;
                }
                if (fi.op === "enter") {
                    result.push(fi);
                    for (const v of allHeapVars) result.push({ op: "const", dst: v, value: 0 });
                    for (const v of mixedVars) result.push({ op: "const", dst: `__owns_${v}`, value: 0 });
                    continue;
                }

                if (fi.op === "label" && isLoopStart(fi.name)) {
                    loopDepth++;
                    loopLabelStack.push(fi.name);
                    result.push(fi);
                    continue;
                }

                if (fi.op === "label" && loopLabelStack.length > 0 && fi.name === loopEnd.get(loopLabelStack[loopLabelStack.length - 1])) {
                    loopLabelStack.pop();
                    loopDepth--;
                    result.push(fi);
                    continue;
                }

                const curLoop = loopLabelStack[loopLabelStack.length - 1];
                if (fi.op === "jmp" && curLoop !== undefined && (fi.target === curLoop || fi.target === loopEnd.get(curLoop))) {
                    for (const [v, d] of varScope) {
                        if (d === loopDepth) {
                            guardedFree(v)
                            result.push({ op: "const", dst: v, value: 0 });
                        }
                    }
                    result.push(fi);
                    continue;
                }

                if (fi.op === "ret") {
                    const returnedVal = fi.value;
                    const returnedOwner = returnedVal ? resolveOwner(returnedVal) : undefined;
                    for (const v of allHeapVars) {
                        if (v !== returnedOwner) {
                            guardedFree(v)
                        }
                    }
                }

                result.push(fi);
            }

            i = j + 1;
            continue;
        }

        result.push(instr);
        i++;
    }

    return result;
}

export function cse(instructions: IR[]): IR[] {
    const exprMap = new Map<string, string>();
    const out: IR[] = [];

    function key(op: string, a: string, b: string): string {
        return `${op}:${a}:${b}`;
    }

    for (const instr of instructions) {
        if (
            instr.op === "label" ||
            instr.op === "jmp" ||
            instr.op === "jz" ||
            instr.op === "jnz" ||
            instr.op === "call" ||
            instr.op === "enter" ||
            instr.op === "str_concat" ||
            instr.op === "str_eq" ||
            instr.op === "str_neq" ||
            instr.op == "array_new" || 
            instr.op == "array_len" || 
            instr.op == "array_load" || 
            instr.op == "array_store" 
        ) {
            exprMap.clear();
            out.push(instr);
            continue;
        }

        if ("dst" in instr) {
            const dst = (instr as any).dst;
            for (const [k] of exprMap) {
                if (k.includes(`:${dst}:`) || k.endsWith(`:${dst}`)) {
                    exprMap.delete(k);
                }
            }
        }

        if (
            instr.op === "add" || instr.op === "sub" ||
            instr.op === "mul" || instr.op === "div" ||
            instr.op === "mod" || instr.op === "and" ||
            instr.op === "or"  || instr.op === "xor" ||
            instr.op === "eq"  || instr.op === "neq" ||
            instr.op === "lt"  || instr.op === "lte" ||
            instr.op === "gt"  || instr.op === "gte"
        ) {
            const k = key(instr.op, instr.a, instr.b);
            if (exprMap.has(k)) {
                out.push({ op: "mov", dst: instr.dst, src: exprMap.get(k)! });
                continue;
            }
            exprMap.set(k, instr.dst);
        }

        out.push(instr);
    }

    return out;
}