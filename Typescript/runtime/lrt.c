// L runtime: growable arrays and maps. Compiled by Main.ts (gcc -c) and linked into every program.
//
// An array is a header {len, cap, data}; the header never moves, so everything pointing at an
// array stays valid when it grows. Elements are 8-byte slots (ints, float bits, or pointers).
// A map is a hash table with open addressing; keys are 8-byte values (ints, chars, or string
// pointers when is_string) and values are 8-byte slots.

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef void (*free_fn)(void *);

static void lrt_fail(const char *msg) {
    fflush(NULL);
    fputs(msg, stderr);
    exit(1);
}

// ── Arrays ──

typedef struct {
    int64_t len;
    int64_t cap;
    int64_t *data;
} LArr;

LArr *lrt_arr_new(int64_t n) {
    if (n < 0) lrt_fail("Error: negative array size\n");
    LArr *a = calloc(1, sizeof *a);
    a->len = n;
    a->cap = n < 4 ? 4 : n;
    a->data = calloc((size_t)a->cap, 8);
    return a;
}

static void arr_reserve(LArr *a, int64_t need) {
    if (need <= a->cap) return;
    int64_t cap = a->cap * 2;
    if (cap < need) cap = need;
    a->data = realloc(a->data, (size_t)cap * 8);
    memset(a->data + a->cap, 0, (size_t)(cap - a->cap) * 8);
    a->cap = cap;
}

void lrt_arr_push(LArr *a, int64_t v) {
    arr_reserve(a, a->len + 1);
    a->data[a->len++] = v;
}

// the last element, now owned by the caller
int64_t lrt_arr_pop(LArr *a) {
    if (a->len == 0) lrt_fail("Error: pop from an empty array\n");
    int64_t v = a->data[--a->len];
    a->data[a->len] = 0;
    return v;
}

void lrt_arr_insert(LArr *a, int64_t i, int64_t v) {
    if (i < 0 || i > a->len) lrt_fail("Error: index out of bounds\n");
    arr_reserve(a, a->len + 1);
    memmove(&a->data[i + 1], &a->data[i], (size_t)(a->len - i) * 8);
    a->data[i] = v;
    a->len++;
}

// element i, now owned by the caller
int64_t lrt_arr_remove(LArr *a, int64_t i) {
    if (i < 0 || i >= a->len) lrt_fail("Error: index out of bounds\n");
    int64_t v = a->data[i];
    memmove(&a->data[i], &a->data[i + 1], (size_t)(a->len - i - 1) * 8);
    a->data[--a->len] = 0;
    return v;
}

// frees the array and, when elem_free is given, each element
void lrt_arr_free(LArr *a, free_fn elem_free) {
    if (!a) return;
    if (elem_free) for (int64_t i = 0; i < a->len; i++) elem_free((void *)a->data[i]);
    free(a->data);
    free(a);
}

// ── Maps ──

typedef struct {
    int64_t count;
    int64_t cap;         // a power of two
    int64_t is_string;   // keys are strings (compared by text, copied into the map)
    int64_t *keys;
    int64_t *vals;
    uint8_t *used;       // 0 empty, 1 in use, 2 removed
} LMap;

LMap *lrt_map_new(int64_t is_string) {
    LMap *m = calloc(1, sizeof *m);
    m->cap = 8;
    m->is_string = is_string;
    m->keys = calloc(8, 8);
    m->vals = calloc(8, 8);
    m->used = calloc(8, 1);
    return m;
}

static uint64_t map_hash(LMap *m, int64_t key) {
    uint64_t h = 1469598103934665603ULL;           // FNV-1a
    if (m->is_string) {
        for (const unsigned char *s = (const unsigned char *)key; *s; s++) h = (h ^ *s) * 1099511628211ULL;
    } else {
        uint64_t k = (uint64_t)key;
        for (int i = 0; i < 8; i++) { h = (h ^ (k & 0xff)) * 1099511628211ULL; k >>= 8; }
    }
    return h;
}

static int map_eq(LMap *m, int64_t a, int64_t b) {
    return m->is_string ? strcmp((const char *)a, (const char *)b) == 0 : a == b;
}

// the slot holding `key`, or -1
static int64_t map_find(LMap *m, int64_t key) {
    uint64_t mask = (uint64_t)m->cap - 1;
    for (uint64_t i = map_hash(m, key) & mask, n = 0; n < (uint64_t)m->cap; i = (i + 1) & mask, n++) {
        if (m->used[i] == 0) return -1;
        if (m->used[i] == 1 && map_eq(m, m->keys[i], key)) return (int64_t)i;
    }
    return -1;
}

static void map_put_new(LMap *m, int64_t key, int64_t val) {
    uint64_t mask = (uint64_t)m->cap - 1;
    uint64_t i = map_hash(m, key) & mask;
    while (m->used[i] == 1) i = (i + 1) & mask;
    m->used[i] = 1;
    m->keys[i] = key;
    m->vals[i] = val;
    m->count++;
}

static void map_grow(LMap *m) {
    int64_t old_cap = m->cap;
    int64_t *keys = m->keys, *vals = m->vals;
    uint8_t *used = m->used;
    m->cap *= 2;
    m->count = 0;
    m->keys = calloc((size_t)m->cap, 8);
    m->vals = calloc((size_t)m->cap, 8);
    m->used = calloc((size_t)m->cap, 1);
    for (int64_t i = 0; i < old_cap; i++) if (used[i] == 1) map_put_new(m, keys[i], vals[i]);
    free(keys); free(vals); free(used);
}

// stores val under key; returns the value it replaced (for the caller to free) or 0
int64_t lrt_map_set(LMap *m, int64_t key, int64_t val) {
    int64_t i = map_find(m, key);
    if (i >= 0) {
        int64_t old = m->vals[i];
        m->vals[i] = val;
        return old;
    }
    if ((m->count + 1) * 4 > m->cap * 3) map_grow(m);
    map_put_new(m, m->is_string ? (int64_t)strdup((const char *)key) : key, val);
    return 0;
}

int64_t lrt_map_get(LMap *m, int64_t key) {
    int64_t i = map_find(m, key);
    if (i < 0) lrt_fail("Error: key not found in map\n");
    return m->vals[i];
}

int64_t lrt_map_has(LMap *m, int64_t key) {
    return map_find(m, key) >= 0;
}

// removes key; returns its value (for the caller to free), or 0 if it wasn't there
int64_t lrt_map_remove(LMap *m, int64_t key) {
    int64_t i = map_find(m, key);
    if (i < 0) return 0;
    int64_t val = m->vals[i];
    if (m->is_string) free((void *)m->keys[i]);
    m->used[i] = 2;
    m->count--;
    return val;
}

int64_t lrt_map_len(LMap *m) {
    return m->count;
}

// the keys as a new array (string keys are copied, so the array owns them)
LArr *lrt_map_keys(LMap *m) {
    LArr *a = lrt_arr_new(0);
    for (int64_t i = 0; i < m->cap; i++) {
        if (m->used[i] != 1) continue;
        lrt_arr_push(a, m->is_string ? (int64_t)strdup((const char *)m->keys[i]) : m->keys[i]);
    }
    return a;
}

void lrt_map_free(LMap *m, free_fn val_free) {
    if (!m) return;
    for (int64_t i = 0; i < m->cap; i++) {
        if (m->used[i] != 1) continue;
        if (m->is_string) free((void *)m->keys[i]);
        if (val_free) val_free((void *)m->vals[i]);
    }
    free(m->keys); free(m->vals); free(m->used);
    free(m);
}
