const fs = require("fs");
const path = require("path");
const chldproc = require("child_process");
import { LexerWithPos } from "./Modules/Lexer";
import { parseWithPos } from "./Modules/Parser";
import { createScope, define } from "./Modules/Scope";
import { declare } from "./Modules/Declare";
import { validate, errors } from "./Modules/Validate";
import { IRGen, printIR } from "./Modules/IR";
import { emitNASM } from "./Modules/Emitter";
import { copyProp, DCE, fold, cse, insertFrees } from "./Modules/Optimize";

const verbose = process.argv.includes("--verbose");
const irOnly = process.argv.includes("--ir");
const astOnly = process.argv.includes("--ast");
const asm = process.argv.includes("--asm");
const tokensOnly = process.argv.includes("--tokens");
// --check: report the errors (each as "Error: line:col: message") and exit 1, or exit 0, without
// writing any files; the language server runs this on save
const checkOnly = process.argv.includes("--check");
// --nolibc: link against runtime/nolibc.c (our own malloc, printf, syscalls, _start) instead of the C
// library, so the program depends on nothing but the kernel; the graphics module isn't available
const noLibc = process.argv.includes("--nolibc");

const [inputFile, outputFile = "output"] = process.argv.slice(2).filter((a: string) => !a.startsWith("--"));

if (!inputFile) {
    console.error("Usage: node Main.js <source-file> [output-file] [--check] [--nolibc] [--ir] [--ast] [--asm] [--tokens] [--verbose]");
    process.exit(1);
}

// stdlib dir is sibling of dist/ (i.e. project root/stdlib)
const stdlibDir = path.resolve(__dirname, "../stdlib");

// Imports are pasted into the program where the `import` line is. Each line of the result
// remembers where it came from, so an error's line:col can be reported against the file the user
// is editing: a line from an imported file is reported at the import that brought it in.
type SourceLine = { text: string, file: string, line: number, rootLine: number };

function resolveImports(src: string, file: string, rootLine: number | undefined, seen: Set<string>): SourceLine[] {
    const isRoot = rootLine === undefined;
    const fileDir = path.dirname(file);
    const out: SourceLine[] = [];
    src.split("\n").forEach((text, i) => {
        const at = rootLine ?? i + 1;
        const m = /^import\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*;?\s*$/.exec(text);
        if (!m) {
            out.push({ text, file, line: i + 1, rootLine: at });
            return;
        }
        const name = m[1];
        const candidates = [...(isRoot ? [] : [path.join(fileDir, `${name}.l`)]),
            path.join(rootHeadersDir, `${name}.l`),
            path.join(stdlibDir, `${name}.l`)
        ];
        const resolved = candidates.find(c => fs.existsSync(c));
        if (!resolved) throw new Error(`${at}:1: Cannot find module '${name}' (searched ${candidates.join(", ")})`);

        const canonical = path.resolve(resolved);
        out.push({ text: "", file, line: i + 1, rootLine: at });   // the import line itself
        if (seen.has(canonical)) return;   // already included
        seen.add(canonical);
        // recursively resolve imports in the imported file
        out.push(...resolveImports(fs.readFileSync(canonical, "utf-8") as string, canonical, at, seen));
    });
    return out;
}

const inputPath = path.resolve(inputFile);
const srcDir = path.dirname(inputPath);
const rootHeadersDir = path.join(srcDir, "headers");
const rawSource = fs.readFileSync(inputFile, "utf-8") as string;
const seen = new Set<string>([inputPath]);

let sourceLines: SourceLine[] = [];
let source: string;
try {
    sourceLines = resolveImports(rawSource, inputPath, undefined, seen);
    source = sourceLines.map(l => l.text).join("\n");
    // stdlib/string.l comes in automatically when the program calls one of its functions (and
    // doesn't define one of the same name itself); it goes at the end so line numbers don't move
    const stringLib = path.join(stdlibDir, "string.l");
    const stringFns = ["str_split", "str_join", "str_trim", "str_replace", "strtofloat", "str_is_space"];
    const uses = stringFns.some(f => new RegExp(`\\b${f}\\s*\\(`).test(source));
    const defines = stringFns.some(f => new RegExp(`\\b(function|fn)\\s+${f}\\b`).test(source));
    if (uses && !defines && !seen.has(path.resolve(stringLib))) {
        seen.add(path.resolve(stringLib));
        const firstUse = sourceLines.find(l => stringFns.some(f => new RegExp(`\\b${f}\\s*\\(`).test(l.text)))!;
        const lib = resolveImports(fs.readFileSync(stringLib, "utf-8"), stringLib, firstUse.rootLine, seen);
        sourceLines.push({ ...firstUse, text: "" }, ...lib);
        source += "\n" + lib.map(l => l.text).join("\n");
    }
} catch (e: any) {
    console.error(`Error: ${e.message}`);
    process.exit(1);
}

