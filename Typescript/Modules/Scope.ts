type SymbolKind = "var" | "func" | "param" | "struct"

export type Ltype = "int" | "float" | "bool" | "void" | "string" | "char" | "int[]" | "float[]" | "char[]" | "int[][]" | "unknown";

export type StructField = {
    name: String
    type: Ltype
    isConst: boolean
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

type SymbolEntry = {
    name: string;
    kind: SymbolKind;
    params?: number;
    type?: Ltype;
    size?: number;
    structType?: string
    structDef?: StructDef
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
