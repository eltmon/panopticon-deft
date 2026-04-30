# Conversation Forks

Panopticon lets you fork any conversation to create a new session that continues the work. Forking is useful when:

- A conversation is running out of context window
- You want to switch models mid-task
- You want to experiment with a different approach while keeping the original
- You want to split a multi-topic conversation into focused threads

## Fork Modes

### Summary Fork (Default)

A **summary fork** distills the conversation history into a structured summary and injects it as the first message in the new session.

**What happens:**
1. Panopticon reads the entire JSONL history (from the last compact boundary, if any)
2. A summary model (configurable, default: Sonnet 4.6) generates a structured checkpoint covering goals, progress, decisions, and next steps
3. The new conversation spawns with the summary as its initial context
4. The model acknowledges the summary and waits for your next instruction

**Advantages:**
- Works across any model or provider switch (Kimi → Opus, Anthropic → OpenAI, etc.)
- Drops irrelevant noise and tool call churn
- Typically much smaller token footprint than raw history
- No risk of provider-specific block validation errors

**Disadvantages:**
- Costs extra tokens for summary generation
- Loses verbatim message history (the model can't reference exact prior turns)
- Very large conversations may require chunked incremental summarization (handled automatically)

### Plain Fork

A **plain fork** copies the raw JSONL history (from the last compact boundary) into a new session file and resumes it with `--resume`.

**What happens:**
1. Panopticon copies JSONL entries from the last `compact_boundary` forward
2. Thinking blocks are sanitized — signatures are stripped, and assistant thinking blocks are converted to text (see [Thinking Block Behavior](#thinking-block-behavior) below)
3. The new conversation spawns with `claude --resume <sessionId>`
4. Claude Code loads the full raw transcript directly

**Advantages:**
- Preserves exact message history, tool calls, and reasoning chain
- No summary generation cost
- The model sees its own prior turns authentically

**Disadvantages:**
- Carries the full token weight of the history
- Cross-model forks may still fail if the history contains provider-specific tool schemas or other non-portable blocks
- Less practical for very long conversations

## Fork Options

When forking from the dashboard, you can configure:

| Option (UI) | API option | Default | Description |
|-------------|-----------|---------|-------------|
| **Plain fork** | `plain` | Off | Copy raw history instead of generating a summary |
| **Fast summary (no LLM)** | `localSummaryOnly` | Off | Use a heuristic fallback instead of calling an LLM to summarize. Faster and free, but less nuanced |
| **Include thinking in summary** | `includeThinkingInSummary` | Off | When generating a summary, include thinking block content as labeled text. Increases summary size but preserves reasoning details |
| **Summary model** | `model` | Configured compaction model | Which model generates the summary. Only applies when Fast summary is off |
| **Launch model** | `model` | Source conversation's model | Which model the new forked conversation uses |

These map to the `SummaryForkOptions` interface in `summary-fork.ts`.

### Thinking Block Behavior

Thinking blocks contain a cryptographic `signature` field bound to the specific API request and model that produced them. Reusing a signed thinking block in a different session or model causes `Invalid signature in thinking block` API errors. Both fork modes handle this, but differently.

**Summary fork:**
- Thinking blocks are excluded from the serialized conversation sent to the summary model by default
- If `includeThinkingInSummary` is enabled, thinking content is included as `[thinking]: ...` plain text in the summary (signatures are never forwarded)
- The new conversation receives only plain text — no thinking blocks at all

**Plain fork** (two-step sanitization in `copySessionFromCompactBoundary()`):
1. `stripThinkingSignatures()` runs first on every entry — removes only the `signature` field from thinking blocks, preserving the block's `type: "thinking"` and content
2. `sanitizeEntryForPlainFork()` runs second on assistant entries — converts `type: "thinking"` blocks to `type: "text"` blocks with a `[Thinking]` prefix

The two-step approach ensures no signed thinking blocks survive in the destination JSONL regardless of entry type.

## What Gets Preserved

| Property | Preserved? | Notes |
|----------|-----------|-------|
| Issue ID | Yes | New conversation is linked to the same issue |
| Working directory (`cwd`) | Yes | Defaults to source conversation's cwd |
| Effort level | Yes | Inherited from source |
| Model | Configurable | Defaults to source model, overrideable at fork time |
| Message history | Mode-dependent | Summary fork: distilled; Plain fork: copied raw |

## Model Switching & Cross-Model Gotchas

Switching models when forking is common, but comes with caveats:

- **Summary fork + model switch:** Safe. The summary is plain text, portable across any model or provider (Anthropic, OpenAI, Kimi, etc.).
- **Plain fork + same model family:** Safe. Raw history loads directly. Thinking blocks are sanitized as a precaution but the content is compatible.
- **Plain fork + different model family:** Risky. Even with thinking block sanitization, the copied history may contain:
  - Provider-specific tool schemas that the destination model doesn't support
  - Content block types or metadata fields unique to one provider
  - Role/turn structures that differ between providers (e.g., system message handling)

  The dashboard shows a warning when you select a different launch model with plain fork enabled. If you need to switch model families, use a summary fork.

## Token & Cost Implications

**Summary fork costs:**
- Summary generation: proportional to conversation length. Chunked for large conversations.
- The summary model's rate applies (default: Sonnet 4.6 at $15/1M input tokens)

**Plain fork costs:**
- No generation cost
- But the new conversation starts with the full history token count, so the first turn costs more

**Fast summary costs:**
- Zero LLM cost
- Parses JSONL locally and extracts user messages, files modified, and tools used

## Developer Notes

See `src/lib/conversations/summary-fork.ts` for the fork pipeline implementation.

Key functions:
- `createSummaryFork()` — entry point, orchestrates session reservation and summary generation
- `generateSummaryForFork()` — calls the LLM summarizer with fork-specific settings
- `generateFallbackSummary()` — heuristic summary when `localSummaryOnly` is true
- `copySessionFromCompactBoundary()` — raw JSONL copy with thinking sanitization for plain fork
- `stripThinkingSignatures()` — removes `signature` field from thinking blocks (preserves block type)
- `sanitizeEntryForPlainFork()` — converts thinking blocks to `[Thinking]`-prefixed text blocks