// an error from a line of an imported file is reported at the import, naming the file and its line
function locate(msg: string): string {
    const m = /^(\d+):(\d+):\s*([\s\S]*)$/.exec(msg);
    const src = m && sourceLines[Number(m[1]) - 1];
    if (!m || !src) return msg;
    if (src.file === inputPath) return `${src.line}:${m[2]}: ${m[3]}`;
    return `${src.rootLine}:1: in ${path.relative(srcDir, src.file)} at ${src.line}:${m[2]}: ${m[3]}`;
}

function die(msg: string): never {
    console.error(`Error: ${locate(msg)}`);
    process.exit(1);
}

let tokens: ReturnType<typeof LexerWithPos>;
try {
    tokens = LexerWithPos(source);
} catch (e: any) {
    die(e.message);
}

let ast: ReturnType<typeof parseWithPos>;
try {
    ast = parseWithPos(tokens);
} catch (e: any) {
    die(e.message);
}

let foldedAst: typeof ast;
let optimizedAst: typeof ast;
try {
    foldedAst = fold(ast);
    optimizedAst = DCE(foldedAst);
} catch (e: any) {
    die(e.message);
}

const globalScope = createScope();
define(globalScope, { name: "print",           kind: "func", params: 1 });
define(globalScope, { name: "input",           kind: "func", params: 0, type: "int" });
define(globalScope, { name: "inputstr",        kind: "func", params: 0, type: "string" });
define(globalScope, { name: "len",             kind: "func", params: 1, type: "int" });
define(globalScope, { name: "printchar",       kind: "func", params: 1 });
define(globalScope, { name: "strtoint",        kind: "func", params: 1, type: "int" });
define(globalScope, { name: "inttostr",        kind: "func", params: 1, type: "string" });
define(globalScope, { name: "chartostr",       kind: "func", params: 1, type: "string" });
define(globalScope, { name: "floattostr",      kind: "func", params: 1, type: "string" });
define(globalScope, { name: "str_upper",       kind: "func", params: 1, type: "string" });
define(globalScope, { name: "str_lower",       kind: "func", params: 1, type: "string" });
define(globalScope, { name: "str_find",        kind: "func", params: 2, type: "int" });
define(globalScope, { name: "str_contains",    kind: "func", params: 2, type: "int" });
define(globalScope, { name: "print_string",    kind: "func", params: 1 });
define(globalScope, { name: "print_int",       kind: "func", params: 1 });
define(globalScope, { name: "ord",             kind: "func", params: 1 });
define(globalScope, { name: "chr",             kind: "func", params: 1 });
// C runtime graphics functions (graphics.o)
define(globalScope, { name: "gfx_window_init",    kind: "func", params: 3 });
define(globalScope, { name: "gfx_should_close",   kind: "func", params: 0 });
define(globalScope, { name: "gfx_swap",           kind: "func", params: 0 });
define(globalScope, { name: "gfx_destroy",        kind: "func", params: 0 });
define(globalScope, { name: "gfx_key_down",       kind: "func", params: 1 });
define(globalScope, { name: "gfx_time",           kind: "func", params: 0 });
define(globalScope, { name: "gfx_log",            kind: "func", params: 1 });
define(globalScope, { name: "gfx_c_clear",        kind: "func", params: 1 });
define(globalScope, { name: "gfx_c_set_pixel",    kind: "func", params: 3 });
define(globalScope, { name: "gfx_c_hline",        kind: "func", params: 4 });
define(globalScope, { name: "gfx_c_vline",        kind: "func", params: 4 });
define(globalScope, { name: "gfx_c_line",         kind: "func", params: 5 });
define(globalScope, { name: "gfx_c_rect",         kind: "func", params: 5 });
define(globalScope, { name: "gfx_c_rect_border",  kind: "func", params: 5 });

try {
    declare(optimizedAst, globalScope);
} catch (e: any) {
    die(e.message);
}

try {
    validate(optimizedAst, globalScope);
} catch (e: any) {
    die(e.message);
}
// every type and memory-safety error is reported (syntax errors still stop at the first)
if (errors.length) {
    for (const msg of errors) console.error(`Error: ${locate(msg)}`);
    process.exit(1);
}

let IR: ReturnType<typeof IRGen>;
try {
    IR = IRGen(optimizedAst);
} catch (e: any) {
    die(e.message);
}

const optimizedIR = cse(copyProp(IR));

const freedIR = insertFrees(optimizedIR);

if (tokensOnly) {
    console.error("=== Tokens ===");
    console.error(tokens);
}

