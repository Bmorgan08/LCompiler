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
- Static types: `int`, `float`, `bool`, `char`, `string`, arrays, structs, tuples
- Automatic memory management — heap values freed at compile time, no GC, no manual `free`
- Structs with methods and single inheritance
- For-in loops, match expressions, short-circuit `&&`/`||`
- Inline assembly via `asm { }`
- Standard library (`math`, trig, string conversion)
- VS Code extension with syntax highlighting and language server

## Requirements

- Node.js 18+
- NASM
- `ld` (GNU linker)
- Linux x86-64

## Building

```sh
npm install
npm run build       # compiles TypeScript to dist/
```

## Usage

```sh
node dist/Main.js <source.l> [output] [flags]
```

```sh
node dist/Main.js hello.l           # compiles to ./output
node dist/Main.js hello.l hello     # compiles to ./hello
```

| Flag        | Description                             |
|-------------|-----------------------------------------|
| `--ir`      | Print the intermediate representation   |
| `--ast`     | Print the abstract syntax tree          |
| `--asm`     | Print the generated assembly            |
| `--tokens`  | Print the token stream                  |
| `--verbose` | Print all of the above                  |

## Language Reference

See [LANGUAGE.md](LANGUAGE.md) for the full language reference — types, operators, control flow, structs, imports, memory model, and more.

## VS Code Extension

The `syntaxes/` and `client/` directories contain a VS Code extension providing syntax highlighting and a language server for `.l` files.

## Project Structure

```
Typescript/       compiler source (TypeScript)
  Lexer.ts
  Parser.ts
  TypeChecker.ts
  IRGen.ts
  CodeGen.ts
stdlib/           standard library modules (.l)
client/           VS Code extension client
server/           VS Code language server
Test/             test programs
```
