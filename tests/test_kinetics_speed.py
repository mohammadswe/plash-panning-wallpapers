import math
import re
import pytest

def test_visual_pan_velocity_is_calm_and_consistent(page):
    """
    Verifies that the camera drift velocity adheres strictly to the target 3.0 to 5.0 px/s range,
    preventing any high-speed camera sprinting across panoramas.
    """
    page.wait_for_selector("#layerA.active", timeout=5000)
    page.wait_for_function("() => document.getElementById('layerA').getAnimations().length > 0")

    anim_info = page.evaluate("""() => {
        const anim = document.getElementById('layerA').getAnimations()[0];
        const [fromFrame, toFrame] = anim.effect.getKeyframes();
        return {
            from: fromFrame.transform,
            to: toFrame.transform,
            durationMs: anim.effect.getComputedTiming().duration,
            easing: anim.effect.getComputedTiming().easing,
            fill: anim.effect.getComputedTiming().fill
        };
    }""")

    # Parse translate3d coordinates
    from_match = re.search(r"translate3d\(([-0-9.]+)px,\s*([-0-9.]+)px", anim_info["from"])
    to_match = re.search(r"translate3d\(([-0-9.]+)px,\s*([-0-9.]+)px", anim_info["to"])
    
    assert from_match and to_match, f"Invalid translate3d format: {anim_info}"
    
    x1, y1 = float(from_match.group(1)), float(from_match.group(2))
    x2, y2 = float(to_match.group(1)), float(to_match.group(2))
    duration_sec = anim_info["durationMs"] / 1000.0
    
    dx = x2 - x1
    dy = y2 - y1
    distance = math.sqrt(dx**2 + dy**2)
    speed = distance / duration_sec
    
    # Assert within 3.0 to 5.0 px/s (with 0.1 tolerance for floating point math)
    assert 2.9 <= speed <= 5.1, f"Calculated speed {speed:.2f} px/s out of range [3.0, 5.0] px/s!"
    assert anim_info["easing"] == "linear", "Animation easing must be linear for calm drift"
    assert anim_info["fill"] == "forwards", "Animation fill must be forwards"

def test_drift_angles_provide_full_360_degree_coverage(page):
    """
    Tests 50 simulated trajectory calculations to verify that camera drift angles
    distribute across all 4 quadrants of the 360-degree compass.
    """
    quadrants = page.evaluate(r"""() => {
        const dummyImg = { naturalWidth: 2560, naturalHeight: 1440, style: {} };
        const hits = [0, 0, 0, 0]; // Q1, Q2, Q3, Q4
        
        for (let i = 0; i < 50; i++) {
            const { from, to } = calculateDynamicPan(dummyImg, 60000);
            const m1 = from.match(/translate3d\(([-0-9.]+)px,\s*([-0-9.]+)px/);
            const m2 = to.match(/translate3d\(([-0-9.]+)px,\s*([-0-9.]+)px/);
            const dx = parseFloat(m2[1]) - parseFloat(m1[1]);
            const dy = parseFloat(m2[2]) - parseFloat(m1[2]);
            const angle = Math.atan2(dy, dx); // [-PI, PI]
            
            if (dx >= 0 && dy >= 0) hits[0]++;
            else if (dx < 0 && dy >= 0) hits[1]++;
            else if (dx < 0 && dy < 0) hits[2]++;
            else hits[3]++;
        }
        return hits;
    }""")
    
    # Every quadrant must receive at least 3 hits out of 50
    for q_idx, count in enumerate(quadrants):
        assert count >= 3, f"Quadrant {q_idx + 1} has insufficient hits ({count}/50) - 360-degree distribution is biased!"
