// Known bugs referenced by tests via `bug: "ID"`.
// A test marked with a bug is expected to fail until the bug is fixed; when it
// starts passing the harness reports XPASS so the marker can be removed.
//
// Ids: B = compiler, S = standard library. Line numbers are as of commit 9004ecc.

module.exports = {
    B1: {
        title: "64-bit ints are printed/read/converted as 32-bit",
        cause: "Emitter.ts:6-7 - fmt and fmt_in are '%d', so printf (print), scanf (input) and sprintf (inttostr) use a 32-bit int. " +
               "scanf writes 4 bytes into an 8-byte slot, leaving the upper half as stack garbage.",
        fixed: "Emitter.ts:6-7 - fmt and fmt_in changed from '%d' to '%ld'.",
    },
    B2: {
        title: "Constant folding loses float type and does int division in floating point",
        cause: "Optimize.ts:14-21 - folded arithmetic results are Number nodes without varType, so folded floats become ints " +
               "(fractional values are then emitted as invalid integer immediates); int '/' folds to a fraction instead of truncating.",
        fixed: "Optimize.ts fold: arithmetic with a float operand folds to a float-typed Number; int arithmetic folds with 64-bit wrapping BigInt maths ('/' truncates, division by zero is left for runtime).",
    },
    B3: {
        title: "Integer constants outside the signed 32-bit range are truncated when stored",
        cause: "Emitter.ts:151,316,328,799 - 'mov qword [mem], imm' only encodes a sign-extended 32-bit immediate; NASM truncates larger values with a warning.",
        fixed: "Emitter.ts storeImm(): constants outside the signed 32-bit range are stored through a scratch register (loadOperand, const, mov, field_store, array_new length).",
    },
    B4: {
        title: "printchar with a constant argument prints garbage",
        cause: "Emitter.ts:387 - printchar reads its argument with memRef() instead of loadOperand(); after copy propagation the argument is a literal, " +
               "so memRef reads an uninitialised stack slot named after the number.",
        fixed: "Emitter.ts printchar reads its argument with loadOperand() (handles literals and globals) instead of memRef().",
    },
    B5: {
        title: "Heap variable reassigned inside a while loop is freed at the end of every iteration (use-after-free)",
        cause: "Optimize.ts:285-291 - insertFrees gives a variable the loop depth of its latest assignment rather than of its declaration, " +
               "so the back-edge at Optimize.ts:330-340 frees the value the variable still holds.",
        fixed: "IR.ts marks declaration movs with decl: true; Optimize.ts insertFrees owns a named variable at its declaration depth (params at 0, undeclared slots at their first assignment) and never frees values moved into globals.",
    },
    B6: {
        title: "String concatenation always allocates 256 bytes (heap overflow for longer results)",
        cause: "Emitter.ts:778 - str_concat does malloc(256) regardless of the operand lengths.",
        fixed: "Emitter.ts str_concat allocates strlen(a) + strlen(b) + 1 bytes (length kept in a __concat_len frame slot, reserved in the frame-size pass).",
    },
    B7: {
        title: "Copy propagation reads a variable's new value through an old copy (x++ returns the new value)",
        cause: "Optimize.ts:189-196 - 'mov t = x' records t as an alias of x (and 'mov b = a' records b -> a), but redefining x/a " +
               "never invalidates those aliases, so later uses resolve to the variable's current value.",
        fixed: "Optimize.ts copyProp: killAliases() runs before any redefinition (and for globals before any call); aliases of the redefined name are dropped, and a dropped temp that is still read later is first written out with the old value.",
    },
    B8: {
        title: "Globals are treated as constants inside functions",
        cause: "Optimize.ts:119-132 - copyProp's environment is not reset at 'enter', so the global initialisers (emitted before the first function) " +
               "are propagated into every function: writes are lost and reads can come from an uninitialised temp slot.",
        fixed: "Optimize.ts copyProp resets its environment at 'enter' and never records values for globals; IR.ts keeps global float/string info across functions (and counts float globals in functionReturnsFloat); Emitter.ts works out string/float globals from their initialisers before main's code is emitted.",
    },
    B9: {
        title: "&& and || return the right operand's value instead of 0/1",
        cause: "IR.ts:419-420 - the right-hand value is stored as the result without normalising it to a bool.",
        fixed: "IR.ts &&/|| normalises the right operand with 'neq rhs, 0'.",
    },
    B10: {
        title: "Nested && / || free a result cell that was never allocated (free(): invalid pointer)",
        cause: "IR.ts:411-412 heap-allocates the result cell of every && / ||; insertFrees (Optimize.ts:347-358) frees every allocation seen " +
               "earlier in the listing at 'ret', including cells on a path that short-circuited past the allocation.",
        fixed: "IR.ts &&/|| keep their result in a named __sc_N stack slot instead of a heap cell, so nothing is allocated or freed.",
    },
    B11: {
        title: "Functions mixing int and float parameters read the wrong registers",
        cause: "Emitter.ts:300-307 - a parameter is read from xmm<index> or the index-th integer register, but callers (Emitter.ts:407-417) " +
               "number int and float registers separately, as the SysV ABI does.",
        fixed: "Emitter.ts arg reads parameters with separate int/float register counters, reset at each function entry.",
    },
    B12: {
        title: "Compiler crashes on 'if (false) { ... }' without an else",
        cause: "Optimize.ts:75 - DCE calls DCE(node.children[2]) when there is no else branch, dereferencing undefined.",
        fixed: "Optimize.ts:75 - DCE checks that the else branch exists before recursing into it.",
    },
    B13: {
        title: "Arrays from 'new' are not zero-initialised",
        cause: "Emitter.ts:184 - array_new uses malloc; LANGUAGE.md says new arrays are zero-initialised (needs calloc).",
        fixed: "Emitter.ts array_new calls calloc(1, bytes) instead of malloc(bytes).",
    },
    B14: {
        title: "Negative array index known at compile time skips the runtime bounds check",
        cause: "Emitter.ts:201-203, 229-231 - for a literal index (e.g. after 'var i = -1' is propagated) only 'length <= index' is checked, never 'index < 0'.",
        fixed: "Emitter.ts boundsCheck(): literal indexes get the same 0 <= index < length register check as variable ones.",
    },
    B15: {
        title: "Array slice with a variable start index copies from index 0",
        cause: "IR.ts:605-620 - the start value is a temp that is used inside the copy loop; copyProp drops its defining mov and clears its environment " +
               "at the loop label, so the loop reads a never-written slot.",
        fixed: "IR.ts ArraySlice keeps the start index in a named __slice_start_N slot, like the arr2d/for-in/match lowering.",
    },
    B16: {
        title: "String literals containing an apostrophe fail to assemble",
        cause: "Emitter.ts:851 - literals are emitted as db '...' without escaping the quote.",
        fixed: "Emitter.ts - string literals are emitted as a list of byte values (same bytes NASM produced from '...', but quotes can no longer end the string).",
    },
    B17: {
        title: "'this.field = value' inside a method fails to compile",
        cause: "Parser.ts:432-437 represents the target as Identifier 'this'; IR.ts:130-137 (getStructTypeOf) only recognises the This node.",
        fixed: "IR.ts FieldAssign treats an Identifier 'this' target as the This node.",
    },
    B18: {
        title: "A struct returned from a function cannot be used",
        cause: "Validate.ts:254-257, Declare.ts:127 and IR.ts:692 only take a variable's struct type from a StructInstantiate initialiser; " +
               "a 'var V v = f();' annotation is ignored.",
        fixed: "Declare.ts, Validate.ts and IR.ts take a variable's struct type from a capitalised type annotation when the initialiser is not a struct literal.",
    },
    B19: {
        title: "A header's own imports are looked up in headers/headers/ (design question)",
        cause: "Main.ts:49 - nested imports resolve relative to the header's directory, so 'import b' inside headers/a.l searches headers/headers/b.l.",
    },
    B20: {
        title: "Expressions outside declarations and assignments are not type-checked",
        cause: "Validate.ts:314-317 - Binary only validates its operands; the type check lives in inferType, which only VarDecl/Assign/ForIn call, " +
               "so print(float + int) compiles to garbage.",
    },
    B21: {
        title: "A function returning its string parameter is not treated as returning a string",
        cause: "IR.ts:157-175 - collectStringFunctions only counts string VarDecls as string variables, not string parameters.",
    },
    B22: {
        title: "An int argument passed to a float parameter is not converted",
        cause: "IR.ts:522-529 / Emitter.ts:407-417 - call arguments are passed as-is; an int goes in an integer register while the callee reads xmm.",
        fixed: "IR.ts records each function's parameter types and converts call arguments with itof/ftoi when an int is passed to a float parameter or vice versa.",
    },
    B23: {
        title: "gfx_get_time returns garbage",
        cause: "stdlib/graphics.l - gfx_time() is a C function returning double (in xmm0) but is not known to return a float, " +
               "so gfx_get_time returns whatever is in rax.",
        fixed: "IR.ts seeds floatFunctions with the C runtime's gfx_time, so gfx_get_time returns xmm0 (verified in the generated assembly; the window test still needs a --gfx run to confirm).",
    },
    B24: {
        title: "Heap values owned by function-level variables are never freed (design question)",
        cause: "Optimize.ts:320-321, 351 - 'ret' only frees names recorded in allocatedSoFar, which holds the allocating temps (t1), " +
               "not the variables that took ownership (s), so only loop-body variables are ever freed. Fixing this needs a decision on " +
               "the ownership model, because returning a literal or a parameter would then be freed twice.",
    },
    B25: {
        title: "inputstr reads one word, not a line",
        cause: "Emitter.ts:9 - fmt_str_in is '%255s', which stops at whitespace; LANGUAGE.md says it reads a line.",
    },
    B26: {
        title: "Compile-time array bounds check uses the declared size and is off by one",
        cause: "Validate.ts:357-362 - the size recorded at the declaration is used even after the array is reassigned, " +
               "and the check is 'idx > size', so a[size] is accepted.",
        fixed: "Validate.ts: constant index check is 'idx >= size', and an assignment clears the recorded array size.",
    },
    B27: {
        title: "A variable initialised from a function call cannot be reassigned",
        cause: "Validate.ts:247 records the call's type, which is 'unknown' for every function; Validate.ts:338 then rejects any " +
               "assignment because 'unknown' differs from the assigned type.",
        fixed: "Validate.ts Assign skips the type check when the variable's recorded type is 'unknown' (as it already did for an unknown right-hand side).",
    },
    B28: {
        title: "Caller frees returned strings it does not own (returned literal or parameter freed inside a loop)",
        cause: "IR.ts:524-529 marks every string-returning call as a fresh heap value; insertFrees then frees the receiving loop variable " +
               "at the back-edge (Optimize.ts:330-340) even when the function returned a string literal or its parameter. " +
               "Part of the ownership-model question in B24.",
    },
    B29: {
        title: "Heap variable freed on a path where it was not allocated (double free / invalid free)",
        cause: "Optimize.ts insertFrees is path-insensitive: at 'ret' it frees every allocation that appears earlier in the listing (even on another branch), " +
               "and a loop variable allocated only on some iterations is freed at every back-edge, freeing the previous iteration's pointer again. " +
               "Pre-existing in commit 9004ecc (e.g. 'if' inside a 'while' that declares a string aborts with a double free).",
        fixed: "Optimize.ts insertFrees sets every heap-owning slot to 0 at function entry and after each back-edge free; Emitter.ts array_free_2d skips a NULL array. free(NULL) is a no-op, so a free on a path that never allocated is harmless.",
    },
    B30: {
        title: "Functions named like x86 instructions (rep, add, push, ...) fail to assemble",
        cause: "Emitter.ts 'enter' / 'call' - function names are emitted as bare NASM labels, so a name that is also a mnemonic or prefix is parsed as an instruction.",
        fixed: "Emitter.ts writes function names as $name in global/label/call/vtable positions; NASM then always treats them as symbols (the symbol names themselves are unchanged).",
    },
    B31: {
        title: "Integer literals above 2^53 lose precision",
        cause: "IR.ts:387 stores int constants as JS numbers (Number(node.value)) and Lexer.ts:68 converts hex with parseInt, " +
               "so digits beyond 2^53 are rounded (and very large values print in a form NASM rejects).",
        fixed: "Lexer.ts converts hex with BigInt; IR.ts keeps int constants outside the JS safe-integer range as 64-bit-wrapped bigints; copyProp records them as decimal text.",
    },

    S1: {
        title: "math_sqrt is inaccurate for large and tiny inputs",
        cause: "stdlib/math.l math_sqrt - a fixed 20 Newton iterations from x/2 is not enough to converge far from 1 (sqrt(1e12) gives 1030620).",
        fixed: "stdlib/math.l math_sqrt scales x into [1, 4) by powers of 4 before the 20 Newton iterations and scales the result back.",
    },
    S2: {
        title: "math_ln is inaccurate for small inputs",
        cause: "stdlib/math.l math_ln - values >= 2 are halved into range, but values below 1 are not doubled, so the series is evaluated " +
               "far from its fast-converging range (ln(0.01) gives -3.747).",
        fixed: "stdlib/math.l math_ln doubles x below 1 (decrementing n), mirroring the existing halving of x >= 2.",
    },
    S3: {
        title: "math_pow drifts outside |exp * ln(base)| < 2 (documented limitation)",
        cause: "stdlib/math.l math_pow - e^t uses a 7-term Taylor series; LANGUAGE.md documents this limit. pow(2, 3) gives 7.989.",
    },
}
