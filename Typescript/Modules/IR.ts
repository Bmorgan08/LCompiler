import { Node, SIZED_INTS } from "./Parser";
import { lookupStruct, tupleTypeParts, fnTypeParts, mapTypeParts, isSizedInt, isSmallInt, isPtrType, sizeOfType } from "./Scope";
import { findFreshFunctions } from "./Fresh";

export type IR =
    | {op: "label", name: string}
    | {op: "jmp", target: string}
    | {op: "jz", cond: string, target: string}
    | {op: "jnz", cond: string, target: string}
    | {op: "call", dst?: string, fn: string, args: string[], returns_string?: boolean, returns_float?: boolean, returns_heap?: boolean, retType?: string}
    | {op: "eq", dst: string, a: string, b: string}
    | {op: "neq", dst: string, a: string, b: string}
    | {op: "lt", dst: string, a: string, b: string, unsigned?: boolean}    // unsigned: u64 values and addresses
    | {op: "lte", dst: string, a: string, b: string, unsigned?: boolean}
    | {op: "gt", dst: string, a: string, b: string, unsigned?: boolean}
    | {op: "gte", dst: string, a: string, b: string, unsigned?: boolean}
    | {op: "str_eq", dst: string, a: string, b: string}
    | {op: "str_neq", dst: string, a: string, b: string}
    | {op: "str_dup", dst: string, src: string}
    | {op: "add", dst: string, a: string, b: string}
    | {op: "sub", dst: string, a: string, b: string}
    | {op: "mul", dst: string, a: string, b: string}
    | {op: "div", dst: string, a: string, b: string, unsigned?: boolean}
    | {op: "and", dst: string, a: string, b: string}
    | {op: "or", dst: string, a: string, b: string}
    | {op: "xor", dst: string, a: string, b: string}
    | {op: "not", dst: string, src: string}
    | {op: "shl", dst: string, a: string, b: string}
    | {op: "shr", dst: string, a: string, b: string}      // logical: u64
    | {op: "sar", dst: string, a: string, b: string}      // arithmetic (keeps the sign): int and the signed types
    | {op: "bnot", dst: string, src: string}              // ~x (not is !x)
    | {op: "trunc", dst: string, src: string, type: string}   // cut a value to a sized integer type (u8, i16, ...)
    | {op: "mem_load", dst: string, addr: string, size: number, signed: boolean}   // read raw memory; never removed or merged
    | {op: "mem_store", addr: string, src: string, size: number}                   // write raw memory; never removed
    | {op: "global_addr", dst: string, name: string}      // the address of a global variable
    | {op: "extern_decl", name: string}                   // a function defined outside L (extern fn)
    | {op: "isr_stub", name: string, fn: string, errorCode: boolean}   // interrupt fn `name`: saves everything, calls fn, iretq
    | {op: "load", dst: string, addr: string, type: string}
    | {op: "store", addr: string, src: string, type: string}
    | {op: "alloc", dst: string, size: string | number, heapFields?: number[], type?: string}   // type: a tuple, e.g. "(string,int)"
    | {op: "free", addr: string, fields?: number[], type?: string}   // type: what addr holds, so its heap parts are freed first
    | {op: "lea", dst: string, base: string, offset: string}
    | {op: "mov", dst: string, src: string, decl?: boolean}   // decl: the mov that declares a variable
    | {op: "const", dst: string, value: number | string | bigint}   // bigint: int beyond 2^53
    | {op: "ret", value?: string}
    | {op: "str_concat", dst: string, a: string, b: string}
    | {op: "cast", dst: string, src: string, type: string}
    | {op: "typeof", dst: string, src: string}
    | {op: "string_const", dst: string, value: string}
    | {op: "enter", name: string, params: string[]}
    | {op: "leave"}
    | {op: "arg", dst: string, index: number, isFloat?: boolean}
    | {op: "itof", dst: string, src: string}
    | {op: "ftoi", dst: string, src: string}
    | {op: "fadd", dst: string, a: string, b: string}
    | {op: "fsub", dst: string, a: string, b: string}
    | {op: "fmul", dst: string, a: string, b: string}
    | {op: "fdiv", dst: string, a: string, b: string}
    | {op: "flt",  dst: string, a: string, b: string}
    | {op: "fgt",  dst: string, a: string, b: string}
    | {op: "flte", dst: string, a: string, b: string}
    | {op: "fgte", dst: string, a: string, b: string}
    | {op: "feq",  dst: string, a: string, b: string}
    | {op: "fneq", dst: string, a: string, b: string}
    | {op: "fneg", dst: string, src: string}
    | {op: "fconst", dst: string, value: number}
    | {op: "srcmap", file: string, line: number, col: number}
    | {op: "comment", text: string}
    | {op: "nop"}
    | {op: "asm_verbatim", text: string}
    | {op: "phi", dst: string, branches: {label: string, src: string}[]}
    | {op: "neg", dst: string, src: string}
    | {op: "abs", dst: string, src: string}
    | {op: "mod", dst: string, a: string, b: string, unsigned?: boolean}
    | {op: "array_new", dst: string, size: string | number, type?: string}   // type: e.g. "int[]", "string[]", "P[]"
    | {op: "array_store", arr: string, index: string, src: string, elemType?: string}
    | {op: "array_load", dst: string, arr: string, index: string, is_string?: boolean, is_float?: boolean}
    | {op: "array_len", dst: string, arr: string}
    | {op: "array_push", arr: string, src: string, elemType?: string}
    | {op: "array_insert", arr: string, index: string, src: string, elemType?: string}
    | {op: "array_pop", dst: string, arr: string, elemType?: string, is_string?: boolean, is_float?: boolean}      // the caller owns the element
    | {op: "array_remove", dst: string, arr: string, index: string, elemType?: string, is_string?: boolean, is_float?: boolean}
    | {op: "array_free_2d", arr: string, rows: string | number}
    | {op: "struct_alloc", dst: string, structName: string, numFields: number, heapFields?: number[]}
    | {op: "field_store", base: string, offset: number, src: string, fieldType?: string}
    | {op: "field_load", dst: string, base: string, offset: number, is_string?: boolean, is_float?: boolean}
    | {op: "vtable_call", dst: string, base: string, slot: number, args: string[], returns_string?: boolean, returns_float?: boolean, returns_heap?: boolean, retType?: string}
    | {op: "type_layout", name: string, fields: { offset: number, type: string }[], dynamic?: boolean}   // heap fields of a struct; dynamic: freed through its vtable
    | {op: "str_cmp", dst: string, a: string, b: string}                              // strcmp(a, b): <0, 0 or >0
    | {op: "str_sub", dst: string, src: string, start: string, end: string}           // new string src[start..end]
    | {op: "check_set", src: string, message: string}                                 // stop with `message` if src is NULL (a field never set)
    | {op: "func_addr", dst: string, fn: string}                                      // the address of function fn (a function value)
    | {op: "map_new", dst: string, stringKeys: boolean, type: string}
    | {op: "map_get", dst: string, map: string, key: string, is_string?: boolean, is_float?: boolean}   // stops if the key is missing
    | {op: "map_set", map: string, key: string, src: string, valType?: string}        // the value it replaces is freed
    | {op: "map_has", dst: string, map: string, key: string}
    | {op: "map_remove", map: string, key: string, valType?: string}                  // the removed value is freed
    | {op: "map_keys", dst: string, map: string, type: string}                        // a new array of the keys
    | {op: "map_len", dst: string, map: string}
    | {op: "call_indirect", dst: string, target: string, args: string[], returns_string?: boolean, returns_float?: boolean, returns_heap?: boolean, retType?: string}
    | {op: "vtable_ptr", dst: string, structName: string}
    | {op: "vtable_entry", structName: string, methodName: string, implName: string}

// IR is generated until the return types it learns stop changing, so a call knows what a
// function defined later in the file returns (a struct, a tuple's element types, ...)
export function IRGen(ast: Node): IR[] {
    // learning passes skip any function they can't generate yet (it may use a return type not
    // learned so far); the final pass reports errors
    let retTypes = new Map<string, string>();
    for (let pass = 0; pass < 4; pass++) {
        const result = generateIR(ast, retTypes, false);
        const same = result.retTypes.size === retTypes.size &&
            [...result.retTypes].every(([k, v]) => retTypes.get(k) === v);
        retTypes = result.retTypes;
        if (same) break;
    }
    return generateIR(ast, retTypes, true).instructions;
}

