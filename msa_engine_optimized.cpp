#include <emscripten/bind.h>
#include <emscripten/val.h>
#include <vector>
#include <string>
#include <algorithm>
#include <unordered_map>
#include <memory>
#include <sstream>
#include <cmath>
#include <fstream>
extern "C" {
    #include "pdfgen.h"
}
#include "font_manager.h"
#include "alignment_pdf.h"

using namespace emscripten;

// Verbose engine tracing. Off in normal builds so the browser console stays
// usable; rebuild with -DSLOP_DEBUG to turn it back on. Genuine errors and
// warnings are printed unconditionally and do not use this macro.
#ifdef SLOP_DEBUG
    #define SLOP_LOG(...) printf(__VA_ARGS__)
#else
    #define SLOP_LOG(...) ((void)0)
#endif

class MSAEngine {
private:
    // Store sequences as contiguous strings for better memory locality
    std::vector<std::string> sequences;
    std::vector<std::string> sequence_names;

    // Store pre-translated amino acid sequences
    std::vector<std::string> amino_acid_sequences;
    bool amino_acid_translations_valid = false;

    // Selection stored as ranges, not individual cells
    int selection_start_row = -1;
    int selection_start_col = -1;
    int selection_end_row = -1;
    int selection_end_col = -1;

    // Cache for frequent operations
    mutable int cached_max_length = -1;
    mutable std::vector<char> consensus_cache;
    mutable bool consensus_dirty = true;

    // Static color maps
    static const std::unordered_map<char, uint32_t> nucleotide_colors;
    static const std::unordered_map<char, uint32_t> amino_acid_colors;

    // Genetic code tables
    static const std::unordered_map<std::string, std::unordered_map<std::string, char>> genetic_codes;

    // Scoring parameters (customizable)
    int gap_open_penalty = -10;
    int gap_extend_penalty = -1;
    int match_score = 2;
    int mismatch_penalty = -1;

    // Codon mode parameters
    bool codon_mode_enabled = false;
    int codon_phase = 0; // 0, 1, or 2 (representing phase 1, 2, 3)
    std::string genetic_code_name = "standard";
    bool is_dna_sequences = false;

public:
    MSAEngine() {
        sequences.reserve(1000);  // Pre-allocate for large datasets
        sequence_names.reserve(1000);
    }

    // Methods to set scoring parameters
    void setGapOpenPenalty(int penalty) { gap_open_penalty = penalty; }
    void setGapExtendPenalty(int penalty) { gap_extend_penalty = penalty; }
    void setMatchScore(int score) { match_score = score; }
    void setMismatchPenalty(int penalty) { mismatch_penalty = penalty; }

    // Methods to get current scoring parameters
    int getGapOpenPenalty() { return gap_open_penalty; }
    int getGapExtendPenalty() { return gap_extend_penalty; }
    int getMatchScore() { return match_score; }
    int getMismatchPenalty() { return mismatch_penalty; }

    // Codon mode methods
    void setCodonMode(bool enabled) { codon_mode_enabled = enabled; }
    bool getCodonMode() { return codon_mode_enabled; }

    void setCodonPhase(int phase) {
        if (phase >= 1 && phase <= 3) {
            codon_phase = phase - 1; // Store as 0-based
        }
    }
    int getCodonPhase() { return codon_phase + 1; } // Return as 1-based

    void setGeneticCode(const std::string& code) { genetic_code_name = code; }
    std::string getGeneticCode() { return genetic_code_name; }

    bool isDNA() { return is_dna_sequences; }

    // Check if sequences are DNA (only ACGT and gaps)
    void checkIfDNA() {
        is_dna_sequences = true;
        for (const auto& seq : sequences) {
            for (char c : seq) {
                if (c != 'A' && c != 'C' && c != 'G' && c != 'T' && c != '-' && c != 'N') {
                    is_dna_sequences = false;
                    return;
                }
            }
        }
    }

    // Translate a codon to amino acid using the current genetic code
    char translateCodon(const std::string& codon) {
        if (codon.length() != 3) return 'X';

        // Handle complete gap codon first
        if (codon == "---") return '-';

        // Handle incomplete codons (containing gaps) - return '?' for uncertain translation
        if (codon.find('-') != std::string::npos) return '?';

        // Get the appropriate genetic code table
        auto code_it = genetic_codes.find(genetic_code_name);
        if (code_it == genetic_codes.end()) {
            code_it = genetic_codes.find("standard");
        }

        auto aa_it = code_it->second.find(codon);
        if (aa_it != code_it->second.end()) {
            return aa_it->second;
        }

        return 'X'; // Unknown codon
    }

    // Get amino acid character for a position in codon mode
    char getAminoAcidAt(int seq_idx, int pos) {
        if (!codon_mode_enabled || seq_idx >= sequences.size()) {
            return ' ';
        }

        // Simple approach: treat pos as the start of the codon
        // JavaScript should only call this for codon start positions
        if (pos < 0 || pos + 2 >= sequences[seq_idx].length()) {
            return ' ';
        }

        std::string codon = sequences[seq_idx].substr(pos, 3);
        return translateCodon(codon);
    }

    // Get three-letter amino acid code
    std::string getThreeLetterCode(char aa) {
        static std::unordered_map<char, std::string> three_letter = {
            {'A', "Ala"}, {'C', "Cys"}, {'D', "Asp"}, {'E', "Glu"},
            {'F', "Phe"}, {'G', "Gly"}, {'H', "His"}, {'I', "Ile"},
            {'K', "Lys"}, {'L', "Leu"}, {'M', "Met"}, {'N', "Asn"},
            {'P', "Pro"}, {'Q', "Gln"}, {'R', "Arg"}, {'S', "Ser"},
            {'T', "Thr"}, {'V', "Val"}, {'W', "Trp"}, {'Y', "Tyr"},
            {'*', "STP"}, {'-', "---"}, {'X', "???"}, {'?', "???"}
        };

        auto it = three_letter.find(aa);
        if (it != three_letter.end()) {
            return it->second;
        }
        return "???";
    }

    // Translate a single sequence to amino acids
    // Returns translated sequence with amino acids at codon start positions, spaces elsewhere
    std::string translateSequence(int seqIdx) {
        if (seqIdx < 0 || seqIdx >= sequences.size()) {
            return "";
        }

        const std::string& seq = sequences[seqIdx];
        int seqLen = seq.length();
        std::string translated(seqLen, ' '); // Initialize with spaces

        // Translate each codon
        for (int i = codon_phase; i + 2 < seqLen; i += 3) {
            std::string codon = seq.substr(i, 3);
            char aa = translateCodon(codon);
            translated[i] = aa; // Store amino acid at codon start position
        }

        return translated;
    }

    // Translate a region of a sequence (from startCol onwards)
    void translateSequenceRegion(int seqIdx, int startCol) {
        if (seqIdx < 0 || seqIdx >= sequences.size() || seqIdx >= amino_acid_sequences.size()) {
            return;
        }

        const std::string& seq = sequences[seqIdx];
        int seqLen = seq.length();
        std::string& translated = amino_acid_sequences[seqIdx];

        // Ensure translated sequence is the right size
        if (translated.length() != seqLen) {
            translated.resize(seqLen, ' ');
        }

        // Find the first codon start position at or after startCol
        int firstCodonStart = startCol;
        if (codon_phase > 0) {
            int offset = (startCol - codon_phase);
            if (offset < 0) {
                firstCodonStart = codon_phase;
            } else {
                int remainder = offset % 3;
                firstCodonStart = startCol + (remainder == 0 ? 0 : (3 - remainder));
            }
        } else {
            int remainder = startCol % 3;
            firstCodonStart = startCol + (remainder == 0 ? 0 : (3 - remainder));
        }

        // Clear affected positions first (set to space)
        for (int i = startCol; i < seqLen; i++) {
            translated[i] = ' ';
        }

        // Translate from first codon start onwards
        for (int i = firstCodonStart; i + 2 < seqLen; i += 3) {
            std::string codon = seq.substr(i, 3);
            char aa = translateCodon(codon);
            translated[i] = aa; // Store amino acid at codon start position
        }
    }

    // Translate all sequences completely
    void translateAllSequences() {
        SLOP_LOG("translateAllSequences called, sequences.size=%zu, codon_phase=%d\n", sequences.size(), codon_phase);
        amino_acid_sequences.clear();
        amino_acid_sequences.resize(sequences.size());

        for (size_t i = 0; i < sequences.size(); i++) {
            amino_acid_sequences[i] = translateSequence(i);
            if (i == 0) {
                SLOP_LOG("Translated seq 0: '%s'\n", amino_acid_sequences[i].substr(0, 30).c_str());
            }
        }

        amino_acid_translations_valid = true;
        SLOP_LOG("Translation complete, valid=%d\n", amino_acid_translations_valid);
    }

