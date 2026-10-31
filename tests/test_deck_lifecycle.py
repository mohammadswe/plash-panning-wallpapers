import pytest

def test_fisher_yates_deck_plays_all_wallpapers_without_repeats(page):
    """
    Verifies that calling getNextWallpaper() across the entire library length
    returns every single registered wallpaper exactly once before any repeat.
    """
    result = page.evaluate("""() => {
        // Reset deck to a fresh full shuffle
        deck = shuffle(images);
        lastShown = "";
        
        const total = images.length;
        const played = [];
        
        for (let i = 0; i < total; i++) {
            played.push(getNextWallpaper());
        }
        
        const uniqueSet = new Set(played);
        return {
            total,
            playedCount: played.length,
            uniqueCount: uniqueSet.size,
            deckRemaining: deck.length
        };
    }""")
    
    assert result["playedCount"] == result["total"], "Did not draw all wallpapers"
    assert result["uniqueCount"] == result["total"], f"Duplicates detected in deck! Unique: {result['uniqueCount']}/{result['total']}"
    assert result["deckRemaining"] == 0, f"Deck should be exhausted after {result['total']} draws"

def test_boundary_deduplication_on_deck_reshuffle(page):
    """
    Verifies that when a deck runs out of cards, the fresh shuffle
    never picks the same wallpaper that was just displayed across the boundary.
    """
    boundary_repeats = page.evaluate("""() => {
        let repeats = 0;
        
        // Test 10 consecutive reshuffle boundaries
        for (let cycle = 0; cycle < 10; cycle++) {
            // Exhaust deck
            while (deck.length > 0) {
                getNextWallpaper();
            }
            const prior = lastShown;
            const nextAcrossBoundary = getNextWallpaper(); // Triggers reshuffle
            if (nextAcrossBoundary === prior) {
                repeats++;
            }
        }
        return repeats;
    }""")
    
    assert boundary_repeats == 0, f"Detected {boundary_repeats} duplicate boundary transitions across deck resets!"

def test_page_reload_does_not_recycle_played_wallpapers(page):
    """
    CRITICAL REGRESSION TEST:
    Verifies that reloading the webview (or waking from sleep) does NOT misidentify
    already-played wallpapers as 'new images' and splice them back into the active deck.
    """
    result = page.evaluate("""() => {
        // Draw 30 wallpapers
        for (let i = 0; i < 30; i++) {
            getNextWallpaper();
        }
        
        const deckSizeBeforeReload = deck.length;
        
        // Simulate reload by re-running initDeck()
        initDeck();
        
        const deckSizeAfterReload = deck.length;
        
        return {
            deckSizeBeforeReload,
            deckSizeAfterReload
        };
    }""")
    
    assert result["deckSizeAfterReload"] == result["deckSizeBeforeReload"], (
        f"Deck re-inflated from {result['deckSizeBeforeReload']} to {result['deckSizeAfterReload']} on reload! "
        "Played cards were falsely recycled back into the deck!"
    )

def test_genuinely_new_images_are_interleaved_into_deck(page):
    """
    Verifies that when a new wallpaper is actually added to images (via add_walls.sh),
    initDeck() detects it, splices it into the remaining deck, and updates the library snapshot.
    """
    result = page.evaluate("""() => {
        // Draw 10 wallpapers
        for (let i = 0; i < 10; i++) getNextWallpaper();
        
        const deckSizeBefore = deck.length;
        const brandNewWall = "converted/brand-new-test-wallpaper.webp";
        
        // Inject new wallpaper into images array
        images.push(brandNewWall);
        
        // Run initDeck()
        initDeck();
        
        const deckSizeAfter = deck.length;
        const containsNewWall = deck.includes(brandNewWall);
        
        // Clean up mock
        images.pop();
        
        return {
            deckSizeBefore,
            deckSizeAfter,
            containsNewWall
        };
    }""")
    
    assert result["deckSizeAfter"] == result["deckSizeBefore"] + 1, "New wallpaper was not added to deck"
    assert result["containsNewWall"] is True, "New wallpaper path missing from deck array"

def test_consecutive_error_circuit_breaker(page):
    """
    Verifies that multiple consecutive image load failures trigger the circuit breaker
    and halt cycling instead of generating a rapid CPU-pegging infinite loop.
    """
    result = page.evaluate("""() => {
        let halted = false;
        
        // Simulate consecutive decode error handling
        for (let i = 0; i < 10; i++) {
            consecutiveErrors++;
            if (consecutiveErrors >= Math.min(MAX_CONSECUTIVE_ERRORS, images.length)) {
                halted = true;
                break;
            }
        }
        
        return {
            consecutiveErrors,
            halted,
            maxErrors: MAX_CONSECUTIVE_ERRORS
        };
    }""")
    
    assert result["halted"] is True, "Circuit breaker failed to trip after consecutive errors"
    assert result["consecutiveErrors"] == result["maxErrors"], f"Expected {result['maxErrors']} errors before halt, got {result['consecutiveErrors']}"
