import { isDeepStrictEqual } from "node:util";

// Test-only evaluator for the keywords used by the NLI schemas, not a full metaschema validator.
export function matchesJsonSchema(schema, value, root = schema) {
  if (schema.$ref) return matchesJsonSchema(resolveJsonPointer(root, schema.$ref), value, root);
  if (schema.allOf && !schema.allOf.every((part) => matchesJsonSchema(part, value, root))) return false;
  if (schema.anyOf && !schema.anyOf.some((part) => matchesJsonSchema(part, value, root))) return false;
  if (schema.oneOf && schema.oneOf.filter((part) => matchesJsonSchema(part, value, root)).length !== 1) return false;
  if (schema.not && matchesJsonSchema(schema.not, value, root)) return false;
  if (schema.if && matchesJsonSchema(schema.if, value, root)) {
    if (schema.then && !matchesJsonSchema(schema.then, value, root)) return false;
  } else if (schema.else && !matchesJsonSchema(schema.else, value, root)) {
    return false;
  }
  if (Object.hasOwn(schema, "const") && !isDeepStrictEqual(value, schema.const)) return false;
  if (schema.enum && !schema.enum.some((entry) => isDeepStrictEqual(value, entry))) return false;
  if (schema.type && !matchesType(schema.type, value)) return false;
  if (typeof value === "number" && (value < schema.minimum || value > schema.maximum)) return false;
  if (typeof value === "string") {
    const length = [...value].length;
    if (length < schema.minLength || length > schema.maxLength) return false;
    if (schema.pattern && !new RegExp(schema.pattern, "u").test(value)) return false;
  }
  if (Array.isArray(value)) {
    if (value.length < schema.minItems || value.length > schema.maxItems) return false;
    if (schema.uniqueItems && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) return false;
    if (schema.items && !value.every((item) => matchesJsonSchema(schema.items, item, root))) return false;
  }
  if (!isPlainObject(value)) return true;
  if (schema.required && !schema.required.every((key) => Object.hasOwn(value, key))) return false;
  if (schema.additionalProperties === false && Object.keys(value).some((key) => !Object.hasOwn(schema.properties || {}, key))) return false;
  return Object.entries(schema.properties || {}).every(([key, propertySchema]) => {
    return !Object.hasOwn(value, key) || matchesJsonSchema(propertySchema, value[key], root);
  });
}

function resolveJsonPointer(root, reference) {
  if (!reference.startsWith("#/")) throw new Error("Unsupported JSON Schema reference: " + reference);
  return reference.slice(2).split("/")
    .reduce((value, key) => value[key.replace(/~1/g, "/").replace(/~0/g, "~")], root);
}

function matchesType(type, value) {
  const types = Array.isArray(type) ? type : [type];
  return types.some((candidate) => {
    if (candidate === "array") return Array.isArray(value);
    if (candidate === "object") return isPlainObject(value);
    if (candidate === "integer") return Number.isInteger(value);
    if (candidate === "null") return value === null;
    return typeof value === candidate;
  });
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
