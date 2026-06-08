import { Scope, define, createScope, registerStruct, lookupStruct, StructDef, StructField } from "./Scope";
import { Node } from "./Parser";

export function declare(node: Node, scope: Scope) {
    switch (node.type) {

        case "StructDef": {
            const fields: StructField[] = []
            const methods = new Map<string, { params:number }>()

            if (node.parent) {
                const parentDef = lookupStruct(node.parent)
                if (parentDef) {
                    parentDef.fields.forEach(f => fields.push(f))
                    parentDef.methods.forEach((v, k) => methods.set(k, v))
                }
            }

            node.children
                .filter(c => c.type === "StructField")
                .forEach(f => {
                    fields.push({
                        name: f.value!,
                        type: f.varType ?? "unknown" as any,
                        isConst: f.isConst ?? false
                    })
                })
        
            node.children
                .filter(c => c.type === "StructMethod")
                .forEach(m => {
                    const paramCount = m.children.filter(c => c.type === "Identifier").length
                    methods.set(m.value!, { params: paramCount })
                })

            node.children
            .filter(c => c.type === "StructOverrides")
            .forEach(o => {
                o.children.forEach(m => {
                    const paramCount = m.children.filter(c => c.type === "Identifier").length;
                    methods.set(m.value!, { params: paramCount });
                });
            });

            const def: StructDef = { fields, methods, parent: node.parent }
            registerStruct(node.value!, def)

            define(scope, {
                name: node.value!,
                kind: "struct",
                structDef: def
            })
            break
        }

        case "StructField":
            break;
        case "StructMethod":
            break;
        case "StructOverrides":
            break;
        case "StructInstantiate":
            break;
        case "FieldAccess":
            break;
        case "FieldAssign":
            break;
        case "This":
            break;

        case "Program":
            node.children.forEach(c => declare(c, scope));
            break;

        case "Function":
            define(scope, {
                name: node.value!,
                kind: "func",
                params: node.children.filter(c => c.type === "Identifier").length
            });

            const fnScope = createScope(scope);

            node.children.forEach(c => {
                if (c.type === "Identifier") {
                    define(fnScope, {
                        name: c.value!,
                        kind: "param",
                        structType: c.varType && /^[A-Z]/.test(c.varType) ? c.varType : undefined
                    });
                }
            });

            node.children.forEach(c => {
                if (c.type === "Block") declare(c, fnScope);
            });
            break;

        case "Block": {
            const blockScope = createScope(scope);
            node.children.forEach(c => declare(c, blockScope));
            break;
        }

        case "ArrayLiteral":
            break;
        case "ArrayNew":
            break;
        case "ArrayAssign":
            break;
        case "ArrayAccess":
            break;
        case "ArrayLen":
            break;

        case "VarDecl":
            define(scope, {
                name: node.value!,
                kind: "var",
                type: node.varType ?? "unknown",
                structType: node.children[0].type === "StructInstantiate" ? node.children[0].value : undefined
            });
            break;

        case "ForIn": {
            // Declare the loop variable in the body scope
            // We just recurse into the body block — VarDecl for loop var handled in validate
            if (node.children[1] && node.children[1].type === "Block") {
                const forInScope = createScope(scope);
                define(forInScope, { name: node.value!, kind: "var", type: "int" });
                declare(node.children[1], forInScope);
            }
            break;
        }

        case "Match":
            // recurse into arm bodies
            node.children.slice(1).forEach(arm => {
                if (arm.value === "_") {
                    if (arm.children[0]) declare(arm.children[0], scope);
                } else {
                    // children[1] is the body
                    if (arm.children[1]) declare(arm.children[1], scope);
                }
            });
            break;

        case "MatchArm":
        case "Char":
        case "Tuple":
        case "TupleAccess":
        case "ArraySlice":
        case "CompoundAssign":
        case "PostfixInc":
        case "PostfixDec":
            break;
    }
}

module.exports = { declare };