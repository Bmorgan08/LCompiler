import { Node } from "./Parser";
import { Scope, resolve, createScope, define, registerStruct, StructDef, lookupStruct, StructField } from "./Scope";
import { Ltype } from "./Scope";

function err(node: Node, msg: string): never {
    const prefix = (node.line && node.col) ? `${node.line}:${node.col}: ` : "";
    throw new Error(prefix + msg);
}

function validateStructMethod(method: Node, structName: string, parentScope: Scope) {
    const methodScope = createScope(parentScope)

    define(methodScope, {
        name: "this",
        kind: "var",
        structType: structName
    })

    method.children
        .filter(c => c.type === "Identifier")
        .forEach(p => {
            define(methodScope, {
                name: p.value!,
                kind: "param",
                type: p.varType ?? "unknown"
            });
        });

    const body = method.children.find(c => c.type === "Block")
    if(body) validate(body, methodScope)
}

function inferType(node: Node, scope: Scope): Ltype {
    switch (node.type) {
        case "Number":
            return node.varType === "float" ? "float" : node.varType === "bool" ? "bool" : "int";

        case "String":
            return "string";

        case "ArrayLiteral":
            return "int[]";

        case "ArrayNew":
            return node.varType === "int[][]" ? "int[][]" : "int[]";

        case "ArrayLen":
            return "int";

        case "ArrayAccess": {
            const sym = resolve(node.value!, scope);
            if (!sym) err(node, `Undefined identifier: ${node.value}`);
            validate(node.children[0], scope);
            return sym.type === "float[]" ? "float" : "int";
        }

        case "Identifier": {
            const sym = resolve(node.value!, scope);
            if (!sym) err(node, `Undefined identifier: ${node.value}`);
            return sym.type ?? "unknown";
        }

        case "Unary":
            return inferType(node.children[0], scope);

        case "Binary": {
            const left = inferType(node.children[0], scope);
            const right = inferType(node.children[1], scope);
            if (["&&", "||"].includes(node.value!)) return "bool";
            if (["==", "!=", "<", ">", "<=", ">="].includes(node.value!)) return "bool";
            // bool and int are interchangeable
            const compatible = (a: Ltype, b: Ltype) =>
                a === b || a === "unknown" || b === "unknown" ||
                (a === "bool" && b === "int") || (a === "int" && b === "bool");
            if (!compatible(left, right)) err(node, `Type mismatch: ${left} vs ${right}`);
            if (left === "float" || right === "float") return "float";
            return left;
        }

        case "Call": {
            const sym = resolve(node.value!, scope);
            return sym?.type ?? "unknown";
        }

        default:
            return "unknown";
    }
}