    // Translate a range of sequences
    void translateSequenceRange(int startSeq, int endSeq) {
        if (amino_acid_sequences.size() != sequences.size()) {
            amino_acid_sequences.resize(sequences.size());
        }

        startSeq = std::max(0, startSeq);
        endSeq = std::min(endSeq, (int)sequences.size());

        for (int i = startSeq; i < endSeq; i++) {
            amino_acid_sequences[i] = translateSequence(i);
        }

        amino_acid_translations_valid = true;
    }

    // Invalidate translations (call when sequences are edited outside codon mode)
    void invalidateTranslations() {
        amino_acid_translations_valid = false;
    }

    // Get amino acid color for a codon at position
    uint32_t getCodonColor(int seq_idx, int pos) {
        if (!codon_mode_enabled || seq_idx >= sequences.size() || pos < 0) {
            // Return regular nucleotide color when not in codon mode
            char c = getCharAt(seq_idx, pos);
            auto color_it = nucleotide_colors.find(c);
            if (color_it != nucleotide_colors.end()) {
                return color_it->second;
            }
            return 0xF0F0F0FF; // Default gray
        }

        // Calculate codon position
        int codon_start = ((pos - codon_phase) / 3) * 3 + codon_phase;
        if (codon_start < 0 || codon_start + 2 >= sequences[seq_idx].length()) {
            return 0xF0F0F0FF; // Gray for incomplete codons
        }

        std::string codon = sequences[seq_idx].substr(codon_start, 3);
        char aa = translateCodon(codon);

        auto color_it = amino_acid_colors.find(aa);
        if (color_it != amino_acid_colors.end()) {
            return color_it->second;
        }

        return 0xCCCCCCFF; // Default gray
    }

    void loadFASTA(const std::string& fasta_content) {
        sequences.clear();
        sequence_names.clear();
        sequences.reserve(1000);
        sequence_names.reserve(1000);

        std::string current_seq;
        current_seq.reserve(10000);  // Pre-allocate for long sequences
        std::string current_name;

        size_t pos = 0;
        size_t content_len = fasta_content.length();

        while (pos < content_len) {
            size_t line_end = fasta_content.find('\n', pos);
            if (line_end == std::string::npos) line_end = content_len;

            if (pos < line_end) {  // Non-empty line
                if (fasta_content[pos] == '>') {
                    if (!current_seq.empty()) {
                        sequences.emplace_back(std::move(current_seq));
                        sequence_names.emplace_back(std::move(current_name));
                        current_seq.clear();
                        current_seq.reserve(10000);
                    }
                    current_name = fasta_content.substr(pos + 1, line_end - pos - 1);
                } else {
                    // Append sequence data directly
                    for (size_t i = pos; i < line_end; i++) {
                        char c = fasta_content[i];
                        if (c != ' ' && c != '\t' && c != '\r') {
                            current_seq += toupper(c);
                        }
                    }
                }
            }
            pos = line_end + 1;
        }

        if (!current_seq.empty()) {
            sequences.emplace_back(std::move(current_seq));
            sequence_names.emplace_back(std::move(current_name));
        }

        // Reset caches
        cached_max_length = -1;
        consensus_dirty = true;

        // Invalidate amino acid translations
        invalidateTranslations();

        // Check if sequences are DNA
        checkIfDNA();
    }

    void loadPHYLIP(const std::string& phylip_content) {
        sequences.clear();
        sequence_names.clear();

        std::istringstream input(phylip_content);
        std::string line;

        // Read header line
        if (!std::getline(input, line)) return;

        // Parse header - should be two numbers: num_sequences and seq_length
        std::istringstream header(line);
        int num_sequences = 0, seq_length = 0;
        header >> num_sequences >> seq_length;

        if (num_sequences <= 0 || seq_length <= 0) return;

        sequences.reserve(num_sequences);
        sequence_names.reserve(num_sequences);

        // Initialize sequences
        for (int i = 0; i < num_sequences; i++) {
            sequences.push_back("");
            sequences[i].reserve(seq_length);
        }

        // Try to detect if it's interleaved or sequential
        std::vector<std::string> lines;
        while (std::getline(input, line)) {
            // Skip empty lines and whitespace
            if (line.find_first_not_of(" \t\r\n") != std::string::npos) {
                lines.push_back(line);
            }
        }

        if (lines.empty()) return;

        // Check if it's interleaved or sequential
        bool is_interleaved = false;

        // For sequential format, we expect num_sequences blocks of continuous sequence
        // For interleaved, we expect names to repeat

        // First pass: read the first block (names and initial sequences)
        int current_seq = 0;
        size_t line_idx = 0;

        // Read first block with names
        while (current_seq < num_sequences && line_idx < lines.size()) {
            const std::string& current_line = lines[line_idx++];

            // PHYLIP format: first 10 characters are the name (padded with spaces)
            // Some variants allow longer names or use tabs
            std::string name;
            std::string seq_data;

            // Handle both strict (10-char) and relaxed PHYLIP formats
            size_t name_end = current_line.find_first_of(" \t");
            if (name_end == std::string::npos || name_end > 10) {
                // Strict format: take first 10 chars as name
                name = current_line.substr(0, std::min((size_t)10, current_line.length()));
                if (current_line.length() > 10) {
                    seq_data = current_line.substr(10);
                }
            } else {
                // Relaxed format: name ends at first whitespace
                name = current_line.substr(0, name_end);
                seq_data = current_line.substr(name_end);
            }

            // Trim whitespace from name
            name.erase(name.find_last_not_of(" \t") + 1);
            if (name.empty()) name = "Seq" + std::to_string(current_seq + 1);

            sequence_names.push_back(name);

            // Process sequence data
            for (char c : seq_data) {
                if (c != ' ' && c != '\t' && c != '\r' && c != '\n' && c >= 0) {
                    sequences[current_seq] += toupper(c);
                }
            }

            current_seq++;
        }

        // Now determine if remaining lines are interleaved or sequential
        if (line_idx < lines.size()) {
            // Check if the pattern suggests interleaved (cycling through sequences)
            // or sequential (all data for one sequence before moving to next)

            // Simple heuristic: if we've read significant sequence data already,
            // and there are many lines left, it's probably interleaved
            size_t avg_seq_len = 0;
            for (const auto& seq : sequences) {
                avg_seq_len += seq.length();
            }
            avg_seq_len /= num_sequences;

            is_interleaved = (avg_seq_len < seq_length / 2) &&
                           (lines.size() - line_idx) > num_sequences;
        }

        // Continue reading based on format
        if (is_interleaved) {
            // Interleaved format: cycle through sequences
            while (line_idx < lines.size()) {
                for (int seq_idx = 0; seq_idx < num_sequences && line_idx < lines.size(); seq_idx++) {
                    const std::string& current_line = lines[line_idx++];

                    // In interleaved continuation, lines usually don't have names
                    // Just sequence data
                    for (char c : current_line) {
                        if (c != ' ' && c != '\t' && c != '\r' && c != '\n' && c >= 0) {
                            sequences[seq_idx] += toupper(c);
                        }
                    }
                }
            }
        } else {
            // Sequential format: continue reading remaining sequences
            current_seq = 0;

            // Find where we are in sequential reading
            while (current_seq < num_sequences && sequences[current_seq].length() >= seq_length) {
                current_seq++;
            }

            // Continue with remaining sequences
            while (current_seq < num_sequences && line_idx < lines.size()) {
                const std::string& current_line = lines[line_idx++];

                // Add to current sequence
                for (char c : current_line) {
                    if (c != ' ' && c != '\t' && c != '\r' && c != '\n' && c >= 0) {
                        sequences[current_seq] += toupper(c);
                    }
                }

                // Move to next sequence if current is complete
                if (sequences[current_seq].length() >= seq_length) {
                    current_seq++;
                }
            }
        }

        // Ensure all sequences have the same length (pad with gaps if needed)
        size_t max_len = 0;
        for (const auto& seq : sequences) {
            max_len = std::max(max_len, seq.length());
        }

        for (auto& seq : sequences) {
            while (seq.length() < max_len) {
                seq += '-';
            }
        }

        // Reset caches
        cached_max_length = -1;
        consensus_dirty = true;

        // Invalidate amino acid translations
        invalidateTranslations();

        // Check if sequences are DNA
        checkIfDNA();
    }

    // Optimized getters that return raw data for batch processing
    std::string getSequenceData(int seq_idx) {
        if (seq_idx >= 0 && seq_idx < sequences.size()) {
            return sequences[seq_idx];
        }
        return "";
    }

    // Get character at position - inline for speed
    inline char getCharAt(int seq_idx, int pos_idx) {
        if (seq_idx >= 0 && seq_idx < sequences.size() &&
            pos_idx >= 0 && pos_idx < sequences[seq_idx].length()) {
            return sequences[seq_idx][pos_idx];
        }
        return ' ';
    }

