// Kernels written in L (--kernel): each test builds a small kernel with Test/kernel/boot.asm and
// linker.ld, boots it in QEMU and checks what it writes to the serial port.
// Run: node Test/KernelTests.js [filter] [--verbose]
// Needs nasm, ld, objcopy and qemu-system-x86_64; without QEMU the boot tests are skipped.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync, spawn } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const COMPILER = path.join(ROOT, "dist", "Main.js");
const BOOT = path.join(__dirname, "kernel", "boot.asm");
const LINKER = path.join(__dirname, "kernel", "linker.ld");
const verbose = process.argv.includes("--verbose");
const filter = process.argv.slice(2).find(a => !a.startsWith("--"));
const BOOT_TIMEOUT = 30000;

// the hooks every test kernel has: output to the serial port, pages from 4 MiB up, a panic that
// prints the message and exits QEMU (isa-debug-exit: status (code << 1) | 1)
const hooks = ({ alloc = true, read = false } = {}) => `
var u64 next_page = 0x400000;
var u64 pages_given = 0;

function qemu_exit(u8 code) {
    outb(0xF4, code);
    return 0;
}

function serial_write(u8 c) {
    while ((inb(0x3FD) & 0x20) == 0) { }
    outb(0x3F8, c);
    return 0;
}

function kernel_write(ptr<u8> text, u64 len) {
    var u64 i = 0;
    while (i < len) {
        serial_write(text[i]);
        i++;
    }
    return 0;
}

function kernel_panic(ptr<u8> message, u64 len) {
    kernel_write(ptr<u8>("PANIC: "), 7);
    kernel_write(message, len);
    kernel_write(ptr<u8>("\\n"), 1);
    qemu_exit(1);
    return 0;
}
` + (alloc ? `
function kernel_alloc_pages(u64 count): u64 {
    var u64 start = next_page;
    next_page += count * 4096;
    pages_given += count;
    return start;
}
` : "") + (read ? `
// one line from the serial port (waits for each byte)
function kernel_read(ptr<u8> buf, u64 max): u64 {
    var u64 n = 0;
    while (n < max) {
        while ((inb(0x3FD) & 0x01) == 0) { }
        var u8 c = inb(0x3F8);
        buf[n] = c;
        n++;
        if (c == '\\n') { return n; }
    }
    return n;
}
` : "");

// a test kernel: the hooks, the test's code (a run() function and anything it needs), and a
// kernel_main that runs it and exits QEMU
const kernel = (body, opts) => hooks(opts) + body + `
function kernel_main() {
    run();
    qemu_exit(0);
    return 0;
}
`;

// an IDT built from L: gates in a packed struct table at 3 MiB, loaded with lidt from assembly
const IDT = `
packed struct IdtEntry {
    var low: u16;
    var sel: u16;
    var ist: u8;
    var flags: u8;
    var mid: u16;
    var high: u32;
    var zero: u32;
}
packed struct IdtPtr {
    var limit: u16;
    var base: u64;
}
extern fn load_idt(u64 idt_ptr);
extern fn read_cr2(): u64;

var ptr<IdtEntry> IDT_TABLE = 0x300000;
var ptr<IdtPtr> IDTR = 0x301000;

function set_gate(int vector, u64 handler) {
    IDT_TABLE[vector].low = u16(handler);
    IDT_TABLE[vector].sel = 0x08;
    IDT_TABLE[vector].ist = 0;
    IDT_TABLE[vector].flags = 0x8E;
    IDT_TABLE[vector].mid = u16(handler >> 16);
    IDT_TABLE[vector].high = u32(handler >> 32);
    IDT_TABLE[vector].zero = 0;
    return 0;
}

function install_idt() {
    IDTR.limit = u16(256 * 16 - 1);
    IDTR.base = u64(IDT_TABLE);
    load_idt(u64(IDTR));
    return 0;
}

// the PIC's IRQs 0-15 moved to vectors 32-47 (their default overlaps CPU exceptions); only IRQ 0 (the timer) on
function remap_pic() {
    outb(0x20, 0x11);
    outb(0xA0, 0x11);
    outb(0x21, 0x20);
    outb(0xA1, 0x28);
    outb(0x21, 0x04);
    outb(0xA1, 0x02);
    outb(0x21, 0x01);
    outb(0xA1, 0x01);
    outb(0x21, 0xFE);
    outb(0xA1, 0xFF);
    return 0;
}

// the PIT's channel 0 at hz interrupts a second
function start_timer(int hz) {
    var int divisor = 1193182 / hz;
    outb(0x43, 0x36);
    outb(0x40, u8(divisor & 0xFF));
    outb(0x40, u8(divisor >> 8));
    return 0;
}
`;
const IDT_ASM = `bits 64
section .text
global load_idt
load_idt:
    lidt [rdi]
    ret
global read_cr2
read_cr2:
    mov rax, cr2
    ret
`;

