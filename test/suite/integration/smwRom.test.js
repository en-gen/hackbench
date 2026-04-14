"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const fs_1 = require("fs");
const path = __importStar(require("path"));
const SmwRom_1 = require("../../../src/rom/SmwRom");
const LevelParser_1 = require("../../../src/rom/LevelParser");
const ROM_PATH = path.resolve(__dirname, '../../roms/smw.sfc');
const romPresent = (0, fs_1.existsSync)(ROM_PATH);
vitest_1.describe.skipIf(!romPresent)('SmwRom integration (requires test/roms/smw.sfc)', () => {
    let rom;
    (0, vitest_1.it)('opens without throwing', () => {
        rom = SmwRom_1.SmwRom.open(ROM_PATH);
        (0, vitest_1.expect)(rom).toBeTruthy();
    });
    (0, vitest_1.it)('internal ROM name is SUPER MARIOWORLD', () => {
        rom ?? (rom = SmwRom_1.SmwRom.open(ROM_PATH));
        (0, vitest_1.expect)(rom.internalName).toMatch(/^SUPER MARIOWORLD/);
    });
    (0, vitest_1.it)('getSummary reports isVanilla=true', () => {
        rom ?? (rom = SmwRom_1.SmwRom.open(ROM_PATH));
        const summary = rom.getSummary();
        (0, vitest_1.expect)(summary.isVanilla).toBe(true);
        (0, vitest_1.expect)(summary.romSizeKb).toBeGreaterThan(0);
    });
    (0, vitest_1.it)('level $000 has a valid L1 pointer', () => {
        rom ?? (rom = SmwRom_1.SmwRom.open(ROM_PATH));
        const ptr = rom.getLevelL1Pointer(0x000);
        (0, vitest_1.expect)(ptr).not.toBeNull();
        (0, vitest_1.expect)(ptr).toBeGreaterThan(0);
    });
    (0, vitest_1.it)('level $000 raw data can be parsed', () => {
        rom ?? (rom = SmwRom_1.SmwRom.open(ROM_PATH));
        const data = rom.getLevelRawData(0x000);
        (0, vitest_1.expect)(data).not.toBeNull();
        const { objects, screens } = (0, LevelParser_1.parseLevelObjects)(data);
        (0, vitest_1.expect)(screens).toBeGreaterThanOrEqual(1);
        (0, vitest_1.expect)(objects.length).toBeGreaterThan(0);
    });
    (0, vitest_1.it)('reports 512 level entries total', () => {
        rom ?? (rom = SmwRom_1.SmwRom.open(ROM_PATH));
        const pointers = rom.getAllLevelPointers();
        (0, vitest_1.expect)(pointers).toHaveLength(0x200);
    });
    (0, vitest_1.it)('GFX slot 0 returns data of expected size', () => {
        rom ?? (rom = SmwRom_1.SmwRom.open(ROM_PATH));
        const gfx = rom.getGfxFile(0);
        (0, vitest_1.expect)(gfx).not.toBeNull();
        (0, vitest_1.expect)(gfx.length).toBe(0x600);
    });
});
//# sourceMappingURL=smwRom.test.js.map