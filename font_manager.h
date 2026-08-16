#ifndef FONT_MANAGER_H
#define FONT_MANAGER_H

#include <ft2build.h>
#include FT_FREETYPE_H
#include <vector>
#include <cstdint>
#include <string>

// Font-level metrics (from FreeType FT_Face)
struct FontMetrics {
    int ascent;           // Font ascender (baseline to top)
    int descent;          // Font descender (baseline to bottom, negative)
    int cap_height;       // Height of capital letters
    int x_height;         // Height of lowercase 'x'
    int stem_v;           // Vertical stem width (estimated)
    int italic_angle;     // Italic angle in degrees (0 for upright)
    int bbox[4];          // Font bounding box [xMin, yMin, xMax, yMax]
    int units_per_em;     // Font units per em (typically 1000 or 2048)
    bool is_fixed_pitch;  // True for monospace fonts
};

// Glyph-level metrics (for individual characters)
struct GlyphMetrics {
    uint32_t glyph_id;    // FreeType glyph index
    int width;            // Advance width in font units
    int height;           // Glyph height in font units
    int bearing_x;        // Horizontal bearing
    int bearing_y;        // Vertical bearing
    int advance_x;        // Horizontal advance
    int advance_y;        // Vertical advance
};

class FontManager {
private:
    FT_Library library;
    FT_Face face;
    std::vector<uint8_t> font_data;  // Keep font data in memory
    bool initialized;

public:
    FontManager();
    ~FontManager();

    // Load font from memory buffer
    bool loadFont(const uint8_t* data, size_t size);

    // Load font from virtual filesystem path
    bool loadFontFromFile(const char* path);

    // Get font-level metrics
    FontMetrics getFontMetrics() const;

    // Get metrics for a specific character
    bool getGlyphMetrics(uint32_t unicode_codepoint, GlyphMetrics& out) const;

    // Get glyph index for a character
    uint32_t getGlyphIndex(uint32_t unicode_codepoint) const;

    // Check if font is loaded
    bool isLoaded() const { return initialized && face != nullptr; }

    // Get font name
    std::string getFontName() const;

    // Get number of glyphs in font
    int getNumGlyphs() const;
};

#endif // FONT_MANAGER_H
