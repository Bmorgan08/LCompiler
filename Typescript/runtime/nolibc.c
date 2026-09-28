#include <stdarg.h>
#include <stddef.h>

static long syscall3(long n, long a, long b, long c)
{
    long ret;
    __asm__ volatile("syscall"
                     : "=a"(ret)
                     : "a"(n), "D"(a), "S"(b), "d"(c)
                     : "rcx", "r11", "memory");
    return ret;
};

static long syscall6(long n, long a, long b, long c, long d, long e, long f)
{
    register long r10 __asm__("r10") = d;
    register long r8 __asm__("r8") = e;
    register long r9 __asm__("r9") = f;
    long ret;
    __asm__ volatile("syscall"
                     : "=a"(ret)
                     : "a"(n), "D"(a), "S"(b), "d"(c), "r"(r10), "r"(r8), "r"(r9)
                     : "rcx", "r11", "memory");
    return ret;
};

int main(void);
void exit(int code);

#ifdef L_KERNEL
// ── Kernel mode (built with -DL_KERNEL for `--kernel`) ──
// There is no OS to make system calls to: the kernel written in L provides these hooks instead.
// Each has a weak default here, so a kernel that leaves some out still links.
typedef unsigned long u64;
size_t strlen(const char *s);

__attribute__((noreturn)) static void halt_forever(void)
{
    for (;;)
        __asm__ volatile("cli; hlt");
}

__attribute__((weak)) void kernel_write(const char *text, u64 len) { (void)text; (void)len; }
__attribute__((weak)) void kernel_panic(const char *msg, u64 len) { (void)msg; (void)len; }
__attribute__((weak)) u64 kernel_read(char *buf, u64 max) { (void)buf; (void)max; return 0; }
__attribute__((weak)) u64 kernel_alloc_pages(u64 count)
{
    static const char msg[] = "L runtime: out of memory (the kernel has no kernel_alloc_pages)";
    (void)count;
    kernel_panic(msg, sizeof msg - 1);
    halt_forever();
}

// stops the kernel with a message: kernel_panic gets it, and if kernel_panic returns the CPU halts
__attribute__((noreturn)) static void kernel_stop(const char *msg, u64 len);
#else
__attribute__((naked, noreturn)) void _start(void)
{
    __asm__ volatile(
        "xor %ebp, %ebp\n"
        "and $-16, %rsp\n"
        "call main\n"
        "mov %eax, %edi\n"
        "call exit\n");
};
#endif

static char outbuf[4096];
static size_t outlen;

static void write_all(int fd, const char *p, size_t n)
{
#ifdef L_KERNEL
    (void)fd;
    if (n > 0)
        kernel_write(p, n);
    return;
#endif
    while (n > 0)
    {
        long w = syscall3(1, fd, (long)p, (long)n);
        if (w <= 0)
            return;
        p += w;
        n -= (size_t)w;
    }
}

static void flush_stdout(void)
{
    write_all(1, outbuf, outlen);
    outlen = 0;
}

static void out_char(char c)
{
    if (outlen == sizeof outbuf)
        flush_stdout();
    outbuf[outlen++] = c;
}

void exit(int code)
{
    flush_stdout();
#ifdef L_KERNEL
    // nothing to exit to: something that would end a program stops the kernel
    (void)code;
    static const char msg[] = "L runtime: exit() called";
    kernel_stop(msg, sizeof msg - 1);
#else
    syscall3(231, code, 0, 0);
    __builtin_unreachable();
#endif
}

static char stdin_tag, stderr_tag;
void *stdin = &stdin_tag;
void *stderr = &stderr_tag;

void *memmove(void *dst, const void *src, size_t n)
{
    unsigned char *d = dst;
    const unsigned char *s = src;
    if (d < s)
    {
        for (size_t i = 0; i < n; i++)
            d[i] = s[i];
    }
    else
    {
        for (size_t i = n; i > 0; i--)
            d[i - 1] = s[i - 1];
    }
    return dst;
}

size_t strcspn(const char *s, const char *reject)
{
    size_t i = 0;
    for (; s[i]; i++)
    {
        for (const char *r = reject; *r; r++)
            if (s[i] == *r)
                return i;
    }
    return i;
}

void *memcpy(void *dst, const void *src, size_t n)
{
    unsigned char *d = dst;
    const unsigned char *s = src;
    for (size_t i = 0; i < n; i++)
        d[i] = s[i];
    return dst;
}

void *memset(void *dst, int c, size_t n)
{
    unsigned char *d = dst;
    for (size_t i = 0; i < n; i++)
        d[i] = (unsigned char)c;
    return dst;
}

size_t strlen(const char *s)
{
    size_t n = 0;
    while (s[n])
        n++;
    return n;
}

char *strcpy(char *dst, const char *src)
{
    char *d = dst;
    while ((*d++ = *src++))
    {
    }
    return dst;
}

char *strcat(char *dst, const char *src)
{
    strcpy(dst + strlen(dst), src);
    return dst;
}