    // Wrapper for JavaScript that takes char code instead of char
    uint32_t getColorForCharacter(int charCode) {
        return getColorInt(static_cast<char>(charCode));
    }

    // Return color as integer for faster transfer
    uint32_t getColorInt(char c) {
        // Updated color scheme for nucleotides
        static const std::unordered_map<char, uint32_t> nuc_colors = {
            {'A', 0xFF0000},  // Red
            {'T', 0x87CEEB},  // Light Blue (Sky Blue)
            {'G', 0xFFD700},  // Yellow (Gold)
            {'C', 0x00FF00},  // Green
            {'U', 0x87CEEB},  // Light Blue (same as T)
            {'-', 0xF0F0F0},  // Very light gray for gaps
            {'N', 0xE0E0E0}   // Light gray for ambiguous
        };

        // Check if this is a DNA sequence - only use nucleotide colors for DNA
        if (is_dna_sequences) {
            auto nuc_it = nuc_colors.find(c);
            if (nuc_it != nuc_colors.end()) return nuc_it->second;
        }

        // For protein sequences or characters not in nucleotide set, use amino acid colors
        auto aa_it = amino_acid_colors.find(c);
        if (aa_it != amino_acid_colors.end()) {
            // Remove the FF alpha suffix since getRenderData expects RGB only
            return aa_it->second >> 8;
        }

        return 0x95A5A6; // Default gray
    }

    // Batch operations for rendering
    val getRenderData(int startRow, int endRow, int startCol, int endCol, bool aminoAcidMode = false) {
        val result = val::object();
        val rows = val::array();

        // Ensure valid bounds
        startRow = std::max(0, startRow);
        endRow = std::min(endRow, (int)sequences.size());
        startCol = std::max(0, startCol);
        endCol = std::max(0, endCol);

        for (int r = startRow; r < endRow && r < sequences.size(); r++) {
            val row = val::object();
            const std::string& seq = sequences[r];
            int seqLen = seq.length();

            std::string visibleChars;
            val colors = val::array();

            // Use pre-translated amino acid sequences if in amino acid display mode
            if (r == 0 && startCol == 0) {
                SLOP_LOG("getRenderData: aminoAcidMode=%d, codon_mode=%d, valid=%d, size=%zu\n",
                    aminoAcidMode, codon_mode_enabled, amino_acid_translations_valid, amino_acid_sequences.size());
            }
            if (aminoAcidMode && codon_mode_enabled && amino_acid_translations_valid && r < amino_acid_sequences.size()) {
                const std::string& aa_seq = amino_acid_sequences[r];
                for (int c = startCol; c < endCol; c++) {
                    if (c < aa_seq.length()) {
                        char aa = aa_seq[c];
                        visibleChars += aa;
                        // Get color for amino acid (or space)
                        if (aa != ' ') {
                            colors.call<void>("push", getCodonColor(r, c));
                        } else {
                            colors.call<void>("push", 0);
                        }
                    } else {
                        visibleChars += ' ';
                        colors.call<void>("push", 0);
                    }
                }
            } else {
                // Normal nucleotide or codon mode
                for (int c = startCol; c < endCol; c++) {
                    if (c < seqLen) {
                        visibleChars += seq[c];
                        // Use codon color if in codon mode, otherwise regular nucleotide color
                        if (codon_mode_enabled) {
                            colors.call<void>("push", getCodonColor(r, c));
                        } else {
                            colors.call<void>("push", getColorInt(seq[c]));
                        }
                    } else {
                        // Pad with spaces if beyond sequence length
                        visibleChars += ' ';
                        colors.call<void>("push", getColorInt(' '));
                    }
                }
            }

            row.set("chars", visibleChars);
            row.set("colors", colors);
            row.set("name", sequence_names[r]);
            rows.call<void>("push", row);
        }

        result.set("rows", rows);
        return result;
    }

    void startSelection(int row, int col) {
        selection_start_row = row;
        selection_start_col = col;
        selection_end_row = row;
        selection_end_col = col;
    }

    void updateSelection(int row, int col) {
        selection_end_row = row;
        selection_end_col = col;
    }

    void clearSelection() {
        selection_start_row = -1;
        selection_start_col = -1;
        selection_end_row = -1;
        selection_end_col = -1;
    }

    bool isSelected(int row, int col) {
        if (selection_start_row < 0) return false;

        int min_row = std::min(selection_start_row, selection_end_row);
        int max_row = std::max(selection_start_row, selection_end_row);
        int min_col = std::min(selection_start_col, selection_end_col);
        int max_col = std::max(selection_start_col, selection_end_col);

        return row >= min_row && row <= max_row && col >= min_col && col <= max_col;
    }

    // Optimized gap operations
    void removeGapsFromSelection() {
        if (selection_start_row < 0) return;

        int min_row = std::min(selection_start_row, selection_end_row);
        int max_row = std::max(selection_start_row, selection_end_row);
        int min_col = std::min(selection_start_col, selection_end_col);
        int max_col = std::max(selection_start_col, selection_end_col);

        for (int row = min_row; row <= max_row && row < sequences.size(); row++) {
            std::string& seq = sequences[row];
            std::string new_seq;
            new_seq.reserve(seq.length());

            for (int i = 0; i < seq.length(); i++) {
                if (i < min_col || i > max_col || seq[i] != '-') {
                    new_seq += seq[i];
                }
            }
            seq = std::move(new_seq);
        }

        // Pad all sequences to the same length after removing gaps
        padSequencesToMaxLength();

        consensus_dirty = true;
        // Invalidate cached max length since sequences may have changed length
        cached_max_length = -1;
    }

    // Helper function to pad all sequences to the same length
    void padSequencesToMaxLength() {
        int max_len = 0;
        for (const auto& seq : sequences) {
            max_len = std::max(max_len, (int)seq.length());
        }

        // Pad shorter sequences with gaps
        for (auto& seq : sequences) {
            if (seq.length() < max_len) {
                seq.append(max_len - seq.length(), '-');
            }
        }
    }

    void dragEdit(int delta_col) {
        if (selection_start_row < 0 || delta_col == 0) return;

        int min_row = std::min(selection_start_row, selection_end_row);
        int max_row = std::max(selection_start_row, selection_end_row);
        int min_col = std::min(selection_start_col, selection_end_col);
        int max_col = std::max(selection_start_col, selection_end_col);

        if (delta_col > 0) {
            // Moving right - insert gaps to the left of selection
            std::string gaps(delta_col, '-');
            for (int row = min_row; row <= max_row && row < sequences.size(); row++) {
                sequences[row].insert(min_col, gaps);
            }
            selection_start_col += delta_col;
            selection_end_col += delta_col;

            // Pad all other sequences to match the new maximum length
            padSequencesToMaxLength();
        } else if (delta_col < 0) {
            // Moving left - remove gaps from the left of selection if they exist
            int abs_delta = -delta_col;
            int gaps_removed = 0;

            // Check how many gaps we can actually remove
            for (int row = min_row; row <= max_row && row < sequences.size(); row++) {
                int gaps_available = 0;
                for (int i = 1; i <= abs_delta && min_col - i >= 0; i++) {
                    if (sequences[row][min_col - i] == '-') {
                        gaps_available++;
                    } else {
                        break; // Stop if we hit a non-gap
                    }
                }
                gaps_removed = (row == min_row) ? gaps_available : std::min(gaps_removed, gaps_available);
            }

            // Remove the gaps
            if (gaps_removed > 0) {
                for (int row = min_row; row <= max_row && row < sequences.size(); row++) {
                    sequences[row].erase(min_col - gaps_removed, gaps_removed);
                }
                selection_start_col -= gaps_removed;
                selection_end_col -= gaps_removed;
            }
            // Don't insert gaps on the right - just don't move if can't go left
        }

        consensus_dirty = true;
        // Invalidate cached max length since sequences may have grown
        cached_max_length = -1;
    }

    // Lazy consensus calculation
    std::string getConsensusRange(int startCol, int endCol) {
        int max_len = getMaxLength();
        endCol = std::min(endCol, max_len);

        std::string result;
        result.reserve(endCol - startCol);

        for (int pos = startCol; pos < endCol; pos++) {
            std::unordered_map<char, int> counts;
            int max_count = 0;
            char max_char = '-';

            for (const auto& seq : sequences) {
                if (pos < seq.length() && seq[pos] != '-') {
                    int count = ++counts[seq[pos]];
                    if (count > max_count) {
                        max_count = count;
                        max_char = seq[pos];
                    }
                }
            }
            result += max_char;
        }
        return result;
    }

