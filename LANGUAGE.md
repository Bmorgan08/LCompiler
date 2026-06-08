# The L Language

L is a compiled, statically-typed language that produces native Linux binaries. It has a C-like syntax with structs, methods, arrays, strings, and a standard library — with automatic memory management so you never call `free` yourself.

---

## Table of Contents

1. [Compiling](#compiling)
2. [Program Structure](#program-structure)
3. [Types](#types)
4. [Variables](#variables)
5. [Operators](#operators)
6. [Control Flow](#control-flow)
7. [Functions](#functions)
8. [Arrays](#arrays)
9. [Strings](#strings)
10. [Chars](#chars)
11. [Tuples](#tuples)
12. [Structs](#structs)
13. [Imports](#imports)
14. [Inline Assembly](#inline-assembly)
15. [Built-ins](#built-ins)
16. [Standard Library](#standard-library)
17. [Full Example](#full-example)
18. [Nerd Talk](#nerd-talk)

---

## Compiling

```sh
node dist/Main.js <source.l> [output] [flags]
```

```sh
node dist/Main.js hello.l          # compiles to ./output
node dist/Main.js hello.l hello    # compiles to ./hello
```

| Flag        | Description                            |
|-------------|----------------------------------------|
| `--ir`      | Print the intermediate representation |
| `--ast`     | Print the abstract syntax tree        |
| `--asm`     | Print the generated assembly           |
| `--tokens`  | Print the token stream                 |
| `--verbose` | Print all of the above                 |

Errors include the source location: `line:col: message`.

---

## Program Structure

Every program needs a `main` entry point. Functions and structs can be declared in any order — you can call something defined below the call site.

```
function add(int a, int b) {
    return a + b;
}

main() {
    print(add(3, 4));   // 7
    return 0;
}
```

---

## Types

| Type       | Description                                   |
|------------|-----------------------------------------------|
| `int`      | 64-bit signed integer                         |
| `float`    | 64-bit double-precision floating point        |
| `bool`     | Boolean — `true` (1) or `false` (0)          |
| `char`     | Single character, stored as its ASCII code    |
| `string`   | Text — heap-allocated, null-terminated        |
| `int[]`    | 1-D array of integers                         |
| `float[]`  | 1-D array of floats                           |
| `char[]`   | 1-D array of chars                            |
| `int[][]`  | 2-D array of integers                         |

Struct types are named with a capital letter by convention (`Point`, `Player`, `Node`).

### Implicit Conversions

`int` and `float` convert to each other automatically on assignment:

```
var float f = 3;      // int 3 → float 3.0
var int n = 9.9;      // float 9.9 → int 9 (truncated)
```

`bool` and `int` are interchangeable — any non-zero int is truthy.

---

## Variables

```
var int x = 10;
var float f = 3.14;
var string s = "hello";
var bool b = true;
```

The type annotation is optional when it can be inferred from the value:

```
var x = 42;        // inferred as int
var s = "hi";      // inferred as string
var f = 1.5;       // inferred as float
```

`let` and `const` are accepted as aliases for `var` — the language does not enforce immutability on `const` variables yet.

---

## Operators

### Arithmetic

```
x + y    x - y    x * y    x / y    x % y
```

`%` is integer modulo. For float modulo use `math_fmod` from the standard library.

### Compound Assignment

```
x += y    x -= y    x *= y    x /= y    x %= y
```

### Increment / Decrement

```
x++    x--    ++x    --x
```

### Comparison

```
x == y    x != y    x < y    x <= y    x > y    x >= y
```

String equality with `==` and `!=` compares contents, not pointers.

### Logical

```
x && y    x || y    !x
```

`&&` and `||` short-circuit: the right side is not evaluated if the result is already determined by the left.

### Unary

```
-x     // negation
!x     // logical NOT
```

---

## Control Flow

### If / Else

```
if (x > 0) {
    print(x);
} else if (x == 0) {
    print(0);
} else {
    print(-1);
}
```

### While

```
while (i < 10) {
    i++;
}
```

### For (C-style)

```
for (var int i = 0; i < 10; i++) {
    print(i);
}
```

### For-In

Iterates over every element of an array. The loop variable takes the type of the array's elements.

```
var int[] nums = [10, 20, 30];

for (n in nums) {
    print(n);
}
```

### Break / Continue

```
while (true) {
    if (x > 100) { break; }
    if (x % 2 == 0) { continue; }
    x++;
}
```

### Match

Test a value against a series of patterns. Arms are checked in order; `_` is the wildcard and catches anything not matched above. `_` must be the last arm.

```
match (x % 3) {
    0 => { print(0); }
    1 => { print(1); }
    _ => { print(2); }
}
```

---

## Functions

```
function greet(string name) {
    var string msg = "Hello, " + name + "!";
    print(msg);
    return 0;
}
```

Parameters must be typed. The return type is inferred from the `return` statements in the body. `function` and `fn` are both accepted.

### Returning Multiple Values

Return a tuple and unpack it at the call site:

```
function minMax(int a, int b) {
    if (a < b) { return (a, b); }
    return (b, a);
}

main() {
    var r = minMax(5, 3);
    print(r.0);    // 3  (the smaller)
    print(r.1);    // 5  (the larger)
    return 0;
}
```

---

## Arrays

### Creating Arrays

```
var int[] a = new int[10];        // 1-D, zero-initialised
var int[][] m = new int[4][4];    // 2-D, zero-initialised
var int[] lit = [1, 2, 3, 4, 5]; // array literal
```

### Reading and Writing

```
a[0] = 42;
var int v = a[0];

m[2][3] = 99;
var int w = m[2][3];
```

### Length

```
var int n = a.len();
```

### Slicing

Returns a new array with elements from index `start` up to (not including) `end`:

```
var int[] full = [10, 20, 30, 40, 50];
var int[] part = full[1..4];   // [20, 30, 40]

print(part[0]);    // 20
print(part.len()); // 3
```

---

## Strings

```
var string s = "Hello";
var string t = s + ", world!";      // concatenation with +
var int n    = len(s);              // length → 5
var string ns = inttostr(42);       // integer to string → "42"
var int i    = strtoint("7");       // string to integer → 7
```

### String Equality

```
if (s == "Hello") {
    print(1);
}
```

### Printing Strings

```
print(s);           // prints the string followed by a newline
```

---

## Chars

A `char` literal is written with single quotes and evaluates to its ASCII code as an `int`. There is no separate char type at runtime — chars are just integers.

```
var int c = 'A';       // c = 65
var int d = c + 1;     // d = 66  (the code for 'B')

printchar(c);          // prints: A
printchar(d);          // prints: B
```

You can compare chars the same way you compare integers:

```
if (c == 'A') {
    print(1);
}
```

---

## Tuples

A tuple is a fixed-size anonymous group of values. Elements are accessed by their zero-based index using dot notation.

```
var t = (10, 20, 30);
print(t.0);    // 10
print(t.1);    // 20
print(t.2);    // 30
```

Tuples are most useful as multiple return values from functions (see [Functions](#functions)).

---

## Structs

Structs group named fields together and can have methods that operate on them.

```
struct Point {
    var x: int;
    var y: int;

    fn distSq() {
        return this.x * this.x + this.y * this.y;
    }
}

main() {
    var p = Point { x: 3, y: 4 };
    print(p.x);          // 3
    print(p.distSq());   // 25
    p.x = 10;
    print(p.x);          // 10
    return 0;
}
```

### Fields

- `var` fields are mutable after construction.
- `const` fields are read-only — assigning to them is a compile error.

### Methods

Methods are defined inside the struct body with `fn`. Use `this` to refer to the current instance:

```
fn area() {
    return this.width * this.height;
}
```

### Inheritance

A struct can extend another with `extends`. It inherits all fields and methods from the parent:

```
struct Animal {
    var name: string;
    fn speak() { return 0; }
}

struct Dog extends Animal {
    var breed: string;

    overrides {
        fn speak() { return 1; }
    }
}
```

- The child gains all parent fields. List parent fields first when constructing: `Dog { name: "Rex", breed: "Lab" }`.
- Overridden methods are dispatched dynamically — calling `speak()` on a variable typed as `Animal` that holds a `Dog` will call the dog's version.
- Methods not listed in `overrides` are inherited unchanged.

---

## Imports

Break code into multiple files. The `import` statement is resolved at compile time by textual inclusion.

```
import math;
```

L searches for the module in two places, in this order:

1. `headers/<name>.l` relative to the source file
2. `stdlib/<name>.l` in the compiler's standard library directory

Duplicate imports are silently deduplicated — importing the same module twice has no effect.

### Example: local header

```
// headers/utils.l
function clamp(int v, int lo, int hi) {
    return math_max(lo, math_min(hi, v));
}
```

```
// main.l
import math;
import utils;

main() {
    print(clamp(150, 0, 100));   // 100
    return 0;
}
```

---

## Inline Assembly

Insert raw NASM instructions directly into the output with `asm { }`. The contents are passed through verbatim with no checking.

```
main() {
    asm { nop }
    print(1);
    return 0;
}
```

This is mainly useful for things the language can't express yet, or for micro-optimisations in hot paths.

---

## Built-ins

These functions are always available without any import.

| Function        | Description                                     |
|-----------------|-------------------------------------------------|
| `print(v)`      | Print an integer or string, followed by newline |
| `printchar(c)`  | Print a character by its ASCII code             |
| `input()`       | Read an integer from stdin                      |
| `inputstr()`    | Read a line of text from stdin                  |
| `len(s)`        | Length of a string                              |
| `inttostr(n)`   | Convert an integer to its string representation |
| `strtoint(s)`   | Parse a string as an integer                    |

---

## Standard Library

Import with `import math;` at the top of your file.

### Integer Helpers

| Function                  | Description                           |
|---------------------------|---------------------------------------|
| `math_abs(int x)`         | Absolute value                        |
| `math_max(int a, int b)`  | Larger of two integers                |
| `math_min(int a, int b)`  | Smaller of two integers               |

### Float Conversion

| Function                  | Description                            |
|---------------------------|----------------------------------------|
| `math_toint(float x)`     | Truncate float to int (towards zero)   |
| `math_tofloat(int x)`     | Widen int to float                     |

### Rounding

| Function                  | Description                            |
|---------------------------|----------------------------------------|
| `math_floor(float x)`     | Round down towards −∞                  |
| `math_roof(float x)`      | Round up towards +∞ (ceiling)          |
| `math_round(float x)`     | Round to nearest integer               |

### Float Arithmetic

| Function                          | Description                           |
|-----------------------------------|---------------------------------------|
| `math_fmod(float x, float step)`  | Float remainder of `x / step`         |

### Trigonometry

All angles are in **radians**. Precision is roughly 8 significant digits.

| Function              | Description           |
|-----------------------|-----------------------|
| `math_sin(float x)`  | Sine                  |
| `math_cos(float x)`  | Cosine                |
| `math_tan(float x)`  | Tangent               |

Useful constants:

```
var float pi  = 3.1415926536;
var float tau = 6.2831853072;   // 2 * pi
```

---

## Full Example

A program that reads 5 numbers, prints their min, max, and average, then shows whether each is above or below average.

```
import math;

function average(int[] arr) {
    var int sum = 0;
    for (v in arr) { sum += v; }
    return math_tofloat(sum) / math_tofloat(arr.len());
}

main() {
    var int[] nums = new int[5];
    var int i = 0;
    while (i < 5) {
        nums[i] = input();
        i++;
    }

    var int lo = nums[0];
    var int hi = nums[0];
    for (v in nums) {
        lo = math_min(lo, v);
        hi = math_max(hi, v);
    }

    var float avg = average(nums);

    print(lo);
    print(hi);

    i = 0;
    while (i < 5) {
        if (math_tofloat(nums[i]) >= avg) {
            print(1);
        } else {
            print(0);
        }
        i++;
    }

    return 0;
}
```

---

## Nerd Talk

For those who want to understand what the language is actually doing under the hood, or who are coming from languages like Rust, C, or C++ and have questions about safety and memory.

### Memory Model

L has three categories of values:

**Stack values** — `int`, `float`, `bool`, `char`. These live in the function's stack frame and cost nothing to create or destroy. When the function returns, they're gone.

**Heap values** — `string`, arrays, structs, tuples. These are `malloc`'d on the heap. Every heap value has exactly one owner: the variable it was assigned to. When that owner goes out of scope, the compiler inserts a `free` call automatically.

There is no garbage collector. `free` calls are inserted statically at compile time based on where variables are declared, not at runtime based on reference counts or reachability.

### Ownership and Transfer

When you assign a heap value from one variable to another, ownership transfers to the new variable. The original is no longer considered the owner and won't be freed:

```
var string a = "hello";
var string b = a;       // b is now the owner — a will NOT be freed
print(b);
```

This means **you should not use `a` after transferring it to `b`** — the compiler doesn't currently enforce this (it will compile), but the memory behind `a` now belongs to `b` and will be freed when `b` goes out of scope.

When a heap value is returned from a function, ownership transfers to the caller. The function does not free it:

```
function makeArray() {
    var int[] arr = new int[10];
    arr[0] = 42;
    return arr;     // caller owns arr now — not freed here
}

main() {
    var int[] result = makeArray();
    print(result[0]);
    return 0;       // result is freed here
}
```

### Arrays Stored Inside Arrays

When you store a value into an array slot, ownership transfers into the array. The compiler will not also free it from its original variable. This matters most for 2D arrays:

```
var int[][] grid = new int[3][4];
// Each inner row is allocated and stored into grid.
// grid owns all three rows.
// When grid is freed, each row is freed first, then grid itself.
```

For a 2D array, the compiler inserts a loop that frees each row individually before freeing the outer array. This is handled automatically — you don't write it.

### What Is and Isn't Safe

**Safe:** Creating, using, and returning heap values normally. The compiler handles the `free` placement.

**Safe:** Passing heap values to functions — the function receives a copy of the pointer, but the caller retains ownership and frees it after the call returns.

**Use with care:** Transferring ownership via assignment and then continuing to use the original variable. The compiler won't stop you, but the original is now an alias to memory owned by someone else.

**Use with care:** Storing a heap value into a data structure (like a struct field or array slot). Once stored, the container owns it. Don't also try to free it from the original variable.

**Unsafe:** `asm { }` blocks that manually call `free`, or that store pointers the compiler doesn't know about. If you free something the compiler also tries to free, you'll get a double-free. If you allocate something the compiler doesn't know about, it will leak.

### Integers and Floats Are Always Copied

There are no pointers to `int` or `float` values in L. When you pass an int to a function or assign it to another variable, it is always a full copy. Modifying one never affects the other:

```
var int x = 10;
var int y = x;
y = 99;
print(x);   // still 10
```

### Type Safety

The compiler checks types at compile time. Mismatched types on assignment or function arguments are caught before the program runs. The exceptions are:

- `int` and `float` implicitly convert to each other on assignment (float to int truncates towards zero)
- `int` and `bool` are interchangeable — any non-zero integer is truthy
- Untyped `var` declarations infer their type from the right-hand side

### Integer Overflow

L uses 64-bit signed integers. Overflow wraps silently — there is no checked arithmetic or panic on overflow. If you need to handle large numbers carefully, you're responsible for range checking.

### Stack Size

The compiler allocates a fixed stack frame per function based on how many local variables the function declares. There is no dynamic stack growth. Very deep recursion will segfault. For deep recursion, consider an iterative approach with an explicit array-based stack instead.

### Float Precision

`float` is a 64-bit IEEE 754 double, the same as `double` in C. You get about 15–16 significant decimal digits. The trig functions in the standard library (`math_sin`, `math_cos`, `math_tan`) are accurate to roughly 8 significant digits — good enough for games and simulations, not for numerical analysis.

Float equality (`==`) compares the exact bit pattern. Due to rounding, two floats that are mathematically equal may not compare equal. For approximate comparison, test whether the difference is smaller than a tolerance:

```
function nearlyEqual(float a, float b) {
    var float diff = a - b;
    if (diff < 0.0) { diff = diff * -1.0; }
    return diff < 0.000001;
}
```
