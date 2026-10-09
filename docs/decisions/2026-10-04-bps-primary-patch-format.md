Ruled 2026-10-04 (Brian)

## Question

Which patch format does Export Patch write by default?

## Options considered

BPS as default with IPS secondary; IPS as default.

## Ruling

Reconfirmed by the owner 2026-10-04, wording not recorded. `[INF]`

## Why

BPS is what SMW Central requires and the current community standard; IPS is legacy. Implemented in #287 (`src/project/ExportPatch.ts` default `'bps'`, encoder `src/rom/Bps.ts`). `[EST]`

## Applies to

Export Patch. Any doc line saying Export Patch writes `.ips` is stale, not the spec. Search closed issues before filing a "new" decision; #531 duplicated #287.