    // Get amino acid consensus for codon mode
    std::string getAminoAcidConsensusRange(int startCol, int endCol) {
        if (!codon_mode_enabled) {
            return getConsensusRange(startCol, endCol);
        }

        int max_len = getMaxLength();
        endCol = std::min(endCol, max_len);

        std::string result;
        result.reserve(endCol - startCol);

        const int phase = codon_phase - 1;

        for (int pos = startCol; pos < endCol; pos++) {
            // Always calculate amino acid consensus for every position
            // The JavaScript will handle which positions to display
            std::unordered_map<char, int> aa_counts;
            int max_count = 0;
            char max_aa = '-';

            // For positions before phase, just add a gap
            const int adjustedPos = pos - phase;
            if (adjustedPos < 0) {
                result += '-';
                continue;
            }

            // Get the codon start position for this column
            int codon_start = (adjustedPos / 3) * 3 + phase;

            for (int seq_idx = 0; seq_idx < sequences.size(); seq_idx++) {
                // Get the amino acid for the codon that contains this position
                char aa = getAminoAcidAt(seq_idx, codon_start);
                if (aa != ' ' && aa != '-') {
                    int count = ++aa_counts[aa];
                    if (count > max_count) {
                        max_count = count;
                        max_aa = aa;
                    }
                }
            }

            result += max_aa;
        }
        return result;
    }

    float getConservation(int pos) {
        if (sequences.empty() || pos < 0) return 0.0;

        std::unordered_map<char, int> counts;
        int total = 0;

        for (const auto& seq : sequences) {
            if (pos < seq.length() && seq[pos] != '-') {
                counts[seq[pos]]++;
                total++;
            }
        }

        if (total == 0) return 0.0;

        int max_count = 0;
        for (const auto& pair : counts) {
            max_count = std::max(max_count, pair.second);
        }

        return (float)max_count / total * 100.0;
    }

    int getSequenceCount() { return sequences.size(); }

    int getMaxLength() {
        if (cached_max_length < 0) {
            cached_max_length = 0;
            for (const auto& seq : sequences) {
                cached_max_length = std::max(cached_max_length, (int)seq.length());
            }
        }
        return cached_max_length;
    }

    std::string getSequenceName(int idx) {
        return (idx >= 0 && idx < sequence_names.size()) ? sequence_names[idx] : "";
    }

    val getSelectionBounds() {
        val bounds = val::object();
        if (selection_start_row >= 0) {
            bounds.set("minRow", std::min(selection_start_row, selection_end_row));
            bounds.set("maxRow", std::max(selection_start_row, selection_end_row));
            bounds.set("minCol", std::min(selection_start_col, selection_end_col));
            bounds.set("maxCol", std::max(selection_start_col, selection_end_col));
        } else {
            bounds.set("minRow", -1);
        }
        return bounds;
    }

    // Calculate alignment score with affine gap penalties
    int calculateScore() {
        int score = 0;

        // Simple scoring: penalize gaps, reward matches
        for (const auto& seq : sequences) {
            bool in_gap = false;
            for (char c : seq) {
                if (c == '-') {
                    score += in_gap ? gap_extend_penalty : gap_open_penalty;
                    in_gap = true;
                } else {
                    in_gap = false;
                }
            }
        }

        // Add match/mismatch scoring for conservation
        int max_len = getMaxLength();
        for (int pos = 0; pos < max_len; pos++) {
            std::unordered_map<char, int> counts;
            int total = 0;
            for (const auto& seq : sequences) {
                if (pos < seq.length() && seq[pos] != '-') {
                    counts[seq[pos]]++;
                    total++;
                }
            }
            if (total > 1) {
                int max_count = 0;
                for (const auto& pair : counts) {
                    max_count = std::max(max_count, pair.second);
                }
                // Reward conservation
                score += (max_count - 1) * match_score;
                score += (total - max_count) * mismatch_penalty;
            }
        }

        return score;
    }

    // Reorder sequences
    void moveSequence(int from_idx, int to_idx) {
        if (from_idx < 0 || from_idx >= sequences.size() ||
            to_idx < 0 || to_idx >= sequences.size() ||
            from_idx == to_idx) return;

        std::string seq = sequences[from_idx];
        std::string name = sequence_names[from_idx];

        if (from_idx < to_idx) {
            // Moving down
            for (int i = from_idx; i < to_idx; i++) {
                sequences[i] = sequences[i + 1];
                sequence_names[i] = sequence_names[i + 1];
            }
        } else {
            // Moving up
            for (int i = from_idx; i > to_idx; i--) {
                sequences[i] = sequences[i - 1];
                sequence_names[i] = sequence_names[i - 1];
            }
        }

        sequences[to_idx] = seq;
        sequence_names[to_idx] = name;
    }

    // Select entire row
    void selectRow(int row) {
        if (row >= 0 && row < sequences.size()) {
            selection_start_row = row;
            selection_end_row = row;
            selection_start_col = 0;
            selection_end_col = getMaxLength() - 1;
            if (selection_end_col < 0) selection_end_col = 0;
        }
    }

    // Select entire column
    void selectColumn(int col) {
        if (col >= 0 && col < getMaxLength()) {
            selection_start_row = 0;
            selection_end_row = sequences.size() - 1;
            selection_start_col = col;
            selection_end_col = col;
        }
    }

    // ========== PDF EXPORT FUNCTIONALITY ==========

    // Helper: Convert RGB color to PDF color (0.0 - 1.0 range)
    struct PDFColor {
        float r, g, b;
        static PDFColor fromRGB(uint32_t color) {
            PDFColor c;
            c.r = ((color >> 24) & 0xFF) / 255.0f;
            c.g = ((color >> 16) & 0xFF) / 255.0f;
            c.b = ((color >> 8) & 0xFF) / 255.0f;
            return c;
        }
    };

    // Test font loading with FreeType
    val testFontLoading(const std::string& font_path) {
        FontManager font_mgr;

        if (!font_mgr.loadFontFromFile(font_path.c_str())) {
            return val("Failed to load font");
        }

        // Get and print font metrics
        FontMetrics metrics = font_mgr.getFontMetrics();

        std::stringstream ss;
        ss << "Font loaded successfully!\n";
        ss << "Name: " << font_mgr.getFontName() << "\n";
        ss << "Glyphs: " << font_mgr.getNumGlyphs() << "\n";
        ss << "Ascent: " << metrics.ascent << "\n";
        ss << "Descent: " << metrics.descent << "\n";
        ss << "Cap Height: " << metrics.cap_height << "\n";
        ss << "Units per EM: " << metrics.units_per_em << "\n";
        ss << "Fixed pitch: " << (metrics.is_fixed_pitch ? "Yes" : "No") << "\n";
        ss << "BBox: [" << metrics.bbox[0] << ", " << metrics.bbox[1]
           << ", " << metrics.bbox[2] << ", " << metrics.bbox[3] << "]\n";

        // Test glyph metrics for ACGT
        for (char c : {'A', 'C', 'G', 'T', '-'}) {
            GlyphMetrics glyph;
            if (font_mgr.getGlyphMetrics(c, glyph)) {
                ss << "Glyph '" << c << "': width=" << glyph.width
                   << ", advance=" << glyph.advance_x << "\n";
            }
        }

        return val(ss.str());
    }

