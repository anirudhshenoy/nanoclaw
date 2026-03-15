---
name: second-brain
description: Persistent research assistant that tracks topics, surfaces new content on a schedule, accumulates knowledge in a two-tier archive, and deepens understanding over time. Use when the user mentions topics, research tracking, "second brain", "add topic", "go deeper", "what do I know about", "show frontier", or any knowledge management command.
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, WebSearch, WebFetch, TodoWrite, mcp__nanoclaw__send_message, mcp__nanoclaw__schedule_task, mcp__nanoclaw__pause_task, mcp__nanoclaw__resume_task, mcp__nanoclaw__cancel_task, mcp__nanoclaw__update_task
---

# Second Brain System

A persistent, ambient research assistant. Two-tier storage: an *archive* (append-only ground truth) and an *active layer* (small frontier map of what's unknown and what's next). The archive is never compressed or summarized. The active layer is rewritten periodically.

---

## Data Model

All data lives at `/workspace/group/second-brain/`.

```
second-brain/
  topics/
    {topic-slug}/
      meta.json        # Classification and parameters
      active.md        # Small frontier map (rewritten, never appended)
      sources.json     # Append-only URL dedup list
      archive/         # Session-chunked research notes
        {YYYY-MM-DD}-{session-id}.md
  config.json          # Global config (optional)
```

### meta.json

```json
{
  "name": "Antifragility",
  "slug": "antifragility",
  "half_life": "durable",
  "source_type": "research-driven",
  "created": "2026-03-14",
  "scheduler_frequency": "weekly",
  "archive_ttl_days": null,
  "status": "broad",
  "prior_knowledge": "Familiar with core concept and barbell strategy."
}
```

- `half_life`: `"ephemeral"` | `"fast-moving"` | `"durable"`
- `source_type`: `"event-driven"` | `"analysis-driven"` | `"research-driven"`
- `status`: `"broad"` (discovery phase) | `"deep"` (focused on specific threads) | `"paused"`
- `scheduler_frequency`: `"4h"` | `"daily"` | `"weekly"` — derived from classification
- `archive_ttl_days`: `30` (ephemeral) | `180` (fast-moving) | `null` (durable, indefinite)

#### Classification → scheduling strategy

| Half-life | Source type | Scheduler freq | Archive TTL | Cron expression |
|---|---|---|---|---|
| Ephemeral | Event-driven | Every 4 hours | 30 days | `0 */4 * * *` |
| Fast-moving | Analysis-driven | Daily | 6 months | `0 9 * * *` |
| Durable | Research-driven | Weekly | Indefinite | `0 9 * * 1` |

Default to `durable` / `research-driven` unless the topic is clearly ephemeral or fast-moving. Do not ask the user for classification unless genuinely ambiguous.

### active.md

Small, fixed-size document. Rewritten in full by the compression task. Structure depends on topic type.

**For durable / fast-moving topics:**

```markdown
## Status
Broad — initial discovery phase.

## Settled (do not resurface)
- [concepts the user already knows, seeded from prior_knowledge]

## Frontier (search targets)
- [gaps to search for — what's unknown, unexplored, or only surface-level]

## Open Questions
- [questions the user or system has identified]

## Recent Additions
- [date]: [brief note of what was added and where]

## Archive Pointers
- [sub-topic label]: archive/[filename]
```

**For ephemeral topics:**

```markdown
## Current Narrative
[2-3 sentence summary of the current state of affairs]

## Active Threads
- [developing storylines to track]

## Recent Events (last 48h)
- [recent developments]

## Watching
- [upcoming events, dates, triggers]
```

### sources.json

Append-only. Every URL ever surfaced goes here. Used to prevent resurfacing.

```json
[
  {
    "url": "https://example.com/article",
    "title": "Article Title",
    "surfaced": "2026-03-14",
    "engaged": false,
    "flagged_for_deep_dive": false
  }
]
```

- `engaged`: user interacted with it (flagged it, replied to it, asked about it)
- `flagged_for_deep_dive`: user explicitly asked to go deeper on this source

### archive/{YYYY-MM-DD}-{session-id}.md

Session-chunked research notes. Written by the deep dive agent or discovery agent when significant content is found.

