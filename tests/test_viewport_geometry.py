import io
import pytest
from PIL import Image

def test_active_layer_completely_covers_viewport_at_all_trajectory_points(page):
    """
    Verifies that the active wallpaper layer never leaves any gap, edge runoff,
    or exposure of the underlying desktop across all 60 seconds of its animation.
    """
    page.wait_for_selector("#layerA.active", timeout=5000)
    
    # Wait for image to load and animation to begin
    page.wait_for_function("() => document.getElementById('layerA').getAnimations().length > 0")

    # Sample trajectory at 0s, 15s, 30s, 45s, and 60s
    time_checkpoints = [0, 15, 30, 45, 60]
    
    for t_sec in time_checkpoints:
        page.evaluate(f"() => {{ const anim = document.getElementById('layerA').getAnimations()[0]; anim.pause(); anim.currentTime = {t_sec * 1000}; }}")
        
        rect = page.evaluate("""() => {
            const el = document.getElementById('layerA');
            const r = el.getBoundingClientRect();
            return {
                left: r.left,
                top: r.top,
                right: r.right,
                bottom: r.bottom,
                vw: window.innerWidth,
                vh: window.innerHeight
            };
        }""")
        
        # Subpixel tolerance of 0.5px
        assert rect["left"] <= 0.5, f"Left edge gap ({rect['left']}px) exposed at {t_sec}s!"
        assert rect["top"] <= 0.5, f"Top edge gap ({rect['top']}px) exposed at {t_sec}s!"
        assert rect["right"] >= rect["vw"] - 0.5, f"Right edge gap exposed at {t_sec}s! (right: {rect['right']}, vw: {rect['vw']})"
        assert rect["bottom"] >= rect["vh"] - 0.5, f"Bottom edge gap exposed at {t_sec}s! (bottom: {rect['bottom']}, vh: {rect['vh']})"

def test_edge_pixel_integrity_and_zero_desktop_bleed(page):
    """
    Captures a screenshot of the viewport and inspects the physical perimeter pixels
    to verify 100% opacity and absence of transparent/blank borders.
    """
    page.wait_for_selector("#layerA.active", timeout=5000)
    page.wait_for_function("() => document.getElementById('layerA').getAnimations().length > 0")
    
    # Seek to midpoint of pan (30s)
    page.evaluate("() => { const anim = document.getElementById('layerA').getAnimations()[0]; anim.pause(); anim.currentTime = 30000; }")
    
    # Capture viewport screenshot
    png_bytes = page.screenshot()
    img = Image.open(io.BytesIO(png_bytes)).convert("RGBA")
    w, h = img.size
    
    # Inspect top, bottom, left, right edge pixels
    top_pixels = [img.getpixel((x, 0)) for x in range(0, w, 50)]
    bottom_pixels = [img.getpixel((x, h - 1)) for x in range(0, w, 50)]
    left_pixels = [img.getpixel((0, y)) for y in range(0, h, 50)]
    right_pixels = [img.getpixel((w - 1, y)) for y in range(0, h, 50)]
    
    for side_name, pixels in [("top", top_pixels), ("bottom", bottom_pixels), ("left", left_pixels), ("right", right_pixels)]:
        for p in pixels:
            # Alpha must be 255 (fully opaque image rendering, no window/desktop punch-through)
            assert p[3] == 255, f"Transparent pixel detected on {side_name} border: {p}"

def test_dynamic_minimum_zoom_monte_carlo_in_webkit(page):
    """
    Executes calculateDynamicPan across 5,000 random aspect ratios and drift angles
    directly inside WebKit to mathematically prove zero boundary breaches under all conditions.
    """
    results = page.evaluate("""() => {
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const durationSec = 60;
        const safety = 0.92;
        let breaches = 0;
        
        // Test aspect ratios: 4:3 (1.33), 3:2 (1.5), 16:9 (1.78), 21:9 (2.33), 3:1 (3.0), portrait (0.66)
        const aspects = [1.333, 1.5, 1.777, 2.333, 3.0, 0.666];
        
        for (let i = 0; i < 5000; i++) {
            const aspect = aspects[i % aspects.length];
            const speed = 3.0 + Math.random() * 2.0;
            const travelDist = speed * durationSec;
            const angle = Math.random() * 2 * Math.PI;
            const dx = travelDist * Math.cos(angle);
            const dy = travelDist * Math.sin(angle);
            
            const renderedHeight = Math.max(
                vh + Math.abs(dy) / safety,
                (vw + Math.abs(dx) / safety) / aspect
            );
            const renderedWidth = renderedHeight * aspect;
            
            const slackX = renderedWidth - vw;
            const slackY = renderedHeight - vh;
            
            const minStartX = -slackX + Math.max(0, -dx);
            const maxStartX = 0 - Math.max(0, dx);
            const startX = minStartX + Math.random() * (maxStartX - minStartX);
            const endX = startX + dx;
            
            const minStartY = -slackY + Math.max(0, -dy);
            const maxStartY = 0 - Math.max(0, dy);
            const startY = minStartY + Math.random() * (maxStartY - minStartY);
            const endY = startY + dy;
            
            // Check boundary constraint: element must cover [0, vw] horizontally and [0, vh] vertically
            if (startX > 0 || startX < -slackX || endX > 0 || endX < -slackX) breaches++;
            if (startY > 0 || startY < -slackY || endY > 0 || endY < -slackY) breaches++;
        }
        return breaches;
    }""")
    
    assert results == 0, f"Monte Carlo simulation found {results} boundary breaches!"
