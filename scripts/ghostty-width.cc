/*
 * Print Ghostty's own display width for codepoints, one "U+XXXX<TAB>width"
 * line each, so our hit-testing width table can be diffed against the
 * terminal's real one.
 *
 * Click hit-testing converts a character index into a screen column, which is
 * only correct if we agree with the terminal about how many cells each glyph
 * occupies. Guessing that table is how off-by-one click bugs are born, so we
 * ask Ghostty (libghostty-vt exports ghostty::CodepointWidth).
 *
 * Usage: ghostty-width [START END | --all]   (default: a representative sample)
 * Build via scripts/ghostty-env.sh.
 */
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <string>

namespace ghostty {
// Exported by libghostty-vt as ghostty::CodepointWidth(unsigned int). It
// returns a byte: declaring a wider return type reads uninitialised high bits
// and yields nonsense like 49154 instead of 2.
std::uint8_t CodepointWidth(std::uint32_t codepoint);
}  // namespace ghostty

static void dump(std::uint32_t from, std::uint32_t to) {
	for (std::uint32_t cp = from; cp <= to; cp++) {
		// Surrogates are not real codepoints.
		if (cp >= 0xD800 && cp <= 0xDFFF) continue;
		std::printf("U+%04X\t%u\n", cp, (unsigned)ghostty::CodepointWidth(cp));
	}
}

int main(int argc, char **argv) {
	if (argc == 2 && std::string(argv[1]) == "--all") {
		dump(0x20, 0x10FFFF);
		return 0;
	}
	if (argc == 3) {
		dump((std::uint32_t)strtoul(argv[1], nullptr, 0), (std::uint32_t)strtoul(argv[2], nullptr, 0));
		return 0;
	}
	dump(0x20, 0x2FFF);      // Latin, punctuation, superscripts, circled digits, arrows
	dump(0x3000, 0x33FF);    // CJK punctuation and kana
	dump(0x4E00, 0x4E20);    // CJK ideographs (sample)
	dump(0xFF00, 0xFF70);    // Fullwidth forms
	dump(0x1F300, 0x1F320);  // Emoji (sample)
	dump(0x1F900, 0x1F910);
	return 0;
}