```markdown
---
session: 2026-03-14
topics_covered: [kelly-criterion, portfolio-sizing]
sources: 3
---

## Findings

[Full synthesis in prose. Tag individual claims:]

[DURABLE] The Kelly criterion optimizes for geometric growth rate, not arithmetic expected value.
[EPHEMERAL:2026-09] Current consensus among quant funds is to use fractional Kelly (0.25-0.5x).
```

Ephemeral claims include an expiry date (`[EPHEMERAL:YYYY-MM]`). Durable claims are tagged `[DURABLE]`.

---

## Workflows

### 1. Topic Onboarding

**Trigger**: User says "Add topic: [name]" or similar.

**Steps**:

1. Ask the user what they already know about this topic (prior knowledge). Keep this brief — 1-2 sentences is fine.
2. Determine classification. Default to `durable` / `research-driven`. Only ask the user if the topic is genuinely ambiguous (e.g., "AI agents" could be fast-moving or durable).
3. Create directory structure:

```bash
mkdir -p /workspace/group/second-brain/topics/{slug}/archive
```

4. Write `meta.json` with classification, today's date, and prior knowledge.
5. Write initial `active.md`:
   - Settled section: seed with prior knowledge items
   - Frontier section: generate 3-5 broad areas to explore based on the topic
   - Open Questions: 2-3 starting questions
   - Archive Pointers: empty
6. Write empty `sources.json`: `[]`
7. Run one discovery session immediately (see workflow 2).
8. Schedule recurring discovery via IPC:

```json
{
  "type": "schedule_task",
  "label": "second-brain-discovery-{slug}",
  "prompt": "Run a Second Brain discovery session for topic '{name}'. Read /workspace/group/second-brain/topics/{slug}/active.md to get the current frontier, then read /workspace/group/second-brain/topics/{slug}/sources.json for already-surfaced URLs. Generate 3-5 search queries targeting frontier gaps (NOT settled knowledge). Use WebSearch and WebFetch to find content. Filter out URLs already in sources.json. For each new source (max 5-7), send a separate message to the user — each message should be a tweet-sized hook (~200-280 chars) covering: what the source is, why it matters for the current frontier, and what makes it worth reading. Append all surfaced URLs to sources.json. Do NOT write to the archive or update active.md.",
  "schedule": {
    "type": "cron",
    "expression": "{cron_expression}"
  },
  "context_mode": "isolated"
}
```

Use the cron expression from the classification table above.

9. Confirm to the user: topic name, classification, scheduled frequency, and that the first discovery run is starting.

### 2. Discovery Session

**Trigger**: Scheduled task fires, or runs inline during onboarding.

**Inputs**: `active.md` and `sources.json` for the topic.

**Steps**:

1. Read `active.md`. Extract the Frontier section (durable/fast-moving) or Active Threads + Watching (ephemeral).
2. Generate 3-5 targeted search queries derived from the frontier gaps. Queries must target what's *missing*, not what's already settled. Be specific — "antifragility Kelly criterion interaction" not "antifragility".
3. Execute searches using `WebSearch`. For promising results, use `WebFetch` to read the content.
4. Read `sources.json`. Filter out any URLs already present.
5. Select the 5-7 most relevant new sources.
6. For each source, compose a hook message (~200-280 chars):
   - What it is (paper, blog post, analysis, etc.)
   - Why it's relevant to the current frontier
   - What makes it worth reading
   - Include the URL
7. Send each hook as a separate message via `mcp__nanoclaw__send_message`. Prefix each message with the topic name in bold so the user knows which topic it's from. Example format:

```
*Antifragility* — Paper by Fama on antifragile portfolio construction challenges Kelly sizing assumptions. Directly addresses the Kelly criterion interaction gap on your frontier. Worth reading for the mathematical critique.
https://example.com/paper
```

8. Append ALL surfaced URLs (whether user engages or not) to `sources.json` with `engaged: false` and `flagged_for_deep_dive: false`.

**Rules**:
- Never write to the archive during discovery.
- Never update active.md during discovery.
- Queries must come from the frontier, not from the topic name.
- If no new content is found, send a single message: "No new content found on the frontier for *{topic}* this session."