    // Export alignment to PDF with optional progress callback
    // Returns PDF bytes as a JavaScript Uint8Array
    val exportToPDF(
        int start_row, int end_row,
        int start_col, int end_col,
        float cell_width, float cell_height,
        bool landscape,
        bool include_labels,
        bool include_ruler,
        val progress_callback = val::null()
    ) {
        // Page dimensions (Letter size in points: 1 point = 1/72 inch)
        float page_width = landscape ? 792.0f : 612.0f;  // 11" x 8.5" or 8.5" x 11"
        float page_height = landscape ? 612.0f : 792.0f;

        // Margins
        float margin_left = 36.0f;   // 0.5 inch
        float margin_right = 36.0f;
        float margin_top = 36.0f;
        float margin_bottom = 36.0f;

        // Calculate available space
        // Dynamically calculate label width based on longest sequence name
        float label_width = 0.0f;
        if (include_labels) {
            size_t max_name_len = 0;
            for (int i = start_row; i <= end_row && i < sequences.size(); i++) {
                max_name_len = std::max(max_name_len, sequence_names[i].length());
            }
            // Courier-Bold at 8pt is ~4.8 points per character (monospace)
            label_width = (max_name_len * 4.8f) + 6.0f; // +6 for minimal padding
        }
        float ruler_height = include_ruler ? 20.0f : 0.0f;

        float content_width = page_width - margin_left - margin_right - label_width;
        float content_height = page_height - margin_top - margin_bottom - ruler_height;

        // Calculate cells per page
        int cells_per_page_h = static_cast<int>(content_width / cell_width);
        int cells_per_page_v = static_cast<int>(content_height / cell_height);

        // Clamp to actual data bounds
        if (start_row < 0) start_row = 0;
        if (end_row >= sequences.size()) end_row = sequences.size() - 1;
        if (start_col < 0) start_col = 0;
        int max_len = getMaxLength();
        if (end_col >= max_len) end_col = max_len - 1;

        int total_rows = end_row - start_row + 1;
        int total_cols = end_col - start_col + 1;

        // Calculate number of pages needed
        int pages_h = static_cast<int>(std::ceil(static_cast<float>(total_cols) / cells_per_page_h));
        int pages_v = static_cast<int>(std::ceil(static_cast<float>(total_rows) / cells_per_page_v));
        int total_pages = pages_h * pages_v;

        // Create PDF
        struct pdf_info info = {0};
        snprintf(info.creator, sizeof(info.creator), "SLOP");
        snprintf(info.producer, sizeof(info.producer), "SLOP MSA Viewer");
        snprintf(info.title, sizeof(info.title), "Multiple Sequence Alignment");
        snprintf(info.author, sizeof(info.author), "SLOP User");
        snprintf(info.subject, sizeof(info.subject), "DNA/Protein Alignment Export");

        struct pdf_doc *pdf = pdf_create(page_width, page_height, &info);
        if (!pdf) {
            return val::null();
        }

        pdf_set_font(pdf, "Courier-Bold");

        // Generate pages
        for (int page_v = 0; page_v < pages_v; page_v++) {
            for (int page_h = 0; page_h < pages_h; page_h++) {
                // Report progress if callback provided
                int current_page = page_v * pages_h + page_h + 1;
                if (!progress_callback.isNull()) {
                    float progress = (static_cast<float>(current_page) / total_pages) * 100.0f;
                    progress_callback(current_page, total_pages, progress);
                }

                pdf_append_page(pdf);

                // Calculate visible range for this page
                int vis_start_col = start_col + (page_h * cells_per_page_h);
                int vis_end_col = std::min(vis_start_col + cells_per_page_h - 1, end_col);
                int vis_start_row = start_row + (page_v * cells_per_page_v);
                int vis_end_row = std::min(vis_start_row + cells_per_page_v - 1, end_row);

                float x_offset = margin_left + label_width;
                float y_offset = page_height - margin_top - ruler_height;

                // Draw ruler if enabled (every 10 columns)
                if (include_ruler) {
                    for (int col = vis_start_col; col <= vis_end_col; col++) {
                        // Only show every 10th position
                        if ((col + 1) % 10 == 0) {
                            float x = x_offset + (col - vis_start_col) * cell_width;
                            float y = page_height - margin_top;

                            char pos_str[16];
                            snprintf(pos_str, sizeof(pos_str), "%d", col + 1);
                            pdf_add_text(pdf, NULL, pos_str, 7, x + 2, y - 12, PDF_RGB(100, 100, 100));
                        }
                    }
                }

                // Draw sequence labels if enabled
                if (include_labels) {
                    for (int row = vis_start_row; row <= vis_end_row; row++) {
                        float y = y_offset - (row - vis_start_row) * cell_height;
                        std::string name = getSequenceName(row);
                        // Don't truncate - we calculated label_width to fit all names
                        // Use smaller font to prevent overlap
                        float label_font_size = std::min(8.0f, cell_height * 0.6f);
                        pdf_add_text(pdf, NULL, name.c_str(), label_font_size, margin_left + 2,
                                   y - cell_height + 2, PDF_RGB(50, 50, 50));
                    }
                }

                // Draw alignment cells
                for (int row = vis_start_row; row <= vis_end_row; row++) {
                    for (int col = vis_start_col; col <= vis_end_col; col++) {
                        char c = getCharAt(row, col);
                        uint32_t color = getColorForCharacter(c);
                        PDFColor pdf_color = PDFColor::fromRGB(color);

                        float x = x_offset + (col - vis_start_col) * cell_width;
                        float y = y_offset - (row - vis_start_row) * cell_height;

                        // Draw cell background
                        uint32_t fill_color = PDF_RGB(
                            static_cast<int>(pdf_color.r * 255),
                            static_cast<int>(pdf_color.g * 255),
                            static_cast<int>(pdf_color.b * 255)
                        );
                        pdf_add_filled_rectangle(pdf, NULL, x, y - cell_height,
                                               cell_width, cell_height,
                                               0.0f, // border width (no border)
                                               fill_color,
                                               fill_color); // border color same as fill

                        // Draw character (black text on colored background)
                        char char_str[2] = {c, '\0'};
                        float font_size = cell_height * 0.7f;
                        pdf_add_text(pdf, NULL, char_str, font_size,
                                   x + cell_width * 0.25f, y - cell_height + 2,
                                   PDF_BLACK);
                    }
                }

                // Add page number footer
                char footer[64];
                snprintf(footer, sizeof(footer), "Page %d of %d",
                        page_v * pages_h + page_h + 1, total_pages);
                pdf_add_text(pdf, NULL, footer, 8,
                           page_width / 2 - 30, margin_bottom / 2,
                           PDF_RGB(100, 100, 100));
            }
        }

        // Save to virtual filesystem
        const char *temp_file = "/tmp/alignment_export.pdf";
        int save_result = pdf_save(pdf, temp_file);

        if (save_result < 0) {
            pdf_destroy(pdf);
            return val::null();
        }

        // Read file back as bytes
        std::ifstream file(temp_file, std::ios::binary | std::ios::ate);
        std::streamsize size = file.tellg();
        file.seekg(0, std::ios::beg);

        std::vector<uint8_t> buffer(size);
        if (!file.read(reinterpret_cast<char*>(buffer.data()), size)) {
            pdf_destroy(pdf);
            return val::null();
        }

        // Convert to JavaScript Uint8Array
        val uint8Array = val::global("Uint8Array").new_(size);
        for (size_t i = 0; i < buffer.size(); i++) {
            uint8Array.call<void>("set", val::array(std::vector<uint8_t>{buffer[i]}), i);
        }

        pdf_destroy(pdf);
        return uint8Array;
    }

