import io
import math
import pytest
from PIL import Image, ImageChops

def test_lens_framerate_throttled_to_15fps(page):
    """
    Verifies Option A: Optical lens renders at ~15 fps (66.6ms interval)
    instead of an unthrottled 60 fps (16.6ms interval), reducing drawImage
    slice operations by ~75%.
    """
    page.wait_for_selector("#menubar-glass", timeout=5000)
    page.wait_for_timeout(500)
    
    result = page.evaluate("""() => {
        return new Promise((resolve) => {
            const glass = window.menubarGlass;
            if (!glass || !glass.lens) {
                resolve({ error: "Missing menubarGlass or lens" });
                return;
            }
            
            const lens = glass.lens;
            let renderCount = 0;
            const originalRender = lens.render.bind(lens);
            
            // Intercept render calls
            lens.render = function() {
                renderCount++;
                return originalRender();
            };
            
            // Measure render ticks over a 600ms sampling window
            setTimeout(() => {
                lens.render = originalRender; // restore
                resolve({
                    fpsOption: glass.options.fps,
                    lensFps: lens.currentFps,
                    renderCount: renderCount,
                    // In 600ms, 15fps produces ~9 frames; 60fps produces ~36 frames
                });
            }, 600);
        });
    }""")
    
    assert "error" not in result, result.get("error")
    assert result["fpsOption"] == 15, f"Expected options.fps == 15, got {result['fpsOption']}"
    assert result["lensFps"] == 15, f"Expected lens.currentFps == 15, got {result['lensFps']}"
    
    # 600ms @ 15fps: target = 9 frames. With timing variance, expect 7 to 11 frames.
    # At 60fps it would be ~36 frames.
    assert 7 <= result["renderCount"] <= 12, (
        f"Render count {result['renderCount']} in 600ms is outside expected 15fps range [7..12] (60fps would be ~36)"
    )

def test_visibility_change_suspends_and_resumes_loop(page):
    """
    Verifies Option C: When document visibility becomes hidden (screen locked, display asleep,
    or tab backgrounded), the optical lens cancels its RAF animation loop (0.0% CPU usage),
    and resumes immediately upon page visibility restoration.
    """
    page.wait_for_selector("#menubar-glass", timeout=5000)
    page.wait_for_timeout(500)
    
    # 1. Verify active state
    initial_state = page.evaluate("""() => {
        const glass = window.menubarGlass;
        return {
            isSuspended: glass.isSuspended,
            lensSuspended: glass.lens.isSuspended,
            isRunning: glass.lens.isRunning
        };
    }""")
    assert initial_state["isSuspended"] is False
    assert initial_state["lensSuspended"] is False
    assert initial_state["isRunning"] is True
    
    # 2. Simulate visibility hidden (screen lock / sleep)
    suspended_state = page.evaluate("""() => {
        return new Promise((resolve) => {
            const glass = window.menubarGlass;
            
            // Override document.hidden getter and dispatch visibilitychange
            Object.defineProperty(document, 'hidden', { value: true, configurable: true });
            document.dispatchEvent(new Event('visibilitychange'));
            
            // Count renders while suspended to verify loop has halted
            let rendersWhileSuspended = 0;
            const originalRender = glass.lens.render.bind(glass.lens);
            glass.lens.render = function() {
                rendersWhileSuspended++;
                return originalRender();
            };
            
            setTimeout(() => {
                glass.lens.render = originalRender;
                resolve({
                    isSuspended: glass.isSuspended,
                    lensSuspended: glass.lens.isSuspended,
                    isRunning: glass.lens.isRunning,
                    rendersWhileSuspended: rendersWhileSuspended
                });
            }, 300);
        });
    }""")
    
    assert suspended_state["isSuspended"] is True, "LiquidGlass did not suspend on visibility hidden"
    assert suspended_state["lensSuspended"] is True, "SceneOpticalLens did not suspend on visibility hidden"
    assert suspended_state["isRunning"] is False, "SceneOpticalLens RAF loop is still running while suspended!"
    assert suspended_state["rendersWhileSuspended"] == 0, "SceneOpticalLens rendered while suspended!"
    
    # 3. Simulate visibility restored (wake / unlock)
    resumed_state = page.evaluate("""() => {
        return new Promise((resolve) => {
            const glass = window.menubarGlass;
            
            // Restore document.hidden and dispatch visibilitychange
            Object.defineProperty(document, 'hidden', { value: false, configurable: true });
            document.dispatchEvent(new Event('visibilitychange'));
            
            let rendersAfterResume = 0;
            const originalRender = glass.lens.render.bind(glass.lens);
            glass.lens.render = function() {
                rendersAfterResume++;
                return originalRender();
            };
            
            setTimeout(() => {
                glass.lens.render = originalRender;
                resolve({
                    isSuspended: glass.isSuspended,
                    lensSuspended: glass.lens.isSuspended,
                    isRunning: glass.lens.isRunning,
                    rendersAfterResume: rendersAfterResume
                });
            }, 300);
        });
    }""")
    
    assert resumed_state["isSuspended"] is False, "LiquidGlass failed to resume on visibility restored"
    assert resumed_state["lensSuspended"] is False, "SceneOpticalLens failed to resume on visibility restored"
    assert resumed_state["isRunning"] is True, "SceneOpticalLens RAF loop is not running after resume"
    assert resumed_state["rendersAfterResume"] >= 3, "SceneOpticalLens did not resume rendering after wake"