int strcmp(const char *a, const char *b)
{
    while (*a && *a == *b)
    {
        a++;
        b++;
    }
    return (unsigned char)*a - (unsigned char)*b;
}

char *strstr(const char *hay, const char *needle)
{
    if (!*needle)
        return (char *)hay;
    for (; *hay; hay++)
    {
        const char *h = hay, *n = needle;
        while (*n && *h == *n)
        {
            h++;
            n++;
        }
        if (!*n)
            return (char *)hay;
    }
    return NULL;
}

typedef struct Block
{
    size_t size;
    struct Block *next;
} Block;

static Block *free_list;
static char *arena;
static size_t arena_left;

static void *os_alloc(size_t n)
{
#ifdef L_KERNEL
    return (void *)kernel_alloc_pages((n + 4095) / 4096);
#endif
    long p = syscall6(9, 0, (long)n, 3, 0x22, -1, 0);
    return (p < 0 && p > -4096) ? NULL : (void *)p;
}

void *malloc(size_t n)
{
    n = (n + 15) & ~(size_t)15;
    if (n == 0)
        n = 16;

    for (Block **pp = &free_list; *pp; pp = &(*pp)->next)
    {
        Block *b = *pp;
        if (b->size >= n)
        {
            *pp = b->next;
            return b + 1;
        }
    }

    size_t need = sizeof(Block) + n;
    if (need > arena_left)
    {
        size_t get = need > (1 << 20) ? (need + 4095) & ~(size_t)4095 : (1 << 20);
        arena = os_alloc(get);
        if (!arena)
            return NULL;
        arena_left = get;
    }
    Block *b = (Block *)arena;
    arena += need;
    arena_left -= need;
    b->size = n;
    return b + 1;
}

void free(void *p)
{
    if (!p)
        return;
    Block *b = (Block *)p - 1;
    b->next = free_list;
    free_list = b;
}

void *calloc(size_t count, size_t size)
{
    if (size && count > (size_t)-1 / size)
        return NULL;
    size_t n = count * size;
    void *p = malloc(n);
    if (p)
        memset(p, 0, n);
    return p;
}

void *realloc(void *p, size_t n)
{
    if (!p)
        return malloc(n);
    Block *b = (Block *)p - 1;
    if (n <= b->size)
        return p;
    void *q = malloc(n);
    if (!q)
        return NULL;
    memcpy(q, p, b->size);
    free(p);
    return q;
}

char *strdup(const char *s)
{
    size_t n = strlen(s) + 1;
    char *p = malloc(n);
    if (p)
        memcpy(p, s, n);
    return p;
}

int fflush(void *stream)
{
    (void)stream;
    flush_stdout();
    return 0;
}

int fputs(const char *s, void *stream)
{
    if (stream == stderr)
    {
        flush_stdout();
#ifdef L_KERNEL
        kernel_stop(s, strlen(s));   // only runtime errors are written to stderr
#endif
        write_all(2, s, strlen(s));
    }
    else
    {
        while (*s)
            out_char(*s++);
    }
    return 0;
}

static char *fmt_long(long v, char *end)
{
    unsigned long u = v < 0 ? -(unsigned long)v : (unsigned long)v;
    char *p = end;
    do
    {
        *--p = (char)('0' + u % 10);
        u /= 10;
    } while (u);
    if (v < 0)
        *--p = '-';
    return p;
}

static double pow10i(int n)
{
    double p = 1;
    int k = n < 0 ? -n : n;
    while (k--)
        p *= 10;
    return n < 0 ? 1 / p : p;
}

static long six_digits(double x, int *exp)
{
    int e = 0;
    while (x >= pow10i(e + 1))
        e++;
    while (x < pow10i(e))
        e--;
    double scaled = e >= 5 ? x / pow10i(e - 5) : x * pow10i(5 - e);
    long d = (long)(scaled + 0.5);
    if (d >= 1000000)
    {
        d /= 10;
        e++;
    }
    *exp = e;
    return d;
}

typedef void (*emit_fn)(void *ctx, char c);

static void emit_str(emit_fn emit, void *ctx, const char *s)
{
    while (*s)
        emit(ctx, *s++);
}

static void fmt_g(emit_fn emit, void *ctx, double x)
{
    if (__builtin_signbit(x))
    {
        emit(ctx, '-');
        x = -x;
    }
    if (__builtin_isnan(x))
    {
        emit_str(emit, ctx, "nan");
        return;
    }
    if (__builtin_isinf(x))
    {
        emit_str(emit, ctx, "inf");
        return;
    }
    if (x == 0)
    {
        emit(ctx, '0');
        return;
    }

    int e;
    long d = six_digits(x, &e);
    char digits[6];
    for (int i = 5; i >= 0; i--)
    {
        digits[i] = (char)('0' + d % 10);
        d /= 10;
    }
    int n = 6;
    while (n > 1 && digits[n - 1] == '0')
        n--;

    if (e < -4 || e >= 6)
    {

        emit(ctx, digits[0]);
        if (n > 1)
        {
            emit(ctx, '.');
            for (int i = 1; i < n; i++)
                emit(ctx, digits[i]);
        }
        emit(ctx, 'e');
        emit(ctx, e < 0 ? '-' : '+');
        int ae = e < 0 ? -e : e;
        if (ae < 10)
            emit(ctx, '0');
        char tmp[8];
        tmp[7] = 0;
        emit_str(emit, ctx, fmt_long(ae, tmp + 7));
    }
    else if (e < 0)
    {

        emit(ctx, '0');
        emit(ctx, '.');
        for (int i = -1; i > e; i--)
            emit(ctx, '0');
        for (int i = 0; i < n; i++)
            emit(ctx, digits[i]);
    }
    else
    {

        for (int i = 0; i <= e; i++)
            emit(ctx, i < n ? digits[i] : '0');
        if (n > e + 1)
        {
            emit(ctx, '.');
            for (int i = e + 1; i < n; i++)
                emit(ctx, digits[i]);
        }
    }
}

