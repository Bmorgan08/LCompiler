"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const node_1 = require("vscode-languageserver/node");
const vscode_languageserver_textdocument_1 = require("vscode-languageserver-textdocument");
const connection = (0, node_1.createConnection)(node_1.ProposedFeatures.all);
const documents = new node_1.TextDocuments(vscode_languageserver_textdocument_1.TextDocument);
function createScope(parent) {
    return { symbols: new Map(), parent };
}
function defineSym(scope, entry) {
    scope.symbols.set(entry.name, entry);
}
function resolveSym(name, scope) {
    let s = scope;
    while (s) {
        const found = s.symbols.get(name);
        if (found)
            return found;
        s = s.parent;
    }
    return null;
}
const structRegistry = new Map();
function registerStruct(name, def) {
    structRegistry.set(name, def);
}
function lookupStruct(name) {
    return structRegistry.get(name);
}
// ─── Lexer ───────────────────────────────────────────────────────────────────
function Lexer(src) {
    const tokens = [];
    for (let i = 0; i < src.length; i++) {
        const c = src[i];
        if (c === " " || c === "\n" || c === "\t" || c === "\r")
            continue;
        // line comment
        if (c === "/" && src[i + 1] === "/") {
            while (i < src.length && src[i] !== "\n")
                i++;
            continue;
        }
        if (/[a-zA-Z_]/.test(c)) {
            let id = c;
            while (i + 1 < src.length && /[a-zA-Z0-9_]/.test(src[i + 1]))
                id += src[++i];
            tokens.push(id);
        }
        else if (/\d/.test(c)) {
            let num = c;
            while (i + 1 < src.length && /\d/.test(src[i + 1]))
                num += src[++i];
            tokens.push(num);
        }
        else if ((c === "=" || c === "!" || c === "<" || c === ">") && src[i + 1] === "=") {
            tokens.push(c + "=");
            i++;
        }
        else if (c === '"') {
            let str = '"';
            while (i + 1 < src.length && src[i + 1] !== '"')
                str += src[++i];
            i++;
            str += '"';
            tokens.push(str);
        }
        else {
            tokens.push(c);
        }
    }
    return tokens.filter((t) => t.length > 0);
}
// ─── Parser ──────────────────────────────────────────────────────────────────
function parseExpression(tokens) {
    const peek = () => tokens[0];
    const eat = () => tokens.shift();
    function primary() {
        const t = eat();
        if (!t)
            throw new Error("Unexpected end");
        if (t === "this") {
            eat(); // .
            const field = eat();
            if (peek() === "(") {
                eat();
                const args = [];
                while (peek() !== ")") {
                    args.push(parseExpression([...tokens.splice(0)]));
                    if (peek() === ",")
                        eat();
                }
                eat();
                return { type: "Call", value: `this.${field}`, children: args };
            }
            return { type: "FieldAccess", value: field, children: [{ type: "This", children: [] }] };
        }
        if (t === "[") {
            const elements = [];
            while (peek() !== "]") {
                elements.push(parseExpression(tokens));
                if (peek() === ",")
                    eat();
            }
            eat();
            return { type: "ArrayLiteral", children: elements };
        }
        if (t === "new") {
            eat();
            eat();
            const size = parseExpression(tokens);
            eat();
            return { type: "ArrayNew", children: [size] };
        }
        if (t.startsWith('"') && t.endsWith('"'))
            return { type: "String", value: t.slice(1, -1), children: [] };
        if (/^\d+$/.test(t))
            return { type: "Number", value: t, children: [] };
        if (t === "(") {
            const expr = parseExpression(tokens);
            eat();
            return expr;
        }
        if (t === "-")
            return { type: "Unary", value: "-", children: [primary()] };
        if (t === "!")
            return { type: "Unary", value: "!", children: [primary()] };
        if (/[a-zA-Z_]/.test(t)) {
            if (peek() === "{") {
                eat();
                const fields = [];
                while (peek() !== "}") {
                    const fn = eat();
                    eat();
                    const val = parseExpression(tokens);
                    fields.push({ type: "StructField", value: fn, children: [val] });
                    if (peek() === ",")
                        eat();
                }
                eat();
                return { type: "StructInstantiate", value: t, children: fields };
            }
            if (peek() === "(") {
                eat();
                const args = [];
                while (peek() !== ")") {
                    args.push(parseExpression(tokens));
                    if (peek() === ",")
                        eat();
                }
                eat();
                return { type: "Call", value: t, children: args };
            }
            if (peek() === ".") {
                eat();
                const member = eat();
                if (member === "len") {
                    eat();
                    eat();
                    return { type: "ArrayLen", value: t, children: [] };
                }
                if (peek() === "(") {
                    eat();
                    const args = [];
                    while (peek() !== ")") {
                        args.push(parseExpression(tokens));
                        if (peek() === ",")
                            eat();
                    }
                    eat();
                    return { type: "Call", value: `${t}.${member}`, children: args };
                }
                return { type: "FieldAccess", value: member, children: [{ type: "Identifier", value: t, children: [] }] };
            }
            if (peek() === "[") {
                eat();
                const index = parseExpression(tokens);
                eat();
                return { type: "ArrayAccess", value: t, children: [index] };
            }
            return { type: "Identifier", value: t, children: [] };
        }
        throw new Error("Bad token: " + t);
    }
    function binary(left, min = 0) {
        const prec = { "+": 1, "-": 1, "*": 2, "/": 2, "==": 0, "!=": 0, "<": 0, ">": 0, "<=": 0, ">=": 0 };
        while (true) {
            const op = peek();
            if (!op || !(op in prec) || prec[op] < min)
                break;
            eat();
            let right = primary();
            while (true) {
                const next = peek();
                if (!next || !(next in prec) || prec[next] <= prec[op])
                    break;
                right = binary(right, prec[next]);
            }
            left = { type: "Binary", value: op, children: [left, right] };
        }
        return left;
    }
    return binary(primary());
}
function parseTypeAnnotation(tokens) {
    const next = tokens[0];
    if (next === "int" || next === "string" || next === "bool" || next === "void" || next === "unknown") {
        tokens.shift();
        if (tokens[0] === "[") {
            tokens.shift();
            tokens.shift();
            return (next + "[]");
        }
        return next;
    }
    if (next && /^[A-Z]/.test(next)) {
        tokens.shift();
        return next;
    }
    return undefined;
}
function parse(tokens) {
    const program = { type: "Program", children: [] };
    const peek = () => tokens[0];
    const eat = () => tokens.shift();
    function parseBlockBody() {
        const body = { type: "Block", children: [] };
        while (peek() !== "}")
            body.children.push(parseStatement());
        return body;
    }
    function parseStatement() {
        const t = peek();
        if (t === "if") {
            eat();
            return parseIf();
        }
        if (t === "while") {
            eat();
            return parseWhile();
        }
        if (t === "for") {
            eat();
            return parseFor();
        }
        if (t === "break") {
            eat();
            eat();
            return { type: "Break", children: [] };
        }
        if (t === "continue") {
            eat();
            eat();
            return { type: "Continue", children: [] };
        }
        if (t === "return") {
            eat();
            const exprTokens = [];
            while (peek() !== ";")
                exprTokens.push(eat());
            eat();
            return { type: "Return", children: [parseExpression(exprTokens)] };
        }
        if (t === "var" || t === "let" || t === "const") {
            eat();
            const varType = parseTypeAnnotation(tokens);
            const name = eat();
            eat(); // =
            const exprTokens = [];
            while (peek() !== ";")
                exprTokens.push(eat());
            eat();
            return { type: "VarDecl", value: name, varType, children: [parseExpression(exprTokens)] };
        }
        const exprTokens = [];
        while (peek() !== ";")
            exprTokens.push(eat());
        eat();
        const eqIdx = exprTokens.lastIndexOf("=");
        const firstBracket = exprTokens.indexOf("[");
        if (eqIdx > 0 && exprTokens.includes("[") && firstBracket < eqIdx && firstBracket > 0) {
            const lhs = exprTokens.slice(0, eqIdx);
            const rhs = exprTokens.slice(eqIdx + 1);
            const name = lhs[0];
            const openIdx = lhs.indexOf("[");
            const closeIdx = lhs.lastIndexOf("]");
            return { type: "ArrayAssign", value: name, children: [parseExpression(lhs.slice(openIdx + 1, closeIdx)), parseExpression(rhs)] };
        }
        const dotIdx = exprTokens.indexOf(".");
        if (dotIdx === 1 && eqIdx > dotIdx) {
            const rhs = exprTokens.slice(eqIdx + 1);
            return { type: "FieldAssign", value: exprTokens[2], children: [{ type: "Identifier", value: exprTokens[0], children: [] }, parseExpression(rhs)] };
        }
        return parseExpression(exprTokens);
    }
    function parseWhile() {
        eat(); // (
        const condTokens = [];
        let depth = 1;
        while (depth > 0) {
            const tok = eat();
            if (tok === "(")
                depth++;
            else if (tok === ")") {
                depth--;
                if (depth === 0)
                    break;
            }
            condTokens.push(tok);
        }
        const cond = parseExpression(condTokens);
        eat();
        const body = parseBlockBody();
        eat();
        return { type: "While", children: [cond, body] };
    }
    function parseFor() {
        eat(); // (
        const initTokens = [];
        while (peek() !== ";")
            initTokens.push(eat());
        eat();
        const condTokens = [];
        while (peek() !== ";")
            condTokens.push(eat());
        eat();
        const updateTokens = [];
        while (peek() !== "{")
            updateTokens.push(eat());
        // remove trailing ) if present
        if (updateTokens[updateTokens.length - 1] === ")")
            updateTokens.pop();
        eat();
        const body = parseBlockBody();
        eat();
        let init = null;
        if (initTokens.length) {
            if (initTokens[0] === "var" || initTokens[0] === "let" || initTokens[0] === "const") {
                let offset = 1;
                let varType;
                if (["int", "string", "bool", "void", "unknown"].includes(initTokens[offset])) {
                    const tn = initTokens[offset++];
                    if (initTokens[offset] === "[") {
                        offset += 2;
                        varType = (tn + "[]");
                    }
                    else
                        varType = tn;
                }
                const name = initTokens[offset++];
                offset++;
                init = { type: "VarDecl", value: name, varType, children: [parseExpression(initTokens.slice(offset))] };
            }
            else
                init = parseExpression(initTokens);
        }
        const cond = condTokens.length ? parseExpression(condTokens) : null;
        const update = updateTokens.length ? parseExpression(updateTokens) : null;
        const forNode = { type: "For", children: [] };
        if (init)
            forNode.children.push(init);
        if (cond)
            forNode.children.push(cond);
        if (update)
            forNode.children.push(update);
        forNode.children.push(body);
        return forNode;
    }
    function parseIf() {
        eat(); // (
        const condTokens = [];
        let depth = 1;
        while (depth > 0) {
            const tok = eat();
            if (tok === "(")
                depth++;
            else if (tok === ")") {
                depth--;
                if (depth === 0)
                    break;
            }
            condTokens.push(tok);
        }
        const cond = parseExpression(condTokens);
        eat();
        const thenBlock = parseBlockBody();
        eat();
        const children = [cond, thenBlock];
        if (peek() === "else") {
            eat();
            if (peek() === "if") {
                eat();
                children.push(parseIf());
            }
            else {
                eat();
                const elseBlock = parseBlockBody();
                eat();
                children.push(elseBlock);
            }
        }
        return { type: "If", children };
    }
    function parseStructMethod() {
        eat(); // fn
        const name = eat();
        eat(); // (
        const params = [];
        while (peek() !== ")") {
            const p = eat();
            if (p === ",")
                continue;
            if (["int", "string", "bool", "void", "unknown"].includes(p) || /^[A-Z]/.test(p)) {
                let pt = p;
                if (peek() === "[") {
                    eat();
                    eat();
                    pt = (p + "[]");
                }
                params.push({ type: "Identifier", value: eat(), varType: pt, children: [] });
                continue;
            }
            params.push({ type: "Identifier", value: p, children: [] });
        }
        eat();
        eat(); // ) {
        const body = parseBlockBody();
        eat(); // }
        return { type: "StructMethod", value: name, children: [...params, body] };
    }
    function parseStruct() {
        const name = eat();
        let parent;
        if (peek() === "extends") {
            eat();
            parent = eat();
        }
        eat(); // {
        const fields = [], methods = [], overrides = [];
        while (peek() !== "}") {
            const t = peek();
            if (t === "overrides") {
                eat();
                eat();
                while (peek() !== "}")
                    overrides.push(parseStructMethod());
                eat();
                continue;
            }
            if (t === "fn") {
                methods.push(parseStructMethod());
                continue;
            }
            const mut = eat();
            const fieldName = eat();
            eat(); // :
            const fieldType = eat();
            eat(); // ;
            const f = { type: "StructField", value: fieldName, varType: fieldType, children: [] };
            if (mut === "const")
                f.isConst = true;
            fields.push(f);
        }
        eat(); // }
        return { type: "StructDef", value: name, parent, children: [...fields, ...methods, ...overrides] };
    }
    function parseFunction(keyword) {
        const name = eat();
        eat(); // (
        const params = [];
        while (peek() !== ")") {
            const p = eat();
            if (p === ",")
                continue;
            if (["int", "string", "bool", "void", "unknown"].includes(p) || /^[A-Z]/.test(p)) {
                let pt = p;
                if (peek() === "[") {
                    eat();
                    eat();
                    pt = (p + "[]");
                }
                params.push({ type: "Identifier", value: eat(), varType: pt, children: [] });
                continue;
            }
            params.push({ type: "Identifier", value: p, children: [] });
        }
        eat();
        eat(); // ) {
        const body = parseBlockBody();
        eat(); // }
        return { type: "Function", value: name, children: [...params, body] };
    }
    while (tokens.length) {
        const t = eat();
        if (!t)
            break;
        if (t === "function" || t === "fn") {
            program.children.push(parseFunction(t));
            continue;
        }
        if (t === "struct") {
            program.children.push(parseStruct());
            continue;
        }
        if (t === "main") {
            eat();
            eat();
            eat();
            const body = parseBlockBody();
            eat();
            program.children.push({ type: "Function", value: "main", children: [body] });
            continue;
        }
        if (t === "var") {
            const name = eat();
            eat();
            const expr = [];
            while (peek() !== ";")
                expr.push(eat());
            eat();
            program.children.push({ type: "VarDecl", value: name, children: [parseExpression(expr)] });
        }
    }
    return program;
}
function makeBuiltins() {
    return [
        { name: "print", kind: "func", params: 1, detail: "print(value) — prints an integer or string" },
        { name: "printchar", kind: "func", params: 1, detail: "printchar(ascii) — prints a character by ASCII code" },
        { name: "input", kind: "func", params: 0, detail: "input() → int — reads an integer from stdin" },
        { name: "inputstr", kind: "func", params: 0, detail: "inputstr() → string — reads a string from stdin" },
        { name: "len", kind: "func", params: 1, detail: "len(s) → int — length of a string" },
        { name: "strtoint", kind: "func", params: 1, detail: "strtoint(s) → int — parse string to int" },
        { name: "inttostr", kind: "func", params: 1, detail: "inttostr(n) → string — convert int to string" },
    ];
}
function analyzeDocument(source) {
    const errors = [];
    const globals = [...makeBuiltins()];
    const localStructs = new Map();
    // Reset struct registry for this document
    structRegistry.clear();
    let ast;
    try {
        const tokens = Lexer(source);
        ast = parse([...tokens]);
    }
    catch (e) {
        errors.push({
            range: node_1.Range.create(0, 0, 0, 0),
            message: "Parse error: " + e.message,
            severity: node_1.DiagnosticSeverity.Error,
        });
        return { globals, structs: localStructs, errors };
    }
    // First pass: collect top-level declarations
    for (const node of ast.children) {
        if (node.type === "Function") {
            const paramCount = node.children.filter(c => c.type === "Identifier").length;
            globals.push({ name: node.value, kind: "func", params: paramCount, detail: `function ${node.value}(${paramCount} param${paramCount !== 1 ? "s" : ""})` });
        }
        if (node.type === "StructDef") {
            const fields = [];
            const methods = new Map();
            if (node.parent) {
                const pd = lookupStruct(node.parent);
                if (pd) {
                    pd.fields.forEach(f => fields.push(f));
                    pd.methods.forEach((v, k) => methods.set(k, v));
                }
            }
            node.children.filter(c => c.type === "StructField").forEach(f => {
                fields.push({ name: f.value, type: f.varType ?? "unknown", isConst: f.isConst ?? false });
            });
            node.children.filter(c => c.type === "StructMethod").forEach(m => {
                methods.set(m.value, { params: m.children.filter(c => c.type === "Identifier").length });
            });
            node.children.filter(c => c.type === "StructOverrides").forEach(o => {
                o.children.forEach(m => methods.set(m.value, { params: m.children.filter(c => c.type === "Identifier").length }));
            });
            const def = { fields, methods, parent: node.parent };
            registerStruct(node.value, def);
            localStructs.set(node.value, def);
            globals.push({ name: node.value, kind: "struct", detail: `struct ${node.value}` });
        }
    }
    // Second pass: validate and collect errors
    const globalScope = createScope();
    for (const b of makeBuiltins())
        defineSym(globalScope, { name: b.name, kind: "func", params: b.params });
    for (const g of globals) {
        if (g.kind === "func" && g.name !== "print" && !makeBuiltins().find(b => b.name === g.name)) {
            try {
                defineSym(globalScope, { name: g.name, kind: "func", params: g.params });
            }
            catch { }
        }
        if (g.kind === "struct") {
            try {
                defineSym(globalScope, { name: g.name, kind: "struct", structDef: localStructs.get(g.name) });
            }
            catch { }
        }
    }
    try {
        validateNode(ast, globalScope, errors);
    }
    catch (e) {
        // top-level catch — individual errors collected inside
    }
    return { globals, structs: localStructs, errors };
}
function validateNode(node, scope, errors) {
    try {
        validateNodeInner(node, scope, errors);
    }
    catch (e) {
        errors.push({ range: node_1.Range.create(0, 0, 0, 0), message: e.message, severity: node_1.DiagnosticSeverity.Error });
    }
}
function validateNodeInner(node, scope, errors) {
    switch (node.type) {
        case "Program":
            node.children.forEach(c => validateNode(c, scope, errors));
            break;
        case "Function": {
            const fnScope = createScope(scope);
            node.children.filter(c => c.type === "Identifier").forEach(p => {
                try {
                    defineSym(fnScope, { name: p.value, kind: "param", type: p.varType ?? "unknown", structType: p.varType && /^[A-Z]/.test(p.varType) ? p.varType : undefined });
                }
                catch { }
            });
            node.children.forEach(c => validateNode(c, fnScope, errors));
            break;
        }
        case "Block": {
            const blockScope = createScope(scope);
            node.children.forEach(c => validateNode(c, blockScope, errors));
            break;
        }
        case "VarDecl": {
            validateNode(node.children[0], scope, errors);
            let structType;
            if (node.children[0].type === "StructInstantiate")
                structType = node.children[0].value;
            try {
                defineSym(scope, { name: node.value, kind: "var", type: node.varType ?? "unknown", structType });
            }
            catch { }
            break;
        }
        case "Identifier": {
            const sym = resolveSym(node.value, scope);
            if (!sym)
                errors.push({ range: node_1.Range.create(0, 0, 0, 0), message: `Undefined identifier: ${node.value}`, severity: node_1.DiagnosticSeverity.Error });
            break;
        }
        case "Call": {
            if (node.value.includes(".")) {
                node.children.forEach(a => validateNode(a, scope, errors));
                break;
            }
            const sym = resolveSym(node.value, scope);
            if (!sym || sym.kind !== "func")
                errors.push({ range: node_1.Range.create(0, 0, 0, 0), message: `Undefined function: ${node.value}`, severity: node_1.DiagnosticSeverity.Error });
            node.children.forEach(a => validateNode(a, scope, errors));
            break;
        }
        case "Assign": {
            const sym = resolveSym(node.value, scope);
            if (!sym)
                errors.push({ range: node_1.Range.create(0, 0, 0, 0), message: `Undefined variable: ${node.value}`, severity: node_1.DiagnosticSeverity.Error });
            validateNode(node.children[0], scope, errors);
            break;
        }
        case "StructInstantiate": {
            const def = lookupStruct(node.value);
            if (!def)
                errors.push({ range: node_1.Range.create(0, 0, 0, 0), message: `Unknown struct: ${node.value}`, severity: node_1.DiagnosticSeverity.Error });
            node.children.forEach(f => validateNode(f.children[0], scope, errors));
            break;
        }
        case "FieldAccess": {
            validateNode(node.children[0], scope, errors);
            break;
        }
        case "FieldAssign": {
            const obj = node.children[0];
            const sym = resolveSym(obj.value, scope);
            if (sym?.structType) {
                const def = lookupStruct(sym.structType);
                const field = def?.fields.find(f => f.name === node.value);
                if (field?.isConst)
                    errors.push({ range: node_1.Range.create(0, 0, 0, 0), message: `Cannot assign to const field '${node.value}'`, severity: node_1.DiagnosticSeverity.Error });
            }
            node.children.forEach(c => validateNode(c, scope, errors));
            break;
        }
        case "ArrayAccess": {
            const sym = resolveSym(node.value, scope);
            if (!sym)
                errors.push({ range: node_1.Range.create(0, 0, 0, 0), message: `Undefined variable: ${node.value}`, severity: node_1.DiagnosticSeverity.Error });
            validateNode(node.children[0], scope, errors);
            break;
        }
        case "ArrayLen": {
            const sym = resolveSym(node.value, scope);
            if (!sym)
                errors.push({ range: node_1.Range.create(0, 0, 0, 0), message: `Undefined variable: ${node.value}`, severity: node_1.DiagnosticSeverity.Error });
            break;
        }
        case "Binary":
        case "Unary":
        case "Return":
        case "If":
        case "While":
        case "For":
        case "ArrayLiteral":
        case "ArrayNew":
        case "ArrayAssign":
            node.children.forEach(c => validateNode(c, scope, errors));
            break;
        case "StructDef":
            // already handled in analyzeDocument
            break;
        default:
            node.children.forEach(c => validateNode(c, scope, errors));
    }
}
// Collect all symbols visible at a given scope depth (for completions)
function collectScopeSymbols(node, scope) {
    const results = [];
    let s = scope;
    while (s) {
        s.symbols.forEach((entry) => {
            results.push({ name: entry.name, kind: entry.kind, type: entry.type, structType: entry.structType, params: entry.params });
        });
        s = s.parent;
    }
    return results;
}
// Walk AST to find scope at a given line (rough approximation — good enough for completion)
function getScopeAtPosition(ast, line, source, globalScope) {
    // For now return global scope enriched with any var decls before this line
    // A full position-tracking parse would require storing line info in the AST
    return globalScope;
}
// ─── Per-document cache ───────────────────────────────────────────────────────
const docCache = new Map();
function refreshDocument(doc) {
    const result = analyzeDocument(doc.getText());
    docCache.set(doc.uri, result);
    connection.sendDiagnostics({ uri: doc.uri, diagnostics: result.errors });
}
// ─── LSP lifecycle ───────────────────────────────────────────────────────────
connection.onInitialize((params) => {
    return {
        capabilities: {
            textDocumentSync: node_1.TextDocumentSyncKind.Incremental,
            completionProvider: { resolveProvider: true, triggerCharacters: ["."] },
            hoverProvider: true,
        },
    };
});
documents.onDidChangeContent((change) => {
    refreshDocument(change.document);
});
documents.onDidOpen((e) => {
    refreshDocument(e.document);
});
// ─── Completion ───────────────────────────────────────────────────────────────
connection.onCompletion((params) => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc)
        return [];
    const cache = docCache.get(params.textDocument.uri);
    if (!cache)
        return [];
    const text = doc.getText();
    const offset = doc.offsetAt(params.position);
    // Check if we're after a dot — if so, offer struct members
    const lineText = doc.getText(node_1.Range.create(params.position.line, 0, params.position.line, params.position.character));
    const dotMatch = lineText.match(/(\w+)\.\s*$/);
    if (dotMatch) {
        const varName = dotMatch[1];
        // Find the struct type of this variable by scanning globals + building a quick scope
        const items = [];
        // Try to find in source: "var ... varName = StructName {"
        const structTypeMatch = text.match(new RegExp(`var\\s+(?:\\w+\\s+)?${varName}\\s*=\\s*(\\w+)\\s*\\{`));
        if (structTypeMatch) {
            const structName = structTypeMatch[1];
            const def = cache.structs.get(structName);
            if (def) {
                def.fields.forEach(f => items.push({
                    label: f.name,
                    kind: node_1.CompletionItemKind.Field,
                    detail: `${f.isConst ? "const" : "var"} ${f.name}: ${f.type}`,
                }));
                def.methods.forEach((m, name) => items.push({
                    label: name,
                    kind: node_1.CompletionItemKind.Method,
                    detail: `fn ${name}(${m.params} param${m.params !== 1 ? "s" : ""})`,
                    insertText: `${name}()`,
                }));
            }
        }
        if (items.length > 0)
            return items;
        // Fall through to general completions if no struct found
    }
    // General completions: globals + keywords + types
    const items = [];
    // Symbols from cache
    cache.globals.forEach(sym => {
        if (sym.kind === "func") {
            items.push({
                label: sym.name,
                kind: node_1.CompletionItemKind.Function,
                detail: sym.detail ?? sym.name,
                insertText: sym.params === 0 ? `${sym.name}()` : `${sym.name}(`,
            });
        }
        else if (sym.kind === "struct") {
            items.push({ label: sym.name, kind: node_1.CompletionItemKind.Class, detail: sym.detail });
        }
    });
    // Keywords
    const keywords = ["var", "function", "fn", "struct", "return", "if", "else", "while", "for", "break", "continue", "new", "extends", "overrides", "this", "const", "main"];
    keywords.forEach(k => items.push({ label: k, kind: node_1.CompletionItemKind.Keyword }));
    // Types
    ["int", "bool", "string", "void"].forEach(t => items.push({ label: t, kind: node_1.CompletionItemKind.TypeParameter }));
    return items;
});
connection.onCompletionResolve((item) => item);
// ─── Hover ────────────────────────────────────────────────────────────────────
connection.onHover((params) => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc)
        return null;
    const cache = docCache.get(params.textDocument.uri);
    if (!cache)
        return null;
    // Get word under cursor
    const lineText = doc.getText(node_1.Range.create(params.position.line, 0, params.position.line, 999));
    const col = params.position.character;
    const wordMatch = lineText.slice(0, col + 1).match(/(\w+)$/);
    if (!wordMatch)
        return null;
    const word = wordMatch[1];
    // Check globals
    const sym = cache.globals.find(g => g.name === word);
    if (sym) {
        let content = "";
        if (sym.kind === "func")
            content = `**function** \`${sym.name}\` — ${sym.detail ?? ""}`;
        else if (sym.kind === "struct") {
            const def = cache.structs.get(sym.name);
            const fieldLines = def ? def.fields.map(f => `  ${f.isConst ? "const" : "var"} ${f.name}: ${f.type}`).join("\n") : "";
            content = `**struct** \`${sym.name}\`\n\`\`\`\n${fieldLines}\n\`\`\``;
        }
        return { contents: { kind: node_1.MarkupKind.Markdown, value: content } };
    }
    // Check builtins
    const builtin = makeBuiltins().find(b => b.name === word);
    if (builtin)
        return { contents: { kind: node_1.MarkupKind.Markdown, value: `**builtin** \`${builtin.detail}\`` } };
    // Check types
    const typeInfo = { int: "integer type", bool: "boolean type", string: "string type", void: "void type" };
    if (typeInfo[word])
        return { contents: { kind: node_1.MarkupKind.Markdown, value: `**type** \`${word}\` — ${typeInfo[word]}` } };
    return null;
});
// ─── Start ────────────────────────────────────────────────────────────────────
documents.listen(connection);
connection.listen();
