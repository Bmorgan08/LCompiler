// Standard library test suite - every function in stdlib/math.l and stdlib/graphics.l.
// Run: node Test/StdlibTests.js [filter] [--verbose] [--memcheck] [--leaks] [--gfx] [--bugs]
//
// Tests that open a window are only run with --gfx.

const { runSuite } = require("./harness");

// prints "ok" when |got - want| <= tol, otherwise the value it got
const APPROX = `
function approx(float got, float want, float tol) {
    var float d = got - want;
    if (d < 0.0) { d = -d; }
    if (d <= tol) {
        print("ok");
    } else {
        print(got);
    }
    return 0;
}
`;

const mathMain = body => `import math;\n${APPROX}\nmain() {\n${body}\n    return 0;\n}\n`;
const gfxMain = body => `import graphics;\nimport math;\nmain() {\n${body}\n    return 0;\n}\n`;

// L float literal for a JS number: always has a decimal point, never an exponent
function fl(x) {
    return Number.isInteger(x) ? x.toFixed(1) : x.toFixed(20).replace(/0+$/, "");
}

// one approx() line per [expression, expected, tolerance]
function approxTest(name, cases, extra = {}) {
    return {
        name,
        source: mathMain(cases.map(([expr, want, tol]) => `    approx(${expr}, ${fl(want)}, ${fl(tol)});`).join("\n")),
        expected: cases.map(() => "ok").join("\n"),
        ...extra,
    };
}

// one print() line per [expression, expected]
function intTest(name, cases, extra = {}) {
    return {
        name,
        source: mathMain(cases.map(([expr]) => `    print(${expr});`).join("\n")),
        expected: cases.map(([, want]) => want).join("\n"),
        ...extra,
    };
}

