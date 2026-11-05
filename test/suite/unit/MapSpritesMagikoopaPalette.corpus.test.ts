/**
 * #1097 against the hardware: the Magikoopa the map view draws on vanilla map $11C uses only colors that the
 * Mesen capture's CGRAM holds in row 15 once the fade has finished (`windows/screen_00`, OAM entries 116/117 are
 * the Magikoopa on palette 7), and none of the level's own row 15. Vanilla ROM and the `layers_v5` captures, one
 * machine. $1F is placed on two vanilla maps, $11C and $1FE. $1FE has no capture (captures/layers_v5/1fe.zip does
 * not exist) and draws no tile at rest in the 64-pass run (its sprite never leaves state 0 at its placed spot), so
 * nothing about its colors is claimed here.
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { bgr555ToRgba } from '../../../src/rom/GraphicsDecoder'
import { unzip } from '../../../tools/scripts/capture_render'
import { L1ModelCache } from '../../../theia/extension/src/node/map-screen'
import { mapSprites } from '../../../theia/extension/src/node/map-sprites'
import { CAPTURE_DIR, VANILLA, freshRom, hasCaptures, hasRom, romPath } from '../support/corpus'
import { slow } from '../support/loadTimeout'

const MAP = 0x11c
const hex = (c: readonly number[]) => c.slice(0, 3).join(',')

describe.skipIf(!hasRom(VANILLA) || !hasCaptures())(
  'Magikoopa colors on map $11C match the capture (#1097)',
  () => {
    it(
      'every opaque pixel is a color of the finished fade in the capture, and none is the level row',
      slow(60_000),
      () => {
        const entries = unzip(readFileSync(join(CAPTURE_DIR, '11c.zip')))
        const cg = entries.get('11c/windows/screen_00/layer_obj_cgram.bin')!()
        const oam = entries.get('11c/windows/screen_00/layer_obj_oam.bin')!()
        // The capture really is of a Magikoopa on palette 7 (attr bits 3:1), or the comparison below is about nothing.
        const onRow15 = [116, 117].filter(i => ((oam[i * 4 + 3]! >> 1) & 7) === 7)
        expect(onRow15).toHaveLength(2)
        const word = (i: number) => cg[i * 2]! | (cg[i * 2 + 1]! << 8)
        const hardware = new Set([1, 2, 3, 4, 5, 6, 7].map(c => hex(bgr555ToRgba(word(240 + c)))))

        const rom = freshRom()
        const reply = mapSprites(
          new L1ModelCache(),
          new Uint8Array(rom.buffer),
          romPath(VANILLA),
          MAP,
        )
        if (reply.status !== 'ok') throw new Error(`map $11C sprites: ${reply.status}`)
        const dto = reply.sprites.find(s => s.id === 0x1f)!
        expect(dto.status).toBe('drawn')
        const px = Buffer.from(dto.rgba, 'base64')
        const seen = new Set<string>()
        for (let i = 0; i < px.length; i += 4)
          if (px[i + 3]) seen.add(hex([px[i]!, px[i + 1]!, px[i + 2]!]))
        expect(seen.size).toBeGreaterThanOrEqual(3)
        for (const c of seen) expect(hardware, `pixel color ${c}`).toContain(c)
      },
    )
  },
)