### 3. Deep Dive

**Trigger**: User says "Go deeper on [thread]" or flags a source for deep dive.

**Steps**:

1. Identify which topic and sub-thread the user is referring to.
2. Read `active.md` to find relevant archive pointers for this sub-thread.
3. Read the relevant archive files to understand current depth.
4. Use `WebSearch` and `WebFetch` to find and read primary sources in depth. Use `agent-browser` for sources that need interactive browsing.
5. Synthesize findings into a session document. Write it in prose, not bullet lists. Tag individual claims as `[DURABLE]` or `[EPHEMERAL:YYYY-MM]`.
6. Write the session document to `archive/{YYYY-MM-DD}-{slug}.md` with the frontmatter header.
7. Send a narrative summary to the user via `mcp__nanoclaw__send_message`. This should be a substantive synthesis, not just a list of links.
8. After the deep dive, immediately run the Compression workflow (workflow 4) to update the active layer.

### 4. Compression

**Trigger**: After a deep dive completes, or periodically (weekly for durable, after every discovery for fast-moving).

**Steps**:

1. Read current `active.md`.
2. Read all archive session files that were added since the last compression (check Recent Additions dates, or read all if unsure).
3. Rewrite `active.md` in full:
   - **Settled**: Add concepts that are now deeply understood. Be specific — "barbell strategy" not "some finance stuff".
   - **Frontier**: Remove items that have been explored. Add newly discovered gaps from the archive sessions. Keep 3-7 items.
   - **Open Questions**: Remove answered questions. Add new ones surfaced during research.
   - **Recent Additions**: Keep only additions from the last 2 weeks.
   - **Archive Pointers**: Add pointers to new session files with descriptive labels.
4. Write the new `active.md` in full. This is a complete rewrite, not an append.

**Critical rule**: The compression task must NOT summarize the archive. It only updates the index (settled, frontier, pointers). Settled knowledge stays in the archive files. The active layer is a map of what's unknown and what to search for next, not a knowledge summary.

---

## User Commands

Handle these interaction patterns. Match intent, not exact phrasing.

| User says | Action |
|---|---|
| "Add topic: [name]" / "Track [name]" / "Start researching [name]" | Run Topic Onboarding (workflow 1) |
| "Go deeper on [thread]" / "Deep dive into [thread]" / "Explore [thread] more" | Run Deep Dive (workflow 3) on the specified thread |
| "Flag this" (replying to a digest item) | Mark source as `engaged: true` in sources.json. Add the thread to Frontier in active.md if not already there. |
| "Not relevant" (replying to a digest item) | Mark source in sources.json with a `"relevant": false` field. Use this signal to avoid similar content in future searches. |
| "What do I know about [topic]?" / "Summarize [topic]" | Read active.md and the archive files referenced by Archive Pointers. Return a structured summary of settled knowledge, current frontier, and open questions. |
| "Show frontier for [topic]" | Read active.md and return the Frontier section directly. |
| "Pause [topic]" | Set `status: "paused"` in meta.json. Pause the scheduled task via `mcp__nanoclaw__pause_task` using label `second-brain-discovery-{slug}`. Confirm to user. |
| "Resume [topic]" | Set `status` back to previous value in meta.json. Resume via `mcp__nanoclaw__resume_task`. Confirm to user. |
| "What topics am I tracking?" / "List topics" | List all topic directories. For each, read meta.json and show: name, status, half-life, last activity date, scheduler frequency. |
| "Remove topic [name]" / "Stop tracking [name]" | Cancel the scheduled task via `mcp__nanoclaw__cancel_task`. Move the topic directory to `second-brain/topics/_archived/{slug}` (don't delete — the user may want it back). |

---

## Formatting Rules

All messages sent to the user via `mcp__nanoclaw__send_message` must follow these rules:
- Use single *asterisks* for bold (not **double**)
- Use _underscores_ for italic
- Use bullet character for lists
- No markdown headings (no ## or #)
- No markdown links `[text](url)` — just paste the URL on its own line
- Keep discovery digest items to ~200-280 characters plus the URL
- Deep dive summaries can be longer but should be narrative prose, not bullet lists
