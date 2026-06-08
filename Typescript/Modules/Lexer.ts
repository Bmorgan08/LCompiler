export interface Token {
    value: string;
    line: number;
    col: number;
}

export function Lexer(src: string): string[] {
    return LexerWithPos(src).map(t => t.value);
}

export function LexerWithPos(src: string): Token[] {
    const tokens: Token[] = [];
    let line = 1;
    let col = 1;

    for (let i = 0; i < src.length; i++) {
        const c = src[i];

        if (c === "\r") { col++; continue; }
        if (c === "\n") { line++; col = 1; continue; }
        if (c === " " || c === "\t") { col++; continue; }

        // line comment
        if (c === "/" && src[i + 1] === "/") {
            while (i < src.length && src[i] !== "\n") { i++; }
            line++; col = 1;
            continue;
        }

        const startLine = line;
        const startCol = col;

        if (c === "a" && src.slice(i, i + 3) === "asm" && !/[a-zA-Z0-9_]/.test(src[i + 3] ?? "")) {
            // asm { raw nasm } — capture raw content verbatim
            tokens.push({ value: "asm", line: startLine, col: startCol });
            col += 3; i += 2;
            // skip whitespace to opening brace
            while (i + 1 < src.length && (src[i + 1] === " " || src[i + 1] === "\t" || src[i + 1] === "\n" || src[i + 1] === "\r")) {
                if (src[i + 1] === "\n") { line++; col = 1; } else col++;
                i++;
            }
            if (src[i + 1] !== "{") throw new Error(`${line}:${col}: expected '{' after asm`);
            i++; col++; // eat {
            tokens.push({ value: "{", line, col });
            let raw = "";
            let depth = 1;
            i++;
            while (i < src.length && depth > 0) {
                if (src[i] === "{") depth++;
                else if (src[i] === "}") { depth--; if (depth === 0) break; }
                if (src[i] === "\n") { line++; col = 1; } else col++;
                raw += src[i++];
            }
            tokens.push({ value: `__asm__:${raw}`, line, col });
            tokens.push({ value: "}", line, col });
        } else if (/[a-zA-Z_]/.test(c)) {
            let id = c;
            while (i + 1 < src.length && /[a-zA-Z0-9_]/.test(src[i + 1])) {
                id += src[++i];
            }
            tokens.push({ value: id, line: startLine, col: startCol });
            col += id.length;
        } else if (/\d/.test(c)) {
            let num = c;
            while (i + 1 < src.length && /\d/.test(src[i + 1])) {
                num += src[++i];
            }
            // float: digits.digits
            if (i + 1 < src.length && src[i + 1] === "." && i + 2 < src.length && /\d/.test(src[i + 2])) {
                num += src[++i]; // .
                while (i + 1 < src.length && /\d/.test(src[i + 1])) {
                    num += src[++i];
                }
            }
            tokens.push({ value: num, line: startLine, col: startCol });
            col += num.length;
        } else if ((c === "&" && src[i + 1] === "&") || (c === "|" && src[i + 1] === "|")) {
            tokens.push({ value: c + src[i + 1], line: startLine, col: startCol });
            i++; col += 2;
        } else if (c === "=" && src[i + 1] === ">") {
            tokens.push({ value: "=>", line: startLine, col: startCol });
            i++; col += 2;
        } else if ((c === "=" || c === "!" || c === "<" || c === ">") && src[i + 1] === "=") {
            tokens.push({ value: c + "=", line: startLine, col: startCol });
            i++; col += 2;
        } else if ((c === "+" || c === "-" || c === "*" || c === "/" || c === "%") && src[i + 1] === "=") {
            tokens.push({ value: c + "=", line: startLine, col: startCol });
            i++; col += 2;
        } else if (c === "+" && src[i + 1] === "+") {
            tokens.push({ value: "++", line: startLine, col: startCol });
            i++; col += 2;
        } else if (c === "-" && src[i + 1] === "-") {
            tokens.push({ value: "--", line: startLine, col: startCol });
            i++; col += 2;
        } else if (c === "." && src[i + 1] === "." && src[i + 2] === ".") {
            tokens.push({ value: "...", line: startLine, col: startCol });
            i += 2; col += 3;
        } else if (c === "." && src[i + 1] === ".") {
            tokens.push({ value: "..", line: startLine, col: startCol });
            i++; col += 2;
        } else if (c === "'" && i + 2 < src.length && src[i + 2] === "'") {
            // char literal 'x'
            tokens.push({ value: `'${src[i + 1]}'`, line: startLine, col: startCol });
            i += 2; col += 3;
        } else if (c === '"') {
            let str = '"';
            i++;
            while (i < src.length && src[i] !== '"') {
                if (src[i] === '\n') { line++; col = 1; }
                str += src[i++];
            }
            str += '"';
            tokens.push({ value: str, line: startLine, col: startCol });
            col += str.length;
        } else {
            tokens.push({ value: c, line: startLine, col: startCol });
            col++;
        }
    }
    return tokens.filter(t => t.value.length > 0);
}

module.exports = { Lexer, LexerWithPos };