    // Export to PDF with TrueType font support (JetBrains Mono)
    val exportToPDFWithFont(
        int start_row, int end_row,
        int start_col, int end_col,
        float cell_width, float cell_height,
        bool landscape,
        bool include_labels,
        bool include_ruler,
        const std::string& font_path,
        val color_scheme,  // JavaScript object with color mappings
        bool use_amino_acid_mode,  // Whether to use amino acid display mode
        bool use_codon_mode,
        val progress_callback = val::null()
    ) {
        bool codon_mode_active = use_codon_mode && codon_mode_enabled;

        // Page dimensions
        float page_width = landscape ? 792.0f : 612.0f;
        float page_height = landscape ? 612.0f : 792.0f;

        // Margins
        float margin_left = 36.0f;
        float margin_right = 36.0f;
        float margin_top = 36.0f;
        float margin_bottom = 36.0f;

        // Calculate label width
        float label_width = 0.0f;
        if (include_labels) {
            size_t max_name_len = 0;
            for (int i = start_row; i <= end_row && i < sequences.size(); i++) {
                max_name_len = std::max(max_name_len, sequence_names[i].length());
            }
            label_width = (max_name_len * 4.8f) + 6.0f;
        }

        float ruler_height = include_ruler ? 20.0f : 0.0f;

        // Available space for alignment
        float avail_width = page_width - margin_left - margin_right - label_width;
        float avail_height = page_height - margin_top - margin_bottom;
        if (include_ruler) {
            avail_height -= ruler_height;
        }

        int cols_per_page = std::max(1, static_cast<int>(avail_width / cell_width));
        float rows_per_page_f = avail_height / cell_height;
        int rows_per_page = std::max(1, static_cast<int>(rows_per_page_f));

        int total_cols_nuc = end_col - start_col + 1;
        int total_rows = end_row - start_row + 1;

        int phase = codon_phase;
        int amino_start_index = 0;
        int amino_end_index = 0;
        int total_cols_render = total_cols_nuc;

        if (use_amino_acid_mode && codon_mode_active) {
            int adjusted_start = std::max(0, start_col - phase);
            int adjusted_end = std::max(0, end_col - phase);
            amino_start_index = adjusted_start / 3;
            amino_end_index = adjusted_end / 3;
            total_cols_render = std::max(1, amino_end_index - amino_start_index + 1);
        }

        // Wrapping configuration
        bool enable_wrapping = false;
        int blocks_per_page = 1;
        float block_spacing_rows = 2.0f;  // Visual spacing between blocks (in row units)

        SLOP_LOG("DEBUG: Initial values - total_rows=%d, total_cols_render=%d, rows_per_page=%d, cols_per_page=%d\n",
               total_rows, total_cols_render, rows_per_page, cols_per_page);

        // Determine if wrapping would be beneficial
        // Enable wrapping if we're using less than 50% of vertical space
        float rows_used_ratio = rows_per_page_f > 0.0f
            ? (static_cast<float>(total_rows) / rows_per_page_f)
            : 1.0f;
        SLOP_LOG("DEBUG: rows_used_ratio=%.2f\n", rows_used_ratio);

        if (rows_used_ratio < 0.5f && total_cols_render > cols_per_page) {
            // Calculate how many blocks we can fit vertically
            float block_height_rows = static_cast<float>(total_rows) + block_spacing_rows;
            if (include_ruler && cell_height > 0.0f) {
                block_height_rows += (ruler_height / cell_height);
            }

            int potential_blocks = static_cast<int>(std::floor(rows_per_page_f / block_height_rows));

            // Only enable wrapping if we can fit at least 2 blocks and it's beneficial
            if (potential_blocks >= 2) {
                enable_wrapping = true;
                blocks_per_page = potential_blocks;

                // Limit blocks per page to what we actually need
                int total_col_blocks = (total_cols_render + cols_per_page - 1) / cols_per_page;
                if (blocks_per_page > total_col_blocks) {
                    blocks_per_page = total_col_blocks;
                }
            }
        }

        // Calculate total pages based on wrapping mode
        int total_pages;
        if (enable_wrapping) {
            int total_col_blocks = (total_cols_render + cols_per_page - 1) / cols_per_page;
            total_pages = (total_col_blocks + blocks_per_page - 1) / blocks_per_page;
            SLOP_LOG("DEBUG: Wrapping enabled - blocks_per_page=%d, total_col_blocks=%d, total_pages=%d\n",
                   blocks_per_page, total_col_blocks, total_pages);
        } else {
            // Traditional grid pagination
            int pages_h = (total_cols_render + cols_per_page - 1) / cols_per_page;
            int pages_v = (total_rows + rows_per_page - 1) / rows_per_page;
            total_pages = pages_h * pages_v;
            SLOP_LOG("DEBUG: Traditional pagination - pages_h=%d, pages_v=%d, total_pages=%d\n",
                   pages_h, pages_v, total_pages);
        }

        // Create PDF with TrueType font
        AlignmentPDF pdf(page_width, page_height);

        SLOP_LOG("DEBUG: Loading font from: %s\n", font_path.c_str());
        bool font_loaded = pdf.loadFont(font_path);
        if (!font_loaded) {
            printf("WARNING: Failed to load font from %s - continuing with default\n", font_path.c_str());
            // Don't fail completely - we can still test the logic
            // return val::null();
        } else {
            SLOP_LOG("DEBUG: Font loaded successfully\n");
        }

        // Ensure amino acid translations are available when needed
        if (codon_mode_active && use_amino_acid_mode && !amino_acid_translations_valid) {
            translateSequenceRange(start_row, end_row + 1);
        }

        auto applyColorFromScheme = [&](char symbol, uint32_t& color) -> bool {
            if (color_scheme.isNull() || color_scheme.isUndefined()) {
                return false;
            }
            std::string key(1, symbol);
            val color_val = color_scheme[key];
            if (color_val.isNull() || color_val.isUndefined()) {
                return false;
            }
            std::string color_hex = color_val.as<std::string>();
            if (color_hex.empty()) {
                return false;
            }
            if (color_hex[0] == '#') color_hex = color_hex.substr(1);
            uint32_t parsed = std::stoul(color_hex, nullptr, 16);
            color = (parsed << 8) | 0xFF;
            return true;
        };

        auto getCodonColorForPosition = [&](int seq_idx, int nuc_col, uint32_t& color, char& aa_char) {
            aa_char = ' ';
            if (!codon_mode_active || seq_idx >= sequences.size()) {
                return;
            }
            int offset = nuc_col - phase;
            if (offset < 0) {
                return;
            }
            int codon_index = offset / 3;
            int codon_start = codon_index * 3 + phase;
            if (codon_start < 0 || codon_start + 2 >= sequences[seq_idx].length()) {
                return;
            }
            std::string codon = sequences[seq_idx].substr(codon_start, 3);
            aa_char = translateCodon(codon);
            uint32_t codon_color = getCodonColor(seq_idx, codon_start);
            color = codon_color;
            applyColorFromScheme(aa_char, color);
        };

        auto getAminoCharAt = [&](int seq_idx, int amino_idx) -> char {
            if (seq_idx < 0 || seq_idx >= sequences.size()) return ' ';
            int codon_start = phase + amino_idx * 3;
            if (codon_start < 0 || codon_start + 2 >= sequences[seq_idx].length()) return ' ';
            std::string codon = sequences[seq_idx].substr(codon_start, 3);
            return translateCodon(codon);
        };

        auto renderAminoBlock = [&](AlignmentPDF& pdf, float x_offset, float y_offset,
                                    int row, int block_start, int block_end) {
            for (int aa_idx = block_start; aa_idx <= block_end; aa_idx++) {
                char aa_char = getAminoCharAt(row, aa_idx);
                uint32_t color = getColorForCharacter(aa_char);
                applyColorFromScheme(aa_char, color);

                float x = x_offset + (aa_idx - block_start) * cell_width;
                pdf.setColor(color);
                pdf.fillRect(x, y_offset, cell_width, cell_height);
            }

            pdf.setColor(0x000000FF);
            pdf.beginTextBlock(cell_height * 0.7f);
            for (int aa_idx = block_start; aa_idx <= block_end; aa_idx++) {
                char aa_char = getAminoCharAt(row, aa_idx);
                float x = x_offset + (aa_idx - block_start) * cell_width;
                std::string char_str(1, aa_char);
                pdf.drawTextAt(char_str, x + 2, y_offset + cell_height * 0.3f);
            }
            pdf.endTextBlock();
        };

        auto renderNucleotideBlock = [&](AlignmentPDF& pdf, float x_offset, float y_offset,
                                         int row, int block_start_col, int block_end_col) {
            // Backgrounds
            for (int col = block_start_col; col <= block_end_col; col++) {
                if (col >= sequences[row].length()) continue;

                char nucleotide = sequences[row][col];
                uint32_t color = getColorForCharacter(nucleotide);

                if (codon_mode_active) {
                    char aa_char = ' ';
                    getCodonColorForPosition(row, col, color, aa_char);
                } else {
                    applyColorFromScheme(nucleotide, color);
                }

                float x = x_offset + (col - block_start_col) * cell_width;
                pdf.setColor(color);
                pdf.fillRect(x, y_offset, cell_width, cell_height);
            }

            // Text
            pdf.setColor(0x000000FF);
            pdf.beginTextBlock(cell_height * 0.7f);
            for (int col = block_start_col; col <= block_end_col; col++) {
                if (col >= sequences[row].length()) continue;
                char nucleotide = sequences[row][col];
                float x = x_offset + (col - block_start_col) * cell_width;
                std::string char_str(1, nucleotide);
                pdf.drawTextAt(char_str, x + 2, y_offset + cell_height * 0.3f);
            }
            pdf.endTextBlock();
        };

        auto drawPageHeader = [&](AlignmentPDF& pdf, int page_index) {
            std::string header = std::to_string(page_index + 1) + "/" + std::to_string(total_pages);
            float font_size = 8.0f;
            float y = page_height - (margin_top * 0.6f);
            if (y > page_height - 8.0f) {
                y = page_height - 8.0f;
            }
            float approx_width = header.length() * font_size * 0.6f;
            float x = page_width - margin_right - approx_width;
            pdf.setColor(0x000000FF);
            pdf.drawText(header, x, y, font_size);
        };

        // Generate pages with optional wrapping
        if (enable_wrapping) {
            int total_col_blocks = (total_cols_render + cols_per_page - 1) / cols_per_page;
            int current_col_block = 0;

            for (int page_num = 0; page_num < total_pages; page_num++) {
                if (!progress_callback.isNull()) {
                    float progress = (static_cast<float>(page_num + 1) / total_pages) * 100.0f;
                    progress_callback(page_num + 1, total_pages, progress);
                }

                int blocks_on_this_page = std::min(blocks_per_page, total_col_blocks - current_col_block);
                if (blocks_on_this_page <= 0) {
                    break;
                }

                pdf.beginPage();

                for (int block_idx = 0; block_idx < blocks_on_this_page; block_idx++) {
                    int block_start_render = current_col_block * cols_per_page;
                    int block_end_render = std::min(block_start_render + cols_per_page - 1,
                                                    total_cols_render - 1);

                    float block_height = (total_rows * cell_height) + (block_spacing_rows * cell_height);
                    if (include_ruler) {
                        block_height += ruler_height;
                    }
                    float x_offset = margin_left + label_width;
                    float y_offset = page_height - margin_top - ruler_height - (block_idx * block_height);

                    if (use_amino_acid_mode && codon_mode_active) {
                        int block_start_aa = amino_start_index + block_start_render;
                        int block_end_aa = amino_start_index + block_end_render;

                        if (include_ruler) {
                            pdf.beginTextBlock(7.0f);
                            pdf.setColor(0x646464FF);
                            for (int aa_idx = block_start_aa; aa_idx <= block_end_aa; aa_idx++) {
                                if (((aa_idx + 1) % 10) == 0) {
                                    float x = x_offset + (aa_idx - block_start_aa) * cell_width;
                                    char pos_str[16];
                                    snprintf(pos_str, sizeof(pos_str), "%d", aa_idx + 1);
                                    pdf.drawTextAt(pos_str, x + 2, y_offset + 8);
                                }
                            }
                            pdf.endTextBlock();
                        }

                        for (int row = start_row; row <= end_row; row++) {
                            if (row >= sequences.size()) break;

                            float y = y_offset - ((row - start_row) + 1) * cell_height;

                            if (include_labels) {
                                float label_size = std::min(8.0f, cell_height * 0.6f);
                                pdf.setColor(0x000000FF);
                                pdf.drawText(sequence_names[row], margin_left, y + cell_height * 0.3f, label_size);
                            }

                            renderAminoBlock(pdf, x_offset, y, row, block_start_aa, block_end_aa);
                        }
                    } else {
                        int block_start_col = start_col + block_start_render;
                        int block_end_col = start_col + block_end_render;

                        if (include_ruler) {
                            pdf.beginTextBlock(7.0f);
                            pdf.setColor(0x646464FF);
                            for (int col = block_start_col; col <= block_end_col; col++) {
                                if ((col + 1) % 10 == 0) {
                                    float x = x_offset + (col - block_start_col) * cell_width;
                                    char pos_str[16];
                                    snprintf(pos_str, sizeof(pos_str), "%d", col + 1);
                                    pdf.drawTextAt(pos_str, x + 2, y_offset + 8);
                                }
                            }
                            pdf.endTextBlock();
                        }

                        for (int row = start_row; row <= end_row; row++) {
                            if (row >= sequences.size()) break;

                            float y = y_offset - ((row - start_row) + 1) * cell_height;

                            if (include_labels) {
                                float label_size = std::min(8.0f, cell_height * 0.6f);
                                pdf.setColor(0x000000FF);
                                pdf.drawText(sequence_names[row], margin_left, y + cell_height * 0.3f, label_size);
                            }

                            renderNucleotideBlock(pdf, x_offset, y, row, block_start_col, block_end_col);
                        }
                    }

                    current_col_block++;
                }

                drawPageHeader(pdf, page_num);
                pdf.endPage();
            }
        } else {
            int pages_h = (total_cols_render + cols_per_page - 1) / cols_per_page;
            int pages_v = (total_rows + rows_per_page - 1) / rows_per_page;

            for (int page_v = 0; page_v < pages_v; page_v++) {
                for (int page_h = 0; page_h < pages_h; page_h++) {
                    int current_page = page_v * pages_h + page_h + 1;

                    if (!progress_callback.isNull()) {
                        float progress = (static_cast<float>(current_page) / total_pages) * 100.0f;
                        progress_callback(current_page, total_pages, progress);
                    }

                    pdf.beginPage();

                    int page_start_render = page_h * cols_per_page;
                    int page_end_render = std::min(page_start_render + cols_per_page - 1,
                                                   total_cols_render - 1);
                    int page_start_row = start_row + (page_v * rows_per_page);
                    int page_end_row = std::min(page_start_row + rows_per_page - 1, end_row);

                    float x_offset = margin_left + label_width;
                    float y_offset = page_height - margin_top - ruler_height;

                    if (use_amino_acid_mode && codon_mode_active) {
                        int block_start_aa = amino_start_index + page_start_render;
                        int block_end_aa = amino_start_index + page_end_render;

                        if (include_ruler) {
                            pdf.beginTextBlock(7.0f);
                            pdf.setColor(0x646464FF);
                            for (int aa_idx = block_start_aa; aa_idx <= block_end_aa; aa_idx++) {
                                if (((aa_idx + 1) % 10) == 0) {
                                    float x = x_offset + (aa_idx - block_start_aa) * cell_width;
                                    char pos_str[16];
                                    snprintf(pos_str, sizeof(pos_str), "%d", aa_idx + 1);
                                    pdf.drawTextAt(pos_str, x + 2, y_offset + 8);
                                }
                            }
                            pdf.endTextBlock();
                        }

                        for (int row = page_start_row; row <= page_end_row; row++) {
                            if (row >= sequences.size()) break;

                            float y = y_offset - ((row - page_start_row) + 1) * cell_height;

                            if (include_labels) {
                                float label_size = std::min(8.0f, cell_height * 0.6f);
                                pdf.setColor(0x000000FF);
                                pdf.drawText(sequence_names[row], margin_left, y + cell_height * 0.3f, label_size);
                            }

                            renderAminoBlock(pdf, x_offset, y, row, block_start_aa, block_end_aa);
                        }
                    } else {
                        int page_start_col = start_col + page_start_render;
                        int page_end_col = start_col + page_end_render;

                        if (include_ruler) {
                            pdf.beginTextBlock(7.0f);
                            pdf.setColor(0x646464FF);
                            for (int col = page_start_col; col <= page_end_col; col++) {
                                if ((col + 1) % 10 == 0) {
                                    float x = x_offset + (col - page_start_col) * cell_width;
                                    char pos_str[16];
                                    snprintf(pos_str, sizeof(pos_str), "%d", col + 1);
                                    pdf.drawTextAt(pos_str, x + 2, y_offset + 8);
                                }
                            }
                            pdf.endTextBlock();
                        }

                        for (int row = page_start_row; row <= page_end_row; row++) {
                            if (row >= sequences.size()) break;

                            float y = y_offset - ((row - page_start_row) + 1) * cell_height;

                            if (include_labels) {
                                float label_size = std::min(8.0f, cell_height * 0.6f);
                                pdf.setColor(0x000000FF);
                                pdf.drawText(sequence_names[row], margin_left, y + cell_height * 0.3f, label_size);
                            }

                            renderNucleotideBlock(pdf, x_offset, y, row, page_start_col, page_end_col);
                        }
                    }

                    drawPageHeader(pdf, current_page - 1);
                    pdf.endPage();
                }
            }
        }

        // Save to temp file
        const char* temp_file = "/tmp/alignment_custom_font.pdf";
        SLOP_LOG("DEBUG: Attempting to save PDF to %s\n", temp_file);
        if (!pdf.save(temp_file)) {
            printf("ERROR: pdf.save() returned false\n");
            return val::null();
        }
        SLOP_LOG("DEBUG: PDF saved successfully\n");

        // Read file back using C FILE API for better binary handling in Emscripten
        FILE* fp = fopen(temp_file, "rb");
        if (!fp) {
            return val::null();
        }

        // Get file size
        fseek(fp, 0, SEEK_END);
        long file_size = ftell(fp);
        fseek(fp, 0, SEEK_SET);

        // Read into buffer
        std::vector<uint8_t> buffer(file_size);
        size_t bytes_read = fread(buffer.data(), 1, file_size, fp);
        fclose(fp);

        if (bytes_read != file_size) {
            printf("ERROR: bytes_read (%zu) != file_size (%ld)\n", bytes_read, file_size);
            return val::null();
        }

        SLOP_LOG("DEBUG: PDF file read successfully: %zu bytes (%.0f KB)\n", bytes_read, bytes_read / 1024.0);

        // Copy into a fresh Uint8Array so the data survives past this scope
        val uint8Array = val::global("Uint8Array").new_(static_cast<unsigned int>(buffer.size()));
        uint8Array.call<void>("set", val(typed_memory_view(buffer.size(), buffer.data())));
        return uint8Array;
    }
};

