import { lookup } from "node:dns/promises";
import { Node } from "./Parser";
import { lookupStruct } from "./Scope";

export type IR = 
    // Control flow
    | {op: "label", name: string}
    | {op: "jmp", target: string}
    | {op: "jz", cond: string, target: string}   // jump if zero
    | {op: "jnz", cond: string, target: string}  // jump if not zero
    | {op: "call", dst?: string, fn: string, args: string[], returns_string?: boolean, returns_float?: boolean}  // dst is optional for void functions
    // comparison
    | {op: "eq", dst: string, a: string, b: string}
    | {op: "neq", dst: string, a: string, b: string}
    | {op: "lt", dst: string, a: string, b: string}
    | {op: "lte", dst: string, a: string, b: string}
    | {op: "gt", dst: string, a: string, b: string}
    | {op: "gte", dst: string, a: string, b: string}
    | {op: "str_eq", dst: string, a: string, b: string}
    | {op: "str_neq", dst: string, a: string, b: string}
    // arithmetic
    | {op: "add", dst: string, a: string, b: string}
    | {op: "sub", dst: string, a: string, b: string}
    | {op: "mul", dst: string, a: string, b: string}
    | {op: "div", dst: string, a: string, b: string}
    // bitwise and logical
    | {op: "and", dst: string, a: string, b: string}
    | {op: "or", dst: string, a: string, b: string}
    | {op: "xor", dst: string, a: string, b: string}
    | {op: "not", dst: string, src: string}
    | {op: "shl", dst: string, a: string, b: string}  // shift left
    | {op: "shr", dst: string, a: string, b: string}  // shift right
    // Memory/Heap
    | {op: "load", dst: string, addr: string, type: string}          // *addr → dst
    | {op: "store", addr: string, src: string, type: string}         // src → *addr
    | {op: "alloc", dst: string, size: string | number}         // heap alloc
    | {op: "free", addr: string}
    | {op: "lea", dst: string, base: string, offset: string}  // address arithmetic
    | {op: "mov", dst: string, src: string}              // register copy
    | {op: "const", dst: string, value: number | string}  // load constant
    | {op: "ret", value?: string}                         // return from function
    | {op: "str_concat", dst: string, a: string, b: string}  // dst = a + b (for strings)
    // Type/casting
    | {op: "cast", dst: string, src: string, type: string}
    | {op: "typeof", dst: string, src: string}
    | {op: "string_const", dst: string, value: string}  // for string literals
    // Functions / stack frames
    | {op: "enter", name: string, params: string[]}   // function prologue
    | {op: "leave"}                                    // function epilogue  
    | {op: "arg", dst: string, index: number, isFloat?: boolean}  // read incoming arg by position
    // Float ops
    | {op: "itof", dst: string, src: string}           // int → float
    | {op: "ftoi", dst: string, src: string}           // float → int
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
    | {op: "fconst", dst: string, value: number}       // float constant
    // Debugging / metadata (invaluable for error messages)
    | {op: "srcmap", file: string, line: number, col: number}
    | {op: "comment", text: string}
    // Misc
    | {op: "nop"}
    | {op: "asm_verbatim", text: string}  // raw inline asm passthrough
    | {op: "phi", dst: string, branches: {label: string, src: string}[]}  // SSA φ-node
    | {op: "neg", dst: string, src: string}   // unary negation
    | {op: "abs", dst: string, src: string}
    | {op: "mod", dst: string, a: string, b: string}
    // arrays
    | {op: "array_new", dst: string, size: string | number}
    | {op: "array_store", arr: string, index: string, src: string}
    | {op: "array_load", dst: string, arr: string, index: string}
    | {op: "array_len", dst: string, arr: string}
    | {op: "array_free_2d", arr: string, rows: string | number}  // free each row then the outer array
    // structs
    | {op: "struct_alloc", dst: string, structName: string, numFields: number}  // malloc struct
    | {op: "field_store", base: string, offset: number, src: string}            // base[offset] = src
    | {op: "field_load", dst: string, base: string, offset: number, is_string?: boolean}             // dst = base[offset]
    | {op: "vtable_call", dst: string, base: string, slot: number, args: string[]} // virtual dispatch
    | {op: "vtable_ptr", dst: string, structName: string}  // load address of vtable
    | {op: "vtable_entry", structName: string, methodName: string, implName: string}

