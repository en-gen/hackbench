/**
 * `meta/data-banks.json`: the data banks detected once per project and
 * editable by hand (en-gen/hackbench#755).
 *
 *   { "version": 1, "rom": "<base sha256>", "banks": { "objectCode": "$0D" } }
 *   { ..., "banks": { "objectCode": { "notFound": "<reason>" } } }
 *
 * Detection runs on the BASE ROM and fills only what is absent. A present
 * value always wins, which is the whole of the hand-edit rule; the file is
 * rewritten from scratch only when it was made for a different base ROM. A
 * value that does not parse is a refusal that names the file, never a quiet
 * fall back to detection, and the file is left as the person wrote it.
 */
import { locateObjectCodeBank, type BankResult, type DataBanks } from '../rom/DataBanks'
import type { RomFile } from '../rom/RomFile'
import { readMeta, writeMeta } from './ProjectMeta'

const FILE = 'meta/data-banks.json'

interface Config {
  version: 1
  rom: string
  banks: Record<string, unknown>
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const hexByte = (bank: number): string => '$' + bank.toString(16).toUpperCase().padStart(2, '0')

/** A bank value as stored; throws a reason for anything but "$00".."$FF" or { notFound: string }. */
function parseBank(v: unknown): BankResult {
  if (typeof v === 'string' && /^\$[0-9a-fA-F]{2}$/.test(v))
    return { bank: parseInt(v.slice(1), 16) }
  if (isRecord(v) && typeof v.notFound === 'string' && Object.keys(v).length === 1)
    return { notFound: v.notFound }
  throw new Error(`objectCode must be a bank like "$0D" or { "notFound": "<reason>" }, got ${JSON.stringify(v)}`) // prettier-ignore
}

const store = (r: BankResult): unknown => ('bank' in r ? hexByte(r.bank) : { notFound: r.notFound })

/**
 * The banks for this project. `base` is the unedited base ROM, `baseSha256`
 * the manifest's identity for it. Never throws: a bad file comes back as a
 * notFound whose reason names the file, so readers refuse and say why.
 */
export function resolveDataBanks(
  manifestPath: string,
  base: RomFile,
  baseSha256: string,
): DataBanks {
  try {
    const raw = readMeta(manifestPath, 'data-banks')
    let config: Config | undefined
    if (raw !== undefined) {
      if (
        !isRecord(raw) ||
        raw.version !== 1 ||
        typeof raw.rom !== 'string' ||
        !isRecord(raw.banks)
      )
        throw new Error('expected { "version": 1, "rom": "<sha256>", "banks": { ... } }')
      config = { version: 1, rom: raw.rom, banks: raw.banks }
    }
    // Made for another base ROM: its values describe that ROM, so start over.
    if (config && config.rom !== baseSha256) config = undefined
    const banks = config?.banks ?? {}

    let objectCode: BankResult
    if (banks.objectCode !== undefined) {
      objectCode = parseBank(banks.objectCode)
    } else {
      objectCode = locateObjectCodeBank(base)
      try {
        writeMeta(manifestPath, 'data-banks', {
          version: 1,
          rom: baseSha256,
          banks: { ...banks, objectCode: store(objectCode) },
        })
      } catch {
        // A read-only project folder loses the record, not the detection: it runs again next open.
      }
    }
    return { objectCode }
  } catch (err) {
    return { objectCode: { notFound: `${FILE}: ${(err as Error).message}` } }
  }
}
