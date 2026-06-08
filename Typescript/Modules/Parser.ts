import { Token, LexerWithPos } from "./Lexer";
import { Ltype } from "./Scope";

type NodeType =
    | "Program"
    | "Function"
    | "Block"
    | "Return"
    | "VarDecl"
    | "Call"
    | "Binary"
    | "Identifier"
    | "Number"
    | "Char"
    | "Assign"
    | "CompoundAssign"
    | "Unary"
    | "PostfixInc"
    | "PostfixDec"
    | "If"
    | "While"
    | "For"
    | "ForIn"
    | "Match"
    | "MatchArm"
    | "Break"
    | "Continue"
    | "String"
    | "ArrayLiteral"
    | "ArrayNew"
    | "ArrayAssign"
    | "ArrayAccess"
    | "ArrayLen"
    | "ArraySlice"
    | "StructDef"
    | "StructField"
    | "StructMethod"
    | "StructInstantiate"
    | "FieldAccess"
    | "FieldAssign"
    | "StructOverrides"
    | "This"
    | "ArrayAccess2D"
    | "ArrayAssign2D"
    | "Tuple"
    | "TupleAccess"
    | "FuncRef"
    | "Lambda"
    | "AsmBlock";

export interface Node {
    type: NodeType;
    value?: string;
    varType?: Ltype;
    children: Node[];
    parent?: string;
    isConst?: boolean;
    line?: number;
    col?: number;
}

// ─── Token stream helpers ────────────────────────────────────────────────────

function peek(t: Token[]): string { return t[0]?.value ?? ""; }
function peekTok(t: Token[]): Token | undefined { return t[0]; }
function eat(t: Token[]): string { return t.shift()!.value; }
function eatTok(t: Token[]): Token { return t.shift()!; }

function pos(t: Token[]): { line: number; col: number } {
    return t[0] ? { line: t[0].line, col: t[0].col } : { line: 0, col: 0 };
}

function err(msg: string, tok?: Token): never {
    if (tok) throw new Error(`${tok.line}:${tok.col}: ${msg}`);
    throw new Error(msg);
}

function node(type: NodeType, tok: Token | undefined, extras: Partial<Node> = {}): Node {
    return { type, children: [], line: tok?.line, col: tok?.col, ...extras };
}

// ─── Expression parser ───────────────────────────────────────────────────────

