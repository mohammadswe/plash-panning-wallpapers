import os
import sys
import re
import pytest
from playwright.sync_api import sync_playwright

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)

INDEX_HTML = os.path.join(PROJECT_ROOT, "index.html")
INDEX_URL = f"file://{INDEX_HTML}"

def test_sync_day_night_classification_and_graceful_default():
    """
    Verifies that sync_day_night correctly partitions day and night wallpapers,
    ignores stray 'day.txt' and 'night.txt' entries, and gracefully defaults
    unassigned converted images to dayImages.
    """
    import sync_day_night as sdn

    converted_dir = os.path.join(PROJECT_ROOT, "converted")
    all_webp = set(f for f in os.listdir(converted_dir) if f.endswith(".webp") and not f.startswith("."))

    with open(INDEX_HTML, "r", encoding="utf-8") as f:
        content = f.read()

    day_match = re.search(r"const dayImages = \[\s*([\s\S]*?)\s*\];", content)
    night_match = re.search(r"const nightImages = \[\s*([\s\S]*?)\s*\];", content)

    assert day_match is not None, "dayImages array not found in index.html"
    assert night_match is not None, "nightImages array not found in index.html"

    day_images = [line.strip().strip('",') for line in day_match.group(1).splitlines() if line.strip()]
    night_images = [line.strip().strip('",') for line in night_match.group(1).splitlines() if line.strip()]

    # Verify no stray txt references
    for img in day_images + night_images:
        assert not img.endswith("day.txt"), f"Found stray day.txt in library: {img}"
        assert not img.endswith("night.txt"), f"Found stray night.txt in library: {img}"

    # Verify disjoint sets
    day_basenames = set(os.path.basename(img) for img in day_images)
    night_basenames = set(os.path.basename(img) for img in night_images)

    assert len(day_basenames & night_basenames) == 0, f"Overlap between day and night: {day_basenames & night_basenames}"

    # Verify all converted images are assigned (graceful default)
    total_assigned = day_basenames | night_basenames
    assert all_webp.issubset(total_assigned), f"Unassigned images missing: {all_webp - total_assigned}"

def test_light_mode_serves_day_wallpapers():
    """
    Verifies that WebKit running in Light appearance mode initializes currentTheme to 'day',
    points active library to dayImages, and draws exclusively day wallpapers.
    """
    with sync_playwright() as p:
        browser = p.webkit.launch()
        context = browser.new_context(color_scheme="light")
        page = context.new_page()
        page.goto(INDEX_URL)

        result = page.evaluate("""() => {
            const isNight = isNightMode();
            const activeLib = getActiveLibrary();
            const drawn = [];
            for (let i = 0; i < 10; i++) {
                drawn.push(getNextWallpaper());
            }

            const allDrawnInDay = drawn.every(img => dayImages.includes(img));
            return {
                isNight,
                currentTheme,
                dayLength: dayImages.length,
                nightLength: nightImages.length,
                allDrawnInDay,
                sample: drawn.slice(0, 3)
            };
        }""")

        assert result["isNight"] is False, "Light mode should report isNightMode() == False"
        assert result["currentTheme"] == "day", f"Expected theme 'day', got {result['currentTheme']}"
        assert result["dayLength"] > 0, "dayImages library is empty"
        assert result["allDrawnInDay"] is True, f"Drawn non-day wallpapers in light mode: {result['sample']}"

        browser.close()