// Define static color maps
const std::unordered_map<char, uint32_t> MSAEngine::nucleotide_colors = {
    {'A', 0xFF0000FF}, // Red
    {'C', 0x00FF00FF}, // Green
    {'G', 0xFFD700FF}, // Yellow/Gold
    {'T', 0x87CEEBFF}, // Light Blue
    {'U', 0x87CEEBFF}, // Light Blue (for RNA)
    {'-', 0xF0F0F0FF}, // Very light gray for gaps
    {'N', 0xCCCCCCFF}  // Gray for unknown
};

const std::unordered_map<char, uint32_t> MSAEngine::amino_acid_colors = {
    // Hydrophobic (light yellow/orange tones)
    {'A', 0xFFEB99FF}, // Alanine - Light Gold
    {'V', 0xFFCC99FF}, // Valine - Light Peach
    {'I', 0xFFD4AAFF}, // Isoleucine - Light Apricot
    {'L', 0xFFDCB4FF}, // Leucine - Pale Orange
    {'M', 0xFFE599FF}, // Methionine - Light Gold
    {'F', 0xFFB3A6FF}, // Phenylalanine - Light Salmon
    {'W', 0xFFBB99FF}, // Tryptophan - Light Coral
    {'P', 0xFFFF99FF}, // Proline - Light Yellow

    // Polar (light green tones)
    {'S', 0xB4FFB4FF}, // Serine - Very Light Green
    {'T', 0x99FFD6FF}, // Threonine - Light Mint
    {'N', 0x99FF99FF}, // Asparagine - Light Green
    {'Q', 0xA6FFA6FF}, // Glutamine - Pale Green
    {'C', 0xD4FF99FF}, // Cysteine - Light Yellow Green
    {'Y', 0xC6FF99FF}, // Tyrosine - Light Lime

    // Positively charged (light blue tones)
    {'K', 0x99CCFFFF}, // Lysine - Light Sky Blue
    {'R', 0xA6C8FFFF}, // Arginine - Light Periwinkle
    {'H', 0xB3D9FFFF}, // Histidine - Pale Blue

    // Negatively charged (light red/pink tones)
    {'D', 0xFFB3B3FF}, // Aspartic Acid - Light Pink
    {'E', 0xFFCCCCFF}, // Glutamic Acid - Light Rose

    // Special
    {'G', 0xE6E6E6FF}, // Glycine - Very Light Gray
    {'*', 0x999999FF}, // Stop - Medium Gray (not black)
    {'-', 0xF8F8F8FF}, // Gap - Near White
    {'X', 0xCCCCCCFF}  // Unknown - Light Gray
};

