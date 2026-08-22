/*
 * Encode key gestures the way Ghostty really does, using Ghostty's own
 * encoder (libghostty-vt), and write the bytes to stdout.
 *
 * Terminal input encoding is the part of this feature we cannot honestly fake:
 * whether "hold Alt, press 1, press 2" arrives as two escape-prefixed digits,
 * as Kitty-protocol CSI-u sequences, or with a modifier-release event, is
 * Ghostty's decision, not ours. Linking its encoder settles it.
 *
 * Build:
 *   gcc -I<ghostty>/include scripts/ghostty-keys.c \
 *       -L<ghostty>/lib -lghostty-vt -Wl,-rpath,<ghostty>/lib -o ghostty-keys
 *   (scripts/ghostty-env.sh locates a Ghostty install and does this.)
 *
 * Usage:
 *   ghostty-keys [--flags N] KEY...
 *   KEY is alt+DIGIT, DIGIT, alt-press, alt-release, or ctrl+LETTER.
 *   --flags is the Kitty keyboard flag set the application asked for; pi
 *   requests 7 (disambiguate | report events | report alternates).
 *
 * Example:
 *   ghostty-keys alt+1 alt+2 alt-release    # the two-digit chord
 */
#include <ghostty/vt.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static GhosttyKeyEncoder encoder;

static int emit(GhosttyKey key, GhosttyMods mods, GhosttyKeyAction action, const char *utf8,
                uint32_t codepoint) {
	GhosttyKeyEvent event;
	if (ghostty_key_event_new(NULL, &event) != GHOSTTY_SUCCESS) {
		fprintf(stderr, "ghostty-keys: cannot allocate key event\n");
		return 1;
	}
	ghostty_key_event_set_key(event, key);
	ghostty_key_event_set_mods(event, mods);
	ghostty_key_event_set_action(event, action);
	if (utf8) ghostty_key_event_set_utf8(event, utf8, strlen(utf8));
	if (codepoint) ghostty_key_event_set_unshifted_codepoint(event, codepoint);

	char buf[256];
	size_t len = 0;
	GhosttyResult result = ghostty_key_encoder_encode(encoder, event, buf, sizeof buf, &len);
	ghostty_key_event_free(event);
	if (result != GHOSTTY_SUCCESS) {
		fprintf(stderr, "ghostty-keys: encode failed (%d)\n", (int)result);
		return 1;
	}
	if (len) fwrite(buf, 1, len, stdout);
	return 0;
}

static const GhosttyKey DIGITS[10] = {
    GHOSTTY_KEY_DIGIT_0, GHOSTTY_KEY_DIGIT_1, GHOSTTY_KEY_DIGIT_2, GHOSTTY_KEY_DIGIT_3,
    GHOSTTY_KEY_DIGIT_4, GHOSTTY_KEY_DIGIT_5, GHOSTTY_KEY_DIGIT_6, GHOSTTY_KEY_DIGIT_7,
    GHOSTTY_KEY_DIGIT_8, GHOSTTY_KEY_DIGIT_9,
};

int main(int argc, char **argv) {
	if (ghostty_key_encoder_new(NULL, &encoder) != GHOSTTY_SUCCESS) {
		fprintf(stderr, "ghostty-keys: cannot allocate encoder\n");
		return 1;
	}
	uint8_t flags = 7;
	int argi = 1;
	if (argi + 1 < argc && strcmp(argv[argi], "--flags") == 0) {
		flags = (uint8_t)atoi(argv[argi + 1]);
		argi += 2;
	}
	ghostty_key_encoder_setopt(encoder, GHOSTTY_KEY_ENCODER_OPT_KITTY_FLAGS, &flags);

	int status = 0;
	for (; argi < argc && !status; argi++) {
		const char *arg = argv[argi];
		char text[2] = {0, 0};
		if (strcmp(arg, "alt-press") == 0) {
			status = emit(GHOSTTY_KEY_ALT_LEFT, GHOSTTY_MODS_ALT, GHOSTTY_KEY_ACTION_PRESS, NULL, 0);
		} else if (strcmp(arg, "alt-release") == 0) {
			status = emit(GHOSTTY_KEY_ALT_LEFT, 0, GHOSTTY_KEY_ACTION_RELEASE, NULL, 0);
		} else if (strncmp(arg, "alt+", 4) == 0 && arg[4] >= '0' && arg[4] <= '9' && !arg[5]) {
			text[0] = arg[4];
			status = emit(DIGITS[arg[4] - '0'], GHOSTTY_MODS_ALT, GHOSTTY_KEY_ACTION_PRESS, text,
			              (uint32_t)arg[4]);
		} else if (strncmp(arg, "ctrl+", 5) == 0 && arg[5] >= 'a' && arg[5] <= 'z' && !arg[6]) {
			text[0] = arg[5];
			status = emit((GhosttyKey)(GHOSTTY_KEY_A + (arg[5] - 'a')), GHOSTTY_MODS_CTRL,
			              GHOSTTY_KEY_ACTION_PRESS, text, (uint32_t)arg[5]);
		} else if (arg[0] >= '0' && arg[0] <= '9' && !arg[1]) {
			text[0] = arg[0];
			status = emit(DIGITS[arg[0] - '0'], 0, GHOSTTY_KEY_ACTION_PRESS, text, (uint32_t)arg[0]);
		} else {
			fprintf(stderr, "ghostty-keys: unknown key %s\n", arg);
			status = 2;
		}
	}
	fflush(stdout);
	ghostty_key_encoder_free(encoder);
	return status;
}
