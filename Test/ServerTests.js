// Compiler checks on save: `node dist/Main.js <file> --check`, and the language server
// (server/out/server.js) showing its errors as diagnostics when a file is opened or saved.
// Run: node Test/ServerTests.js [filter] [--verbose]
// The language server part needs server/node_modules (vscode-languageserver); without it those
// tests are skipped.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const { pathToFileURL } = require("url");

const ROOT = path.resolve(__dirname, "..");
const COMPILER = path.join(ROOT, "dist", "Main.js");
const SERVER = path.join(ROOT, "server", "out", "server.js");
const verbose = process.argv.includes("--verbose");
const filter = process.argv.slice(2).find(a => !a.startsWith("--"));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lsrv-"));
const main = body => `main() {\n    ${body}\n    return 0;\n}\n`;
const lines = (...xs) => xs.join("\n    ");

function write(name, source) {
    const file = path.join(dir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, source);
    return file;
}

function check(source, name = "c.l") {
    const file = write(name, source);
    const r = spawnSync("node", [COMPILER, file, "--check"], { encoding: "utf8", cwd: dir });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

// ── A minimal LSP client over stdio ──

class Client {
    constructor() {
        this.proc = spawn("node", [SERVER, "--stdio"], { stdio: ["pipe", "pipe", "pipe"] });
        this.buf = Buffer.alloc(0);
        this.nextId = 1;
        this.pending = new Map();
        this.diagnostics = new Map();   // uri -> the latest published diagnostics
        this.waiters = [];
        this.proc.stdout.on("data", d => this.onData(d));
        this.proc.stderr.on("data", d => { if (verbose) process.stderr.write(d); });
    }
    onData(d) {
        this.buf = Buffer.concat([this.buf, d]);
        for (;;) {
            const headerEnd = this.buf.indexOf("\r\n\r\n");
            if (headerEnd < 0) return;
            const len = Number(/Content-Length: (\d+)/i.exec(this.buf.slice(0, headerEnd).toString())[1]);
            if (this.buf.length < headerEnd + 4 + len) return;
            const msg = JSON.parse(this.buf.slice(headerEnd + 4, headerEnd + 4 + len).toString());
            this.buf = this.buf.slice(headerEnd + 4 + len);
            this.onMessage(msg);
        }
    }
    onMessage(msg) {
        if (msg.id !== undefined && this.pending.has(msg.id)) {
            this.pending.get(msg.id)(msg.result);
            this.pending.delete(msg.id);
        } else if (msg.id !== undefined && msg.method) {
            this.send({ jsonrpc: "2.0", id: msg.id, result: null });   // e.g. client/registerCapability
        } else if (msg.method === "textDocument/publishDiagnostics") {
            this.diagnostics.set(msg.params.uri, msg.params.diagnostics);
            this.waiters = this.waiters.filter(w => !w());
        }
    }
    send(msg) {
        const body = JSON.stringify(msg);
        this.proc.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    }
    request(method, params) {
        const id = this.nextId++;
        this.send({ jsonrpc: "2.0", id, method, params });
        return new Promise(resolve => this.pending.set(id, resolve));
    }
    notify(method, params) {
        this.send({ jsonrpc: "2.0", method, params });
    }
    async start() {
        await this.request("initialize", { processId: process.pid, rootUri: pathToFileURL(dir).href, capabilities: {} });
        this.notify("initialized", {});
    }
    // the compiler's diagnostics for uri once `until` holds for them (they arrive after the check runs)
    compilerDiagnostics(uri, until, timeout = 20000) {
        const get = () => (this.diagnostics.get(uri) ?? []).filter(d => d.source === "L compiler");
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`timed out; last diagnostics: ${JSON.stringify(get())}`)), timeout);
            const test = () => {
                if (!this.diagnostics.has(uri) || !until(get())) return false;
                clearTimeout(timer);
                resolve(get());
                return true;
            };
            if (!test()) this.waiters.push(test);
        });
    }
    open(file) {
        const uri = pathToFileURL(file).href;
        this.versions = this.versions ?? new Map();
        this.versions.set(uri, 1);
        this.diagnostics.delete(uri);
        this.notify("textDocument/didOpen", { textDocument: { uri, languageId: "l", version: 1, text: fs.readFileSync(file, "utf8") } });
        return uri;
    }
    // writes the file and tells the server it was edited and saved
    save(file, source) {
        fs.writeFileSync(file, source);
        const uri = pathToFileURL(file).href;
        const version = this.versions.get(uri) + 1;
        this.versions.set(uri, version);
        this.diagnostics.delete(uri);
        this.notify("textDocument/didChange", { textDocument: { uri, version }, contentChanges: [{ text: source }] });
        this.notify("textDocument/didSave", { textDocument: { uri } });
        return uri;
    }
    close(file) {
        const uri = pathToFileURL(file).href;
        this.diagnostics.delete(uri);
        this.notify("textDocument/didClose", { textDocument: { uri } });
        return uri;
    }
    async stop() {
        await this.request("shutdown", null);
        this.notify("exit", null);
        this.proc.kill();
    }
}

