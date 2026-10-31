import os
import pytest
from playwright.sync_api import sync_playwright

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
INDEX_HTML_PATH = os.path.join(PROJECT_ROOT, "index.html")

@pytest.fixture(scope="session")
def playwright_instance():
    with sync_playwright() as p:
        yield p

@pytest.fixture(scope="session")
def webkit_browser(playwright_instance):
    # Launch WebKit with hardware acceleration flags
    browser = playwright_instance.webkit.launch(
        headless=True,
        args=["--enable-webgl", "--enable-accelerated-2d-canvas"]
    )
    yield browser
    browser.close()

@pytest.fixture
def page(webkit_browser):
    # Standard macOS 5K / 1440p logical viewport
    context = webkit_browser.new_context(
        viewport={"width": 2560, "height": 1440},
        device_scale_factor=2,
        ignore_https_errors=True
    )
    pg = context.new_page()
    
    # Clean localStorage before test
    pg.goto(f"file://{INDEX_HTML_PATH}")
    pg.evaluate("() => localStorage.clear()")
    pg.reload()
    
    yield pg
    context.close()
