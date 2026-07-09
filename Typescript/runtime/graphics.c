#include <GLFW/glfw3.h>
#include <stdio.h>
#include <math.h>

static GLFWwindow *window = NULL;
static int win_w = 0, win_h = 0;

int gfx_window_init(int width, int height, const char *title)
{
    if (!glfwInit()) return 0;
    glfwWindowHint(GLFW_RESIZABLE, GLFW_FALSE);
    window = glfwCreateWindow(width, height, title, NULL, NULL);
    if (!window) return 0;
    glfwMakeContextCurrent(window);
    glfwSwapInterval(1);

    /* framebuffer size differs from window size on HiDPI displays */
    int fb_w, fb_h;
    glfwGetFramebufferSize(window, &fb_w, &fb_h);
    win_w = fb_w; win_h = fb_h;

    glViewport(0, 0, fb_w, fb_h);
    glMatrixMode(GL_PROJECTION);
    glLoadIdentity();
    glOrtho(0, width, height, 0, -1, 1);
    glMatrixMode(GL_MODELVIEW);
    glLoadIdentity();
    glDisable(GL_DEPTH_TEST);
    return 1;
}

int gfx_should_close()
{
    return window ? glfwWindowShouldClose(window) : 1;
}

void gfx_swap()
{
    if (!window) return;
    glfwSwapBuffers(window);
    glfwPollEvents();
}

void gfx_destroy()
{
    if (window) { glfwDestroyWindow(window); window = NULL; }
    glfwTerminate();
}

double gfx_time()   { return glfwGetTime(); }

int gfx_key_down(int key)
{
    return window ? glfwGetKey(window, key) == GLFW_PRESS : 0;
}

void gfx_log(const char *msg) { printf("[gfx] %s\n", msg); }

static void set_color(int color)
{
    float r = ((color >> 16) & 0xFF) / 255.0f;
    float g = ((color >>  8) & 0xFF) / 255.0f;
    float b = ( color        & 0xFF) / 255.0f;
    glColor3f(r, g, b);
}

void gfx_c_clear(int color)
{
    float r = ((color >> 16) & 0xFF) / 255.0f;
    float g = ((color >>  8) & 0xFF) / 255.0f;
    float b = ( color        & 0xFF) / 255.0f;
    glClearColor(r, g, b, 1.0f);
    glClear(GL_COLOR_BUFFER_BIT);
}

void gfx_c_set_pixel(int x, int y, int color)
{
    set_color(color);
    glBegin(GL_POINTS);
        glVertex2f(x + 0.5f, y + 0.5f);
    glEnd();
}

void gfx_c_hline(int x, int y, int len, int color)
{
    set_color(color);
    glBegin(GL_QUADS);
        glVertex2f(x,       y);     glVertex2f(x + len, y);
        glVertex2f(x + len, y + 1); glVertex2f(x,       y + 1);
    glEnd();
}

void gfx_c_vline(int x, int y, int len, int color)
{
    set_color(color);
    glBegin(GL_QUADS);
        glVertex2f(x,     y);       glVertex2f(x + 1, y);
        glVertex2f(x + 1, y + len); glVertex2f(x,     y + len);
    glEnd();
}

void gfx_c_line(int x0, int y0, int x1, int y1, int color)
{
    set_color(color);
    glBegin(GL_LINES);
        glVertex2f(x0 + 0.5f, y0 + 0.5f);
        glVertex2f(x1 + 0.5f, y1 + 0.5f);
    glEnd();
}

void gfx_c_rect(int x, int y, int w, int h, int color)
{
    set_color(color);
    glBegin(GL_QUADS);
        glVertex2f(x,     y);
        glVertex2f(x + w, y);
        glVertex2f(x + w, y + h);
        glVertex2f(x,     y + h);
    glEnd();
}

void gfx_c_rect_border(int x, int y, int w, int h, int color)
{
    set_color(color);
    glBegin(GL_QUADS);
        /* top */
        glVertex2f(x,     y);     glVertex2f(x + w, y);
        glVertex2f(x + w, y + 1); glVertex2f(x,     y + 1);
        /* bottom */
        glVertex2f(x,     y + h - 1); glVertex2f(x + w, y + h - 1);
        glVertex2f(x + w, y + h);     glVertex2f(x,     y + h);
        /* left */
        glVertex2f(x,     y);     glVertex2f(x + 1, y);
        glVertex2f(x + 1, y + h); glVertex2f(x,     y + h);
        /* right */
        glVertex2f(x + w - 1, y);     glVertex2f(x + w, y);
        glVertex2f(x + w,     y + h); glVertex2f(x + w - 1, y + h);
    glEnd();
}