if (astOnly) {
    console.error("=== AST ===");
    console.error(JSON.stringify(ast, null, 2));
    console.error("=== Folded AST ===");
    console.error(JSON.stringify(foldedAst, null, 2));
    console.error("=== Optimized AST ===");
    console.error(JSON.stringify(optimizedAst, null, 2));
}

if (irOnly) {
    console.error("=== IR ===");
    console.error(printIR(IR));
    console.error("=== Optimized IR ===");
    console.error(printIR(optimizedIR));
    console.error("=== Freed IR ===");
    console.error(printIR(freedIR));
}

if (verbose) {
    console.error("=== Tokens ===");
    console.error(tokens);
    console.error("=== AST ===");
    console.error(JSON.stringify(ast, null, 2));
    console.error("=== Folded AST ===");
    console.error(JSON.stringify(foldedAst, null, 2));
    console.error("=== Optimized AST ===");
    console.error(JSON.stringify(optimizedAst, null, 2));
    console.error("=== IR ===");
    console.error(printIR(IR));
    console.error("=== Optimized IR ===");
    console.error(printIR(optimizedIR));
    console.error("=== Freed IR ===");
    console.error(printIR(freedIR));
}



let nasm: string;
try {
    nasm = emitNASM(freedIR);
} catch (e: any) {
    die(e.message);
}

if (checkOnly) process.exit(0);

fs.writeFileSync(`${outputFile}.asm`, nasm);
try {
    chldproc.execSync(`nasm -f elf64 ${outputFile}.asm -o ${outputFile}.o`, { stdio: "pipe" });
} catch (e: any) {
    die(`NASM error:\n${e.stderr?.toString() ?? e.message}`);
}
const runtimeDir = path.resolve(__dirname, "../Typescript/runtime");

// builds runtime/<name>.c into <object>.o when the object is missing or older than the source; it is
// written to a temporary file and renamed, so compilers running at the same time can't see half a file
function buildRuntime(name: string, object: string, flags: string): string {
    const c = path.join(runtimeDir, `${name}.c`);
    const o = path.join(runtimeDir, `${object}.o`);
    try {
        if (!fs.existsSync(o) || fs.statSync(o).mtimeMs < fs.statSync(c).mtimeMs) {
            const tmp = `${o}.${process.pid}.tmp`;
            chldproc.execSync(`gcc -c -O2 ${flags} ${c} -o ${tmp}`, { stdio: "pipe" });
            fs.renameSync(tmp, o);
        }
    } catch (e: any) {
        die(`Could not build the L runtime (${name}.c):\n${e.stderr?.toString() ?? e.message}`);
    }
    return o;
}

if (noLibc) {
    // a call into graphics.c (which needs GLFW and OpenGL, and so the C library)
    const graphicsCall = /^\s*call\s+\$?(gfx_c_\w+|gfx_window_init|gfx_should_close|gfx_swap|gfx_destroy|gfx_key_down|gfx_time|gfx_log)\s*$/m;
    if (graphicsCall.test(nasm)) die("The graphics module needs the C library, so it can't be used with --nolibc");
    // No C library means no stack-protector canary (it's read through the fs register, which libc sets
    // up) and no builtins: gcc must not turn nolibc.c's own memset loop into a call to memset
    const flags = "-ffreestanding -fno-builtin -fno-stack-protector -fno-pie";
    const lrtO = buildRuntime("lrt", "lrt-nolibc", flags);   // arrays and maps, built separately from the libc version
    const noLibcO = buildRuntime("nolibc", "nolibc", flags);
    try {
        // libgcc supplies the few helpers gcc itself may call (it doesn't need the C library)
        chldproc.execSync(`gcc ${outputFile}.o ${lrtO} ${noLibcO} -o ${outputFile} -nostdlib -static -no-pie -lgcc`, { stdio: "pipe" });
    } catch (e: any) {
        die(`Linker error:\n${e.stderr?.toString() ?? e.message}`);
    }
} else {
    const lrtO = buildRuntime("lrt", "lrt", "");   // arrays and maps
    try {
        const graphicsO = path.join(runtimeDir, "graphics.o");
        chldproc.execSync(`gcc ${outputFile}.o ${graphicsO} ${lrtO} -o ${outputFile} -no-pie -lglfw -lGL`, { stdio: "pipe" });
    } catch (e: any) {
        die(`Linker error:\n${e.stderr?.toString() ?? e.message}`);
    }
}

if (asm) {
    console.error("=== NASM ===");
    console.error(nasm);
}

fs.rmSync(`${outputFile}.o`);
console.log(`Compiled successfully to ${outputFile}`);
console.log(`Run with: ./${outputFile}`);