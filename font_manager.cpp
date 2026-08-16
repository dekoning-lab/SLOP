#include "font_manager.h"
#include <cstring>
#include <fstream>
#include <iostream>
#include FT_TRUETYPE_TABLES_H

FontManager::FontManager() : library(nullptr), face(nullptr), initialized(false) {
    FT_Error error = FT_Init_FreeType(&library);
    if (error) {
        std::cerr << "FreeType initialization failed: " << error << std::endl;
        initialized = false;
    } else {
        initialized = true;
    }
}

FontManager::~FontManager() {
    if (face) {
        FT_Done_Face(face);
        face = nullptr;
    }
    if (library) {
        FT_Done_FreeType(library);
        library = nullptr;
    }
}

bool FontManager::loadFont(const uint8_t* data, size_t size) {
    if (!initialized || !library) {
        std::cerr << "FontManager not initialized" << std::endl;
        return false;
    }

    // Copy font data to internal buffer
    font_data.assign(data, data + size);

    // Load face from memory
    FT_Error error = FT_New_Memory_Face(
        library,
        font_data.data(),
        font_data.size(),
        0,  // face_index
        &face
    );

    if (error) {
        std::cerr << "Failed to load font from memory: " << error << std::endl;
        return false;
    }

    std::cout << "Font loaded: " << face->family_name
              << " " << face->style_name << std::endl;
    std::cout << "  Glyphs: " << face->num_glyphs << std::endl;
    std::cout << "  Units per EM: " << face->units_per_EM << std::endl;

    return true;
}

bool FontManager::loadFontFromFile(const char* path) {
    if (!initialized || !library) {
        std::cerr << "FontManager not initialized" << std::endl;
        return false;
    }

    // Read file into memory
    std::ifstream file(path, std::ios::binary | std::ios::ate);
    if (!file.is_open()) {
        std::cerr << "Failed to open font file: " << path << std::endl;
        return false;
    }

    size_t file_size = file.tellg();
    file.seekg(0, std::ios::beg);

    std::vector<uint8_t> buffer(file_size);
    if (!file.read(reinterpret_cast<char*>(buffer.data()), file_size)) {
        std::cerr << "Failed to read font file: " << path << std::endl;
        return false;
    }

    return loadFont(buffer.data(), buffer.size());
}

FontMetrics FontManager::getFontMetrics() const {
    FontMetrics metrics = {0};

    if (!face) {
        return metrics;
    }

    // Convert FreeType font units to PDF font units (1000 per em)
    // PDF expects metrics in 1000-unit space
    float scale = 1000.0f / face->units_per_EM;

    metrics.ascent = static_cast<int>(face->ascender * scale);
    metrics.descent = static_cast<int>(face->descender * scale);
    metrics.units_per_em = 1000;  // PDF standard
    metrics.is_fixed_pitch = (face->face_flags & FT_FACE_FLAG_FIXED_WIDTH) != 0;

    // Bounding box
    metrics.bbox[0] = static_cast<int>(face->bbox.xMin * scale);
    metrics.bbox[1] = static_cast<int>(face->bbox.yMin * scale);
    metrics.bbox[2] = static_cast<int>(face->bbox.xMax * scale);
    metrics.bbox[3] = static_cast<int>(face->bbox.yMax * scale);

    // Try to get cap_height and x_height from OS/2 table
    // If not available, estimate from bounding box
    TT_OS2* os2 = (TT_OS2*)FT_Get_Sfnt_Table(face, FT_SFNT_OS2);
    if (os2) {
        metrics.cap_height = static_cast<int>(os2->sCapHeight * scale);
        metrics.x_height = static_cast<int>(os2->sxHeight * scale);
    } else {
        // Estimate: cap_height ≈ 70% of ascent
        metrics.cap_height = static_cast<int>(metrics.ascent * 0.7f);
        metrics.x_height = static_cast<int>(metrics.ascent * 0.5f);
    }

    // Estimate StemV from average glyph width
    // For monospace fonts, use width of 'M'
    uint32_t m_index = FT_Get_Char_Index(face, 'M');
    if (m_index > 0) {
        FT_Load_Glyph(face, m_index, FT_LOAD_NO_SCALE);
        metrics.stem_v = static_cast<int>(face->glyph->metrics.width * scale * 0.15f);
    } else {
        metrics.stem_v = 100;  // Default fallback
    }

    // Get italic angle from 'post' table
    TT_Postscript* post = (TT_Postscript*)FT_Get_Sfnt_Table(face, FT_SFNT_POST);
    if (post) {
        metrics.italic_angle = static_cast<int>(post->italicAngle >> 16);
    } else {
        metrics.italic_angle = 0;
    }

    return metrics;
}

bool FontManager::getGlyphMetrics(uint32_t unicode_codepoint, GlyphMetrics& out) const {
    if (!face) {
        return false;
    }

    // Get glyph index from Unicode code point
    uint32_t glyph_index = FT_Get_Char_Index(face, unicode_codepoint);
    if (glyph_index == 0) {
        return false;  // Glyph not found in font
    }

    // Load glyph without scaling (in font units)
    FT_Error error = FT_Load_Glyph(face, glyph_index, FT_LOAD_NO_SCALE);
    if (error) {
        return false;
    }

    // Convert to PDF units (1000 per em)
    float scale = 1000.0f / face->units_per_EM;

    out.glyph_id = glyph_index;
    out.width = static_cast<int>(face->glyph->metrics.width * scale);
    out.height = static_cast<int>(face->glyph->metrics.height * scale);
    out.bearing_x = static_cast<int>(face->glyph->metrics.horiBearingX * scale);
    out.bearing_y = static_cast<int>(face->glyph->metrics.horiBearingY * scale);
    out.advance_x = static_cast<int>(face->glyph->metrics.horiAdvance * scale);
    out.advance_y = static_cast<int>(face->glyph->metrics.vertAdvance * scale);

    return true;
}

uint32_t FontManager::getGlyphIndex(uint32_t unicode_codepoint) const {
    if (!face) {
        return 0;
    }
    return FT_Get_Char_Index(face, unicode_codepoint);
}

std::string FontManager::getFontName() const {
    if (!face || !face->family_name) {
        return "";
    }
    std::string name = face->family_name;
    if (face->style_name) {
        name += "-";
        name += face->style_name;
    }
    return name;
}

int FontManager::getNumGlyphs() const {
    if (!face) {
        return 0;
    }
    return face->num_glyphs;
}
