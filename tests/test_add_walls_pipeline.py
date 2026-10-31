import os
import shutil
import subprocess
import pytest
from PIL import Image

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ADD_WALLS_SCRIPT = os.path.join(PROJECT_ROOT, "add_walls.sh")
INDEX_HTML = os.path.join(PROJECT_ROOT, "index.html")
INDEX_PERSONAL = os.path.join(PROJECT_ROOT, "index.personal.html")

@pytest.fixture(autouse=True)
def preserve_html_files():
    """Back up index.html and index.personal.html and restore them after tests."""
    with open(INDEX_HTML, "r", encoding="utf-8") as f:
        orig_html = f.read()
    with open(INDEX_PERSONAL, "r", encoding="utf-8") as f:
        orig_personal = f.read()
    yield
    with open(INDEX_HTML, "w", encoding="utf-8") as f:
        f.write(orig_html)
    with open(INDEX_PERSONAL, "w", encoding="utf-8") as f:
        f.write(orig_personal)
    # Remove any stray .bak files
    for p in [INDEX_HTML + ".bak", INDEX_PERSONAL + ".bak"]:
        if os.path.exists(p):
            os.remove(p)

@pytest.fixture
def temp_images_dir(tmp_path):
    """Generates synthetic test images for the pipeline."""
    img_dir = tmp_path / "input_photos"
    img_dir.mkdir()
    
    # Standard 16:9 4K JPEG
    img_standard = Image.new("RGB", (3840, 2160), color=(50, 100, 150))
    img_standard.save(img_dir / "standard-mountain.jpg")
    
    # Ultra-wide 12000x2000 Gigapixel Panorama
    img_pano = Image.new("RGB", (12000, 2000), color=(20, 80, 40))
    img_pano.save(img_dir / "ultra-wide-panorama.png")
    
    # Non-Latin Unicode filename (Bengali)
    img_unicode = Image.new("RGB", (2000, 1500), color=(180, 50, 50))
    img_unicode.save(img_dir / "শহীদ_মিনার.jpg")
    
    return img_dir

def test_add_walls_dimension_clamping(temp_images_dir):
    """
    Verifies that importing an ultra-wide panorama clamps width to <= 7680px
    and height to <= 2880px without distorting its aspect ratio.
    """
    pano_path = str(temp_images_dir / "ultra-wide-panorama.png")
    converted_path = os.path.join(PROJECT_ROOT, "converted", "ultra-wide-panorama.webp")
    
    try:
        res = subprocess.run(
            [ADD_WALLS_SCRIPT, pano_path],
            cwd=PROJECT_ROOT,
            capture_output=True,
            text=True
        )
        assert res.returncode == 0, f"add_walls.sh failed with error:\n{res.stderr}"
        assert os.path.exists(converted_path), "Expected converted WebP file was not created"
        
        # Verify dimensions with sips
        dims_out = subprocess.check_output(["sips", "-g", "pixelWidth", "-g", "pixelHeight", converted_path], text=True)
        w = int([line.split(":")[1].strip() for line in dims_out.splitlines() if "pixelWidth:" in line][0])
        h = int([line.split(":")[1].strip() for line in dims_out.splitlines() if "pixelHeight:" in line][0])
        
        assert w <= 7680, f"Width {w} exceeds MAX_WIDTH 7680!"
        assert h <= 2880, f"Height {h} exceeds TARGET_HEIGHT 2880!"
        
        # Aspect ratio original was 12000/2000 = 6.0. Output must be within 1% of 6.0
        aspect = w / h
        assert abs(aspect - 6.0) < 0.1, f"Aspect ratio distorted! Expected ~6.0, got {aspect:.2f}"
    finally:
        if os.path.exists(converted_path):
            os.remove(converted_path)

def test_add_walls_duplicate_skipping_and_force_overwrite(temp_images_dir):
    """
    Verifies that importing an already converted file skips by default,
    and overwrites when the --force (-f) flag is passed.
    """
    src_path = str(temp_images_dir / "standard-mountain.jpg")
    converted_file = os.path.join(PROJECT_ROOT, "converted", "standard-mountain.webp")
    
    try:
        # First run: should convert
        res1 = subprocess.run([ADD_WALLS_SCRIPT, src_path], cwd=PROJECT_ROOT, capture_output=True, text=True)
        assert res1.returncode == 0
        assert os.path.exists(converted_file)
        
        # Second run without force: should skip
        res2 = subprocess.run([ADD_WALLS_SCRIPT, src_path], cwd=PROJECT_ROOT, capture_output=True, text=True)
        assert res2.returncode == 0
        assert "Skipped (already imported)" in res2.stdout, f"Expected duplicate skip, got:\n{res2.stdout}"
        
        # Third run with -f: should overwrite
        res3 = subprocess.run([ADD_WALLS_SCRIPT, "-f", src_path], cwd=PROJECT_ROOT, capture_output=True, text=True)
        assert res3.returncode == 0
        assert "Overwriting existing" in res3.stdout, f"Expected overwrite notice, got:\n{res3.stdout}"
    finally:
        if os.path.exists(converted_file):
            os.remove(converted_file)

def test_add_walls_unicode_filename_preservation(temp_images_dir):
    """
    Verifies that non-Latin Unicode filenames (e.g. Bengali) are preserved cleanly
    without being stripped into empty dashes or generic names.
    """
    src_path = str(temp_images_dir / "শহীদ_মিনার.jpg")
    expected_path = os.path.join(PROJECT_ROOT, "converted", "শহীদ_মিনার.webp")
    
    try:
        res = subprocess.run([ADD_WALLS_SCRIPT, src_path], cwd=PROJECT_ROOT, capture_output=True, text=True)
        assert res.returncode == 0
        assert os.path.exists(expected_path), f"Expected {expected_path} to exist. Output was:\n{res.stdout}"
    finally:
        if os.path.exists(expected_path):
            os.remove(expected_path)
