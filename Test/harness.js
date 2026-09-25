// Shared runner for LanguageTests.js and StdlibTests.js.
//
// A test is an object:
//   name       unique description
//   source     L program
//   expected   expected stdout (compared after trimming trailing whitespace)
//   exact      compare stdout exactly, without trimming
//   stdin      text fed to the program
//   files      extra files to write next to the source, e.g. { "headers/util.l": "..." }
//   shouldError  compilation must fail; errorMatch (RegExp) is checked against the compiler's stderr
//   exitCode   expected exit status of the program (default 0 is not checked unless set)
//   memcheck   also relink the program with AddressSanitizer and fail on any memory error
//              (invalid/double free, heap overflow, use-after-free seen by libc calls)
//   leaks      with memcheck, also fail on memory leaks
//   bug        id from known-bugs.js: the test documents a known bug and is expected to fail.
//              If it passes, it is reported as XPASS so the marker can be removed.
//   gfx        needs a display; only run with --gfx
//
// Usage: node Test/<Suite>.js [filter] [--verbose] [--memcheck] [--leaks] [--gfx] [--bugs]
//   filter      only run tests whose name contains this text
//   --verbose   print compiler output and program output for failures
//   --memcheck  memory-check every test, not just the ones marked memcheck
//   --leaks     also report memory leaks in memory-checked tests
//   --gfx       include tests that open a window
//   --bugs      only run tests marked with a bug id

const { execFile } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const knownBugs = require("./known-bugs");

const ROOT = path.resolve(__dirname, "..");
const COMPILER = path.join(ROOT, "dist", "Main.js");
const COMPILE_TIMEOUT = 30000;
const RUN_TIMEOUT = 10000;

