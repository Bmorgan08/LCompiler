const { execSync } = require("child_process");
const fs = require("fs");

const { Lexer } = require("../dist/Modules/Lexer");
const { parse } = require("../dist/Modules/Parser");
const { fold } = require("../dist/Modules/Optimize");
const { IRGen, printIR } = require("../dist/Modules/IR");
const { DCE, copyProp, cse } = require("../dist/Modules/Optimize");
const verbose = process.argv.includes("--verbose");

function getIR(source) {
    const tokens = Lexer(source);
    const ast = parse(tokens);
    const folded = fold(ast);
    const optimized = DCE(folded);
    return printIR(cse(copyProp(IRGen(optimized))));
}


const errorTests = []; 

const tests = [
    {
    name: "ownership: inttostr in loop",
    source: `
main() {
    var int i = 0;
    while (i < 1000) {
        var string s = inttostr(i);
        i = i + 1;
    }
    print(1);
    return 0;
}`,
    expected: "1"
},
{
    name: "ownership: str_concat in loop",
    source: `
main() {
    var int i = 0;
    while (i < 1000) {
        var string s = "hello " + "world";
        i = i + 1;
    }
    print(1);
    return 0;
}`,
    expected: "1"
},
{
    name: "ownership: chained concat in loop",
    source: `
main() {
    var int i = 0;
    while (i < 1000) {
        var string a = "foo" + "bar";
        var string b = a + "baz";
        i = i + 1;
    }
    print(1);
    return 0;
}`,
    expected: "1"
},
{
    name: "ownership: array in loop",
    source: `
main() {
    var int i = 0;
    while (i < 1000) {
        var int[] arr = new int[10];
        arr[0] = i;
        i = i + 1;
    }
    print(1);
    return 0;
}`,
    expected: "1"
},
{
    name: "ownership: inttostr then concat in loop",
    source: `
main() {
    var int i = 0;
    while (i < 1000) {
        var string s = inttostr(i);
        var string t = "value: " + s;
        i = i + 1;
    }
    print(1);
    return 0;
}`,
    expected: "1"
},
{
    name: "ownership: return string from function",
    source: `
function makeStr(int n) {
    var string s = inttostr(n);
    var string r = "n=" + s;
    return r;
}
main() {
    var int i = 0;
    while (i < 1000) {
        var string s = makeStr(i);
        i = i + 1;
    }
    print(1);
    return 0;
}`,
    expected: "1"
},
{
    name: "ownership: struct in loop",
    source: `
struct Point {
    var x: int;
    var y: int;
}
main() {
    var int i = 0;
    while (i < 1000) {
        var p = Point { x: i, y: i };
        i = i + 1;
    }
    print(1);
    return 0;
}`,
    expected: "1"
},
{
    name: "ownership: returned value is usable after function frees others",
    source: `
function process(int n) {
    var string a = inttostr(n);
    var string b = "unused " + a;
    var string r = "result: " + a;
    return r;
}
main() {
    var string s = process(42);
    print(s);
    return 0;
}`,
    expected: "result: 42"
},
    {
        name: "basic arithmetic",
        source: `
main() {
    var x = 2 + 3;
    print(x);
    return 0;
}`,
        expected: "5"
    },
    {
        name: "parentheses grouping",
        source: `
main() {
    var x = (2 + 3) * 4;
    print(x);
    return 0;
}`,
        expected: "20"
    },
    {
        name: "comparison eq",
        source: `
main() {
    var x = 5;
    var y = 5;
    var r = x == y;
    print(r);
    return 0;
}`,
        expected: "1"
    },
    {
        name: "comparison lt",
        source: `
main() {
    var x = 3;
    var y = 5;
    var r = x < y;
    print(r);
    return 0;
}`,
        expected: "1"
    },
    {
        name: "comparison gt",
        source: `
main() {
    var x = 5;
    var y = 3;
    var r = x > y;
    print(r);
    return 0;
}`,
        expected: "1"
    },
    {
        name: "comparison neq",
        source: `
main() {
    var x = 5;
    var y = 3;
    var r = x != y;
    print(r);
    return 0;
}`,
        expected: "1"
    },
    {
        name: "function call",
        source: `
function add(a, b) {
    return a + b;
}
main() {
    var x = add(5, 10);
    print(x);
    return 0;
}`,
        expected: "15"
    },
    {
        name: "nested function calls",
        source: `
function multiply(a, b) {
    return a * b;
}
function square(n) {
    return multiply(n, n);
}
main() {
    var x = square(5);
    print(x);
    return 0;
}`,
        expected: "25"
    },
    {
    name: "unary negation",
    source: `
main() {
    var x = 5;
    var y = -x;
    print(y);
    return 0;
}`,
    expected: "-5"
},
{
    name: "unary not",
    source: `
main() {
    var x = 0;
    var y = !x;
    print(y);
    return 0;
}`,
    expected: "1"
},
{
    name: "if true branch",
    source: `
main() {
    var x = 1;
    if (x == 1) {
        print(1);
    }
    return 0;
}`,
    expected: "1"
},
{
    name: "if false branch skipped",
    source: `
main() {
    var x = 0;
    if (x == 1) {
        print(1);
    }
    return 0;
}`,
    expected: ""
},
{
    name: "if else - true branch",
    source: `
main() {
    var x = 1;
    if (x == 1) {
        print(1);
    } else {
        print(0);
    }
    return 0;
}`,
    expected: "1"
},
{
    name: "if else - false branch",
    source: `
main() {
    var x = 0;
    if (x == 1) {
        print(1);
    } else {
        print(0);
    }
    return 0;
}`,
    expected: "0"
},
{
    name: "else if chain - first branch",
    source: `
main() {
    var x = 1;
    if (x == 1) {
        print(1);
    } else if (x == 2) {
        print(2);
    } else {
        print(3);
    }
    return 0;
}`,
    expected: "1"
},
{
    name: "else if chain - middle branch",
    source: `
main() {
    var x = 2;
    if (x == 1) {
        print(1);
    } else if (x == 2) {
        print(2);
    } else {
        print(3);
    }
    return 0;
}`,
    expected: "2"
},
{
    name: "else if chain - last branch",
    source: `
main() {
    var x = 99;
    if (x == 1) {
        print(1);
    } else if (x == 2) {
        print(2);
    } else {
        print(3);
    }
    return 0;
}`,
    expected: "3"
},
{
    name: "if with comparison gt",
    source: `
main() {
    var x = 10;
    if (x > 5) {
        print(1);
    } else {
        print(0);
    }
    return 0;
}`,
    expected: "1"
},
{
    name: "if inside function",
    source: `
function myabs(n) {
    if (n < 0) {
        return -n;
    } else {
        return n;
    }
}
main() {
    var x = myabs(-5);
    print(x);
    return 0;
}`,
    expected: "5"
},
{
    name: "while basic countdown",
    source: `
main() {
    var x = 3;
    while (x > 0) {
        x = x - 1;
    }
    print(x);
    return 0;
}`,
    expected: "0"
},
{
    name: "while never executes",
    source: `
main() {
    var x = 0;
    while (x > 0) {
        x = x - 1;
    }
    print(x);
    return 0;
}`,
    expected: "0"
},
{
    name: "while accumulator",
    source: `
main() {
    var sum = 0;
    var i = 1;
    while (i < 6) {
        sum = sum + i;
        i = i + 1;
    }
    print(sum);
    return 0;
}`,
    expected: "15"
},
{
    name: "while with if inside",
    source: `
main() {
    var i = 0;
    var count = 0;
    while (i < 10) {
        if (i == 5) {
            count = count + 1;
        }
        i = i + 1;
    }
    print(count);
    return 0;
}`,
    expected: "1"
},
{
    name: "while in function",
    source: `
function sumTo(n) {
    var sum = 0;
    var i = 1;
    while (i < n) {
        sum = sum + i;
        i = i + 1;
    }
    return sum;
}
main() {
    var x = sumTo(6);
    print(x);
    return 0;
}`,
    expected: "15"
},
{
    name: "for basic loop",
    source: `
main() {
    var sum = 0;
    for (var i = 0; i < 5; i = i + 1) {
        sum = sum + i;
    }
    print(sum);
    return 0;
}`,
    expected: "10"
},
{
    name: "for never executes",
    source: `
main() {
    var sum = 0;
    for (var i = 0; i < 0; i = i + 1) {
        sum = sum + 1;
    }
    print(sum);
    return 0;
}`,
    expected: "0"
},
{
    name: "for countdown",
    source: `
main() {
    var x = 0;
    for (var i = 5; i > 0; i = i - 1) {
        x = x + 1;
    }
    print(x);
    return 0;
}`,
    expected: "5"
},
{
    name: "for with if inside",
    source: `
main() {
    var count = 0;
    for (var i = 0; i < 10; i = i + 1) {
        if (i == 5) {
            count = count + 1;
        }
    }
    print(count);
    return 0;
}`,
    expected: "1"
},
{
    name: "for in function",
    source: `
function sumTo(n) {
    var sum = 0;
    for (var i = 0; i < n; i = i + 1) {
        sum = sum + i;
    }
    return sum;
}
main() {
    var x = sumTo(5);
    print(x);
    return 0;
}`,
    expected: "10"
},
{
    name: "nested for loops",
    source: `
main() {
    var count = 0;
    for (var i = 0; i < 3; i = i + 1) {
        for (var j = 0; j < 3; j = j + 1) {
            count = count + 1;
        }
    }
    print(count);
    return 0;
}`,
    expected: "9"
},
{
    name: "while break",
    source: `
main() {
    var x = 0;
    while (x < 10) {
        if (x == 5) {
            break;
        }
        x = x + 1;
    }
    print(x);
    return 0;
}`,
    expected: "5"
},
{
    name: "while continue",
    source: `
main() {
    var x = 0;
    var sum = 0;
    while (x < 10) {
        x = x + 1;
        if (x == 5) {
            continue;
        }
        sum = sum + 1;
    }
    print(sum);
    return 0;
}`,
    expected: "9"
},
{
    name: "for break",
    source: `
main() {
    var result = 0;
    for (var i = 0; i < 10; i = i + 1) {
        if (i == 5) {
            break;
        }
        result = result + 1;
    }
    print(result);
    return 0;
}`,
    expected: "5"
},
{
    name: "for continue",
    source: `
main() {
    var sum = 0;
    for (var i = 0; i < 10; i = i + 1) {
        if (i == 5) {
            continue;
        }
        sum = sum + 1;
    }
    print(sum);
    return 0;
}`,
    expected: "9"
},
{
    name: "nested loop break inner only",
    source: `
main() {
    var count = 0;
    for (var i = 0; i < 3; i = i + 1) {
        for (var j = 0; j < 3; j = j + 1) {
            if (j == 1) {
                break;
            }
            count = count + 1;
        }
    }
    print(count);
    return 0;
}`,
    expected: "3"
},
{
    name: "break in while in function",
    source: `
function firstOver(n) {
    var i = 0;
    while (i < 100) {
        if (i > n) {
            break;
        }
        i = i + 1;
    }
    return i;
}
main() {
    var x = firstOver(5);
    print(x);
    return 0;
}`,
    expected: "6"
},
// Valid typed declarations
{
    name: "typed int declaration",
    source: `
main() {
    var int x = 5;
    print(x);
    return 0;
}`,
    expected: "5"
},
{
    name: "untyped inferred int",
    source: `
main() {
    var x = 5;
    print(x);
    return 0;
}`,
    expected: "5"
},
{
    name: "typed int param",
    source: `
function double(int n) {
    return n + n;
}
main() {
    var x = double(5);
    print(x);
    return 0;
}`,
    expected: "10"
},
{
    name: "typed int params multiple",
    source: `
function add(int a, int b) {
    return a + b;
}
main() {
    var int x = add(3, 4);
    print(x);
    return 0;
}`,
    expected: "7"
},
{
    name: "typed var in for loop",
    source: `
main() {
    var int sum = 0;
    for (var int i = 0; i < 5; i = i + 1) {
        sum = sum + i;
    }
    print(sum);
    return 0;
}`,
    expected: "10"
},

// Type error tests
{
    name: "type mismatch on declaration",
    source: `
main() {
    var int x = 3;
    var bool y = x;
    return 0;
}`,
    shouldError: true
},
{
    name: "type mismatch on assign",
    source: `
main() {
    var int x = 5;
    var bool y = 1;
    x = y;
    return 0;
}`,
    shouldError: true
},
{
    name: "undefined variable",
    source: `
main() {
    print(z);
    return 0;
}`,
    shouldError: true
},
{
    name: "undefined function",
    source: `
main() {
    var x = foo(5);
    return 0;
}`,
    shouldError: true
},
{
    name: "wrong arg count",
    source: `
function add(int a, int b) {
    return a + b;
}
main() {
    var x = add(1);
    return 0;
}`,
    shouldError: true
},
{
    name: "string: print literal",
    source: `
main() {
    print("hello");
    return 0;
}`,
    expected: "hello"
},
{
    name: "string: print multiple literals",
    source: `
main() {
    print("hello");
    print("world");
    return 0;
}`,
    expected: "hello\nworld"
},
{
    name: "string: print empty string",
    source: `
main() {
    print("");
    return 0;
}`,
    expected: ""
},
{
    name: "string: print in if branch",
    source: `
main() {
    var x = 1;
    if (x == 1) {
        print("yes");
    } else {
        print("no");
    }
    return 0;
}`,
    expected: "yes"
},
{
    name: "string: print in loop",
    source: `
main() {
    var i = 0;
    while (i < 3) {
        print("hi");
        i = i + 1;
    }
    return 0;
}`,
    expected: "hi\nhi\nhi"
},
{
    name: "string: concatenate two literals",
    source: `
main() {
    var string x = "hello" + " world";
    print(x);
    return 0;
}`,
    expected: "hello world"
},
{
    name: "string: concatenate three literals",
    source: `
main() {
    var string x = "foo" + "bar";
    var string y = x + "baz";
    print(y);
    return 0;
}`,
    expected: "foobarbaz"
},
{
    name: "string: concatenate in if branch",
    source: `
main() {
    var string x = "hello";
    var string y = x + " world";
    if (1 == 1) {
        print(y);
    }
    return 0;
}`,
    expected: "hello world"
},
{
    name: "string: concatenate in function",
    source: `
function greet(string name) {
    return "hello " + name;
}
main() {
    var string x = greet("world");
    print(x);
    return 0;
}`,
    expected: "hello world"
},
{
    name: "string: get length of literal",
    source: `
main() {
    var string x = "hello";
    var int len = len(x);
    print(len);
    return 0;
}`,
    expected: "5"

},
{
    name: "string: get length of concatenated string",
    source: `
main() {
    var string x = "foo" + "bar";
    var int len = len(x);
    print(len);
    return 0;
}`,
    expected: "6"
},
{
    name: "string: get length in function",
    source: `
function length(string s) {
    return len(s);
}
main() {
    var string x = "hello world";
    var int n = length(x);
    print(n);
    return 0;
}`,
    expected: "11"
},
{
    name: "string: character access first (ascii)",
    source: `
main() {
    var string s = "hello";
    var int c = s[0];
    print(c);
    return 0;
}`,
    expected: "104"  // ascii 'h'
},
{
    name: "string: character access middle (ascii)",
    source: `
main() {
    var string s = "hello";
    var int c = s[1];
    print(c);
    return 0;
}`,
    expected: "101"  // ascii 'e'
},
{
    name: "string: character access last (ascii)",
    source: `
main() {
    var string s = "hello";
    var int c = s[4];
    print(c);
    return 0;
}`,
    expected: "111"  // ascii 'o'
},
{
    name: "string: character access in function (ascii)",
    source: `
function firstChar(string s) {
    return s[0];
}
main() {
    var int c = firstChar("world");
    print(c);
    return 0;
}`,
    expected: "119"  // ascii 'w'
},
{
    name: "string: character access with variable index (ascii)",
    source: `
main() {
    var string s = "hello";
    var int i = 2;
    var int c = s[i];
    print(c);
    return 0;
}`,
    expected: "108"  // ascii 'l'
},
{
    name: "string: character access first",
    source: `
main() {
    var string s = "hello";
    var int c = s[0];
    printchar(c);
    return 0;
}`,
    expected: "h"  // ascii 'h'
},
{
    name: "string: character access middle",
    source: `
main() {
    var string s = "hello";
    var int c = s[1];
    printchar(c);
    return 0;
}`,
    expected: "e"  // ascii 'e'
},
{
    name: "string: character access last",
    source: `
main() {
    var string s = "hello";
    var int c = s[4];
    printchar(c);
    return 0;
}`,
    expected: "o"  // ascii 'o'
},
{
    name: "string: character access in function",
    source: `
function firstChar(string s) {
    return s[0];
}
main() {
    var int c = firstChar("world");
    printchar(c);
    return 0;
}`,
    expected: "w"  // ascii 'w'
},
{
    name: "string: character access with variable index",
    source: `
main() {
    var string s = "hello";
    var int i = 2;
    var int c = s[i];
    printchar(c);
    return 0;
}`,
    expected: "l"  // ascii 'l'
},
{
    name: "string: equality true",
    source: `
main() {
    var string a = "hello";
    var string b = "hello";
    var int r = a == b;
    print(r);
    return 0;
}`,
    expected: "1"
},
{
    name: "string: equality false",
    source: `
main() {
    var string a = "hello";
    var string b = "world";
    var int r = a == b;
    print(r);
    return 0;
}`,
    expected: "0"
},
{
    name: "string: inequality true",
    source: `
main() {
    var string a = "hello";
    var string b = "world";
    var int r = a != b;
    print(r);
    return 0;
}`,
    expected: "1"
},
{
    name: "string: equality in if",
    source: `
main() {
    var string a = "hello";
    var string b = "hello";
    if (a == b) {
        print(1);
    }
    return 0;
}`,
    expected: "1"
},
{
    name: "string: strtoint basic",
    source: `
main() {
    var string s = "42";
    var int n = strtoint(s);
    print(n);
    return 0;
}`,
    expected: "42"
},
{
    name: "string: strtoint arithmetic",
    source: `
main() {
    var string s = "10";
    var int n = strtoint(s);
    var int r = n * 5;
    print(r);
    return 0;
}`,
    expected: "50"
},
{
    name: "string: inttostr basic",
    source: `
main() {
    var int n = 42;
    var string s = inttostr(n);
    print(s);
    return 0;
}`,
    expected: "42"
},
{
    name: "string: inttostr concat",
    source: `
main() {
    var int n = 42;
    var string s = "value: " + inttostr(n);
    print(s);
    return 0;
}`,
    expected: "value: 42"
},
{
    name: "string: roundtrip int to string to int",
    source: `
main() {
    var int n = 99;
    var string s = inttostr(n);
    var int m = strtoint(s);
    print(m);
    return 0;
}`,
    expected: "99"
},
{
    name: "string: inequality false",
    source: `
main() {
    var string a = "hello";
    var string b = "hello";
    var int r = a != b;
    print(r);
    return 0;
}`,
    expected: "0"
},
{
    name: "string: inttostr then len",
    source: `
main() {
    var int n = 12345;
    var string s = inttostr(n);
    var int l = len(s);
    print(l);
    return 0;
}`,
    expected: "5"
},
{
    name: "string: equality in if else false branch",
    source: `
main() {
    var string a = "hello";
    var string b = "world";
    if (a == b) {
        print(1);
    } else {
        print(0);
    }
    return 0;
}`,
    expected: "0"
},
{
    name: "string: pass concat result to function",
    source: `
function length(string s) {
    return len(s);
}
main() {
    var string a = "foo";
    var string b = "bar";
    var int n = length(a + b);
    print(n);
    return 0;
}`,
    expected: "6"
},
// Array tests
{
    name: "array: create and access literal",
    source: `
main() {
    var int[] arr = [1, 2, 3];
    print(arr[0]);
    return 0;
}`,
    expected: "1"
},
{
    name: "array: access middle element",
    source: `
main() {
    var int[] arr = [10, 20, 30];
    print(arr[1]);
    return 0;
}`,
    expected: "20"
},
{
    name: "array: access last element",
    source: `
main() {
    var int[] arr = [10, 20, 30];
    print(arr[2]);
    return 0;
}`,
    expected: "30"
},
{
    name: "array: modify element",
    source: `
main() {
    var int[] arr = [1, 2, 3];
    arr[0] = 99;
    print(arr[0]);
    return 0;
}`,
    expected: "99"
},
{
    name: "array: len",
    source: `
main() {
    var int[] arr = [1, 2, 3];
    print(arr.len());
    return 0;
}`,
    expected: "3"
},
{
    name: "array: new fixed size",
    source: `
main() {
    var int[] arr = new int[5];
    print(arr.len());
    return 0;
}`,
    expected: "5"
},
{
    name: "array: new and assign",
    source: `
main() {
    var int[] arr = new int[3];
    arr[0] = 10;
    arr[1] = 20;
    arr[2] = 30;
    print(arr[1]);
    return 0;
}`,
    expected: "20"
},
{
    name: "array: variable index",
    source: `
main() {
    var int[] arr = [10, 20, 30];
    var int i = 1;
    print(arr[i]);
    return 0;
}`,
    expected: "20"
},
{
    name: "array: sum elements in loop",
    source: `
main() {
    var int[] arr = [1, 2, 3, 4, 5];
    var int sum = 0;
    var int i = 0;
    while (i < arr.len()) {
        sum = sum + arr[i];
        i = i + 1;
    }
    print(sum);
    return 0;
}`,
    expected: "15"
},
{
    name: "array: pass to function",
    source: `
function first(int[] arr) {
    return arr[0];
}
main() {
    var int[] arr = [42, 99, 7];
    var int x = first(arr);
    print(x);
    return 0;
}`,
    expected: "42"
},
{
    name: "array: bounds check triggers on overflow",
    source: `
main() {
    var int[] arr = [1, 2, 3];
    print(arr[5]);
    return 0;
}`,
    shouldError: true
},
{
    name: "array: bounds check triggers on negative",
    source: `
main() {
    var int[] arr = [1, 2, 3];
    print(arr[-1]);
    return 0;
}`,
    shouldError: true
},
{
    name: "array: for loop fill and read",
    source: `
main() {
    var int[] arr = new int[5];
    for (var int i = 0; i < 5; i = i + 1) {
        arr[i] = i * 2;
    }
    print(arr[3]);
    return 0;
}`,
    expected: "6"
},
{
    name: "array: nested access",
    source: `
main() {
    var int[] arr = [5, 10, 15];
    var int x = arr[0] + arr[2];
    print(x);
    return 0;
}`,
    expected: "20"
},
// Struct tests
{
    name: "struct: basic field access",
    source: `
struct Point {
    var x: int;
    var y: int;
}
main() {
    var p = Point { x: 3, y: 4 };
    print(p.x);
    return 0;
}`,
    expected: "3"
},
{
    name: "struct: multiple field access",
    source: `
struct Point {
    var x: int;
    var y: int;
}
main() {
    var p = Point { x: 3, y: 4 };
    var sum = p.x + p.y;
    print(sum);
    return 0;
}`,
    expected: "7"
},
{
    name: "struct: field assign var",
    source: `
struct Point {
    var x: int;
    var y: int;
}
main() {
    var p = Point { x: 3, y: 4 };
    p.x = 10;
    print(p.x);
    return 0;
}`,
    expected: "10"
},
{
    name: "struct: const field cannot be assigned",
    source: `
struct Point {
    const x: int;
    var y: int;
}
main() {
    var p = Point { x: 3, y: 4 };
    p.x = 10;
    return 0;
}`,
    shouldError: true
},
{
    name: "struct: method call",
    source: `
struct Counter {
    var count: int;

    fn get() {
        print(this.count);
    }
}
main() {
    var c = Counter { count: 42 };
    c.get();
    return 0;
}`,
    expected: "42"
},
{
    name: "struct: string field",
    source: `
struct Person {
    var name: string;
}
main() {
    var p = Person { name: "Alice" };
    print(p.name);
    return 0;
}`,
    expected: "Alice"
},
{
    name: "struct: string field method",
    source: `
struct Person {
    var name: string;

    fn greet() {
        print(this.name);
    }
}
main() {
    var p = Person { name: "Bob" };
    p.greet();
    return 0;
}`,
    expected: "Bob"
},
{
    name: "struct: inheritance field access",
    source: `
struct Animal {
    var name: string;
}
struct Dog extends Animal {
    var breed: string;
}
main() {
    var d = Dog { name: "Rex", breed: "Labrador" };
    print(d.breed);
    return 0;
}`,
    expected: "Labrador"
},
{
    name: "struct: inherited method",
    source: `
struct Animal {
    var name: string;

    fn speak() {
        print(this.name);
    }
}
struct Dog extends Animal {
    var breed: string;
}
main() {
    var d = Dog { name: "Rex", breed: "Labrador" };
    d.speak();
    return 0;
}`,
    expected: "Rex"
},
{
    name: "struct: overridden method",
    source: `
struct Animal {
    var name: string;

    fn speak() {
        print(this.name);
    }
}
struct Dog extends Animal {
    var breed: string;

    overrides {
        fn speak() {
            print(this.breed);
        }
    }
}
main() {
    var d = Dog { name: "Rex", breed: "Labrador" };
    d.speak();
    return 0;
}`,
    expected: "Labrador"
},
{
    name: "struct: base method still works after override in child",
    source: `
struct Animal {
    var name: string;

    fn speak() {
        print(this.name);
    }
}
struct Dog extends Animal {
    var breed: string;

    overrides {
        fn speak() {
            print(this.breed);
        }
    }
}
main() {
    var a = Animal { name: "Generic" };
    var d = Dog { name: "Rex", breed: "Labrador" };
    a.speak();
    d.speak();
    return 0;
}`,
    expected: "Generic\nLabrador"
},
{
    name: "struct: field used in arithmetic",
    source: `
struct Rect {
    var width: int;
    var height: int;
}
main() {
    var r = Rect { width: 5, height: 4 };
    var area = r.width * r.height;
    print(area);
    return 0;
}`,
    expected: "20"
},
{
    name: "struct: two instances independent",
    source: `
struct Point {
    var x: int;
    var y: int;
}
main() {
    var a = Point { x: 1, y: 2 };
    var b = Point { x: 10, y: 20 };
    print(a.x);
    print(b.x);
    return 0;
}`,
    expected: "1\n10"
},
{
    name: "struct: field assign does not affect other instance",
    source: `
struct Point {
    var x: int;
    var y: int;
}
main() {
    var a = Point { x: 1, y: 2 };
    var b = Point { x: 10, y: 20 };
    a.x = 99;
    print(a.x);
    print(b.x);
    return 0;
}`,
    expected: "99\n10"
},
{
    name: "struct: pass to function",
    source: `
struct Point {
    var x: int;
    var y: int;
}
fn getX(Point p) {
    return p.x;
}
main() {
    var p = Point { x: 7, y: 3 };
    var x = getX(p);
    print(x);
    return 0;
}`,
    expected: "7"
},

// ── bool tests ──────────────────────────────────────────────────────────────
{
    name: "bool: true literal",
    source: `main() { var bool b = true; print(b); return 0; }`,
    expected: "1"
},
{
    name: "bool: false literal",
    source: `main() { var bool b = false; print(b); return 0; }`,
    expected: "0"
},
{
    name: "bool: and both true",
    source: `main() { var bool a = true; var bool b = true; print(a && b); return 0; }`,
    expected: "1"
},
{
    name: "bool: and one false",
    source: `main() { var bool a = true; var bool b = false; print(a && b); return 0; }`,
    expected: "0"
},
{
    name: "bool: or both false",
    source: `main() { var bool a = false; var bool b = false; print(a || b); return 0; }`,
    expected: "0"
},
{
    name: "bool: or one true",
    source: `main() { var bool a = false; var bool b = true; print(a || b); return 0; }`,
    expected: "1"
},
{
    name: "bool: not true",
    source: `main() { var bool b = true; var bool r = !b; print(r); return 0; }`,
    expected: "0"
},
{
    name: "bool: not false",
    source: `main() { var bool b = false; var bool r = !b; print(r); return 0; }`,
    expected: "1"
},
{
    name: "bool: comparison returns bool",
    source: `main() { var bool b = 5 > 3; print(b); return 0; }`,
    expected: "1"
},
{
    name: "bool: in if condition",
    source: `main() { var bool b = true; if (b) { print(1); } return 0; }`,
    expected: "1"
},
{
    name: "bool: in while condition",
    source: `main() { var bool b = true; var int i = 0; while (b) { i = i + 1; if (i == 3) { b = false; } } print(i); return 0; }`,
    expected: "3"
},
{
    name: "bool: short-circuit && stops early",
    source: `main() { var int x = 0; var bool r = false && (x == 1); print(r); return 0; }`,
    expected: "0"
},
{
    name: "bool: short-circuit || stops early",
    source: `main() { var int x = 0; var bool r = true || (x == 1); print(r); return 0; }`,
    expected: "1"
},
{
    name: "bool: chained && and ||",
    source: `main() { var bool r = true && false || true; print(r); return 0; }`,
    expected: "1"
},

// ── float tests ──────────────────────────────────────────────────────────────
{
    name: "float: literal",
    source: `main() { var float x = 3.14; print(x); return 0; }`,
    expected: "3.14"
},
{
    name: "float: addition",
    source: `main() { var float x = 1.5; var float y = 2.5; var float z = x + y; print(z); return 0; }`,
    expected: "4"
},
{
    name: "float: subtraction",
    source: `main() { var float x = 5.0; var float y = 2.5; var float z = x - y; print(z); return 0; }`,
    expected: "2.5"
},
{
    name: "float: multiplication",
    source: `main() { var float x = 2.0; var float y = 3.5; var float z = x * y; print(z); return 0; }`,
    expected: "7"
},
{
    name: "float: division",
    source: `main() { var float x = 7.0; var float y = 2.0; var float z = x / y; print(z); return 0; }`,
    expected: "3.5"
},
{
    name: "float: comparison lt true",
    source: `main() { var float x = 1.5; var float y = 2.5; print(x < y); return 0; }`,
    expected: "1"
},
{
    name: "float: comparison gt false",
    source: `main() { var float x = 1.5; var float y = 2.5; print(x > y); return 0; }`,
    expected: "0"
},
{
    name: "float: equality true",
    source: `main() { var float x = 1.5; var float y = 1.5; print(x == y); return 0; }`,
    expected: "1"
},
{
    name: "float: negation",
    source: `main() { var float x = 3.5; var float y = -x; print(y); return 0; }`,
    expected: "-3.5"
},
{
    name: "float: in function",
    source: `
function area(float r) {
    return r * r;
}
main() { var float a = area(3.0); print(a); return 0; }`,
    expected: "9"
},
{
    name: "float: in if",
    source: `main() { var float x = 2.5; if (x > 2.0) { print(1); } return 0; }`,
    expected: "1"
},
{
    name: "float: in while loop",
    source: `
main() {
    var float x = 0.0;
    var int i = 0;
    while (i < 4) {
        x = x + 0.5;
        i = i + 1;
    }
    print(x);
    return 0;
}`,
    expected: "2"
},

// ── 2D array tests ────────────────────────────────────────────────────────────
{
    name: "array2d: create and access",
    source: `
main() {
    var int[][] g = new int[3][3];
    g[1][2] = 42;
    print(g[1][2]);
    return 0;
}`,
    expected: "42"
},
{
    name: "array2d: fill and read",
    source: `
main() {
    var int[][] g = new int[2][3];
    var int i = 0;
    while (i < 2) {
        var int j = 0;
        while (j < 3) {
            g[i][j] = i * 3 + j;
            j = j + 1;
        }
        i = i + 1;
    }
    print(g[1][2]);
    return 0;
}`,
    expected: "5"
},
{
    name: "array2d: sum all elements",
    source: `
main() {
    var int[][] g = new int[3][3];
    var int i = 0;
    while (i < 3) {
        var int j = 0;
        while (j < 3) {
            g[i][j] = i + j;
            j = j + 1;
        }
        i = i + 1;
    }
    var int total = 0;
    i = 0;
    while (i < 3) {
        var int j = 0;
        while (j < 3) {
            total = total + g[i][j];
            j = j + 1;
        }
        i = i + 1;
    }
    print(total);
    return 0;
}`,
    expected: "18"
},
{
    name: "array2d: pass to function",
    source: `
function getVal(int[][] g, int r, int c) {
    return g[r][c];
}
main() {
    var int[][] g = new int[2][2];
    g[0][0] = 10;
    g[0][1] = 20;
    g[1][0] = 30;
    g[1][1] = 40;
    print(getVal(g, 1, 1));
    return 0;
}`,
    expected: "40"
},

// ── Compound assignment ────────────────────────────────────────────────────
{
    name: "compound assign: +=",
    source: `
main() {
    var int x = 5;
    x += 3;
    print(x);
    return 0;
}`,
    expected: "8"
},
{
    name: "compound assign: -=",
    source: `
main() {
    var int x = 10;
    x -= 4;
    print(x);
    return 0;
}`,
    expected: "6"
},
{
    name: "compound assign: *=",
    source: `
main() {
    var int x = 3;
    x *= 7;
    print(x);
    return 0;
}`,
    expected: "21"
},
{
    name: "compound assign: /=",
    source: `
main() {
    var int x = 20;
    x /= 4;
    print(x);
    return 0;
}`,
    expected: "5"
},
{
    name: "compound assign: %=",
    source: `
main() {
    var int x = 17;
    x %= 5;
    print(x);
    return 0;
}`,
    expected: "2"
},
{
    name: "compound assign: in loop",
    source: `
main() {
    var int sum = 0;
    var int i = 0;
    while (i < 5) {
        sum += i;
        i += 1;
    }
    print(sum);
    return 0;
}`,
    expected: "10"
},

// ── ++ / -- operators ──────────────────────────────────────────────────────
{
    name: "postfix ++",
    source: `
main() {
    var int x = 5;
    x++;
    print(x);
    return 0;
}`,
    expected: "6"
},
{
    name: "postfix --",
    source: `
main() {
    var int x = 5;
    x--;
    print(x);
    return 0;
}`,
    expected: "4"
},
{
    name: "++ in loop",
    source: `
main() {
    var int i = 0;
    var int sum = 0;
    while (i < 5) {
        sum += i;
        i++;
    }
    print(sum);
    return 0;
}`,
    expected: "10"
},

// ── for-in ─────────────────────────────────────────────────────────────────
{
    name: "for-in: sum array elements",
    source: `
main() {
    var int[] arr = [1, 2, 3, 4, 5];
    var int sum = 0;
    for (x in arr) {
        sum += x;
    }
    print(sum);
    return 0;
}`,
    expected: "15"
},
{
    name: "for-in: print each element",
    source: `
main() {
    var int[] arr = [10, 20, 30];
    var int last = 0;
    for (v in arr) {
        last = v;
    }
    print(last);
    return 0;
}`,
    expected: "30"
},
{
    name: "for-in: count elements",
    source: `
main() {
    var int[] arr = [5, 5, 5, 5];
    var int count = 0;
    for (x in arr) {
        count += 1;
    }
    print(count);
    return 0;
}`,
    expected: "4"
},

// ── char literals ──────────────────────────────────────────────────────────
{
    name: "char: literal value",
    source: `
main() {
    var int c = 'A';
    print(c);
    return 0;
}`,
    expected: "65"
},
{
    name: "char: comparison",
    source: `
main() {
    var int c = 'a';
    if (c == 97) {
        print(1);
    } else {
        print(0);
    }
    return 0;
}`,
    expected: "1"
},
{
    name: "char: arithmetic",
    source: `
main() {
    var int c = 'A';
    var int d = c + 1;
    print(d);
    return 0;
}`,
    expected: "66"
},

// ── Array slice ─────────────────────────────────────────────────────────────
{
    name: "array slice: basic",
    source: `
main() {
    var int[] arr = [10, 20, 30, 40, 50];
    var int[] sl = arr[1..3];
    print(sl[0]);
    return 0;
}`,
    expected: "20"
},
{
    name: "array slice: length",
    source: `
main() {
    var int[] arr = [1, 2, 3, 4, 5];
    var int[] sl = arr[2..5];
    print(sl.len());
    return 0;
}`,
    expected: "3"
},

// ── match statement ────────────────────────────────────────────────────────
{
    name: "match: integer literal arms",
    source: `
main() {
    var int x = 2;
    match (x) {
        1 => { print(10); }
        2 => { print(20); }
        3 => { print(30); }
        _ => { print(99); }
    }
    return 0;
}`,
    expected: "20"
},
{
    name: "match: wildcard arm",
    source: `
main() {
    var int x = 99;
    match (x) {
        1 => { print(1); }
        _ => { print(0); }
    }
    return 0;
}`,
    expected: "0"
},
{
    name: "match: expression as subject",
    source: `
main() {
    var int x = 5;
    var int y = 3;
    match (x - y) {
        1 => { print(1); }
        2 => { print(2); }
        _ => { print(3); }
    }
    return 0;
}`,
    expected: "2"
},

// ── Tuples ─────────────────────────────────────────────────────────────────
{
    name: "tuple: access elements",
    source: `
function makePair() {
    return (10, 20);
}
main() {
    var t = makePair();
    print(t.1);
    return 0;
}`,
    expected: "20"
},
{
    name: "tuple: first element",
    source: `
function getFirst() {
    return (42, 99);
}
main() {
    var t = getFirst();
    print(t.0);
    return 0;
}`,
    expected: "42"
},

// ── math stdlib ──────────────────────────────────────────────────────────────
{
    name: "math: math_abs positive",
    source: `
import math;
main() {
    print(math_abs(7));
    return 0;
}`,
    expected: "7"
},
{
    name: "math: math_abs negative",
    source: `
import math;
main() {
    print(math_abs(-5));
    return 0;
}`,
    expected: "5"
},
{
    name: "math: math_abs zero",
    source: `
import math;
main() {
    print(math_abs(0));
    return 0;
}`,
    expected: "0"
},
{
    name: "math: math_max picks larger",
    source: `
import math;
main() {
    print(math_max(3, 9));
    return 0;
}`,
    expected: "9"
},
{
    name: "math: math_max left wins",
    source: `
import math;
main() {
    print(math_max(10, 2));
    return 0;
}`,
    expected: "10"
},
{
    name: "math: math_max equal",
    source: `
import math;
main() {
    print(math_max(5, 5));
    return 0;
}`,
    expected: "5"
},
{
    name: "math: math_min picks smaller",
    source: `
import math;
main() {
    print(math_min(3, 9));
    return 0;
}`,
    expected: "3"
},
{
    name: "math: math_min right wins",
    source: `
import math;
main() {
    print(math_min(10, 2));
    return 0;
}`,
    expected: "2"
},
{
    name: "math: math_toint truncates positive float",
    source: `
import math;
main() {
    print(math_toint(3.9));
    return 0;
}`,
    expected: "3"
},
{
    name: "math: math_toint truncates negative float",
    source: `
import math;
main() {
    print(math_toint(-2.7));
    return 0;
}`,
    expected: "-2"
},
{
    name: "math: math_tofloat converts int",
    source: `
import math;
main() {
    var float f = math_tofloat(4);
    print(f);
    return 0;
}`,
    expected: "4"
},
{
    name: "math: math_floor positive",
    source: `
import math;
main() {
    print(math_floor(3.7));
    return 0;
}`,
    expected: "3"
},
{
    name: "math: math_floor exact integer",
    source: `
import math;
main() {
    print(math_floor(5.0));
    return 0;
}`,
    expected: "5"
},
{
    name: "math: math_floor negative non-integer",
    source: `
import math;
main() {
    print(math_floor(-2.3));
    return 0;
}`,
    expected: "-3"
},
{
    name: "math: math_floor negative exact",
    source: `
import math;
main() {
    print(math_floor(-3.0));
    return 0;
}`,
    expected: "-3"
},
{
    name: "math: math_roof positive non-integer",
    source: `
import math;
main() {
    print(math_roof(2.1));
    return 0;
}`,
    expected: "3"
},
{
    name: "math: math_roof positive exact",
    source: `
import math;
main() {
    print(math_roof(4.0));
    return 0;
}`,
    expected: "4"
},
{
    name: "math: math_roof negative non-integer",
    source: `
import math;
main() {
    print(math_roof(-1.7));
    return 0;
}`,
    expected: "-1"
},
{
    name: "math: math_round rounds up",
    source: `
import math;
main() {
    print(math_round(2.5));
    return 0;
}`,
    expected: "3"
},
{
    name: "math: math_round rounds down",
    source: `
import math;
main() {
    print(math_round(2.4));
    return 0;
}`,
    expected: "2"
},
{
    name: "math: math_round exact integer",
    source: `
import math;
main() {
    print(math_round(7.0));
    return 0;
}`,
    expected: "7"
},
{
    name: "math: math_fmod basic",
    source: `
import math;
main() {
    var float r = math_fmod(7.5, 3.0);
    print(math_toint(r));
    return 0;
}`,
    expected: "1"
},
{
    name: "math: math_fmod exact divisor",
    source: `
import math;
main() {
    var float r = math_fmod(6.0, 3.0);
    print(math_toint(r));
    return 0;
}`,
    expected: "0"
},
{
    name: "math: chained math calls",
    source: `
import math;
main() {
    print(math_max(math_abs(-3), math_min(5, 2)));
    return 0;
}`,
    expected: "3"
},
{
    name: "math: math_sin(0) = 0",
    source: `
import math;
main() {
    var float r = math_sin(0.0);
    print(r);
    return 0;
}`,
    expected: "0"
},
{
    name: "math: math_sin(pi/2) = 1",
    source: `
import math;
main() {
    var float r = math_sin(1.5707963268);
    print(r);
    return 0;
}`,
    expected: "1"
},
{
    name: "math: math_sin(pi) = 0",
    source: `
import math;
main() {
    var float r = math_sin(3.1415926536);
    print(r);
    return 0;
}`,
    expected: "0"
},
{
    name: "math: math_cos(0) = 1",
    source: `
import math;
main() {
    var float r = math_cos(0.0);
    print(r);
    return 0;
}`,
    expected: "1"
},
{
    name: "math: math_cos(pi) = -1",
    source: `
import math;
main() {
    var float r = math_cos(3.1415926536);
    print(r);
    return 0;
}`,
    expected: "-1"
},
{
    name: "math: sin^2 + cos^2 = 1 (at pi/4)",
    source: `
import math;
main() {
    var float a = 0.7853981634;
    var float s = math_sin(a);
    var float c = math_cos(a);
    var float sum = s * s + c * c;
    print(math_round(sum));
    return 0;
}`,
    expected: "1"
},
{
    name: "math: math_tan(0) = 0",
    source: `
import math;
main() {
    var float r = math_tan(0.0);
    print(r);
    return 0;
}`,
    expected: "0"
},
{
    name: "math: math_tan(pi/4) = 1",
    source: `
import math;
main() {
    var float r = math_tan(0.7853981634);
    print(math_round(r));
    return 0;
}`,
    expected: "1"
},
{
    name: "math: math_tan(pi/3) ~ 1.732",
    source: `
import math;
main() {
    var float r = math_tan(1.0471975512);
    var float rounded = math_fmod(r * 1000.0, 1000.0);
    print(math_toint(r * 1000.0));
    return 0;
}`,
    expected: "1732"
},
{
    name: "math: math_tan negative angle",
    source: `
import math;
main() {
    var float r = math_tan(-0.7853981634);
    print(math_round(r));
    return 0;
}`,
    expected: "-1"
},
{
    name: "math: math_sqrt(0) = 0",
    source: `
import math;
main() {
    print(math_sqrt(0.0));
    return 0;
}`,
    expected: "0"
},
{
    name: "math: math_sqrt(1) = 1",
    source: `
import math;
main() {
    print(math_sqrt(1.0));
    return 0;
}`,
    expected: "1"
},
{
    name: "math: math_sqrt(4) = 2",
    source: `
import math;
main() {
    print(math_sqrt(4.0));
    return 0;
}`,
    expected: "2"
},
{
    name: "math: math_sqrt(9) = 3",
    source: `
import math;
main() {
    print(math_sqrt(9.0));
    return 0;
}`,
    expected: "3"
},
{
    name: "math: math_sqrt(2) ~ 1.41421",
    source: `
import math;
main() {
    var float r = math_sqrt(2.0);
    print(r);
    return 0;
}`,
    expected: "1.41421"
},
{
    name: "math: sqrt(x)^2 = x (at 7)",
    source: `
import math;
main() {
    var float r = math_sqrt(7.0);
    print(math_round(r * r));
    return 0;
}`,
    expected: "7"
},
{
    name: "math: math_ln(1) = 0",
    source: `
import math;
main() {
    print(math_ln(1.0));
    return 0;
}`,
    expected: "0"
},
{
    name: "math: math_ln(e) = 1",
    source: `
import math;
main() {
    var float r = math_ln(2.718281828);
    print(math_round(r));
    return 0;
}`,
    expected: "1"
},
{
    name: "math: math_ln(2) ~ 0.693147",
    source: `
import math;
main() {
    print(math_ln(2.0));
    return 0;
}`,
    expected: "0.693147"
},
{
    name: "math: math_ln(10) ~ 2.30259",
    source: `
import math;
main() {
    print(math_ln(10.0));
    return 0;
}`,
    expected: "2.30259"
},
{
    name: "math: math_pow(2, 3) = 8",
    source: `
import math;
main() {
    var float r = math_pow(2.0, 3.0);
    print(math_round(r));
    return 0;
}`,
    expected: "8"
},
{
    name: "math: math_pow(9, 0.5) = 3 (square root)",
    source: `
import math;
main() {
    var float r = math_pow(9.0, 0.5);
    print(math_round(r));
    return 0;
}`,
    expected: "3"
},

// ── import system ─────────────────────────────────────────────────────────────
{
    name: "import: deduplication (import math twice does not double-define)",
    source: `
import math;
import math;
main() {
    print(math_abs(-1));
    return 0;
}`,
    expected: "1"
},

// ── inline asm ────────────────────────────────────────────────────────────────
{
    name: "asm: verbatim nop does not crash",
    source: `
main() {
    asm { nop }
    print(42);
    return 0;
}`,
    expected: "42"
},

// ── float arithmetic ──────────────────────────────────────────────────────────
{
    name: "float: addition and toint",
    source: `
main() {
    var float a = 1.5;
    var float b = 2.5;
    var float c = a + b;
    print(math_toint(c));
    return 0;
}
function math_toint(float x) {
    var int i = x;
    return i;
}`,
    expected: "4"
},
{
    name: "float: implicit int-to-float widening",
    source: `
main() {
    var int n = 3;
    var float f = n;
    print(f);
    return 0;
}`,
    expected: "3"
},
{
    name: "float: implicit float-to-int truncation",
    source: `
main() {
    var float f = 9.9;
    var int n = f;
    print(n);
    return 0;
}`,
    expected: "9"
},
{
    name: "float: negative literal constant fold",
    source: `
main() {
    var float f = -3.5;
    var int check = f < 0.0;
    print(check);
    return 0;
}`,
    expected: "1"
},

// ── for-in with floats ────────────────────────────────────────────────────────
{
    name: "for-in: modifies loop body correctly",
    source: `
main() {
    var int[] arr = [10, 20, 30, 40];
    var int sum = 0;
    for (x in arr) {
        sum += x;
    }
    print(sum);
    return 0;
}`,
    expected: "100"
},

// ── match ──────────────────────────────────────────────────────────────────────
{
    name: "match: multiple arms first matches",
    source: `
main() {
    var int x = 1;
    match (x) {
        1 => { print(100); }
        2 => { print(200); }
        _ => { print(0); }
    }
    return 0;
}`,
    expected: "100"
},
{
    name: "match: falls through to wildcard",
    source: `
main() {
    var int x = 99;
    match (x) {
        1 => { print(1); }
        2 => { print(2); }
        _ => { print(999); }
    }
    return 0;
}`,
    expected: "999"
},

// ── postfix / compound assign edge cases ──────────────────────────────────────
{
    name: "compound assign: %= remainder",
    source: `
main() {
    var int x = 17;
    x %= 5;
    print(x);
    return 0;
}`,
    expected: "2"
},
{
    name: "postfix: -- in while condition",
    source: `
main() {
    var int x = 3;
    var int sum = 0;
    while (x > 0) {
        sum += x;
        x--;
    }
    print(sum);
    return 0;
}`,
    expected: "6"
},

// ── char ──────────────────────────────────────────────────────────────────────
{
    name: "char: char literal as int code",
    source: `
main() {
    var int code = 'A';
    print(code);
    return 0;
}`,
    expected: "65"
},
{
    name: "char: arithmetic on char code",
    source: `
main() {
    var int a = 'a';
    print(a + 1);
    return 0;
}`,
    expected: "98"
},

// ── array slice ───────────────────────────────────────────────────────────────
{
    name: "array slice: sum of slice",
    source: `
main() {
    var int[] arr = [1, 2, 3, 4, 5];
    var int[] sl = arr[1..4];
    var int sum = 0;
    var int i = 0;
    while (i < sl.len()) {
        sum += sl[i];
        i++;
    }
    print(sum);
    return 0;
}`,
    expected: "9"
},

// ── structs ───────────────────────────────────────────────────────────────────
{
    name: "struct: basic field access",
    source: `
struct Point {
    var x: int;
    var y: int;
}
main() {
    var p = Point { x: 3, y: 7 };
    print(p.x + p.y);
    return 0;
}`,
    expected: "10"
},
{
    name: "struct: field assign",
    source: `
struct Counter {
    var n: int;
}
main() {
    var c = Counter { n: 0 };
    c.n = 42;
    print(c.n);
    return 0;
}`,
    expected: "42"
},
{
    name: "struct: method call",
    source: `
struct Box {
    var val: int;
    fn get() { return this.val; }
}
main() {
    var b = Box { val: 99 };
    print(b.get());
    return 0;
}`,
    expected: "99"
},
{
    name: "struct: inheritance field access",
    source: `
struct Animal {
    var legs: int;
}
struct Dog extends Animal {
    var bark: int;
}
main() {
    var d = Dog { legs: 4, bark: 1 };
    print(d.legs);
    return 0;
}`,
    expected: "4"
},

// ── 2D arrays ─────────────────────────────────────────────────────────────────
{
    name: "array2d: write and read element",
    source: `
main() {
    var int[][] grid = new int[3][4];
    grid[1][2] = 77;
    print(grid[1][2]);
    return 0;
}`,
    expected: "77"
},
{
    name: "array2d: loop fill and sum",
    source: `
main() {
    var int[][] m = new int[2][3];
    var int r = 0;
    while (r < 2) {
        var int c = 0;
        while (c < 3) {
            m[r][c] = r + c;
            c++;
        }
        r++;
    }
    print(m[1][2]);
    return 0;
}`,
    expected: "3"
},

// ── string builtins ───────────────────────────────────────────────────────────
{
    name: "string: inttostr and concat",
    source: `
main() {
    var string s = "val=" + inttostr(42);
    print(s);
    return 0;
}`,
    expected: "val=42"
},
{
    name: "string: len of literal",
    source: `
main() {
    var string s = "hello";
    print(len(s));
    return 0;
}`,
    expected: "5"
},

];

