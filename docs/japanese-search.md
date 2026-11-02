# Japanese full-text search with sqlite-vaporetto

This optional feature adds one MCP tool, `search_ocr_japanese`, backed by a separate FTS5 index. Vaporetto segments Japanese text into tokens during the offline index build and when tokenizing query text. The index itself uses FTS5's built-in `unicode61` tokenizer over strings whose Vaporetto word boundaries have already been made explicit. This avoids loading a second copy of the large Vaporetto model in the serving worker. It does not change the existing `images_fts` table or write to the shared OCR database.

The project ships installation/build scripts, not the upstream native binary. The installer is pinned to upstream release `v0.4.0` and verifies the archive's published SHA-256 before extracting it. The selected `-with-model` release embeds `bccwj-suw+unidic_pos+kana.model.zst`; no separate model file is required. Check the upstream release notes before changing the pinned version.

## 1. Install the extension (Xubuntu / Linux)

From the project root:

```bash
npm run japanese-search:install
npm run japanese-search:check
```

The installer currently supports Linux `x86_64` and `aarch64`. It places the extension at:

```text
native/sqlite-vaporetto/libsqlite_vaporetto.so
```

For another operating system or architecture, obtain the matching official release asset or build from the upstream repository. Do not load a native library from an untrusted source.

## 2. Configure the feature

Add the following section to `config/config.json`. Keep all paths absolute and make sure `indexPath` is different from the source OCR DB, OAuth DB, and static-token DB.

```json
"japaneseSearch": {
  "enabled": true,
  "indexPath": "/home/USER/src/ocr-mcp-server/data/ocr-japanese-search.sqlite",
  "extensionPath": "/home/USER/src/ocr-mcp-server/native/sqlite-vaporetto/libsqlite_vaporetto.so",
  "busyTimeoutMs": 500,
  "maxLimit": 20
}
```

Replace `/home/USER/src/ocr-mcp-server` with the real project path. `enabled` defaults to `false`; existing configurations remain read-only and do not register the new tool until explicitly enabled.

## 3. Build the dedicated index

```bash
npm run japanese-search:index
```

The command reads the source DB path and Japanese-search settings from `MCP_CONFIG_PATH`, if set, or `config/config.json` otherwise. It opens the source OCR database read-only, copies `source_images` to a staging SQLite database, tokenizes each OCR text with the Vaporetto scalar helper, and inserts those terms into a contentless FTS5 table using `unicode61`. Original OCR text is stored once in `japanese_documents` for display/snippets; the FTS table stores only its search index. The source database remains authoritative.

The index build is an offline maintenance command. It may take time and use CPU for a large OCR collection, and prints progress every 1,000 records. The source reader holds a consistent read snapshot while copying; with rollback-journal mode, that snapshot may delay concurrent source writes, so run the initial build/rebuild when `book-ocr` is not doing a large write. The original OCR database is never modified by this command. The generated index uses schema version 2; an older schema-v1 index must be rebuilt after applying this version.

## 4. Restart the MCP server

After the index is built, restart the server. When `japaneseSearch.enabled` is true, the MCP server exposes `search_ocr_japanese`. The main thread checks that the configured files are readable and launches one dedicated worker. The worker loads the native extension, warms the Vaporetto query-side tokenizer once, validates the unicode61 FTS5 index, and then signals readiness asynchronously. This avoids loading the large model for both the FTS5 table tokenizer and the query helper. The log entry `[japanese-search] worker ready` includes the overall `initializationMs`. Worker initialization fails closed after a 180-second startup deadline. Search calls are dispatched one at a time in FIFO order; up to four total active/queued calls are accepted and additional calls receive a safe busy error. Each request has a 180-second queue-wait deadline measured from enqueue until dispatch. The 20-second execution deadline starts only after the worker reports that a query has started, so time spent waiting behind another query is excluded. If a worker fails, the active call fails; it is replaced only when queued demand remains. Automatic restarts use exponential backoff (250 ms base, capped at 8 seconds) and are limited to five consecutive startup failures before the worker reaches `ready`. Reaching `ready` resets the startup-failure counter. Query execution timeouts and failures after `ready` do not consume this budget; recovery still occurs only when queued demand remains. When the worker is idle, an unexpected failure does not trigger background restarts; the next request starts recovery. `startup-error`, the startup deadline, and exhausted restart attempts fail closed instead of restarting indefinitely; after the restart limit, restart the MCP server.

## 5. Tool inputs

- `query` (required): Japanese word or phrase, 1–500 characters.
- `mode`: `any` (default) or `all`. `any` ORs searchable Vaporetto tokens for broader recall; `all` requires every searchable token.
- `label`: optional exact `source_images.file_path` label.
- `reviewed`: optional review-state filter.
- `limit`: 1 to the configured `maxLimit` (default 20).
- `offset`: relevance-ranked pagination offset, capped at 100,000. Keep offsets small where possible.

The result includes the query's searchable tokens, snippets taken from original OCR text with best-effort match highlighting, source record IDs, labels, file names, review states, BM25 scores, and `nextOffset` when another page exists. BM25 scores are lower for better matches. Since snippets are generated from original text after the match, highlighting is substring-based and may be approximate where a query token occurs inside a longer OCR word.

**Important search semantics:** sqlite-vaporetto is a Japanese word tokenizer, not a character-substring index. A one-character query to `search_ocr_japanese` is tokenized by Vaporetto and is not guaranteed to find that character inside every longer token. Use the unified `search_ocr` tool when exact short-substring matching is required: each 1–2 Unicode-code-point term scans `source_images.ocr_text` with case-sensitive literal substring semantics, while terms of 3+ code points use the existing FTS5 trigram phrase index. Structured `search_ocr` expressions can combine these term types with nested AND/OR/NOT conditions. The one- and two-character path scans the source OCR table and can cost more than indexed searches; it does not depend on the Japanese snapshot index and does not apply Unicode normalization.

## 6. Index freshness and rebuilding

The Japanese index is a snapshot. It is not automatically updated when `book-ocr` changes `source_images` or when `update_ocr_text` changes a source record. Rebuild the index after adding OCR records, changing OCR text, changing review state, or applying schema-v2 pretokenization changes:

```bash
npm run japanese-search:index
```

Then restart the MCP server so the worker opens the new snapshot. The previous index remains in place if the build fails. Keep sufficient disk space for the staging index alongside the previous index during rebuilding.

## 7. License and security notes

The upstream extension is licensed `MIT OR Apache-2.0`. The `-with-model` release also bundles a model licensed under `BSD-3-Clause`; keep upstream license notices with the installed package. Source references: [sqlite-vaporetto README and releases](https://github.com/hotchpotch/sqlite-vaporetto).

The server loads the extension only from the configured absolute path. The worker validates the index during asynchronous startup, then disables extension loading on its SQLite connection immediately after loading the trusted library. The Japanese index is opened read-only by the MCP server; only the maintenance script creates or replaces this index snapshot.
