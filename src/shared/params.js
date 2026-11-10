// params.js — validation of workflow parameters / JSON inputs (untrusted).
// Each reader returns the value or throws NodeInputError with a message that
// names the field (safe to return to Workflow Builder as the job error).

// expose: the message is safe to return to Workflow Builder as the job error.
// (Checked by flag, not instanceof — bundlers / test runners may load this
// module more than once.)
class NodeInputError extends Error {
    constructor(message) { super(message); this.name = "NodeInputError"; this.expose = true; }
}

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** @param {any} source @param {string} name @param {{ def?: number, min?: number, max?: number, integer?: boolean }} [opts] */
function readNumber(source, name, { def, min = -Infinity, max = Infinity, integer = false } = {}) {
    const raw = isObject(source) ? source[name] : undefined;
    if (raw === undefined || raw === null || raw === "") {
        if (def === undefined) throw new NodeInputError(`"${name}" is required`);
        return def;
    }
    const n = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) {
        throw new NodeInputError(`"${name}" must be ${integer ? "an integer" : "a number"} between ${min} and ${max}`);
    }
    return n;
}

function readBoolean(source, name, def) {
    const raw = isObject(source) ? source[name] : undefined;
    if (raw === undefined || raw === null || raw === "") return def;
    if (raw === true || raw === "true") return true;
    if (raw === false || raw === "false") return false;
    throw new NodeInputError(`"${name}" must be true or false`);
}

function readEnum(source, name, allowed, def) {
    const raw = isObject(source) ? source[name] : undefined;
    if (raw === undefined || raw === null || raw === "") return def;
    if (!allowed.includes(raw)) throw new NodeInputError(`"${name}" must be one of: ${allowed.join(", ")}`);
    return raw;
}

/** @param {any} source @param {string} name @param {{ def?: string, maxLength?: number }} [opts] */
function readString(source, name, { def, maxLength = 1024 } = {}) {
    const raw = isObject(source) ? source[name] : undefined;
    if (raw === undefined || raw === null) return def;
    if (typeof raw !== "string" || raw.length > maxLength) throw new NodeInputError(`"${name}" must be text of at most ${maxLength} characters`);
    return raw;
}

// [top, left, bottom, right] with finite numbers, bottom > top, right > left.
function readBounds(value, name) {
    if (!Array.isArray(value) || value.length !== 4 || !value.every((n) => typeof n === "number" && Number.isFinite(n))) {
        throw new NodeInputError(`"${name}" must be [top, left, bottom, right] numbers`);
    }
    if (!(value[2] > value[0]) || !(value[3] > value[1])) throw new NodeInputError(`"${name}" must have bottom > top and right > left`);
    return value;
}

module.exports = { NodeInputError, isObject, readNumber, readBoolean, readEnum, readString, readBounds };