function parseExpression(tokens: Token[]): Node {
    function primary(): Node {
        const tok = eatTok(tokens);
        if (!tok) throw new Error("Unexpected end of input");
        const t = tok.value;

        if (t === "this") {
            eat(tokens); // .
            const field = eat(tokens);
            if (peek(tokens) === "(") {
                eat(tokens);
                const args: Node[] = [];
                while (peek(tokens) !== ")") {
                    args.push(parseExpression(tokens));
                    if (peek(tokens) === ",") eat(tokens);
                }
                eat(tokens);
                return { type: "Call", value: `this.${field}`, children: args, line: tok.line, col: tok.col };
            }
            return { type: "FieldAccess", value: field, children: [{ type: "This", children: [], line: tok.line, col: tok.col }], line: tok.line, col: tok.col };
        }

        if (t === "[") {
            const elements: Node[] = [];
            while (peek(tokens) !== "]") {
                elements.push(parseExpression(tokens));
                if (peek(tokens) === ",") eat(tokens);
            }
            eat(tokens); // ]
            return { type: "ArrayLiteral", children: elements, line: tok.line, col: tok.col };
        }

        if (t === "(") {
            // Could be tuple: (expr, expr, ...) or grouped expr
            const first = parseExpression(tokens);
            if (peek(tokens) === ",") {
                // tuple
                const elems: Node[] = [first];
                while (peek(tokens) === ",") {
                    eat(tokens);
                    elems.push(parseExpression(tokens));
                }
                eat(tokens); // )
                return { type: "Tuple", children: elems, line: tok.line, col: tok.col };
            }
            eat(tokens); // )
            return first;
        }

        if (t === "new") {
            eat(tokens); // type name e.g. int
            eat(tokens); // [
            const rows = parseExpression(tokens);
            eat(tokens); // ]
            if (peek(tokens) === "[") {
                eat(tokens);
                const cols = parseExpression(tokens);
                eat(tokens);
                return { type: "ArrayNew", varType: "int[][]" as any, children: [rows, cols], line: tok.line, col: tok.col };
            }
            return { type: "ArrayNew", children: [rows], line: tok.line, col: tok.col };
        }

        if (t === "true") return { type: "Number", value: "1", varType: "bool", children: [], line: tok.line, col: tok.col };
        if (t === "false") return { type: "Number", value: "0", varType: "bool", children: [], line: tok.line, col: tok.col };

        if (t.startsWith("'") && t.endsWith("'") && t.length === 3) {
            // char literal 'x' — store as the character
            return { type: "Char", value: t[1], children: [], line: tok.line, col: tok.col };
        }

        if (t.startsWith('"') && t.endsWith('"')) {
            return { type: "String", value: t.slice(1, -1), children: [], line: tok.line, col: tok.col };
        }

        if (/^\d+\.\d*$/.test(t) || /^\d*\.\d+$/.test(t)) {
            return { type: "Number", value: t, varType: "float", children: [], line: tok.line, col: tok.col };
        }

        if (/^\d+$/.test(t)) {
            return { type: "Number", value: t, children: [], line: tok.line, col: tok.col };
        }

        if (t === "-") {
            return { type: "Unary", value: "-", children: [primary()], line: tok.line, col: tok.col };
        }

        if (t === "!") {
            return { type: "Unary", value: "!", children: [primary()], line: tok.line, col: tok.col };
        }

        if (t === "++" || t === "--") {
            // prefix inc/dec — treat as compound assign
            const operand = primary();
            return { type: "CompoundAssign", value: t === "++" ? "+=" : "-=", children: [operand, { type: "Number", value: "1", children: [] }], line: tok.line, col: tok.col };
        }

        if (/[a-zA-Z_]/.test(t)) {
            if (peek(tokens) === "{") {
                eat(tokens);
                const fields: Node[] = [];
                while (peek(tokens) !== "}") {
                    const fieldName = eat(tokens);
                    eat(tokens); // :
                    const val = parseExpression(tokens);
                    fields.push({ type: "StructField", value: fieldName, children: [val] });
                    if (peek(tokens) === ",") eat(tokens);
                }
                eat(tokens);
                return { type: "StructInstantiate", value: t, children: fields, line: tok.line, col: tok.col };
            }

            if (peek(tokens) === "(") {
                eat(tokens);
                const args: Node[] = [];
                while (peek(tokens) !== ")") {
                    args.push(parseExpression(tokens));
                    if (peek(tokens) === ",") eat(tokens);
                }
                eat(tokens);
                return { type: "Call", value: t, children: args, line: tok.line, col: tok.col };
            }

            if (peek(tokens) === ".") {
                // tuple element access: t.0, t.1, ... (digit after dot)
                if (/^\d+$/.test(tokens[1]?.value ?? "")) {
                    eat(tokens); // .
                    const idx = eat(tokens);
                    return { type: "TupleAccess", value: idx, children: [{ type: "Identifier", value: t, children: [] }], line: tok.line, col: tok.col };
                }
                eat(tokens); // .
                const member = eat(tokens);
                if (member === "len") {
                    eat(tokens); // (
                    eat(tokens); // )
                    return { type: "ArrayLen", value: t, children: [], line: tok.line, col: tok.col };
                }
                if (peek(tokens) === "(") {
                    eat(tokens);
                    const args: Node[] = [];
                    while (peek(tokens) !== ")") {
                        args.push(parseExpression(tokens));
                        if (peek(tokens) === ",") eat(tokens);
                    }
                    eat(tokens);
                    return { type: "Call", value: `${t}.${member}`, children: args, line: tok.line, col: tok.col };
                }
                return { type: "FieldAccess", value: member, children: [{ type: "Identifier", value: t, children: [] }], line: tok.line, col: tok.col };
            }

            if (peek(tokens) === "[") {
                eat(tokens);
                const index = parseExpression(tokens);
                // slice: arr[i..j]
                if (peek(tokens) === "..") {
                    eat(tokens);
                    const end = parseExpression(tokens);
                    eat(tokens); // ]
                    return { type: "ArraySlice", value: t, children: [index, end], line: tok.line, col: tok.col };
                }
                eat(tokens); // ]
                if (peek(tokens) === "[") {
                    eat(tokens);
                    const index2 = parseExpression(tokens);
                    eat(tokens);
                    return { type: "ArrayAccess2D", value: t, children: [index, index2], line: tok.line, col: tok.col } as any;
                }
                return { type: "ArrayAccess", value: t, children: [index], line: tok.line, col: tok.col };
            }

            // postfix ++ / --
            if (peek(tokens) === "++" || peek(tokens) === "--") {
                const op = eat(tokens);
                const nodeType = op === "++" ? "PostfixInc" : "PostfixDec";
                return { type: nodeType, value: t, children: [], line: tok.line, col: tok.col };
            }

            return { type: "Identifier", value: t, children: [], line: tok.line, col: tok.col };
        }

        err(`Unexpected token '${t}'`, tok);
    }

    function assignment(): Node {
        const left = primary();

        // compound assignment: +=, -=, *=, /=, %=
        const compOps = ["+=", "-=", "*=", "/=", "%="];
        if (compOps.includes(peek(tokens))) {
            const op = eat(tokens);
            const right = binary(primary());
            if (left.type !== "Identifier") err("Invalid compound assignment target");
            return { type: "CompoundAssign", value: op, children: [left, right], line: left.line, col: left.col };
        }

        if (peek(tokens) === "=") {
            eat(tokens);
            const right = binary(primary());
            if (left.type !== "Identifier") err("Invalid assignment target");
            return { type: "Assign", value: left.value, children: [right], line: left.line, col: left.col };
        }

        return left;
    }

    function binary(left: Node, min = 0): Node {
        const prec: Record<string, number> = {
            "||": 1, "&&": 2,
            "==": 3, "!=": 3, "<": 3, ">": 3, "<=": 3, ">=": 3,
            "+": 4, "-": 4,
            "*": 5, "/": 5, "%": 5,
        };

        while (true) {
            const op = peek(tokens);
            if (!op || !(op in prec) || prec[op] < min) break;
            eat(tokens);
            let right = primary();
            while (true) {
                const next = peek(tokens);
                if (!next || !(next in prec) || prec[next] <= prec[op]) break;
                right = binary(right, prec[next]);
            }
            left = { type: "Binary", value: op, children: [left, right], line: left.line, col: left.col };
        }
        return left;
    }

    return binary(assignment());
}

