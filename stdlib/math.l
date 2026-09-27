function math_abs(int x) {
    if (x < 0) { return -x; }
    return x;
}

function math_max(int a, int b) {
    if (a > b) { return a; }
    return b;
}

function math_min(int a, int b) {
    if (a < b) { return a; }
    return b;
}

function math_toint(float x) {
    var int i = x;
    return i;
}

function math_tofloat(int x) {
    var float y = x;
    return y;
}

function math_floor(float x) {
    var int i = math_toint(x);
    if (x >= 0.0) {
        return i;
    }
    var float reconstructed = math_tofloat(i);
    var float diff = x - reconstructed;
    if (diff < 0.0) {
        return i - 1;
    }
    return i;
}

function math_round(float x) {
    var int truncated = math_toint(x);
    var float base = math_tofloat(truncated);
    var float frac = x - base;
    if (frac >= 0.5) {
        return math_roof(x);
    }
    return math_floor(x);
}

function math_roof(float x) {
    var int i = math_toint(x);
    var float f = math_tofloat(i);
    if (f == x) {
        return i;
    }
    if (x >= 0.0) {
        return i + 1;
    }
    return i;
}

function math_fmod(float input, float step) {
    var int quotient = math_toint(input / step);
    var float fquotient = math_tofloat(quotient);
    var float answer = input - step * fquotient;
    return answer;
}

function math_sin_raw(float r) {
    var float x2 = r * r;
    var float x3 = x2 * r;
    var float x5 = x3 * x2;
    var float x7 = x5 * x2;
    var float x9 = x7 * x2;
    var float x11 = x9 * x2;
    return r - x3 * 0.1666666667 + x5 * 0.0083333333 - x7 * 0.0001984127 + x9 * 0.0000027557 - x11 * 0.0000000251;
}

function math_cos_raw(float r) {
    var float x2 = r * r;
    var float x4 = x2 * x2;
    var float x6 = x4 * x2;
    var float x8 = x6 * x2;
    var float x10 = x8 * x2;
    var float x12 = x10 * x2;
    return 1.0 - x2 * 0.5 + x4 * 0.0416666667 - x6 * 0.0013888889 + x8 * 0.0000248016 - x10 * 0.0000002756 + x12 * 0.0000000021;
}

function math_sin(float x) {
    var float tau = 6.2831853072;
    var float pi = 3.1415926536;
    var float halfpi = 1.5707963268;
    var float r = math_fmod(x, tau);
    if (r > pi) { r = r - tau; }
    if (r < -3.1415926536) { r = r + tau; }
    if (r > halfpi) { return math_sin_raw(pi - r); }
    if (r < -1.5707963268) { return -1.0 * math_sin_raw(pi + r); }
    return math_sin_raw(r);
}

function math_cos(float x) {
    var float tau = 6.2831853072;
    var float pi = 3.1415926536;
    var float halfpi = 1.5707963268;
    var float r = math_fmod(x, tau);
    if (r > pi) { r = r - tau; }
    if (r < -3.1415926536) { r = r + tau; }
    if (r > halfpi) { return -1.0 * math_cos_raw(pi - r); }
    if (r < -1.5707963268) { return -1.0 * math_cos_raw(pi + r); }
    return math_cos_raw(r);
}

function math_tan(float x) {
    var float c = math_cos(x);
    var float s = math_sin(x);
    return s / c;
}

function math_sqrt(float x) {
    if (x <= 0.0) { return 0.0; }
    // bring x into [1, 4) so the iterations start near the root:
    // sqrt(x * 4^k) = sqrt(x) * 2^k, and scaling by 4 is exact
    var float scale = 1.0;
    var int k = 0;
    while (x >= 4.0 && k < 1100) {
        x = x / 4.0;
        scale = scale * 2.0;
        k++;
    }
    while (x < 1.0 && k < 1100) {
        x = x * 4.0;
        scale = scale / 2.0;
        k++;
    }
    var float guess = x / 2.0;
    var int i = 0;
    while (i < 20) {
        guess = (guess + x / guess) / 2.0;
        i++;
    }
    return guess * scale;
}

function math_ln(float x) {
    if (x <= 0.0) { return 0.0; }
    var int n = 0;
    while (x >= 2.0) {
        x = x / 2.0;
        n++;
    }
    while (x < 1.0) {
        x = x * 2.0;
        n--;
    }
    var float u = (x - 1.0) / (x + 1.0);
    var float u2 = u * u;
    var float u3 = u2 * u;
    var float u5 = u3 * u2;
    var float u7 = u5 * u2;
    var float u9 = u7 * u2;
    var float u11 = u9 * u2;
    var float u13 = u11 * u2;
    var float u15 = u13 * u2;
    var float series = 2.0 * (u + u3/3.0 + u5/5.0 + u7/7.0 + u9/9.0 + u11/11.0 + u13/13.0 + u15/15.0);
    var float nf = math_tofloat(n);
    return series + nf * 0.6931471806;
} 

function math_pow(float base, float exp) {
    // a whole-number exponent is multiplied out (exact, and works for base <= 0)
    var int n = math_toint(exp);
    if (math_tofloat(n) == exp) {
        var float result = 1.0;
        var float b = base;
        var int k = math_abs(n);
        while (k > 0) {
            if (k % 2 == 1) { result = result * b; }
            b = b * b;
            k = k / 2;
        }
        if (n < 0) { return 1.0 / result; }
        return result;
    }
    return math_exp(exp * math_ln(base));
}

function math_exp(float t) {
    // e^t = e^whole * e^frac with frac in [0, 1), where the series converges quickly
    var int whole = math_floor(t);
    var float frac = t - math_tofloat(whole);
    var float term = 1.0;
    var float sum = 1.0;
    var int i = 1;
    while (i < 18) {
        term = term * frac / math_tofloat(i);
        sum = sum + term;
        i++;
    }
    var float scale = 1.0;
    var float e = 2.718281828459045;
    var int k = math_abs(whole);
    while (k > 0) {
        if (k % 2 == 1) { scale = scale * e; }
        e = e * e;
        k = k / 2;
    }
    if (whole < 0) { return sum / scale; }
    return sum * scale;
}