// Define genetic code tables
const std::unordered_map<std::string, std::unordered_map<std::string, char>> MSAEngine::genetic_codes = {
    {"standard", {
        {"TTT", 'F'}, {"TTC", 'F'}, {"TTA", 'L'}, {"TTG", 'L'},
        {"TCT", 'S'}, {"TCC", 'S'}, {"TCA", 'S'}, {"TCG", 'S'},
        {"TAT", 'Y'}, {"TAC", 'Y'}, {"TAA", '*'}, {"TAG", '*'},
        {"TGT", 'C'}, {"TGC", 'C'}, {"TGA", '*'}, {"TGG", 'W'},
        {"CTT", 'L'}, {"CTC", 'L'}, {"CTA", 'L'}, {"CTG", 'L'},
        {"CCT", 'P'}, {"CCC", 'P'}, {"CCA", 'P'}, {"CCG", 'P'},
        {"CAT", 'H'}, {"CAC", 'H'}, {"CAA", 'Q'}, {"CAG", 'Q'},
        {"CGT", 'R'}, {"CGC", 'R'}, {"CGA", 'R'}, {"CGG", 'R'},
        {"ATT", 'I'}, {"ATC", 'I'}, {"ATA", 'I'}, {"ATG", 'M'},
        {"ACT", 'T'}, {"ACC", 'T'}, {"ACA", 'T'}, {"ACG", 'T'},
        {"AAT", 'N'}, {"AAC", 'N'}, {"AAA", 'K'}, {"AAG", 'K'},
        {"AGT", 'S'}, {"AGC", 'S'}, {"AGA", 'R'}, {"AGG", 'R'},
        {"GTT", 'V'}, {"GTC", 'V'}, {"GTA", 'V'}, {"GTG", 'V'},
        {"GCT", 'A'}, {"GCC", 'A'}, {"GCA", 'A'}, {"GCG", 'A'},
        {"GAT", 'D'}, {"GAC", 'D'}, {"GAA", 'E'}, {"GAG", 'E'},
        {"GGT", 'G'}, {"GGC", 'G'}, {"GGA", 'G'}, {"GGG", 'G'}
    }},
    {"vertebrate_mito", {
        {"TTT", 'F'}, {"TTC", 'F'}, {"TTA", 'L'}, {"TTG", 'L'},
        {"TCT", 'S'}, {"TCC", 'S'}, {"TCA", 'S'}, {"TCG", 'S'},
        {"TAT", 'Y'}, {"TAC", 'Y'}, {"TAA", '*'}, {"TAG", '*'},
        {"TGT", 'C'}, {"TGC", 'C'}, {"TGA", 'W'}, {"TGG", 'W'}, // TGA codes for W instead of stop
        {"CTT", 'L'}, {"CTC", 'L'}, {"CTA", 'L'}, {"CTG", 'L'},
        {"CCT", 'P'}, {"CCC", 'P'}, {"CCA", 'P'}, {"CCG", 'P'},
        {"CAT", 'H'}, {"CAC", 'H'}, {"CAA", 'Q'}, {"CAG", 'Q'},
        {"CGT", 'R'}, {"CGC", 'R'}, {"CGA", 'R'}, {"CGG", 'R'},
        {"ATT", 'I'}, {"ATC", 'I'}, {"ATA", 'M'}, {"ATG", 'M'}, // ATA codes for M instead of I
        {"ACT", 'T'}, {"ACC", 'T'}, {"ACA", 'T'}, {"ACG", 'T'},
        {"AAT", 'N'}, {"AAC", 'N'}, {"AAA", 'K'}, {"AAG", 'K'},
        {"AGT", 'S'}, {"AGC", 'S'}, {"AGA", '*'}, {"AGG", '*'}, // AGA, AGG are stops instead of R
        {"GTT", 'V'}, {"GTC", 'V'}, {"GTA", 'V'}, {"GTG", 'V'},
        {"GCT", 'A'}, {"GCC", 'A'}, {"GCA", 'A'}, {"GCG", 'A'},
        {"GAT", 'D'}, {"GAC", 'D'}, {"GAA", 'E'}, {"GAG", 'E'},
        {"GGT", 'G'}, {"GGC", 'G'}, {"GGA", 'G'}, {"GGG", 'G'}
    }}
    // Add more genetic codes as needed
};

EMSCRIPTEN_BINDINGS(msa_engine) {
    class_<MSAEngine>("MSAEngine")
        .constructor()
        .function("loadFASTA", &MSAEngine::loadFASTA)
        .function("loadPHYLIP", &MSAEngine::loadPHYLIP)
        .function("getSequenceData", &MSAEngine::getSequenceData)
        .function("getCharAt", &MSAEngine::getCharAt)
        .function("getRenderData", &MSAEngine::getRenderData, allow_raw_pointers())
        .function("getColorForCharacter", &MSAEngine::getColorForCharacter)
        .function("startSelection", &MSAEngine::startSelection)
        .function("updateSelection", &MSAEngine::updateSelection)
        .function("clearSelection", &MSAEngine::clearSelection)
        .function("isSelected", &MSAEngine::isSelected)
        .function("removeGapsFromSelection", &MSAEngine::removeGapsFromSelection)
        .function("dragEdit", &MSAEngine::dragEdit)
        .function("getConsensusRange", &MSAEngine::getConsensusRange)
        .function("getAminoAcidConsensusRange", &MSAEngine::getAminoAcidConsensusRange)
        .function("getConservation", &MSAEngine::getConservation)
        .function("getSequenceCount", &MSAEngine::getSequenceCount)
        .function("getMaxLength", &MSAEngine::getMaxLength)
        .function("getSequenceName", &MSAEngine::getSequenceName)
        .function("getSelectionBounds", &MSAEngine::getSelectionBounds)
        .function("calculateScore", &MSAEngine::calculateScore)
        .function("moveSequence", &MSAEngine::moveSequence)
        .function("selectRow", &MSAEngine::selectRow)
        .function("selectColumn", &MSAEngine::selectColumn)
        .function("setGapOpenPenalty", &MSAEngine::setGapOpenPenalty)
        .function("setGapExtendPenalty", &MSAEngine::setGapExtendPenalty)
        .function("setMatchScore", &MSAEngine::setMatchScore)
        .function("setMismatchPenalty", &MSAEngine::setMismatchPenalty)
        .function("getGapOpenPenalty", &MSAEngine::getGapOpenPenalty)
        .function("getGapExtendPenalty", &MSAEngine::getGapExtendPenalty)
        .function("getMatchScore", &MSAEngine::getMatchScore)
        .function("getMismatchPenalty", &MSAEngine::getMismatchPenalty)
        .function("setCodonMode", &MSAEngine::setCodonMode)
        .function("getCodonMode", &MSAEngine::getCodonMode)
        .function("setCodonPhase", &MSAEngine::setCodonPhase)
        .function("getCodonPhase", &MSAEngine::getCodonPhase)
        .function("setGeneticCode", &MSAEngine::setGeneticCode)
        .function("getGeneticCode", &MSAEngine::getGeneticCode)
        .function("isDNA", &MSAEngine::isDNA)
        .function("getCodonColor", &MSAEngine::getCodonColor)
        .function("getAminoAcidAt", &MSAEngine::getAminoAcidAt)
        .function("getThreeLetterCode", &MSAEngine::getThreeLetterCode)
        .function("translateAllSequences", &MSAEngine::translateAllSequences)
        .function("translateSequenceRange", &MSAEngine::translateSequenceRange)
        .function("translateSequenceRegion", &MSAEngine::translateSequenceRegion)
        .function("invalidateTranslations", &MSAEngine::invalidateTranslations)
        .function("exportToPDF", &MSAEngine::exportToPDF)
        .function("exportToPDFWithFont", &MSAEngine::exportToPDFWithFont)
        .function("testFontLoading", &MSAEngine::testFontLoading);
}
