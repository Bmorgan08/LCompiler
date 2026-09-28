# LCompiler

A compiler for **L**, a statically-typed language that compiles to native Linux x86-64 binaries via NASM assembly. Written in TypeScript.

```
function add(int a, int b) {
    return a + b;
}

main() {
    print(add(3, 4));   // 7
    return 0;
}
```

## Features

- Compiled to native x86-64 — no VM, no interpreter
- Static types: `int`, `float`, `bool`, `char`, `string`, typed arrays (`int[]`, `float[]`, `string[]`, arrays of structs, 2-D), structs, tuples, maps (`map<string, int>`) and function types (`fn(int): int`)
- Growable arrays (`push`, `pop`, `insert`, `remove`), declared return types, and argument type checks
- `none` for empty struct fields (linked lists, optional values), and clear runtime errors for bad indexes, division by zero and missing map keys
- Automatic memory management — heap values freed at compile time, no GC, no manual `free`, and use-after-free is a compile error
- Structs with methods, single inheritance, nested structs and chained access (`ps[i].tags[0]`)
- Strings with escape sequences, ordering, substrings, search/case helpers, and split/join/trim/replace; `const` variables
- For-in loops, match expressions, short-circuit `&&`/`||`
- Inline assembly via `asm { }`
- Low-level programming for OS kernels: sized integers (`u8`...`u64`, `i8`...`i32`), bitwise operators, pointers (`ptr<u16>`), packed structs with exact layouts, port I/O (`inb`/`outb`), `extern fn` to call assembly and C, `interrupt fn` handlers, and a `--kernel` mode to build an OS kernel
- Standard library (`math`, trig, strings, graphics)
- VS Code extension with syntax highlighting and a language server that shows compiler errors on save

## Requirements

- Node.js 18+
- NASM
- GCC (used to link, and to build the runtime `Typescript/runtime/lrt.c` the first time a program is compiled)
- GLFW and OpenGL development libraries (linked for the `graphics` module)
- For kernels (optional): QEMU to boot them, and GRUB (`grub-mkrescue`, `xorriso`) to make an ISO
- Linux x86-64

## Building

```sh
npm install
npx tsc             # compiles TypeScript to dist/
```

## Usage

```sh
node dist/Main.js <source.l> [output] [flags]
```

```sh
node dist/Main.js hello.l           # compiles to ./output
node dist/Main.js hello.l hello     # compiles to ./hello
```

| Flag        | Description                           |
| ----------- | ------------------------------------- |
| `--ir`      | Print the intermediate representation |
| `--ast`     | Print the abstract syntax tree        |
| `--asm`     | Print the generated assembly          |
| `--tokens`  | Print the token stream                |
| `--verbose` | Print all of the above                |
| `--check`   | Only check for errors; write no files |
| `--nolibc`  | Link against L's own runtime instead of the C library |
| `--kernel`  | Compile an OS kernel to `<output>.o` and `<output>-runtime.o` (see LANGUAGE.md, Writing a Kernel) |

## Tests

```sh
node Test/LanguageTests.js              # language suite
node Test/StdlibTests.js                # standard library suite
node Test/RegressionTests.js            # older whole-program tests (from the original Runner.js)
node Test/IRTests.js                    # --ir output and optimizer passes
node Test/ServerTests.js                # --check and the language server's diagnostics
node Test/KernelTests.js                # --kernel: boots small kernels in QEMU
node Test/LanguageTests.js --memcheck --leaks   # also run every test under AddressSanitizer
node Test/LanguageTests.js --nolibc             # compile every test with --nolibc (runtime/nolibc.c instead of libc)
```

Rebuild with `npx tsc` first; the tests run `dist/Main.js`. `Test/known-bugs.js` records every bug found so far and how it was fixed.

## Language Reference

See [LANGUAGE.md](LANGUAGE.md) for the full language reference — types, operators, control flow, structs, imports, memory model, and more.

## VS Code Extension

The `syntaxes/` and `client/` directories contain a VS Code extension providing syntax highlighting and a language server for `.l` files.

## Project Structure

```
Typescript/            compiler source (TypeScript)
  Main.ts              driver: imports, pipeline, assembling and linking
  Modules/Lexer.ts     tokens
  Modules/Parser.ts    AST
  Modules/Scope.ts     symbols, scopes and struct definitions
  Modules/Declare.ts   declares functions, globals and structs
  Modules/Validate.ts  type checks and memory-safety checks
  Modules/Fresh.ts     which functions always return a new value
  Modules/IR.ts        AST -> IR
  Modules/Optimize.ts  copy propagation, CSE, and where values are freed
  Modules/Emitter.ts   IR -> NASM
  runtime/lrt.c        C runtime for growable arrays and maps (built into lrt.o on first use)
  runtime/nolibc.c     replacement for the C library, used with --nolibc
  runtime/graphics.c   C runtime for the graphics module
stdlib/                standard library modules (.l); string.l is imported automatically
client/                VS Code extension client
server/                VS Code language server
Test/                  test suites
```