function generateIR(ast: Node, knownRetTypes: Map<string, string>, final: boolean): { instructions: IR[], retTypes: Map<string, string> } {
    const instructions: IR[] = [];
    let tempCount = 0;
    let labelCount = 0;
    const stringVars = new Set<string>();
    const floatTemps = new Set<string>();
    const loopStack: { startLabel: string, endLabel: string }[] = [];
    const stringFunctions = new Set<string>();
    const tupleStrings = new Map<string, Set<number>>()
    const heapFunctions = new Set<string>();
    // C runtime functions (Typescript/runtime/graphics.c) that return a double
    const floatFunctions = new Set<string>(["gfx_time"]);
    const StructLayouts = new Map<string, Map<String, number>>()
    const vtableSlots = new Map<string, Map<string, number>>()
    const structTypeMap = new Map<string, string>()
    let currentStructName: string| undefined
    let currentFunction: string | undefined
    const globalNames = new Set<string>();
    const globalFloatNames = new Set<string>();
    const functionParamTypes = new Map<string, (string | undefined)[]>();

    // ── Types ──
    // varTypes records each variable's type ("int", "string[]", "P", "P[]", "(string,int)" for a
    // tuple, ...); typeOf works out the type of any expression from it
    const varTypes = new Map<string, string>();
    const foundRetTypes = new Map<string, string>();   // function (".name" for a method) -> what it returns
    let currentRetKey: string | undefined;
    const elemT = (t?: string) => t?.endsWith("[]") ? t.slice(0, -2) : undefined;
    const structT = (t?: string) => t && /^[A-Z]/.test(t) && !t.endsWith("[]") ? t : undefined;
    // "(string,int[],P)" -> ["string", "int[]", "P"] (element types can't contain commas)
    const tupleElems = (t?: string) => t && t.startsWith("(") && t.endsWith(")") ? tupleTypeParts(t) : undefined;

    // declared return types (function f(): string) win over what was learned from the returns
    const declaredRet = new Map<string, string>();
    const externFns = new Set<string>();
    (function collect(n: Node) {
        if (n.type === "ExternFn") externFns.add(n.value!);
        if ((n.type === "Function" || n.type === "ExternFn") && n.varType) declaredRet.set(n.value!, n.varType);
        if (n.type === "StructMethod" && n.varType) declaredRet.set("." + n.value!, n.varType);
        n.children.forEach(collect);
    })(ast);
    // a known return type ("?" marks a function whose returns disagree)
    const rt = (key: string) => {
        if (declaredRet.has(key)) return declaredRet.get(key);
        const t = knownRetTypes.get(key);
        return t && t !== "?" ? t : undefined;
    };

    function typeOf(n: Node): string | undefined {
        switch (n.type) {
            case "Identifier":
                if (isFunctionName(n.value!)) return functionValueT(n.value!);
                return varTypes.get(n.value!) ?? (stringVars.has(n.value!) ? "string" : floatTemps.has(n.value!) ? "float" : structTypeMap.get(n.value!));
            case "This": return currentStructName;
            case "String": return "string";
            case "Char": return "char";
            case "Number": return n.varType === "float" ? "float" : "int";
            case "ArrayNew": return n.varType ?? "int[]";
            case "MapLiteral":
                return n.varType ?? (n.children.length ? `map<${typeOf(n.children[0]) ?? "int"},${typeOf(n.children[1]) ?? "int"}>` : undefined);
            case "ArrayLiteral": {
                if (n.varType) return n.varType;
                const ts = n.children.map(typeOf);
                if (ts.some(t => t === "float")) return "float[]";
                const first = ts.find(t => t !== undefined);
                return `${first ?? "int"}[]`;
            }
            case "StructInstantiate": return n.value!;
            case "Tuple": return `(${n.children.map(c => typeOf(c) ?? "int").join(",")})`;
            case "ArrayAccess": {
                const t = typeOf({ type: "Identifier", value: n.value, children: [] });
                return t === "string" ? "char" : elemT(t) ?? mapTypeParts(t)?.value;
            }
            case "ArrayAccess2D" as any: return elemT(elemT(typeOf({ type: "Identifier", value: n.value, children: [] })));
            case "IndexExpr": {
                const t = typeOf(n.children[0]);
                return t === "string" ? "char" : elemT(t) ?? mapTypeParts(t)?.value;
            }
            case "ArraySlice": return typeOf({ type: "Identifier", value: n.value, children: [] });
            case "SliceExpr": return typeOf(n.children[0]);
            case "ArrayLen": case "LenExpr": return "int";
            case "FieldAccess": {
                const s = structT(typeOf(n.children[0]));
                const f = s ? lookupStruct(s)?.fields.find(f => f.name === n.value) : undefined;
                return f ? String(f.type) : undefined;
            }
            case "TupleAccess": return tupleElems(typeOf(n.children[0]))?.[Number(n.value)];
            case "Call": {
                if (n.value!.includes(".")) {
                    const [obj, method] = n.value!.split(".");
                    const recv = obj === "this" ? undefined : typeOf({ type: "Identifier", value: obj, children: [] });
                    if (recv?.endsWith("[]")) return method === "pop" || method === "remove" ? elemT(recv) : "int";
                    if (mapTypeParts(recv)) return method === "keys" ? `${mapTypeParts(recv)!.key}[]` : "int";
                    return rt("." + method);
                }
                if (["inttostr", "inputstr", "chartostr", "str_upper", "str_lower", "floattostr"].includes(n.value!)) return "string";
                if (["len", "input", "strtoint", "str_find", "str_contains"].includes(n.value!)) return "int";
                if (stringFunctions.has(n.value!)) return "string";
                if (floatFunctions.has(n.value!)) return "float";
                if (!isFunctionName(n.value!)) { const f = fnTypeParts(varTypes.get(n.value!) ?? ""); if (f) return f.ret; }
                return rt(n.value!);
            }
            case "MethodCall": {
                const recv = typeOf(n.children[0]);
                if (recv?.endsWith("[]")) return n.value === "pop" || n.value === "remove" ? elemT(recv) : "int";
                if (mapTypeParts(recv)) return n.value === "keys" ? `${mapTypeParts(recv)!.key}[]` : "int";
                return rt("." + n.value!);
            }
            case "Binary": {
                if (["==", "!=", "<", "<=", ">", ">=", "&&", "||"].includes(n.value!)) return "int";
                const a = typeOf(n.children[0]), b = typeOf(n.children[1]);
                if (a === "string" || b === "string") return "string";
                if (a === "float" || b === "float") return "float";
                return "int";
            }
            case "Unary": return typeOf(n.children[0]);
            case "Cast": case "PtrLoad": return n.varType;
            case "AddrOf": return "u64";
            default: return undefined;
        }
    }

    // a name that refers to a function rather than a variable (a function value)
    function isFunctionName(name: string): boolean {
        return functionParamTypes.has(name) && !varTypes.has(name) && !stringVars.has(name) && !floatTemps.has(name) && !structTypeMap.has(name);
    }
    function functionValueT(name: string): string {
        return `fn(${(functionParamTypes.get(name) ?? []).map(t => t ?? "int").join(",")}):${rt(name) ?? "int"}`;
    }

    // record a value's type on the IR temp holding it, so later instructions know it
    function noteType(dst: string, t: string | undefined) {
        if (t === "string") stringVars.add(dst);
        if (t === "float") floatTemps.add(dst);
    }

    const fresh = () => `t${tempCount++}`;
    const freshLabel = (hint = "L") => `${hint}_${labelCount++}`;

    function emit(ir: IR) {
        instructions.push(ir);
    }

    // Structs with methods, a parent or a child have a vtable (a pointer at offset 0). Its first
    // slot is the struct's own free routine, so a child stored where its parent type is expected
    // is freed as the child; method slots follow.
    const structDefs = new Map<string, Node>();
    for (const c of ast.children) if (c.type === "StructDef") structDefs.set(c.value!, c);
    const parentNames = new Set([...structDefs.values()].map(d => d.parent).filter((p): p is string => !!p));
    function hasVtable(name: string): boolean {
        const def = lookupStruct(name);
        return (def?.methods.size ?? 0) > 0 || !!structDefs.get(name)?.parent || parentNames.has(name);
    }
    function ownMethodNames(name: string): Set<string> {
        const d = structDefs.get(name);
        if (!d) return new Set();
        return new Set([
            ...d.children.filter(c => c.type === "StructMethod"),
            ...d.children.filter(c => c.type === "StructOverrides").flatMap(o => o.children),
        ].map(m => m.value!));
    }
    // the struct whose code runs for `method` on a `name`: itself or the nearest ancestor defining it
    function implOwner(name: string, method: string): string {
        for (let s: string | undefined = name; s; s = structDefs.get(s)?.parent) {
            if (ownMethodNames(s).has(method)) return s;
        }
        return name;
    }

    function getLayout(structName: string): Map<String, number> {
        if (StructLayouts.has(structName)) return StructLayouts.get(structName)!
        const layout = new Map<String, number>()
        const def = lookupStruct(structName)
        if (!def) throw new Error(`Unknown struct: ${structName}`)
        let offset = hasVtable(structName) ? 8:0
        def.fields.forEach(f => {
            layout.set(f.name, offset)
            offset += 8
        })
        StructLayouts.set(structName, layout)
        return layout
    }

    function getVtableSlot(structName: string, methodName: string): number {
        if (!vtableSlots.has(structName)) {
            const slots = new Map<string, number>()
            const def = lookupStruct(structName)
            if (def) {
                let i = 1       // slot 0 is the free routine
                def.methods.forEach((_, name) => {
                    slots.set(name, i++)
                })
            }
            vtableSlots.set(structName, slots)
        }
        const slot = vtableSlots.get(structName)!.get(methodName)
        if (slot === undefined )throw new Error(`Unknown method '${methodName}' on struct '${structName}'`);
        return slot
    }

    function getStructTypeOf(node: Node): string {
        if (node.type === "This") return currentStructName!;
        const t = (node.type === "Identifier" ? structTypeMap.get(node.value!) : undefined) ?? structT(typeOf(node));
        if (!t) throw new Error(`'${node.value ?? node.type}' is not a struct instance`);
        return t
    }

    // the int side of a float operation is converted first; a float is used as it is
    function asFloat(v: string): string {
        if (floatTemps.has(v)) return v;
        const conv = fresh();
        emit({ op: "itof", dst: conv, src: v });
        floatTemps.add(conv);
        return conv;
    }

    function isFreshString(name: string): boolean {
        const producer = [...instructions].reverse().find(i =>
            'dst' in i && (i as any).dst === name
        );
        if (!producer) return false;
        if (producer.op === "str_concat" || producer.op === "str_dup" || producer.op === "str_sub") return true
        if ((producer.op === "array_pop" || producer.op === "array_remove") && producer.is_string) return true
        if (producer.op === "call") return producer.returns_string === true
        return false
    }

    function isAssigned(node: Node, name: string): boolean {
        if (node.type === "Assign" && node.value === name) return true;
        if (node.type === "CompoundAssign" && node.children[0].value === name) return true;
        return node.children.some(c => isAssigned(c, name));
    }

    function ownField(src: string): string {
        if (!isStringTemp(src) || isFreshString(src)) return src
        const copy = fresh()
        emit({ op: "str_dup", dst: copy, src })
        return copy
    }

    function ownString(dst: string, src: string): string {
        if(!stringVars.has(dst) || !isStringTemp(src) || isFreshString(src)) return src
        const copy = fresh()
        emit({ op: "str_dup", dst: copy, src })
        return copy
    }

    function isStringTemp(name: string): boolean {
        if (stringVars.has(name)) return true;
        const producer = [...instructions].reverse().find(i =>
            'dst' in i && (i as any).dst === name
        );
        if (!producer) return false;
        if (producer.op === "string_const" || producer.op === "str_concat") return true;
        if (producer.op === "call") return producer.returns_string === true;
        if (producer.op === "arg") return stringVars.has(name);
        if (producer.op === "mov") {
            const src = (producer as any).src;
            if (!isNaN(Number(src))) return false;
            return isStringTemp(src);
        }
        return false;
    }

    function collectStringFunctions(node: Node) {
        if (node.type === "Function") {
            const body = node.children.find(c => c.type === "Block");
            if (body) {
                const localStringVars = new Set<string>();
                for (const param of node.children) {
                    if (param.type === "Identifier" && param.varType === "string") {
                        localStringVars.add(param.value!);
                    }
                }
                function collectVarTypes(n: Node) {
                    if ((n.type === "VarDecl") && n.varType === "string") {
                        localStringVars.add(n.value!);
                    
                    }
                    n.children.forEach(collectVarTypes);
                }
                node.children.forEach(collectVarTypes);
                collectVarTypes(body);
                if (functionReturnsString(body, localStringVars)) {
                    stringFunctions.add(node.value!);
                }
            }
        }
        node.children.forEach(collectStringFunctions);
    }

    function functionReturnsFloat(node: Node): boolean {
        const floatVarNames = new Set<string>([
            ...globalFloatNames,
            ...node.children
                .filter(c => c.type === "Identifier" && c.varType === "float")
                .map(c => c.value!)
        ]);
        function collectFloatLocals(n: Node) {
            if (n.type === "VarDecl" && n.varType === "float") floatVarNames.add(n.value!);
            n.children.forEach(collectFloatLocals);
        }
        const body = node.children.find(c => c.type === "Block");
        if (body) collectFloatLocals(body);


        function isFloatExpr(n: Node): boolean {
            if (n.type === "Number" && n.varType === "float") return true;
            if (n.type === "Identifier" && floatVarNames.has(n.value!)) return true;
            if (n.type === "Unary" && n.value === "-") return isFloatExpr(n.children[0]);
            if (n.type === "Binary") return isFloatExpr(n.children[0]) || isFloatExpr(n.children[1]);
            if (n.type === "Call") return floatFunctions.has(n.value!);
            return false;
        }
        function hasFloatReturn(n: Node): boolean {
            if (n.type === "Return") return isFloatExpr(n.children[0]);
            return n.children.some(hasFloatReturn);
        }
        return body ? hasFloatReturn(body) : false;
    }

    function collectFloatFunctions(node: Node) {
        if (node.type === "Function") {
            if (functionReturnsFloat(node)) {
                floatFunctions.add(node.value!);
            }
        }
        node.children.forEach(collectFloatFunctions);
    }

    function isStringExpr(node: Node, localStringVars: Set<string>): boolean {
        if (node.type === "String") return true;
        if (node.type === "Identifier") return localStringVars.has(node.value!);
        if (node.type === "Call") return stringFunctions.has(node.value!) || node.value === "inttostr" || node.value === "inputstr";
        if (node.type === "Binary" && node.value === "+")
            return isStringExpr(node.children[0], localStringVars) || isStringExpr(node.children[1], localStringVars);
        return false;
    }

    function functionReturnsString(node: Node, localStringVars: Set<string>): boolean {
        if (node.type === "Return") {
            const val = node.children[0];
            return isStringExpr(val, localStringVars);
        }
        return node.children.some(c => functionReturnsString(c, localStringVars));
    }

    // a value stored into an array element or struct field of type `slot`: ints become floats in a
    // float slot, and strings are copied (the container owns and frees its strings)
    function storeValue(val: string, slot: string | undefined): string {
        if (slot === "float") return asFloat(val);
        if (slot === "string") return ownField(val);
        return val;
    }

    // load element `index` of the array in `arr`, whose elements have type `elem`
    function loadElement(arr: string, index: string, elem: string | undefined): string {
        const dst = fresh();
        emit({ op: "array_load", dst, arr, index, is_string: elem === "string", is_float: elem === "float" });
        noteType(dst, elem);
        if (elem && structT(elem)) structTypeMap.set(dst, elem);
        if (elem) varTypes.set(dst, elem);
        return dst;
    }

    // a[start..end] as a new array (string elements are copied) or, for a string, a new string
    function genSlice(base: string, baseType: string | undefined, startNode: Node, endNode: Node): string {
        const start = genExpr(startNode);
        const end = genExpr(endNode);
        if (baseType === "string") {
            const dst = fresh();
            emit({ op: "str_sub", dst, src: base, start, end });
            stringVars.add(dst);
            return dst;
        }
        const elem = elemT(baseType);
        // values read inside the copy loop live in named slots (copyProp clears its environment at labels)
        const startSlot = `__slice_start_${labelCount}`;
        const baseSlot = `__slice_base_${labelCount}`;
        const lenSlot = `__slice_len_${labelCount}`;
        emit({ op: "mov", dst: startSlot, src: start });
        emit({ op: "mov", dst: baseSlot, src: base });
        const len = fresh();
        emit({ op: "sub", dst: len, a: end, b: start });
        emit({ op: "mov", dst: lenSlot, src: len });
        const dst = fresh();
        emit({ op: "array_new", dst, size: lenSlot, type: baseType ?? "int[]" });
        const dstSlot = `__slice_dst_${labelCount}`;
        emit({ op: "mov", dst: dstSlot, src: dst });
        const i = `__slice_i_${labelCount}`;
        const startLabel = freshLabel("slice_loop");
        const endLabel = freshLabel("slice_end");
        emit({ op: "const", dst: i, value: 0 });
        emit({ op: "label", name: startLabel });
        const cond = fresh();
        emit({ op: "lt", dst: cond, a: i, b: lenSlot });
        emit({ op: "jz", cond, target: endLabel });
        const srcIdx = fresh();
        emit({ op: "add", dst: srcIdx, a: i, b: startSlot });
        const el = loadElement(baseSlot, srcIdx, elem);
        emit({ op: "array_store", arr: dstSlot, index: i, src: storeValue(el, elem), elemType: elem });
        const next = fresh();
        emit({ op: "add", dst: next, a: i, b: "1" });
        emit({ op: "mov", dst: i, src: next });
        emit({ op: "jmp", target: startLabel });
        emit({ op: "label", name: endLabel });
        const out = fresh();
        emit({ op: "mov", dst: out, src: dstSlot });
        return out;
    }

    // m[k]: the value stored under k (the program stops if it isn't there)
    function genMapGet(mapNode: Node | string, mapType: string, keyNode: Node): string {
        const m = mapTypeParts(mapType)!;
        const map = typeof mapNode === "string" ? mapNode : genExpr(mapNode);
        const key = genExpr(keyNode);
        const dst = fresh();
        emit({ op: "map_get", dst, map, key, is_string: m.value === "string", is_float: m.value === "float" });
        noteType(dst, m.value);
        varTypes.set(dst, m.value);
        if (structT(m.value)) structTypeMap.set(dst, m.value);
        return dst;
    }

    // m[k] = v: a string value is copied, a heap value moves in, and the value it replaces is freed
    function genMapSet(map: string, mapType: string, keyNode: Node, valueNode: Node) {
        const m = mapTypeParts(mapType)!;
        const key = genExpr(keyNode);
        const src = storeValue(genExpr(valueNode), m.value);
        emit({ op: "map_set", map, key, src, valType: m.value });
    }

    // m.has(k), m.remove(k), m.keys(), m.len()
    function genMapMethod(receiver: Node, method: string, argNodes: Node[]): string {
        const t = typeOf(receiver)!;
        const m = mapTypeParts(t)!;
        const map = genExpr(receiver);
        const dst = fresh();
        switch (method) {
            case "has": emit({ op: "map_has", dst, map, key: genExpr(argNodes[0]) }); return dst;
            case "remove": emit({ op: "map_remove", map, key: genExpr(argNodes[0]), valType: m.value }); return "0";
            case "len": emit({ op: "map_len", dst, map }); return dst;
            case "keys":
                emit({ op: "map_keys", dst, map, type: `${m.key}[]` });
                varTypes.set(dst, `${m.key}[]`);
                return dst;
        }
        throw new Error(`Unknown map method '${method}'`);
    }

    // a.push(v), a.pop(), a.insert(i, v), a.remove(i) on an array
    function genArrayMethod(receiver: Node, method: string, argNodes: Node[]): string {
        const elem = elemT(typeOf(receiver));
        const arr = genExpr(receiver);
        switch (method) {
            case "push": {
                const src = storeValue(genExpr(argNodes[0]), elem);
                emit({ op: "array_push", arr, src, elemType: elem });
                return "0";
            }
            case "insert": {
                const index = genExpr(argNodes[0]);
                const src = storeValue(genExpr(argNodes[1]), elem);
                emit({ op: "array_insert", arr, index, src, elemType: elem });
                return "0";
            }
            case "pop":
            case "remove": {
                const dst = fresh();
                const flags = { elemType: elem, is_string: elem === "string", is_float: elem === "float" };
                if (method === "pop") emit({ op: "array_pop", dst, arr, ...flags });
                else emit({ op: "array_remove", dst, arr, index: genExpr(argNodes[0]), ...flags });
                noteType(dst, elem);
                if (elem) varTypes.set(dst, elem);
                if (structT(elem)) structTypeMap.set(dst, elem!);
                return dst;
            }
        }
        throw new Error(`Unknown array method '${method}'`);
    }

    // receiver.method(args): a virtual call through the receiver's vtable
    function genMethodCall(receiver: Node, methodName: string, argNodes: Node[], at: Node): string {
        if (receiver.type !== "This" && typeOf(receiver)?.endsWith("[]")) return genArrayMethod(receiver, methodName, argNodes);
        if (receiver.type !== "This" && mapTypeParts(typeOf(receiver))) return genMapMethod(receiver, methodName, argNodes);
        const structName = receiver.type === "This" ? currentStructName : structT(typeOf(receiver));
        if (!structName) throw new Error(`'${receiver.value ?? "value"}' is not a struct`);
        const slot = getVtableSlot(structName, methodName);
        const base = receiver.type === "This" ? "__this" : genExpr(receiver);
        // convert int <-> float arguments to the method's parameter types, as for a function call
        const implNode = structDefs.get(implOwner(structName, methodName));
        const methodNode = implNode ? [
            ...implNode.children.filter(c => c.type === "StructMethod"),
            ...implNode.children.filter(c => c.type === "StructOverrides").flatMap(o => o.children),
        ].find(m => m.value === methodName) : undefined;
        const paramTypesOf = methodNode?.children.filter(c => c.type === "Identifier").map(c => c.varType) ?? [];
        const args = argNodes.map((a, i) => {
            const v = genExpr(a);
            if (paramTypesOf[i] === "float") return asFloat(v);
            if (paramTypesOf[i] === "int" && floatTemps.has(v)) { const c = fresh(); emit({ op: "ftoi", dst: c, src: v }); return c; }
            return v;
        });
        const dst = fresh();
        const key = "." + methodName;
        const known = rt(key);
        const returnsString = known === "string";
        const returnsFloat = known === "float";
        const returnsHeap = heapFunctions.has(key);
        noteType(dst, known);
        if (returnsHeap && known) varTypes.set(dst, known);
        emit({ op: "vtable_call", dst, base, slot, args: [base, ...args], returns_string: returnsString,
               returns_float: returnsFloat, returns_heap: returnsHeap, retType: returnsHeap ? known : undefined });
        return dst;
    }

    // set while generating the field in `x.f == none`, so that read skips the never-set check
    let readingForNoneCheck = false;

    // the address of a PtrLoad / PtrStore / AddrOf: pointer + index * element size + field offset
    function ptrAddress(node: Node): string {
        const { scale, offset } = node.ptr!;
        let addr = genExpr(node.children[0]);
        let constOffset = offset;
        const idx = node.children[1];
        if (idx.type === "Number" && /^\d+$/.test(idx.value!)) {
            constOffset += Number(idx.value) * scale;
        } else {
            let i = genExpr(idx);
            if (scale !== 1) { const scaled = fresh(); emit({ op: "mul", dst: scaled, a: i, b: String(scale) }); i = scaled; }
            const sum = fresh();
            emit({ op: "add", dst: sum, a: addr, b: i });
            addr = sum;
        }
        if (constOffset !== 0) {
            const at = fresh();
            emit({ op: "add", dst: at, a: addr, b: String(constOffset) });
            addr = at;
        }
        return addr;
    }

    function genExpr(node: Node): string {
        switch (node.type) {
            case "MapLiteral": {
                const type = typeOf(node)!;
                const m = mapTypeParts(type)!;
                const dst = fresh();
                emit({ op: "map_new", dst, stringKeys: m.key === "string", type });
                varTypes.set(dst, type);
                for (let i = 0; i < node.children.length; i += 2) genMapSet(dst, type, node.children[i], node.children[i + 1]);
                return dst;
            }
            case "None": {
                const dst = fresh();
                emit({ op: "const", dst, value: 0 });
                return dst;
            }
            case "MethodCall":
                return genMethodCall(node.children[0], node.value!, node.children.slice(1), node);


            case "StructInstantiate": {
                const def = lookupStruct(node.value!);
                const dst = fresh()
                if (!def) throw new Error(`Unknown struct: ${node.value}`);
                const layout = getLayout(node.value!);

                const withVtable = hasVtable(node.value!)
                const heapFields = def.fields
                    .filter(f => f.type === "string" || String(f.type).endsWith("[]"))
                    .map(f => layout.get(f.name)!)
                emit({ op: "struct_alloc", dst, structName: node.value!, numFields: def.fields.length + (withVtable ? 1:0), heapFields });

                if (withVtable) {
                    const vtablePtr = fresh();
                    emit({ op: "vtable_ptr", dst: vtablePtr, structName: node.value! });
                    emit({ op: "field_store", base: dst, offset: 0, src: vtablePtr });
                }

                node.children.forEach(fieldNode => {
                    const offset = layout.get(fieldNode.value!);
                    if (offset === undefined) throw new Error(`Unknown field: ${fieldNode.value}`);
                    const fieldType = String(def.fields.find(f => f.name === fieldNode.value)?.type ?? "");
                    const val = storeValue(genExpr(fieldNode.children[0]), fieldType);
                    emit({ op: "field_store", base: dst, offset, src: ownField(val), fieldType });
                });
                // fields the literal leaves out get their default, evaluated afresh for each struct
                const given = new Set(node.children.map(f => f.value));
                for (const f of def.fields) {
                    if (given.has(String(f.name)) || !f.default) continue;
                    const fieldType = String(f.type);
                    const val = storeValue(genExpr(f.default), fieldType);
                    emit({ op: "field_store", base: dst, offset: layout.get(f.name)!, src: ownField(val), fieldType });
                }

                return dst;
            }

            case "This": {
                const dst = fresh()
                emit({ op: "mov", dst, src: "__this" })
                return dst
            }

            case "FieldAccess": {
                // only the outermost field of `a.b.c == none` skips the never-set check
                const skipSetCheck = readingForNoneCheck
                readingForNoneCheck = false
                const obj = node.children[0]
                const objReg = genExpr(obj)
                const dst = fresh()

                const structName = getStructTypeOf(obj)
                const layout = getLayout(structName)
                const offset = layout.get(node.value!)
                if (offset === undefined) throw new Error(`Unknown field: ${node.value}`);

                const fieldType = typeOf(node)
                const isString = fieldType === "string"
                noteType(dst, fieldType)
                if (fieldType) varTypes.set(dst, fieldType)
                if (structT(fieldType)) structTypeMap.set(dst, fieldType!)

                emit({ op: "field_load", dst, base: objReg, offset, is_string: isString, is_float: fieldType === "float" });
                // a string, array or struct field with no default that was never set is NULL
                if (isHeapT(fieldType) && !skipSetCheck) {
                    emit({ op: "check_set", src: dst, message: `Error: ${structName}.${node.value} was never set (or is none)` });
                }
                return dst;

            }

            case "ArrayNew": {
                if (node.children.length > 1) {
                    // 2D: allocate outer array, then allocate each row.
                    // Store rows/cols into stable named slots so copyProp label-clears
                    // don't lose the values across the init loop back-edge.
                    const rowsTemp = genExpr(node.children[0]);
                    const colsTemp = genExpr(node.children[1]);
                    const rowsSlot = `__arr2d_rows_${labelCount}`;
                    const colsSlot = `__arr2d_cols_${labelCount}`;
                    emit({ op: "mov", dst: rowsSlot, src: rowsTemp });
                    emit({ op: "mov", dst: colsSlot, src: colsTemp });
                    const dst = fresh();
                    const outerType = node.varType ?? "int[][]";
                    emit({ op: "array_new", dst, size: rowsSlot, type: outerType });
                    const loopIdx = fresh();
                    emit({ op: "const", dst: loopIdx, value: 0 });
                    const startLabel = freshLabel("arr2d_init");
                    const endLabel = freshLabel("arr2d_end");
                    emit({ op: "label", name: startLabel });
                    const cond = fresh();
                    emit({ op: "lt", dst: cond, a: loopIdx, b: rowsSlot });
                    emit({ op: "jz", cond, target: endLabel });
                    const row = fresh();
                    emit({ op: "array_new", dst: row, size: colsSlot, type: elemT(outerType) });
                    emit({ op: "array_store", arr: dst, index: loopIdx, src: row, elemType: elemT(outerType) });
                    const next = fresh();
                    emit({ op: "add", dst: next, a: loopIdx, b: "1" });
                    emit({ op: "mov", dst: loopIdx, src: next });
                    emit({ op: "jmp", target: startLabel });
                    emit({ op: "label", name: endLabel });
                    return dst;
                }
                const type = node.varType ?? "int[]";
                const elem = elemT(type)!;
                const size = genExpr(node.children[0]);
                const dst = fresh();
                emit({ op: "array_new", dst, size, type });
                // strings start as "" and structs as zeroed instances, so every element is usable
                if (elem === "string" || structT(elem)) {
                    const sizeSlot = `__arrinit_size_${labelCount}`;
                    const arrSlot = `__arrinit_arr_${labelCount}`;
                    emit({ op: "mov", dst: sizeSlot, src: size });
                    emit({ op: "mov", dst: arrSlot, src: dst });
                    const idx = `__arrinit_idx_${labelCount}`;
                    emit({ op: "const", dst: idx, value: 0 });
                    const startLabel = freshLabel("arrinit");
                    const endLabel = freshLabel("arrinit_end");
                    emit({ op: "label", name: startLabel });
                    const cond = fresh();
                    emit({ op: "lt", dst: cond, a: idx, b: sizeSlot });
                    emit({ op: "jz", cond, target: endLabel });
                    const value = elem === "string"
                        ? genExpr({ type: "String", value: "", children: [] })
                        : genExpr({ type: "StructInstantiate", value: elem, children: [] });
                    emit({ op: "array_store", arr: arrSlot, index: idx, src: elem === "string" ? ownField(value) : value, elemType: elem });
                    const next = fresh();
                    emit({ op: "add", dst: next, a: idx, b: "1" });
                    emit({ op: "mov", dst: idx, src: next });
                    emit({ op: "jmp", target: startLabel });
                    emit({ op: "label", name: endLabel });
                    const out = fresh();
                    emit({ op: "mov", dst: out, src: arrSlot });
                    return out;
                }
                return dst;
            }

            case "ArrayLiteral": {
                const type = typeOf(node)!;
                const elem = elemT(type);
                const dst = fresh();
                const size = node.children.length;
                emit({ op: "array_new", dst, size, type });
                node.children.forEach((el, i) => {
                    emit({ op: "array_store", arr: dst, index: String(i), src: storeValue(genExpr(el), elem), elemType: elem });
                });
                return dst;
            }

            case "ArrayAccess": {
                const accessed = typeOf({ type: "Identifier", value: node.value, children: [] });
                if (mapTypeParts(accessed)) return genMapGet(node.value!, accessed!, node.children[0]);
                const index = genExpr(node.children[0])
                const dst = fresh()
                if(stringVars.has(node.value!)) {
                    const base = fresh()
                    emit({ op: "mov", dst: base, src: node.value!})
                    emit({ op: "lea", dst, base, offset: index })
                    emit({ op: "load", dst, addr: dst, type: "i8" })
                } else {
                    const elem = elemT(typeOf({ type: "Identifier", value: node.value, children: [] }));
                    emit({ op: "array_load", dst, arr: node.value!, index, is_string: elem === "string", is_float: elem === "float" });
                    noteType(dst, elem);
                    if (elem) varTypes.set(dst, elem);
                    if (structT(elem)) structTypeMap.set(dst, elem!);
                }
                return dst
            }

            case "ArrayAccess2D" as any: {
                const i = genExpr(node.children[0]);
                const j = genExpr(node.children[1]);
                const row = fresh();
                const dst = fresh();
                const elem2 = elemT(elemT(typeOf({ type: "Identifier", value: node.value, children: [] })));
                emit({ op: "array_load", dst: row, arr: node.value!, index: i });
                emit({ op: "array_load", dst, arr: row, index: j, is_float: elem2 === "float" });
                noteType(dst, elem2);
                return dst;
            }

            case "ArrayLen": {
                const dst = fresh();
                // s.len() on a string is its length in characters
                const lenType = typeOf({ type: "Identifier", value: node.value, children: [] });
                if (lenType === "string") {
                    emit({ op: "call", dst, fn: "len", args: [node.value!] });
                } else if (mapTypeParts(lenType)) {
                    emit({ op: "map_len", dst, map: node.value! });
                } else {
                    emit({ op: "array_len", dst, arr: node.value! });
                }
                return dst;
            }

            case "Unary": {
                const src = genExpr(node.children[0]);
                const dst = fresh();
                if (node.value === "-") {
                    if (node.children[0].varType === "float" || floatTemps.has(src)) {
                        emit({ op: "fneg", dst, src });
                        floatTemps.add(dst);
                    } else {
                        emit({ op: "neg", dst, src });
                    }
                } else if (node.value === "!") {
                    emit({ op: "not", dst, src });
                } else if (node.value === "~") {
                    emit({ op: "bnot", dst, src });
                }
                return dst;
            }

            case "Cast": {
                let v = genExpr(node.children[0]);
                if (floatTemps.has(v)) { const c = fresh(); emit({ op: "ftoi", dst: c, src: v }); v = c; }
                // int, u64 and pointers are the same 64 bits; smaller types are cut to size
                if (!isSmallInt(node.varType)) return v;
                const dst = fresh();
                emit({ op: "trunc", dst, src: v, type: node.varType! });
                return dst;
            }

            case "PtrLoad": {
                const addr = ptrAddress(node);
                const t = String(node.varType);
                const dst = fresh();
                emit({ op: "mem_load", dst, addr, size: sizeOfType(t)!, signed: t === "int" || !!SIZED_INTS[t]?.signed });
                return dst;
            }

            case "AddrOf": {
                const dst = fresh();
                if (node.varType === "function") { emit({ op: "func_addr", dst, fn: node.value! }); return dst; }
                if (node.varType === "global") { emit({ op: "global_addr", dst, name: node.value! }); return dst; }
                return ptrAddress(node);
            }
            case "Number": {
                const dst = fresh();
                if (node.varType === "float") {
                    emit({ op: "fconst", dst, value: Number(node.value) });
                    floatTemps.add(dst);
                } else {
                    // JS numbers are exact only up to 2^53; beyond that keep the 64-bit value as a bigint
                    const n = Number(node.value);
                    const exact = Number.isSafeInteger(n) || !/^-?\d+$/.test(node.value!);
                    emit({ op: "const", dst, value: exact ? n : BigInt.asIntN(64, BigInt(node.value!)) });
                }
                return dst;
            }
            case "String": {
                const dst = fresh();
                emit({ op: "string_const", dst, value: node.value! });
                return dst;
            }

            case "Identifier": {
                const dst = fresh();
                if (isFunctionName(node.value!)) {
                    // a function value: the caller of the value owns what it returns, so a function
                    // returning an array/struct must always return a new one
                    const ret = rt(node.value!);
                    if (isHeapT(ret) && ret !== "string" && !heapFunctions.has(node.value!)) {
                        throw new Error(`${node.line}:${node.col}: ${node.value} can only be used as a value if it always returns a new ${ret}`);
                    }
                    emit({ op: "func_addr", dst, fn: node.value! });
                    varTypes.set(dst, functionValueT(node.value!));
                    return dst;
                }
                if (floatTemps.has(node.value!)) floatTemps.add(dst);
                emit({ op: "mov", dst, src: node.value! });
                return dst;
            }

            case "Binary": {
                // Both paths write a named slot; copyProp keeps movs into named
                // variables and clears its environment at the labels, so the
                // writes survive (as with __match_subj_N / __forin_*).
                if (node.value === "&&" || node.value === "||") {
                    const isAnd = node.value === "&&";
                    const labelShort = freshLabel("sc");
                    const labelEnd = freshLabel("sc");
                    const slot = `__sc_${labelCount}`;
                    const lhsVal = genExpr(node.children[0]);
                    if (isAnd) {
                        emit({ op: "jz", cond: lhsVal, target: labelShort });
                    } else {
                        emit({ op: "jnz", cond: lhsVal, target: labelShort });
                    }
                    const rhsVal = genExpr(node.children[1]);
                    // the result is a bool: normalise the right operand to 0/1
                    const rhsBool = fresh();
                    emit({ op: "neq", dst: rhsBool, a: rhsVal, b: "0" });
                    emit({ op: "mov", dst: slot, src: rhsBool });
                    emit({ op: "jmp", target: labelEnd });
                    emit({ op: "label", name: labelShort });
                    const shortConst = fresh();
                    emit({ op: "const", dst: shortConst, value: isAnd ? 0 : 1 });
                    emit({ op: "mov", dst: slot, src: shortConst });
                    emit({ op: "label", name: labelEnd });
                    const dst = fresh();
                    emit({ op: "mov", dst, src: slot });
                    return dst;
                }

                // p + n / p - n: n elements of the pointer's type
                if (node.ptr && (node.value === "+" || node.value === "-")) {
                    const p = genExpr(node.children[0]);
                    let n = genExpr(node.children[1]);
                    if (node.ptr.scale !== 1) { const scaled = fresh(); emit({ op: "mul", dst: scaled, a: n, b: String(node.ptr.scale) }); n = scaled; }
                    const dst = fresh();
                    emit({ op: node.value === "+" ? "add" : "sub", dst, a: p, b: n });
                    return dst;
                }

                // x == none / x != none: compare with 0, reading a field without the never-set check
                if ((node.value === "==" || node.value === "!=") && (node.children[0].type === "None" || node.children[1].type === "None")) {
                    const other = node.children[0].type === "None" ? node.children[1] : node.children[0];
                    readingForNoneCheck = other.type === "FieldAccess";
                    const v = other.type === "None" ? "0" : genExpr(other);
                    readingForNoneCheck = false;
                    const dst = fresh();
                    emit({ op: node.value === "==" ? "eq" : "neq", dst, a: v, b: "0" });
                    return dst;
                }
                const isStringSide = (n: Node) => n.type === "String" || n.varType === "string" ||
                    (n.type === "Identifier" && stringVars.has(n.value!)) || typeOf(n) === "string";
                if (node.value === "==" || node.value === "!=") {
                    if (isStringSide(node.children[0]) || isStringSide(node.children[1])) {
                        const a = genExpr(node.children[0]);
                        const b = genExpr(node.children[1]);
                        const dst = fresh();
                        emit({op: node.value === "==" ? "str_eq" : "str_neq", dst, a, b});
                        return dst;
                    }
                }
                // strings order alphabetically (byte by byte): compare strcmp's result with 0
                if (["<", "<=", ">", ">="].includes(node.value!) && isStringSide(node.children[0]) && isStringSide(node.children[1])) {
                    const a = genExpr(node.children[0]);
                    const b = genExpr(node.children[1]);
                    const cmp = fresh();
                    emit({ op: "str_cmp", dst: cmp, a, b });
                    const ops: Record<string, IR["op"]> = { "<": "lt", "<=": "lte", ">": "gt", ">=": "gte" };
                    const dst = fresh();
                    emit({ op: ops[node.value!], dst, a: cmp, b: "0" } as IR);
                    return dst;
                }

                if (node.value === "+") {
                    const a = genExpr(node.children[0]);
                    const b = genExpr(node.children[1]);
                    if (isStringTemp(a) || isStringTemp(b)) {
                        const dst = fresh();
                        emit({ op: "str_concat", dst, a, b });
                        stringVars.add(dst);
                        return dst;
                    }
                    const isFloatAdd = node.children[0].varType === "float" || node.children[1].varType === "float"
                        || floatTemps.has(a) || floatTemps.has(b);
                    const dst = fresh();
                    if (isFloatAdd) {
                        emit({ op: "fadd", dst, a: asFloat(a), b: asFloat(b) } as IR);
                        floatTemps.add(dst);
                    } else {
                        emit({ op: "add", dst, a, b });
                    }
                    return dst;
                }

                const a = genExpr(node.children[0]);
                const b = genExpr(node.children[1]);
                const dst = fresh();

                const isFloat = node.children[0].varType === "float" || node.children[1].varType === "float"
                    || floatTemps.has(a) || floatTemps.has(b);
                if (isFloat) {
                    const floatOpMap: Record<string, IR["op"]> = {
                        "+": "fadd", "-": "fsub", "*": "fmul", "/": "fdiv",
                        "==": "feq", "!=": "fneq",
                        "<": "flt", "<=": "flte", ">": "fgt", ">=": "fgte",
                    };
                    const fop = floatOpMap[node.value!];
                    if (!fop) throw new Error(`Unknown float op: ${node.value}`);
                    emit({ op: fop, dst, a: asFloat(a), b: asFloat(b) } as IR);
                    // arithmetic ops produce float; comparison ops produce int (0/1)
                    if (["fadd","fsub","fmul","fdiv","fneg"].includes(fop as string)) floatTemps.add(dst);
                    return dst;
                }

                const opMap: Record<string, IR["op"]> = {
                    "+": "add", "-": "sub", "*": "mul", "/": "div", "%": "mod",
                    "==": "eq", "!=": "neq",
                    "<": "lt",  "<=": "lte",
                    ">": "gt",  ">=": "gte",
                    "&": "and", "|": "or", "^": "xor", "<<": "shl", ">>": node.unsigned ? "shr" : "sar",
                };
                const op = opMap[node.value!];
                if (!op) throw new Error(`Unknown binary op: ${node.value}`);
                const unsigned = node.unsigned && ["lt", "lte", "gt", "gte", "div", "mod"].includes(op);
                emit({ op, dst, a, b, ...(unsigned ? { unsigned: true } : {}) } as IR);
                return dst;
            }

            case "Call": {

                if (node.value!.includes(".")) {
                    const [objName, methodName] = node.value!.split(".")
                    const receiver: Node = objName === "this" ? { type: "This", children: [] } : { type: "Identifier", value: objName, children: [] }
                    return genMethodCall(receiver, methodName, node.children, node)
                }

                // a call through a variable holding a function
                const valueType = !isFunctionName(node.value!) ? fnTypeParts(varTypes.get(node.value!) ?? "") : undefined;
                if (valueType) {
                    const args = node.children.map((a, i) => {
                        const v = genExpr(a);
                        if (valueType.params[i] === "float") return asFloat(v);
                        if (valueType.params[i] === "int" && floatTemps.has(v)) { const c = fresh(); emit({ op: "ftoi", dst: c, src: v }); return c; }
                        return v;
                    });
                    const dst = fresh();
                    const ret = valueType.ret;
                    noteType(dst, ret);
                    if (isHeapT(ret)) varTypes.set(dst, ret);
                    if (structT(ret)) structTypeMap.set(dst, ret);
                    emit({ op: "call_indirect", dst, target: node.value!, args, returns_string: ret === "string", returns_float: ret === "float",
                           returns_heap: isHeapT(ret) && ret !== "string", retType: isHeapT(ret) && ret !== "string" ? ret : undefined });
                    return dst;
                }

                // convert int <-> float arguments to the parameter's type, as assignment does
                const paramTypes = functionParamTypes.get(node.value!);
                const args = node.children.map((arg, i) => {
                    const val = genExpr(arg);
                    const want = paramTypes?.[i];
                    if (want === "float" && !floatTemps.has(val)) {
                        const conv = fresh();
                        emit({ op: "itof", dst: conv, src: val });
                        floatTemps.add(conv);
                        return conv;
                    }
                    if (want === "int" && floatTemps.has(val)) {
                        const conv = fresh();
                        emit({ op: "ftoi", dst: conv, src: val });
                        return conv;
                    }
                    return val;
                });
                if (node.value === "floattostr") args[0] = asFloat(args[0]);   // the built-in reads a float
                const dst = fresh();
                const known = rt(node.value!);
                const returnsString = stringFunctions.has(node.value!) || known === "string" ||
                    ["inttostr", "inputstr", "chartostr", "str_upper", "str_lower", "floattostr"].includes(node.value!);
                const returnsFloat = floatFunctions.has(node.value!) || known === "float";
                if (returnsString) stringVars.add(dst);
                if (returnsFloat) floatTemps.add(dst);
                const returnsHeap = heapFunctions.has(node.value!);
                if (returnsHeap && known) varTypes.set(dst, known);

                emit({ op: "call", dst, fn: node.value!, args, returns_string: returnsString, returns_float: returnsFloat,
                       returns_heap: returnsHeap, retType: returnsHeap ? known : undefined });
                // an assembly/C function returning a u8 (say) only sets the low bits of rax
                if (externFns.has(node.value!) && isSmallInt(known)) {
                    const cut = fresh();
                    emit({ op: "trunc", dst: cut, src: dst, type: known! });
                    return cut;
                }
                return dst;
            }

            case "Assign": {
                const src = genExpr(node.children[0]);
                emit({ op: "mov", dst: node.value!, src: ownString(node.value!, src) });
                return node.value!;
            }

            case "CompoundAssign": {
                const name = node.children[0].value!;
                let rhs = genExpr(node.children[1]);
                // p += n moves n elements
                if (node.ptr && node.ptr.scale !== 1) { const scaled = fresh(); emit({ op: "mul", dst: scaled, a: rhs, b: String(node.ptr.scale) }); rhs = scaled; }
                const cur = fresh();
                const result = fresh();
                emit({ op: "mov", dst: cur, src: name });
                if (floatTemps.has(name)) floatTemps.add(cur);
                const isFloatOp = floatTemps.has(name) || floatTemps.has(rhs);
                const isStringOp = node.value === "+=" && stringVars.has(name);
                switch (node.value) {
                    case "+=": emit(isStringOp ? { op: "str_concat", dst: result, a: cur, b: rhs }
                                    : isFloatOp ? { op: "fadd", dst: result, a: asFloat(cur), b: asFloat(rhs) }
                                    : { op: "add", dst: result, a: cur, b: rhs }); break;
                    case "-=": emit(isFloatOp ? { op: "fsub", dst: result, a: asFloat(cur), b: asFloat(rhs) } : { op: "sub", dst: result, a: cur, b: rhs }); break;
                    case "*=": emit(isFloatOp ? { op: "fmul", dst: result, a: asFloat(cur), b: asFloat(rhs) } : { op: "mul", dst: result, a: cur, b: rhs }); break;
                    case "/=": emit(isFloatOp ? { op: "fdiv", dst: result, a: asFloat(cur), b: asFloat(rhs) } : { op: "div", dst: result, a: cur, b: rhs, ...(node.unsigned ? { unsigned: true } : {}) }); break;
                    case "%=": emit({ op: "mod", dst: result, a: cur, b: rhs, ...(node.unsigned ? { unsigned: true } : {}) }); break;
                    case "&=": emit({ op: "and", dst: result, a: cur, b: rhs }); break;
                    case "|=": emit({ op: "or", dst: result, a: cur, b: rhs }); break;
                    case "^=": emit({ op: "xor", dst: result, a: cur, b: rhs }); break;
                    case "<<=": emit({ op: "shl", dst: result, a: cur, b: rhs }); break;
                    case ">>=": emit({ op: node.unsigned ? "shr" : "sar", dst: result, a: cur, b: rhs }); break;
                }
                if (isFloatOp) floatTemps.add(result);
                if (isStringOp) stringVars.add(result);
                // an int variable keeps an int: a float result is truncated, as in an assignment
                let stored = result;
                if (isFloatOp && !floatTemps.has(name)) {
                    stored = fresh();
                    emit({ op: "ftoi", dst: stored, src: result });
                }
                // a sized variable wraps to its size
                if (node.truncTo) { const cut = fresh(); emit({ op: "trunc", dst: cut, src: stored, type: node.truncTo }); stored = cut; }
                emit({ op: "mov", dst: name, src: stored });
                return name;
            }

            case "PostfixInc":
            case "PostfixDec": {
                const name = node.value!;
                const cur = fresh();
                let result = fresh();
                emit({ op: "mov", dst: cur, src: name });
                // a pointer moves one element; a sized variable wraps
                emit({ op: node.type === "PostfixInc" ? "add" : "sub", dst: result, a: cur, b: String(node.ptr?.scale ?? 1) });
                if (node.truncTo) { const cut = fresh(); emit({ op: "trunc", dst: cut, src: result, type: node.truncTo }); result = cut; }
                emit({ op: "mov", dst: name, src: result });
                return cur; // return old value (true postfix semantics)
            }

            case "Char": {
                const dst = fresh();
                const code = node.value!.charCodeAt(0);
                emit({ op: "const", dst, value: code });
                return dst;
            }

            case "Tuple": {
                const dst = fresh();
                const n = node.children.length;
                const allocInstr: IR = { op: "alloc", dst, size: n * 8, heapFields: [], type: typeOf(node) }
                emit(allocInstr);
                varTypes.set(dst, typeOf(node)!);
                const strIdx = new Set<number>();
                tupleStrings.set(dst, strIdx);
                node.children.forEach((el, i) => {
                    const val = genExpr(el);
                    if (isStringTemp(val)) {
                        (allocInstr as any).heapFields.push(i * 8);
                        strIdx.add(i);
                    }
                    emit({ op: "field_store", base: dst, offset: i * 8, src: ownField(val), fieldType: typeOf(el) });
                });
                return dst;
            }

            case "TupleAccess": {
                const obj = genExpr(node.children[0]);
                const dst = fresh();
                const idx = Number(node.value!);
                const key = node.children[0].type === "Identifier" ? node.children[0].value! : obj;
                const elemType = typeOf(node);
                const isString = elemType === "string" || (tupleStrings.get(key)?.has(idx) ?? false);
                if (isString) stringVars.add(dst);
                noteType(dst, elemType);
                if (elemType) varTypes.set(dst, elemType);
                if (structT(elemType)) structTypeMap.set(dst, elemType!);
                emit({ op: "field_load", dst, base: obj, offset: idx * 8, is_string: isString, is_float: elemType === "float" });
                return dst;
            }

            case "ArraySlice": {
                const base = fresh();
                emit({ op: "mov", dst: base, src: node.value! });
                return genSlice(base, typeOf({ type: "Identifier", value: node.value, children: [] }), node.children[0], node.children[1]);
            }

            case "SliceExpr":
                return genSlice(genExpr(node.children[0]), typeOf(node.children[0]), node.children[1], node.children[2]);

            case "IndexExpr": {
                const baseType = typeOf(node.children[0]);
                if (mapTypeParts(baseType)) return genMapGet(node.children[0], baseType!, node.children[1]);
                const base = genExpr(node.children[0]);
                const index = genExpr(node.children[1]);
                if (baseType === "string") {
                    const dst = fresh();
                    emit({ op: "lea", dst, base, offset: index });
                    emit({ op: "load", dst, addr: dst, type: "i8" });
                    return dst;
                }
                return loadElement(base, index, elemT(baseType));
            }

            case "LenExpr": {
                const baseType = typeOf(node.children[0]);
                const base = genExpr(node.children[0]);
                const dst = fresh();
                if (mapTypeParts(baseType)) { emit({ op: "map_len", dst, map: base }); return dst; }
                if (baseType === "string") emit({ op: "call", dst, fn: "len", args: [base] });
                else emit({ op: "array_len", dst, arr: base });
                return dst;
            }

            default:
                throw new Error(`Cannot gen expr for ${node.type}`);
        }
    }

    function genStmt(node: Node) {
        switch (node.type) {

            case "PtrStore": {
                const addr = ptrAddress(node);
                let val = genExpr(node.children[2]);
                if (floatTemps.has(val)) { const c = fresh(); emit({ op: "ftoi", dst: c, src: val }); val = c; }
                emit({ op: "mem_store", addr, src: val, size: sizeOfType(String(node.varType))! });
                break;
            }

            case "FieldAssign": {
                // the parser gives 'this.x = v' an Identifier "this" target; treat it as This
                const target = node.children[0]
                const obj: Node = target.type === "Identifier" && target.value === "this"
                    ? { type: "This", children: [] }
                    : target
                const objReg = genExpr(obj)
                const structName = getStructTypeOf(obj)
                const layout = getLayout(structName)
                const offset = layout.get(node.value!)
                if (offset === undefined) throw new Error(`Unknown field: ${node.value}`);
                const fieldType = String(lookupStruct(structName)?.fields.find(f => f.name === node.value)?.type ?? "")
                if (node.children[1].type === "None") {
                    // p.f = none: free what the field held, then leave it empty
                    const old = fresh();
                    emit({ op: "field_load", dst: old, base: objReg, offset });
                    emit({ op: "free", addr: old, type: fieldType });
                    emit({ op: "field_store", base: objReg, offset, src: "0" });
                    break
                }
                const val = storeValue(genExpr(node.children[1]), fieldType)

                emit({ op: "field_store", base: objReg, offset, src: ownField(val), fieldType })
                break
            }

            case "ArrayAssign": {
                const assignedType = typeOf({ type: "Identifier", value: node.value, children: [] });
                if (mapTypeParts(assignedType)) { genMapSet(node.value!, assignedType!, node.children[0], node.children[1]); break; }
                const elem = elemT(typeOf({ type: "Identifier", value: node.value, children: [] }));
                const index = genExpr(node.children[0])
                const val = storeValue(genExpr(node.children[1]), elem)
                emit({ op: "array_store", arr: node.value!, index, src: val, elemType: elem })
                break;
            }
            case "IndexAssign": {
                const containerType = typeOf(node.children[0]);
                if (mapTypeParts(containerType)) { genMapSet(genExpr(node.children[0]), containerType!, node.children[1], node.children[2]); break; }
                const elem = elemT(typeOf(node.children[0]));
                const base = genExpr(node.children[0]);
                const index = genExpr(node.children[1]);
                const val = storeValue(genExpr(node.children[2]), elem);
                emit({ op: "array_store", arr: base, index, src: val, elemType: elem });
                break;
            }
            case "ArrayAssign2D" as any: {
                const i = genExpr(node.children[0]);
                const j = genExpr(node.children[1]);
                const elem = elemT(elemT(typeOf({ type: "Identifier", value: node.value, children: [] })));
                const val = storeValue(genExpr(node.children[2]), elem);
                const row = fresh();
                emit({ op: "array_load", dst: row, arr: node.value!, index: i });
                emit({ op: "array_store", arr: row, index: j, src: val });
                break;
            }
            case "VarDecl": {
                const declType = node.varType ?? typeOf(node.children[0]);
                if (declType === "float[]" && node.children[0].type === "ArrayLiteral") node.children[0].varType = "float[]";
                const src = genExpr(node.children[0]);
                if (declType) varTypes.set(node.value!, declType);
                if (structT(declType)) structTypeMap.set(node.value!, declType!);
                if (node.varType === "string" || declType === "string" || stringVars.has(src) || isStringTemp(src)) {
                    stringVars.add(node.value!);
                }
                const srcIsFloat = floatTemps.has(src);
                const dstIsFloat = node.varType === "float";
                if (dstIsFloat && !srcIsFloat) {
                    // int → float widening
                    const conv = fresh();
                    emit({ op: "itof", dst: conv, src });
                    floatTemps.add(conv);
                    floatTemps.add(node.value!);
                    emit({ op: "mov", dst: node.value!, src: conv, decl: true });
                } else if (!dstIsFloat && srcIsFloat && node.varType === "int") {
                    // float → int truncation
                    const conv = fresh();
                    emit({ op: "ftoi", dst: conv, src });
                    emit({ op: "mov", dst: node.value!, src: conv, decl: true });
                } else {
                    if (dstIsFloat || srcIsFloat) floatTemps.add(node.value!);
                    if (tupleStrings.has(src)) tupleStrings.set(node.value!, tupleStrings.get(src)!)
                    emit({ op: "mov", dst: node.value!, src: ownString(node.value!, src), decl: true });
                }
                if (node.children[0].type === "StructInstantiate") {
                    structTypeMap.set(node.value!, node.children[0].value!)
                } else if (node.varType && /^[A-Z]/.test(node.varType)) {
                    structTypeMap.set(node.value!, node.varType)
                }
                break;
            }

            case "Return": {
                const declared = currentRetKey ? declaredRet.get(currentRetKey) : undefined;
                const retType = declared ?? typeOf(node.children[0]);
                let val = genExpr(node.children[0]);
                // a declared float/int return converts the other kind of number
                if (declared === "float" && !floatTemps.has(val)) val = asFloat(val);
                if (declared === "int" && floatTemps.has(val)) { const c = fresh(); emit({ op: "ftoi", dst: c, src: val }); val = c; }
                // a returned string is always one the caller owns: copy one that isn't new
                const isString = retType === "string" || (currentFunction !== undefined && stringFunctions.has(currentFunction) && isStringTemp(val));
                if (isString && !isFreshString(val)) {
                    const copy = fresh();
                    emit({ op: "str_dup", dst: copy, src: val });
                    stringVars.add(copy);
                    val = copy;
                }
                if (currentRetKey) {
                    const seen = foundRetTypes.get(currentRetKey);
                    const t = retType ?? "?";
                    foundRetTypes.set(currentRetKey, seen === undefined || seen === t ? t : "?");
                }
                emit({ op: "ret", value: val });
                break;
            }

            case "Block":
                node.children.forEach(genStmt);
                break;

            case "If": {
                const cond = genExpr(node.children[0]);
                const elseLabel = freshLabel("else");
                const endLabel = freshLabel("endif");

                emit({ op: "jz", cond, target: elseLabel });
                genStmt(node.children[1]);
                emit({ op: "jmp", target: endLabel });
                emit({ op: "label", name: elseLabel });
                if (node.children[2]) genStmt(node.children[2]);
                emit({ op: "label", name: endLabel });
                break;
            }

            case "While": {
                const startLabel = freshLabel("while_start");
                const endLabel = freshLabel("while_end");

                loopStack.push({ startLabel, endLabel });

                emit({ op: "label", name: startLabel });
                const cond = genExpr(node.children[0]);
                emit({ op: "jz", cond, target: endLabel });
                genStmt(node.children[1]);
                emit({ op: "jmp", target: startLabel });
                emit({ op: "label", name: endLabel });

                loopStack.pop();
                break;
            }

            case "For": {
                const startLabel  = freshLabel("for_start");
                const updateLabel = freshLabel("for_update");  // ← new
                const endLabel    = freshLabel("for_end");

                // init
                if (node.children[0].type !== "Block") genStmt(node.children[0]);

                emit({ op: "label", name: startLabel });

                // condition
                const cond = genExpr(node.children[1]);
                emit({ op: "jz", cond, target: endLabel });

                loopStack.push({ startLabel: updateLabel, endLabel });  // ← continue goes to update

                genStmt(node.children[3]); // body

                loopStack.pop();

                emit({ op: "label", name: updateLabel });  // ← update label here
                genStmt(node.children[2]); // update

                emit({ op: "jmp", target: startLabel });
                emit({ op: "label", name: endLabel });
                break;
            }

            case "Break": {
                const loop = loopStack[loopStack.length - 1];
                if (!loop) {
                    throw new Error("Break statement not within a loop");
                }
                emit({ op: "jmp", target: loop.endLabel });
                break;
            }

            case "Continue": {
                const loop = loopStack[loopStack.length - 1];
                if (!loop) {
                    throw new Error("Continue statement not within a loop");
                }
                emit({ op: "jmp", target: loop.startLabel });
                break;
            }

            case "AsmBlock": {
                emit({ op: "asm_verbatim", text: node.value! });
                break;
            }

            case "ForIn": {
                // for (k in m) goes over a new array of the map's keys (freed at the end of scope)
                const iterType = typeOf(node.children[0]);
                const iterMap = mapTypeParts(iterType);
                let arrReg: string;
                if (iterMap) {
                    arrReg = fresh();
                    emit({ op: "map_keys", dst: arrReg, map: genExpr(node.children[0]), type: `${iterMap.key}[]` });
                    varTypes.set(arrReg, `${iterMap.key}[]`);
                } else {
                    arrReg = genExpr(node.children[0]);
                }
                const arrSlot = `__forin_arr_${labelCount}`;
                emit({ op: "mov", dst: arrSlot, src: arrReg });
                const lenDst = fresh();
                emit({ op: "array_len", dst: lenDst, arr: arrSlot });
                const lenSlot = `__forin_len_${labelCount}`;
                emit({ op: "mov", dst: lenSlot, src: lenDst });
                const idx = `__forin_idx_${labelCount}`;
                emit({ op: "const", dst: idx, value: 0 });
                const startLabel = freshLabel("forin_start");
                const nextLabel = freshLabel("forin_next");
                const endLabel = freshLabel("forin_end");
                loopStack.push({ startLabel: nextLabel, endLabel });
                emit({ op: "label", name: startLabel });
                const cond = fresh();
                emit({ op: "lt", dst: cond, a: idx, b: lenSlot });
                emit({ op: "jz", cond, target: endLabel });
                const elemType = iterMap ? iterMap.key : elemT(typeOf(node.children[0]));
                const elemDst = loadElement(arrSlot, idx, elemType);
                if (elemType) varTypes.set(node.value!, elemType);
                noteType(node.value!, elemType);
                if (structT(elemType)) structTypeMap.set(node.value!, elemType!);
                emit({ op: "mov", dst: node.value!, src: elemDst });
                genStmt(node.children[1]);
                emit({ op: "label", name: nextLabel });
                const nextIdx = fresh();
                emit({ op: "add", dst: nextIdx, a: idx, b: "1" });
                emit({ op: "mov", dst: idx, src: nextIdx });
                emit({ op: "jmp", target: startLabel });
                emit({ op: "label", name: endLabel });
                loopStack.pop();
                break;
            }

            case "Match": {
                const subject = genExpr(node.children[0]);
                const subjSlot = `__match_subj_${labelCount}`;
                emit({ op: "mov", dst: subjSlot, src: subject });
                const endLabel = freshLabel("match_end");
                const arms = node.children.slice(1); // MatchArm nodes
                for (let i = 0; i < arms.length; i++) {
                    const arm = arms[i];
                    if (arm.value === "_") {
                        genStmt(arm.children[0]);
                        emit({ op: "jmp", target: endLabel });
                    } else {
                        const nextLabel = freshLabel("match_next");
                        const patDst = genExpr(arm.children[0]);
                        const cmpDst = fresh();
                        emit({ op: "eq", dst: cmpDst, a: subjSlot, b: patDst });
                        emit({ op: "jz", cond: cmpDst, target: nextLabel });
                        genStmt(arm.children[1]);
                        emit({ op: "jmp", target: endLabel });
                        emit({ op: "label", name: nextLabel });
                    }
                }
                emit({ op: "label", name: endLabel });
                break;
            }

            default:
                genExpr(node);
        }
    }

    function genFunction(node: Node) {
        const params = node.children
            .filter(c => c.type === "Identifier")
            .map(c => c.value!);
        const body = node.children.find(c => c.type === "Block")!;

        currentFunction = node.value!;
        currentRetKey = node.value!;
        // an interrupt fn: the CPU jumps to a stub under its name, which calls the body (__isr_<name>)
        const fnName = node.interrupt ? `__isr_${node.value}` : node.value!;
        emit({ op: "enter", name: fnName, params });
        for (const v of [...varTypes.keys()]) { if (!globalNames.has(v)) varTypes.delete(v); }
        for (const v of [...tupleStrings.keys()]) { if (!/^t\d+$/.test(v) && !globalNames.has(v)) tupleStrings.delete(v); }

        // forget the previous function's locals, but keep what is known about globals
        for (const v of [...floatTemps]) { if (!/^t\d+$/.test(v) && !globalNames.has(v)) floatTemps.delete(v); }
        for (const v of [...stringVars]) { if (!/^t\d+$/.test(v) && !globalNames.has(v)) stringVars.delete(v); }
        for (const v of [...structTypeMap.keys()]) { if (!globalNames.has(v)) structTypeMap.delete(v); }


        params.forEach((p, i) => {
            const paramNode = node.children[i];
            const isFloat = paramNode.varType === "float";
            emit({ op: "arg", dst: p, index: i, isFloat });
            if (paramNode.varType) varTypes.set(p, paramNode.varType);
            if (paramNode.varType === "string") {
                stringVars.add(p);
            }
            if (isFloat) {
                floatTemps.add(p);
            }
            if (structT(paramNode.varType)) {
                structTypeMap.set(p, paramNode.varType!)
            }
        });
        for (const p of params) {
            if (stringVars.has(p) && isAssigned(body, p)) {
                const copy = fresh();
                emit({ op: "str_dup", dst: copy, src: p });
                emit({ op: "mov", dst: p, src: copy });
            }
        }

        genStmt(body);
        emit({ op: "leave" });
        // after the body, so it never sits before the first function (where global set-up code goes)
        if (node.interrupt) emit({ op: "isr_stub", name: node.value!, fn: fnName, errorCode: params.length === 2 });
    }

    function genStructDef(node: Node) {
        currentStructName = node.value!;
        const def = lookupStruct(node.value!)!;

        const ownMethods = [
            ...node.children.filter(c => c.type === "StructMethod"),
            ...node.children
                .filter(c => c.type === "StructOverrides")
                .flatMap(o => o.children)
        ];

        ownMethods.forEach(method => {
            const mangledName = `${node.value!}.${method.value!}`;
            const paramNodes = method.children.filter(c => c.type === "Identifier");
            const params = paramNodes.map(c => c.value!);
            const body = method.children.find(c => c.type === "Block")!;

            currentFunction = mangledName;
            currentRetKey = "." + method.value!;
            for (const v of [...varTypes.keys()]) { if (!globalNames.has(v)) varTypes.delete(v); }
        for (const v of [...tupleStrings.keys()]) { if (!/^t\d+$/.test(v) && !globalNames.has(v)) tupleStrings.delete(v); }
            for (const v of [...floatTemps]) { if (!/^t\d+$/.test(v) && !globalNames.has(v)) floatTemps.delete(v); }
            for (const v of [...stringVars]) { if (!/^t\d+$/.test(v) && !globalNames.has(v)) stringVars.delete(v); }
            for (const v of [...structTypeMap.keys()]) { if (!globalNames.has(v)) structTypeMap.delete(v); }

            emit({ op: "enter", name: mangledName, params: ["__this", ...params] });
            emit({ op: "arg", dst: "__this", index: 0 });
            paramNodes.forEach((pn, i) => {
                const isFloat = pn.varType === "float";
                emit({ op: "arg", dst: pn.value!, index: i + 1, isFloat });
                if (pn.varType) varTypes.set(pn.value!, pn.varType);
                noteType(pn.value!, pn.varType);
                if (structT(pn.varType)) structTypeMap.set(pn.value!, pn.varType!);
            });
            for (const p of params) {
                if (stringVars.has(p) && isAssigned(body, p)) {
                    const copy = fresh();
                    emit({ op: "str_dup", dst: copy, src: p });
                    emit({ op: "mov", dst: p, src: copy });
                }
            }
            genStmt(body);
            emit({ op: "leave" });
        });
        currentFunction = undefined;
        currentRetKey = undefined;

        if (hasVtable(node.value!)) {
            emit({ op: "comment", text: `vtable for ${node.value}` });
            emit({ op: "vtable_entry", structName: node.value!, methodName: "__free", implName: `__freeobj_${node.value!}` });
            def.methods.forEach((_, methodName) => {
                const implName = `${implOwner(node.value!, methodName)}.${methodName}`;
                emit({ op: "vtable_entry", structName: node.value!, methodName, implName });
            });
        }

        currentStructName = undefined;
    }

    function genProgram(node: Node) {
        for (const child of node.children) if (child.type === "ExternFn") emit({ op: "extern_decl", name: child.value! });
        // global initialisers first: everything before the first function is the code that
        // sets up globals (Emitter.ts runs it at the start of main, insertFrees treats its names as globals)
        node.children.forEach(child => { if (child.type === "VarDecl") genStmt(child); });
        node.children.forEach(child => {
            const gen = () => {
                if (child.type === "Function") genFunction(child);
                else if (child.type === "StructDef") genStructDef(child)
            };
            if (final) gen();
            else try { gen(); } catch { /* learned on a later pass */ }
        });
    }


    for (const c of ast.children.filter(c => c.type === "VarDecl")) {
        globalNames.add(c.value!);
        const init = c.children[0];
        if (c.varType === "float" || (!c.varType && init.type === "Number" && init.varType === "float")) {
            globalFloatNames.add(c.value!);
        }
    }
    for (const fn of ast.children.filter(c => c.type === "Function" || c.type === "ExternFn")) {
        functionParamTypes.set(fn.value!, fn.children.filter(c => c.type === "Identifier").map(c => c.varType));
    }
    let known: number;
    do {
        known = stringFunctions.size;
        collectStringFunctions(ast);
    } while (stringFunctions.size !== known);
    do {
        known = floatFunctions.size;
        collectFloatFunctions(ast);
    } while (floatFunctions.size !== known);
    for (const f of findFreshFunctions(ast)) heapFunctions.add(f);
    for (const [name, t] of declaredRet) {
        if (name.startsWith(".")) continue;
        // the declared type wins over what was inferred from the returns
        if (t === "string") stringFunctions.add(name); else stringFunctions.delete(name);
        if (t === "float") floatFunctions.add(name); else floatFunctions.delete(name);
    }
    genProgram(ast);
    // heap fields of every struct, for the free routines the emitter generates
    for (const name of structNamesInProgram(ast)) {
        const def = lookupStruct(name);
        if (!def) continue;
        const layout = getLayout(name);
        const fields = def.fields
            .filter(f => isHeapT(String(f.type)))
            .map(f => ({ offset: layout.get(f.name)!, type: String(f.type) }));
        emit({ op: "type_layout", name, fields, dynamic: hasVtable(name) });
    }
    return { instructions, retTypes: foundRetTypes };
}