export function validate(node: Node, scope: Scope) {
    switch (node.type) {
        case "StructDef":
        const fields: StructField[] = []
        const methods = new Map<string, { params: number }>()

        node.children.filter(c => c.type === "StructField")
            .forEach(f => {
                fields.push({
                    name: f.value as string,
                    type: f.varType ?? "unknown" as any,
                    isConst: f.isConst ?? false
                })
            })
        
        node.children
            .filter(c => c.type === "StructMethod")
            .forEach(m => {
                const paramCount = m.children.filter( c => c.type === "Identifier").length
                methods.set(m.value!, { params: paramCount })
            })

        node.children
            .filter(c => c.type === "StructOverrides")
            .forEach( o => {
                o.children.forEach(m => {
                    const paramCount = m.children.filter( c => c.type === "Identifier").length
                    methods.set(m.value!, { params: paramCount } )
                })
            })
        
            let parentFields: StructField[] = []
            if(node.parent) {
                const parentDef = lookupStruct(node.parent)
                if (!parentDef) err(node, `Unknown parent struct: ${node.parent}`)
                parentFields = parentDef.fields
                parentDef.methods.forEach((v, k) => {
                    if (!methods.has(k)) methods.set(k, v)
                })
            }

            const def: StructDef = {
                fields: [...parentFields, ...fields],
                methods,
                parent: node.parent
            }

            registerStruct(node.value!, def)

            node.children
                .filter(c => c.type === "StructMethod" || c.type === "StructOverrides")
                .forEach(c => {
                    if(c.type === "StructOverrides") {
                        c.children.forEach(m => validateStructMethod(m, node.value!, scope))
                    } else {
                        validateStructMethod(c, node.value!, scope)
                    }
                })
            break
        
        case "StructInstantiate": {
            const structDef = lookupStruct(node.value!)
            if(!structDef) err(node, `Unknown struct: ${node.value}`)
            node.children.forEach(f => {
                const fieldDef = structDef.fields.find( sf => sf.name === f.value)
                if (!fieldDef) err(f, `Unknown field '${f.value}' on struct '${node.value}'`)
                    validate(f.children[0], scope)
            })
            break
        }

        case "FieldAccess": {
            const obj = node.children[0]
            validate(obj, scope)

            if (obj.type == "This") break

            const sym = resolve(obj.value!, scope)
            if (!sym) err(obj, `Undefined variable: ${obj.value}`)
            if (!sym.structType) err(obj, `'${obj.value}' is not a struct`)

            const structDef = lookupStruct(sym.structType)
            if (!structDef) err(obj, `Unknown struct type: ${sym.structType}`)

            const field = structDef.fields.find( f=> f.name === node.value)
            if(!field) err(node, `Unknown field '${node.value}' on struct '${sym.structType}'`)
            break
        }

        case "FieldAssign": {
            const obj = node.children[0]
            validate(obj, scope)

            const sym = resolve(obj.value!, scope)
            if (!sym) err(obj, `Undefined variable: ${obj.value}`)
            if (!sym.structType) err(obj, `'${obj.value}' is not a struct`)

            const structDef = lookupStruct(sym.structType as string)
            if (!structDef) err(obj, `Unknown struct type: ${sym.structType}`)

            const field = structDef.fields.find(f => f.name === node.value)
            if ( !field) err(node, `Unknown field '${node.value}' on struct '${sym.structType}`)
            if (field.isConst) err(node, `Cannot assign to const field '${node.value}'`);

            validate(node.children[1], scope)
            break
        }

        case "This":
            break
        
        case "StructField":
            break
        
        case "StructMethod":
            break

        case "StructOverrides":
            break

        case "Program":
            node.children.forEach(c => validate(c, scope));
            break;

        case "Function": {
            const fnScope = createScope(scope);
            node.children.forEach(c => {
                if (c.type === "Identifier") {
                    define(fnScope, {
                        name: c.value!,
                        kind: "param",
                        type: c.varType ?? "unknown",
                        structType: c.varType && /^[A-Z]/.test(c.varType) ? c.varType : undefined
                    });
                }
            });
            node.children.forEach(c => validate(c, fnScope));
            break;
        }

        case "Block": {
            const blockScope = createScope(scope);
            node.children.forEach(c => validate(c, blockScope));
            break;
        }

        case "VarDecl": {
            validate(node.children[0], scope);
            const inferredType = inferType(node.children[0], scope);
            const compatible = (declared: string, inferred: string) =>
                (declared === "int" && inferred === "bool") ||   // bool→int ok
                (declared === "int" && inferred === "float") ||  // float→int truncates
                (declared === "float" && inferred === "int");    // int→float widens
            if (node.varType && node.varType !== inferredType && inferredType !== "unknown"
                && !compatible(node.varType, inferredType)) {
                err(node, `Type annotation mismatch: declared ${node.varType}, inferred ${inferredType}`);
            }
            const finalType = node.varType ?? inferredType;
            let arraySize: number | undefined;
            if (node.children[0].type === "ArrayLiteral") {
                arraySize = node.children[0].children.length;
            } else if (node.children[0].type === "ArrayNew" && node.children[0].children[0].type === "Number") {
                arraySize = Number(node.children[0].children[0].value);
            }
            let structType: string | undefined
            if(node.children[0].type === "StructInstantiate") {
                structType = node.children[0].value
            }
            if (!resolve(node.value!, scope)) {
                define(scope, {
                    name: node.value!,
                    kind: "var",
                    type: finalType,
                    size: arraySize,
                    structType
                });
            }
            
            break;
        }

        case "Unary":
            validate(node.children[0], scope);
            break;

        case "Return":
            validate(node.children[0], scope);
            break;

        case "Call": {
            if(node.value!.includes(".")) {
                const [objName, methodName] = node.value!.split(".")

                if(objName === "this") [
                    node.children.forEach(a => {
                        validate(a, scope)
                    })
                ]

                const sym = resolve(objName, scope)
                if (!sym) err(node, `Undefined variable: ${objName}`)
                if (!sym.structType) err(node, `'${objName}' is not a struct`)

                const structDef = lookupStruct(sym.structType)
                if (!structDef) err(node, `Unknown struct type: ${sym.structType}`);

                if (!structDef.methods.has(methodName)) {
                    err(node, `Unknown method '${methodName}' on struct '${sym.structType}'`);
                }

                node.children.forEach(a => validate(a, scope));
                break;
            }
            const sym = resolve(node.value!, scope);
            if (!sym || sym.kind !== "func") {
                err(node, `Undefined function: ${node.value}`);
            }
            if (sym.params !== undefined && node.children.length !== sym.params) {
                err(node, `Function ${node.value} expects ${sym.params} args, got ${node.children.length}`);
            }
            node.children.forEach(a => validate(a, scope));
            break;
        }

        case "Binary":
            validate(node.children[0], scope);
            validate(node.children[1], scope);
            break;

        case "Identifier": {
            const sym = resolve(node.value!, scope);
            if (!sym) err(node, `Undefined identifier: ${node.value}`);
            break;
        }

        case "Number":
        case "String":
            break;

        case "Assign": {
            const sym = resolve(node.value!, scope);
            if (!sym) err(node, `Undefined variable: ${node.value}`);
            validate(node.children[0], scope);
            const inferredType = inferType(node.children[0], scope);
            const compatibleAssign = (declared: string, inferred: string) =>
                (declared === "int" && inferred === "bool") ||
                (declared === "int" && inferred === "float") ||
                (declared === "float" && inferred === "int");
            if (sym.type && sym.type !== inferredType && inferredType !== "unknown"
                && !compatibleAssign(sym.type, inferredType)) {
                err(node, `Type mismatch in assignment to ${node.value}: ${sym.type} vs ${inferredType}`);
            }
            break;
        }

        case "ArrayLiteral":
            node.children.forEach(c => validate(c, scope));
            break;

        case "ArrayNew":
            validate(node.children[0], scope);
            break;

        case "ArrayAccess": {
            const sym = resolve(node.value!, scope);
            if (!sym) err(node, `Undefined variable: ${node.value}`);
            validate(node.children[0], scope);
            if (node.children[0].type === "Number") {
                const idx = Number(node.children[0].value);
                if (idx < 0) err(node.children[0], `Array index out of bounds: negative index ${idx} for '${node.value}'`);
                if (sym.size !== undefined && idx > sym.size) {
                    err(node.children[0], `Array index out of bounds: index ${idx} >= size ${sym.size} for '${node.value}'`);
                }
            }
            break;
        }

        case "ArrayAssign": {
            const sym = resolve(node.value!, scope);
            if (!sym) err(node, `Undefined variable: ${node.value}`);
            validate(node.children[0], scope); // index
            validate(node.children[1], scope); // value
            break;
        }

        case "ArrayLen": {
            const sym = resolve(node.value!, scope);
            if (!sym) err(node, `Undefined variable: ${node.value}`);
            break;
        }

        case "If":
            node.children.forEach(c => validate(c, scope));
            break;

        case "While":
            node.children.forEach(c => validate(c, scope));
            break;

        case "For":
            node.children.forEach(c => validate(c, scope));
            break;

        case "ArrayAccess2D" as any: {
            const sym = resolve(node.value!, scope);
            if (!sym) err(node, `Undefined variable: ${node.value}`);
            validate(node.children[0], scope);
            validate(node.children[1], scope);
            break;
        }

        case "ArrayAssign2D" as any: {
            const sym = resolve(node.value!, scope);
            if (!sym) err(node, `Undefined variable: ${node.value}`);
            validate(node.children[0], scope);
            validate(node.children[1], scope);
            validate(node.children[2], scope);
            break;
        }

        case "Break":
        case "Continue":
            break;

        case "Char":
            break;

        case "CompoundAssign": {
            const lhs = node.children[0];
            const sym = resolve(lhs.value!, scope);
            if (!sym) err(lhs, `Undefined variable: ${lhs.value}`);
            validate(node.children[1], scope);
            break;
        }

        case "PostfixInc":
        case "PostfixDec": {
            const sym = resolve(node.value!, scope);
            if (!sym) err(node, `Undefined variable: ${node.value}`);
            break;
        }

        case "ForIn": {
            // node.value = loop var name, children[0] = array expr, children[1] = body
            const forInScope = createScope(scope);
            validate(node.children[0], scope);
            const arrType = inferType(node.children[0], scope);
            const elemType = arrType === "float[]" ? "float" : arrType === "char[]" ? "char" : "int";
            define(forInScope, { name: node.value!, kind: "var", type: elemType });
            validate(node.children[1], forInScope);
            break;
        }

        case "Match": {
            // children[0] = subject, rest = MatchArm
            validate(node.children[0], scope);
            node.children.slice(1).forEach(arm => {
                const armScope = createScope(scope);
                if (arm.value === "_") {
                    // wildcard: children[0] = body
                    validate(arm.children[0], armScope);
                } else {
                    // children[0] = pattern expr, children[1] = body
                    validate(arm.children[0], armScope);
                    validate(arm.children[1], armScope);
                }
            });
            break;
        }

        case "MatchArm":
            node.children.forEach(c => validate(c, scope));
            break;

        case "Tuple":
            node.children.forEach(c => validate(c, scope));
            break;

        case "TupleAccess":
            validate(node.children[0], scope);
            break;

        case "ArraySlice": {
            const sym = resolve(node.value!, scope);
            if (!sym) err(node, `Undefined variable: ${node.value}`);
            validate(node.children[0], scope);
            validate(node.children[1], scope);
            break;
        }
    }
}

module.exports = { validate };