#include "alignment_pdf.h"
#include <sstream>
#include <iomanip>
#include <fstream>
#include <ctime>
#include <zlib.h>
#include <iostream>

// Helper function to compress data using zlib
static std::vector<char> compressData(const std::vector<uint8_t>& data) {
    std::cout << "Compressing " << data.size() << " bytes..." << std::endl;

    uLongf compressed_size = compressBound(data.size());
    std::vector<char> compressed(compressed_size);

    int result = compress(reinterpret_cast<Bytef*>(compressed.data()), &compressed_size,
                          reinterpret_cast<const Bytef*>(data.data()), data.size());

    if (result != Z_OK) {
        // Compression failed, return empty vector
        std::cout << "Compression FAILED with error: " << result << std::endl;
        return std::vector<char>();
    }

    compressed.resize(compressed_size);
    std::cout << "Compressed to " << compressed_size << " bytes ("
              << (100.0 * compressed_size / data.size()) << "%)" << std::endl;
    return compressed;
}

AlignmentPDF::AlignmentPDF(float width, float height)
    : page_width(width), page_height(height), next_obj_num(1),
      font_mgr(nullptr), pages_root_obj(0), font_obj(0), resources_obj(0), default_width(600) {
    // Reserve object 0 (unused in PDF)
    objects.push_back({0, 0, std::vector<char>()});

    // Note: pages_root_obj will be allocated in save() after all content is created
}

int AlignmentPDF::createObject(const std::vector<char>& content) {
    int obj_num = next_obj_num++;
    objects.push_back({obj_num, 0, content});  // offset filled later
    return obj_num;
}

bool AlignmentPDF::loadFont(const std::string& font_path) {
    // Load font with FreeType
    font_mgr = new FontManager();
    if (!font_mgr->loadFontFromFile(font_path.c_str())) {
        delete font_mgr;
        font_mgr = nullptr;
        return false;
    }

    // Get default width from 'A' character
    GlyphMetrics gm;
    if (font_mgr->getGlyphMetrics('A', gm)) {
        default_width = gm.advance_x;
    }

    // Read font file as bytes for embedding
    std::ifstream file(font_path, std::ios::binary | std::ios::ate);
    if (!file.is_open()) return false;

    size_t font_size = file.tellg();
    file.seekg(0);
    std::vector<uint8_t> font_data(font_size);
    file.read(reinterpret_cast<char*>(font_data.data()), font_size);
    file.close();

    // Embed font in PDF
    embedTrueTypeFont("JetBrainsMono-Bold", font_data);

    return true;
}

void AlignmentPDF::embedTrueTypeFont(const std::string& font_name, const std::vector<uint8_t>& font_data) {
    // 1. Create FontFile2 stream (TrueType font program) - UNCOMPRESSED for compatibility
    // Note: Disabling compression for Preview/Acrobat compatibility
    int font_file_obj;

    std::ostringstream header;
    header << "<< /Length " << font_data.size()
           << " /Length1 " << font_data.size() << " >>\n";
    header << "stream\n";
    std::string header_str = header.str();

    std::vector<char> font_stream;
    font_stream.insert(font_stream.end(), header_str.begin(), header_str.end());
    font_stream.insert(font_stream.end(), font_data.begin(), font_data.end());
    std::string trailer = "\nendstream";
    font_stream.insert(font_stream.end(), trailer.begin(), trailer.end());

    font_file_obj = createObject(font_stream);

    // 2. Create FontDescriptor
    FontMetrics metrics = font_mgr->getFontMetrics();
    int flags = 32;  // Symbolic
    if (metrics.is_fixed_pitch) flags |= 1;

    std::ostringstream font_desc;
    font_desc << "<< /Type /FontDescriptor\n";
    font_desc << "   /FontName /" << font_name << "\n";
    font_desc << "   /Flags " << flags << "\n";
    font_desc << "   /FontBBox [" << metrics.bbox[0] << " " << metrics.bbox[1]
              << " " << metrics.bbox[2] << " " << metrics.bbox[3] << "]\n";
    font_desc << "   /ItalicAngle " << metrics.italic_angle << "\n";
    font_desc << "   /Ascent " << metrics.ascent << "\n";
    font_desc << "   /Descent " << metrics.descent << "\n";
    font_desc << "   /CapHeight " << metrics.cap_height << "\n";
    font_desc << "   /StemV " << metrics.stem_v << "\n";
    font_desc << "   /FontFile2 " << font_file_obj << " 0 R\n";
    font_desc << ">>";
    std::string font_desc_str = font_desc.str();
    std::vector<char> font_desc_vec(font_desc_str.begin(), font_desc_str.end());
    int font_desc_obj = createObject(font_desc_vec);

    // 3. Create a simple TrueType font (not Type 0/CID for better compatibility)
    std::ostringstream font;
    font << "<< /Type /Font\n";
    font << "   /Subtype /TrueType\n";
    font << "   /BaseFont /" << font_name << "\n";
    font << "   /FirstChar 32\n";
    font << "   /LastChar 126\n";
    font << "   /FontDescriptor " << font_desc_obj << " 0 R\n";

    // Create widths array for characters 32-126
    font << "   /Widths [";
    for (int i = 32; i <= 126; i++) {
        GlyphMetrics gm;
        if (font_mgr->getGlyphMetrics(i, gm)) {
            font << gm.advance_x << " ";
        } else {
            font << default_width << " ";
        }
    }
    font << "]\n";

    font << "   /Encoding /WinAnsiEncoding\n";
    font << ">>";
    std::string font_str = font.str();
    std::vector<char> font_vec(font_str.begin(), font_str.end());
    font_obj = createObject(font_vec);
}

