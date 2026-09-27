// String helpers. Imported automatically when a program uses one of them
// (see resolveImports in Typescript/Main.ts); `import string;` also works.

// true for a space, tab, newline or carriage return
function str_is_space(char c): bool {
    return c == ' ' || c == '\t' || c == '\n' || c == '\r';
}

// s without spaces, tabs and newlines at either end
function str_trim(string s): string {
    var start = 0;
    var end = len(s);
    while (start < end && str_is_space(s[start])) {
        start++;
    }
    while (end > start && str_is_space(s[end - 1])) {
        end--;
    }
    return s[start..end];
}

// the pieces of s between each occurrence of sep ("a,b,,c" split on "," is "a", "b", "", "c");
// an empty sep gives s as the only piece
function str_split(string s, string sep): string[] {
    var string[] parts = [];
    if (len(sep) == 0) {
        parts.push(s);
        return parts;
    }
    var string rest = s;
    var i = str_find(rest, sep);
    while (i >= 0) {
        parts.push(rest[0..i]);
        rest = rest[i + len(sep)..len(rest)];
        i = str_find(rest, sep);
    }
    parts.push(rest);
    return parts;
}

// the parts with sep between each pair
function str_join(string[] parts, string sep): string {
    var string out = "";
    var i = 0;
    while (i < parts.len()) {
        if (i > 0) {
            out = out + sep;
        }
        out = out + parts[i];
        i++;
    }
    return out;
}

// s with every occurrence of from replaced by to (an empty from changes nothing)
function str_replace(string s, string from, string to): string {
    if (len(from) == 0) {
        return s;
    }
    var string out = "";
    var string rest = s;
    var i = str_find(rest, from);
    while (i >= 0) {
        out = out + rest[0..i] + to;
        rest = rest[i + len(from)..len(rest)];
        i = str_find(rest, from);
    }
    return out + rest;
}

// the number at the start of s: an optional sign, digits, an optional fraction and an optional
// exponent ("-12.5e2" is -1250.0); leading spaces are skipped and parsing stops at anything else
function strtofloat(string s): float {
    var i = 0;
    var n = len(s);
    while (i < n && str_is_space(s[i])) {
        i++;
    }
    var float sign = 1.0;
    if (i < n && (s[i] == '-' || s[i] == '+')) {
        if (s[i] == '-') {
            sign = -1.0;
        }
        i++;
    }
    var float value = 0.0;
    while (i < n && s[i] >= '0' && s[i] <= '9') {
        value = value * 10.0 + (s[i] - '0');
        i++;
    }
    if (i < n && s[i] == '.') {
        i++;
        var float scale = 0.1;
        while (i < n && s[i] >= '0' && s[i] <= '9') {
            value = value + (s[i] - '0') * scale;
            scale = scale / 10.0;
            i++;
        }
    }
    if (i < n && (s[i] == 'e' || s[i] == 'E')) {
        i++;
        var expSign = 1;
        if (i < n && (s[i] == '-' || s[i] == '+')) {
            if (s[i] == '-') {
                expSign = -1;
            }
            i++;
        }
        var exp = 0;
        while (i < n && s[i] >= '0' && s[i] <= '9') {
            exp = exp * 10 + (s[i] - '0');
            i++;
        }
        while (exp > 0) {
            if (expSign > 0) {
                value = value * 10.0;
            } else {
                value = value / 10.0;
            }
            exp--;
        }
    }
    return sign * value;
}
