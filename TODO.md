# TODO

Open bugs from the test suites. Each one has tests marked with its id in
`Test/LanguageTests.js` / `Test/StdlibTests.js`; they are expected to fail until
the bug is fixed. `node Test/LanguageTests.js --bugs` runs just those tests, and a
fixed bug shows up as "known bugs now passing" so its marker can be removed.
Full diagnoses are in `Test/known-bugs.js`.

B21, B24 and B28 are one problem (who owns a string returned from a function) and
should be decided together.

## Memory ownership

- [ ] **B24 - Heap values owned by function-level variables are never freed (leak)**
  In `insertFrees` (Optimize.ts), `ret` only frees names in `allocatedSoFar`, which
  holds the allocating temps (`t1`), not the variables that took ownership (`s`), so
  only loop-body variables are ever freed. This contradicts the memory model in
  LANGUAGE.md. It can't just be switched on: returning a string literal or a
  parameter would then be freed twice (see B28).

- [ ] **B28 - Caller frees returned strings it does not own**
  Every call to a string-returning function is treated as a fresh heap value, so the
  receiving variable is freed at a loop back-edge even when the function returned a
  string literal or its parameter. Crashes with `free(): invalid pointer` inside a
  `while` loop. Options: callee always returns a fresh copy (`strdup` when returning
  a literal / parameter / global), or track ownership through calls.

- [ ] **B21 - A function returning its string parameter isn't treated as returning a string**
  `collectStringFunctions` (IR.ts) only counts string `VarDecl`s, not string
  parameters, so `print(same(s))` prints a pointer. Fixing the typing alone would make
  B28 hit these functions too, so fix it with the ownership decision.

## Language decisions

- [ ] **B20 - Expressions outside declarations and assignments aren't type-checked**
  `validate` for `Binary` (Validate.ts) only validates the operands; the type check
  lives in `inferType`, which only `VarDecl` / `Assign` / `ForIn` call. So
  `print(f + n)` with a float and an int compiles to garbage. Enforcing it matches
  LANGUAGE.md but would reject programs that compile today (e.g. `x < 0` on a float).
  If enforced, `char` should stay compatible with `int`.

- [ ] **B25 - `inputstr` reads one word, not a line**
  `fmt_str_in` (Emitter.ts) is `'%255s'`, which stops at whitespace; LANGUAGE.md says
  it reads a line. Switching to a line read has to keep `input(); inputstr();` working
  (the newline `input()` leaves behind) and handle empty lines.

- [ ] **B19 - A header's own imports are looked up in `headers/headers/`**
  `resolveImports` (Main.ts) resolves nested imports relative to the header's
  directory, so `import b;` inside `headers/a.l` searches `headers/headers/b.l`.
  Decide whether imports should resolve relative to the importing file, the main
  source file, or both.

## Standard library

- [ ] **S3 - `math_pow` drifts outside |exp * ln(base)| < 2**
  `e^t` uses a 7-term Taylor series. Documented in LANGUAGE.md, but common calls are
  off: `math_pow(2, 3)` gives 7.989. Could reduce the range (e.g. split `t` into an
  integer part and a remainder) to make it accurate everywhere.

## To confirm

- [ ] **B23 - `gfx_get_time`** is fixed in the generated assembly but hasn't been run
  with a window. Run `node Test/StdlibTests.js --gfx`; if its test reports as now
  passing, remove the `bug: "B23"` marker.