int AlignmentPDF::beginPage() {
    page_content.str("");
    page_content.clear();
    return 0;
}

void AlignmentPDF::setColor(uint32_t rgb) {
    float r = ((rgb >> 24) & 0xFF) / 255.0f;
    float g = ((rgb >> 16) & 0xFF) / 255.0f;
    float b = ((rgb >> 8) & 0xFF) / 255.0f;
    page_content << std::fixed << std::setprecision(3)
                 << r << " " << g << " " << b << " rg\n"  // Fill color
                 << r << " " << g << " " << b << " RG\n"; // Stroke color
}

void AlignmentPDF::fillRect(float x, float y, float w, float h) {
    page_content << std::fixed << std::setprecision(2)
                 << x << " " << y << " " << w << " " << h << " re f\n";
}

void AlignmentPDF::drawText(const std::string& text, float x, float y, float size) {
    page_content << "BT\n";
    page_content << "/F1 " << size << " Tf\n";
    page_content << std::fixed << std::setprecision(2) << x << " " << y << " Td\n";

    // Use simple text string with escaping for special characters
    page_content << "(";
    for (unsigned char c : text) {
        // Escape special PDF characters
        if (c == '(' || c == ')' || c == '\\') {
            page_content << "\\" << c;
        } else if (c >= 32 && c <= 126) {
            page_content << c;
        } else {
            // For non-printable, use octal escape
            page_content << "\\" << std::oct << std::setw(3) << std::setfill('0')
                        << static_cast<int>(c);
        }
    }
    page_content << ") Tj\n";
    page_content << "ET\n";

    // Reset to decimal for other PDF operations
    page_content << std::dec << std::nouppercase;
}

void AlignmentPDF::beginTextBlock(float size) {
    page_content << "BT\n";
    page_content << "/F1 " << size << " Tf\n";
}

void AlignmentPDF::drawTextAt(const std::string& text, float x, float y) {
    // Use Tm for absolute positioning instead of Td for relative
    page_content << std::fixed << std::setprecision(2)
                 << "1 0 0 1 " << x << " " << y << " Tm\n";

    // Use simple text string with escaping for special characters
    page_content << "(";
    for (unsigned char c : text) {
        // Escape special PDF characters
        if (c == '(' || c == ')' || c == '\\') {
            page_content << "\\" << c;
        } else if (c >= 32 && c <= 126) {
            page_content << c;
        } else {
            // For non-printable, use octal escape
            page_content << "\\" << std::oct << std::setw(3) << std::setfill('0')
                        << static_cast<int>(c);
        }
    }
    page_content << ") Tj\n";

    // Reset to decimal for next positioning
    page_content << std::dec << std::nouppercase;
}

void AlignmentPDF::endTextBlock() {
    page_content << "ET\n";
}

void AlignmentPDF::endPage() {
    // Create page content stream only - defer Page object creation until save()
    std::string content = page_content.str();

    std::ostringstream header;
    header << "<< /Length " << content.length() << " >>\n";
    header << "stream\n";
    std::string header_str = header.str();

    std::vector<char> stream_vec;
    stream_vec.insert(stream_vec.end(), header_str.begin(), header_str.end());
    stream_vec.insert(stream_vec.end(), content.begin(), content.end());
    std::string trailer = "\nendstream";
    stream_vec.insert(stream_vec.end(), trailer.begin(), trailer.end());

    // Only create the content stream object here
    int content_obj = createObject(stream_vec);
    page_contents_.push_back(content_obj);
}