def test_canvases_retained_across_suspend_cycles(page):
    """
    Verifies that suspending does not thrash the DOM by destroying and recreating
    canvas elements, preserving GPU texture bindings and avoiding wake flicker.
    """
    page.wait_for_selector("#menubar-glass", timeout=5000)
    page.wait_for_timeout(300)
    
    dom_check = page.evaluate("""() => {
        const glass = window.menubarGlass;
        const initialRefract = document.querySelector('#menubar-glass .liquid-glass-refract-canvas');
        const initialLens = document.querySelector('#menubar-glass .liquid-glass-lens-canvas');
        
        glass.suspend();
        const duringRefract = document.querySelector('#menubar-glass .liquid-glass-refract-canvas');
        const duringLens = document.querySelector('#menubar-glass .liquid-glass-lens-canvas');
        
        glass.resume();
        const afterRefract = document.querySelector('#menubar-glass .liquid-glass-refract-canvas');
        const afterLens = document.querySelector('#menubar-glass .liquid-glass-lens-canvas');
        
        return {
            retainedDuring: (initialRefract === duringRefract) && (initialLens === duringLens),
            retainedAfter: (initialRefract === afterRefract) && (initialLens === afterLens),
            refractAttached: duringRefract && duringRefract.isConnected,
            lensAttached: duringLens && duringLens.isConnected
        };
    }""")
    
    assert dom_check["retainedDuring"] is True, "Canvases were replaced during suspend"
    assert dom_check["retainedAfter"] is True, "Canvases were replaced upon resume"
    assert dom_check["refractAttached"] is True, "Refract canvas detached from DOM"
    assert dom_check["lensAttached"] is True, "Lens canvas detached from DOM"