export function IRGen(ast: Node): IR[] {
    const instructions: IR[] = [];
    let tempCount = 0;
    let labelCount = 0;
    const stringVars = new Set<string>();  // Map from string literal to variable name
    const floatTemps = new Set<string>(); // track float-typed temporaries
    const loopStack: { startLabel: string, endLabel: string }[] = [];
    const stringFunctions = new Set<string>(); // Track functions that return strings
    const floatFunctions = new Set<string>(); // Track functions that return floats
    const StructLayouts = new Map<string, Map<String, number>>()
    const vtableSlots = new Map<string, Map<string, number>>()
    const structTypeMap = new Map<string, string>()
    let currentStructName: string| undefined

    const fresh = () => `t${tempCount++}`;
    const freshLabel = (hint = "L") => `${hint}_${labelCount++}`;

    function emit(ir: IR) {
        instructions.push(ir);
    }

    function getLayout(structName: string): Map<String, number> {
        if (StructLayouts.has(structName)) return StructLayouts.get(structName)!
        const layout = new Map<String, number>()
        const def = lookupStruct(structName)
        if (!def) throw new Error(`Unknown struct: ${structName}`)
        let offset = def.methods.size > 0 ? 8:0
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
                let i = 0
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
        if (node.type === "Identifier" ) {
            const t = structTypeMap.get(node.value!)
            if (!t) throw new Error(`'${node.value}' is not a struct instance`);
            return t
        }
        throw new Error(`Cannot get struct type of ${node.type}`);
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
            // don't follow movs from scanner/input slots
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
        const floatVarNames = new Set<string>(
            node.children
                .filter(c => c.type === "Identifier" && c.varType === "float")
                .map(c => c.value!)
        );
        // Collect float-typed local variables from VarDecl nodes in the body
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

    // Returns the register holding the result
    function genExpr(node: Node): string {
        switch (node.type) {

            case "StructInstantiate": {
                const def = lookupStruct(node.value!);
                const dst = fresh()
                if (!def) throw new Error(`Unknown struct: ${node.value}`);
                const layout = getLayout(node.value!);

                const hasVtable = def.methods.size > 0
                emit({ op: "struct_alloc", dst, structName: node.value!, numFields: def.fields.length + (hasVtable ? 1:0)});

                // only emit vtable pointer if struct has methods
                if (def.methods.size > 0) {
                    const vtablePtr = fresh();
                    emit({ op: "vtable_ptr", dst: vtablePtr, structName: node.value! });
                    emit({ op: "field_store", base: dst, offset: 0, src: vtablePtr });
                }

                // store each field
                node.children.forEach(fieldNode => {
                    const offset = layout.get(fieldNode.value!);
                    if (offset === undefined) throw new Error(`Unknown field: ${fieldNode.value}`);
                    const val = genExpr(fieldNode.children[0]);
                    emit({ op: "field_store", base: dst, offset, src: val });
                });

                return dst;
            }

            case "This": {
                const dst = fresh()
                emit({ op: "mov", dst, src: "__this" })
                return dst
            }

            case "FieldAccess": {
                const obj = node.children[0]
                const objReg = genExpr(obj)
                const dst = fresh()

                const structName = getStructTypeOf(obj)
                const layout = getLayout(structName)
                const offset = layout.get(node.value!)
                if (offset === undefined) throw new Error(`Unknown field: ${node.value}`);

                const def = lookupStruct(structName)
                const fieldDef = def?.fields.find(f => f.name === node.value)
                const isString = fieldDef?.type === "string"
                if (isString) stringVars.add(dst)

                emit({ op: "field_load", dst, base: objReg, offset, is_string: isString });
                return dst;

            }

            case "ArrayNew": {
                if (node.varType === "int[][]" as any) {
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
                    emit({ op: "array_new", dst, size: rowsSlot });
                    // loop: for each row, allocate a column array
                    const loopIdx = fresh();
                    emit({ op: "const", dst: loopIdx, value: 0 });
                    const startLabel = freshLabel("arr2d_init");
                    const endLabel = freshLabel("arr2d_end");
                    emit({ op: "label", name: startLabel });
                    const cond = fresh();
                    emit({ op: "lt", dst: cond, a: loopIdx, b: rowsSlot });
                    emit({ op: "jz", cond, target: endLabel });
                    const row = fresh();
                    emit({ op: "array_new", dst: row, size: colsSlot });
                    emit({ op: "array_store", arr: dst, index: loopIdx, src: row });
                    const next = fresh();
                    emit({ op: "add", dst: next, a: loopIdx, b: "1" });
                    emit({ op: "mov", dst: loopIdx, src: next });
                    emit({ op: "jmp", target: startLabel });
                    emit({ op: "label", name: endLabel });
                    return dst;
                }
                const size = genExpr(node.children[0]);
                const dst = fresh();
                emit({ op: "array_new", dst, size });
                return dst;
            }

            case "ArrayLiteral": {
                const dst = fresh();
                const size = node.children.length;
                emit({ op: "array_new", dst, size });
                node.children.forEach((el, i) => {
                    const val = genExpr(el);
                    emit({ op: "array_store", arr: dst, index: String(i), src: val });
                });
                return dst;
            }

            case "ArrayAccess": {
                const index = genExpr(node.children[0])
                const dst = fresh()
                if(stringVars.has(node.value!)) {
                    const base = fresh()
                    emit({ op: "mov", dst: base, src: node.value!})
                    emit({ op: "lea", dst, base, offset: index })
                    emit({ op: "load", dst, addr: dst, type: "i8" })
                } else {
                    emit({ op: "array_load", dst, arr: node.value!, index });
                }
                return dst
            }

            case "ArrayAccess2D" as any: {
                const i = genExpr(node.children[0]);
                const j = genExpr(node.children[1]);
                const row = fresh();
                const dst = fresh();
                emit({ op: "array_load", dst: row, arr: node.value!, index: i });
                emit({ op: "array_load", dst, arr: row, index: j });
                return dst;
            }

            case "ArrayLen": {
                const dst = fresh();
                emit({ op: "array_len", dst, arr: node.value! });
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
                }
                return dst;
            }
            case "Number": {
                const dst = fresh();
                if (node.varType === "float") {
                    emit({ op: "fconst", dst, value: Number(node.value) });
                    floatTemps.add(dst);
                } else {
                    emit({ op: "const", dst, value: Number(node.value) });
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
                if (floatTemps.has(node.value!)) floatTemps.add(dst);
                emit({ op: "mov", dst, src: node.value! });
                return dst;
            }

            case "Binary": {
                // short-circuit && / ||
                // Uses alloc/store/load to create a stack slot both paths write to,
                // so copy propagation cannot eliminate the writes.
                if (node.value === "&&" || node.value === "||") {
                    const isAnd = node.value === "&&";
                    const labelShort = freshLabel("sc");
                    const labelEnd = freshLabel("sc");
                    const slot = fresh();   // a stack-allocated cell
                    emit({ op: "alloc", dst: slot, size: 8 });
                    const lhsVal = genExpr(node.children[0]);
                    if (isAnd) {
                        emit({ op: "jz", cond: lhsVal, target: labelShort });
                    } else {
                        emit({ op: "jnz", cond: lhsVal, target: labelShort });
                    }
                    // lhs passed: evaluate rhs, store it
                    const rhsVal = genExpr(node.children[1]);
                    emit({ op: "store", addr: slot, src: rhsVal, type: "i64" });
                    emit({ op: "jmp", target: labelEnd });
                    emit({ op: "label", name: labelShort });
                    // short-circuit path: store constant
                    const shortConst = fresh();
                    emit({ op: "const", dst: shortConst, value: isAnd ? 0 : 1 });
                    emit({ op: "store", addr: slot, src: shortConst, type: "i64" });
                    emit({ op: "label", name: labelEnd });
                    const dst = fresh();
                    emit({ op: "load", dst, addr: slot, type: "i64" });
                    return dst;
                }

                if (node.value === "==" || node.value === "!=") {
                    const leftIsString = node.children[0].type === "String" ||
                        node.children[0].varType === "string" ||
                        (node.children[0].type === "Identifier" && stringVars.has(node.children[0].value!));
                    const rightIsString = node.children[1].type === "String" ||
                        node.children[1].varType === "string" ||
                        (node.children[1].type === "Identifier" && stringVars.has(node.children[1].value!));
                    if (leftIsString || rightIsString) {
                        const a = genExpr(node.children[0]);
                        const b = genExpr(node.children[1]);
                        const dst = fresh();
                        emit({op: node.value === "==" ? "str_eq" : "str_neq", dst, a, b});
                        return dst;
                    }
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
                        emit({ op: "fadd", dst, a, b } as IR);
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
                    emit({ op: fop, dst, a, b } as IR);
                    // arithmetic ops produce float; comparison ops produce int (0/1)
                    if (["fadd","fsub","fmul","fdiv","fneg"].includes(fop as string)) floatTemps.add(dst);
                    return dst;
                }

                const opMap: Record<string, IR["op"]> = {
                    "+": "add", "-": "sub", "*": "mul", "/": "div", "%": "mod",
                    "==": "eq", "!=": "neq",
                    "<": "lt",  "<=": "lte",
                    ">": "gt",  ">=": "gte",
                };
                const op = opMap[node.value!];
                if (!op) throw new Error(`Unknown binary op: ${node.value}`);
                emit({ op, dst, a, b } as IR);
                return dst;
            }

            case "Call": {

                if (node.value!.includes(".")) {
                    const [objName, methodName] = node.value!.split(".")
                    const args = node.children.map(genExpr)
                    const dst = fresh()

                    if (objName === "this") {
                        const slot = getVtableSlot(currentStructName!, methodName)
                        emit({ op: "vtable_call", dst, base: "__this", slot, args: ["__this", ...args]})
                    } else {
                        const structName = structTypeMap.get(objName)
                        if (!structName) throw new Error(`'${objName}' is not a struct`);
                        const slot = getVtableSlot(structName, methodName)
                        const objReg = fresh()

                        emit({ op: "vtable_call", dst, base: objName, slot, args: [objName, ...args] });
                    }
                    return dst
                }

                const args = node.children.map(genExpr);
                const dst = fresh();
                const returnsString = stringFunctions.has(node.value!) || node.value === "inttostr" || node.value === "inputstr";
                const returnsFloat = floatFunctions.has(node.value!);
                if (returnsString) stringVars.add(dst);
                if (returnsFloat) floatTemps.add(dst);

                emit({ op: "call", dst, fn: node.value!, args, returns_string: returnsString, returns_float: returnsFloat });
                return dst;
            }

            case "Assign": {
                const src = genExpr(node.children[0]);
                emit({ op: "mov", dst: node.value!, src });
                return node.value!;
            }

            case "CompoundAssign": {
                // children[0] is an Identifier node, children[1] is the rhs
                const name = node.children[0].value!;
                const rhs = genExpr(node.children[1]);
                const cur = fresh();
                const result = fresh();
                emit({ op: "mov", dst: cur, src: name });
                const isFloatOp = floatTemps.has(name) || floatTemps.has(rhs);
                switch (node.value) {
                    case "+=": emit(isFloatOp ? { op: "fadd", dst: result, a: cur, b: rhs } : { op: "add", dst: result, a: cur, b: rhs }); break;
                    case "-=": emit(isFloatOp ? { op: "fsub", dst: result, a: cur, b: rhs } : { op: "sub", dst: result, a: cur, b: rhs }); break;
                    case "*=": emit(isFloatOp ? { op: "fmul", dst: result, a: cur, b: rhs } : { op: "mul", dst: result, a: cur, b: rhs }); break;
                    case "/=": emit(isFloatOp ? { op: "fdiv", dst: result, a: cur, b: rhs } : { op: "div", dst: result, a: cur, b: rhs }); break;
                    case "%=": emit({ op: "mod", dst: result, a: cur, b: rhs }); break;
                }
                if (isFloatOp) floatTemps.add(result);
                emit({ op: "mov", dst: name, src: result });
                return name;
            }

            case "PostfixInc": {
                const name = node.value!;
                const cur = fresh();
                const result = fresh();
                emit({ op: "mov", dst: cur, src: name });
                emit({ op: "add", dst: result, a: cur, b: "1" });
                emit({ op: "mov", dst: name, src: result });
                return cur; // return old value (true postfix semantics)
            }

            case "PostfixDec": {
                const name = node.value!;
                const cur = fresh();
                const result = fresh();
                emit({ op: "mov", dst: cur, src: name });
                emit({ op: "sub", dst: result, a: cur, b: "1" });
                emit({ op: "mov", dst: name, src: result });
                return cur;
            }

            case "Char": {
                const dst = fresh();
                const code = node.value!.charCodeAt(0);
                emit({ op: "const", dst, value: code });
                return dst;
            }

            case "Tuple": {
                // Allocate a heap block: numFields * 8 bytes, store each element
                const dst = fresh();
                const n = node.children.length;
                emit({ op: "alloc", dst, size: n * 8 });
                node.children.forEach((el, i) => {
                    const val = genExpr(el);
                    emit({ op: "field_store", base: dst, offset: i * 8, src: val });
                });
                return dst;
            }

            case "TupleAccess": {
                const obj = genExpr(node.children[0]);
                const dst = fresh();
                const idx = Number(node.value!);
                emit({ op: "field_load", dst, base: obj, offset: idx * 8 });
                return dst;
            }

            case "ArraySlice": {
                // arr[start..end] — allocate new array of (end-start) elements, copy
                const start = genExpr(node.children[0]);
                const end = genExpr(node.children[1]);
                const len = fresh();
                const dst = fresh();
                emit({ op: "sub", dst: len, a: end, b: start });
                emit({ op: "array_new", dst, size: len });
                // loop: for i = 0; i < len; i++
                const i = fresh();
                const startLabel = freshLabel("slice_loop");
                const endLabel = freshLabel("slice_end");
                emit({ op: "const", dst: i, value: 0 });
                emit({ op: "label", name: startLabel });
                const cond = fresh();
                emit({ op: "lt", dst: cond, a: i, b: len });
                emit({ op: "jz", cond, target: endLabel });
                const srcIdx = fresh();
                emit({ op: "add", dst: srcIdx, a: i, b: start });
                const elem = fresh();
                emit({ op: "array_load", dst: elem, arr: node.value!, index: srcIdx });
                emit({ op: "array_store", arr: dst, index: i, src: elem });
                const next = fresh();
                emit({ op: "add", dst: next, a: i, b: "1" });
                emit({ op: "mov", dst: i, src: next });
                emit({ op: "jmp", target: startLabel });
                emit({ op: "label", name: endLabel });
                return dst;
            }

            default:
                throw new Error(`Cannot gen expr for ${node.type}`);
        }
    }

    function genStmt(node: Node) {
        switch (node.type) {

            case "FieldAssign": {
                const obj = node.children[0]
                const objReg = genExpr(obj)
                const val = genExpr(node.children[1])

                const structName = getStructTypeOf(obj)
                const layout = getLayout(structName)
                const offset = layout.get(node.value!)
                if (offset === undefined) throw new Error(`Unknown field: ${node.value}`);

                emit({ op: "field_store", base: objReg, offset, src: val})
                break
            }

            case "ArrayAssign": {
                const index = genExpr(node.children[0])
                const val = genExpr(node.children[1])
                emit({ op: "array_store", arr: node.value!, index, src: val })
                break;
            }
            case "ArrayAssign2D" as any: {
                const i = genExpr(node.children[0]);
                const j = genExpr(node.children[1]);
                const val = genExpr(node.children[2]);
                const row = fresh();
                emit({ op: "array_load", dst: row, arr: node.value!, index: i });
                emit({ op: "array_store", arr: row, index: j, src: val });
                break;
            }
            case "VarDecl": {
                const src = genExpr(node.children[0]);
                if (node.varType === "string" || stringVars.has(src) || isStringTemp(src)) {
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
                    emit({ op: "mov", dst: node.value!, src: conv });
                } else if (!dstIsFloat && srcIsFloat && node.varType === "int") {
                    // float → int truncation
                    const conv = fresh();
                    emit({ op: "ftoi", dst: conv, src });
                    emit({ op: "mov", dst: node.value!, src: conv });
                } else {
                    if (dstIsFloat || srcIsFloat) floatTemps.add(node.value!);
                    emit({ op: "mov", dst: node.value!, src });
                }
                if (node.children[0].type === "StructInstantiate") {
                    structTypeMap.set(node.value!, node.children[0].value!)
                }
                break;
            }

            case "Return": {
                const val = genExpr(node.children[0]);
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
                // for varName in arrName { body }
                // node.value = varName, node.children[0] = array expr, node.children[1] = body
                const arrReg = genExpr(node.children[0]);
                const arrSlot = `__forin_arr_${labelCount}`;
                emit({ op: "mov", dst: arrSlot, src: arrReg });
                const lenDst = fresh();
                emit({ op: "array_len", dst: lenDst, arr: arrSlot });
                const lenSlot = `__forin_len_${labelCount}`;
                emit({ op: "mov", dst: lenSlot, src: lenDst });
                const idx = `__forin_idx_${labelCount}`;
                emit({ op: "const", dst: idx, value: 0 });
                const startLabel = freshLabel("forin_start");
                const endLabel = freshLabel("forin_end");
                loopStack.push({ startLabel, endLabel });
                emit({ op: "label", name: startLabel });
                const cond = fresh();
                emit({ op: "lt", dst: cond, a: idx, b: lenSlot });
                emit({ op: "jz", cond, target: endLabel });
                // bind loop variable
                const elemDst = fresh();
                emit({ op: "array_load", dst: elemDst, arr: arrSlot, index: idx });
                emit({ op: "mov", dst: node.value!, src: elemDst });
                genStmt(node.children[1]);
                // increment
                const nextIdx = fresh();
                emit({ op: "add", dst: nextIdx, a: idx, b: "1" });
                emit({ op: "mov", dst: idx, src: nextIdx });
                emit({ op: "jmp", target: startLabel });
                emit({ op: "label", name: endLabel });
                loopStack.pop();
                break;
            }

            case "Match": {
                // node.children[0] = subject expr, rest = MatchArm nodes
                // MatchArm wildcard: value="_", children[0]=body
                // MatchArm literal:  value=undefined, children[0]=pattern expr, children[1]=body
                const subject = genExpr(node.children[0]);
                const subjSlot = `__match_subj_${labelCount}`;
                emit({ op: "mov", dst: subjSlot, src: subject });
                const endLabel = freshLabel("match_end");
                const arms = node.children.slice(1); // MatchArm nodes
                for (let i = 0; i < arms.length; i++) {
                    const arm = arms[i];
                    if (arm.value === "_") {
                        // wildcard — always taken
                        genStmt(arm.children[0]);
                        emit({ op: "jmp", target: endLabel });
                    } else {
                        // pattern is children[0], body is children[1]
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

            // Bare expression statement (call with no assignment, etc.)
            default:
                genExpr(node);
        }
    }

    function genFunction(node: Node) {
        const params = node.children
            .filter(c => c.type === "Identifier")
            .map(c => c.value!);
        const body = node.children.find(c => c.type === "Block")!;

        emit({ op: "enter", name: node.value!, params });

        // Clear named variable entries (params, locals) from prior functions.
        // Temp names (t0, t1, ...) are globally unique so they stay.
        for (const v of [...floatTemps]) { if (!/^t\d+$/.test(v)) floatTemps.delete(v); }
        for (const v of [...stringVars]) { if (!/^t\d+$/.test(v)) stringVars.delete(v); }
        structTypeMap.clear();

        // Materialise each param into a named register
        params.forEach((p, i) => {
            const paramNode = node.children[i];
            const isFloat = paramNode.varType === "float";
            emit({ op: "arg", dst: p, index: i, isFloat });
            if (paramNode.varType === "string") {
                stringVars.add(p);
            }
            if (isFloat) {
                floatTemps.add(p);
            }
            if (paramNode.varType && /^[A-Z]/.test(paramNode.varType)) {
                structTypeMap.set(p, paramNode.varType)
            }
        });

        genStmt(body);
        emit({ op: "leave" });
    }

    function genStructDef(node: Node) {
        currentStructName = node.value!;
        const def = lookupStruct(node.value!)!;

        // collect own methods
        const ownMethods = [
            ...node.children.filter(c => c.type === "StructMethod"),
            ...node.children
                .filter(c => c.type === "StructOverrides")
                .flatMap(o => o.children)
        ];

        // emit method bodies
        ownMethods.forEach(method => {
            const mangledName = `${node.value!}.${method.value!}`;
            const params = method.children.filter(c => c.type === "Identifier").map(c => c.value!);
            const body = method.children.find(c => c.type === "Block")!;

            emit({ op: "enter", name: mangledName, params: ["__this", ...params] });
            emit({ op: "arg", dst: "__this", index: 0 });
            params.forEach((p, i) => emit({ op: "arg", dst: p, index: i + 1 }));
            genStmt(body);
            emit({ op: "leave" });
        });

        // emit vtable if struct has any methods (including inherited)
        if (def.methods.size > 0) {
            const ownMethodNames = new Set(ownMethods.map(m => m.value!));
            emit({ op: "comment", text: `vtable for ${node.value}` });

            // for each method in vtable order, point to own impl or inherited
            def.methods.forEach((_, methodName) => {
                const hasOwn = ownMethodNames.has(methodName);
                const implName = hasOwn ? `${node.value!}.${methodName}` : `${node.parent}.${methodName}`;
                emit({ op: "vtable_entry", structName: node.value!, methodName, implName });
            });
        }

        currentStructName = undefined;
    }

    function genProgram(node: Node) {
        node.children.forEach(child => {
            if (child.type === "Function") genFunction(child);
            else if (child.type === "VarDecl") genStmt(child);
            else if (child.type === "StructDef") genStructDef(child)
        });
    }

    collectStringFunctions(ast);
    collectFloatFunctions(ast);
    genProgram(ast);
    return instructions;
}

export function printIR(instructions: IR[]): string {
    const lines: string[] = [];

    for (const instr of instructions) {
        switch (instr.op) {
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
            case "shl": case "shr":
            case "eq":  case "neq":
            case "lt":  case "lte":
            case "gt":  case "gte":
                lines.push(`  ${instr.op.padEnd(9)} ${instr.dst} = ${instr.a} ${instr.op} ${instr.b}`);
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
                lines.push(`  free      ${instr.addr}`);
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
        }
    }
    return lines.join("\n");
}

module.exports = { IRGen, printIR };