let passed = 0;
let failed = 0;

for (const test of tests) {
    fs.writeFileSync("_test.l", test.source);
    try {
        execSync("node ./dist/Main.js _test.l _test", { stdio: "pipe" });

        if (test.shouldError) {
            console.log(`  ✗ ${test.name}`);
            console.log(`    expected a type error but compiled successfully`);
            failed++;
            continue;
        }
        const output = execSync("./_test", { timeout: 10000 }).toString().trim();
        if (output === test.expected) {
            console.log(`  ✓ ${test.name}`);
            passed++;
        } else {
            console.log(`  ✗ ${test.name}`);
            console.log(`    expected: ${test.expected}`);
            console.log(`    got:      ${output}`);
            if (verbose) {
                let ir = getIR(test.source);
                console.log(ir)
                let asm = fs.readFileSync("_test.asm").toString();
                console.log("    assembly:");
                console.log(asm.split("\n").map(line => "      " + line).join("\n"));
            }

            failed++;
        }
    } catch (e) {
        if (test.shouldError) {
            console.log(`  ✓ ${test.name}`);
            passed++;
        } else {
            console.log(`  ✗ ${test.name} (crashed)`);
            console.log(`    ${e.stderr?.toString().trim() || e.message}`);
            if (verbose) {
                let ir = getIR(test.source);
                console.log(ir)
                let asm = fs.readFileSync("_test.asm").toString();
                console.log("    assembly:");
                console.log(asm.split("\n").map(line => "      " + line).join("\n"));
            }
            failed++;
        }
    }
}

