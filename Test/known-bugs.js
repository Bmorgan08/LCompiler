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
        fixed: "Main.ts resolveImports searches, in order: the importing file's own folder (imported files only), headers/ next to the main source file, then stdlib/.",
    },
    B20: {
        title: "Expressions outside declarations and assignments are not type-checked",
        cause: "Validate.ts:314-317 - Binary only validates its operands; the type check lives in inferType, which only VarDecl/Assign/ForIn call, " +
               "so print(float + int) compiles to garbage.",
        decided: "Incompatible operand types are a compile error; compatible ones (int, float, char, bool) are converted.",
        fixed: "Validate.ts binaryType checks every binary expression (string + int, string ordering, % on a float and arrays in arithmetic are errors); IR.ts asFloat converts the int side of a float operation with itof.",
    },
    B21: {
        title: "A function returning its string parameter is not treated as returning a string",
        cause: "IR.ts:157-175 - collectStringFunctions only counts string VarDecls as string variables, not string parameters.",
        fixed: "IR.ts collectStringFunctions also counts string parameters; the B28 str_dup in Return then hands the caller a copy, so it never frees its own argument.",
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
        fixed: "IR.ts seeds floatFunctions with the C runtime's gfx_time, so gfx_get_time returns xmm0 (confirmed with the --gfx window test).",
    },
    B24: {
        title: "Heap values owned by function-level variables are never freed (design question)",
        cause: "Optimize.ts:320-321, 351 - 'ret' only frees names recorded in allocatedSoFar, which holds the allocating temps (t1), " +
               "not the variables that took ownership (s), so only loop-body variables are ever freed. Fixing this needs a decision on " +
               "the ownership model, because returning a literal or a parameter would then be freed twice.",
        fixed: "Every string variable now owns its value (IR.ts ownString/ownField copies, str_dup on return, reassigned string params copied on entry) and " +
               "insertFrees frees a heap owner's old value before it is overwritten, so Optimize.ts insertFrees drops the allocatedSoFar check and frees every heap owner at ret.",
    },
    B25: {
        title: "inputstr reads one word, not a line",
        cause: "Emitter.ts:9 - fmt_str_in is '%255s', which stops at whitespace; LANGUAGE.md says it reads a line.",
        fixed: "Emitter.ts inputstr reads with fgets into a calloc'd 256-byte buffer and strips the newline; input() sets __after_num so an inputstr straight after it " +
               "skips the empty rest of the number's line. Empty lines read as \"\" and end of input gives \"\".",
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
        fixed: "IR.ts Return emits str_dup when a string-returning function returns a value that is not already fresh (a literal, parameter, global or variable), so the caller always owns the result.",
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
    B32: {
        title: "String += crashes",
        cause: "IR.ts CompoundAssign always emits an integer add (or fadd), never str_concat, so 's += \"cd\"' adds the two pointers and print reads a wild address.",
        fixed: "IR.ts CompoundAssign emits str_concat for += on a string variable; the result is fresh, so insertFrees frees the old value on the following mov.",
    },
    B33: {
        title: "A string function that calls a string function defined after it is not treated as returning a string",
        cause: "IR.ts collectStringFunctions makes one pass in source order; isStringExpr for a Call only knows functions already added to stringFunctions, " +
               "so 'function a() { return b(); }' before 'function b() { return \"x\"; }' leaves a out and print(a()) prints a pointer.",
        fixed: "IR.ts repeats collectStringFunctions (and collectFloatFunctions, which had the same problem: print(a()) gave 0) until the set stops growing.",
    },
    B34: {
        title: "Arrays, structs and tuples returned from a function are never freed by the caller (leak)",
        cause: "Optimize.ts insertFrees isHeapAlloc only counts a call as an allocation when it returns a string, so the variable receiving a returned array/struct/tuple never owns it.",
        fixed: "IR.ts collects heapFunctions (every return is a new array/struct/tuple, a call to another such function, or a local only ever given such values) " +
               "and marks their calls returns_heap; Optimize.ts isHeapAlloc counts those calls, so the caller owns and frees the result. Functions returning a parameter, global or mix are left alone.",
    },
    B35: {
        title: "Freeing a struct does not free its string fields (leak)",
        cause: "Structs are freed with a single free of the struct block; the strings its fields own (copied in by IR.ts ownField) are not freed first.",
        fixed: "IR.ts records heapFields (string/array field offsets; string tuple elements) on struct_alloc/alloc; Optimize.ts insertFrees carries them with ownership (fieldsOf) " +
               "and frees owners with free{fields}, which Emitter.ts expands to freeing each field then the block, skipping a NULL struct. Field stores that move a heap value free the old field. " +
               "Structs and tuples are calloc'd so unset fields are NULL. A struct returned from a function still frees only its block.",
    },
    B36: {
        title: "A loop variable is not freed when the loop exits through break (leak)",
        cause: "Optimize.ts insertFrees frees loop-body owners only at the back-edge jmp, which a break skips; at ret they are in freedVars and skipped too.",
        fixed: "Optimize.ts insertFrees maps each loop start to its end label (the label after the back-edge) and frees the loop's owners at every jmp to the start or end, " +
               "so break frees them too; loops are left at the end label rather than the first jmp back, which also fixes continue in while loops. freedVars is gone (every free is followed by zeroing).",
    },
    B37: {
        title: "Heap values in C-style for loops and for-in loops leak",
        cause: "Optimize.ts insertFrees tracks loop depth only for while_start labels, so owners inside a 'for (var int i = 0; ...)' or 'for (x in a)' loop get the wrong depth and are never freed per iteration.",
        fixed: "Optimize.ts insertFrees treats while_start, for_start and forin_start labels as loop starts in both passes.",
    },
    B38: {
        title: "Old values of a global string are never freed when it is reassigned (leak)",
        cause: "Optimize.ts insertFrees excludes globals from varScope, so neither the free on overwrite nor any other free applies to them; a global can also still hold its initial literal, so it cannot simply be freed.",
        fixed: "IR.ts ownString/ownField also copy global initialisers (Emitter.ts counts str_dup as making a global a string); Optimize.ts insertFrees frees a global's old string " +
               "before a string moves into it (globalStringStores). Emitter.ts aligns .bss to 8 so leak checkers see pointers held in globals.",
    },
    B39: {
        title: "continue inside a for-in loop never ends the loop",
        cause: "IR.ts ForIn pushes forin_start as the continue target, so continue jumps back to the condition without incrementing the index and repeats the same element forever. " +
               "The C-style For case already sends continue to a separate for_update label.",
        fixed: "IR.ts ForIn sends continue to a forin_next label placed before the index increment.",
    },
    B40: {
        title: "Storing an array into an array slot does not free the array already in that slot (leak)",
        cause: "Optimize.ts insertFrees transfers ownership of the stored value into the array on array_store, but nothing frees the element it replaces " +
               "(e.g. m[0] = row on a new int[2][3] leaks the original row).",
        fixed: "Optimize.ts insertFrees records array_stores that move a heap value in (heapStores) and frees the element they overwrite first; arrays are calloc'd, so a slot that never held one is NULL.",
    },
    B41: {
        title: "An array variable stored into an array or struct, used, then reassigned crashes (regression from the step 3 ownership work)",
        cause: "Optimize.ts insertFrees zeroes the variable right after array_store/field_store when it is reassigned later (so the free before that reassignment is free(NULL)). " +
               "Any use of the variable between the store and the reassignment then goes through NULL. Needs a decision: forbid using a variable after it is moved into a container, or stop zeroing.",
        fixed: "Decided: storing an array or struct variable into an array slot, struct field, tuple or array literal moves it. Validate.ts rejects any use of the variable " +
               "until it is reassigned (branches merge conservatively, loop bodies are checked twice); the zeroing in insertFrees stays as a runtime backstop.",
    },
    B42: {
        title: "Printing a string element of a tuple prints a pointer",
        cause: "IR.ts TupleAccess emits a field_load without marking the result as a string, so print() formats it as an integer.",
        fixed: "IR.ts records which tuple elements are strings (tupleStrings) when the tuple is built, passes it on to the declared variable, and TupleAccess marks those loads is_string. " +
               "A tuple returned from a function still has no element types.",
    },
    B43: {
        title: "Struct fields of array type are not parsed",
        cause: "Parser.ts struct field parsing does not handle an array type such as 'var tags: int[];': the rest of the file is swallowed, so main is missing at link time " +
               "(or, with 'extends', the compiler crashes reading an undefined node).",
        fixed: "Parser.ts reads a struct field's type with parseTypeAnnotation, which handles int[], int[][] and struct names.",
    },
    B44: {
        title: "Reassigning a global array does not free the old array (leak)",
        cause: "Optimize.ts insertFrees only frees a global's old value for strings. A local can alias a global array (var int[] a = A), so freeing on reassignment " +
               "could leave that alias dangling; it needs the aliasing question answered first (e.g. make var-to-var array assignment a move checked by Validate.ts).",
        fixed: "Optimize.ts insertFrees frees a global's old value whenever a value it owns moves in (globalStores, resolving copyProp temps through heldBy). " +
               "Validate.ts rejects anything that could still point at the old value: locals copied from the global go stale when it is reassigned (directly or via a call, per-function reassigns summary), " +
               "and a global can't be passed to a function that reassigns it, stored in a container, returned, reassigned inside a for-in over it, or given a value something else points to. " +
               "The 'always returns a new value' analysis moved to Fresh.ts so both IR.ts and Validate.ts use it.",
    },
    B45: {
        title: "A local that sometimes owns its value and sometimes borrows one is freed while borrowing (invalid free)",
        cause: "Optimize.ts insertFrees treats every heap owner as owning whatever it holds, so 'var int[] x = d.tags; x = new int[2];' frees d.tags " +
               "(the free before overwriting x), and the struct frees it again.",
        fixed: "Optimize.ts insertFrees gives heap owners that also receive borrowed values (borrowMovs) an __owns_<name> flag, set on every mov into them; their frees skip when it is 0.",
    },
    B46: {
        title: "Fields of a global struct can't be accessed",
        cause: "'var P gp = P { ... };' at the top level, then 'gp.name' in a function is rejected with \"'gp' is not a struct instance\" " +
               "(the global's struct type isn't recorded where field access looks it up).",
        fixed: "IR.ts genFunction keeps globals' entries in structTypeMap instead of clearing it for every function.",
    },
    B47: {
        title: "Globals declared after a struct with methods are never initialised",
        cause: "IR.ts genProgram emits top-level items in source order, so a struct's methods can come before a global's initialiser. " +
               "Emitter.ts and insertFrees treat only the code before the first function as global setup, so the initialiser never runs " +
               "(an int global reads garbage, an array global crashes) and insertFrees treats the global as a local of the next function.",
        fixed: "IR.ts genProgram emits every top-level VarDecl before any function or struct method.",
    },
    B48: {
        title: "A variable holding another's array or struct could be used after it was freed",
        cause: "'var int[] b = a; a = new int[3]; b[0]' and 'var int[] x = d.tags; d.tags = new int[2]; x[0]' read freed memory: nothing tracked that b and x only referred to values owned elsewhere. " +
               "Storing a parameter into a container double-freed it (container and caller).",
        fixed: "Validate.ts tracks every heap variable as an owner or a borrower of 'roots'; a borrower is stale (an error to use) once a root is reassigned, has a heap part replaced, is moved, " +
               "or is passed to a function that may change it (per-function parameter mutation summary), can't outlive its roots, and can't be stored or returned out of its function. Parameters can't be stored into containers.",
    },
    B49: {
        title: "Methods returning strings returned a borrowed pointer that printed as a number",
        cause: "Only plain functions were in stringFunctions, and methods didn't record their parameter types, so 'print(p.label())' printed the field's address and the caller shared the field's string.",
        fixed: "IR.ts records every function's and method's return type (repeating IR generation until the types are stable), marks method calls returns_string/float/heap, copies any non-new string being returned, and types method parameters.",
    },
    B50: {
        title: "Compound assignment mixing int and float gave garbage",
        cause: "IR.ts CompoundAssign used fadd etc. without converting the int side, and stored a float result into an int variable as raw bits ('n += 1.9').",
        fixed: "IR.ts converts the int side with asFloat and truncates a float result stored back into an int variable (ftoi).",
    },
    B51: {
        title: "s.len() on a string variable read garbage",
        cause: "The parser turns 'name.len()' into ArrayLen, which IR.ts always compiled as an array length (the 8 bytes before the text).",
        fixed: "IR.ts ArrayLen on a string variable calls len (strlen).",
    },
    B52: {
        title: "--ir silently left out several ops",
        cause: "printIR had no case for str_concat, the float ops, str_eq/str_neq, array_free_2d or vtable_entry, so they didn't appear at all.",
        fixed: "printIR prints every op (and prints any future op without a case as JSON rather than dropping it); frees show the type they free. Covered by Test/IRTests.js.",
    },
    B54: {
        title: "A method inherited from a grandparent failed to assemble",
        cause: "IR.ts named an inherited method's vtable entry after the direct parent ('B.base'), even when only the grandparent defines it, so NASM reported an undefined symbol.",
        fixed: "IR.ts uses the nearest ancestor that defines the method (implOwner).",
    },
    B53: {
        title: "Slicing an array of rows (or structs) shared its elements, so they were freed twice",
        cause: "A slice copies element pointers; for int[][] or P[] both arrays then owned the same rows/structs.",
        fixed: "Validate.ts rejects slicing an array whose elements are arrays or structs; slicing a string[] copies each string.",
    },
    B55: {
        title: "Folding negation and int comparisons lost precision above 2^53",
        cause: "Optimize.ts fold negated literals and compared ints as JS numbers, so -9007199254740993 folded to -9007199254740992 and 9007199254740993 > 9007199254740992 folded to 0.",
        fixed: "Optimize.ts fold negates and compares ints with BigInt.",
    },
    B56: {
        title: "A variable with the same name as a string literal's text crashed the compiler",
        cause: "Optimize.ts copyProp replaced every field of an instruction that matched a known variable, including a string_const's text ('var int x = 5; print(\"x\");' turned the string into 5).",
        fixed: "Optimize.ts copyProp only rewrites operand fields: it skips op/dst/args/type names/messages, and 'value' on const/fconst/string_const.",
    },
    B57: {
        title: "Substrings inside a function wrote outside its stack frame",
        cause: "Emitter.ts sized each frame by simulating the slots it would use, but missed start/end/key/map/target/index operands and the __strsub_* temporaries, so s[a..b] in a function overwrote the caller's frame.",
        fixed: "Emitter.ts frame-size simulation counts those operands and the __strsub_* slots.",
    },
    B58: {
        title: "A character of a string array element (w[1][0]) read 0",
        cause: "Parser.ts reads a[i][j] as ArrayAccess2D, which IR.ts only handles for int[][]-style arrays; for a string[] it indexed the wrong thing.",
        fixed: "Validate.ts rewrites ArrayAccess2D / ArrayAssign2D into nested IndexExpr / IndexAssign unless the base really is a 2D array.",
    },
    B59: {
        title: "for (x in f()) didn't parse",
        cause: "Parser.ts collected the for-in source up to the first ')', which was the call's own.",
        fixed: "Parser.ts tracks parenthesis depth when collecting the for-in source.",
    },
    B60: {
        title: "Borrowing a variable assigned in a loop or an if, then reassigning the borrower, freed the original",
        cause: "Optimize.ts insertFrees (first pass) treated `mov cur = head` as moving ownership from head to cur whenever head currently owned a value. " +
               "copyProp usually rewrites such a mov to the allocation's temp, hiding it, but not when head was assigned in a loop or an if. " +
               "cur then owned head's struct, so `cur = cur.next` freed it; and heldBy (built in one pass over the whole function) " +
               "made a store of head into a field inside the loop zero cur instead of head. Found by the allocator stress tests.",
        fixed: "Optimize.ts insertFrees: a mov from one named variable into another local is a borrow (srcDepth undefined), so the source keeps owning; " +
               "only a temp's value, or a move into a global, transfers ownership.",
    },
    B61: {
        title: "A pointer holding a literal address read and wrote the wrong memory",
        cause: "Emitter.ts mem_load / mem_store loaded the address with memRef(), which only knows variable names. copyProp replaces a pointer given a " +
               "literal address (var ptr<u16> vga = 0xB8000;) by the literal, so the address was taken from an uninitialised stack slot named after the number. " +
               "Found by the page-fault test in KernelTests.js (the write to an unmapped address didn't fault).",
        fixed: "Emitter.ts mem_load / mem_store load the address with loadOperand(), which handles literals (of any size) and globals.",
    },
    B62: {
        title: "Globals were set up in source order, so a number global could still be 0 when used",
        cause: "Every global lived in .bss and was given its value by code at the start of main (kernel_main). A global set up earlier that used a later one " +
               "saw 0: in a kernel, a heap global declared before the allocator's `var u64 next_page = 0x400000;` made kernel_alloc_pages hand out memory at address 0 " +
               "(over VGA memory). Found by the timer example.",
        fixed: "Emitter.ts: a global given a plain number (and not set again before main) is stored in .data with that value, so it holds it from the start.",
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
        fixed: "stdlib/math.l math_pow multiplies out whole-number exponents by squaring (exact, negative bases work) and otherwise calls the new math_exp, " +
               "which splits t into a whole part (e^whole by squaring) and a fraction in [0, 1) (17-term series); relative error about 1e-9.",
    },
}
