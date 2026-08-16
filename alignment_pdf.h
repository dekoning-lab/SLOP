#ifndef ALIGNMENT_PDF_H
#define ALIGNMENT_PDF_H

#include <string>
#include <vector>
#include <map>
#include <fstream>
#include <sstream>
#include "font_manager.h"

// Minimal PDF generator specifically for MSA alignments
// Supports TrueType fonts via font embedding
class AlignmentPDF {
private:
    struct PDFObject {
        int number;
        size_t offset;
        std::vector<char> content;  // Use vector<char> for binary safety
    };

    std::vector<PDFObject> objects;
    std::vector<int> page_objects;
    std::vector<int> page_contents_;  // Store content stream object numbers
    int pages_root_obj;
    int font_obj;
    int resources_obj;

    FontManager* font_mgr;
    std::map<uint32_t, int> char_widths;  // Unicode -> width in font units
    int default_width;

    std::ostringstream pdf_content;
    std::ostringstream page_content;
    float page_width, page_height;
    int next_obj_num;

    // Create new object and return its number
    int createObject(const std::vector<char>& content);

    // Embed TrueType font
    void embedTrueTypeFont(const std::string& font_name, const std::vector<uint8_t>& font_data);

public:
    AlignmentPDF(float width, float height);

    // Load and embed font
    bool loadFont(const std::string& font_path);

    // Start new page, returns page content stream object number
    int beginPage();

    // Add content to current page
    void setColor(uint32_t rgb);
    void fillRect(float x, float y, float w, float h);
    void drawText(const std::string& text, float x, float y, float size);

    // Optimized text drawing for sequences
    void beginTextBlock(float size);
    void drawTextAt(const std::string& text, float x, float y);
    void endTextBlock();

    // End page and add to pages array
    void endPage();

    // Write final PDF to file
    bool save(const std::string& filename);
};

#endif // ALIGNMENT_PDF_H