const irTests = [
    // constant folding IR tests
    {
        name: "fold: addition produces no add instruction",
        ir: getIR(`main() { var x = 2 + 3; print(x); return 0; }`),
        shouldNotContain: "add",
        shouldContain: "const     t0 = 5"
    },
    {
        name: "fold: multiplication produces no mul instruction",
        ir: getIR(`main() { var x = 4 * 5; print(x); return 0; }`),
        shouldNotContain: "mul",
        shouldContain: "const     t0 = 20"
    },
    {
        name: "fold: subtraction produces no sub instruction",
        ir: getIR(`main() { var x = 10 - 3; print(x); return 0; }`),
        shouldNotContain: "sub",
        shouldContain: "const     t0 = 7"
    },
    {
        name: "fold: division produces no div instruction",
        ir: getIR(`main() { var x = 10 / 2; print(x); return 0; }`),
        shouldNotContain: "div",
        shouldContain: "const     t0 = 5"
    },
    {
        name: "fold: nested expression folds completely",
        ir: getIR(`main() { var x = (2 + 3) * 4; print(x); return 0; }`),
        shouldNotContain: "add",
        shouldContain: "const     t0 = 20"
    },
    {
        name: "fold: unary negation folds",
        ir: getIR(`main() { var x = -5; print(x); return 0; }`),
        shouldNotContain: "neg",
        shouldContain: "const     t0 = -5"
    },
    {
        name: "fold: comparison folds to 1",
        ir: getIR(`main() { var x = 2 == 2; print(x); return 0; }`),
        shouldNotContain: "eq",
        shouldContain: "const     t0 = 1"
    },
    {
        name: "fold: comparison folds to 0",
        ir: getIR(`main() { var x = 2 == 3; print(x); return 0; }`),
        shouldNotContain: "eq",
        shouldContain: "const     t0 = 0"
    },

    // DCE IR tests
    {
        name: "dce: dead code after return removed",
        ir: getIR(`
function foo() {
    return 5;
    var x = 10;
    print(x);
}
main() {
    var x = foo();
    print(x);
    return 0;
}`),
        shouldNotContain: "const     t0 = 10",
        shouldContain: "ret"
    },
    {
        name: "dce: always true if removes else",
        ir: getIR(`
main() {
    if (1 == 1) {
        print(1);
    } else {
        print(0);
    }
    return 0;
}`),
        shouldNotContain: "jz",
        shouldNotContain2: "jmp"
    },
    {
        name: "dce: always false if removes then",
        ir: getIR(`
main() {
    if (1 == 2) {
        print(1);
    } else {
        print(0);
    }
    return 0;
}`),
        shouldNotContain: "jz",
        shouldNotContain2: "const     t0 = 1"
    },
    {
        name: "dce: dead code after break removed",
        ir: getIR(`
main() {
    var x = 0;
    while (x < 10) {
        break;
        x = x + 1;
    }
    return 0;
}`),
        shouldNotContain: "add"
    },
    {
    name: "copyprop: simple mov propagation",
    ir: getIR(`main() { var a = 5; var b = a; print(b); return 0; }`),
    shouldNotContain: "mov       t",   // temp-to-temp movs should be gone
    shouldContain: "mov       b"       // named var assignment should stay
},
{
    name: "copyprop: chained mov propagation",
    ir: getIR(`main() { var a = 5; var b = a; var c = b; print(c); return 0; }`),
    shouldNotContain: "mov       t",
    shouldContain: "const     t0 = 5"
},
{
    name: "copyprop: arithmetic uses original source",
    ir: getIR(`main() { var a = 5; var b = a; var c = b + 1; print(c); return 0; }`),
    shouldNotContain: "mov       t",
    shouldContain: "add"
},
{
    name: "copyprop: function argument propagation",
    ir: getIR(`
function id(x) { return x; }
main() { var a = 5; var b = a; print(id(b)); return 0; }`),
    shouldNotContain: "mov       t",
    shouldContain: "call"
},
{
    name: "copyprop: comparison propagation",
    ir: getIR(`main() { var a = 5; var b = a; if (b == 5) { print(1); } return 0; }`),
    shouldNotContain: "mov       t",
    shouldContain: "eq"
},
{
    name: "cse: duplicate addition eliminated",
    ir: getIR(`
main() {
    var a = 5;
    var b = a + 1;
    var c = a + 1;
    print(c);
    return 0;
}`),
    shouldNotContain: "add       t2",
    shouldContain: "add"
},
{
    name: "cse: duplicate subtraction eliminated",
    ir: getIR(`
main() {
    var a = 10;
    var b = a - 3;
    var c = a - 3;
    print(c);
    return 0;
}`),
    shouldNotContain: "sub       t2",
    shouldContain: "sub"
},
{
    name: "cse: duplicate comparison eliminated",
    ir: getIR(`
main() {
    var a = 5;
    var b = a == 5;
    var c = a == 5;
    print(c);
    return 0;
}`),
    shouldNotContain: "eq        t2",
    shouldContain: "eq"
},
{
    name: "cse: expression not reused after variable changes",
    ir: getIR(`
main() {
    var a = 5;
    var b = a + 1;
    a = 10;
    var c = a + 1;
    print(c);
    return 0;
}`),
    shouldContain: "add       t",
},
{
    name: "cse: duplicate multiplication eliminated",
    ir: getIR(`
main() {
    var a = 5;
    var b = a * 2;
    var c = a * 2;
    print(c);
    return 0;
}`),
    shouldNotContain: "mul       t2",
    shouldContain: "mul"
},
];

