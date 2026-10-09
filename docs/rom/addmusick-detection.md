# AddmusicK detection

> **Bottom line**
>
> - 3 of 6 corpus ROMs are AddmusicK: GPW2 1.1, GPW 1.2, Invictus 1.0. Seven_Vanilla_Levels, vanilla and magic are stock N-SPC. `[EST]`
> - `$008075` holds `JML $8E8020` on all 3 AMK ROMs; stock ROMs read `64 10 80 F2` there. `[EST]`
> - The target block starts at `$0E8000` with `"@AMK"`, a version byte (0 on all 3), then `dl SampleGroupPtrs`, `dl MusicPtrs`. Pointer fields not yet verified on the corpus. `[OPEN]`
> - The music player refuses AMK ROMs today. Detection path: follow the JML, gate on `@AMK`, read the header pointers. `[PROP]`

| Source | Identifier | As of | Retrieved |
| --- | --- | --- | --- |
| 6-ROM corpus probe | `$008075`, `$0E8000` reads | 2026-09-22 | 2026-09-22 |
| HertzDevil/AddmusicK fork (1.0.5-based) | `asm/SNES/patch.asm` header layout | not recorded | 2026-09-22 |

## Facts

- AMK wipes banks `$0E` and `$0F`. `[EST]`
- AMK NOPs the stock sample upload (`$00805E`) and music-bank uploads. `[EST]`
- AMK rewrites song numbers (for example `$0584DB`). `[EST]`
- AMK loads samples per song through sample groups. `[EST]`
- Never assume the stock driver's command lengths on an AMK ROM; the driver is user-editable. `[INF]` from the above.
- Related: `../sfx-tables.md`, `gfx-decompressors.md`.