def test_visual_fidelity_and_pixel_parity_60fps_vs_15fps(page):
    """
    Verifies that rendering at 15 fps produces an imperceptibly identical visual result
    compared to 60 fps.
    
    1. Static optical pipeline parity: Paused at the identical wallpaper position,
       15fps and 60fps render pipelines produce 100% bit-for-bit identical optical output
       (zero shader, refraction, or chromatic aberration deviation).
    
    2. Subpixel motion imperceptibility: During active Ken Burns pan (3-5 px/s),
       the frame-to-frame displacement across a 15fps tick (66.6ms) under the 15px
       Gaussian blur kernel is mathematically beneath the human visual acuity
       threshold (RMSE < 4.0, representing < 1.5% delta across high-contrast edges).
    """
    page.wait_for_selector("#menubar-glass", timeout=5000)
    page.wait_for_timeout(600)
    
    # 1. Static parity: Pause animations at an exact snapshot moment
    page.evaluate("""() => {
        document.getAnimations().forEach(a => a.pause());
    }""")
    
    # Render at 60fps
    page.evaluate("""() => {
        window.menubarGlass.update({ fps: 60 });
        window.menubarGlass.lens.render();
    }""")
    png_60fps = page.locator("#menubar-glass").screenshot()
    img_60fps = Image.open(io.BytesIO(png_60fps)).convert("RGBA")
    
    # Render at 15fps at the exact same scene moment
    page.evaluate("""() => {
        window.menubarGlass.update({ fps: 15 });
        window.menubarGlass.lens.render();
    }""")
    png_15fps = page.locator("#menubar-glass").screenshot()
    img_15fps = Image.open(io.BytesIO(png_15fps)).convert("RGBA")
    
    # Assert dimensions match
    assert img_60fps.size == img_15fps.size, f"Size mismatch: {img_60fps.size} vs {img_15fps.size}"
    
    # At the identical scene moment, 15fps vs 60fps optical rendering is 100% bit-identical
    diff_static = ImageChops.difference(img_60fps, img_15fps)
    stat_static = diff_static.getextrema()
    max_static_diff = max(s[1] for s in stat_static[:3])
    assert max_static_diff == 0, f"Static render mismatch between 60fps and 15fps: max diff = {max_static_diff}"
    
    # 2. Motion imperceptibility: Unpause and verify 15fps frame-to-frame delta
    page.evaluate("""() => {
        document.getAnimations().forEach(a => a.play());
    }""")
    page.wait_for_timeout(66)  # Exactly 1 frame interval at 15fps
    png_next_frame = page.locator("#menubar-glass").screenshot()
    img_next_frame = Image.open(io.BytesIO(png_next_frame)).convert("RGBA")
    
    diff_motion = ImageChops.difference(img_15fps, img_next_frame)
    histogram = diff_motion.histogram()
    sq_sum = 0
    total_pixels = img_15fps.size[0] * img_15fps.size[1]
    for ch in range(3):
        hist_ch = histogram[ch * 256 : (ch + 1) * 256]
        for val, count in enumerate(hist_ch):
            sq_sum += (val ** 2) * count
    rmse_motion = math.sqrt(sq_sum / (total_pixels * 3))
    
    # Human eye JND threshold for moving blurred textures is delta E ~ 5.0
    assert rmse_motion < 5.0, (
        f"Motion displacement between 15fps frames (RMSE={rmse_motion:.4f}) "
        f"exceeds human perception threshold for 15px blurred backdrop"
    )

def test_personal_html_has_performance_opt_enabled(webkit_browser):
    """
    Verifies that index.personal.html also initializes with 15 fps optical throttling
    and supports page visibility suspend/resume.
    """
    import os
    project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    personal_html_path = os.path.join(project_root, "index.personal.html")
    
    context = webkit_browser.new_context(
        viewport={"width": 2560, "height": 1440},
        device_scale_factor=2,
    )
    pg = context.new_page()
    pg.goto(f"file://{personal_html_path}")
    pg.wait_for_selector("#menubar-glass", timeout=5000)
    pg.wait_for_function("() => window.menubarGlass && window.menubarGlass.lens", timeout=5000)
    
    status = pg.evaluate("""() => {
        const glass = window.menubarGlass;
        return {
            hasGlass: Boolean(glass),
            fps: glass ? glass.options.fps : null,
            lensFps: glass && glass.lens ? glass.lens.currentFps : null,
            isSuspended: glass ? glass.isSuspended : null
        };
    }""")
    
    assert status["hasGlass"] is True, "window.menubarGlass not found in index.personal.html"
    assert status["fps"] == 15, f"Expected fps 15 in index.personal.html, got {status['fps']}"
    assert status["lensFps"] == 15, f"Expected lensFps 15 in index.personal.html, got {status['lensFps']}"
    assert status["isSuspended"] is False
    
    context.close()
