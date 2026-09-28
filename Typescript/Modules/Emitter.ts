import { IR } from "./IR";
import { tupleTypeParts } from "./Scope";

// kernel: the program is a kernel (--kernel). Globals are set up at the start of kernel_main, and
// a runtime error calls the kernel runtime's lrt_kernel_fail (which calls kernel_panic) instead of
// writing to stderr with a Linux system call
export function emitNASM(instructions: IR[], options: { kernel?: boolean } = {}): string {
    const nasmLines: string[] = [
        "section .data",
        "fmt db '%ld', 10, 0",
        "fmt_in db '%ld', 0",
        "fmt_str db '%s', 10, 0",
        "nl_str db 10, 0",        
        "__after_num dq 0",       
        "fmt_char db '%c', 0",
        "fmt_float db '%g', 10, 0",
        "fmt_g db '%g', 0",
        "bounds_msg db 'Error: index out of bounds', 10",
        "",
        "section .text", 
        "extern printf",
        "extern scanf",
        "extern fgets",
        "extern strcspn",
        "extern stdin",
        "extern malloc",
        "extern calloc",
        "extern strcpy",
        "extern strcat",
        "extern strlen",
        "extern strcmp",
        "extern atoi",
        "extern sprintf",
        "extern free",
        "extern lrt_arr_new",
        "extern lrt_arr_push",
        "extern lrt_arr_pop",
        "extern lrt_arr_insert",
        "extern lrt_arr_remove",
        "extern lrt_arr_free",
        "extern lrt_map_new",
        "extern lrt_map_set",
        "extern lrt_map_get",
        "extern lrt_map_has",
        "extern lrt_map_remove",
        "extern lrt_map_len",
        "extern lrt_map_keys",
        "extern lrt_map_free",
        "extern memcpy",
        "extern strstr",
        "extern fflush",
        "extern exit",
        "extern gfx_window_init",
        "extern gfx_should_close",
        "extern gfx_swap",
        "extern gfx_destroy",
        "extern gfx_key_down",
        "extern gfx_time",
        "extern gfx_log",
        "extern gfx_c_clear",
        "extern gfx_c_set_pixel",
        "extern gfx_c_hline",
        "extern gfx_c_vline",
        "extern gfx_c_line",
        "extern gfx_c_rect",
        "extern gfx_c_rect_border",
        ""];

    // functions defined in assembly or C (extern fn)
    for (const instr of instructions) {
        if (instr.op === "extern_decl") nasmLines.splice(nasmLines.indexOf("section .text") + 1, 0, `extern ${instr.name}`);
    }

    // Identify global variables: instructions emitted before the first function enter.
    // Collect their names so we can store them in .bss and access them RIP-relative.
    const globalVars = new Set<string>();
    // Globals holding strings or floats. Their initialisers run inside main, which
    // may be emitted after functions that use them, so work this out up front.
    const globalStrings = new Set<string>();
    const globalFloats = new Set<string>();
    // globals set to a plain number (var u64 next_page = 0x400000;): stored in .data with that value
    // instead of being set by code at the start of main. They hold it from the very start, so a
    // kernel's hooks (called while other globals are still being set up) can rely on them
    const staticGlobals = new Map<string, string>();
    {
        const firstEnterIdx = instructions.findIndex(i => i.op === "enter");
        if (firstEnterIdx > 0) {
            for (const instr of instructions.slice(0, firstEnterIdx)) {
                const i = instr as any;
                if (i.dst && typeof i.dst === "string" && !/^(t\d+|__lit_.*)$/.test(i.dst)) {
                    globalVars.add(i.dst);
                }
            }
            const globalInits = instructions.splice(0, firstEnterIdx);
            const writes = new Map<string, number>();
            for (const instr of globalInits) {
                const d = (instr as any).dst;
                if (typeof d === "string") writes.set(d, (writes.get(d) ?? 0) + 1);
            }
            for (let k = globalInits.length - 1; k >= 0; k--) {
                const instr = globalInits[k];
                if (instr.op === "mov" && globalVars.has(instr.dst) && writes.get(instr.dst) === 1 && /^-?\d+$/.test(String(instr.src))) {
                    staticGlobals.set(instr.dst, String(instr.src));
                    globalInits.splice(k, 1);
                }
            }
            const strs = new Set<string>();
            const floats = new Set<string>();
            for (const instr of globalInits) {
                const i = instr as any;
                if (!i.dst) continue;
                if (instr.op === "string_const" || instr.op === "str_concat" || instr.op === "str_dup" || instr.op === "str_sub" ||
                    (instr.op === "const" && typeof instr.value === "string") ||
                    (instr.op === "field_load" && instr.is_string) ||
                    (instr.op === "call" && (instr.returns_string || ["inttostr", "inputstr", "chartostr", "str_upper", "str_lower", "floattostr"].includes(instr.fn)))) {
                    strs.add(i.dst);
                }
                if (["fconst", "fadd", "fsub", "fmul", "fdiv", "fneg", "itof"].includes(instr.op) ||
                    (instr.op === "call" && instr.returns_float)) {
                    floats.add(i.dst);
                }
                if (instr.op === "mov") {
                    if (strs.has(instr.src)) strs.add(instr.dst);
                    if (floats.has(instr.src)) floats.add(instr.dst);
                }
            }
            for (const g of globalVars) {
                if (strs.has(g)) globalStrings.add(g);
                if (floats.has(g)) globalFloats.add(g);
            }
            const entry = options.kernel ? "kernel_main" : "main";
            const mainEnterIdx = instructions.findIndex(i => i.op === "enter" && (i as any).name === entry);
            const insertAfter = mainEnterIdx >= 0 ? mainEnterIdx + 1 : 1;
            instructions.splice(insertAfter, 0, ...globalInits);
        }
    }

    let stackMap = new Map<string, number>();
    let stackOffset = 0;
    let freeSkipCount = 0
    let strOpCount = 0
    let usesUnsetFail = false
    let usesFreeDyn = false

    // ── Freeing by type ──
    // A value that owns other heap values (a string[], a struct with string fields, a P[], an
    // int[][], a tuple holding strings, ...) is freed by a routine generated for its type, which
    // frees what it owns first. A struct field of its own type is fine: the routine calls itself.
    const layouts = new Map<string, { offset: number, type: string }[]>();
    const dynamicStructs = new Set<string>();   // structs with a vtable: freed through its slot 0
    for (const instr of instructions) if (instr.op === "type_layout") {
        layouts.set(instr.name, instr.fields);
        if (instr.dynamic) dynamicStructs.add(instr.name);
    }
    const neededFrees = new Set<string>();
    const isHeapElem = (t: string) => t === "string" || t.endsWith("[]") || /^[A-Z]/.test(t) || t.startsWith("(") || t.startsWith("map<");
    const tupleParts = (t: string) => tupleTypeParts(t);
    function needsDeepFree(t: string | undefined): boolean {
        if (!t) return false;
        if (t.endsWith("[]")) return true;   // an array is a header plus its elements: always a routine
        if (t.startsWith("map<")) return true;
        if (t.startsWith("(") && t.endsWith(")")) return tupleParts(t).some(isHeapElem);
        if (/^[A-Z]/.test(t)) return dynamicStructs.has(t) || (layouts.get(t)?.length ?? 0) > 0;
        return false;
    }
    // unambiguous for nested types: "(" -> T_, ")" -> _E, "," -> _, "[]" -> _arr
    const mapParts = (t: string) => { const [key, value] = tupleTypeParts(`(${t.slice(4, -1)})`); return { key, value }; };
    const mangle = (t: string) => t.replace(/\[\]/g, "_arr").replace(/\(/g, "T_").replace(/\)/g, "_E").replace(/,/g, "_").replace(/</g, "_L_").replace(/>/g, "_G_");
    // the routine that frees a value of type t (plain free when it owns nothing else)
    function freeFn(t: string | undefined): string {
        if (!needsDeepFree(t)) return "free";
        // the actual struct may be a child of t: free it through its own vtable
        if (dynamicStructs.has(t!)) { usesFreeDyn = true; return "__free_dyn"; }
        neededFrees.add(t!);
        return `__free_${mangle(t!)}`;
    }
    // `name` is the routine's label; dynamic structs use __freeobj_<Struct> (their vtable's slot 0)
    function emitFreeRoutine(t: string, name = freeFn(t)): string[] {
        if (t.startsWith("map<")) {
            // lrt_map_free(map, value free routine or NULL); string keys are freed by the runtime
            const value = mapParts(t).value;
            return [`${name}:`, isHeapElem(value) ? `lea rsi, [rel ${freeFn(value)}]` : `xor esi, esi`, `jmp lrt_map_free`];
        }
        if (t.endsWith("[]")) {
            // lrt_arr_free(array, element free routine or NULL)
            const elem = t.slice(0, -2);
            return [`${name}:`, isHeapElem(elem) ? `lea rsi, [rel ${freeFn(elem)}]` : `xor esi, esi`, `jmp lrt_arr_free`];
        }
        const out = [
            `${name}:`,
            `push rbx`,
            `push r12`,
            `sub rsp, 8`,
            `mov rbx, rdi`,
            `test rbx, rbx`,
            `jz .done`,
        ];
        if (t.startsWith("(")) {
            tupleParts(t).forEach((e, i) => {
                if (isHeapElem(e)) out.push(`mov rdi, [rbx + ${i * 8}]`, `call ${freeFn(e)}`);
            });
        } else {
            for (const f of layouts.get(t) ?? []) out.push(`mov rdi, [rbx + ${f.offset}]`, `call ${freeFn(f.type)}`);
        }
        out.push(`mov rdi, rbx`, `call free`, `.done:`, `add rsp, 8`, `pop r12`, `pop rbx`, `ret`);
        return out;
    }
    let inputCount = 0 
    const stringLiterals = new Map<string, string>();
    const stringTemps = new Set<string>(globalStrings);
    let stringCount = 0;
    const floatVars = new Set<string>();
    const floatConsts: string[] = [];
    let floatConstCount = 0;

    const frameSizes = new Map<string, number>();
    {
        let fnName = "";
        let slots = new Map<string, number>();
        let off = 0;
        function simSlot(name: string) {
            if (globalVars.has(name)) return;
            if (!slots.has(name)) { off += 8; slots.set(name, off); }
        }
        function simOperands(instr: IR) {
            const i = instr as any;
            if (i.dst) simSlot(i.dst);
            if (i.src) simSlot(i.src);
            if (i.a)   simSlot(i.a);
            if (i.b)   simSlot(i.b);
            if (i.arr) simSlot(i.arr);
            if (i.addr) simSlot(i.addr);
            if (i.base) simSlot(i.base);
            if (i.cond) simSlot(i.cond);
            // operands of the newer ops (maps, substrings, indirect calls, array insert/remove)
            for (const k of ["start", "end", "key", "map", "target", "index"]) {
                if (typeof i[k] === "string" && !/^-?\d+$/.test(i[k])) simSlot(i[k]);
            }
            if (i.value && typeof i.value === "string" && !/^-?\d+$/.test(i.value)) simSlot(i.value);
            if (i.args) (i.args as string[]).forEach(a => { if (!/^-?\d+$/.test(a)) simSlot(a); });
            if (i.dst && /^-?\d+$/.test(i.dst)) simSlot(`__lit_${i.dst}`);
            if (i.value && typeof i.value === "number") simSlot(`__lit_${i.value}`);
            if (i.dst && globalVars.has(i.dst)) simSlot(`__gcopy_${i.dst}`);
            if (i.src && globalVars.has(i.src)) simSlot(`__gcopy_${i.src}`);
            if (i.a   && globalVars.has(i.a))   simSlot(`__gcopy_${i.a}`);
            if (i.b   && globalVars.has(i.b))   simSlot(`__gcopy_${i.b}`);
            if (i.arr && globalVars.has(i.arr)) simSlot(`__gcopy_${i.arr}`);
            if (i.cond && globalVars.has(i.cond)) simSlot(`__gcopy_${i.cond}`);
        }
        for (const instr of instructions) {
            if (instr.op === "enter") {
                fnName = instr.name; slots = new Map(); off = 0;
            } else if (instr.op === "leave") {
                const aligned = Math.max(32, Math.ceil(off / 16) * 16);
                frameSizes.set(fnName, aligned);
            } else {
                simOperands(instr);
                if (instr.op === "str_concat") simSlot("__concat_len");
                if (instr.op === "str_sub") { simSlot("__strsub_len"); simSlot("__strsub_start"); simSlot("__strsub_end"); }
                if (instr.op === "array_free_2d") {
                    simSlot(`__free2d_idx_${instr.arr}`);
                    if (typeof instr.rows === "string" && !/^-?\d+$/.test(instr.rows)) simSlot(instr.rows);
                }
            }
        }
    }

    function getStringLabel(value: string): string {
        if (!stringLiterals.has(value)) {
            const label = `str_${stringCount++}`;
            stringLiterals.set(value, label);
        }
        return stringLiterals.get(value)!;
    }

    function resolveValue(v: string): string {
        if (/^-?\d+$/.test(v)) {
            nasmLines.push(`mov rax, ${v}`);
            const tmp = getSlot(`__lit_${v}`);
            nasmLines.push(`mov [rbp - ${tmp}], rax`);
            return tmp.toString();
        }
        return getSlot(v).toString();
    }

    function getSlot(name: string): number {
        if (!stackMap.has(name)) {
            stackOffset += 8;
            stackMap.set(name, stackOffset);
        }
        return stackMap.get(name)!;
    }

    // Returns the NASM memory reference for a named variable.
    // Globals use RIP-relative addressing; locals use rbp-relative.
    function memRef(name: string): string {
        if (globalVars.has(name)) return `[rel __g_${name}]`;
        return `[rbp - ${getSlot(name)}]`;
    }

    // Store an integer constant to memory. 'mov qword [mem], imm' only encodes a
    // sign-extended 32-bit immediate, so larger values go through a register.
    // `scratch` must not hold anything the caller still needs.
    function storeImm(dest: string, value: string | number | bigint, scratch = "rax") {
        const text = String(value);
        if (/^-?\d+$/.test(text) && (BigInt(text) < -2147483648n || BigInt(text) > 2147483647n)) {
            nasmLines.push(`mov ${scratch}, ${text}`);
            nasmLines.push(`mov ${dest}, ${scratch}`);
        } else {
            nasmLines.push(`mov qword ${dest}, ${text}`);
        }
    }

    // Array index as a mov source: the literal itself, or the variable's memory.
    function indexOperand(index: string): string {
        return /^-?\d+$/.test(index) ? index : memRef(index);
    }

    // True when a literal index's byte offset fits in a 32-bit displacement.
    function fitsDisp32(index: string): boolean {
        const offset = 8n + BigInt(index) * 8n;
        return offset >= -2147483648n && offset <= 2147483647n;
    }

    // Jump to _bounds_fail unless 0 <= index < length. Expects rcx = length; clobbers rdx.
    function boundsCheck(index: string) {
        nasmLines.push(`mov rdx, ${indexOperand(index)}`);
        nasmLines.push(`cmp rdx, rcx`);
        nasmLines.push(`jge _bounds_fail`);
        nasmLines.push(`cmp rdx, 0`);
        nasmLines.push(`jl _bounds_fail`);
    }

    function loadOperand(val: string): string {
        if (/^-?\d+$/.test(val)) {
            const slot = getSlot(`__lit_${val}`);
            storeImm(`[rbp - ${slot}]`, val);
            return slot.toString();
        }
        if (globalVars.has(val)) {
            // global — copy into a local temp so existing [rbp - slot] logic works
            const tmpSlot = getSlot(`__gcopy_${val}`);
            nasmLines.push(`mov rax, [rel __g_${val}]`);
            nasmLines.push(`mov [rbp - ${tmpSlot}], rax`);
            return tmpSlot.toString();
        }
        return getSlot(val).toString();
    }

    function resetFrame() {
        stackMap = new Map();
        stackOffset = 0;
        floatVars.clear();
        for (const g of globalFloats) floatVars.add(g);
    }

    const sysv = ["rdi", "rsi", "rdx", "rcx", "r8", "r9"];
    // SysV numbers int and float argument registers separately
    let intArgIdx = 0;
    let floatArgIdx = 0;

    for (const instr of instructions) {
        switch (instr.op) {
            
            // An array is a header {len, cap, data} (see Typescript/runtime/lrt.c); elements are
            // 8-byte slots at data[i]. The header never moves, so a grown array stays valid everywhere.
            case "array_new": {
                nasmLines.push(`mov rdi, ${typeof instr.size === "number" ? instr.size : memRef(instr.size)}`);
                nasmLines.push(`call lrt_arr_new`);                // zero-filled
                nasmLines.push(`mov ${memRef(instr.dst)}, rax`);
                break;
            }

            case "array_load": {
                nasmLines.push(`mov rax, ${memRef(instr.arr)}`);  // rax = header
                nasmLines.push(`mov rcx, [rax]`);                // rcx = length
                boundsCheck(instr.index);
                nasmLines.push(`mov rax, [rax + 16]`);           // rax = data
                if (/^-?\d+$/.test(instr.index) && fitsDisp32(instr.index)) {
                    nasmLines.push(`mov rax, [rax + ${Number(instr.index) * 8}]`);
                } else {
                    nasmLines.push(`mov rdx, ${indexOperand(instr.index)}`);
                    nasmLines.push(`mov rax, [rax + rdx*8]`);
                }
                nasmLines.push(`mov ${memRef(instr.dst)}, rax`);
                if (instr.is_string) stringTemps.add(instr.dst);
                if (instr.is_float) floatVars.add(instr.dst);
                break;
            }

            case "array_store": {
                nasmLines.push(`mov rax, ${memRef(instr.arr)}`);  // rax = header
                nasmLines.push(`mov rcx, [rax]`);                // rcx = length
                boundsCheck(instr.index);
                if(/^-?\d+$/.test(instr.src)) {
                    nasmLines.push(`mov r10, ${instr.src}`)
                } else {
                    nasmLines.push(`mov r10, ${memRef(instr.src)}`)
                }
                nasmLines.push(`mov rax, [rax + 16]`);           // rax = data
                if (/^-?\d+$/.test(instr.index) && fitsDisp32(instr.index)) {
                    nasmLines.push(`mov [rax + ${Number(instr.index) * 8}], r10`)
                } else {
                    nasmLines.push(`mov rdx, ${indexOperand(instr.index)}`);
                    nasmLines.push(`mov [rax + rdx*8], r10`);
                }
                break;
            }

            case "array_len": {
                nasmLines.push(`mov rax, ${memRef(instr.arr)}`);  // rax = header
                nasmLines.push(`mov rax, [rax]`);                  // rax = length
                nasmLines.push(`mov ${memRef(instr.dst)}, rax`);
                break;
            }

            // push/insert take the raw 8 bytes (float bits too); pop/remove hand back an element
            case "array_push":
            case "array_insert": {
                const val = (x: string) => /^-?\d+$/.test(x) ? x : memRef(x);
                nasmLines.push(`mov rdi, ${memRef(instr.arr)}`);
                if (instr.op === "array_insert") {
                    nasmLines.push(`mov rsi, ${val(instr.index)}`);
                    nasmLines.push(`mov rdx, ${val(instr.src)}`);
                    nasmLines.push(`call lrt_arr_insert`);
                } else {
                    nasmLines.push(`mov rsi, ${val(instr.src)}`);
                    nasmLines.push(`call lrt_arr_push`);
                }
                break;
            }
            case "array_pop":
            case "array_remove": {
                nasmLines.push(`mov rdi, ${memRef(instr.arr)}`);
                if (instr.op === "array_remove") {
                    nasmLines.push(`mov rsi, ${/^-?\d+$/.test(instr.index) ? instr.index : memRef(instr.index)}`);
                    nasmLines.push(`call lrt_arr_remove`);
                } else {
                    nasmLines.push(`call lrt_arr_pop`);
                }
                nasmLines.push(`mov ${memRef(instr.dst)}, rax`);
                if (instr.is_string) stringTemps.add(instr.dst);
                if (instr.is_float) floatVars.add(instr.dst);
                break;
            }

            case "enter": {
                resetFrame();
                intArgIdx = 0;
                floatArgIdx = 0;
                // '$' makes NASM read the name as a symbol even if it is a mnemonic (e.g. 'rep')
                nasmLines.push(`global $${instr.name}`);
                nasmLines.push(`$${instr.name}:`);
                nasmLines.push(`push rbp`);
                nasmLines.push(`mov rbp, rsp`);
                nasmLines.push(`sub rsp, ${frameSizes.get(instr.name) ?? 256}`);
                break;
            }
            case "leave": {
                nasmLines.push(`mov rsp, rbp`);
                nasmLines.push(`pop rbp`);
                nasmLines.push(`ret`);
                break;
            }
            case "str_cmp": {
                nasmLines.push(`mov rdi, ${memRef(instr.a)}`);
                nasmLines.push(`mov rsi, ${memRef(instr.b)}`);
                nasmLines.push(`call strcmp`);
                nasmLines.push(`movsxd rax, eax`);          // strcmp returns a 32-bit int
                nasmLines.push(`mov ${memRef(instr.dst)}, rax`);
                break;
            }
            case "str_sub": {
                // src[start..end] as a new string; start and end are clamped to 0..len
                const n = strOpCount++;
                const val = (x: string) => /^-?\d+$/.test(x) ? x : memRef(x);
                const lenSlot = getSlot(`__strsub_len`), startSlot = getSlot(`__strsub_start`), endSlot = getSlot(`__strsub_end`);
                nasmLines.push(`mov rdi, ${memRef(instr.src)}`);
                nasmLines.push(`call strlen`);
                nasmLines.push(`mov [rbp - ${lenSlot}], rax`);
                nasmLines.push(`mov rax, ${val(instr.start)}`);
                nasmLines.push(`mov rcx, ${val(instr.end)}`);
                nasmLines.push(`xor rdx, rdx`);
                nasmLines.push(`cmp rax, 0`);
                nasmLines.push(`cmovl rax, rdx`);
                nasmLines.push(`cmp rax, [rbp - ${lenSlot}]`);
                nasmLines.push(`cmovg rax, [rbp - ${lenSlot}]`);
                nasmLines.push(`cmp rcx, [rbp - ${lenSlot}]`);
                nasmLines.push(`cmovg rcx, [rbp - ${lenSlot}]`);
                nasmLines.push(`cmp rcx, rax`);
                nasmLines.push(`cmovl rcx, rax`);
                nasmLines.push(`mov [rbp - ${startSlot}], rax`);
                nasmLines.push(`mov [rbp - ${endSlot}], rcx`);
                nasmLines.push(`sub rcx, rax`);
                nasmLines.push(`lea rdi, [rcx + 1]`);
                nasmLines.push(`call malloc`);
                nasmLines.push(`mov ${memRef(instr.dst)}, rax`);
                nasmLines.push(`mov rdi, rax`);
                nasmLines.push(`mov rsi, ${memRef(instr.src)}`);
                nasmLines.push(`add rsi, [rbp - ${startSlot}]`);
                nasmLines.push(`mov rdx, [rbp - ${endSlot}]`);
                nasmLines.push(`sub rdx, [rbp - ${startSlot}]`);
                nasmLines.push(`mov [rbp - ${lenSlot}], rdx`);
                nasmLines.push(`call memcpy`);
                nasmLines.push(`mov rax, ${memRef(instr.dst)}`);
                nasmLines.push(`add rax, [rbp - ${lenSlot}]`);
                nasmLines.push(`mov byte [rax], 0`);
                stringTemps.add(instr.dst);
                void n;
                break;
            }
            case "type_layout":
                break; // read before emitting
            case "check_set": {
                // a field that was never set: print the message and stop (see __unset_fail)
                const n = strOpCount++;
                const text = instr.message + "\n";
                nasmLines.push(`cmp qword ${memRef(instr.src)}, 0`);
                nasmLines.push(`jne __set_ok_${n}`);
                nasmLines.push(`lea rsi, [rel ${getStringLabel(text)}]`);
                nasmLines.push(`mov rdx, ${Buffer.byteLength(text, "utf8")}`);
                nasmLines.push(`jmp __unset_fail`);
                nasmLines.push(`__set_ok_${n}:`);
                usesUnsetFail = true;
                break;
            }
            case "str_eq": {
                nasmLines.push(`mov rdi, ${memRef(instr.a)}`);
                nasmLines.push(`mov rsi, ${memRef(instr.b)}`);
                nasmLines.push(`call strcmp`);
                nasmLines.push(`test rax, rax`);
                nasmLines.push(`sete al`);
                nasmLines.push(`movzx rax, al`);
                nasmLines.push(`mov ${memRef(instr.dst)}, rax`);
                break;
            }
            case "str_neq": {
                nasmLines.push(`mov rdi, ${memRef(instr.a)}`);
                nasmLines.push(`mov rsi, ${memRef(instr.b)}`);
                nasmLines.push(`call strcmp`);
                nasmLines.push(`test rax, rax`);
                nasmLines.push(`setne al`);
                nasmLines.push(`movzx rax, al`);
                nasmLines.push(`mov ${memRef(instr.dst)}, rax`);
                break;
            }
            case "arg": {
                if (instr.isFloat) {
                    floatVars.add(instr.dst);
                    nasmLines.push(`movsd ${memRef(instr.dst)}, xmm${floatArgIdx++}`);
                } else {
                    nasmLines.push(`mov qword ${memRef(instr.dst)}, ${sysv[intArgIdx++]}`);
                }
                break;
            }
            case "const": {
                if (typeof instr.value === "string") {
                    const label = getStringLabel(instr.value);
                    nasmLines.push(`lea rax, [rel ${label}]`);
                    nasmLines.push(`mov ${memRef(instr.dst)}, rax`);
                    stringTemps.add(instr.dst);
                } else {
                    storeImm(memRef(instr.dst), instr.value);
                }
                break;
            }
            case "mov": {
                if (stringTemps.has(instr.src)) {
                    stringTemps.add(instr.dst);
                }
                if (floatVars.has(instr.src)) {
                    floatVars.add(instr.dst);
                }
                if (/^-?\d+$/.test(instr.src)) {
                    storeImm(memRef(instr.dst), instr.src);
                } else {
                    nasmLines.push(`mov rax, ${memRef(instr.src)}`);
                    nasmLines.push(`mov ${memRef(instr.dst)}, rax`);
                }
                break;
            }
            case "ret": {
                if (instr.value !== undefined) {
                    if (/^-?\d+$/.test(instr.value)) {
                        nasmLines.push(`mov rax, ${instr.value}`);
                    } else if (floatVars.has(instr.value)) {
                        nasmLines.push(`movsd xmm0, ${memRef(instr.value)}`);
                    } else {
                        nasmLines.push(`mov rax, ${memRef(instr.value)}`);
                    }
                }
                nasmLines.push(`mov rsp, rbp`);
                nasmLines.push(`pop rbp`);
                nasmLines.push(`ret`);
                break;
            }
            case "call": {
                if (/^(in|out)[bwl]$/.test(instr.fn)) {
                    // port I/O: the port goes in dx; in reads into al/ax/eax, out writes from it
                    const reg = ({ b: "al", w: "ax", l: "eax" } as Record<string, string>)[instr.fn[instr.fn.length - 1]];
                    nasmLines.push(`mov rdx, ${indexOperand(instr.args[0])}`);
                    if (instr.fn.startsWith("out")) {
                        nasmLines.push(`mov rax, ${indexOperand(instr.args[1])}`);
                        nasmLines.push(`out dx, ${reg}`);
                    } else {
                        nasmLines.push(`xor eax, eax`);
                        nasmLines.push(`in ${reg}, dx`);
                        if (instr.dst) nasmLines.push(`mov ${memRef(instr.dst)}, rax`);
                    }
                    break;
                }
                if (instr.fn === "print_int" || instr.fn === "print_str" || instr.fn === "print") {
                    const arg = instr.args[0];
                    const slot = loadOperand(arg);
                    const isString = stringTemps.has(instr.args[0]);
                    const isFloat = floatVars.has(instr.args[0]);
                    if (isFloat) {
                        nasmLines.push(`movsd xmm0, [rbp - ${slot}]`);
                        nasmLines.push(`lea rdi, [rel fmt_float]`);
                        nasmLines.push(`mov eax, 1`);
                        nasmLines.push(`call printf`);
                    } else {
                        nasmLines.push(`mov rsi, [rbp - ${slot}]`);
                        nasmLines.push(`lea rdi, [rel ${isString ? "fmt_str" : "fmt"}]`);
                        nasmLines.push(`xor eax, eax`);
                        nasmLines.push(`call printf`);
                    }
                } else if (instr.fn === "input") {
                    const dst = getSlot(instr.dst!);
                    nasmLines.push(`lea rsi, [rbp - ${dst}]`);
                    nasmLines.push(`lea rdi, [rel fmt_in]`);
                    nasmLines.push(`xor eax, eax`);
                    nasmLines.push(`call scanf`);
                    nasmLines.push(`mov qword [rel __after_num], 1`)
                } else if (instr.fn === "inputstr") {
                    const n = inputCount++;
                    const buf = memRef(instr.dst!);
                    nasmLines.push(`mov rdi, 1`);
                    nasmLines.push(`mov rsi, 256`);
                    nasmLines.push(`call calloc`);                    // "" if nothing is read (EOF)
                    nasmLines.push(`mov ${buf}, rax`);
                    nasmLines.push(`__inputstr_read_${n}:`);
                    nasmLines.push(`mov rdi, ${buf}`);
                    nasmLines.push(`mov rsi, 256`);
                    nasmLines.push(`mov rdx, [rel stdin]`);
                    nasmLines.push(`call fgets`);
                    nasmLines.push(`mov rdi, ${buf}`);
                    nasmLines.push(`lea rsi, [rel nl_str]`);
                    nasmLines.push(`call strcspn`);                   // index of the newline (or the end)
                    nasmLines.push(`mov rcx, ${buf}`);
                    nasmLines.push(`mov byte [rcx + rax], 0`);
                    nasmLines.push(`cmp qword [rel __after_num], 0`);
                    nasmLines.push(`mov qword [rel __after_num], 0`); // mov leaves the flags from cmp intact
                    nasmLines.push(`je __inputstr_done_${n}`);
                    nasmLines.push(`cmp byte [rcx], 0`);
                    nasmLines.push(`je __inputstr_read_${n}`);        // only the rest of input()'s line: read again
                    nasmLines.push(`__inputstr_done_${n}:`);
                    stringTemps.add(instr.dst!);
                } else if (instr.fn === "len") {
                    nasmLines.push(`mov rdi, ${memRef(instr.args[0])}`);
                    nasmLines.push(`call strlen`);
                    nasmLines.push(`mov ${memRef(instr.dst!)}, rax`);
                } else if (instr.fn === "printchar") {
                    const arg = loadOperand(instr.args[0]);
                    nasmLines.push(`mov rsi, [rbp - ${arg}]`);
                    nasmLines.push(`lea rdi, [rel fmt_char]`);
                    nasmLines.push(`xor eax, eax`);
                    nasmLines.push(`call printf`);
                } else if (instr.fn === "strtoint") {
                    nasmLines.push(`mov rdi, ${memRef(instr.args[0])}`);
                    nasmLines.push(`call atoi`);
                    nasmLines.push(`mov ${memRef(instr.dst!)}, rax`);
                } else if (instr.fn === "chartostr") {
                    // a one-character string
                    nasmLines.push(`mov rdi, 2`);
                    nasmLines.push(`mov rsi, 1`);
                    nasmLines.push(`call calloc`);
                    nasmLines.push(`mov ${memRef(instr.dst!)}, rax`);
                    const arg = instr.args[0];
                    nasmLines.push(`mov rcx, ${/^-?\d+$/.test(arg) ? arg : memRef(arg)}`);
                    nasmLines.push(`mov [rax], cl`);
                    stringTemps.add(instr.dst!);
                } else if (instr.fn === "str_upper" || instr.fn === "str_lower") {
                    // a copy with a-z / A-Z changed case
                    const n = strOpCount++;
                    const [from, to] = instr.fn === "str_upper" ? ["a", "z"] : ["A", "Z"];
                    const delta = instr.fn === "str_upper" ? -32 : 32;
                    nasmLines.push(`mov rdi, ${memRef(instr.args[0])}`);
                    nasmLines.push(`call strlen`);
                    nasmLines.push(`lea rdi, [rax + 1]`);
                    nasmLines.push(`call malloc`);
                    nasmLines.push(`mov ${memRef(instr.dst!)}, rax`);
                    nasmLines.push(`mov rdi, rax`);
                    nasmLines.push(`mov rsi, ${memRef(instr.args[0])}`);
                    nasmLines.push(`call strcpy`);
                    nasmLines.push(`mov rax, ${memRef(instr.dst!)}`);
                    nasmLines.push(`__case_loop_${n}:`);
                    nasmLines.push(`mov cl, [rax]`);
                    nasmLines.push(`test cl, cl`);
                    nasmLines.push(`jz __case_done_${n}`);
                    nasmLines.push(`cmp cl, '${from}'`);
                    nasmLines.push(`jl __case_next_${n}`);
                    nasmLines.push(`cmp cl, '${to}'`);
                    nasmLines.push(`jg __case_next_${n}`);
                    nasmLines.push(`add cl, ${delta}`);
                    nasmLines.push(`mov [rax], cl`);
                    nasmLines.push(`__case_next_${n}:`);
                    nasmLines.push(`inc rax`);
                    nasmLines.push(`jmp __case_loop_${n}`);
                    nasmLines.push(`__case_done_${n}:`);
                    stringTemps.add(instr.dst!);
                } else if (instr.fn === "str_find" || instr.fn === "str_contains") {
                    // index of the first occurrence of args[1] in args[0] (-1 if none), or 1/0
                    nasmLines.push(`mov rdi, ${memRef(instr.args[0])}`);
                    nasmLines.push(`mov rsi, ${memRef(instr.args[1])}`);
                    nasmLines.push(`call strstr`);
                    if (instr.fn === "str_contains") {
                        nasmLines.push(`test rax, rax`);
                        nasmLines.push(`setnz al`);
                        nasmLines.push(`movzx rax, al`);
                    } else {
                        nasmLines.push(`mov rcx, -1`);
                        nasmLines.push(`test rax, rax`);
                        nasmLines.push(`cmovz rax, rcx`);
                        nasmLines.push(`jz __find_done_${strOpCount}`);
                        nasmLines.push(`sub rax, ${memRef(instr.args[0])}`);
                        nasmLines.push(`__find_done_${strOpCount++}:`);
                    }
                    nasmLines.push(`mov ${memRef(instr.dst!)}, rax`);
                } else if (instr.fn === "floattostr") {
                    // the float as text, formatted like print (%g)
                    const arg = instr.args[0];
                    nasmLines.push(`mov rdi, 32`);
                    nasmLines.push(`call malloc`);
                    nasmLines.push(`mov ${memRef(instr.dst!)}, rax`);
                    nasmLines.push(`mov rdi, rax`);
                    nasmLines.push(`lea rsi, [rel fmt_g]`);
                    nasmLines.push(`movsd xmm0, ${memRef(arg)}`);
                    nasmLines.push(`mov eax, 1`);
                    nasmLines.push(`call sprintf`);
                    stringTemps.add(instr.dst!);
                } else if (instr.fn === "inttostr") {
                    const arg = loadOperand(instr.args[0]);
                    nasmLines.push(`mov rdi, 32`);
                    nasmLines.push(`call malloc`);
                    nasmLines.push(`mov ${memRef(instr.dst!)}, rax`);
                    nasmLines.push(`mov rdi, rax`);
                    nasmLines.push(`lea rsi, [rel fmt_in]`);
                    nasmLines.push(`mov rdx, [rbp - ${arg}]`);
                    nasmLines.push(`xor eax, eax`);
                    nasmLines.push(`call sprintf`);
                    stringTemps.add(instr.dst!);
                } else {
                    let xmmIdx = 0;
                    let intIdx = 0;
                    instr.args.forEach((arg) => {
                        if (floatVars.has(arg)) {
                            nasmLines.push(`movsd xmm${xmmIdx++}, ${memRef(arg)}`);
                        } else if (/^-?\d+$/.test(arg)) {
                            nasmLines.push(`mov ${sysv[intIdx++]}, ${arg}`);
                        } else {
                            nasmLines.push(`mov ${sysv[intIdx++]}, ${memRef(arg)}`);
                        }
                    });
                    if (xmmIdx > 0) nasmLines.push(`mov eax, ${xmmIdx}`);
                    else nasmLines.push(`xor eax, eax`);
                    nasmLines.push(`call $${instr.fn}`);
                    if (instr.dst) {
                        if (instr.returns_float) {
                            nasmLines.push(`movsd ${memRef(instr.dst)}, xmm0`);
                            floatVars.add(instr.dst);
                        } else {
                            nasmLines.push(`mov ${memRef(instr.dst)}, rax`);
                        }
                        if (instr.returns_string) {
                            stringTemps.add(instr.dst);
                        }
                    }
                }
                break;
            }
            case "label": {
                nasmLines.push(`${instr.name}:`);
                break;
            }
            case "jmp": {
                nasmLines.push(`jmp ${instr.target}`);
                break;
            }
            case "jz": {
                const slot = loadOperand(String(instr.cond));
                nasmLines.push(`mov rax, [rbp - ${slot}]`);
                nasmLines.push(`test rax, rax`);
                nasmLines.push(`jz ${instr.target}`);
                break;
            }
            case "jnz": {
                const slot = loadOperand(String(instr.cond));
                nasmLines.push(`mov rax, [rbp - ${slot}]`);
                nasmLines.push(`test rax, rax`);
                nasmLines.push(`jnz ${instr.target}`);
                break;
            }
            case "add": {
                const a = loadOperand(instr.a);
                const b = loadOperand(instr.b);
                nasmLines.push(`mov rax, [rbp - ${a}]`);
                nasmLines.push(`add rax, [rbp - ${b}]`);
                nasmLines.push(`mov ${memRef(instr.dst)}, rax`);
                break;
            }
            case "sub": {
                const a = loadOperand(instr.a);
                const b = loadOperand(instr.b);
                nasmLines.push(`mov rax, [rbp - ${a}]`);
                nasmLines.push(`sub rax, [rbp - ${b}]`);
                nasmLines.push(`mov ${memRef(instr.dst)}, rax`);
                break;
            }
            case "mul": {
                const a = loadOperand(instr.a);
                const b = loadOperand(instr.b);
                nasmLines.push(`mov rax, [rbp - ${a}]`);
                nasmLines.push(`imul rax, [rbp - ${b}]`);
                nasmLines.push(`mov ${memRef(instr.dst)}, rax`);
                break;
            }
            case "string_const": {
                stringTemps.add(instr.dst);
                const label = getStringLabel(instr.value);
                nasmLines.push(`lea rax, [rel ${label}]`);
                nasmLines.push(`mov ${memRef(instr.dst)}, rax`);
                break;
            }
            case "div":
            case "mod": {
                // x / 0 stops with an error; x / -1 is a negation (idiv traps on INT64_MIN / -1)
                const a = loadOperand(instr.a);
                const b = loadOperand(instr.b);
                const n = strOpCount++;
                const text = "Error: division by zero\n";
                nasmLines.push(`mov rcx, [rbp - ${b}]`);
                nasmLines.push(`test rcx, rcx`);
                nasmLines.push(`jnz __div_ok_${n}`);
                nasmLines.push(`lea rsi, [rel ${getStringLabel(text)}]`);
                nasmLines.push(`mov rdx, ${Buffer.byteLength(text, "utf8")}`);
                nasmLines.push(`jmp __unset_fail`);
                usesUnsetFail = true;
                nasmLines.push(`__div_ok_${n}:`);
                nasmLines.push(`mov rax, [rbp - ${a}]`);
                if (instr.unsigned) {
                    // u64: unsigned division (no INT64_MIN / -1 case)
                    nasmLines.push(`xor edx, edx`);
                    nasmLines.push(`div rcx`);
                    if (instr.op === "mod") nasmLines.push(`mov rax, rdx`);
                    nasmLines.push(`mov ${memRef(instr.dst)}, rax`);
                    break;
                }
                nasmLines.push(`cmp rcx, -1`);
                nasmLines.push(`jne __div_normal_${n}`);
                nasmLines.push(instr.op === "div" ? `neg rax` : `xor eax, eax`);
                nasmLines.push(`jmp __div_done_${n}`);
                nasmLines.push(`__div_normal_${n}:`);
                nasmLines.push(`cqo`);
                nasmLines.push(`idiv rcx`);
                if (instr.op === "mod") nasmLines.push(`mov rax, rdx`);
                nasmLines.push(`__div_done_${n}:`);
                nasmLines.push(`mov ${memRef(instr.dst)}, rax`);
                break;
            }
            case "and": {
                const a = loadOperand(instr.a);
                const b = loadOperand(instr.b);
                nasmLines.push(`mov rax, [rbp - ${a}]`);
                nasmLines.push(`and rax, [rbp - ${b}]`);
                nasmLines.push(`mov ${memRef(instr.dst)}, rax`);
                break;
            }
            case "or": {
                const a = loadOperand(instr.a);
                const b = loadOperand(instr.b);
                nasmLines.push(`mov rax, [rbp - ${a}]`);
                nasmLines.push(`or rax, [rbp - ${b}]`);
                nasmLines.push(`mov ${memRef(instr.dst)}, rax`);
                break;
            }
            case "xor": {
                const a = loadOperand(instr.a);
                const b = loadOperand(instr.b);
                nasmLines.push(`mov rax, [rbp - ${a}]`);
                nasmLines.push(`xor rax, [rbp - ${b}]`);
                nasmLines.push(`mov ${memRef(instr.dst)}, rax`);
                break;
            }
            case "shl": {
                const a = loadOperand(instr.a);
                const b = loadOperand(instr.b);
                nasmLines.push(`mov rax, [rbp - ${a}]`);
                nasmLines.push(`mov rcx, [rbp - ${b}]`);
                nasmLines.push(`shl rax, cl`);
                nasmLines.push(`mov ${memRef(instr.dst)}, rax`);
                break;
            }
            case "shr": {
                const a = loadOperand(instr.a);
                const b = loadOperand(instr.b);
                nasmLines.push(`mov rax, [rbp - ${a}]`);
                nasmLines.push(`mov rcx, [rbp - ${b}]`);
                nasmLines.push(`shr rax, cl`);
                nasmLines.push(`mov ${memRef(instr.dst)}, rax`);
                break;
            }
            case "sar": {
                const a = loadOperand(instr.a);
                const b = loadOperand(instr.b);
                nasmLines.push(`mov rax, [rbp - ${a}]`);
                nasmLines.push(`mov rcx, [rbp - ${b}]`);
                nasmLines.push(`sar rax, cl`);
                nasmLines.push(`mov ${memRef(instr.dst)}, rax`);
                break;
            }
            case "bnot": {
                const src = loadOperand(instr.src);
                nasmLines.push(`mov rax, [rbp - ${src}]`);
                nasmLines.push(`not rax`);
                nasmLines.push(`mov ${memRef(instr.dst)}, rax`);
                break;
            }
            case "trunc": {
                // keep the value widened to 64 bits, zero- or sign-extended from its size
                const src = loadOperand(instr.src);
                nasmLines.push(`mov rax, [rbp - ${src}]`);
                nasmLines.push(({
                    u8: "movzx eax, al", u16: "movzx eax, ax", u32: "mov eax, eax",
                    i8: "movsx rax, al", i16: "movsx rax, ax", i32: "movsxd rax, eax",
                } as Record<string, string>)[instr.type] ?? "");
                nasmLines.push(`mov ${memRef(instr.dst)}, rax`);
                break;
            }
            case "mem_load": {
                // raw memory: read exactly `size` bytes, widened to 64 bits. The address may be a
                // literal (copyProp puts a pointer's constant value here), so load it as an operand
                nasmLines.push(`mov rax, [rbp - ${loadOperand(instr.addr)}]`);
                const load: Record<string, string> = {
                    "1u": "movzx eax, byte [rax]", "1s": "movsx rax, byte [rax]",
                    "2u": "movzx eax, word [rax]", "2s": "movsx rax, word [rax]",
                    "4u": "mov eax, dword [rax]", "4s": "movsxd rax, dword [rax]",
                    "8u": "mov rax, qword [rax]", "8s": "mov rax, qword [rax]",
                };
                nasmLines.push(load[`${instr.size}${instr.signed ? "s" : "u"}`]);
                nasmLines.push(`mov ${memRef(instr.dst)}, rax`);
                break;
            }
            case "mem_store": {
                const src = loadOperand(instr.src);
                nasmLines.push(`mov rax, [rbp - ${loadOperand(instr.addr)}]`);
                nasmLines.push(`mov rcx, [rbp - ${src}]`);
                nasmLines.push(({ 1: "mov byte [rax], cl", 2: "mov word [rax], cx", 4: "mov dword [rax], ecx", 8: "mov qword [rax], rcx" } as Record<number, string>)[instr.size]);
                break;
            }
            case "global_addr": {
                nasmLines.push(`lea rax, [rel __g_${instr.name}]`);
                nasmLines.push(`mov ${memRef(instr.dst)}, rax`);
                break;
            }
            case "extern_decl":
                break;   // declared at the top (see externNames)
            case "isr_stub": {
                // The CPU jumps here with (error code,) rip, cs, rflags, rsp, ss on the stack. Save every
                // register and the SSE state (the handler is ordinary L code, which may use any of them),
                // call the body with the frame and error code, restore, drop the error code, iretq
                const regs = ["rax", "rbx", "rcx", "rdx", "rsi", "rdi", "rbp", "r8", "r9", "r10", "r11", "r12", "r13", "r14", "r15"];
                const saved = regs.length * 8;
                nasmLines.push(`global $${instr.name}`);
                nasmLines.push(`$${instr.name}:`);
                for (const r of regs) nasmLines.push(`push ${r}`);
                nasmLines.push(`mov rbx, rsp`);                          // rbx survives the call
                nasmLines.push(`and rsp, -16`);
                nasmLines.push(`sub rsp, 512`);
                nasmLines.push(`fxsave64 [rsp]`);
                nasmLines.push(`lea rdi, [rbx + ${saved + (instr.errorCode ? 8 : 0)}]`);   // the frame
                if (instr.errorCode) nasmLines.push(`mov rsi, [rbx + ${saved}]`);         // the error code
                nasmLines.push(`cld`);
                nasmLines.push(`call $${instr.fn}`);
                nasmLines.push(`fxrstor64 [rsp]`);
                nasmLines.push(`mov rsp, rbx`);
                for (const r of [...regs].reverse()) nasmLines.push(`pop ${r}`);
                if (instr.errorCode) nasmLines.push(`add rsp, 8`);
                nasmLines.push(`iretq`);
                break;
            }
            case "not": {
                const src = loadOperand(instr.src);
                nasmLines.push(`mov rax, [rbp - ${src}]`);
                nasmLines.push(`test rax, rax`);
                nasmLines.push(`sete al`);
                nasmLines.push(`movzx rax, al`);
                nasmLines.push(`mov ${memRef(instr.dst)}, rax`);
                break;
            }
            case "neg": {
                const src = loadOperand(instr.src);
                nasmLines.push(`mov rax, [rbp - ${src}]`);
                nasmLines.push(`neg rax`);
                nasmLines.push(`mov ${memRef(instr.dst)}, rax`);
                break;
            }
            case "abs": {
                const src = loadOperand(instr.src);
                nasmLines.push(`mov rax, [rbp - ${src}]`);
                nasmLines.push(`mov rcx, rax`);
                nasmLines.push(`neg rax`);
                nasmLines.push(`cmovl rax, rcx`);
                nasmLines.push(`mov ${memRef(instr.dst)}, rax`);
                break;
            }
            case "eq": {
                const a = loadOperand(instr.a);
                const b = loadOperand(instr.b);
                nasmLines.push(`mov rax, [rbp - ${a}]`);
                nasmLines.push(`cmp rax, [rbp - ${b}]`);
                nasmLines.push(`sete al`);
                nasmLines.push(`movzx rax, al`);
                nasmLines.push(`mov ${memRef(instr.dst)}, rax`);
                break;
            }
            case "neq": {
                const a = loadOperand(instr.a);
                const b = loadOperand(instr.b);
                nasmLines.push(`mov rax, [rbp - ${a}]`);
                nasmLines.push(`cmp rax, [rbp - ${b}]`);
                nasmLines.push(`setne al`);
                nasmLines.push(`movzx rax, al`);
                nasmLines.push(`mov ${memRef(instr.dst)}, rax`);
                break;
            }
            case "lt": {
                const a = loadOperand(instr.a);
                const b = loadOperand(instr.b);
                nasmLines.push(`mov rax, [rbp - ${a}]`);
                nasmLines.push(`cmp rax, [rbp - ${b}]`);
                nasmLines.push(instr.unsigned ? `setb al` : `setl al`);
                nasmLines.push(`movzx rax, al`);
                nasmLines.push(`mov ${memRef(instr.dst)}, rax`);
                break;
            }
            case "lte": {
                const a = loadOperand(instr.a);
                const b = loadOperand(instr.b);
                nasmLines.push(`mov rax, [rbp - ${a}]`);
                nasmLines.push(`cmp rax, [rbp - ${b}]`);
                nasmLines.push(instr.unsigned ? `setbe al` : `setle al`);
                nasmLines.push(`movzx rax, al`);
                nasmLines.push(`mov ${memRef(instr.dst)}, rax`);
                break;
            }
            case "gt": {
                const a = loadOperand(instr.a);
                const b = loadOperand(instr.b);
                nasmLines.push(`mov rax, [rbp - ${a}]`);
                nasmLines.push(`cmp rax, [rbp - ${b}]`);
                nasmLines.push(instr.unsigned ? `seta al` : `setg al`);
                nasmLines.push(`movzx rax, al`);
                nasmLines.push(`mov ${memRef(instr.dst)}, rax`);
                break;
            }
            case "gte": {
                const a = loadOperand(instr.a);
                const b = loadOperand(instr.b);
                nasmLines.push(`mov rax, [rbp - ${a}]`);
                nasmLines.push(`cmp rax, [rbp - ${b}]`);
                nasmLines.push(instr.unsigned ? `setae al` : `setge al`);
                nasmLines.push(`movzx rax, al`);
                nasmLines.push(`mov ${memRef(instr.dst)}, rax`);
                break;
            }
            case "load": {
                nasmLines.push(`mov rax, ${memRef(instr.addr)}`);
                if (instr.type === "i8") {
                    nasmLines.push(`movzx rax, byte [rax]`);
                } else {
                    nasmLines.push(`mov rax, [rax]`);
                }
                nasmLines.push(`mov ${memRef(instr.dst)}, rax`);
                break;
            }
            case "store": {
                const src = loadOperand(String(instr.src));
                nasmLines.push(`mov rax, ${memRef(instr.addr)}`);
                nasmLines.push(`mov rcx, [rbp - ${src}]`);
                nasmLines.push(`mov [rax], rcx`);
                break;
            }
            case "alloc": {
                nasmLines.push(`mov rdi, 1`);
                nasmLines.push(`mov rsi, ${instr.size}`);
                nasmLines.push(`call calloc`);
                nasmLines.push(`mov ${memRef(instr.dst)}, rax`)
                break;
            }
            case "free": {
                if (needsDeepFree(instr.type)) {
                    nasmLines.push(`mov rdi, ${memRef(instr.addr)}`)
                    nasmLines.push(`call ${freeFn(instr.type)}`)
                    break;
                }
                if(instr.fields?.length) {
                    const skip = `__free_skip_${freeSkipCount++}`
                    nasmLines.push(`cmp qword ${memRef(instr.addr)}, 0`)
                    nasmLines.push(`je ${skip}`)
                    for (const off of instr.fields) {
                        nasmLines.push(`mov rax, ${memRef(instr.addr)}`)
                        nasmLines.push(`mov rdi, [rax + ${off}]`)
                        nasmLines.push(`call free`)
                    }
                    nasmLines.push(`mov rdi, ${memRef(instr.addr)}`)
                    nasmLines.push(`call free`)
                    nasmLines.push(`${skip}:`)
                    break;
                }
                nasmLines.push(`mov rdi, ${memRef(instr.addr)}`)
                nasmLines.push(`call free`)
                break;
            }
            case "array_free_2d": {
                // an int[][] whose type wasn't recorded: free its rows, then it
                nasmLines.push(`mov rdi, ${memRef(instr.arr)}`);
                nasmLines.push(`lea rsi, [rel ${freeFn("int[]")}]`);
                nasmLines.push(`call lrt_arr_free`);
                break;
            }
            case "lea": {
                nasmLines.push(`mov rax, ${memRef(instr.base)}`);
                if (/^-?\d+$/.test(instr.offset)) {
                    nasmLines.push(`add rax, ${instr.offset}`);
                } else {
                    nasmLines.push(`mov rcx, ${memRef(instr.offset)}`);
                    nasmLines.push(`add rax, rcx`);
                }
                nasmLines.push(`mov ${memRef(instr.dst)}, rax`);
                break;
            }
            case "cast": {
                nasmLines.push(`mov rax, ${memRef(instr.src)}`);
                nasmLines.push(`mov ${memRef(instr.dst)}, rax`);
                break;
            }
            case "typeof":
            case "phi":
            case "srcmap":
                break;

            case "fconst": {
                floatVars.add(instr.dst);
                const buf = Buffer.allocUnsafe(8);
                buf.writeDoubleBE(instr.value, 0);
                const lo = buf.readUInt32BE(4);
                const hi = buf.readUInt32BE(0);
                const label = `__fconst_${floatConstCount++}`;
                floatConsts.push(`${label}: dq 0x${hi.toString(16).padStart(8,'0')}${lo.toString(16).padStart(8,'0')}`);
                nasmLines.push(`movsd xmm0, [rel ${label}]`);
                nasmLines.push(`movsd ${memRef(instr.dst)}, xmm0`);
                break;
            }
            case "itof": {
                const src = loadOperand(instr.src);
                floatVars.add(instr.dst);
                nasmLines.push(`mov rax, [rbp - ${src}]`);
                nasmLines.push(`cvtsi2sd xmm0, rax`);
                nasmLines.push(`movsd ${memRef(instr.dst)}, xmm0`);
                break;
            }
            case "ftoi": {
                nasmLines.push(`movsd xmm0, ${memRef(instr.src)}`);
                nasmLines.push(`cvttsd2si rax, xmm0`);
                nasmLines.push(`mov ${memRef(instr.dst)}, rax`);
                break;
            }
            case "fadd": case "fsub": case "fmul": case "fdiv": {
                floatVars.add(instr.dst);
                const fopMap: Record<string, string> = { fadd: "addsd", fsub: "subsd", fmul: "mulsd", fdiv: "divsd" };
                nasmLines.push(`movsd xmm0, ${memRef(instr.a)}`);
                nasmLines.push(`${fopMap[instr.op]} xmm0, ${memRef(instr.b)}`);
                nasmLines.push(`movsd ${memRef(instr.dst)}, xmm0`);
                break;
            }
            case "fneg": {
                floatVars.add(instr.dst);
                const label = `__fneg_mask_${floatConstCount++}`;
                floatConsts.push(`${label}: dq 0x8000000000000000`);
                nasmLines.push(`movsd xmm0, ${memRef(instr.src)}`);
                nasmLines.push(`movsd xmm1, [rel ${label}]`);
                nasmLines.push(`xorpd xmm0, xmm1`);
                nasmLines.push(`movsd ${memRef(instr.dst)}, xmm0`);
                break;
            }
            case "feq": case "fneq": case "flt": case "flte": case "fgt": case "fgte": {
                nasmLines.push(`movsd xmm0, ${memRef(instr.a)}`);
                nasmLines.push(`ucomisd xmm0, ${memRef(instr.b)}`);
                const setMap: Record<string, string> = {
                    feq: "sete", fneq: "setne", flt: "setb", flte: "setbe", fgt: "seta", fgte: "setae"
                };
                nasmLines.push(`${setMap[instr.op]} al`);
                nasmLines.push(`movzx rax, al`);
                nasmLines.push(`mov ${memRef(instr.dst)}, rax`);
                break;
            }
            case "asm_verbatim": {
                nasmLines.push(instr.text);
                break;
            }
            case "comment": {
                nasmLines.push(`; ${instr.text}`);
                break;
            }
            case "nop": {
                nasmLines.push(`nop`);
                break;
            }
            case "str_dup": {
                stringTemps.add(instr.dst);
                nasmLines.push(`mov rdi, ${memRef(instr.src)}`);
                nasmLines.push(`call strlen`);
                nasmLines.push(`lea rdi, [rax + 1]`);
                nasmLines.push(`call malloc`);
                nasmLines.push(`mov ${memRef(instr.dst)}, rax`);
                nasmLines.push(`mov rdi, rax`);
                nasmLines.push(`mov rsi, ${memRef(instr.src)}`);
                nasmLines.push(`call strcpy`);
                break;
            }
            case "str_concat": {
                stringTemps.add(instr.dst);
                // allocate strlen(a) + strlen(b) + 1 bytes
                const lenSlot = getSlot("__concat_len");
                nasmLines.push(`mov rdi, ${memRef(instr.a)}`);
                nasmLines.push(`call strlen`);
                nasmLines.push(`mov [rbp - ${lenSlot}], rax`);
                nasmLines.push(`mov rdi, ${memRef(instr.b)}`);
                nasmLines.push(`call strlen`);
                nasmLines.push(`add rax, [rbp - ${lenSlot}]`);
                nasmLines.push(`lea rdi, [rax + 1]`);
                nasmLines.push(`call malloc`);
                nasmLines.push(`mov ${memRef(instr.dst)}, rax`);
                nasmLines.push(`mov rdi, rax`);
                nasmLines.push(`mov rsi, ${memRef(instr.a)}`);
                nasmLines.push(`call strcpy`);
                nasmLines.push(`mov rdi, ${memRef(instr.dst)}`);
                nasmLines.push(`mov rsi, ${memRef(instr.b)}`);
                nasmLines.push(`call strcat`);
                break;
            }
            case "struct_alloc": {
                const size = instr.numFields * 8;
                nasmLines.push(`mov rdi, 1`);
                nasmLines.push(`mov rsi, ${size}`);
                nasmLines.push(`call calloc`);
                nasmLines.push(`mov ${memRef(instr.dst)}, rax`)
                break;
            }
            case "field_store": {
                nasmLines.push(`mov rax, ${memRef(instr.base)}`);
                if (/^-?\d+$/.test(instr.src)) {
                    storeImm(`[rax + ${instr.offset}]`, instr.src, "rcx");
                } else {
                    nasmLines.push(`mov rcx, ${memRef(instr.src)}`);
                    nasmLines.push(`mov [rax + ${instr.offset}], rcx`);
                }
                break;
            }
            case "field_load": {
                nasmLines.push(`mov rax, ${memRef(instr.base)}`);
                nasmLines.push(`mov rax, [rax + ${instr.offset}]`);
                nasmLines.push(`mov ${memRef(instr.dst)}, rax`);
                if (instr.is_string) stringTemps.add(instr.dst);
                if (instr.is_float) floatVars.add(instr.dst);
                break;
            }
            // maps (Typescript/runtime/lrt.c): keys and values travel as their raw 8 bytes
            case "map_new": {
                nasmLines.push(`mov rdi, ${instr.stringKeys ? 1 : 0}`);
                nasmLines.push(`call lrt_map_new`);
                nasmLines.push(`mov ${memRef(instr.dst)}, rax`);
                break;
            }
            case "map_set": {
                const val = (x: string) => /^-?\d+$/.test(x) ? x : memRef(x);
                nasmLines.push(`mov rdi, ${memRef(instr.map)}`);
                nasmLines.push(`mov rsi, ${val(instr.key)}`);
                nasmLines.push(`mov rdx, ${val(instr.src)}`);
                nasmLines.push(`call lrt_map_set`);                // returns the value it replaced (or 0)
                if (instr.valType && isHeapElem(instr.valType)) {
                    nasmLines.push(`mov rdi, rax`);
                    nasmLines.push(`call ${freeFn(instr.valType)}`);
                }
                break;
            }
            case "map_get":
            case "map_has": {
                nasmLines.push(`mov rdi, ${memRef(instr.map)}`);
                nasmLines.push(`mov rsi, ${/^-?\d+$/.test(instr.key) ? instr.key : memRef(instr.key)}`);
                nasmLines.push(`call ${instr.op === "map_get" ? "lrt_map_get" : "lrt_map_has"}`);
                nasmLines.push(`mov ${memRef(instr.dst)}, rax`);
                if (instr.op === "map_get" && instr.is_string) stringTemps.add(instr.dst);
                if (instr.op === "map_get" && instr.is_float) floatVars.add(instr.dst);
                break;
            }
            case "map_remove": {
                nasmLines.push(`mov rdi, ${memRef(instr.map)}`);
                nasmLines.push(`mov rsi, ${/^-?\d+$/.test(instr.key) ? instr.key : memRef(instr.key)}`);
                nasmLines.push(`call lrt_map_remove`);             // returns the removed value (or 0)
                if (instr.valType && isHeapElem(instr.valType)) {
                    nasmLines.push(`mov rdi, rax`);
                    nasmLines.push(`call ${freeFn(instr.valType)}`);
                }
                break;
            }
            case "map_keys":
            case "map_len": {
                nasmLines.push(`mov rdi, ${memRef(instr.map)}`);
                nasmLines.push(`call ${instr.op === "map_keys" ? "lrt_map_keys" : "lrt_map_len"}`);
                nasmLines.push(`mov ${memRef(instr.dst)}, rax`);
                break;
            }
            case "func_addr": {
                nasmLines.push(`lea rax, [rel $${instr.fn}]`);
                nasmLines.push(`mov ${memRef(instr.dst)}, rax`);
                break;
            }
            case "call_indirect": {
                // call the function whose address is in `target` (r11: rax carries the float-arg count)
                nasmLines.push(`mov r11, ${memRef(instr.target)}`);
                let xmm = 0, gp = 0;
                instr.args.forEach(arg => {
                    if (floatVars.has(arg)) nasmLines.push(`movsd xmm${xmm++}, ${memRef(arg)}`);
                    else if (/^-?\d+$/.test(arg)) nasmLines.push(`mov ${sysv[gp++]}, ${arg}`);
                    else nasmLines.push(`mov ${sysv[gp++]}, ${memRef(arg)}`);
                });
                nasmLines.push(xmm > 0 ? `mov eax, ${xmm}` : `xor eax, eax`);
                nasmLines.push(`call r11`);
                if (instr.returns_float) {
                    nasmLines.push(`movsd ${memRef(instr.dst)}, xmm0`);
                    floatVars.add(instr.dst);
                } else {
                    nasmLines.push(`mov ${memRef(instr.dst)}, rax`);
                }
                if (instr.returns_string) stringTemps.add(instr.dst);
                break;
            }
            case "vtable_call": {
                // the method's address goes in r11 (rax carries the count of float args); float
                // args go in xmm registers, the rest (starting with the receiver) in integer ones
                nasmLines.push(`mov r11, ${memRef(instr.base)}`);
                nasmLines.push(`mov r11, [r11]`);
                nasmLines.push(`mov r11, [r11 + ${instr.slot * 8}]`);
                let xmm = 0, gp = 0;
                instr.args.forEach(arg => {
                    if (floatVars.has(arg)) nasmLines.push(`movsd xmm${xmm++}, ${memRef(arg)}`);
                    else if (/^-?\d+$/.test(arg)) nasmLines.push(`mov ${sysv[gp++]}, ${arg}`);
                    else nasmLines.push(`mov ${sysv[gp++]}, ${memRef(arg)}`);
                });
                nasmLines.push(xmm > 0 ? `mov eax, ${xmm}` : `xor eax, eax`);
                nasmLines.push(`call r11`);
                if (instr.returns_float) {
                    nasmLines.push(`movsd ${memRef(instr.dst)}, xmm0`);
                    floatVars.add(instr.dst);
                } else {
                    nasmLines.push(`mov ${memRef(instr.dst)}, rax`);
                }
                if (instr.returns_string) stringTemps.add(instr.dst);
                break;
            }
            case "vtable_ptr": {
                nasmLines.push(`lea rax, [rel __vtable_${instr.structName}]`);
                nasmLines.push(`mov ${memRef(instr.dst)}, rax`);
                break;
            }
            case "vtable_entry":
                break; // handled in post-pass
        }
    }

    // every struct with a vtable frees itself through slot 0 (see the vtable_entry "__free")
    for (const s of dynamicStructs) {
        nasmLines.push(...emitFreeRoutine(s, `__freeobj_${s}`));
    }
    // free routines for the types used above (a routine may need others, so repeat until done)
    const emittedFrees = new Set<string>();
    while ([...neededFrees].some(t => !emittedFrees.has(t))) {
        for (const t of [...neededFrees]) {
            if (emittedFrees.has(t)) continue;
            emittedFrees.add(t);
            nasmLines.push(...emitFreeRoutine(t));
        }
    }

    if (usesFreeDyn) {
        // free a struct that has a vtable: jump to the free routine in its slot 0 (NULL is skipped)
        nasmLines.push(`__free_dyn:`);
        nasmLines.push(`test rdi, rdi`);
        nasmLines.push(`jz .done`);
        nasmLines.push(`mov rax, [rdi]`);
        nasmLines.push(`jmp [rax]`);
        nasmLines.push(`.done:`);
        nasmLines.push(`ret`);
    }

    if (options.kernel) {
        // a runtime error in a kernel: lrt_kernel_fail(message, length) calls kernel_panic and halts
        nasmLines.push(`__unset_fail:`);
        nasmLines.push(`and rsp, -16`);
        nasmLines.push(`mov rdi, rsi`);
        nasmLines.push(`mov rsi, rdx`);
        nasmLines.push(`call lrt_kernel_fail`);
        nasmLines.splice(nasmLines.indexOf("section .text") + 1, 0, "extern lrt_kernel_fail");
    } else {
        // a runtime error (a field never set, division by zero): rsi = message, rdx = its length.
        // Flush what the program printed, write the message to stderr and exit with status 1
        nasmLines.push(`__unset_fail:`);
        nasmLines.push(`and rsp, -16`);
        nasmLines.push(`push rdx`);
        nasmLines.push(`push rsi`);
        nasmLines.push(`xor edi, edi`);
        nasmLines.push(`call fflush`);
        nasmLines.push(`pop rsi`);
        nasmLines.push(`pop rdx`);
        nasmLines.push(`mov rdi, 2`);
        nasmLines.push(`mov rax, 1`);
        nasmLines.push(`syscall`);
        nasmLines.push(`mov edi, 1`);
        nasmLines.push(`call exit`);
    }

    // an index outside the array: the same runtime error path as the others
    nasmLines.push(`_bounds_fail:`);
    nasmLines.push(`lea rsi, [rel bounds_msg]`);
    nasmLines.push(`mov rdx, 27`);
    nasmLines.push(`jmp __unset_fail`);

    if (stringLiterals.size > 0) {
        const dataLines: string[] = [];
        for (const [value, label] of stringLiterals) {
            // emitted as byte values so quotes in the text can't end the NASM string
            const bytes = [...Buffer.from(value, "utf8")];
            dataLines.push(`${label} db ${[...bytes, 0].join(", ")}`);
        }
        const dataIdx = nasmLines.indexOf("section .data") + 1;
        nasmLines.splice(dataIdx + 4, 0, ...dataLines);
    }

    if (floatConsts.length > 0) {
        const dataIdx = nasmLines.indexOf("section .data") + 1;
        nasmLines.splice(dataIdx, 0, ...floatConsts);
    }

    const vtables = new Map<string, string[]>();
    for (const instr of instructions) {
        if (instr.op === "vtable_entry") {
            if (!vtables.has(instr.structName)) vtables.set(instr.structName, []);
            vtables.get(instr.structName)!.push(instr.implName);
        }
    }

    if (vtables.size > 0) {
        const dataIdx = nasmLines.indexOf("section .data") + 1
        const vtableLines: string[] =[]
        for (const [structName, methods] of vtables) {
            vtableLines.push(`__vtable_${structName}:`)
            methods.forEach( m => {
                vtableLines.push(`  dq $${m}`)
            })
        }
        nasmLines.splice(dataIdx, 0, ...vtableLines)
    }

    if (globalVars.size > 0) {
        nasmLines.push("");
        nasmLines.push("section .bss");
        nasmLines.push("alignb 8")
        for (const name of globalVars) {
            if (!staticGlobals.has(name)) nasmLines.push(`__g_${name}: resq 1`);
        }
        if (staticGlobals.size) {
            nasmLines.push("section .data");
            nasmLines.push("align 8");
            for (const [name, value] of staticGlobals) nasmLines.push(`__g_${name}: dq ${value}`);
        }
    }

    return nasmLines.join("\n");
}

module.exports = { emitNASM };