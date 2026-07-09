var int WIDTH  = 800;
var int HEIGHT = 600;

var int KEY_SPACE  = 32;
var int KEY_A      = 65;
var int KEY_D      = 68;
var int KEY_S      = 83;
var int KEY_W      = 87;
var int KEY_ESCAPE = 256;
var int KEY_ENTER  = 257;
var int KEY_RIGHT  = 262;
var int KEY_LEFT   = 263;
var int KEY_DOWN   = 264;
var int KEY_UP     = 265;
var int KEY_SHIFT  = 340;

function gfx_init(int w, int h) {
    WIDTH  = w;
    HEIGHT = h;
    gfx_window_init(w, h, "L Graphics");
}

function gfx_clear(int color) {
    gfx_c_clear(color);
}

function gfx_set_pixel(int x, int y, int color) {
    gfx_c_set_pixel(x, y, color);
}

function gfx_hline(int x, int y, int len, int color) {
    gfx_c_hline(x, y, len, color);
}

function gfx_vline(int x, int y, int len, int color) {
    gfx_c_vline(x, y, len, color);
}

function gfx_line(int x0, int y0, int x1, int y1, int color) {
    gfx_c_line(x0, y0, x1, y1, color);
}

function gfx_rect(int x, int y, int w, int h, int color) {
    gfx_c_rect(x, y, w, h, color);
}

function gfx_rect_border(int x, int y, int w, int h, int color) {
    gfx_c_rect_border(x, y, w, h, color);
}

function gfx_present() {
    gfx_swap();
}

function gfx_closed() {
    return gfx_should_close();
}

function gfx_key(int key) {
    return gfx_key_down(key);
}

function gfx_get_time() {
    return gfx_time();
}

function gfx_destroy_window() {
    gfx_destroy();
}