function structNamesInProgram(ast: Node): string[] {
    return ast.children.filter(c => c.type === "StructDef").map(c => c.value!);
}

// types held on the heap (strings, arrays, structs, tuples)
export function isHeapT(t: string | undefined): boolean {
    return !!t && t !== "int" && t !== "float" && t !== "bool" && t !== "char" && t !== "void" && t !== "unknown" && !t.startsWith("fn(") &&
        !isSizedInt(t) && !isPtrType(t);
}

export function printIR(instructions: IR[]): string {
    const lines: string[] = [];

    for (const instr of instructions) {
        switch (instr.op) {
            case "str_dup":
                lines.push(`  str_dup   ${instr.dst} = ${instr.src}`);
                break;
            case "str_concat":
                lines.push(`  str_concat ${instr.dst} = ${instr.a} + ${instr.b}`);
                break;
            case "str_cmp":
                lines.push(`  str_cmp   ${instr.dst} = ${instr.a} <=> ${instr.b}`);
                break;
            case "str_sub":
                lines.push(`  str_sub   ${instr.dst} = ${instr.src}[${instr.start}..${instr.end}]`);
                break;
            case "array_push":
                lines.push(`  array_push  ${instr.arr}.push(${instr.src})`);
                break;
            case "array_insert":
                lines.push(`  array_insert ${instr.arr}.insert(${instr.index}, ${instr.src})`);
                break;
            case "array_pop":
                lines.push(`  array_pop   ${instr.dst} = ${instr.arr}.pop()`);
                break;
            case "array_remove":
                lines.push(`  array_remove ${instr.dst} = ${instr.arr}.remove(${instr.index})`);
                break;
            case "func_addr":
                lines.push(`  func_addr ${instr.dst} = &${instr.fn}`);
                break;
            case "call_indirect":
                lines.push(`  call_indirect ${instr.dst} = (*${instr.target})(${instr.args.join(", ")})`);
                break;
            case "map_new":
                lines.push(`  map_new   ${instr.dst} = new ${instr.type}`);
                break;
            case "map_get":
                lines.push(`  map_get   ${instr.dst} = ${instr.map}[${instr.key}]`);
                break;
            case "map_set":
                lines.push(`  map_set   ${instr.map}[${instr.key}] = ${instr.src}`);
                break;
            case "map_has":
                lines.push(`  map_has   ${instr.dst} = ${instr.map}.has(${instr.key})`);
                break;
            case "map_remove":
                lines.push(`  map_remove ${instr.map}.remove(${instr.key})`);
                break;
            case "map_keys":
                lines.push(`  map_keys  ${instr.dst} = ${instr.map}.keys()`);
                break;
            case "map_len":
                lines.push(`  map_len   ${instr.dst} = ${instr.map}.len()`);
                break;
            case "check_set":
                lines.push(`  check_set ${instr.src}   ; "${instr.message}"`);
                break;
            case "type_layout":
                lines.push(`  ; layout ${instr.name}: ${instr.fields.map(f => `${f.type} @${f.offset}`).join(", ") || "no heap fields"}`);
                break;
            case "enter":
                lines.push(`\n[${instr.name}](${instr.params.join(", ")})`);
                break;
            case "leave":
                lines.push(`  leave\n`);
                break;
            case "arg":
                lines.push(`  arg       ${instr.dst} #${instr.index}`);
                break;
            case "const":
                lines.push(`  const     ${instr.dst} = ${instr.value}`);
                break;
            case "mov":
                lines.push(`  mov       ${instr.dst} = ${instr.src}`);
                break;
            case "ret":
                lines.push(`  ret       ${instr.value ?? ""}`);
                break;
            case "call":
                lines.push(`  call      ${instr.dst ? instr.dst + " = " : ""}${instr.fn}(${instr.args.join(", ")})`);
                break;
            case "label":
                lines.push(`\n.${instr.name}:`);
                break;
            case "jmp":
                lines.push(`  jmp       .${instr.target}`);
                break;
            case "jz":
                lines.push(`  jz        ${instr.cond} .${instr.target}`);
                break;
            case "jnz":
                lines.push(`  jnz       ${instr.cond} .${instr.target}`);
                break;
            case "add": case "sub": case "mul": case "div":
            case "mod": case "and": case "or":  case "xor":
            case "shl": case "shr": case "sar":
            case "eq":  case "neq":
            case "lt":  case "lte":
            case "gt":  case "gte":
                lines.push(`  ${instr.op.padEnd(9)} ${instr.dst} = ${instr.a} ${instr.op}${(instr as any).unsigned ? " unsigned" : ""} ${instr.b}`);
                break;
            case "bnot":
                lines.push(`  bnot      ${instr.dst} = ~${instr.src}`);
                break;
            case "trunc":
                lines.push(`  trunc     ${instr.dst} = ${instr.type}(${instr.src})`);
                break;
            case "mem_load":
                lines.push(`  mem_load  ${instr.dst} = ${instr.signed ? "i" : "u"}${instr.size * 8} [${instr.addr}]`);
                break;
            case "mem_store":
                lines.push(`  mem_store ${instr.size * 8}-bit [${instr.addr}] = ${instr.src}`);
                break;
            case "global_addr":
                lines.push(`  global_addr ${instr.dst} = &${instr.name}`);
                break;
            case "extern_decl":
                lines.push(`; extern ${instr.name}`);
                break;
            case "isr_stub":
                lines.push(`; interrupt stub ${instr.name} -> ${instr.fn}${instr.errorCode ? " (with error code)" : ""}`);
                break;
            case "neg": case "not": case "abs":
            case "itof": case "ftoi":
            case "typeof":
                lines.push(`  ${instr.op.padEnd(9)} ${instr.dst} = ${instr.op}(${instr.src})`);
                break;
            case "cast":
                lines.push(`  cast      ${instr.dst} = (${instr.type}) ${instr.src}`);
                break;
            case "load":
                lines.push(`  load      ${instr.dst} = *${instr.addr} [${instr.type}]`);
                break;
            case "store":
                lines.push(`  store     *${instr.addr} = ${instr.src} [${instr.type}]`);
                break;
            case "alloc":
                lines.push(`  alloc     ${instr.dst} = alloc(${instr.size})`);
                break;
            case "free":
                lines.push(`  free      ${instr.addr}${instr.type ? ` (${instr.type})` : ""}`);
                break;
            case "lea":
                lines.push(`  lea       ${instr.dst} = &${instr.base}[${instr.offset}]`);
                break;
            case "phi":
                const branches = instr.branches.map(b => `${b.src} <- .${b.label}`).join(", ");
                lines.push(`  phi       ${instr.dst} = φ(${branches})`);
                break;
            case "asm_verbatim":
                lines.push(`  ; [asm] ${instr.text.trim().split("\n")[0]}...`);
                break;
            case "srcmap":
                lines.push(`  ; ${instr.file}:${instr.line}:${instr.col}`);
                break;
            case "comment":
                lines.push(`  ; ${instr.text}`);
                break;
            case "nop":
                lines.push(`  nop`);
                break;
            case "string_const":
                lines.push(`  const     ${instr.dst} = "${instr.value}"`);
                break;
            case "array_new":
                lines.push(`  array_new  ${instr.dst} = new[${instr.size}]`);
                break;
            case "array_store":
                lines.push(`  array_store ${instr.arr}[${instr.index}] = ${instr.src}`);
                break;
            case "array_load":
                lines.push(`  array_load  ${instr.dst} = ${instr.arr}[${instr.index}]`);
                break;
            case "array_len":
                lines.push(`  array_len   ${instr.dst} = ${instr.arr}.len()`);
                break;

            case "struct_alloc":
                lines.push(`  struct_alloc ${instr.dst} = new ${instr.structName}[${instr.numFields}]`);
                break;
            case "field_store":
                lines.push(`  field_store  [${instr.base} + ${instr.offset}] = ${instr.src}`);
                break;
            case "field_load":
                lines.push(`  field_load   ${instr.dst} = [${instr.base} + ${instr.offset}]`);
                break;
            case "vtable_call":
                lines.push(`  vtable_call  ${instr.dst} = ${instr.base}->vtable[${instr.slot}](${instr.args.join(", ")})`);
                break;
            case "vtable_ptr":
                lines.push(`  vtable_ptr   ${instr.dst} = &__vtable_${instr.structName}`);
                break;
            case "vtable_entry":
                lines.push(`  ; vtable ${instr.structName}.${instr.methodName} -> ${instr.implName}`);
                break;
            case "fadd": case "fsub": case "fmul": case "fdiv":
            case "feq": case "fneq": case "flt": case "flte": case "fgt": case "fgte":
            case "str_eq": case "str_neq":
                lines.push(`  ${instr.op.padEnd(9)} ${instr.dst} = ${instr.a} ${instr.op} ${instr.b}`);
                break;
            case "fneg":
                lines.push(`  fneg      ${instr.dst} = -${instr.src}`);
                break;
            case "fconst":
                lines.push(`  fconst    ${instr.dst} = ${instr.value}`);
                break;
            case "array_free_2d":
                lines.push(`  array_free_2d ${instr.arr} (${instr.rows} rows)`);
                break;
            default:
                // every op should have a case above; show any that don't rather than hide them
                lines.push(`  ${JSON.stringify(instr)}`);
        }
    }
    return lines.join("\n");
}

module.exports = { IRGen, printIR, isHeapT };