let hasAsan = null;
function asanAvailable() {
    if (hasAsan === null) {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ltest-asan-"));
        try {
            fs.writeFileSync(path.join(dir, "t.c"), "int main(void) { return 0; }\n");
            require("child_process").execFileSync("gcc", ["-fsanitize=address", "t.c", "-o", "t"], { cwd: dir, stdio: "pipe" });
            require("child_process").execFileSync(path.join(dir, "t"), { stdio: "pipe" });
            hasAsan = true;
        } catch {
            hasAsan = false;
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }
    return hasAsan;
}

function run(cmd, args, opts) {
    return new Promise(resolve => {
        const child = execFile(cmd, args, { ...opts, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
            resolve({
                code: err ? (typeof err.code === "number" ? err.code : null) : 0,
                signal: err?.signal ?? null,
                timedOut: err?.killed === true,
                stdout: stdout.toString(),
                stderr: stderr.toString(),
            });
        });
        if (opts.input !== undefined) {
            // the program may exit without reading stdin
            child.stdin.on("error", () => {});
            child.stdin.end(opts.input);
        }
    });
}

async function runTest(test, flags) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ltest-"));
    try {
        const src = path.join(dir, "main.l");
        const bin = path.join(dir, "main");
        fs.writeFileSync(src, test.source);
        for (const [rel, content] of Object.entries(test.files ?? {})) {
            fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
            fs.writeFileSync(path.join(dir, rel), content);
        }

        const compile = await run("node", [COMPILER, src, bin], { cwd: dir, timeout: COMPILE_TIMEOUT });
        if (compile.timedOut) {
            return { ok: false, reason: `compiler did not finish within ${COMPILE_TIMEOUT / 1000}s` };
        }
        if (test.shouldError) {
            if (compile.code === 0) return { ok: false, reason: "expected a compile error but it compiled" };
            if (test.errorMatch && !test.errorMatch.test(compile.stderr)) {
                return { ok: false, reason: `compile error did not match ${test.errorMatch}`, detail: compile.stderr };
            }
            return { ok: true };
        }
        if (compile.code !== 0) {
            return { ok: false, reason: "compile failed", detail: compile.stderr.trim() };
        }

        const env = { ...process.env, MALLOC_PERTURB_: "165" };
        const result = await run(bin, [], { cwd: dir, timeout: RUN_TIMEOUT, env, input: test.stdin ?? "" });
        if (result.timedOut) return { ok: false, reason: `program did not finish within ${RUN_TIMEOUT / 1000}s`, detail: result.stdout.slice(0, 2000) };
        if (result.signal) return { ok: false, reason: `program killed by ${result.signal}`, detail: result.stdout.slice(0, 2000) };
        if (test.exitCode !== undefined && result.code !== test.exitCode) {
            return { ok: false, reason: `exit code ${result.code}, expected ${test.exitCode}`, detail: result.stdout.slice(0, 2000) };
        }
        if (test.exitCode === undefined && result.code !== 0 && result.code !== null) {
            // main's return value becomes the exit code; tests all return 0
            return { ok: false, reason: `exit code ${result.code}`, detail: result.stdout.slice(0, 2000) };
        }

        const got = test.exact ? result.stdout : result.stdout.trimEnd();
        const want = test.exact ? test.expected : String(test.expected).trimEnd();
        if (got !== want) {
            return { ok: false, reason: "wrong output", expected: want, got };
        }

        if ((test.memcheck || flags.memcheck) && asanAvailable()) {
            // relink the generated assembly the same way Main.ts does, plus AddressSanitizer
            const graphicsO = path.join(ROOT, "Typescript", "runtime", "graphics.o");
            const asm = await run("nasm", ["-f", "elf64", "main.asm", "-o", "main.o"], { cwd: dir });
            const link = asm.code === 0 && await run("gcc", ["main.o", graphicsO, "-o", "main_asan", "-no-pie", "-fsanitize=address", "-lglfw", "-lGL"], { cwd: dir });
            if (!link || link.code !== 0) {
                return { ok: false, reason: "could not relink with AddressSanitizer", detail: (link ? link.stderr : asm.stderr).trim() };
            }
            const asanEnv = { ...process.env, ASAN_OPTIONS: `detect_leaks=${test.leaks || flags.leaks ? 1 : 0}:exitcode=99` };
            const mc = await run(path.join(dir, "main_asan"), [], { cwd: dir, timeout: RUN_TIMEOUT * 3, env: asanEnv, input: test.stdin ?? "" });
            if (mc.code === 99 || mc.signal || /AddressSanitizer|LeakSanitizer/.test(mc.stderr)) {
                const report = mc.stderr.split("\n").filter(l => /ERROR|SUMMARY|^    #[0-4] /.test(l)).slice(0, 8).join("\n");
                return { ok: false, reason: "AddressSanitizer reported a memory error", detail: report };
            }
        }
        return { ok: true };
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

async function runSuite(title, tests) {
    const args = process.argv.slice(2);
    const flags = {
        verbose: args.includes("--verbose"),
        memcheck: args.includes("--memcheck"),
        leaks: args.includes("--leaks"),
        gfx: args.includes("--gfx"),
        bugsOnly: args.includes("--bugs"),
    };
    const filter = args.find(a => !a.startsWith("--"));

    const names = new Set();
    for (const t of tests) {
        if (names.has(t.name)) throw new Error(`duplicate test name: ${t.name}`);
        names.add(t.name);
        if (t.bug && !knownBugs[t.bug]) throw new Error(`test '${t.name}' refers to unknown bug id ${t.bug}`);
    }

    const selected = tests.filter(t =>
        (!filter || t.name.includes(filter)) &&
        (!t.gfx || flags.gfx) &&
        (!flags.bugsOnly || t.bug));
    const skipped = tests.length - selected.length;

    if (!fs.existsSync(COMPILER)) {
        console.error(`${COMPILER} not found - run 'npx tsc' first`);
        process.exit(2);
    }

    console.log(`${title}: ${selected.length} tests${skipped ? ` (${skipped} skipped)` : ""}\n`);

    const results = new Array(selected.length);
    let next = 0;
    const workers = Array.from({ length: Math.max(1, os.cpus().length) }, async () => {
        while (next < selected.length) {
            const i = next++;
            results[i] = await runTest(selected[i], flags);
        }
    });
    await Promise.all(workers);

    const counts = { pass: 0, fail: 0, xfail: 0, xpass: 0 };
    const bugsSeen = new Map();
    selected.forEach((test, i) => {
        const r = results[i];
        let status;
        if (test.bug) {
            status = r.ok ? "xpass" : "xfail";
            if (!bugsSeen.has(test.bug)) bugsSeen.set(test.bug, { xfail: 0, xpass: 0 });
            bugsSeen.get(test.bug)[status]++;
        } else {
            status = r.ok ? "pass" : "fail";
        }
        counts[status]++;

        const mark = { pass: "✓", fail: "✗", xfail: "·", xpass: "!" }[status];
        const tag = test.bug ? ` [${test.bug}]` : "";
        if (status === "pass" || (status === "xfail" && !flags.verbose)) {
            console.log(`  ${mark} ${test.name}${tag}`);
            return;
        }
        console.log(`  ${mark} ${test.name}${tag}${status === "xpass" ? "  (known bug no longer reproduces - remove the marker?)" : ""}`);
        if (status === "fail" || flags.verbose) {
            console.log(`      ${r.reason}`);
            if (r.expected !== undefined) {
                console.log(`      expected: ${JSON.stringify(r.expected).slice(0, 400)}`);
                console.log(`      got:      ${JSON.stringify(r.got).slice(0, 400)}`);
            }
            if (r.detail) console.log(r.detail.split("\n").map(l => "      | " + l).join("\n"));
        }
    });

    console.log(`\n${counts.pass} passed, ${counts.fail} failed, ${counts.xfail} known-bug failures, ${counts.xpass} known bugs now passing`);
    if (bugsSeen.size) {
        console.log("\nKnown bugs exercised:");
        for (const [id, c] of [...bugsSeen].sort()) {
            console.log(`  ${id.padEnd(4)} ${c.xfail} failing, ${c.xpass} passing  - ${knownBugs[id].title}`);
        }
    }
    if ((selected.some(t => t.memcheck) || flags.memcheck) && !asanAvailable()) {
        console.log("\nAddressSanitizer unavailable (gcc -fsanitize=address failed): memory checks were skipped");
    }
    process.exitCode = counts.fail || counts.xpass ? 1 : 0;
}

module.exports = { runSuite };