def test_dark_mode_serves_night_wallpapers():
    """
    Verifies that WebKit running in Dark appearance mode initializes currentTheme to 'night',
    points active library to nightImages, and draws exclusively night wallpapers.
    """
    with sync_playwright() as p:
        browser = p.webkit.launch()
        context = browser.new_context(color_scheme="dark")
        page = context.new_page()
        page.goto(INDEX_URL)

        result = page.evaluate("""() => {
            const isNight = isNightMode();
            const activeLib = getActiveLibrary();
            const drawn = [];
            for (let i = 0; i < 10; i++) {
                drawn.push(getNextWallpaper());
            }

            const allDrawnInNight = drawn.every(img => nightImages.includes(img));
            return {
                isNight,
                currentTheme,
                nightLength: nightImages.length,
                allDrawnInNight,
                sample: drawn.slice(0, 3)
            };
        }""")

        assert result["isNight"] is True, "Dark mode should report isNightMode() == True"
        assert result["currentTheme"] == "night", f"Expected theme 'night', got {result['currentTheme']}"
        assert result["nightLength"] > 0, "nightImages library is empty"
        assert result["allDrawnInNight"] is True, f"Drawn non-night wallpapers in dark mode: {result['sample']}"

        browser.close()

def test_runtime_theme_switch_flips_deck():
    """
    Verifies that switching appearance theme at runtime (via OS / WebKit media emulation)
    immediately re-indexes the active deck and draws from the appropriate new pool.
    """
    with sync_playwright() as p:
        browser = p.webkit.launch()
        context = browser.new_context(color_scheme="light")
        page = context.new_page()
        page.goto(INDEX_URL)

        # Draw 2 day wallpapers in light mode
        day1 = page.evaluate("getNextWallpaper()")
        day2 = page.evaluate("getNextWallpaper()")
        initial_theme = page.evaluate("currentTheme")
        in_day1 = page.evaluate(f"dayImages.includes('{day1}')")
        in_day2 = page.evaluate(f"dayImages.includes('{day2}')")

        assert initial_theme == "day"
        assert in_day1 is True
        assert in_day2 is True

        # Emulate OS transition to Dark Mode (e.g. sunset)
        page.emulate_media(color_scheme="dark")

        # Draw wallpapers in dark mode
        night1 = page.evaluate("getNextWallpaper()")
        night2 = page.evaluate("getNextWallpaper()")
        switched_theme = page.evaluate("currentTheme")
        in_night1 = page.evaluate(f"nightImages.includes('{night1}')")
        in_night2 = page.evaluate(f"nightImages.includes('{night2}')")

        assert switched_theme == "night"
        assert in_night1 is True
        assert in_night2 is True

        # Emulate OS transition back to Light Mode (e.g. sunrise)
        page.emulate_media(color_scheme="light")

        day3 = page.evaluate("getNextWallpaper()")
        reverted_theme = page.evaluate("currentTheme")
        in_day3 = page.evaluate(f"dayImages.includes('{day3}')")

        assert reverted_theme == "day"
        assert in_day3 is True

        browser.close()

def test_night_deck_full_rotation_without_repeats():
    """
    Verifies that the smaller night deck (14 wallpapers) completes a full Fisher-Yates rotation
    without repeats before cycling, and avoids boundary collision on reset.
    """
    with sync_playwright() as p:
        browser = p.webkit.launch()
        context = browser.new_context(color_scheme="dark")
        page = context.new_page()
        page.goto(INDEX_URL)

        result = page.evaluate("""() => {
            switchThemeDeck("night");
            const totalNight = nightImages.length;
            const played = [];

            for (let i = 0; i < totalNight; i++) {
                played.push(getNextWallpaper());
            }

            const uniqueCount = new Set(played).size;
            const lastNightShown = lastShown;
            const nextCycleFirst = getNextWallpaper(); // Reshuffle boundary

            return {
                totalNight,
                playedCount: played.length,
                uniqueCount,
                boundaryRepeat: lastNightShown === nextCycleFirst,
                allInNight: played.every(img => nightImages.includes(img))
            };
        }""")

        assert result["playedCount"] == result["totalNight"], "Did not draw all night wallpapers"
        assert result["uniqueCount"] == result["totalNight"], "Duplicate detected in single night rotation"
        assert result["boundaryRepeat"] is False, "Boundary duplicate detected on night deck reshuffle"
        assert result["allInNight"] is True, "Non-night wallpaper drawn in night deck"

        browser.close()
