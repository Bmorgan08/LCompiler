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
12. [Maps](#maps)
13. [Structs](#structs)
14. [Imports](#imports)
15. [Inline Assembly](#inline-assembly)
16. [Low-Level Programming](#low-level-programming)
17. [Built-ins](#built-ins)
18. [Standard Library](#standard-library)
    - [math](#math)
    - [graphics](#graphics)
    - [string](#string)
19. [Runtime Errors](#runtime-errors)
20. [Full Example](#full-example)
21. [Nerd Talk](#nerd-talk)

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
| `--check`   | Only check the program: report its errors and exit 1, or exit 0; no files are written |
| `--nolibc`  | Link without the C library (see [Without the C Library](#without-the-c-library)) |
| `--kernel`  | Compile an operating system kernel to an object file (see [Writing a Kernel](#writing-a-kernel)) |

Errors include the source location: `line:col: message`. Every type and memory-safety error in the program is reported, one per line; a syntax error stops the compiler at the first one, since the code after it can't be read reliably. The VS Code extension runs `--check` whenever a file is opened or saved and shows the errors in the editor.

### Without the C Library

Normally a program is linked against the C library, which provides `malloc`, `printf` and the rest. With `--nolibc` it is linked against L's own runtime, `Typescript/runtime/nolibc.c`, instead:

```sh
node dist/Main.js hello.l hello --nolibc
```

The result is a static binary that depends on nothing but the Linux kernel. `nolibc.c` provides everything a compiled program uses:

- the entry point (`_start`, which calls `main` and exits with what it returns)
- a memory allocator (`malloc`, `calloc`, `realloc`, `free`)
- string and memory functions
- buffered output (`printf`, `sprintf`, with `%ld`, `%s`, `%c` and `%g`)
- input (`scanf`, `fgets`, `atoi`)

Programs behave the same either way; the whole test suite runs in both modes. The [graphics](#graphics) module needs GLFW and OpenGL, which need the C library, so a program that imports it is rejected with `--nolibc`.

Everything in `nolibc.c` reaches the operating system through two functions, `syscall3` and `syscall6`, which make the Linux `read`, `write`, `mmap` and `exit_group` system calls. To run L programs on another operating system (your own kernel, for example), those two functions are the part to replace.

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
| `string[]` | 1-D array of strings                          |
| `P[]`      | 1-D array of structs of type `P`              |
| `int[][]`, `float[][]` | 2-D array of numbers              |
| `map<K, V>` | Keys of type `K` mapped to values of type `V` (see [Maps](#maps)) |
| `fn(A, B): R` | A function taking `A` and `B` and returning `R` (see [Functions as Values](#functions-as-values)) |
| `u8` `u16` `u32` `u64` | Unsigned integers of 8, 16, 32 and 64 bits (see [Low-Level Programming](#low-level-programming)) |
| `i8` `i16` `i32` | Signed integers of 8, 16 and 32 bits (`int` is the signed 64-bit one) |
| `ptr<T>`   | The address of a `T` in raw memory (see [Pointers](#pointers)) |

Struct types are named with a capital letter by convention (`Point`, `Player`, `Node`). A tuple's type is written as its element types in parentheses, e.g. `(string, int)` (see [Tuples](#tuples)).

### Implicit Conversions

`int` and `float` convert to each other automatically on assignment:

```
var float f = 3;      // int 3 → float 3.0
var int n = 9.9;      // float 9.9 → int 9 (truncated)
```

`bool` and `int` are interchangeable — any non-zero int is truthy.

In an expression, `int`, `float`, `char` and `bool` mix freely. If either side is a `float`, the other side is converted and the result is a `float`:

```
var f = 1.5;
var n = 2;
print(f + n);     // 3.5
print(f < 0);     // 0 — the int 0 is compared as 0.0
```

Other combinations are a compile error:

| Not allowed                         | Why                                               |
|-------------------------------------|---------------------------------------------------|
| `"a" + 1`, `"a" == 1`, `"a" < 1`    | strings only join (`+`) and compare (`==`, `!=`, `<`, `>`, …) with strings |
| `5.5 % 2`                           | `%` needs whole numbers — use `math_fmod`         |
| `arr + 1`                           | arrays can't be used in arithmetic                |

When one side's type isn't known at compile time (for example the result of some function calls), the check is skipped.

The same rules apply to compound assignment: `f += n` converts the int `n`, and `n += 1.9` on an int `n` truncates the result back to an int, just like `n = n + 1.9`.

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

`let` is an alias for `var`. A variable declared with `const` can't be reassigned — `=`, `+=`, `++` and the rest are compile errors:

```
const int LIMIT = 10;
LIMIT = 11;           // error: Cannot assign to const variable 'LIMIT'
```

`const` fixes the variable, not what it points to: the elements of a `const` array and the fields of a `const` struct can still be changed.

Integer literals can be written in hexadecimal with a `0x` prefix:

```
var int red   = 0xFF0000;
var int flags = 0x1F;
```

---

## Operators

### Arithmetic

```
x + y    x - y    x * y    x / y    x % y
```

`%` is integer modulo. For float modulo use `math_fmod` from the standard library.

Integer `/` and `%` round toward zero (`-7 / 2` is `-3`, `-7 % 3` is `-1`). Dividing an integer by zero stops the program with `Error: division by zero` (see [Runtime Errors](#runtime-errors)). Float division by zero follows IEEE 754 and gives `inf` or `nan`.

### Bitwise

```
x & y    x | y    x ^ y    ~x    x << n    x >> n
```

These work on whole numbers (`int`, `char`, `bool` and the sized integers). `>>` keeps the sign of a signed value (`-8 >> 1` is `-4`) and fills with zeros for `u64`.

### Compound Assignment

```
x += y    x -= y    x *= y    x /= y    x %= y
x &= y    x |= y    x ^= y    x <<= n   x >>= n
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
~x     // bitwise NOT
```

### Precedence

From loosest to tightest, the same as C: `||`, `&&`, `|`, `^`, `&`, `==` `!=`, `<` `<=` `>` `>=`, `<<` `>>`, `+` `-`, `*` `/` `%`. So `a + b << 3` is `(a + b) << 3`, and `flags & MASK == 0` is `flags & (MASK == 0)`: write the parentheses.

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

The source can be any expression that gives an array, such as a call: `for (w in str_split(line, " ")) { ... }`. Looping over a [map](#maps) visits its keys.

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

Parameters must be typed. `function` and `fn` are both accepted.

The return type can be written after the parameters with `:`. Without it, the return type is inferred from the `return` statements in the body:

```
function percent(int part, int whole): int {
    return part * 100.0 / whole;     // a float, truncated to the declared int
}

function average(int[] xs): float {
    var float total = 0;
    for (x in xs) { total += x; }
    return total / xs.len();         // average([1, 2]) is 1.5
}
```

With a declared return type, every `return` must fit it: ints and floats convert (a float returned from an `int` function is truncated), and anything else — `return "x";` in an `int` function — is a compile error. Methods take a return type the same way: `fn area(): int { ... }`.

Arguments are checked like assignments: an int passed to a `float` parameter is converted, a float passed to an `int` parameter is truncated, a child struct can be passed for its parent, and anything else (`add("x", 2)` for `add(int a, int b)`) is a compile error. The same goes for methods and built-ins, and calling with the wrong number of arguments is an error.

### Functions as Values

A function's name without parentheses is a value you can store in a variable, pass to another function, or call later. Its type is written `fn(parameter types): return type`:

```
function twice(int x): int { return x * 2; }
function square(int x): int { return x * x; }

function apply(fn(int): int f, int v): int {
    return f(v);
}

main() {
    var f = twice;             // f has type fn(int): int
    print(f(3));               // 6
    f = square;
    print(apply(f, 5));        // 25
    return 0;
}
```

- Only functions you write can be values, not built-ins like `print` or `len`.
- All of the function's parameters must have types.
- A function returning an array, struct or tuple can only be a value if it always returns a new one, since whoever calls the value owns what it returns.
- Arguments of a call through a value are checked against its type, and assigning a function of a different type (`fn(int): string` to an `fn(int): int` variable) is an error.

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
var int[] a = new int[10];             // 1-D, zero-initialised
var int[][] m = new int[4][4];         // 2-D, zero-initialised
var int[] lit = [1, 2, 3, 4, 5];       // array literal
var float[] f = [1.5, 2, 3];           // ints in a float array become floats
var string[] names = ["ann", "bob"];   // array of strings
var string[] blank = new string[3];    // three empty strings ("")
```

The element type comes from the literal's elements (or from `new T[n]`). All elements must have the same type, except that ints, floats, chars and bools mix — a literal with any float is a `float[]`.

### Reading and Writing

```
a[0] = 42;
var int v = a[0];

m[2][3] = 99;
var int w = m[2][3];

names[1] = "bea";
print(names[1] + "!");    // bea!
```

Storing a string into a `string[]` stores a copy, so changing the variable afterwards doesn't change the array. The array owns its strings and frees them when it's freed.

An index the compiler can see is out of range (`a[3]` on a literal of one element) is a compile error; otherwise it is checked when the program runs and stops it with `Error: index out of bounds` (see [Runtime Errors](#runtime-errors)).

### Growing and Shrinking

Arrays can change size:

| Method           | Effect                                                               |
|------------------|----------------------------------------------------------------------|
| `a.push(v)`      | Adds `v` at the end                                                  |
| `a.pop()`        | Removes the last element and returns it                              |
| `a.insert(i, v)` | Inserts `v` before index `i` (`i` can be `a.len()`, the end)         |
| `a.remove(i)`    | Removes the element at index `i` and returns it                      |

```
var int[] a = [];          // an empty int[]
a.push(1);
a.push(2);
a.insert(0, 9);            // [9, 1, 2]
print(a.remove(1));        // 1  → a is [9, 2]
print(a.pop());            // 2  → a is [9]
print(a.len());            // 1
```

- `pop()` on an empty array and `insert`/`remove` at an index outside the array stop the program with an error.
- An array passed to a function is the same array, so a function can push to its parameter and the caller sees the new elements.
- Pushing a string stores a copy. Pushing an array or struct moves it into the array, like any other store into a container (see [Arrays Stored Inside Arrays](#arrays-stored-inside-arrays)).
- `pop()` and `remove(i)` hand the element back: a popped string, array or struct belongs to the variable it's stored in.
- An `int` pushed to a `float[]` is converted; pushing a value of the wrong type is a compile error.

### Arrays of Structs

```
struct P {
    var name: string;
    var n: int;
}

var P[] ps = [P { name: "a", n: 1 }, P { name: "b", n: 2 }];
ps[1].n = 20;                 // change a field of an element
ps[0] = P { name: "c", n: 3 };  // replace an element (the old one is freed)
for (p in ps) { print(p.n); }

var P[] more = new P[5];      // five zeroed structs, ready to use
more[4].name = "e";
```

A struct stored into the array moves into it, like storing into any container (see [Arrays Stored Inside Arrays](#arrays-stored-inside-arrays)). Arrays of structs and arrays of arrays can't be sliced, because their elements can't be copied.

### Chained Access

`[i]`, `.field`, `.len()` and method calls work on any expression, not just a variable name:

```
d.tags[1] = 5;            // an array field of a struct
print(d.tags.len());
print(ps[i].name);        // a field of an array element
print(box.inner.x);       // a struct inside a struct
print(makePoint(3).x);    // a field of a returned struct
print(pair().1);          // an element of a returned tuple
```

### Length

```
var int n = a.len();
```

### Slicing

Returns a new array with elements from index `start` up to (not including) `end`. Slicing a `string[]` copies its strings; arrays of structs or arrays can't be sliced.

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

### Escape Sequences

A backslash in a string or char literal starts an escape:

| Escape | Character          |
|--------|--------------------|
| `\n`   | newline            |
| `\t`   | tab                |
| `\r`   | carriage return    |
| `\0`   | the zero byte      |
| `\\`   | backslash          |
| `\"`   | double quote       |
| `\'`   | single quote       |

```
print("name:\tL\n\"quoted\"");
var c = '\n';                    // 10
```

Any other escape (`"\q"`) is a compile error, and so is a string with no closing quote.

### Comparing Strings

`==` and `!=` compare the text. `<`, `<=`, `>` and `>=` order strings alphabetically, byte by byte (so uppercase letters come before lowercase, and `"apple" < "apples"`):

```
if (s == "Hello") {
    print(1);
}
print("apple" < "banana");   // 1
```

### Characters and Substrings

`s[i]` is the character code at index `i`, and `s[a..b]` is a new string with the characters from `a` up to (not including) `b`. Out-of-range bounds are clamped to the string, so a substring is never longer than what's there:

```
var string s = "Hello, World";
print(s[0]);        // 72 ('H')
print(s[0..5]);     // Hello
print(s[7..100]);   // World
```

Strings can't be changed in place (`s[0] = 'J'` is an error) — build a new string instead.

### String Functions

| Function               | Result                                                          |
|------------------------|-----------------------------------------------------------------|
| `len(s)` / `s.len()`   | Number of characters                                            |
| `str_find(s, part)`    | Index of the first occurrence of `part` in `s`, or `-1`         |
| `str_contains(s, part)`| `1` if `part` occurs in `s`, else `0`                           |
| `str_upper(s)`         | A copy with `a`–`z` in uppercase                                |
| `str_lower(s)`         | A copy with `A`–`Z` in lowercase                                |
| `chartostr(c)`         | A one-character string                                          |
| `inttostr(n)`          | The integer as text                                             |
| `strtoint(s)`          | The text as an integer                                          |
| `floattostr(f)`        | The float as text (`2.5` → `"2.5"`, `10.0` → `"10"`)            |
| `str_split(s, sep)`    | A `string[]` of the pieces between each `sep` (`"a,b,,c"` → `"a"`, `"b"`, `""`, `"c"`) |
| `str_join(parts, sep)` | The strings in `parts` joined with `sep` between them           |
| `str_trim(s)`          | A copy without spaces, tabs and newlines at either end          |
| `str_replace(s, from, to)` | A copy with every `from` replaced by `to`                   |
| `strtofloat(s)`        | The text as a float (`"-12.5e2"` → `-1250.0`)                   |

`str_split`, `str_join`, `str_trim`, `str_replace` and `strtofloat` are written in L in `stdlib/string.l`, which is imported automatically when a program uses one of them (see [string](#string)).

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

Escapes work in char literals too: `'\n'`, `'\t'`, `'\''`, `'\\'` (see [Escape Sequences](#escape-sequences)).

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

A tuple's type is its element types in parentheses. Write it wherever a type goes — a parameter, a variable, a struct field, or an array of tuples — so the compiler knows what each element is:

```
function show((string, int) t) {
    print(t.0 + ": " + inttostr(t.1));
    return 0;
}

var (string, (int, string)) nested = ("a", (2, "b"));
print(nested.1.1);                          // b
var (string, int)[] scores = [("ann", 3), ("bob", 5)];
```

Passing a tuple of the wrong type to a tuple parameter, or reading an element past the end (`t.2` on a pair), is a compile error.

---

## Maps

A map stores values under keys. Its type is `map<K, V>`: keys of type `K` (`int`, `float`, `char`, `bool` or `string`) and values of any type `V`, including arrays, structs and other maps.

```
var map<string, int> ages = {};           // an empty map
ages["ann"] = 31;
ages["bob"] = 27;
ages["ann"] = 32;                         // replaces the old value
print(ages["ann"]);                       // 32

var map<int, string> names = { 1: "one", 2: "two" };   // a map literal
```

| Operation        | Result                                                     |
|------------------|------------------------------------------------------------|
| `m[k]`           | The value stored under `k`                                  |
| `m[k] = v`       | Stores `v` under `k`, replacing (and freeing) any old value |
| `m.has(k)`       | `1` if `k` is in the map, else `0`                          |
| `m.remove(k)`    | Removes `k` and its value (nothing happens if it's missing) |
| `m.len()`        | The number of keys                                          |
| `m.keys()`       | A new array of the keys                                     |
| `for (k in m)`   | Loops over the keys                                         |

```
if (ages.has("bob")) {
    ages.remove("bob");
}
for (name in ages) {
    print(name + ": " + inttostr(ages[name]));
}
```

- Reading a key that isn't in the map stops the program with `Error: key not found in map` — check with `has` first.
- String keys are compared by their text and copied into the map. The order of `keys()` and of a `for` loop is not the order the keys were added.
- A key of the wrong type (`m[3]` on a `map<string, int>`) is a compile error, and so are struct, array and map keys.
- Values follow the same rules as array elements: a string is copied in, an array or struct moves in, and the map frees its values when it is freed. Like arrays, a map passed to a function is the same map, so the function's changes are seen by the caller.
- Maps nest: `var map<string, map<string, int>> m = {};` then `m["a"] = {};` and `m["a"]["b"] = 1;`.

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
- A field can hold any type, including arrays (`var tags: int[];`), other structs (`var inner: Point;`), arrays of structs (`var items: Node[];`) or the struct's own type (`var next: Node;`, for linked lists).
- A field can have a default, used when a struct literal (or `new P[n]`) doesn't give it a value. The default is evaluated again for every struct, so each gets its own array or struct:

  ```
  struct Team {
      var name: string = "unnamed";
      var scores: int[] = [];
      var captain: Player = Player { };
  }
  var t = Team { };        // name "unnamed", no scores, a default captain
  ```

  A string, array or struct default must be a new value (a literal, `new`, a struct, or a call that returns a new value) — not another variable.
- A numeric field with no default starts as `0`. A string, array or struct field with no default that is never set has no value: reading it stops the program with `Error: Team.scores was never set` (after anything already printed). Setting it later (`t.scores = [1];`) is fine.
- A string, array, struct or map field can be `none` — empty on purpose. Give it as the default (`var next: Node = none;`) or in a literal (`Node { val: 1, next: none }`), assign it (`n.next = none;` frees the old value), and test for it with `==` / `!=`:

  ```
  struct Node {
      var val: int;
      var next: Node = none;
  }

  var n = Node { val: 1, next: Node { val: 2 } };
  var total = 0;
  var Node cur = n;
  while (true) {
      total += cur.val;
      if (cur.next == none) { break; }
      cur = cur.next;
  }
  ```

  Reading a field that is `none` (other than comparing it) stops the program with `Error: Node.next was never set (or is none)`. `none` can only be stored in a struct field or compared with `==` / `!=`: a local variable, argument, array element, or number field can't be `none`.
- A child inherits its parent's defaults.
- Fields of fields, elements of array fields and methods of nested structs chain as expected: `box.inner.x = 3;`, `d.tags[0] += 1;`, `l.items[i].val`.

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
- Methods not listed in `overrides` are inherited unchanged, from the nearest ancestor that defines them.
- A child can be stored wherever its parent type is expected — a parent-typed variable, field or array — and is still freed as the child it is (its own fields included). An array literal mixing a parent and its children is an array of the parent: `[Dog { ... }, Animal { ... }]` is an `Animal[]`.
- The reverse is an error: an `Animal` can't be stored where a `Dog` is expected.

---

## Imports

Break code into multiple files. The `import` statement is resolved at compile time by textual inclusion.

```
import math;
```

L searches for the module in these places, in this order:

1. `<name>.l` in the same folder as the importing file — only when the import is inside an imported file (a header or a stdlib module), so headers can import each other and stdlib modules always find their own siblings
2. `headers/<name>.l` relative to the main source file
3. `stdlib/<name>.l` in the compiler's standard library directory

The main source file only imports from `headers/` and `stdlib/`, not from `.l` files next to it.

Duplicate imports are silently deduplicated — importing the same module twice has no effect.

An error inside an imported file is reported on the `import` line of your file, naming the imported file and the line in it: `Error: 2:1: in headers/utils.l at 5:9: ...`.

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

## Low-Level Programming

These features are for code that talks to hardware directly, such as an operating system kernel: sized integers, pointers into raw memory, structs with an exact memory layout, port I/O, and calling functions written in assembly or C.

### Sized Integers

| Type  | Size    | Range |
|-------|---------|-------|
| `u8`  | 1 byte  | 0 to 255 |
| `u16` | 2 bytes | 0 to 65,535 |
| `u32` | 4 bytes | 0 to 4,294,967,295 |
| `u64` | 8 bytes | 0 to 2⁶⁴ − 1 |
| `i8`  | 1 byte  | −128 to 127 |
| `i16` | 2 bytes | −32,768 to 32,767 |
| `i32` | 4 bytes | −2³¹ to 2³¹ − 1 |
| `int` | 8 bytes | −2⁶³ to 2⁶³ − 1 |

```
var u8 attr = 0x0F;           // a literal that fits is fine
var u16 cell = u16((attr << 8) | 'A');
var i8 delta = -3;
```

- **Nothing is lost without you asking.** A value only goes where it fits: a `u8` goes into a `u16`, an `int` or an `i16`; an `i8` into an `i16` or `int`; `int` and `u64` mix. Anything narrower, or signed into unsigned, is a compile error until you convert it: `var u8 b = u8(x);` keeps the low 8 bits. An integer literal is accepted when it fits (`var u8 b = 300;` is an error that says so).
- **Arithmetic is done at full width**, like C: `a + b` on two `u8`s is an `int`, so `attr << 8` doesn't lose bits. Storing the result back into a `u8` needs `u8(...)`.
- **Compound assignment and `++`/`--` wrap**: on a `u8` holding 250, `x += 10` gives 4, and `x++` on 255 gives 0. This also applies to a sized array element, struct field or pointer target (`p.flags |= 0x80;`).
- **`u64` is unsigned**: comparisons, `/`, `%` and `>>` treat it as 0 to 2⁶⁴ − 1. The smaller unsigned types are always positive, so they compare the same either way.
- Conversions: `u8(x)` … `i32(x)`, `int(x)`, `u64(x)` convert any whole number, float (truncated) or pointer.

### Pointers

`ptr<T>` is the address of a `T` in raw memory. `T` can be a sized integer, `int`, `char`, `bool`, another pointer or a [packed struct](#packed-structs).

```
var ptr<u16> vga = 0xB8000;          // an address literal
vga[0] = 0x0F00 + 'H';               // white-on-black 'H' in the top-left corner
vga[1] = 0x0F00 + 'i';

var ptr<u16> row = vga + 80 * 2;     // the start of the third row
row[5] = 0x2F00 + '!';
```

- `p[i]` reads or writes the `i`th `T` at `p`, exactly `sizeof(T)` bytes. Signed types are sign-extended when read.
- `p + n` and `p - n` move by `n` elements, not bytes (`ptr<u64>` moves 8 bytes per element); `p++`, `p += n` too.
- Pointers compare with `==`, `<`, … (as unsigned addresses), with each other or with a literal address (`p == 0`).
- Conversions: `ptr<T>(x)` turns an integer or another pointer into a `ptr<T>`, and `u64(p)` gives the address as a number. A pointer of one type doesn't go into a variable of another without a conversion. `ptr<u8>(s)` gives a string's bytes (valid while the string is).
- **L doesn't manage this memory.** There are no bounds checks and nothing is freed: pointers are plain addresses, copied like numbers.
- **Every read and write happens.** The optimizer never removes or merges an access through a pointer, so a hardware register that changes on its own is read each time.

### Packed Structs

A `packed struct` describes a block of memory field by field, with no padding and no hidden header: exactly the layout hardware tables need.

```
packed struct IdtEntry {
    var offset_low: u16;
    var selector: u16;
    var ist: u8;
    var flags: u8;
    var offset_mid: u16;
    var offset_high: u32;
    var zero: u32;
}

var ptr<IdtEntry> idt = ptr<IdtEntry>(table_base);
idt[32].selector = 0x08;
idt[32].flags = 0x8E;
print(sizeof(IdtEntry));     // 16
```

- Fields are sized integers, `int`, `char`, `bool`, pointers or other packed structs (laid out inline). They have no defaults.
- A packed struct is used through a pointer: `p[i].field`, and `p.field` for `p[0].field`. A whole packed struct can't be copied as a value; read or write its fields.
- Packed structs have no methods and don't extend each other. They're separate from regular structs, which live on the heap and are managed by L.

### addr and sizeof

- `addr(x)` gives the address (as a `u64`) of a function (`addr(on_timer)`), a global variable (`addr(gdt_table)`), or something reached through a pointer (`addr(idt[32])`, `addr(p.flags)`). Local variables live on the stack and have no lasting address, so `addr` of one is an error.
- `sizeof(T)` is the size in bytes of a sized integer, `int`, `char`, `bool`, a pointer or a packed struct.

### Port I/O

| Function            | Instruction |
|---------------------|-------------|
| `outb(port, value)` | `out dx, al` (value is a `u8`) |
| `outw(port, value)` | `out dx, ax` (value is a `u16`) |
| `outl(port, value)` | `out dx, eax` (value is a `u32`) |
| `inb(port)` → `u8`  | `in al, dx` |
| `inw(port)` → `u16` | `in ax, dx` |
| `inl(port)` → `u32` | `in eax, dx` |

`port` is a `u16`. These are single instructions, so they need to run in a kernel (ring 0); in a normal program they crash.

```
outb(0x20, 0x20);          // end of interrupt, to the PIC
var u8 scancode = inb(0x60);
```

### extern fn

`extern fn` declares a function written in assembly or C, so L can call it. It has no body, and it's linked in with the rest of your program.

```
extern fn load_idt(u64 base, u16 limit);
extern fn read_cr2(): u64;
extern fn memset(ptr<u8> dest, int value, u64 count): ptr<u8>;
```

- Parameters and return values are whole numbers, floats or pointers, passed with the standard x86-64 calling convention (System V), the same one L's own functions use. That also means assembly can call L functions directly: every L function is exported under its own name.
- Arguments are checked like any call. A return type smaller than 64 bits is cut to size, since assembly and C only set the low bits of the register.

### Interrupts

`interrupt fn` declares a handler the CPU calls through the IDT (Interrupt Descriptor Table):

```
var int ticks = 0;

interrupt fn on_timer(ptr<InterruptFrame> frame) {
    ticks++;
    outb(0x20, 0x20);                 // tell the PIC the interrupt is handled
    return 0;
}

interrupt fn on_page_fault(ptr<InterruptFrame> frame, u64 error_code) {
    print("page fault at " + inttostr(int(read_cr2())));
    return 0;
}

set_gate(32, addr(on_timer));         // your code: fill in the IDT entry
set_gate(14, addr(on_page_fault));
```

- The compiler generates the entry point the CPU jumps to (the address `addr(on_timer)` gives). It saves every register and the SSE state, calls your code, restores them all and returns with `iretq`, so a handler is ordinary L code and can't disturb what it interrupted.
- `frame` points at what the CPU saved: the built-in packed struct `InterruptFrame` with fields `rip`, `cs`, `rflags`, `rsp` and `ss` (all `u64`). Changing them changes where the CPU goes back to (`frame.rip += 2;` skips a 2-byte instruction).
- The CPU pushes an error code for some exceptions (8, 10–14, 17, 21, 29, 30; 14 is the page fault). Their handlers take it as a second parameter, `u64 error_code`, and the entry point removes it before returning. For every other vector, leave it out: a mismatch corrupts the stack.
- A handler can't be called from L or stored as a function value: only the CPU calls it, through `addr(...)` in the IDT.
- Filling in the IDT, loading it (`lidt`), and turning interrupts on and off (`sti`/`cli`) are up to your kernel: a packed struct for the gates, `asm { sti }`, and a two-line assembly function for `lidt` do it (`Test/KernelTests.js` has a complete example).
- A handler runs with interrupts off (in an interrupt gate). L's heap isn't safe to use from a handler while the code it interrupted might be using it: keep handlers to numbers, pointers and packed structs, or turn interrupts off around heap use in the rest of the kernel.

### Writing a Kernel

`--kernel` compiles a kernel instead of a program:

```sh
node dist/Main.js kernel.l build/kernel --kernel
# -> build/kernel.o          your kernel
#    build/kernel-runtime.o  L's runtime for it (nolibc.c built with -DL_KERNEL, plus lrt.c)
nasm -f elf64 boot.asm -o build/boot.o
ld -n -T linker.ld build/boot.o build/kernel.o build/kernel-runtime.o -o build/kernel.elf
```

`Test/kernel/boot.asm` and `Test/kernel/linker.ld` are minimal boot code and a linker script that work with this (the kernel tests use them): Multiboot, the switch to 64-bit mode, the first 1 GiB identity-mapped, SSE turned on, then a call to `kernel_main`.

**The entry point is `kernel_main()`.** Your boot code calls it once the CPU is in 64-bit mode with a stack. Globals are set up at the start of `kernel_main`, as they are at the start of `main` in a program. A kernel has no `main`.

A global set to a plain number or address (`var u64 next_page = 0x400000;`) holds its value from the very start: it's stored with it, so the hooks can use such globals even while other globals (arrays, strings) are still being set up.

**Hooks.** L's runtime needs a few things only your kernel can do. Write them as ordinary L functions with these names; any you leave out get the default:

| Hook | Called for | Default |
|------|------------|---------|
| `kernel_write(ptr<u8> text, u64 len)` | `print()` and `printchar()`: each call to `print` is one call to `kernel_write` | output is dropped |
| `kernel_alloc_pages(u64 count): u64` | memory for strings, arrays, maps and structs: return the address of `count` free, contiguous 4 KiB pages, or 0 | panics: "out of memory (the kernel has no kernel_alloc_pages)" |
| `kernel_panic(ptr<u8> message, u64 len)` | runtime errors (index out of bounds, division by zero, ...): print the message; the CPU halts after it returns | halts |
| `kernel_read(ptr<u8> buf, u64 max): u64` | `input()` and `inputstr()`: fill `buf` with up to `max` bytes (a line), return how many | no input |

```
function kernel_write(ptr<u8> text, u64 len) {
    var u64 i = 0;
    while (i < len) {
        serial_write(text[i]);      // and/or the screen
        i++;
    }
    return 0;
}

var u64 next_page = 0x400000;       // free memory from 4 MiB up
function kernel_alloc_pages(u64 count): u64 {
    var u64 start = next_page;
    next_page += count * 4096;
    return start;
}
```

- The hooks are called from inside the runtime, so they should only use numbers, pointers and packed structs, never strings, arrays or maps (which would call back into the allocator). `ptr<u8>("text")` gives a string literal's bytes, which is fine.
- Code that runs before your allocator is ready (setting up paging, say) must not create strings, arrays, maps or structs either.
- Your boot code has to turn on SSE before calling `kernel_main`: L uses it for floats, and the runtime is compiled expecting it. `Test/kernel/boot.asm` shows how.
- The runtime is compiled without the red zone (so an interrupt can't overwrite a function's locals) and for any load address, so a higher-half kernel works too.

---

## Built-ins

These functions are always available without any import.

| Function        | Description                                     |
|-----------------|-------------------------------------------------|
| `print(v)`      | Print an integer or string, followed by newline |
| `printchar(c)`  | Print a character by its ASCII code             |
| `input()`       | Read an integer from stdin                      |
| `inputstr()`    | Read a line of text from stdin (up to 255 characters, newline removed; `""` for an empty line or end of input) |
| `len(s)`        | Length of a string                              |
| `inttostr(n)`   | Convert an integer to its string representation |
| `strtoint(s)`   | Parse a string as an integer                    |
| `floattostr(f)` | Convert a float to its string representation    |
| `chartostr(c)`  | A one-character string                          |
| `str_find(s, p)`| Index of `p` in `s`, or `-1`                    |
| `str_contains(s, p)` | `1` if `p` occurs in `s`, else `0`         |
| `str_upper(s)`, `str_lower(s)` | A copy in upper / lower case     |

---

## Standard Library

The standard library lives in the `stdlib/` folder next to the compiler. Each file is a module you pull in with `import`:

| Module     | Import             | Provides                                                  |
|------------|--------------------|-----------------------------------------------------------|
| `math`     | `import math;`     | Integer helpers, float conversion, rounding, trig, roots, logs and powers |
| `graphics` | `import graphics;` | An OpenGL window with pixel drawing, keyboard input and timing |
| `string`   | automatic          | `str_split`, `str_join`, `str_trim`, `str_replace`, `strtofloat`, `str_is_space` |

The modules are written in plain L, so you can read `stdlib/*.l` to see exactly how each function works. `math` and `graphics` functions are prefixed with their module name (`math_`, `gfx_`) to avoid clashing with your own code; the `string` functions start with `str_` (and `strtofloat`).

### math

```
import math;
```

#### Integer Helpers

| Function                  | Returns | Description                |
|---------------------------|---------|----------------------------|
| `math_abs(int x)`         | `int`   | Absolute value             |
| `math_max(int a, int b)`  | `int`   | Larger of two integers     |
| `math_min(int a, int b)`  | `int`   | Smaller of two integers    |

#### Conversion

| Function                  | Returns | Description                            |
|---------------------------|---------|----------------------------------------|
| `math_toint(float x)`     | `int`   | Truncate towards zero (`2.9 → 2`, `-2.9 → -2`) |
| `math_tofloat(int x)`     | `float` | Widen an int to a float                |

#### Rounding

All rounding functions take a `float` and return an `int`.

| Function                  | Description                                  | `2.5` | `-2.5` |
|---------------------------|----------------------------------------------|-------|--------|
| `math_floor(float x)`     | Round down towards −∞                        | `2`   | `-3`   |
| `math_roof(float x)`      | Round up towards +∞ (ceiling)                | `3`   | `-2`   |
| `math_round(float x)`     | Round to nearest; `.5` rounds up (see note)  | `3`   | `-3`   |

> For negative inputs the fractional part is always below `0.5`, so `math_round` currently behaves like `math_floor` (e.g. `math_round(-2.3)` gives `-3`).

#### Float Arithmetic

| Function                          | Returns | Description                                                  |
|-----------------------------------|---------|--------------------------------------------------------------|
| `math_fmod(float x, float step)`  | `float` | Remainder of `x / step`; takes the sign of `x`               |
| `math_sqrt(float x)`              | `float` | Square root (20 Newton–Raphson iterations). Returns `0.0` for `x <= 0` |
| `math_ln(float x)`                | `float` | Natural logarithm. Returns `0.0` for `x <= 0`                |
| `math_pow(float base, float exp)` | `float` | `base` raised to `exp`                                        |
| `math_exp(float t)`               | `float` | `e` raised to `t`                                            |

> A whole-number `exp` is multiplied out, so `math_pow(2.0, 10.0)` is exact and a negative `base` works. Any other `exp` is computed as `math_exp(exp · ln base)`, accurate to about 9 significant digits; `base` must then be positive (a negative `base` returns `1.0`).

#### Trigonometry

All angles are in **radians**. Inputs are reduced into `[-π, π]` with `math_fmod` and evaluated with a Taylor series, giving roughly 8 significant digits.

| Function             | Returns | Description |
|----------------------|---------|-------------|
| `math_sin(float x)`  | `float` | Sine        |
| `math_cos(float x)`  | `float` | Cosine      |
| `math_tan(float x)`  | `float` | Tangent (`sin / cos`) — blows up near `±π/2` |

The module doesn't export constants, so define the ones you need:

```
var float pi  = 3.1415926536;
var float tau = 6.2831853072;   // 2 * pi
```

#### Example

```
import math;

main() {
    var float x = 2.0;
    print(math_round(math_sqrt(x) * 1000.0));   // 1414
    print(math_floor(-1.5));                     // -2
    print(math_max(math_abs(-7), 3));            // 7
    return 0;
}
```

### graphics

```
import graphics;
```

Opens an OpenGL window (via GLFW) and lets you draw with pixel coordinates — `(0, 0)` is the top-left corner, x grows right, y grows down. The `gfx_` functions are thin L wrappers around a small C runtime (`Typescript/runtime/graphics.c`) that the compiler always links in, so building any program requires `libglfw` and `libGL` to be installed.

#### Setup and Loop

```
import graphics;

main() {
    gfx_init(800, 600);         // open an 800×600 window

    while (!gfx_closed()) {
        gfx_clear(0x0a0a1a);    // fill background

        // ... draw here ...

        gfx_present();          // swap buffers and poll events
    }

    gfx_destroy_window();
    return 0;
}
```

#### Window

| Function                   | Returns | Description                                                  |
|----------------------------|---------|--------------------------------------------------------------|
| `gfx_init(int w, int h)`   | —       | Open a `w × h` window titled "L Graphics" and set `WIDTH` / `HEIGHT` |
| `gfx_present()`            | —       | Show this frame: swap buffers and poll input events          |
| `gfx_closed()`             | `int`   | `1` once the user has closed the window, else `0`            |
| `gfx_destroy_window()`     | —       | Close the window and shut down GLFW                          |

#### Drawing

| Function                                                 | Description                |
|----------------------------------------------------------|----------------------------|
| `gfx_clear(int color)`                                   | Fill the entire screen     |
| `gfx_set_pixel(int x, int y, int color)`                 | Draw a single pixel        |
| `gfx_hline(int x, int y, int len, int color)`            | Horizontal line of `len` pixels, starting at `(x, y)` |
| `gfx_vline(int x, int y, int len, int color)`            | Vertical line of `len` pixels, starting at `(x, y)` |
| `gfx_line(int x0, int y0, int x1, int y1, int color)`    | Line between two points    |
| `gfx_rect(int x, int y, int w, int h, int color)`        | Filled rectangle           |
| `gfx_rect_border(int x, int y, int w, int h, int color)` | Rectangle outline          |

#### Colors

Colors are packed `0xRRGGBB` integers, and hex literals work directly:

```
gfx_rect(10, 10, 100, 50, 0xFF0000);   // red
gfx_rect(10, 70, 100, 50, 0x00FF00);   // green
gfx_rect(10, 130, 100, 50, 0x0000FF);  // blue
```

#### Input and Timing

| Function              | Returns | Description                                    |
|-----------------------|---------|------------------------------------------------|
| `gfx_key(int key)`    | `int`   | `1` while the given key is held down, else `0` |
| `gfx_get_time()`      | `float` | Seconds elapsed since `gfx_init`               |

#### Globals

| Global               | Value | Notes |
|----------------------|-------|-------|
| `WIDTH`, `HEIGHT`    | `800`, `600` until `gfx_init` runs | Updated by `gfx_init` to the window size |
| `KEY_SPACE`          | `32`  | |
| `KEY_A` `KEY_D` `KEY_S` `KEY_W` | `65` `68` `83` `87` | |
| `KEY_ESCAPE`         | `256` | |
| `KEY_ENTER`          | `257` | |
| `KEY_RIGHT` `KEY_LEFT` `KEY_DOWN` `KEY_UP` | `262` `263` `264` `265` | |
| `KEY_SHIFT`          | `340` | Left shift |

Key codes are GLFW key codes, so any key not listed can be passed as a number (e.g. `gfx_key(81)` for Q).

### string

`stdlib/string.l` is imported automatically when a program calls one of its functions, so there's no `import` to write (`import string;` also works). A program that defines its own function with one of these names keeps its own version, and the module isn't imported.

| Function                   | Result                                                               |
|----------------------------|----------------------------------------------------------------------|
| `str_split(s, sep)`        | A new `string[]` of the pieces of `s` between each `sep`; an empty `sep` gives `[s]` |
| `str_join(parts, sep)`     | The strings in `parts` with `sep` between each pair                  |
| `str_trim(s)`              | `s` without spaces, tabs, carriage returns and newlines at either end |
| `str_replace(s, from, to)` | `s` with every occurrence of `from` replaced by `to` (an empty `from` changes nothing) |
| `strtofloat(s)`            | The number at the start of `s`: optional sign, digits, fraction and exponent; leading spaces are skipped and parsing stops at anything else |
| `str_is_space(c)`          | `1` if `c` is a space, tab, newline or carriage return               |

```
var string line = "  ann, bob ,cy ";
var string[] names = str_split(str_trim(line), ",");
var i = 0;
while (i < names.len()) {
    names[i] = str_trim(names[i]);
    i++;
}
print(str_join(names, " & "));      // ann & bob & cy
print(strtofloat("2.5e1") + 1);     // 26
```

---

## Runtime Errors

Some mistakes can only be caught while the program runs. When one happens the program prints an error to stderr, after anything it has already printed, and exits with status 1:

| Error                                   | Cause                                                        |
|-----------------------------------------|--------------------------------------------------------------|
| `Error: index out of bounds`            | An array index outside the array, or `insert`/`remove` at one |
| `Error: division by zero`               | An integer `/` or `%` by zero                                |
| `Error: pop from an empty array`        | `pop()` on an array with no elements                         |
| `Error: key not found in map`           | Reading a map key that isn't there                           |
| `Error: P.f was never set (or is none)` | Reading a struct field that was never given a value, or is `none` |
| `Error: negative array size`            | `new int[n]` with a negative `n`                             |

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

**Heap values** — `string`, arrays, maps, structs, tuples. These are `malloc`'d on the heap. Every heap value has exactly one owner: the variable it was assigned to. When that owner goes out of scope, the compiler inserts a `free` call automatically.

There is no garbage collector. `free` calls are inserted statically at compile time based on where variables are declared, not at runtime based on reference counts or reachability.

### Ownership and Transfer

Strings are copied. Assigning a string from another variable, a string literal or a parameter gives the new variable its own copy, so each string variable owns its own memory and the two are independent:

```
var string a = inttostr(7);
var string b = a;       // b gets its own copy of "7"
a = inttostr(8);        // b is unaffected
print(b);               // 7
```

A string that is already new (the result of `+`, or of a call that returns a string) is not copied again; the variable simply takes ownership of it. A string parameter that the function reassigns is copied on entry, so the caller's string is never freed.

Arrays, structs and tuples are not copied: assigning one to another variable makes both refer to the same value. The variable that was given a *new* value (`new`, a literal, a struct, a call that returns a new value) **owns** it and frees it; any other variable holding it just **refers** to it:

```
var int[] a = [1, 2];     // a owns the array
var int[] b = a;          // b refers to a's array
print(b[1]);              // 2
b[0] = 9;                 // changes the array a owns
print(a[0]);              // 9
```

A variable that refers to another value (a copy of another variable, an element read out of an array, a struct field, a parameter, or the result of a call that may return one of its arguments) can't be used once that value may have been freed. The compiler reports an error if:

- the owner is reassigned (`a = new int[3];` frees a's old array, so `b` can't be used after it),
- an array or struct inside it is replaced (`d.tags = new int[2];` frees the old `d.tags`),
- it is moved into an array, struct or tuple,
- it is passed to a function that may change it (the compiler works out which parameters each function can change, so passing it to a function that only reads it is fine),
- the variable would outlive it (declared outside a loop but referring to something declared inside it).

Give the variable a new value and it can be used again. A variable that refers to something else also can't be stored into an array, struct or tuple (the container would free it too), and a function can't return something that points into its own locals. A parameter belongs to the caller, so it can't be stored into a container either.

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

A function that returns a string always hands the caller a string it owns. If the returned value isn't already a new string (for example a string literal, a parameter, a global or a variable), the compiler returns a copy of it, so the caller can free the result safely.

### Arrays Stored Inside Arrays

When you store a value into an array slot, ownership transfers into the array. The compiler will not also free it from its original variable. This matters most for 2D arrays:

```
var int[][] grid = new int[3][4];
// Each inner row is allocated and stored into grid.
// grid owns all three rows.
// When grid is freed, each row is freed first, then grid itself.
```

For a 2D array, the compiler inserts a loop that frees each row individually before freeing the outer array. This is handled automatically — you don't write it.

The same applies whenever you store an array or struct variable into an array slot, a struct field, a tuple or an array literal: the value moves into the container, which now owns it. The variable can't be used again until you assign it a new value — the compiler reports an error if you do:

```
var int[][] m = new int[2][3];
var int[] row = new int[3];
m[0] = row;         // row moves into m
row[1] = 7;         // error: row was stored into an array or struct
row = new int[3];   // fine: row holds a new array
row[1] = 7;         // fine
```

The check is conservative: if a variable is stored on only one branch of an `if`, or anywhere in a loop body, it counts as moved after the `if` and in the next iteration. Declaring the variable inside the loop avoids this, since each iteration gets a new one. Strings are copied into struct fields and tuples rather than moved, so a string variable stays usable.

### Global Arrays and Structs

When a global array, struct or tuple is reassigned, its old value is freed. The compiler makes sure nothing can still be pointing at that old value:

```
var int[] G = [1, 2];

main() {
    var int[] a = G;        // a points at G's current array
    G = new int[3];         // the old [1, 2] is freed
    print(a[0]);            // error: a points at G's old value
    a = new int[2];         // fine: a has its own array now
    return 0;
}
```

- A local copied from a global can't be used after the global is reassigned — in the same function, or by any function it calls — until the local is given a new value.
- A global (or a local copied from one) can't be passed to a function that may reassign that global, stored into an array, struct or tuple, returned from a function, or looped over by a `for` loop that reassigns it.
- A global can only be given a value nothing else points to: `new`, a literal, a struct or tuple, a slice, a call to a function that always returns a new value, or a local that owns its value. The local is moved into the global and can't be used afterwards.

Global strings are copied like any other string, so none of this applies to them.

### What Is and Isn't Safe

**Safe:** Creating, using, and returning heap values normally. The compiler handles the `free` placement.

**Safe:** Passing heap values to functions — the function receives a copy of the pointer, but the caller retains ownership and frees it after the call returns.

**Safe:** Variables that refer to another variable's array or struct, and values stored into containers. The compiler checks that nothing is used after it may have been freed (see [Ownership and Transfer](#ownership-and-transfer)), and reports an error instead of producing a program that reads freed memory.

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
- Sized integers and pointers are strict: a value only goes where it can't lose anything, and everything else needs a conversion like `u8(x)` or `ptr<u16>(x)` (see [Low-Level Programming](#low-level-programming))
- Memory reached through a pointer isn't checked: there are no bounds checks on `p[i]`, and L never frees it

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