bool AlignmentPDF::save(const std::string& filename) {
    std::ofstream file(filename, std::ios::binary);
    if (!file.is_open()) return false;

    // PDF header - use write() for binary safety
    const char* header = "%PDF-1.4\n";
    file.write(header, strlen(header));
    // Binary marker (4 bytes with high bit set)
    const char binary_marker[] = "%\xE2\xE3\xCF\xD3\n";
    file.write(binary_marker, 6);

    // 1) Allocate the /Pages object number NOW (before creating Page objects)
    pages_root_obj = next_obj_num++;
    size_t pages_obj_index = objects.size();
    objects.push_back({pages_root_obj, 0, {}});

    // 2) Create Page objects with valid parent pointer
    page_objects.clear();  // Clear any old entries
    for (int content_obj : page_contents_) {
        std::ostringstream page;
        page << "<< /Type /Page\n";
        page << "   /Parent " << pages_root_obj << " 0 R\n";
        page << "   /MediaBox [0 0 " << page_width << " " << page_height << "]\n";
        page << "   /Contents " << content_obj << " 0 R\n";
        page << "   /Resources << /Font << /F1 " << font_obj << " 0 R >> >>\n";
        page << ">>";
        std::string page_str = page.str();
        std::vector<char> page_vec(page_str.begin(), page_str.end());
        int page_obj = createObject(page_vec);
        page_objects.push_back(page_obj);
    }

    // 3) Create the /Pages node listing those pages
    std::ostringstream pages;
    pages << "<< /Type /Pages\n";
    pages << "   /Kids [";
    for (int page_obj : page_objects) {
        pages << page_obj << " 0 R ";
    }
    pages << "]\n";
    pages << "   /Count " << page_objects.size() << "\n";
    pages << ">>";
    std::string pages_str = pages.str();
    std::vector<char> pages_vec(pages_str.begin(), pages_str.end());

    // Populate the reserved /Pages object slot so ordering by object number is preserved
    objects[pages_obj_index].content = pages_vec;

    // Create Catalog
    std::ostringstream catalog;
    catalog << "<< /Type /Catalog\n";
    catalog << "   /Pages " << pages_root_obj << " 0 R\n";
    catalog << ">>";
    std::string catalog_str = catalog.str();
    std::vector<char> catalog_vec(catalog_str.begin(), catalog_str.end());
    int catalog_obj = createObject(catalog_vec);

    // Write all objects and record offsets
    size_t offset = file.tellp();
    for (size_t i = 1; i < objects.size(); i++) {
        objects[i].offset = offset;

        // Write object header
        std::string obj_header = std::to_string(objects[i].number) + " 0 obj\n";
        file.write(obj_header.c_str(), obj_header.length());

        // Write object content
        file.write(objects[i].content.data(), objects[i].content.size());

        // Write object footer
        const char* obj_footer = "\nendobj\n";
        file.write(obj_footer, strlen(obj_footer));

        offset = file.tellp();
    }

    // Write xref table
    size_t xref_offset = offset;

    std::ostringstream xref;
    xref << "xref\n";
    xref << "0 " << objects.size() << "\n";
    xref << "0000000000 65535 f \n";
    for (size_t i = 1; i < objects.size(); i++) {
        xref << std::setw(10) << std::setfill('0') << objects[i].offset << " 00000 n \n";
    }
    std::string xref_str = xref.str();
    file.write(xref_str.c_str(), xref_str.length());

    // Write trailer
    std::ostringstream trailer;
    trailer << "trailer\n";
    trailer << "<< /Size " << objects.size() << "\n";
    trailer << "   /Root " << catalog_obj << " 0 R\n";
    trailer << ">>\n";
    trailer << "startxref\n";
    trailer << xref_offset << "\n";
    trailer << "%%EOF\n";
    std::string trailer_str = trailer.str();
    file.write(trailer_str.c_str(), trailer_str.length());

    size_t final_size = file.tellp();
    file.close();

    std::cout << "PDF saved: " << final_size << " bytes ("
              << (final_size / 1024) << " KB)" << std::endl;
    return true;
}