static void format(emit_fn emit, void *ctx, const char *f, va_list ap)
{
    char tmp[32];
    tmp[31] = 0;
    for (; *f; f++)
    {
        if (*f != '%')
        {
            emit(ctx, *f);
            continue;
        }
        f++;
        if (*f == 'l')
            f++;
        switch (*f)
        {
        case 'd':
            emit_str(emit, ctx, fmt_long(va_arg(ap, long), tmp + 31));
            break;
        case 's':
            emit_str(emit, ctx, va_arg(ap, const char *));
            break;
        case 'c':
            emit(ctx, (char)va_arg(ap, int));
            break;
        case 'g':
            fmt_g(emit, ctx, va_arg(ap, double));
            break;
        case '%':
            emit(ctx, '%');
            break;
        }
    }
}

static void emit_stdout(void *ctx, char c)
{
    (void)ctx;
    out_char(c);
}

int printf(const char *f, ...)
{
    va_list ap;
    va_start(ap, f);
    format(emit_stdout, NULL, f, ap);
    va_end(ap);
#ifdef L_KERNEL
    flush_stdout();   // each print() reaches kernel_write straight away
#endif
    return 0;
}

static void emit_buf(void *ctx, char c)
{
    char **p = ctx;
    *(*p)++ = c;
}

int sprintf(char *buf, const char *f, ...)
{
    char *p = buf;
    va_list ap;
    va_start(ap, f);
    format(emit_buf, &p, f, ap);
    va_end(ap);
    *p = 0;
    return (int)(p - buf);
}

static char inbuf[4096];
static size_t inpos, inlen;

static int in_getc(void)
{
    if (inpos == inlen)
    {
        flush_stdout();
#ifdef L_KERNEL
        long r = (long)kernel_read(inbuf, sizeof inbuf);
#else
        long r = syscall3(0, 0, (long)inbuf, sizeof inbuf);
#endif
        if (r <= 0)
            return -1;
        inpos = 0;
        inlen = (size_t)r;
    }
    return (unsigned char)inbuf[inpos++];
}

static void in_ungetc(void) { inpos--; }

static int is_space(int c)
{
    return c == ' ' || (c >= '\t' && c <= '\r');
}

int scanf(const char *f, ...)
{
    (void)f;
    va_list ap;
    va_start(ap, f);
    long *out = va_arg(ap, long *);
    va_end(ap);

    int c;
    do
        c = in_getc();
    while (is_space(c));
    if (c < 0)
        return -1;

    int neg = 0;
    if (c == '-' || c == '+')
    {
        neg = c == '-';
        c = in_getc();
    }
    if (c < '0' || c > '9')
    {
        if (c >= 0)
            in_ungetc();
        return 0;
    }
    unsigned long v = 0;
    while (c >= '0' && c <= '9')
    {
        v = v * 10 + (unsigned long)(c - '0');
        c = in_getc();
    }
    if (c >= 0)
        in_ungetc();
    *out = (long)(neg ? 0 - v : v);
    return 1;
}

char *fgets(char *buf, int size, void *stream)
{
    (void)stream;
    int n = 0;
    while (n < size - 1)
    {
        int c = in_getc();
        if (c < 0)
            break;
        buf[n++] = (char)c;
        if (c == '\n')
            break;
    }
    if (n == 0)
        return NULL;
    buf[n] = 0;
    return buf;
}

long atoi(const char *s)
{
    while (is_space(*s))
        s++;
    int neg = 0;
    if (*s == '-' || *s == '+')
        neg = *s++ == '-';
    unsigned long v = 0;
    while (*s >= '0' && *s <= '9')
        v = v * 10 + (unsigned long)(*s++ - '0');
    return (long)(neg ? 0 - v : v);
}

#ifdef L_KERNEL
static void kernel_stop(const char *msg, u64 len)
{
    flush_stdout();
    kernel_panic(msg, len);
    halt_forever();
}

// a runtime error in compiled code (index out of bounds, division by zero, a field never set)
__attribute__((noreturn)) void lrt_kernel_fail(const char *msg, u64 len)
{
    kernel_stop(msg, len);
}
#endif
