import { IR } from "./IR";

export function emitNASM(instructions: IR[]): string {
    const nasmLines: string[] = [
        "section .data",
        "fmt db '%d', 10, 0",  // for printf
        "fmt_in db '%d', 0",   // for scanf
        "fmt_str db '%s', 10, 0", // for printing strings
        "fmt_str_in db '%255s', 0", // for reading strings
        "fmt_char db '%c', 0",
        "fmt_float db '%g', 10, 0", // for printing floats
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
        ""];
    let stackMap = new Map<string, number>();
    let stackOffset = 0;
    const stringLiterals = new Map<string, string>();
    const stringTemps = new Set<string>();
    let stringCount = 0;
    const floatVars = new Set<string>();
    const floatConsts: string[] = [];
    let floatConstCount = 0;

    // Pre-pass: compute the frame size needed for each function
    const frameSizes = new Map<string, number>();
    {
        let fnName = "";
        let slots = new Map<string, number>();
        let off = 0;
        function simSlot(name: string) {
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
            // literal temps
            if (i.dst && /^-?\d+$/.test(i.dst)) simSlot(`__lit_${i.dst}`);
            if (i.value && typeof i.value === "number") simSlot(`__lit_${i.value}`);
        }
        for (const instr of instructions) {
            if (instr.op === "enter") {
                fnName = instr.name; slots = new Map(); off = 0;
            } else if (instr.op === "leave") {
                // round up to 16-byte alignment, minimum 32
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
            // it's a literal number, load it directly
            nasmLines.push(`mov rax, ${v}`);
            // store to a temp slot so the rest of the emitter can use it
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

    function loadOperand(val: string): string {
        if (/^-?\d+$/.test(val)) {
            // literal — move immediate into rax and store to a temp slot
            const slot = getSlot(`__lit_${val}`);
            nasmLines.push(`mov qword [rbp - ${slot}], ${val}`);
            return slot.toString();
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
                const dst = getSlot(instr.dst);
                // allocate 8 bytes for length + size * 8 for elements
                if (typeof instr.size === "number") {
                    nasmLines.push(`mov rdi, ${8 + instr.size * 8}`);
                } else {
                    const sizeSlot = getSlot(instr.size);
                    nasmLines.push(`mov rax, [rbp - ${sizeSlot}]`);
                    nasmLines.push(`imul rax, 8`);
                    nasmLines.push(`add rax, 8`);
                    nasmLines.push(`mov rdi, rax`);
                }
                nasmLines.push(`call malloc`);
                nasmLines.push(`mov [rbp - ${dst}], rax`);
                // store length at [ptr]
                if (typeof instr.size === "number") {
                    nasmLines.push(`mov rax, [rbp - ${dst}]`);
                    nasmLines.push(`mov qword [rax], ${instr.size}`);
                } else {
                    const sizeSlot = getSlot(instr.size);
                    nasmLines.push(`mov rax, [rbp - ${dst}]`);
                    nasmLines.push(`mov rcx, [rbp - ${sizeSlot}]`);
                    nasmLines.push(`mov [rax], rcx`);
                }
                break;
            }

            case "array_load": {
                const arrSlot = getSlot(instr.arr);
                const dst = getSlot(instr.dst);
                nasmLines.push(`mov rax, [rbp - ${arrSlot}]`);  // rax = ptr

                // bounds check
                nasmLines.push(`mov rcx, [rax]`);                // rcx = length
                if (/^-?\d+$/.test(instr.index)) {
                    nasmLines.push(`cmp rcx, ${instr.index}`);
                    nasmLines.push(`jle _bounds_fail`);
                } else {
                    const idxSlot = getSlot(instr.index);
                    nasmLines.push(`mov rdx, [rbp - ${idxSlot}]`);
                    nasmLines.push(`cmp rdx, rcx`);
                    nasmLines.push(`jge _bounds_fail`);
                    nasmLines.push(`cmp rdx, 0`);
                    nasmLines.push(`jl _bounds_fail`);
                }

                // load element at ptr + 8 + index * 8
                if (/^-?\d+$/.test(instr.index)) {
                    const offset = 8 + Number(instr.index) * 8;
                    nasmLines.push(`mov rax, [rax + ${offset}]`);
                } else {
                    const idxSlot = getSlot(instr.index);
                    nasmLines.push(`mov rdx, [rbp - ${idxSlot}]`);
                    nasmLines.push(`imul rdx, 8`);
                    nasmLines.push(`add rdx, 8`);
                    nasmLines.push(`mov rax, [rax + rdx]`);
                }
                nasmLines.push(`mov [rbp - ${dst}], rax`);
                break;
            }

            case "array_store": {
                const arrSlot = getSlot(instr.arr);
                nasmLines.push(`mov rax, [rbp - ${arrSlot}]`);  // rax = ptr

                // bounds check
                nasmLines.push(`mov rcx, [rax]`);                // rcx = length
                if (/^-?\d+$/.test(instr.index)) {
                    nasmLines.push(`cmp rcx, ${instr.index}`);
                    nasmLines.push(`jle _bounds_fail`);
                } else {
                    const idxSlot = getSlot(instr.index);
                    nasmLines.push(`mov rdx, [rbp - ${idxSlot}]`);
                    nasmLines.push(`cmp rdx, rcx`);
                    nasmLines.push(`jge _bounds_fail`);
                    nasmLines.push(`cmp rdx, 0`);
                    nasmLines.push(`jl _bounds_fail`);
                }

                if(/^-?\d+$/.test(instr.src)) {
                    nasmLines.push(`mov r10, ${instr.src}`)
                } else {
                    const srcSlot = getSlot(instr.src)
                    nasmLines.push(`mov r10, [rbp - ${srcSlot}]`)
                }

                if (/^-?\d+$/.test(instr.index)) {
                    const offset = 8 + Number(instr.index) * 8;
                    nasmLines.push(`mov [rax + ${offset}], r10`)
                } else {
                    const idxSlot = getSlot(instr.index);
                    nasmLines.push(`mov rdx, [rbp - ${idxSlot}]`);
                    nasmLines.push(`imul rdx, 8`);
                    nasmLines.push(`add rdx, 8`);
                    nasmLines.push(`mov [rax + rdx], r10`);
                }
                break;
            }

            case "array_len": {
                const arrSlot = getSlot(instr.arr);
                const dst = getSlot(instr.dst);
                nasmLines.push(`mov rax, [rbp - ${arrSlot}]`);  // rax = ptr
                nasmLines.push(`mov rax, [rax]`);                // rax = length
                nasmLines.push(`mov [rbp - ${dst}], rax`);
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
                const a = getSlot(instr.a);
                const b = getSlot(instr.b);
                const dst = getSlot(instr.dst);
                nasmLines.push(`mov rdi, [rbp - ${a}]`);
                nasmLines.push(`mov rsi, [rbp - ${b}]`);
                nasmLines.push(`call strcmp`);
                nasmLines.push(`test rax, rax`);
                nasmLines.push(`sete al`);
                nasmLines.push(`movzx rax, al`);
                nasmLines.push(`mov [rbp - ${dst}], rax`);
                break;
            }
            case "str_neq": {
                const a = getSlot(instr.a);
                const b = getSlot(instr.b);
                const dst = getSlot(instr.dst);
                nasmLines.push(`mov rdi, [rbp - ${a}]`);
                nasmLines.push(`mov rsi, [rbp - ${b}]`);
                nasmLines.push(`call strcmp`);
                nasmLines.push(`test rax, rax`);
                nasmLines.push(`setne al`);
                nasmLines.push(`movzx rax, al`);
                nasmLines.push(`mov [rbp - ${dst}], rax`);
                break;
            }
            case "arg": {
                const slot = getSlot(instr.dst);
                if (instr.isFloat) {
                    const xmmReg = `xmm${instr.index}`;
                    floatVars.add(instr.dst);
                    nasmLines.push(`movsd [rbp - ${slot}], ${xmmReg}`);
                } else {
                    const reg = sysv[instr.index];
                    nasmLines.push(`mov qword [rbp - ${slot}], ${reg}`);
                }
                break;
            }
            case "const": {
                const slot = getSlot(instr.dst);
                if (typeof instr.value === "string") {
                    const label = getStringLabel(instr.value);
                    nasmLines.push(`lea rax, [rel ${label}]`);
                    nasmLines.push(`mov [rbp - ${slot}], rax`);
                    stringTemps.add(instr.dst);
                } else {
                    nasmLines.push(`mov qword [rbp - ${slot}], ${instr.value}`);
                }
                break;
            }
            case "mov": {
                const dst = getSlot(instr.dst);
                if (stringTemps.has(instr.src)) {
                    stringTemps.add(instr.dst);
                }
                if (floatVars.has(instr.src)) {
                    floatVars.add(instr.dst);
                }
                if (/^-?\d+$/.test(instr.src)) {
                    nasmLines.push(`mov qword [rbp - ${dst}], ${instr.src}`);
                } else {
                    const src = getSlot(instr.src);
                    nasmLines.push(`mov rax, [rbp - ${src}]`);
                    nasmLines.push(`mov [rbp - ${dst}], rax`);
                }
                break;
            }
            case "ret": {
                if (instr.value !== undefined) {
                    if (/^-?\d+$/.test(instr.value)) {
                        nasmLines.push(`mov rax, ${instr.value}`);
                    } else {
                        const slot = getSlot(instr.value);
                        if (floatVars.has(instr.value)) {
                            nasmLines.push(`movsd xmm0, [rbp - ${slot}]`);
                        } else {
                            nasmLines.push(`mov rax, [rbp - ${slot}]`);
                        }
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
                        nasmLines.push(`mov eax, 1`);  // 1 float arg in xmm
                        nasmLines.push(`call printf`);
                    } else {
                        nasmLines.push(`mov rsi, [rbp - ${slot}]`);
                        nasmLines.push(`lea rdi, [rel ${isString ? "fmt_str" : "fmt"}]`);
                        nasmLines.push(`xor eax, eax`);
                        nasmLines.push(`call printf`);
                    }
                } else if (instr.fn === "input") {
                    const dst = getSlot(instr.dst!);
                    nasmLines.push(`lea rsi, [rbp - ${dst}]`);  // buffer for input
                    nasmLines.push(`lea rdi, [rel fmt_in]`);         // format string
                    nasmLines.push(`xor eax, eax`);               // no float args
                    nasmLines.push(`call scanf`);
                } else if (instr.fn === "inputstr") {
                    const dst = getSlot(instr.dst!);
                    nasmLines.push(`mov rdi, 256`);  // buffer for input
                    nasmLines.push(`call malloc`);
                    nasmLines.push(`mov [rbp - ${dst}], rax`); // store pointer to buffer
                    nasmLines.push(`mov rsi, rax`);
                    nasmLines.push(`lea rdi, [rel fmt_str_in]`);         // format string
                    nasmLines.push(`xor eax, eax`);               // no float args
                    nasmLines.push(`call scanf`);
                    stringTemps.add(instr.dst!);
                } else if (instr.fn === "len") {
                    const arg = getSlot(instr.args[0]);
                    const dst = getSlot(instr.dst!);
                    nasmLines.push(`mov rdi, [rbp - ${arg}]`);
                    nasmLines.push(`call strlen`);
                    nasmLines.push(`mov [rbp - ${dst}], rax`);
                } else if (instr.fn === "printchar") {
                    const arg = getSlot(instr.args[0]);
                    nasmLines.push(`mov rsi, [rbp - ${arg}]`);  // value to print
                    nasmLines.push(`lea rdi, [rel fmt_char]`);         // format string
                    nasmLines.push(`xor eax, eax`);               // no float args
                    nasmLines.push(`call printf`);
                } else if (instr.fn === "strtoint") {
                    const arg = getSlot(instr.args[0]);
                    const dst = getSlot(instr.dst!);
                    nasmLines.push(`mov rdi, [rbp - ${arg}]`);
                    nasmLines.push(`call atoi`);
                    nasmLines.push(`mov [rbp - ${dst}], rax`);
                } else if (instr.fn === "inttostr") {
                    const arg = loadOperand(instr.args[0]);
                    const dst = getSlot(instr.dst!);
                    nasmLines.push(`mov rdi, 32`); // max buffer size for int to string conversion
                    nasmLines.push(`call malloc`);
                    nasmLines.push(`mov [rbp - ${dst}], rax`); // store pointer to buffer
                    nasmLines.push(`mov rdi, rax`); // buffer ptr
                    nasmLines.push(`lea rsi, [rel fmt_in]`); // format string
                    nasmLines.push(`mov rdx, [rbp - ${arg}]`); // integer value
                    nasmLines.push(`xor eax, eax`); // no float args
                    nasmLines.push(`call sprintf`);
                    stringTemps.add(instr.dst!);
                } else {
                    let xmmIdx = 0;
                    let intIdx = 0;
                    instr.args.forEach((arg) => {
                        if (floatVars.has(arg)) {
                            const slot = getSlot(arg);
                            nasmLines.push(`movsd xmm${xmmIdx++}, [rbp - ${slot}]`);
                        } else if (/^-?\d+$/.test(arg)) {
                            nasmLines.push(`mov ${sysv[intIdx++]}, ${arg}`);
                        } else {
                            const slot = getSlot(arg);
                            nasmLines.push(`mov ${sysv[intIdx++]}, [rbp - ${slot}]`);
                        }
                    });
                    if (xmmIdx > 0) nasmLines.push(`mov eax, ${xmmIdx}`);
                    else nasmLines.push(`xor eax, eax`);
                    nasmLines.push(`call ${instr.fn}`);
                    if (instr.dst) {
                        const dst = getSlot(instr.dst);
                        if (instr.returns_float) {
                            nasmLines.push(`movsd [rbp - ${dst}], xmm0`);
                            floatVars.add(instr.dst);
                        } else {
                            nasmLines.push(`mov [rbp - ${dst}], rax`);
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
                const dst = getSlot(instr.dst);
                nasmLines.push(`mov rax, [rbp - ${a}]`);
                nasmLines.push(`add rax, [rbp - ${b}]`);
                nasmLines.push(`mov [rbp - ${dst}], rax`);
                break;
            }
            case "sub": {
                const a = loadOperand(instr.a);
                const b = loadOperand(instr.b);
                const dst = getSlot(instr.dst);
                nasmLines.push(`mov rax, [rbp - ${a}]`);
                nasmLines.push(`sub rax, [rbp - ${b}]`);
                nasmLines.push(`mov [rbp - ${dst}], rax`);
                break;
            }
            case "mul": {
                const a = loadOperand(instr.a);
                const b = loadOperand(instr.b);
                const dst = getSlot(instr.dst);
                nasmLines.push(`mov rax, [rbp - ${a}]`);
                nasmLines.push(`imul rax, [rbp - ${b}]`);
                nasmLines.push(`mov [rbp - ${dst}], rax`);
                break;
            }
            case "string_const": {
                stringTemps.add(instr.dst);
                const label = getStringLabel(instr.value);
                const dst = getSlot(instr.dst);
                nasmLines.push(`lea rax, [rel ${label}]`);
                nasmLines.push(`mov [rbp - ${dst}], rax`);
                break;
            }
            case "div": {
                const a = loadOperand(instr.a);
                const b = loadOperand(instr.b);
                const dst = getSlot(instr.dst);
                nasmLines.push(`mov rax, [rbp - ${a}]`);
                nasmLines.push(`cqo`);
                nasmLines.push(`idiv qword [rbp - ${b}]`);
                nasmLines.push(`mov [rbp - ${dst}], rax`);
                break;
            }
            case "mod": {
                const a = loadOperand(instr.a);
                const b = loadOperand(instr.b);
                const dst = getSlot(instr.dst);
                nasmLines.push(`mov rax, [rbp - ${a}]`);
                nasmLines.push(`cqo`);
                nasmLines.push(`idiv qword [rbp - ${b}]`);
                nasmLines.push(`mov [rbp - ${dst}], rdx`);
                break;
            }
            case "and": {
                const a = loadOperand(instr.a);
                const b = loadOperand(instr.b);
                const dst = getSlot(instr.dst);
                nasmLines.push(`mov rax, [rbp - ${a}]`);
                nasmLines.push(`and rax, [rbp - ${b}]`);
                nasmLines.push(`mov [rbp - ${dst}], rax`);
                break;
            }
            case "or": {
                const a = loadOperand(instr.a);
                const b = loadOperand(instr.b);
                const dst = getSlot(instr.dst);
                nasmLines.push(`mov rax, [rbp - ${a}]`);
                nasmLines.push(`or rax, [rbp - ${b}]`);
                nasmLines.push(`mov [rbp - ${dst}], rax`);
                break;
            }
            case "xor": {
                const a = loadOperand(instr.a);
                const b = loadOperand(instr.b);
                const dst = getSlot(instr.dst);
                nasmLines.push(`mov rax, [rbp - ${a}]`);
                nasmLines.push(`xor rax, [rbp - ${b}]`);
                nasmLines.push(`mov [rbp - ${dst}], rax`);
                break;
            }
            case "shl": {
                const a = loadOperand(instr.a);
                const b = loadOperand(instr.b);
                const dst = getSlot(instr.dst);
                nasmLines.push(`mov rax, [rbp - ${a}]`);
                nasmLines.push(`mov rcx, [rbp - ${b}]`);
                nasmLines.push(`shl rax, cl`);
                nasmLines.push(`mov [rbp - ${dst}], rax`);
                break;
            }
            case "shr": {
                const a = loadOperand(instr.a);
                const b = loadOperand(instr.b);
                const dst = getSlot(instr.dst);
                nasmLines.push(`mov rax, [rbp - ${a}]`);
                nasmLines.push(`mov rcx, [rbp - ${b}]`);
                nasmLines.push(`shr rax, cl`);
                nasmLines.push(`mov [rbp - ${dst}], rax`);
                break;
            }
            case "not": {
                const src = loadOperand(instr.src);
                const dst = getSlot(instr.dst);
                nasmLines.push(`mov rax, [rbp - ${src}]`);
                nasmLines.push(`test rax, rax`);
                nasmLines.push(`sete al`);
                nasmLines.push(`movzx rax, al`);
                nasmLines.push(`mov [rbp - ${dst}], rax`);
                break;
            }
            case "neg": {
                const src = loadOperand(instr.src);
                const dst = getSlot(instr.dst);
                nasmLines.push(`mov rax, [rbp - ${src}]`);
                nasmLines.push(`neg rax`);
                nasmLines.push(`mov [rbp - ${dst}], rax`);
                break;
            }
            case "abs": {
                const src = loadOperand(instr.src);
                const dst = getSlot(instr.dst);
                nasmLines.push(`mov rax, [rbp - ${src}]`);
                nasmLines.push(`mov rcx, rax`);
                nasmLines.push(`neg rax`);
                nasmLines.push(`cmovl rax, rcx`);
                nasmLines.push(`mov [rbp - ${dst}], rax`);
                break;
            }
            case "eq": {
                const a = loadOperand(instr.a);
                const b = loadOperand(instr.b);
                const dst = getSlot(instr.dst);
                nasmLines.push(`mov rax, [rbp - ${a}]`);
                nasmLines.push(`cmp rax, [rbp - ${b}]`);
                nasmLines.push(`sete al`);
                nasmLines.push(`movzx rax, al`);
                nasmLines.push(`mov [rbp - ${dst}], rax`);
                break;
            }
            case "neq": {
                const a = loadOperand(instr.a);
                const b = loadOperand(instr.b);
                const dst = getSlot(instr.dst);
                nasmLines.push(`mov rax, [rbp - ${a}]`);
                nasmLines.push(`cmp rax, [rbp - ${b}]`);
                nasmLines.push(`setne al`);
                nasmLines.push(`movzx rax, al`);
                nasmLines.push(`mov [rbp - ${dst}], rax`);
                break;
            }
            case "lt": {
                const a = loadOperand(instr.a);
                const b = loadOperand(instr.b);
                const dst = getSlot(instr.dst);
                nasmLines.push(`mov rax, [rbp - ${a}]`);
                nasmLines.push(`cmp rax, [rbp - ${b}]`);
                nasmLines.push(`setl al`);
                nasmLines.push(`movzx rax, al`);
                nasmLines.push(`mov [rbp - ${dst}], rax`);
                break;
            }
            case "lte": {
                const a = loadOperand(instr.a);
                const b = loadOperand(instr.b);
                const dst = getSlot(instr.dst);
                nasmLines.push(`mov rax, [rbp - ${a}]`);
                nasmLines.push(`cmp rax, [rbp - ${b}]`);
                nasmLines.push(`setle al`);
                nasmLines.push(`movzx rax, al`);
                nasmLines.push(`mov [rbp - ${dst}], rax`);
                break;
            }
            case "gt": {
                const a = loadOperand(instr.a);
                const b = loadOperand(instr.b);
                const dst = getSlot(instr.dst);
                nasmLines.push(`mov rax, [rbp - ${a}]`);
                nasmLines.push(`cmp rax, [rbp - ${b}]`);
                nasmLines.push(`setg al`);
                nasmLines.push(`movzx rax, al`);
                nasmLines.push(`mov [rbp - ${dst}], rax`);
                break;
            }
            case "gte": {
                const a = loadOperand(instr.a);
                const b = loadOperand(instr.b);
                const dst = getSlot(instr.dst);
                nasmLines.push(`mov rax, [rbp - ${a}]`);
                nasmLines.push(`cmp rax, [rbp - ${b}]`);
                nasmLines.push(`setge al`);
                nasmLines.push(`movzx rax, al`);
                nasmLines.push(`mov [rbp - ${dst}], rax`);
                break;
            }
            case "load": {
                const addr = getSlot(instr.addr);
                const dst = getSlot(instr.dst);
                nasmLines.push(`mov rax, [rbp - ${addr}]`);
                if (instr.type === "i8") {
                    nasmLines.push(`movzx rax, byte [rax]`);  // load a byte and zero-extend for int
                } else {
                    nasmLines.push(`mov rax, [rax]`);  // load a pointer
                }
                nasmLines.push(`mov [rbp - ${dst}], rax`);
                
                break;
            }
            case "store": {
                const addr = getSlot(instr.addr);
                const src = loadOperand(String(instr.src));
                nasmLines.push(`mov rax, [rbp - ${addr}]`);
                nasmLines.push(`mov rcx, [rbp - ${src}]`);
                nasmLines.push(`mov [rax], rcx`);
                break;
            }
            case "alloc": {
                const dst = getSlot(instr.dst);
                nasmLines.push(`mov rdi, ${instr.size}`);
                nasmLines.push(`call malloc`);
                nasmLines.push(`mov [rbp - ${dst}], rax`);
                break;
            }
            case "free": {
                const addr = getSlot(instr.addr);
                nasmLines.push(`mov rdi, [rbp - ${addr}]`);
                nasmLines.push(`call free`);
                break;
            }
            case "array_free_2d": {
                // Free each inner row, then free the outer array.
                // Inline loop: i = 0; while (i < rows) { free(arr[i]); i++; }; free(arr);
                const arrSlot = getSlot(instr.arr);
                const idxSlot = getSlot(`__free2d_idx_${instr.arr}`);
                const loopLabel = `__free2d_loop_${instr.arr}_${stackOffset}`;
                const endLabel  = `__free2d_end_${instr.arr}_${stackOffset}`;
                nasmLines.push(`mov qword [rbp - ${idxSlot}], 0`);
                nasmLines.push(`${loopLabel}:`);
                const rowsVal = instr.rows;
                if (typeof rowsVal === "number" || /^-?\d+$/.test(String(rowsVal))) {
                    nasmLines.push(`cmp qword [rbp - ${idxSlot}], ${rowsVal}`);
                } else {
                    const rowsSlot = getSlot(String(rowsVal));
                    nasmLines.push(`mov rax, [rbp - ${rowsSlot}]`);
                    nasmLines.push(`cmp qword [rbp - ${idxSlot}], rax`);
                }
                nasmLines.push(`jge ${endLabel}`);
                // load arr ptr, then load arr[i] (offset 8 + i*8)
                nasmLines.push(`mov rax, [rbp - ${arrSlot}]`);
                nasmLines.push(`mov rcx, [rbp - ${idxSlot}]`);
                nasmLines.push(`imul rcx, 8`);
                nasmLines.push(`add rcx, 8`);
                nasmLines.push(`mov rdi, [rax + rcx]`);
                nasmLines.push(`call free`);
                nasmLines.push(`add qword [rbp - ${idxSlot}], 1`);
                nasmLines.push(`jmp ${loopLabel}`);
                nasmLines.push(`${endLabel}:`);
                // free the outer array
                nasmLines.push(`mov rdi, [rbp - ${arrSlot}]`);
                nasmLines.push(`call free`);
                break;
            }
            case "lea": {
                const base = getSlot(instr.base);
                const dst = getSlot(instr.dst);
                nasmLines.push(`mov rax, [rbp - ${base}]`);
                if (/^-?\d+$/.test(instr.offset)) {
                    nasmLines.push(`add rax, ${instr.offset}`);
                } else {
                    const offset = getSlot(instr.offset);
                    nasmLines.push(`mov rcx, [rbp - ${offset}]`);
                    nasmLines.push(`add rax, rcx`);
                }
                nasmLines.push(`mov [rbp - ${dst}], rax`);
                break;
            }
            case "cast": {
                const src = getSlot(instr.src);
                const dst = getSlot(instr.dst);
                nasmLines.push(`mov rax, [rbp - ${src}]`);
                nasmLines.push(`mov [rbp - ${dst}], rax`);
                break;
            }
            case "typeof":
            case "phi":
            case "srcmap":
                break;

            case "fconst": {
                // store float as 64-bit IEEE754 double in stack slot
                const dst = getSlot(instr.dst);
                floatVars.add(instr.dst);
                // Use a temporary data label trick: encode via movsd from memory
                const buf = Buffer.allocUnsafe(8);
                buf.writeDoubleBE(instr.value, 0);
                const lo = buf.readUInt32BE(4);
                const hi = buf.readUInt32BE(0);
                const label = `__fconst_${floatConstCount++}`;
                floatConsts.push(`${label}: dq 0x${hi.toString(16).padStart(8,'0')}${lo.toString(16).padStart(8,'0')}`);
                nasmLines.push(`movsd xmm0, [rel ${label}]`);
                nasmLines.push(`movsd [rbp - ${dst}], xmm0`);
                break;
            }
            case "itof": {
                const src = loadOperand(instr.src);
                const dst = getSlot(instr.dst);
                floatVars.add(instr.dst);
                nasmLines.push(`mov rax, [rbp - ${src}]`);
                nasmLines.push(`cvtsi2sd xmm0, rax`);
                nasmLines.push(`movsd [rbp - ${dst}], xmm0`);
                break;
            }
            case "ftoi": {
                const src = getSlot(instr.src);
                const dst = getSlot(instr.dst);
                nasmLines.push(`movsd xmm0, [rbp - ${src}]`);
                nasmLines.push(`cvttsd2si rax, xmm0`);
                nasmLines.push(`mov [rbp - ${dst}], rax`);
                break;
            }
            case "fadd": case "fsub": case "fmul": case "fdiv": {
                const a = getSlot(instr.a);
                const b = getSlot(instr.b);
                const dst = getSlot(instr.dst);
                floatVars.add(instr.dst);
                const fopMap: Record<string, string> = { fadd: "addsd", fsub: "subsd", fmul: "mulsd", fdiv: "divsd" };
                nasmLines.push(`movsd xmm0, [rbp - ${a}]`);
                nasmLines.push(`${fopMap[instr.op]} xmm0, [rbp - ${b}]`);
                nasmLines.push(`movsd [rbp - ${dst}], xmm0`);
                break;
            }
            case "fneg": {
                const src = getSlot(instr.src);
                const dst = getSlot(instr.dst);
                floatVars.add(instr.dst);
                const label = `__fneg_mask_${floatConstCount++}`;
                floatConsts.push(`${label}: dq 0x8000000000000000`);
                nasmLines.push(`movsd xmm0, [rbp - ${src}]`);
                nasmLines.push(`movsd xmm1, [rel ${label}]`);
                nasmLines.push(`xorpd xmm0, xmm1`);
                nasmLines.push(`movsd [rbp - ${dst}], xmm0`);
                break;
            }
            case "feq": case "fneq": case "flt": case "flte": case "fgt": case "fgte": {
                const a = getSlot(instr.a);
                const b = getSlot(instr.b);
                const dst = getSlot(instr.dst);
                nasmLines.push(`movsd xmm0, [rbp - ${a}]`);
                nasmLines.push(`ucomisd xmm0, [rbp - ${b}]`);
                const setMap: Record<string, string> = {
                    feq: "sete", fneq: "setne", flt: "setb", flte: "setbe", fgt: "seta", fgte: "setae"
                };
                nasmLines.push(`${setMap[instr.op]} al`);
                nasmLines.push(`movzx rax, al`);
                nasmLines.push(`mov [rbp - ${dst}], rax`);
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
                const a = getSlot(instr.a);
                const b = getSlot(instr.b);
                const dst = getSlot(instr.dst);
                stringTemps.add(instr.dst);
                nasmLines.push(`mov rdi, 256`);
                nasmLines.push(`call malloc`);
                nasmLines.push(`mov [rbp - ${dst}], rax`); // store dest pointer
                nasmLines.push(`mov rdi, rax`); // dest buffer
                nasmLines.push(`mov rsi, [rbp - ${a}]`); // src a
                nasmLines.push(`call strcpy`);
                nasmLines.push(`mov rdi, [rbp - ${dst}]`); // dest buffer
                nasmLines.push(`mov rsi, [rbp - ${b}]`); // src b
                nasmLines.push(`call strcat`);
                break;
            }
            case "struct_alloc": {
                const dst = getSlot(instr.dst)
                const size = instr.numFields * 8
                nasmLines.push(`mov rdi, ${size}`)
                nasmLines.push(`call malloc`)
                nasmLines.push(`mov [rbp - ${dst}], rax`)
                break
            }
            case "field_store": {
                const baseSlot = getSlot(instr.base)
                nasmLines.push(`mov rax, [rbp - ${baseSlot}]`)
                if (/^-?\d+$/.test(instr.src)) {
                    nasmLines.push(`mov qword [rax + ${instr.offset}], ${instr.src}`);
                } else {
                    const srcSlot = getSlot(instr.src)
                    nasmLines.push(`mov rcx, [rbp - ${srcSlot}]`)
                    nasmLines.push(`mov [rax + ${instr.offset}], rcx`)
                }
                break
            }

            case "field_load": {
                const baseSlot = getSlot(instr.base);
                const dst = getSlot(instr.dst);
                nasmLines.push(`mov rax, [rbp - ${baseSlot}]`);  // rax = struct pointer
                nasmLines.push(`mov rax, [rax + ${instr.offset}]`);
                nasmLines.push(`mov [rbp - ${dst}], rax`);
                if (instr.is_string) {
                    stringTemps.add(instr.dst)
                }
                break;
            }

            case "vtable_call": {
                const baseSlot = getSlot(instr.base);
                const dst = getSlot(instr.dst);

                // load vtable pointer from offset 0 of struct
                nasmLines.push(`mov rax, [rbp - ${baseSlot}]`);  // rax = struct ptr
                nasmLines.push(`mov rax, [rax]`);                 // rax = vtable ptr
                nasmLines.push(`mov rax, [rax + ${instr.slot * 8}]`); // rax = function pointer

                // push args in reverse order into registers
                instr.args.forEach((arg, i) => {
                    if (/^-?\d+$/.test(arg)) {
                        nasmLines.push(`mov ${sysv[i]}, ${arg}`);
                    } else {
                        const slot = getSlot(arg);
                        nasmLines.push(`mov ${sysv[i]}, [rbp - ${slot}]`);
                    }
                });

                nasmLines.push(`call rax`);
                nasmLines.push(`mov [rbp - ${dst}], rax`);
                break;
            }

            case "vtable_ptr": {
                const dst = getSlot(instr.dst);
                nasmLines.push(`lea rax, [rel __vtable_${instr.structName}]`);
                nasmLines.push(`mov [rbp - ${dst}], rax`);
                break;
            }
            case "vtable_entry":
                break; // handled in post-pass
        }
    }

    // bounds fail handler
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

    // collect vtable entries from instructions
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

    return nasmLines.join("\n");
}

module.exports = { emitNASM };