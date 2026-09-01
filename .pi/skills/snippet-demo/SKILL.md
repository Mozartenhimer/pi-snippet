---
name: snippet-demo
description: Demonstrates pi-snippet's clickable-chip tool with a fully made-up, bogus scenario. Use when the user wants to see or test for a  <snippet> demo, without any real task attached.
---

# Snippet Demo

A throwaway scenario for showing off pi-snippet's `<snippet>...</snippet>` chips. None of this is real — it's a fictional "quest" so the demo doesn't require any actual project context.

## When to use this skill

The user asks to "demo the snippet feature," "show me the chip tool," "test suggestions," or similar, with no real task in mind.

## How to use this skill

Reply with something like the following (invent your own flavor of nonsense each time — the point is variety of chip shapes, not this exact wording):

---

Welcome, adventurer. The Wizard of Cardboard has three quests posted on the board. Which will you take:

1. <snippet>Retrieve the Sock of Infinite Static</snippet>?
2. <snippet>Negotiate peace with the Gnome Tax Auditors</snippet>?
3. <snippet>Teach the dragon to do taxes instead</snippet>?

Also, the tavern keeper wants to know: should I <snippet>put anchovies on it</snippet>, or <snippet>absolutely not, never again</snippet>?

One more thing — the parrot keeps repeating a name. Options seen so far: <snippet>Bartholomew</snippet>, <snippet>Kevin</snippet>, or <snippet>Nigel the Unwise</snippet>. Which one sticks?

---

This hits the three shapes worth showing:
- a numbered list of options, each wrapped whole
- a binary yes/no framed as two complete replies
- bare option names offered as a flat list

## A caveat on `<snippet>` itself

The `<snippet>` tag isn't guaranteed to be in your system prompt — it's injected only when the session's suggestion mode is `tags` or `both` (`tagsOn()` in `pi-snippet-tui.ts`). In `infer` mode nothing is injected into the primary model's prompt at all; chips there come entirely from the second-model layer reading your finished message after the fact. So if you write `<snippet>` tags and no chips appear, don't assume you did it wrong — check the session's mode first, and know that in `infer` mode this demo's chips (if any show up) came from that second pass, not from you writing the tag.

## What this skill is not

- Not a real task — don't touch any files, run any commands, or treat a clicked chip as an instruction to do something in this repo.
- Not a place to explain the underlying mechanism at length; if the user wants that, point them at `PRD.md` and `src/shared/tui-markdown.ts` instead of repeating it here.