const tests = [
    // ── Booting ──
    { name: "boot: print() reaches kernel_write",
      source: kernel(`function run() {\n    print("hello from L");\n    print(42);\n    return 0;\n}\n`),
      expected: "hello from L\n42", exitCode: 1 },
    { name: "boot: globals are set up before kernel_main runs",
      source: kernel(`var int answer = 6 * 7;\nvar string greeting = "hi";\nvar ptr<u16> vga = 0xB8000;\nfunction run() {\n    print(answer);\n    print(greeting);\n    print(u64(vga));\n    return 0;\n}\n`),
      expected: "42\nhi\n753664", exitCode: 1 },
    { name: "boot: floats work (boot.asm turns SSE on)",
      source: kernel(`function run() {\n    var float f = 1.5;\n    print(f * 3.0);\n    print(floattostr(0.25));\n    return 0;\n}\n`),
      expected: "4.5\n0.25", exitCode: 1 },
    { name: "boot: the screen is VGA memory at 0xB8000",
      source: kernel(`function run() {\n    var ptr<u16> vga = 0xB8000;\n    vga[0] = 0x0F00 + 'L';\n    vga[1] = 0x0F00 + '!';\n    print(vga[0] & 0xFF);\n    print(vga[1] >> 8);\n    return 0;\n}\n`),
      expected: "76\n15", exitCode: 1 },

    // ── The heap, through kernel_alloc_pages ──
    { name: "heap: strings, arrays, maps and structs",
      source: kernel(`struct P {\n    var name: string;\n    var n: int;\n}\nfunction run() {\n    var string s = "";\n    var i = 0;\n    while (i < 100) {\n        s = s + inttostr(i % 10);\n        i++;\n    }\n    print(len(s));\n    var int[] xs = [];\n    i = 0;\n    while (i < 1000) {\n        xs.push(i);\n        i++;\n    }\n    print(xs[999]);\n    var map<string, P> m = {};\n    m["a"] = P { name: "alpha", n: 1 };\n    print(m["a"].name);\n    print(pages_given > 0);\n    return 0;\n}\n`),
      expected: "100\n999\nalpha\n1", exitCode: 1 },
    { name: "heap: the string library works in a kernel",
      source: kernel(`function run() {\n    print(str_join(str_split(str_trim("  a b c  "), " "), "+"));\n    print(strtofloat("2.5") * 2.0);\n    return 0;\n}\n`),
      expected: "a+b+c\n5", exitCode: 1 },
    { name: "heap: without kernel_alloc_pages the runtime panics with a message",
      source: kernel(`function run() {\n    var int[] xs = [1, 2, 3];\n    print(xs[0]);\n    return 0;\n}\n`, { alloc: false }),
      expected: "PANIC: L runtime: out of memory (the kernel has no kernel_alloc_pages)", exitCode: 3 },

    // ── Runtime errors call kernel_panic ──
    { name: "panic: an index out of bounds",
      source: kernel(`function run() {\n    var int[] xs = [1, 2, 3];\n    var i = 5;\n    print(1);\n    print(xs[i]);\n    return 0;\n}\n`),
      expected: "1\nPANIC: Error: index out of bounds", exitCode: 3 },
    { name: "panic: division by zero",
      source: kernel(`function run() {\n    var zero = 0;\n    print(10 / zero);\n    return 0;\n}\n`),
      expected: "PANIC: Error: division by zero", exitCode: 3 },
    { name: "panic: a missing map key",
      source: kernel(`function run() {\n    var map<string, int> m = {};\n    print(m["nope"]);\n    return 0;\n}\n`),
      expected: "PANIC: Error: key not found in map", exitCode: 3 },

    // ── Input, through kernel_read ──
    { name: "input: input() and inputstr() read from kernel_read",
      source: kernel(`function run() {\n    var n = input();\n    var string name = inputstr();\n    print(n * 2);\n    print("hello " + name);\n    return 0;\n}\n`, { read: true }),
      stdin: "21\nkernel\n", expected: "42\nhello kernel", exitCode: 1 },

    // ── Low-level features in ring 0 ──
    { name: "ring 0: packed structs in real memory",
      source: kernel(`packed struct Entry {\n    var low: u16;\n    var sel: u16;\n    var ist: u8;\n    var flags: u8;\n    var mid: u16;\n    var high: u32;\n    var zero: u32;\n}\nfunction run() {\n    var ptr<Entry> table = 0x200000;\n    var i = 0;\n    while (i < 256) {\n        table[i].sel = 0x08;\n        table[i].flags = 0x8E;\n        table[i].low = u16(i);\n        i++;\n    }\n    print(table[255].low + table[3].sel);\n    var ptr<u8> raw = 0x200000;\n    print(raw[16 * 7 + 5]);\n    return 0;\n}\n`),
      expected: "263\n142", exitCode: 1 },
    // ── Interrupts (interrupt fn) ──
    { name: "interrupt: int 0x80 runs the handler and comes back",
      source: IDT + kernel(`interrupt fn on_syscall(ptr<InterruptFrame> frame) {\n    print("in the handler");\n    print(frame.cs);\n    return 0;\n}\nfunction run() {\n    set_gate(0x80, addr(on_syscall));\n    install_idt();\n    asm { int 0x80 }\n    print("back");\n    asm { int 0x80 }\n    print("back again");\n    return 0;\n}\n`),
      asm: IDT_ASM, expected: "in the handler\n8\nback\nin the handler\n8\nback again", exitCode: 1 },
    { name: "interrupt: a breakpoint's frame has the address after int3",
      source: IDT + kernel(`var u64 seen_rip = 0;\ninterrupt fn on_breakpoint(ptr<InterruptFrame> frame) {\n    seen_rip = frame.rip;\n    return 0;\n}\nfunction run() {\n    set_gate(3, addr(on_breakpoint));\n    install_idt();\n    asm { int3 }\n    print(seen_rip > 0x100000);\n    print((frame_flags() >> 9) & 1);\n    return 0;\n}\n`) + `extern fn frame_flags(): u64;\n`,
      asm: IDT_ASM + `global frame_flags\nframe_flags:\n    pushfq\n    pop rax\n    ret\n`,
      expected: "1\n0", exitCode: 1 },
    { name: "interrupt: the timer (PIT through the PIC) ticks",
      source: IDT + kernel(`var int ticks = 0;\ninterrupt fn on_timer(ptr<InterruptFrame> frame) {\n    ticks++;\n    outb(0x20, 0x20);\n    return 0;\n}\nfunction run() {\n    remap_pic();\n    set_gate(32, addr(on_timer));\n    install_idt();\n    start_timer(1000);\n    asm { sti }\n    while (ticks < 5) {\n        asm { hlt }\n    }\n    asm { cli }\n    print(ticks >= 5);\n    return 0;\n}\n`),
      asm: IDT_ASM, expected: "1", exitCode: 1 },
    { name: "interrupt: registers and floats survive interrupts",
      source: IDT + kernel(`var int ticks = 0;\nvar float handler_float = 0.0;\ninterrupt fn on_timer(ptr<InterruptFrame> frame) {\n    ticks++;\n    var float mess = 3.75 * 2.0;\n    handler_float = handler_float + mess;\n    outb(0x20, 0x20);\n    return 0;\n}\nfunction run() {\n    remap_pic();\n    set_gate(32, addr(on_timer));\n    install_idt();\n    start_timer(10000);\n    asm { sti }\n    var float acc = 0.0;\n    var int isum = 0;\n    var int i = 0;\n    while (i < 2000000 || ticks < 20) {\n        if (i < 2000000) {\n            acc = acc + 0.5;\n            isum += i % 7;\n        }\n        i++;\n    }\n    asm { cli }\n    print(acc == 1000000.0);\n    print(isum);\n    print(ticks >= 20);\n    print(handler_float > 0.0);\n    return 0;\n}\n`),
      asm: IDT_ASM, expected: "1\n5999995\n1\n1", exitCode: 1 },
    { name: "interrupt: a page fault passes its error code",
      source: IDT + kernel(`interrupt fn on_page_fault(ptr<InterruptFrame> frame, u64 error_code) {\n    print(error_code);\n    print(read_cr2() == 0x80000000);\n    print(frame.cs);\n    qemu_exit(0);\n    return 0;\n}\nfunction run() {\n    set_gate(14, addr(on_page_fault));\n    install_idt();\n    var ptr<u8> unmapped = 0x80000000;\n    unmapped[0] = 1;\n    print("not reached");\n    return 0;\n}\n`),
      asm: IDT_ASM, expected: "2\n1\n8", exitCode: 1 },
    { name: "interrupt: the handler can change where the CPU returns to",
      source: IDT + kernel(`interrupt fn on_invalid_opcode(ptr<InterruptFrame> frame) {\n    print("skipping ud2");\n    frame.rip += 2;\n    return 0;\n}\nfunction run() {\n    set_gate(6, addr(on_invalid_opcode));\n    install_idt();\n    asm { ud2 }\n    print("carried on");\n    return 0;\n}\n`),
      asm: IDT_ASM, expected: "skipping ud2\ncarried on", exitCode: 1 },

    { name: "ring 0: a pointer with a literal address writes that address (B61)",
      source: kernel(`function where(): u64 {\n    return 0x200000;\n}\nfunction run() {\n    var ptr<u8> fixed = 0x200000;\n    fixed[0] = 42;\n    fixed[1] = 7;\n    var ptr<u8> computed = ptr<u8>(where());\n    print(computed[0]);\n    print(computed[1]);\n    var ptr<u16> vga = 0xB8000;\n    vga[3] = 0x0F41;\n    var ptr<u16> screen = ptr<u16>(where() - 0x200000 + 0xB8000);\n    print(screen[3]);\n    return 0;\n}\n`),
      expected: "42\n7\n3905", exitCode: 1 },
    { name: "boot: the allocator's globals are ready before heap globals are set up (B62)",
      source: hooks({ alloc: false }) + `var int[] TABLE = [10, 20, 30];\nvar string GREETING = "hi " + inttostr(TABLE[2]);\nvar u64 heap_next = 0x400000;\nfunction kernel_alloc_pages(u64 count): u64 {\n    var u64 start = heap_next;\n    heap_next += count * 4096;\n    return start;\n}\nfunction kernel_main() {\n    print(GREETING);\n    print(TABLE.len());\n    print(heap_next > 0x400000);\n    qemu_exit(0);\n    return 0;\n}\n`,
      expected: "hi 30\n3\n1", exitCode: 1 },
    { name: "ring 0: extern fn calls into assembly",
      source: `extern fn read_cr0(): u64;\n` + kernel(`function run() {\n    var u64 cr0 = read_cr0();\n    print((cr0 >> 31) & 1);\n    print(cr0 & 1);\n    return 0;\n}\n`),
      asm: `global read_cr0\nsection .text\nbits 64\nread_cr0:\n    mov rax, cr0\n    ret\n`,
      expected: "1\n1", exitCode: 1 },
];