let irPassed = 0;
let irFailed = 0;

for (const test of irTests) {
    let failed = false;
    let reason = "";

    if (test.shouldContain && !test.ir.includes(test.shouldContain)) {
        failed = true;
        reason = `expected IR to contain: ${test.shouldContain}`;
    }
    if (test.shouldNotContain && test.ir.includes(test.shouldNotContain)) {
        failed = true;
        reason = `expected IR to NOT contain: ${test.shouldNotContain}`;
        console.log(test.ir);
    }
    if (test.shouldNotContain2 && test.ir.includes(test.shouldNotContain2)) {
        failed = true;
        reason = `expected IR to NOT contain: ${test.shouldNotContain2}`;
        console.log(test.ir);
    }

    if (failed) {
        console.log(`  ✗ ${test.name}`);
        console.log(`    ${reason}`);
        irFailed++;
    } else {
        console.log(`  ✓ ${test.name}`);
        irPassed++;
    }
}

const inputTests = [
    {
        name: "input: read integer",
        source: `
main() {
    var x = input();
    print(x);
    return 0;
}`,
        stdin: "42\n",
        expected: "42"
    },
    {
        name: "input: arithmetic on input",
        source: `
main() {
    var x = input();
    var y = x + 1;
    print(y);
    return 0;
}`,
        stdin: "5\n",
        expected: "6"
    },
    {
        name: "input: two inputs",
        source: `
main() {
    var x = input();
    var y = input();
    var z = x + y;
    print(z);
    return 0;
}`,
        stdin: "3\n4\n",
        expected: "7"
    },
    {
        name: "input: input in condition",
        source: `
main() {
    var x = input();
    if (x > 5) {
        print(1);
    } else {
        print(0);
    }
    return 0;
}`,
        stdin: "10\n",
        expected: "1"
    },
    {
    name: "input: read string",
    source: `
main() {
    var string s = inputstr();
    print(s);
    return 0;
}`,
    stdin: "hello\n",
    expected: "hello"
},
{
    name: "input: string concat with input",
    source: `
main() {
    var string s = inputstr();
    var string r = "hello " + s;
    print(r);
    return 0;
}`,
    stdin: "world\n",
    expected: "hello world"
},
{
    name: "input: string equality check",
    source: `
main() {
    var string s = inputstr();
    if (s == "yes") {
        print(1);
    } else {
        print(0);
    }
    return 0;
}`,
    stdin: "yes\n",
    expected: "1"
},
{
    name: "input: string length of input",
    source: `
main() {
    var string s = inputstr();
    var int n = len(s);
    print(n);
    return 0;
}`,
    stdin: "hello\n",
    expected: "5"
},
{
    name: "input: strtoint on string input",
    source: `
main() {
    var string s = inputstr();
    var int n = strtoint(s);
    var int r = n * 2;
    print(r);
    return 0;
}`,
    stdin: "21\n",
    expected: "42"
},
{
    name: "input: two string inputs",
    source: `
main() {
    var string a = inputstr();
    var string b = inputstr();
    var string r = a + b;
    print(r);
    return 0;
}`,
    stdin: "foo\nbar\n",
    expected: "foobar"
},
{
    name: "input: string input in function",
    source: `
function greet(string name) {
    return "hi " + name;
}
main() {
    var string s = inputstr();
    var string r = greet(s);
    print(r);
    return 0;
}`,
    stdin: "alice\n",
    expected: "hi alice"
},
{
    name: "input: negative number",
    source: `
main() {
    var x = input();
    print(x);
    return 0;
}`,
    stdin: "-7\n",
    expected: "-7"
},
{
    name: "input: input in while loop",
    source: `
main() {
    var sum = 0;
    var i = 0;
    while (i < 3) {
        var x = input();
        sum = sum + x;
        i = i + 1;
    }
    print(sum);
    return 0;
}`,
    stdin: "1\n2\n3\n",
    expected: "6"
},

];

