import graphics;

function main() {
    gfx_init(800, 600);

    var int frame = 0;
    while (!gfx_closed()) {
        gfx_clear(0x000000);

        // Moving red rectangle
        var int x = frame % 760;
        gfx_rect(x, 260, 40, 80, 0xFF0000);

        // Static blue border
        gfx_rect_border(10, 10, 200, 150, 0x0088FF);

        // Diagonal line
        gfx_line(0, 0, 799, 599, 0x00FF00);

        gfx_present();
        frame++;
    }

    gfx_destroy_window();
}
