type SymbolKind = "var" | "func" | "param" | "struct"

// also array types of any element ("string[]", "P[]"), struct names ("Point") and "tuple"
export type Ltype = "int" | "float" | "bool" | "void" | "string" | "char" | "int[]" | "float[]" | "char[]" | "int[][]" | "unknown" | (string & {});

export type StructField = {
    name: String
    type: Ltype
    isConst: boolean
    default?: import("./Parser").Node    // `var tags: int[] = [];` — used when a struct literal leaves the field out
}

export type StructDef = {
    fields: StructField[]
    methods: Map<string, MethodDef>
    parent?: string
}

export type MethodDef = {
    params: number
    returnType?: Ltype
} 

export type SymbolEntry = {
    name: string;
    kind: SymbolKind;
    params?: number;
    type?: Ltype;
    size?: number;
    structType?: string
    structDef?: StructDef
    isConst?: boolean
};

export type Scope = {
    symbols: Map<string, SymbolEntry>;
    parent?: Scope;
};

export function createScope(parent?: Scope): Scope {
    return { symbols: new Map(), parent };
}

export function define(scope: Scope, entry: SymbolEntry) {
    if (scope.symbols.has(entry.name)) {
        throw new Error(`Duplicate declaration: ${entry.name}`);
    }
    scope.symbols.set(entry.name, entry);
}

export function resolve(name: string, scope: Scope): SymbolEntry | null {
    let s: Scope | undefined = scope;
    while (s) {
        const found = s.symbols.get(name);
        if (found) return found;
        s = s.parent;
    }
    return null;
}

const structRegistry = new Map<string, StructDef>()

export function registerStruct(name: string, def: StructDef) {
    structRegistry.set(name, def)
}

export function lookupStruct(name:string): StructDef | undefined {
    return structRegistry.get(name)
}

export default { createScope, define, resolve };

// "(string,(int,char),P[])" -> ["string", "(int,char)", "P[]"]: split at the top-level commas
export function tupleTypeParts(t: string): string[] {
    const parts: string[] = [];
    let depth = 0, cur = "";
    for (const ch of t.slice(1, -1)) {
        if (ch === "(" || ch === "<") depth++;
        if (ch === ")" || ch === ">") depth--;
        if (ch === "," && depth === 0) { parts.push(cur); cur = ""; } else cur += ch;
    }
    parts.push(cur);
    return parts;
}

// "fn(int,(string,int)):float" -> { params: ["int", "(string,int)"], ret: "float" }
export function fnTypeParts(t: string): { params: string[], ret: string } | undefined {
    if (!t.startsWith("fn(")) return undefined;
    let depth = 0, close = -1;
    for (let i = 2; i < t.length; i++) {
        if (t[i] === "(") depth++;
        if (t[i] === ")") { depth--; if (depth === 0) { close = i; break; } }
    }
    if (close < 0) return undefined;
    const inside = t.slice(2, close + 1);
    const params = inside === "()" ? [] : tupleTypeParts(inside);
    const ret = t[close + 1] === ":" ? t.slice(close + 2) : "unknown";
    return { params, ret };
}

// "map<string,(int,char)>" -> { key: "string", value: "(int,char)" }
export function mapTypeParts(t: string | undefined): { key: string, value: string } | undefined {
    if (!t || !t.startsWith("map<") || !t.endsWith(">")) return undefined;
    const [key, value] = tupleTypeParts(`(${t.slice(4, -1)})`);
    return { key, value };
}

// ── Low-level types: sized integers, pointers and packed structs ──

import { SIZED_INTS } from "./Parser";

export const isSizedInt = (t: string | undefined): boolean => !!t && t in SIZED_INTS;
// narrower than 64 bits: a value of this type is kept widened, and stores/casts cut it to size
export const isSmallInt = (t: string | undefined): boolean => isSizedInt(t) && SIZED_INTS[t!].size < 8;
export const isPtrType = (t: string | undefined): boolean => !!t && t.startsWith("ptr<") && t.endsWith(">");
export const ptrElem = (t: string | undefined): string | undefined => isPtrType(t) ? t!.slice(4, -1) : undefined;

// packed struct S { var f: u16; ... }: fields in order, no padding and no hidden header
export type PackedField = { name: string, type: string, offset: number };
export type PackedDef = { size: number, fields: PackedField[] };
const packedFields = new Map<string, { name: string, type: string }[]>();
const packedLayouts = new Map<string, PackedDef>();

export function registerPacked(name: string, fields: { name: string, type: string }[]) {
    packedFields.set(name, fields);
}

export function isPackedStruct(name: string | undefined): boolean {
    return !!name && packedFields.has(name);
}

// the layout of a packed struct (a nested packed struct is laid out inline)
export function packedLayout(name: string, inProgress = new Set<string>()): PackedDef {
    const done = packedLayouts.get(name);
    if (done) return done;
    const raw = packedFields.get(name);
    if (!raw) throw new Error(`Unknown packed struct: ${name}`);
    if (inProgress.has(name)) throw new Error(`packed struct ${name} contains itself`);
    inProgress.add(name);
    const fields: PackedField[] = [];
    let offset = 0;
    for (const f of raw) {
        const size = sizeOfType(f.type, inProgress);
        if (size === undefined) {
            throw new Error(`Field ${f.name} of packed struct ${name} can't be ${f.type}: packed struct fields are sized integers, int, char, bool, pointers or other packed structs`);
        }
        fields.push({ name: f.name, type: f.type, offset });
        offset += size;
    }
    inProgress.delete(name);
    const def = { size: offset, fields };
    packedLayouts.set(name, def);
    return def;
}

// the size in bytes of a type that can live in raw memory, or undefined (strings, arrays, floats, ...)
export function sizeOfType(t: string, inProgress = new Set<string>()): number | undefined {
    if (isSizedInt(t)) return SIZED_INTS[t].size;
    if (t === "int" || isPtrType(t)) return 8;
    if (t === "char" || t === "bool") return 1;
    if (isPackedStruct(t)) return packedLayout(t, inProgress).size;
    return undefined;
}
