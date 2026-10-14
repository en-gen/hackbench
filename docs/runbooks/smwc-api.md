# SMW Central listing API

Use when an agent must look up SMW Central content. HTML pages return a copyright banner to WebFetch and a Cloudflare "verify you are human" page to the browser pane. Do not try to bypass the check on HTML; use the JSON endpoint. `[EST]` 2026-09-22.

1. Request with plain curl: `https://www.smwcentral.net/ajax.php?a=getsectionlist&s=<section>&f%5Bname%5D=<term>&n=<page>`.
2. Sections seen: `tools`. Hacks are `s=smwhacks`, sorted with `&u=0&o=downloads&d=desc` (50 per page, 56 pages, `total` 2785 on 2026-10-10); each item also carries `downloads`, `rating` and `fields.type`/`difficulty`. Patches, music and others follow the same pattern. `[OPEN]` unverified.
3. Each item has `fields` (version, changelog, status, os, platforms, source, website, description), `authors`, `download_url`, `obsoleted_by`. The name filter matches the name only.
4. Wait about 6 seconds between calls. Rapid paging returned HTTP 429 and then a connection timeout. `[EST]` 2026-09-22.
5. The canonical shared copy of reference links lives in the owner's notes repository.
6. `tools/scripts/hack-fetch.ts` is the repeatable fetch built on this endpoint (see docs/rom/hack-corpus.md).
