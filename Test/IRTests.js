// --ir output tests: every IR op should print as a readable line, and the optimizer passes
// (fold, DCE, copy propagation, CSE) should show their effect in the "Optimized IR" section.
// Run: node Test/IRTests.js [--verbose]

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const COMPILER = path.join(ROOT, "dist", "Main.js");
const verbose = process.argv.includes("--verbose");

// wraps statements in a main() that returns 0
const main = body => `main() {\n${body}\n    return 0;\n}\n`;

// each test: a program, lines (RegExp or text) the "Freed IR" section (or `section`) must contain,
// and lines it must not
const tests = [
    { name: "str_concat is printed",
      source: main(`var string a = "x";\n var string s = a + "y";\n print(s);`),
      contains: [/str_concat t\d+ = \S+ \+ \S+/] },
    { name: "str_cmp and str_sub are printed",
      source: main(`var string s = "hello";\n print(s[1..3]);\n print(s < "z");`),
      contains: [/str_sub\s+t\d+ = \S+\[\S+\.\.\S+\]/, /str_cmp\s+t\d+ = \S+ <=> \S+/] },
    { name: "float ops are printed",
      source: main(`var f = 1.5;\n var g = f * 2.0 + 0.5;\n print(g);`),
      contains: [/fconst\s+t\d+ = 1\.5/, /fmul\s+t\d+ = \S+ fmul \S+/, /fadd\s+t\d+ = \S+ fadd \S+/] },
    { name: "string equality is printed",
      source: main(`var string s = "a";\n print(s == "a");`),
      contains: [/str_eq\s+t\d+ = \S+ str_eq \S+/] },
    { name: "struct layouts and vtable entries are printed",
      source: `struct P {\n    var name: string;\n    fn get() { return this.name; }\n}\n` + main(`var p = P { name: "a" };\n print(p.get());`),
      contains: [/; layout P: string @8/, /; vtable P\.get -> P\.get/] },
    { name: "typed frees are printed",
      source: main(`var string[] xs = ["a", "b"];\n print(xs[0]);`),
      contains: [/free\s+xs \(string\[\]\)/] },
    { name: "no op falls through to the raw fallback",
      source: `struct P {\n    var n: int;\n    fn f() { return this.n; }\n}\n` +
              main(`var P[] ps = [P { n: 1 }];\n var float[] f = [1.5];\n var string[] w = ["x"];\n print(ps[0].f());\n print(f[0] * 2.0);\n print(w[0] + "y");\n print(w[0] < "z");\n print(-f[0]);`),
      absent: [/^\s*\{"op"/m] },

    // ── Optimizer passes (checked in the "Optimized IR" section; plain strings match anywhere) ──

    { section: "Optimized IR", name: "fold: addition produces no add instruction",
      source: "main() { var x = 2 + 3; print(x); return 0; }",
      contains: ["const     t0 = 5"],
      absent: ["add"] },
    { section: "Optimized IR", name: "fold: multiplication produces no mul instruction",
      source: "main() { var x = 4 * 5; print(x); return 0; }",
      contains: ["const     t0 = 20"],
      absent: ["mul"] },
    { section: "Optimized IR", name: "fold: subtraction produces no sub instruction",
      source: "main() { var x = 10 - 3; print(x); return 0; }",
      contains: ["const     t0 = 7"],
      absent: ["sub"] },
    { section: "Optimized IR", name: "fold: division produces no div instruction",
      source: "main() { var x = 10 / 2; print(x); return 0; }",
      contains: ["const     t0 = 5"],
      absent: ["div"] },
    { section: "Optimized IR", name: "fold: nested expression folds completely",
      source: "main() { var x = (2 + 3) * 4; print(x); return 0; }",
      contains: ["const     t0 = 20"],
      absent: ["add"] },
    { section: "Optimized IR", name: "fold: unary negation folds",
      source: "main() { var x = -5; print(x); return 0; }",
      contains: ["const     t0 = -5"],
      absent: ["neg"] },
    { section: "Optimized IR", name: "fold: comparison folds to 1",
      source: "main() { var x = 2 == 2; print(x); return 0; }",
      contains: ["const     t0 = 1"],
      absent: ["eq"] },
    { section: "Optimized IR", name: "fold: comparison folds to 0",
      source: "main() { var x = 2 == 3; print(x); return 0; }",
      contains: ["const     t0 = 0"],
      absent: ["eq"] },
    { section: "Optimized IR", name: "dce: dead code after return removed",
      source: "\nfunction foo() {\n    return 5;\n    var x = 10;\n    print(x);\n}\nmain() {\n    var x = foo();\n    print(x);\n    return 0;\n}",
      contains: ["ret"],
      absent: ["const     t0 = 10"] },
    { section: "Optimized IR", name: "dce: always true if removes else",
      source: "\nmain() {\n    if (1 == 1) {\n        print(1);\n    } else {\n        print(0);\n    }\n    return 0;\n}",
      absent: ["jz", "jmp"] },
    { section: "Optimized IR", name: "dce: always false if removes then",
      source: "\nmain() {\n    if (1 == 2) {\n        print(1);\n    } else {\n        print(0);\n    }\n    return 0;\n}",
      absent: ["jz", "const     t0 = 1"] },
    { section: "Optimized IR", name: "dce: dead code after break removed",
      source: "\nmain() {\n    var x = 0;\n    while (x < 10) {\n        break;\n        x = x + 1;\n    }\n    return 0;\n}",
      absent: ["add"] },
    { section: "Optimized IR", name: "copyprop: simple mov propagation",
      source: "main() { var a = 5; var b = a; print(b); return 0; }",
      contains: ["mov       b"],
      absent: ["mov       t"] },
    { section: "Optimized IR", name: "copyprop: chained mov propagation",
      source: "main() { var a = 5; var b = a; var c = b; print(c); return 0; }",
      contains: ["const     t0 = 5"],
      absent: ["mov       t"] },
    { section: "Optimized IR", name: "copyprop: arithmetic uses original source",
      source: "main() { var a = 5; var b = a; var c = b + 1; print(c); return 0; }",
      contains: ["add"],
      absent: ["mov       t"] },
    { section: "Optimized IR", name: "copyprop: function argument propagation",
      source: "\nfunction id(x) { return x; }\nmain() { var a = 5; var b = a; print(id(b)); return 0; }",
      contains: ["call"],
      absent: ["mov       t"] },
    { section: "Optimized IR", name: "copyprop: comparison propagation",
      source: "main() { var a = 5; var b = a; if (b == 5) { print(1); } return 0; }",
      contains: ["eq"],
      absent: ["mov       t"] },
    { section: "Optimized IR", name: "cse: duplicate addition eliminated",
      source: "\nmain() {\n    var a = 5;\n    var b = a + 1;\n    var c = a + 1;\n    print(c);\n    return 0;\n}",
      contains: ["add"],
      absent: ["add       t2"] },
    { section: "Optimized IR", name: "cse: duplicate subtraction eliminated",
      source: "\nmain() {\n    var a = 10;\n    var b = a - 3;\n    var c = a - 3;\n    print(c);\n    return 0;\n}",
      contains: ["sub"],
      absent: ["sub       t2"] },
    { section: "Optimized IR", name: "cse: duplicate comparison eliminated",
      source: "\nmain() {\n    var a = 5;\n    var b = a == 5;\n    var c = a == 5;\n    print(c);\n    return 0;\n}",
      contains: ["eq"],
      absent: ["eq        t2"] },
    { section: "Optimized IR", name: "cse: expression not reused after variable changes",
      source: "\nmain() {\n    var a = 5;\n    var b = a + 1;\n    a = 10;\n    var c = a + 1;\n    print(c);\n    return 0;\n}",
      contains: ["add       t"] },
    { section: "Optimized IR", name: "cse: duplicate multiplication eliminated",
      source: "\nmain() {\n    var a = 5;\n    var b = a * 2;\n    var c = a * 2;\n    print(c);\n    return 0;\n}",
      contains: ["mul"],
      absent: ["mul       t2"] },
];

let passed = 0, failed = 0;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lir-"));
for (const t of tests) {
    const src = path.join(dir, "t.l");
    fs.writeFileSync(src, t.source);
    const r = spawnSync("node", [COMPILER, src, path.join(dir, "t"), "--ir"], { encoding: "utf8" });
    const out = r.stderr + r.stdout;
    const section = t.section ?? "Freed IR";
    const start = out.indexOf(`=== ${section} ===`);
    const end = out.indexOf("=== ", start + 4);
    const freed = out.slice(start, end < 0 ? undefined : end);
    const has = p => typeof p === "string" ? freed.includes(p) : p.test(freed);
    const problems = [];
    if (r.status !== 0) problems.push(`compiler exited with ${r.status}`);
    for (const re of t.contains ?? []) if (!has(re)) problems.push(`missing ${re}`);
    for (const re of t.absent ?? []) if (has(re)) problems.push(`unexpected ${re}`);
    if (problems.length === 0) {
        passed++;
        console.log(`  ✓ ${t.name}`);
    } else {
        failed++;
        console.log(`  ✗ ${t.name}\n      ${problems.join("\n      ")}`);
        if (verbose) console.log(freed.split("\n").map(l => "      | " + l).join("\n"));
    }
}
fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
