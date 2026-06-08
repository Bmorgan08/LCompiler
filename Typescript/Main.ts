const fs = require("fs");
const path = require("path");
const chldproc = require("child_process");
import { LexerWithPos } from "./Modules/Lexer";
import { parseWithPos } from "./Modules/Parser";
import { createScope, define } from "./Modules/Scope";
import { declare } from "./Modules/Declare";
import { validate } from "./Modules/Validate";
import { IRGen, printIR } from "./Modules/IR";
import { emitNASM } from "./Modules/Emitter";
import { copyProp, DCE, fold, cse, insertFrees } from "./Modules/Optimize";

const verbose = process.argv.includes("--verbose");
const irOnly = process.argv.includes("--ir");
const astOnly = process.argv.includes("--ast");
const asm = process.argv.includes("--asm");
const tokensOnly = process.argv.includes("--tokens");

const inputFile = process.argv[2];
const outputFile = process.argv[3] || "output";

if (!inputFile) {
    console.error("Usage: node Main.js <source-file> [output-file] [--ir]");
    process.exit(1);
}

// stdlib dir is sibling of dist/ (i.e. project root/stdlib)
const stdlibDir = path.resolve(__dirname, "../stdlib");

function resolveImports(src: string, srcDir: string, seen: Set<string>): string {
    return src.replace(/^import\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*;?\s*$/gm, (_match, name) => {
        // 1. headers/ local to the source file
        const localPath = path.join(srcDir, "headers", `${name}.l`);
        // 2. stdlib/
        const stdlibPath = path.join(stdlibDir, `${name}.l`);

        let resolved: string | null = null;
        if (fs.existsSync(localPath)) resolved = localPath;
        else if (fs.existsSync(stdlibPath)) resolved = stdlibPath;

        if (!resolved) throw new Error(`Cannot find module '${name}' (searched ${localPath}, ${stdlibPath})`);

        const canonical = path.resolve(resolved);
        if (seen.has(canonical)) return ""; // already included
        seen.add(canonical);

        const importedSrc = fs.readFileSync(canonical, "utf-8") as string;
        // recursively resolve imports in the imported file
        return resolveImports(importedSrc, path.dirname(canonical), seen);
    });
}

const srcDir = path.dirname(path.resolve(inputFile));
const rawSource = fs.readFileSync(inputFile, "utf-8") as string;
const seen = new Set<string>([path.resolve(inputFile)]);

let source: string;
try {
    source = resolveImports(rawSource, srcDir, seen);
} catch (e: any) {
    console.error(`Error: ${e.message}`);
    process.exit(1);
}

function die(msg: string): never {
    // If the message already contains line:col prefix, pass through
    if (/^\d+:\d+:/.test(msg)) {
        console.error(`Error: ${msg}`);
    } else {
        console.error(`Error: ${msg}`);
    }
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
define(globalScope, { name: "print",        kind: "func", params: 1 });
define(globalScope, { name: "input",        kind: "func", params: 0 });
define(globalScope, { name: "inputstr",     kind: "func", params: 0 });
define(globalScope, { name: "len",          kind: "func", params: 1 });
define(globalScope, { name: "printchar",    kind: "func", params: 1 });
define(globalScope, { name: "strtoint",     kind: "func", params: 1 });
define(globalScope, { name: "inttostr",     kind: "func", params: 1 });
define(globalScope, { name: "print_string", kind: "func", params: 1 });
define(globalScope, { name: "print_int",    kind: "func", params: 1 });
define(globalScope, { name: "ord",          kind: "func", params: 1 });
define(globalScope, { name: "chr",          kind: "func", params: 1 });

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

fs.writeFileSync(`${outputFile}.asm`, nasm);
try {
    chldproc.execSync(`nasm -f elf64 ${outputFile}.asm -o ${outputFile}.o`, { stdio: "pipe" });
} catch (e: any) {
    die(`NASM error:\n${e.stderr?.toString() ?? e.message}`);
}
try {
    chldproc.execSync(`gcc ${outputFile}.o -o ${outputFile} -no-pie`, { stdio: "pipe" });
} catch (e: any) {
    die(`Linker error:\n${e.stderr?.toString() ?? e.message}`);
}

if (asm) {
    console.error("=== NASM ===");
    console.error(nasm);
}

fs.rmSync(`${outputFile}.o`);
console.log(`Compiled successfully to ${outputFile}`);
console.log(`Run with: ./${outputFile}`);