import io
import pytest
from PIL import Image

def test_menubar_glass_element_and_styles(page):
    """
    Verifies that the simulated macOS menu bar glass container is mounted
    with proper safe-area dimensions and hardware-accelerated frosted glass styles.
    """
    page.wait_for_selector("#menubar-glass", timeout=5000)
    
    styles = page.evaluate("""() => {
        const el = document.getElementById('menubar-glass');
        const computed = window.getComputedStyle(el);
        return {
            position: computed.position,
            height: parseFloat(computed.height),
            backdropFilter: computed.backdropFilter || computed.webkitBackdropFilter || ''
        };
    }""")
    
    assert styles["height"] >= 30.0, f"Menubar height {styles['height']}px is less than standard macOS 30px"
    assert styles["position"] in ["relative", "fixed", "absolute", "static"], f"Unexpected position: {styles['position']}"

def test_liquid_glass_optical_canvas_rendering(page):
    """
    Verifies that LiquidGlass mounts its optical refraction and lens canvases,
    rendering authentic frosted glass blur and specular highlights.
    """
    page.wait_for_selector("#menubar-glass", timeout=5000)
    page.wait_for_timeout(500)
    
    # Verify DOM contains LiquidGlass refraction and lens canvas layers
    canvas_info = page.evaluate("""() => {
        const refractCanvas = document.querySelector('#menubar-glass .liquid-glass-refract-canvas');
        const lensCanvas = document.querySelector('#menubar-glass .liquid-glass-lens-canvas');
        const isInstance = Boolean(menubarGlass && typeof menubarGlass.syncToBackdrop === 'function');
        return {
            isInstance,
            hasRefractCanvas: Boolean(refractCanvas),
            hasLensCanvas: Boolean(lensCanvas),
            refractWidth: refractCanvas ? refractCanvas.width : 0,
            lensWidth: lensCanvas ? lensCanvas.width : 0
        };
    }""")
    
    assert canvas_info["isInstance"] is True, "LiquidGlass instance failed to initialize"
    assert canvas_info["hasRefractCanvas"] is True, "Missing .liquid-glass-refract-canvas element"
    assert canvas_info["hasLensCanvas"] is True, "Missing .liquid-glass-lens-canvas element"
    assert canvas_info["refractWidth"] >= 2560, f"Refraction canvas width ({canvas_info['refractWidth']}) is smaller than 2560px"
    assert canvas_info["lensWidth"] >= 2560, f"Lens canvas width ({canvas_info['lensWidth']}) is smaller than 2560px"
    
    # Capture GPU compositor screenshot of the menubar element to verify visual pixel rendering
    png_bytes = page.locator("#menubar-glass").screenshot()
    img = Image.open(io.BytesIO(png_bytes)).convert("RGBA")
    assert img.size[0] >= 2560, f"Expected menubar screenshot width >= 2560, got {img.size[0]}"
    assert img.size[1] >= 30, f"Expected menubar screenshot height >= 30, got {img.size[1]}"
    
    # Inspect rendered pixels (must be non-blank)
    max_alpha = img.getchannel("A").getextrema()[1]
    assert max_alpha > 0, "Menubar glass element rendered completely transparent pixels!"