const tests = [

    // ── Integer helpers ──────────────────────────────────────────────────

    intTest("math_abs", [["math_abs(5)", 5], ["math_abs(-5)", 5], ["math_abs(0)", 0], ["math_abs(-2147483647)", 2147483647]]),
    intTest("math_abs of a 64-bit value", [["math_abs(-3000000 * 3000) / 1000", 9000000]]),
    intTest("math_max", [["math_max(3, 9)", 9], ["math_max(9, 3)", 9], ["math_max(-1, -7)", -1], ["math_max(4, 4)", 4]]),
    intTest("math_min", [["math_min(3, 9)", 3], ["math_min(9, 3)", 3], ["math_min(-1, -7)", -7], ["math_min(4, 4)", 4]]),

    // ── Conversion ───────────────────────────────────────────────────────

    intTest("math_toint truncates towards zero", [
        ["math_toint(2.9)", 2], ["math_toint(-2.9)", -2], ["math_toint(0.0)", 0], ["math_toint(0.999)", 0], ["math_toint(-0.5)", 0],
    ]),
    intTest("math_toint of a value above 2^31", [["math_toint(12345678901.0) / 1000", 12345678]]),
    approxTest("math_tofloat", [["math_tofloat(7) * 0.5", 3.5, 0.0], ["math_tofloat(-3) / 2.0", -1.5, 0.0], ["math_tofloat(0)", 0.0, 0.0]]),

    // ── Rounding (table in LANGUAGE.md) ─────────────────────────────────

    intTest("math_floor", [
        ["math_floor(2.5)", 2], ["math_floor(-2.5)", -3], ["math_floor(2.0)", 2], ["math_floor(-2.0)", -2],
        ["math_floor(0.0)", 0], ["math_floor(-0.5)", -1], ["math_floor(0.5)", 0],
    ]),
    intTest("math_roof", [
        ["math_roof(2.5)", 3], ["math_roof(-2.5)", -2], ["math_roof(2.0)", 2], ["math_roof(-2.0)", -2],
        ["math_roof(0.1)", 1], ["math_roof(-0.1)", 0], ["math_roof(0.0)", 0],
    ]),
    intTest("math_round", [["math_round(2.5)", 3], ["math_round(2.4)", 2], ["math_round(2.6)", 3], ["math_round(-2.5)", -3], ["math_round(3.0)", 3]]),
    // LANGUAGE.md documents that negative inputs currently round like floor
    intTest("math_round negative behaves like floor (documented)", [["math_round(-2.3)", -3], ["math_round(-2.7)", -3]]),

    // ── Float arithmetic ─────────────────────────────────────────────────

    approxTest("math_fmod", [
        ["math_fmod(7.5, 2.0)", 1.5, 1e-12], ["math_fmod(-7.5, 2.0)", -1.5, 1e-12],
        ["math_fmod(6.0, 3.0)", 0.0, 1e-12], ["math_fmod(1.0, 3.0)", 1.0, 1e-12],
    ]),
    approxTest("math_sqrt of small integers", [
        ["math_sqrt(0.0)", 0.0, 0.0], ["math_sqrt(1.0)", 1.0, 1e-12], ["math_sqrt(4.0)", 2.0, 1e-12],
        ["math_sqrt(9.0)", 3.0, 1e-12], ["math_sqrt(2.0)", 1.4142135623730951, 1e-12],
    ]),
    approxTest("math_sqrt of fractions", [["math_sqrt(0.25)", 0.5, 1e-12], ["math_sqrt(0.01)", 0.1, 1e-12]]),
    approxTest("math_sqrt of negative returns 0 (documented)", [["math_sqrt(-4.0)", 0.0, 0.0]]),
    approxTest("math_sqrt of a large value", [["math_sqrt(1000000000000.0)", 1000000.0, 1e-6]]),
    approxTest("math_sqrt of a tiny value", [["math_sqrt(0.0000000001)", 0.00001, 1e-12]]),

    approxTest("math_sqrt across magnitudes", [
        ["math_sqrt(123456789.0)", 11111.111060555555, 1e-8], ["math_sqrt(1000000000000000.0)", 31622776.601683792, 1e-6],
        ["math_sqrt(3.0)", 1.7320508075688772, 1e-14], ["math_sqrt(0.3)", 0.5477225575051661, 1e-14],
        ["math_sqrt(0.5)", 0.7071067811865476, 1e-14], ["math_sqrt(0.000001)", 0.001, 1e-15],
    ]),
    approxTest("math_ln of values below 1", [
        ["math_ln(0.9)", -0.10536051565782628, 1e-8], ["math_ln(0.1)", -2.3025850929940455, 1e-8],
        ["math_ln(0.001)", -6.907755278982137, 1e-8], ["math_ln(0.000001)", -13.815510557964274, 1e-7],
        ["math_ln(1.5)", 0.4054651081081644, 1e-8],
    ]),
    approxTest("math_ln at 1, e and 2", [
        ["math_ln(1.0)", 0.0, 1e-9], ["math_ln(2.718281828459045)", 1.0, 1e-8], ["math_ln(2.0)", 0.6931471805599453, 1e-8],
    ]),
    approxTest("math_ln of large values", [["math_ln(10.0)", 2.302585092994046, 1e-8], ["math_ln(1000.0)", 6.907755278982137, 1e-8], ["math_ln(1000000.0)", 13.815510557964274, 1e-7]]),
    approxTest("math_ln of 0.5", [["math_ln(0.5)", -0.6931471805599453, 1e-8]]),
    approxTest("math_ln of a small value", [["math_ln(0.01)", -4.605170185988091, 1e-6]]),
    approxTest("math_ln of 0 and negatives returns 0 (documented)", [["math_ln(0.0)", 0.0, 0.0], ["math_ln(-3.0)", 0.0, 0.0]]),

    approxTest("math_pow within the documented range", [
        ["math_pow(9.0, 0.5)", 3.0, 1e-4], ["math_pow(2.0, 0.5)", 1.4142135623730951, 1e-7],
        ["math_pow(10.0, 0.3)", 1.9952623149688795, 1e-5], ["math_pow(1.5, 2.0)", 2.25, 1e-4], ["math_pow(5.0, 0.0)", 1.0, 0.0],
    ]),

    // outside |exp * ln(base)| < 2 LANGUAGE.md documents that math_pow drifts
    approxTest("math_pow outside the documented range", [["math_pow(2.0, 3.0)", 8.0, 1e-6], ["math_pow(2.0, 10.0)", 1024.0, 1e-3]], { bug: "S3" }),

    // ── Trigonometry (about 8 significant digits, per LANGUAGE.md) ──────

    approxTest("math_sin at key angles", [
        ["math_sin(0.0)", 0.0, 1e-7], ["math_sin(0.5235987756)", 0.5, 1e-7], ["math_sin(1.5707963268)", 1.0, 1e-7],
        ["math_sin(3.1415926536)", 0.0, 1e-7], ["math_sin(4.7123889804)", -1.0, 1e-7], ["math_sin(-1.5707963268)", -1.0, 1e-7],
    ]),
    approxTest("math_sin of angles outside [-pi, pi]", [
        ["math_sin(4.0)", -0.7568024953079282, 1e-7], ["math_sin(7.0)", 0.6569865987187891, 1e-7],
        ["math_sin(100.0)", -0.5063656411097588, 1e-6], ["math_sin(-100.0)", 0.5063656411097588, 1e-6],
    ]),
    approxTest("math_cos at key angles", [
        ["math_cos(0.0)", 1.0, 1e-7], ["math_cos(3.1415926536)", -1.0, 1e-7], ["math_cos(1.5707963268)", 0.0, 1e-7],
        ["math_cos(2.0)", -0.4161468365471424, 1e-7], ["math_cos(-3.0)", -0.9899924966004454, 1e-7],
    ]),
    approxTest("math_cos of large angles", [["math_cos(100.0)", 0.8623188722876839, 1e-6], ["math_cos(10000.0)", -0.9521553682590148, 1e-5]]),
    approxTest("sin^2 + cos^2 = 1", [
        ["math_sin(0.7) * math_sin(0.7) + math_cos(0.7) * math_cos(0.7)", 1.0, 1e-7],
        ["math_sin(2.9) * math_sin(2.9) + math_cos(2.9) * math_cos(2.9)", 1.0, 1e-7],
    ]),
    approxTest("math_tan", [
        ["math_tan(0.0)", 0.0, 1e-7], ["math_tan(0.7853981634)", 1.0, 1e-7],
        ["math_tan(1.0)", 1.5574077246549023, 1e-6], ["math_tan(-0.5)", -0.5463024898437905, 1e-7],
    ]),

    // ── graphics (no window) ─────────────────────────────────────────────

    { name: "graphics: program importing graphics compiles and runs",
      source: gfxMain(`    print(1);`), expected: "1" },
    { name: "graphics: default WIDTH and HEIGHT",
      source: gfxMain(`    print(WIDTH);\n    print(HEIGHT);`), expected: "800\n600" },
    { name: "graphics: key constants",
      source: gfxMain(["KEY_SPACE", "KEY_A", "KEY_D", "KEY_S", "KEY_W", "KEY_ESCAPE", "KEY_ENTER", "KEY_RIGHT", "KEY_LEFT", "KEY_DOWN", "KEY_UP", "KEY_SHIFT"]
                      .map(k => `    print(${k});`).join("\n")),
      expected: "32\n65\n68\n83\n87\n256\n257\n262\n263\n264\n265\n340" },
    { name: "graphics: gfx_log",
      source: gfxMain(`    gfx_log("hello");`), expected: "[gfx] hello" },
    // passes only because rax happens to be 0 - see B23 and the --gfx test below
    { name: "graphics: gfx_get_time returns a float (0 before gfx_init)",
      source: gfxMain(`    var float t = gfx_get_time();\n    print(t);`), expected: "0" },

    // ── graphics (window, --gfx) ─────────────────────────────────────────

    { name: "graphics: open window, draw every primitive, close", gfx: true,
      source: gfxMain(`    gfx_init(320, 240);
    print(WIDTH);
    print(HEIGHT);
    var int frame = 0;
    while (frame < 10) {
        gfx_clear(0x101010);
        gfx_set_pixel(5, 5, 0xFFFFFF);
        gfx_hline(0, 10, 100, 0xFF0000);
        gfx_vline(10, 0, 100, 0x00FF00);
        gfx_line(0, 0, 319, 239, 0x0000FF);
        gfx_rect(50, 50, 40, 30, 0xFFFF00);
        gfx_rect_border(100, 100, 40, 30, 0x00FFFF);
        gfx_present();
        frame++;
    }
    print(gfx_closed());
    print(gfx_key(KEY_SPACE));
    gfx_destroy_window();`),
      expected: "320\n240\n0\n0" },
    { name: "graphics: gfx_get_time increases after gfx_init", gfx: true, bug: "B23",
      source: gfxMain(`    gfx_init(64, 64);
    var float a = gfx_get_time();
    var int frame = 0;
    while (frame < 5) {
        gfx_present();
        frame++;
    }
    var float b = gfx_get_time();
    gfx_destroy_window();
    if (b > a) { print(1); } else { print(0); }
    if (a >= 0.0) { print(1); } else { print(0); }`),
      expected: "1\n1" },
];

runSuite("Stdlib tests", tests);
