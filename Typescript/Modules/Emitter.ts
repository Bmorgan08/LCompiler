import { IR } from "./IR";

export function emitNASM(instructions: IR[]): string {
    const nasmLines: string[] = [
        "section .data",
        "fmt db '%d', 10, 0",
        "fmt_in db '%d', 0",
        "fmt_str db '%s', 10, 0",
        "fmt_str_in db '%255s', 0",
        "fmt_char db '%c', 0",
        "fmt_float db '%g', 10, 0",
        "bounds_msg db 'Error: index out of bounds', 10",
        "",
        "section .text", 
        "extern printf",
        "extern scanf",
        "extern malloc",
        "extern strcpy",
        "extern strcat",
        "extern strlen",
        "extern strcmp",
        "extern atoi",
        "extern sprintf",
        "extern free",
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

    // Identify global variables: instructions emitted before the first function enter.
    // Collect their names so we can store them in .bss and access them RIP-relative.
    const globalVars = new Set<string>();
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
            const mainEnterIdx = instructions.findIndex(i => i.op === "enter" && (i as any).name === "main");
            const insertAfter = mainEnterIdx >= 0 ? mainEnterIdx + 1 : 1;
            instructions.splice(insertAfter, 0, ...globalInits);
        }
    }

    let stackMap = new Map<string, number>();
    let stackOffset = 0;
    const stringLiterals = new Map<string, string>();
    const stringTemps = new Set<string>();
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

    function loadOperand(val: string): string {
        if (/^-?\d+$/.test(val)) {
            const slot = getSlot(`__lit_${val}`);
            nasmLines.push(`mov qword [rbp - ${slot}], ${val}`);
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
    }

    const sysv = ["rdi", "rsi", "rdx", "rcx", "r8", "r9"];

    for (const instr of instructions) {
        switch (instr.op) {
            
            case "array_new": {
                if (typeof instr.size === "number") {
                    nasmLines.push(`mov rdi, ${8 + instr.size * 8}`);
                } else {
                    nasmLines.push(`mov rax, ${memRef(instr.size)}`);
                    nasmLines.push(`imul rax, 8`);
                    nasmLines.push(`add rax, 8`);
                    nasmLines.push(`mov rdi, rax`);
                }
                nasmLines.push(`call malloc`);
                nasmLines.push(`mov ${memRef(instr.dst)}, rax`);
                if (typeof instr.size === "number") {
                    nasmLines.push(`mov rax, ${memRef(instr.dst)}`);
                    nasmLines.push(`mov qword [rax], ${instr.size}`);
                } else {
                    nasmLines.push(`mov rax, ${memRef(instr.dst)}`);
                    nasmLines.push(`mov rcx, ${memRef(instr.size)}`);
                    nasmLines.push(`mov [rax], rcx`);
                }
                break;
            }

            case "array_load": {
                nasmLines.push(`mov rax, ${memRef(instr.arr)}`);  // rax = ptr

                nasmLines.push(`mov rcx, [rax]`);                // rcx = length
                if (/^-?\d+$/.test(instr.index)) {
                    nasmLines.push(`cmp rcx, ${instr.index}`);
                    nasmLines.push(`jle _bounds_fail`);
                } else {
                    nasmLines.push(`mov rdx, ${memRef(instr.index)}`);
                    nasmLines.push(`cmp rdx, rcx`);
                    nasmLines.push(`jge _bounds_fail`);
                    nasmLines.push(`cmp rdx, 0`);
                    nasmLines.push(`jl _bounds_fail`);
                }

                if (/^-?\d+$/.test(instr.index)) {
                    const offset = 8 + Number(instr.index) * 8;
                    nasmLines.push(`mov rax, [rax + ${offset}]`);
                } else {
                    nasmLines.push(`mov rdx, ${memRef(instr.index)}`);
                    nasmLines.push(`imul rdx, 8`);
                    nasmLines.push(`add rdx, 8`);
                    nasmLines.push(`mov rax, [rax + rdx]`);
                }
                nasmLines.push(`mov ${memRef(instr.dst)}, rax`);
                break;
            }

            case "array_store": {
                nasmLines.push(`mov rax, ${memRef(instr.arr)}`);  // rax = ptr

                nasmLines.push(`mov rcx, [rax]`);                // rcx = length
                if (/^-?\d+$/.test(instr.index)) {
                    nasmLines.push(`cmp rcx, ${instr.index}`);
                    nasmLines.push(`jle _bounds_fail`);
                } else {
                    nasmLines.push(`mov rdx, ${memRef(instr.index)}`);
                    nasmLines.push(`cmp rdx, rcx`);
                    nasmLines.push(`jge _bounds_fail`);
                    nasmLines.push(`cmp rdx, 0`);
                    nasmLines.push(`jl _bounds_fail`);
                }

                if(/^-?\d+$/.test(instr.src)) {
                    nasmLines.push(`mov r10, ${instr.src}`)
                } else {
                    nasmLines.push(`mov r10, ${memRef(instr.src)}`)
                }

                if (/^-?\d+$/.test(instr.index)) {
                    const offset = 8 + Number(instr.index) * 8;
                    nasmLines.push(`mov [rax + ${offset}], r10`)
                } else {
                    nasmLines.push(`mov rdx, ${memRef(instr.index)}`);
                    nasmLines.push(`imul rdx, 8`);
                    nasmLines.push(`add rdx, 8`);
                    nasmLines.push(`mov [rax + rdx], r10`);
                }
                break;
            }

            case "array_len": {
                nasmLines.push(`mov rax, ${memRef(instr.arr)}`);  // rax = ptr
                nasmLines.push(`mov rax, [rax]`);                  // rax = length
                nasmLines.push(`mov ${memRef(instr.dst)}, rax`);
                break;
            }

            case "enter": {
                resetFrame();
                nasmLines.push(`global ${instr.name}`);
                nasmLines.push(`${instr.name}:`);
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
                    nasmLines.push(`movsd ${memRef(instr.dst)}, xmm${instr.index}`);
                } else {
                    nasmLines.push(`mov qword ${memRef(instr.dst)}, ${sysv[instr.index]}`);
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
                    nasmLines.push(`mov qword ${memRef(instr.dst)}, ${instr.value}`);
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
                    nasmLines.push(`mov qword ${memRef(instr.dst)}, ${instr.src}`);
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
                } else if (instr.fn === "inputstr") {
                    nasmLines.push(`mov rdi, 256`);
                    nasmLines.push(`call malloc`);
                    nasmLines.push(`mov ${memRef(instr.dst!)}, rax`);
                    nasmLines.push(`mov rsi, rax`);
                    nasmLines.push(`lea rdi, [rel fmt_str_in]`);
                    nasmLines.push(`xor eax, eax`);
                    nasmLines.push(`call scanf`);
                    stringTemps.add(instr.dst!);
                } else if (instr.fn === "len") {
                    nasmLines.push(`mov rdi, ${memRef(instr.args[0])}`);
                    nasmLines.push(`call strlen`);
                    nasmLines.push(`mov ${memRef(instr.dst!)}, rax`);
                } else if (instr.fn === "printchar") {
                    nasmLines.push(`mov rsi, ${memRef(instr.args[0])}`);
                    nasmLines.push(`lea rdi, [rel fmt_char]`);
                    nasmLines.push(`xor eax, eax`);
                    nasmLines.push(`call printf`);
                } else if (instr.fn === "strtoint") {
                    nasmLines.push(`mov rdi, ${memRef(instr.args[0])}`);
                    nasmLines.push(`call atoi`);
                    nasmLines.push(`mov ${memRef(instr.dst!)}, rax`);
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
                    nasmLines.push(`call ${instr.fn}`);
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
            case "div": {
                const a = loadOperand(instr.a);
                const b = loadOperand(instr.b);
                nasmLines.push(`mov rax, [rbp - ${a}]`);
                nasmLines.push(`cqo`);
                nasmLines.push(`idiv qword [rbp - ${b}]`);
                nasmLines.push(`mov ${memRef(instr.dst)}, rax`);
                break;
            }
            case "mod": {
                const a = loadOperand(instr.a);
                const b = loadOperand(instr.b);
                nasmLines.push(`mov rax, [rbp - ${a}]`);
                nasmLines.push(`cqo`);
                nasmLines.push(`idiv qword [rbp - ${b}]`);
                nasmLines.push(`mov ${memRef(instr.dst)}, rdx`);
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
                nasmLines.push(`setl al`);
                nasmLines.push(`movzx rax, al`);
                nasmLines.push(`mov ${memRef(instr.dst)}, rax`);
                break;
            }
            case "lte": {
                const a = loadOperand(instr.a);
                const b = loadOperand(instr.b);
                nasmLines.push(`mov rax, [rbp - ${a}]`);
                nasmLines.push(`cmp rax, [rbp - ${b}]`);
                nasmLines.push(`setle al`);
                nasmLines.push(`movzx rax, al`);
                nasmLines.push(`mov ${memRef(instr.dst)}, rax`);
                break;
            }
            case "gt": {
                const a = loadOperand(instr.a);
                const b = loadOperand(instr.b);
                nasmLines.push(`mov rax, [rbp - ${a}]`);
                nasmLines.push(`cmp rax, [rbp - ${b}]`);
                nasmLines.push(`setg al`);
                nasmLines.push(`movzx rax, al`);
                nasmLines.push(`mov ${memRef(instr.dst)}, rax`);
                break;
            }
            case "gte": {
                const a = loadOperand(instr.a);
                const b = loadOperand(instr.b);
                nasmLines.push(`mov rax, [rbp - ${a}]`);
                nasmLines.push(`cmp rax, [rbp - ${b}]`);
                nasmLines.push(`setge al`);
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
                nasmLines.push(`mov rdi, ${instr.size}`);
                nasmLines.push(`call malloc`);
                nasmLines.push(`mov ${memRef(instr.dst)}, rax`);
                break;
            }
            case "free": {
                nasmLines.push(`mov rdi, ${memRef(instr.addr)}`);
                nasmLines.push(`call free`);
                break;
            }
            case "array_free_2d": {
                const idxSlot = getSlot(`__free2d_idx_${instr.arr}`);
                const loopLabel = `__free2d_loop_${instr.arr}_${stackOffset}`;
                const endLabel  = `__free2d_end_${instr.arr}_${stackOffset}`;
                nasmLines.push(`mov qword [rbp - ${idxSlot}], 0`);
                nasmLines.push(`${loopLabel}:`);
                const rowsVal = instr.rows;
                if (typeof rowsVal === "number" || /^-?\d+$/.test(String(rowsVal))) {
                    nasmLines.push(`cmp qword [rbp - ${idxSlot}], ${rowsVal}`);
                } else {
                    nasmLines.push(`mov rax, ${memRef(String(rowsVal))}`);
                    nasmLines.push(`cmp qword [rbp - ${idxSlot}], rax`);
                }
                nasmLines.push(`jge ${endLabel}`);
                nasmLines.push(`mov rax, ${memRef(instr.arr)}`);
                nasmLines.push(`mov rcx, [rbp - ${idxSlot}]`);
                nasmLines.push(`imul rcx, 8`);
                nasmLines.push(`add rcx, 8`);
                nasmLines.push(`mov rdi, [rax + rcx]`);
                nasmLines.push(`call free`);
                nasmLines.push(`add qword [rbp - ${idxSlot}], 1`);
                nasmLines.push(`jmp ${loopLabel}`);
                nasmLines.push(`${endLabel}:`);
                nasmLines.push(`mov rdi, ${memRef(instr.arr)}`);
                nasmLines.push(`call free`);
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
            case "str_concat": {
                stringTemps.add(instr.dst);
                nasmLines.push(`mov rdi, 256`);
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
                nasmLines.push(`mov rdi, ${size}`);
                nasmLines.push(`call malloc`);
                nasmLines.push(`mov ${memRef(instr.dst)}, rax`);
                break;
            }
            case "field_store": {
                nasmLines.push(`mov rax, ${memRef(instr.base)}`);
                if (/^-?\d+$/.test(instr.src)) {
                    nasmLines.push(`mov qword [rax + ${instr.offset}], ${instr.src}`);
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
                break;
            }
            case "vtable_call": {
                nasmLines.push(`mov rax, ${memRef(instr.base)}`);
                nasmLines.push(`mov rax, [rax]`);
                nasmLines.push(`mov rax, [rax + ${instr.slot * 8}]`);
                instr.args.forEach((arg, i) => {
                    if (/^-?\d+$/.test(arg)) {
                        nasmLines.push(`mov ${sysv[i]}, ${arg}`);
                    } else {
                        nasmLines.push(`mov ${sysv[i]}, ${memRef(arg)}`);
                    }
                });
                nasmLines.push(`call rax`);
                nasmLines.push(`mov ${memRef(instr.dst)}, rax`);
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

    nasmLines.push(`_bounds_fail:`);
    nasmLines.push(`mov rdi, 1`);
    nasmLines.push(`mov rsi, bounds_msg`);
    nasmLines.push(`mov rdx, 27`);
    nasmLines.push(`mov rax, 1`);
    nasmLines.push(`syscall`);
    nasmLines.push(`mov rdi, 1`);
    nasmLines.push(`mov rax, 60`);
    nasmLines.push(`syscall`);  

    if (stringLiterals.size > 0) {
        const dataLines: string[] = [];
        for (const [value, label] of stringLiterals) {
            dataLines.push(`${label} db '${value}', 0`);
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
                vtableLines.push(`  dq ${m}`)
            })
        }
        nasmLines.splice(dataIdx, 0, ...vtableLines)
    }

    if (globalVars.size > 0) {
        nasmLines.push("");
        nasmLines.push("section .bss");
        for (const name of globalVars) {
            nasmLines.push(`__g_${name}: resq 1`);
        }
    }

    return nasmLines.join("\n");
}

module.exports = { emitNASM };