function parseTypeAnnotation(tokens: Token[]): Ltype | undefined {
    const next = peek(tokens);
    if (next === "int" || next === "string" || next === "bool" || next === "float" ||
        next === "char" || next === "void" || next === "unknown") {
        eat(tokens);
        if (peek(tokens) === "[") {
            eat(tokens);
            eat(tokens);
            if (peek(tokens) === "[") {
                eat(tokens);
                eat(tokens);
                return (next + "[][]") as Ltype;
            }
            return (next + "[]") as Ltype;
        }
        return next as Ltype;
    }
    if (next && /^[A-Z]/.test(next)) {
        eat(tokens);
        return next as Ltype;
    }
    return undefined;
}

// ─── Top-level parse ─────────────────────────────────────────────────────────

export function parse(rawTokens: string[]): Node {
    // Re-lex from source is impossible here; accept pre-tokenised string array
    // by wrapping into synthetic Token objects with no position.
    // The real position-aware path goes through parseWithPos.
    const tokens: Token[] = rawTokens.map(v => ({ value: v, line: 0, col: 0 }));
    return parseTokens(tokens);
}

export function parseWithPos(tokens: Token[]): Node {
    return parseTokens(tokens);
}

function parseTokens(tokens: Token[]): Node {
    const program: Node = { type: "Program", children: [] };

    function parseStatement(): Node {
        const t = peek(tokens);
        const tok = peekTok(tokens);

        if (t === "if") { eat(tokens); return parseIf(); }
        if (t === "while") { eat(tokens); return parseWhile(); }
        if (t === "for") { eat(tokens); return parseFor(); }
        if (t === "match") { eat(tokens); return parseMatch(); }
        if (t === "asm") {
            const atok = eatTok(tokens); // asm
            eat(tokens); // {
            const rawTok = eatTok(tokens); // __asm__:...
            eat(tokens); // }
            const raw = rawTok.value.slice("__asm__:".length);
            return { type: "AsmBlock", value: raw, children: [], line: atok.line, col: atok.col };
        }

        if (t === "break") {
            const btok = eatTok(tokens);
            eat(tokens); // ;
            return { type: "Break", children: [], line: btok.line, col: btok.col };
        }
        if (t === "continue") {
            const ctok = eatTok(tokens);
            eat(tokens); // ;
            return { type: "Continue", children: [], line: ctok.line, col: ctok.col };
        }

        if (t === "return") {
            const rtok = eatTok(tokens);
            const exprTokens: Token[] = [];
            while (peek(tokens) !== ";") exprTokens.push(eatTok(tokens)!);
            eat(tokens);
            return { type: "Return", children: [parseExpression(exprTokens)], line: rtok.line, col: rtok.col };
        }

        if (t === "var" || t === "let" || t === "const") {
            const vtok = eatTok(tokens);
            const varType = parseTypeAnnotation(tokens);
            const name = eat(tokens);
            eat(tokens); // =
            const exprTokens: Token[] = [];
            while (peek(tokens) !== ";") exprTokens.push(eatTok(tokens)!);
            eat(tokens);
            return { type: "VarDecl", value: name, varType, children: [parseExpression(exprTokens)], line: vtok.line, col: vtok.col };
        }

        // collect up to ;
        const exprTokens: Token[] = [];
        while (peek(tokens) !== ";") exprTokens.push(eatTok(tokens)!);
        eat(tokens);

        // 2D array assign: name[i][j] = expr
        const eqIdx = exprTokens.map(t => t.value).lastIndexOf("=");
        const firstBracketIdx = exprTokens.findIndex(t => t.value === "[");
        if (eqIdx > 0 && firstBracketIdx > 0 && firstBracketIdx < eqIdx &&
            exprTokens[eqIdx - 1]?.value !== "<" && exprTokens[eqIdx - 1]?.value !== ">" &&
            exprTokens[eqIdx - 1]?.value !== "!" &&
            exprTokens[eqIdx + 1]?.value !== "=") {
            const lhs = exprTokens.slice(0, eqIdx);
            const rhs = exprTokens.slice(eqIdx + 1);
            const name = lhs[0].value;
            const open1 = lhs.findIndex(t => t.value === "[");
            const close1 = lhs.findIndex(t => t.value === "]");
            const open2 = lhs.findIndex((t, i) => t.value === "[" && i > close1);
            const close2 = lhs.map(t => t.value).lastIndexOf("]");
            if (open2 > close1) {
                return {
                    type: "ArrayAssign2D" as any,
                    value: name,
                    children: [
                        parseExpression(lhs.slice(open1 + 1, close1)),
                        parseExpression(lhs.slice(open2 + 1, close2)),
                        parseExpression(rhs)
                    ],
                    line: exprTokens[0]?.line, col: exprTokens[0]?.col
                };
            }
            if (open1 > 0) {
                return {
                    type: "ArrayAssign",
                    value: name,
                    children: [
                        parseExpression(lhs.slice(open1 + 1, close1)),
                        parseExpression(rhs)
                    ],
                    line: exprTokens[0]?.line, col: exprTokens[0]?.col
                };
            }
        }

        // field assign: obj.field = expr
        const dotIdx = exprTokens.findIndex(t => t.value === ".");
        if (dotIdx === 1 && eqIdx > dotIdx && exprTokens[eqIdx - 1]?.value !== "<" &&
            exprTokens[eqIdx - 1]?.value !== ">" && exprTokens[eqIdx - 1]?.value !== "!" &&
            exprTokens[eqIdx + 1]?.value !== "=") {
            const objName = exprTokens[0].value;
            const fieldName = exprTokens[2].value;
            const rhs = exprTokens.slice(eqIdx + 1);
            return {
                type: "FieldAssign", value: fieldName,
                children: [{ type: "Identifier", value: objName, children: [] }, parseExpression(rhs)],
                line: exprTokens[0].line, col: exprTokens[0].col
            };
        }

        // compound assign as statement: x += expr
        const compOpIdx = exprTokens.findIndex(t => ["+=", "-=", "*=", "/=", "%="].includes(t.value));
        if (compOpIdx === 1) {
            const name = exprTokens[0].value;
            const op = exprTokens[compOpIdx].value;
            const rhs = exprTokens.slice(compOpIdx + 1);
            return {
                type: "CompoundAssign", value: op,
                children: [{ type: "Identifier", value: name, children: [] }, parseExpression(rhs)],
                line: exprTokens[0].line, col: exprTokens[0].col
            };
        }

        // postfix ++ / -- as statement: i++; or i--;
        if (exprTokens.length === 2 && (exprTokens[1].value === "++" || exprTokens[1].value === "--")) {
            const name = exprTokens[0].value;
            const op = exprTokens[1].value === "++" ? "+=" : "-=";
            return {
                type: "CompoundAssign", value: op,
                children: [
                    { type: "Identifier", value: name, children: [] },
                    { type: "Number", value: "1", children: [] }
                ],
                line: exprTokens[0].line, col: exprTokens[0].col
            };
        }

        return parseExpression(exprTokens);
    }

    function parseWhile(): Node {
        const wtok = peekTok(tokens);
        eat(tokens); // (
        const condTokens: Token[] = [];
        let depth = 1;
        while (depth > 0) {
            const tok = eatTok(tokens)!;
            if (tok.value === "(") depth++;
            else if (tok.value === ")") { depth--; if (depth === 0) break; }
            condTokens.push(tok);
        }
        const cond = parseExpression(condTokens);
        eat(tokens); // {
        const body = parseBlockBody();
        eat(tokens); // }
        return { type: "While", children: [cond, body], line: wtok?.line, col: wtok?.col };
    }

    function parseFor(): Node {
        const ftok = peekTok(tokens);
        eat(tokens); // (

        // Peek ahead for `for x in arr` pattern
        // Detect: identifier "in" without a ; before "in"
        const saved = [...tokens];
        const firstTok = tokens[0]?.value;
        const secondTok = tokens[1]?.value;
        if (firstTok && /^[a-zA-Z_]/.test(firstTok) && secondTok === "in") {
            const varName = eat(tokens); // varName
            eat(tokens); // in
            const iterTokens: Token[] = [];
            while (peek(tokens) !== ")") iterTokens.push(eatTok(tokens)!);
            eat(tokens); // )
            eat(tokens); // {
            const body = parseBlockBody();
            eat(tokens); // }
            return {
                type: "ForIn",
                value: varName,
                children: [parseExpression(iterTokens), body],
                line: ftok?.line, col: ftok?.col
            };
        }

        const initTokens: Token[] = [];
        while (peek(tokens) !== ";") initTokens.push(eatTok(tokens)!);
        eat(tokens);

        const condTokens: Token[] = [];
        while (peek(tokens) !== ";") condTokens.push(eatTok(tokens)!);
        eat(tokens);

        const updateTokens: Token[] = [];
        while (peek(tokens) !== "{") updateTokens.push(eatTok(tokens)!);

        eat(tokens); // {
        const body = parseBlockBody();
        eat(tokens); // }

        let init: Node | null = null;
        if (initTokens.length) {
            if (initTokens[0].value === "var" || initTokens[0].value === "let" || initTokens[0].value === "const") {
                let offset = 1;
                const typeTok = initTokens[offset];
                let varType: Ltype | undefined;
                if (["int","string","bool","float","char","void","unknown"].includes(typeTok?.value)) {
                    const typeName = initTokens[offset++].value;
                    if (initTokens[offset]?.value === "[") {
                        offset += 2;
                        varType = (typeName + "[]") as Ltype;
                    } else {
                        varType = typeName as Ltype;
                    }
                }
                const name = initTokens[offset++].value;
                offset++; // =
                const exprTokens = initTokens.slice(offset);
                init = { type: "VarDecl", value: name, varType, children: [parseExpression(exprTokens)] };
            } else {
                init = parseExpression(initTokens);
            }
        }

        const cond = condTokens.length ? parseExpression(condTokens) : null;
        const update = updateTokens.length ? parseExpression(updateTokens) : null;

        const forNode: Node = { type: "For", children: [], line: ftok?.line, col: ftok?.col };
        if (init) forNode.children.push(init);
        if (cond) forNode.children.push(cond);
        if (update) forNode.children.push(update);
        forNode.children.push(body);
        return forNode;
    }

    function parseMatch(): Node {
        const mtok = peekTok(tokens);
        eat(tokens); // (
        const subjTokens: Token[] = [];
        let depth = 1;
        while (depth > 0) {
            const tok = eatTok(tokens)!;
            if (tok.value === "(") depth++;
            else if (tok.value === ")") { depth--; if (depth === 0) break; }
            subjTokens.push(tok);
        }
        const subject = parseExpression(subjTokens);
        eat(tokens); // {
        const arms: Node[] = [];
        while (peek(tokens) !== "}") {
            if (peek(tokens) === "_") {
                // wildcard arm
                eat(tokens); // _
                eat(tokens); // =>
                eat(tokens); // {
                const body = parseBlockBody();
                eat(tokens); // }
                arms.push({ type: "MatchArm", value: "_", children: [body] });
            } else {
                const patternTokens: Token[] = [];
                while (peek(tokens) !== "=>" && peek(tokens) !== "}") patternTokens.push(eatTok(tokens)!);
                eat(tokens); // =>
                eat(tokens); // {
                const body = parseBlockBody();
                eat(tokens); // }
                const pattern = parseExpression(patternTokens);
                arms.push({ type: "MatchArm", children: [pattern, body] });
            }
        }
        eat(tokens); // }
        return { type: "Match", children: [subject, ...arms], line: mtok?.line, col: mtok?.col };
    }

    function parseStruct(): Node {
        const name = eat(tokens);
        let parent: string | undefined;
        if (peek(tokens) === "extends") { eat(tokens); parent = eat(tokens); }
        eat(tokens); // {

        const fields: Node[] = [];
        const methods: Node[] = [];
        const overrides: Node[] = [];

        while (peek(tokens) !== "}") {
            const t = peek(tokens);
            if (t === "overrides") {
                eat(tokens);
                eat(tokens); // {
                while (peek(tokens) !== "}") overrides.push(parseStructMethod());
                eat(tokens); // }
                continue;
            }
            if (t === "fn") { methods.push(parseStructMethod()); continue; }

            const mut = eat(tokens);
            const fieldName = eat(tokens);
            eat(tokens); // :
            const fieldType = eat(tokens) as Ltype;
            eat(tokens); // ;
            const f: Node = { type: "StructField", value: fieldName, varType: fieldType, children: [] };
            if (mut === "const") f.isConst = true;
            fields.push(f);
        }
        eat(tokens); // }
        return { type: "StructDef", value: name, parent, children: [...fields, ...methods, ...overrides] };
    }

    function parseStructMethod(): Node {
        eat(tokens); // fn
        const name = eat(tokens);
        eat(tokens); // (

        const params: Node[] = [];
        while (peek(tokens) !== ")") {
            const p = eat(tokens)!;
            if (p === ",") continue;
            if (["int","string","bool","float","char","void","unknown"].includes(p) || /^[A-Z]/.test(p)) {
                let paramType: Ltype = p as Ltype;
                if (peek(tokens) === "[") {
                    eat(tokens); eat(tokens);
                    paramType = (p + "[]") as Ltype;
                    if (peek(tokens) === "[") { eat(tokens); eat(tokens); paramType = (p + "[][]") as Ltype; }
                }
                params.push({ type: "Identifier", value: eat(tokens), varType: paramType, children: [] });
                continue;
            }
            params.push({ type: "Identifier", value: p, children: [] });
        }
        eat(tokens); // )
        eat(tokens); // {
        const body = parseBlockBody();
        eat(tokens); // }
        return { type: "StructMethod", value: name, children: [...params, body] };
    }

    function parseIf(): Node {
        eat(tokens); // (
        const condTokens: Token[] = [];
        let depth = 1;
        while (depth > 0) {
            const tok = eatTok(tokens)!;
            if (tok.value === "(") depth++;
            else if (tok.value === ")") { depth--; if (depth === 0) break; }
            condTokens.push(tok);
        }
        const cond = parseExpression(condTokens);
        eat(tokens); // {
        const thenBlock = parseBlockBody();
        eat(tokens); // }

        const children: Node[] = [cond, thenBlock];
        if (peek(tokens) === "else") {
            eat(tokens);
            if (peek(tokens) === "if") { eat(tokens); children.push(parseIf()); }
            else { eat(tokens); children.push(parseBlockBody()); eat(tokens); }
        }
        return { type: "If", children };
    }

    function parseBlockBody(): Node {
        const body: Node = { type: "Block", children: [] };
        while (peek(tokens) !== "}") body.children.push(parseStatement());
        return body;
    }

    function parseFunctionParams(): Node[] {
        const params: Node[] = [];
        while (peek(tokens) !== ")") {
            const p = eat(tokens)!;
            if (p === ",") continue;
            if (p === "...") {
                // variadic: ...name
                const vname = eat(tokens)!;
                params.push({ type: "Identifier", value: vname, varType: "int[]" as Ltype, children: [], isConst: false });
                // mark as variadic via a special convention
                params[params.length - 1].value = "..." + vname;
                continue;
            }
            if (["int","string","bool","float","char","void","unknown"].includes(p) || /^[A-Z]/.test(p)) {
                let paramType: Ltype = p as Ltype;
                if (peek(tokens) === "[") {
                    eat(tokens); eat(tokens);
                    paramType = (p + "[]") as Ltype;
                    if (peek(tokens) === "[") { eat(tokens); eat(tokens); paramType = (p + "[][]") as Ltype; }
                }
                params.push({ type: "Identifier", value: eat(tokens)!, varType: paramType, children: [] });
                continue;
            }
            params.push({ type: "Identifier", value: p, children: [] });
        }
        return params;
    }

    while (tokens.length) {
        const tok = eatTok(tokens);
        if (!tok) break;
        const t = tok.value;

        if (t === "function" || t === "fn") {
            const name = eat(tokens);
            eat(tokens); // (
            const params = parseFunctionParams();
            eat(tokens); // )
            eat(tokens); // {
            const body = parseBlockBody();
            eat(tokens); // }
            program.children.push({ type: "Function", value: name, children: [...params, body], line: tok.line, col: tok.col });
            continue;
        }

        if (t === "struct") {
            program.children.push(parseStruct());
            continue;
        }

        if (t === "var") {
            const name = eat(tokens)!;
            eat(tokens); // =
            const expr: Token[] = [];
            while (peek(tokens) !== ";") expr.push(eatTok(tokens)!);
            eat(tokens);
            program.children.push({ type: "VarDecl", value: name, children: [parseExpression(expr)], line: tok.line, col: tok.col });
            continue;
        }

        if (t === "main") {
            eat(tokens); eat(tokens); eat(tokens); // ( ) {
            const body = parseBlockBody();
            eat(tokens); // }
            program.children.push({ type: "Function", value: "main", children: [body], line: tok.line, col: tok.col });
            continue;
        }
    }

    return program;
}

module.exports = { parse, parseWithPos };