let inputPassed = 0;
let inputFailed = 0;

for (const test of inputTests) {
    fs.writeFileSync("_test.l", test.source);
    try {
        execSync("node ./dist/Main.js _test.l _test", { stdio: "pipe" });
        const output = execSync("./_test", { input: test.stdin, timeout: 10000 }).toString().trim();
        if (output === test.expected) {
            console.log(`  ✓ ${test.name}`);
            inputPassed++;
        } else {
            console.log(`  ✗ ${test.name}`);
            console.log(`    expected: ${test.expected}`);
            console.log(`    got:      ${output}`);
            inputFailed++;
            if(verbose) {
                let asm = fs.readFileSync("_test.asm").toString()
                console.log("assembly :")
                console.log(asm)
            }
        }
    } catch (e) {
        console.log(`  ✗ ${test.name} (crashed)`);
        console.log(`    ${e.stderr?.toString().trim() || e.message}`);
        inputFailed++;
        if (verbose) {
            let asm = fs.readFileSync("_test.asm").toString();
            console.log("assembly:")
            console.log(asm)
        }
    }
}

fs.rmSync("_test.l", { force: true });
fs.rmSync("_test", { force: true });

console.log(`\n${passed} passed, ${failed} failed`);
console.log(`${irPassed} IR tests passed, ${irFailed} IR tests failed`);
console.log(`${inputPassed} input tests passed, ${inputFailed} input tests failed`);