const some = ds => ds.length > 0;
const none = ds => ds.length === 0;

function expectEq(actual, expected, what) {
    if (JSON.stringify(actual) !== JSON.stringify(expected))
        throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function expectMatch(text, re, what) {
    if (!re.test(text)) throw new Error(`${what}: expected ${re}, got ${JSON.stringify(text)}`);
}

// ── Tests ──

const checkTests = [
    { name: "check: a valid program exits 0 and prints nothing", run: () => {
        const r = check(main(`print(1);`));
        expectEq([r.status, r.stdout, r.stderr], [0, "", ""], "result");
    } },
    { name: "check: a type error exits 1 with line:col", run: () => {
        const r = check(main(`var int x = "a";`));
        expectEq(r.status, 1, "status");
        expectMatch(r.stderr, /^Error: 2:5: Type annotation mismatch: declared int, inferred string/, "stderr");
    } },
    { name: "check: writes no files", run: () => {
        const sub = path.join(dir, "nofiles");
        fs.mkdirSync(sub);
        const file = path.join(sub, "p.l");
        fs.writeFileSync(file, main(`print(2);`));
        const r = spawnSync("node", [COMPILER, file, "--check"], { encoding: "utf8", cwd: sub });
        expectEq(r.status, 0, "status");
        expectEq(fs.readdirSync(sub), ["p.l"], "files in the directory");
    } },
    { name: "check: an output name before --check is accepted and not written", run: () => {
        const file = write("named.l", main(`print(3);`));
        const r = spawnSync("node", [COMPILER, file, path.join(dir, "named"), "--check"], { encoding: "utf8" });
        expectEq(r.status, 0, "status");
        expectEq(fs.existsSync(path.join(dir, "named")) || fs.existsSync(path.join(dir, "named.asm")), false, "output written");
    } },
    { name: "check: lexer errors are reported", run: () => {
        const r = check(main(`print("a\\q");`));
        expectEq(r.status, 1, "status");
        expectMatch(r.stderr, /Unknown escape/, "stderr");
    } },
    { name: "check: memory-safety errors are reported", run: () => {
        const r = check(main(`var int[][] m = new int[2][3];\n    var int[] row = new int[3];\n    m[0] = row;\n    row[0] = 7;`));
        expectEq(r.status, 1, "status");
        expectMatch(r.stderr, /^Error: 5:\d+: .*was stored into an array or struct/, "stderr");
    } },
    { name: "check: lines after an import are not shifted by it", run: () => {
        write("headers/three.l", `function t1() { return 1; }\nfunction t2() { return 2; }\nfunction t3() { return 3; }\n`);
        const r = check(`import three;\nimport math;\nmain() {\n    var int x = "a";\n    return 0;\n}\n`);
        expectMatch(r.stderr, /^Error: 4:5: Type annotation mismatch/, "stderr");
    } },
    { name: "check: lines are not shifted by the automatic string import", run: () => {
        const r = check(main(`print(str_trim(" a "));\n    var int z = "q";`));
        expectMatch(r.stderr, /^Error: 3:\d+: Type annotation mismatch/, "stderr");
    } },
    { name: "check: the string library is imported automatically", run: () => {
        const r = check(main(`print(str_trim("  x  "));`));
        expectEq([r.status, r.stderr], [0, ""], "result");
    } },
    { name: "check: --ir output name mix-up is gone (flags aren't the output file)", run: () => {
        const sub = path.join(dir, "flags");
        fs.mkdirSync(sub);
        const file = path.join(sub, "f.l");
        fs.writeFileSync(file, main(`print(4);`));
        const r = spawnSync("node", [COMPILER, file, "--asm"], { encoding: "utf8", cwd: sub });
        expectEq(r.status, 0, "status");
        expectEq(fs.existsSync(path.join(sub, "--asm")), false, "a file named --asm");
        expectEq(fs.existsSync(path.join(sub, "output")), true, "the default output");
    } },
];

const serverTests = [
    { name: "server: an error is shown when a file is opened", run: async c => {
        const f = write("s1.l", main(`var int x = "a";`));
        const ds = await c.compilerDiagnostics(c.open(f), some);
        expectEq(ds.length, 1, "diagnostics");
        expectEq(ds[0].range.start, { line: 1, character: 4 }, "position");
        expectMatch(ds[0].message, /^Type annotation mismatch: declared int, inferred string$/, "message");
        expectEq(ds[0].severity, 1, "severity (error)");
    } },
    { name: "server: a valid file has no compiler diagnostics", run: async c => {
        const f = write("s2.l", main(`print(1);`));
        await c.compilerDiagnostics(c.open(f), none);
    } },
    { name: "server: an error introduced by a save is shown", run: async c => {
        const f = write("s3.l", main(`print(1);`));
        await c.compilerDiagnostics(c.open(f), none);
        const ds = await c.compilerDiagnostics(c.save(f, main(`print(1);\n    print(nope);`)), some);
        expectEq(ds[0].range.start.line, 2, "line");
        expectMatch(ds[0].message, /nope/, "message");
    } },
    { name: "server: fixing the error and saving clears it", run: async c => {
        const f = write("s4.l", main(`var int x = "a";`));
        await c.compilerDiagnostics(c.open(f), some);
        await c.compilerDiagnostics(c.save(f, main(`var int x = 1;\n    print(x);`)), none);
    } },
    { name: "server: the column is converted to 0-based", run: async c => {
        const f = write("s5.l", `main() {\n    var int[] xs = [1];\n    xs.push("a");\n    return 0;\n}\n`);
        const ds = await c.compilerDiagnostics(c.open(f), some);
        const r = check(fs.readFileSync(f, "utf8"));
        const [, line, col] = /^Error: (\d+):(\d+):/.exec(r.stderr);
        expectEq(ds[0].range.start, { line: Number(line) - 1, character: Number(col) - 1 }, "position");
    } },
    { name: "server: an error without a position goes on the first line", run: async c => {
        const f = write("s6.l", `function dup() { return 1; }\nfunction dup() { return 2; }\n` + main(`print(dup());`));
        const ds = await c.compilerDiagnostics(c.open(f), some);
        expectEq(ds[0].range.start, { line: 0, character: 0 }, "position");
        expectMatch(ds[0].message, /Duplicate declaration: dup/, "message");
    } },
    { name: "server: a missing import is shown on its line", run: async c => {
        const f = write("s6b.l", `// uses a module that isn't there\nimport nosuchmodule;\n` + main(`print(1);`));
        const ds = await c.compilerDiagnostics(c.open(f), some);
        expectEq(ds[0].range.start, { line: 1, character: 0 }, "position");
        expectMatch(ds[0].message, /Cannot find module 'nosuchmodule'/, "message");
    } },
    { name: "server: an error in an imported file is shown on the import", run: async c => {
        write("headers/broken.l", `function b1() { return 1; }\nfunction b2() { var int q = "x"; return q; }\n`);
        const f = write("s6c.l", `// header with a mistake\nimport broken;\n` + main(`print(b1());`));
        const ds = await c.compilerDiagnostics(c.open(f), some);
        expectEq(ds[0].range.start, { line: 1, character: 0 }, "position");
        expectMatch(ds[0].message, /^in headers\/broken\.l at 2:17: Type annotation mismatch/, "message");
    } },
    { name: "server: imports next to the file are found", run: async c => {
        write("headers/helper.l", `function helper(int x): int { return x + 1; }\n`);
        const f = write("s7.l", `import helper;\n` + main(`print(helper(1));`));
        await c.compilerDiagnostics(c.open(f), none);
    } },
    { name: "server: each file keeps its own diagnostics", run: async c => {
        const bad = write("s8a.l", main(`var int x = "a";`));
        const good = write("s8b.l", main(`print(1);`));
        const badUri = c.open(bad);
        const goodUri = c.open(good);
        await c.compilerDiagnostics(badUri, some);
        await c.compilerDiagnostics(goodUri, none);
        expectEq((c.diagnostics.get(badUri) ?? []).filter(d => d.source === "L compiler").length, 1, "bad file diagnostics");
    } },
    { name: "server: closing a file clears its diagnostics", run: async c => {
        const f = write("s9.l", main(`var int x = "a";`));
        await c.compilerDiagnostics(c.open(f), some);
        const uri = c.close(f);
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("no empty diagnostics after close")), 10000);
            const test = () => { if (c.diagnostics.get(uri)?.length === 0) { clearTimeout(timer); resolve(); return true; } return false; };
            if (!test()) c.waiters.push(test);
        });
    } },
    { name: "server: newer syntax shows no errors at all", run: async c => {
        const f = write("s10.l", lines("struct Node {", "    var val: int;", "    var next: Node = none;", "}",
            "function twice(int x): int { return x * 2; }") + "\n" +
            main(lines(`var map<string, int> m = {"a": 1};`, `m["b"] = 2;`, "var int[] xs = [];", "xs.push(m.len());",
                       "var f = twice;", "print(f(xs.pop()));", `print(str_join(str_split("a,b", ","), "\\t"));`, "var n = Node { val: 1 };", "print(n.next == none);")));
        const uri = c.open(f);
        await c.compilerDiagnostics(uri, none);
        expectEq(c.diagnostics.get(uri), [], "all diagnostics (including the quick checks)");
    } },
    { name: "server: completions include the string library and new keywords", run: async c => {
        const f = write("s11.l", main(`print(1);`));
        const uri = c.open(f);
        await c.compilerDiagnostics(uri, none);
        const items = await c.request("textDocument/completion", { textDocument: { uri }, position: { line: 1, character: 0 } });
        const labels = new Set((items.items ?? items).map(i => i.label));
        for (const want of ["str_split", "str_trim", "floattostr", "strtofloat", "none", "map"])
            if (!labels.has(want)) throw new Error(`missing completion ${want}`);
    } },
    { name: "server: array and map methods are completed after a dot", run: async c => {
        const src = main(lines("var int[] xs = [];", "var map<string, int> m = {};", "xs.", "m."));
        const f = write("s12.l", src);
        const uri = c.open(f);
        const at = async line => {
            const items = await c.request("textDocument/completion", { textDocument: { uri }, position: { line, character: src.split("\n")[line].length } });
            return (items.items ?? items).map(i => i.label).sort();
        };
        expectEq(await at(3), ["insert", "len", "pop", "push", "remove"], "array methods");
        expectEq(await at(4), ["has", "keys", "len", "remove"], "map methods");
    } },
];

(async () => {
    let passed = 0, failed = 0, skipped = 0;
    const pick = ts => ts.filter(t => !filter || t.name.includes(filter));
    const report = (t, e) => {
        if (!e) { passed++; console.log(`  ✓ ${t.name}`); return; }
        failed++;
        console.log(`  ✗ ${t.name}\n      ${e.message}`);
    };
    console.log("Server tests\n");
    for (const t of pick(checkTests)) {
        try { t.run(); report(t); } catch (e) { report(t, e); }
    }
    const tests = pick(serverTests);
    let hasDeps = true;
    try { require.resolve("vscode-languageserver/node", { paths: [path.dirname(SERVER)] }); } catch { hasDeps = false; }
    if (!hasDeps && tests.length) {
        skipped = tests.length;
        console.log(`  - ${skipped} language server tests skipped: server/node_modules has no vscode-languageserver`);
    } else if (tests.length) {
        const c = new Client();
        await c.start();
        for (const t of tests) {
            try { await t.run(c); report(t); } catch (e) { report(t, e); }
        }
        await c.stop();
    }
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(`\n${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ""}`);
    process.exit(failed ? 1 : 0);
})();