// compile-only checks of --kernel (no QEMU needed)
const compileTests = [
    { name: "compile: --kernel makes an object and a runtime object",
      run: dir => {
          const src = path.join(dir, "k.l");
          fs.writeFileSync(src, kernel(`function run() {\n    print(1);\n    return 0;\n}\n`));
          const r = spawnSync("node", [COMPILER, src, path.join(dir, "k"), "--kernel"], { encoding: "utf8" });
          if (r.status !== 0) return `compile failed: ${r.stderr}`;
          for (const f of ["k.o", "k-runtime.o"]) if (!fs.existsSync(path.join(dir, f))) return `${f} missing`;
          if (fs.existsSync(path.join(dir, "k"))) return "a linked program was made";
          const syms = spawnSync("nm", [path.join(dir, "k-runtime.o")], { encoding: "utf8" }).stdout;
          if (/\b_start\b/.test(syms)) return "the kernel runtime defines _start";
          if (!/ W kernel_panic\b/.test(syms)) return "kernel_panic has no weak default";
          if (!/ T lrt_kernel_fail\b/.test(syms)) return "lrt_kernel_fail missing";
          const ksyms = spawnSync("nm", [path.join(dir, "k.o")], { encoding: "utf8" }).stdout;
          if (!/ T kernel_main\b/.test(ksyms)) return "kernel_main isn't a global symbol";
          if (/\bsyscall\b/.test(fs.readFileSync(path.join(dir, "k.asm"), "utf8"))) return "the kernel uses a Linux system call";
          return undefined;
      } },
    { name: "compile: a kernel's entry point is kernel_main, not main",
      run: dir => compileError(dir, `main() {\n    return 0;\n}\n`, /--kernel: a kernel's entry point is kernel_main, not main/) },
    { name: "compile: a kernel needs kernel_main",
      run: dir => compileError(dir, `function other() {\n    return 0;\n}\n`, /--kernel: a kernel needs a kernel_main function/) },
    { name: "compile: the graphics module can't be used in a kernel",
      run: dir => compileError(dir, `import graphics;\nfunction kernel_main() {\n    gfx_init(10, 10);\n    return 0;\n}\n`, /graphics module needs the C library, so it can't be used in a kernel/) },
];

function compileError(dir, source, re) {
    const src = path.join(dir, "e.l");
    fs.writeFileSync(src, source);
    const r = spawnSync("node", [COMPILER, src, path.join(dir, "e"), "--kernel"], { encoding: "utf8" });
    if (r.status === 0) return "expected a compile error but it compiled";
    return re.test(r.stderr) ? undefined : `error didn't match ${re}: ${r.stderr.trim()}`;
}

const have = tool => spawnSync("sh", ["-c", `command -v ${tool}`]).status === 0;

// a kernel as a GRUB ISO, the way a real OS boots: GRUB loads the 64-bit ELF itself
function bootSampleIso(dir, bootO) {
    const src = path.join(dir, "kernel.l");
    fs.writeFileSync(src, kernel(`function run() {\n    print("booted by GRUB");\n    print(str_split("a b c", " ").len());\n    return 0;\n}\n`));
    const compile = spawnSync("node", [COMPILER, src, path.join(dir, "kernel"), "--kernel"], { encoding: "utf8" });
    if (compile.status !== 0) return Promise.resolve({ error: `compile failed:\n${compile.stderr}` });
    const iso = path.join(dir, "iso");
    fs.mkdirSync(path.join(iso, "boot", "grub"), { recursive: true });
    const link = spawnSync("ld", ["-n", "--no-warn-rwx-segments", "-T", LINKER, bootO, path.join(dir, "kernel.o"), path.join(dir, "kernel-runtime.o"),
        "-o", path.join(iso, "boot", "kernel.elf")], { encoding: "utf8" });
    if (link.status !== 0) return Promise.resolve({ error: `link failed:\n${link.stderr}` });
    fs.writeFileSync(path.join(iso, "boot", "grub", "grub.cfg"), `set timeout=0\nmenuentry "L kernel" {\n    multiboot /boot/kernel.elf\n    boot\n}\n`);
    const mk = spawnSync("grub-mkrescue", ["-o", path.join(dir, "myos.iso"), iso], { encoding: "utf8" });
    if (mk.status !== 0) return Promise.resolve({ error: `grub-mkrescue failed:\n${mk.stderr}` });
    return new Promise(resolve => {
        const q = spawn("qemu-system-x86_64", ["-cdrom", path.join(dir, "myos.iso"), "-serial", "stdio", "-display", "none", "-monitor", "none",
            "-no-reboot", "-m", "128", "-device", "isa-debug-exit,iobase=0xf4,iosize=0x04"]);
        let output = "";
        const timer = setTimeout(() => q.kill("SIGKILL"), 90000);
        q.stdout.on("data", d => output += d);
        q.on("close", () => { clearTimeout(timer); resolve({ output }); });
    });
}

// build the kernel for a test and boot it; resolves to { output, status } or { error }
function bootTest(t, dir, bootO) {
    const src = path.join(dir, "kernel.l");
    fs.writeFileSync(src, t.source);
    const compile = spawnSync("node", [COMPILER, src, path.join(dir, "kernel"), "--kernel"], { encoding: "utf8" });
    if (compile.status !== 0) return Promise.resolve({ error: `compile failed:\n${compile.stderr}` });
    const objects = [bootO, path.join(dir, "kernel.o"), path.join(dir, "kernel-runtime.o")];
    if (t.asm) {
        fs.writeFileSync(path.join(dir, "extra.asm"), t.asm);
        const a = spawnSync("nasm", ["-f", "elf64", path.join(dir, "extra.asm"), "-o", path.join(dir, "extra.o")], { encoding: "utf8" });
        if (a.status !== 0) return Promise.resolve({ error: `nasm failed:\n${a.stderr}` });
        objects.push(path.join(dir, "extra.o"));
    }
    const elf = path.join(dir, "kernel.elf"), elf32 = path.join(dir, "kernel32.elf");
    const link = spawnSync("ld", ["-n", "--no-warn-rwx-segments", "-T", LINKER, ...objects, "-o", elf], { encoding: "utf8" });
    if (link.status !== 0) return Promise.resolve({ error: `link failed:\n${link.stderr}` });
    const copy = spawnSync("objcopy", ["-O", "elf32-i386", elf, elf32], { encoding: "utf8" });
    if (copy.status !== 0) return Promise.resolve({ error: `objcopy failed:\n${copy.stderr}` });
    return new Promise(resolve => {
        const q = spawn("qemu-system-x86_64", ["-kernel", elf32, "-serial", "stdio", "-display", "none", "-monitor", "none",
            "-no-reboot", "-m", "128", "-device", "isa-debug-exit,iobase=0xf4,iosize=0x04"]);
        let output = "";
        q.stdout.on("data", d => output += d);
        q.stderr.on("data", d => output += d);
        const timer = setTimeout(() => q.kill("SIGKILL"), BOOT_TIMEOUT);
        q.on("close", status => { clearTimeout(timer); resolve({ output, status }); });
        q.stdin.on("error", () => {});
        q.stdin.end(t.stdin ?? "");
    });
}

(async () => {
    let passed = 0, failed = 0, skipped = 0;
    const report = (name, problem, detail) => {
        if (!problem) { passed++; console.log(`  ✓ ${name}`); return; }
        failed++;
        console.log(`  ✗ ${name}\n      ${problem}`);
        if (detail && verbose) console.log(detail.split("\n").map(l => "      | " + l).join("\n"));
    };
    const pick = ts => ts.filter(t => !filter || t.name.includes(filter));
    console.log("Kernel tests\n");

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lkernel-"));
    for (const t of pick(compileTests)) {
        const sub = fs.mkdtempSync(path.join(dir, "c-"));
        report(t.name, t.run(sub));
    }

    const boots = pick(tests);
    const ISO_TEST = "iso: a kernel boots from a GRUB ISO";
    const wantIso = !filter || ISO_TEST.includes(filter);
    const missing = ["nasm", "ld", "objcopy", "qemu-system-x86_64"].filter(t => !have(t));
    if (missing.length && (boots.length || wantIso)) {
        skipped = boots.length + (wantIso ? 1 : 0);
        console.log(`  - ${skipped} boot tests skipped: ${missing.join(", ")} not found`);
    } else if (boots.length || wantIso) {
        const bootO = path.join(dir, "boot.o");
        const a = spawnSync("nasm", ["-f", "elf64", BOOT, "-o", bootO], { encoding: "utf8" });
        if (a.status !== 0) { console.log(`  boot.asm doesn't assemble:\n${a.stderr}`); process.exit(1); }
        const results = new Array(boots.length);
        let next = 0;
        await Promise.all(Array.from({ length: Math.min(4, os.cpus().length) }, async () => {
            while (next < boots.length) {
                const i = next++;
                results[i] = await bootTest(boots[i], fs.mkdtempSync(path.join(dir, "k-")), bootO);
            }
        }));
        if (wantIso) {
            const name = ISO_TEST;
            if (!have("grub-mkrescue") || !have("xorriso")) { skipped++; console.log(`  - ${name}: skipped (grub-mkrescue or xorriso not found)`); }
            else {
                const r = await bootSampleIso(fs.mkdtempSync(path.join(dir, "iso-")), bootO);
                const want = "booted by GRUB\n3";
                const got = (r.output ?? "").replace(/\r/g, "").trimEnd();
                report(name, r.error ? r.error.split("\n")[0] : got === want ? undefined : `wrong output\n      expected: ${JSON.stringify(want)}\n      got:      ${JSON.stringify(got)}`, r.error);
            }
        }
        boots.forEach((t, i) => {
            const r = results[i];
            if (r.error) return report(t.name, r.error.split("\n")[0], r.error);
            const got = r.output.replace(/\r/g, "").trimEnd();
            if (got !== t.expected) return report(t.name, `wrong output\n      expected: ${JSON.stringify(t.expected)}\n      got:      ${JSON.stringify(got)}`);
            if (t.exitCode !== undefined && r.status !== t.exitCode) return report(t.name, `QEMU exit status ${r.status}, expected ${t.exitCode}`, got);
            report(t.name);
        });
    }
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(`\n${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ""}`);
    process.exit(failed ? 1 : 0);
})();
