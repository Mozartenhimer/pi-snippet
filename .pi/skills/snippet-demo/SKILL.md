---
name: snippet-demo
description: Demonstrates pi-snippet's clickable-chip tool with a fully made-up, bogus scenario. Use when the user wants to see or test a suggestion-chip demo, without any real task attached.
---

# Snippet Demo

A throwaway scenario for showing off pi-snippet's clickable chips. None of this is real — it's a fictional "quest" so the demo doesn't require any actual project context.

## When to use this skill

The user asks to "demo the snippet feature," "show me the chip tool," "test suggestions," or similar, with no real task in mind.

## How to use this skill

Reply with something like the following (invent your own flavor of nonsense each time — the point is variety of chip shapes, not this exact wording), marking each candidate reply the way your system prompt instructs:

---

Welcome, adventurer. The Wizard of Cardboard has three quests posted on the board. Which will you take:

1. Retrieve the Sock of Infinite Static?
2. Negotiate peace with the Gnome Tax Auditors?
3. Teach the dragon to do taxes instead?

Also, the tavern keeper wants to know: should I put anchovies on it, or absolutely not, never again?

One more thing — the parrot keeps repeating a name. Options seen so far: Bartholomew, Kevin, or Nigel the Unwise. Which one sticks?

---

This hits the three shapes worth showing:
- a numbered list of options, each wrapped whole
- a binary yes/no framed as two complete replies
- bare option names offered as a flat list

## A caveat on chips appearing at all

Whether a candidate reply becomes a clickable chip depends on the session's suggestion mode, which you don't control. If you mark up replies as instructed and no chips appear, don't assume you did it wrong — the session may be configured so that chips come from a separate pass over your finished message rather than from anything in your own output.

## What this skill is not

- Not a real task — don't touch any files, run any commands, or treat a clicked chip as an instruction to do something in this repo.
- Not a place to explain the underlying mechanism at length; if the user wants that, point them at `PRD.md` and `src/shared/tui-markdown.ts` instead of repeating it here.
