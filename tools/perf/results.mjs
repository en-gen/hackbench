// Perf result format (design section 1): one JSON file per suite run, schema 1.
// Nothing downstream knows which tool produced it, so this is the only place
// that reads or writes the shape. A suite that measured nothing must fail,
// never report green: validate() rejects an empty results array and any
// result with no samples.

import { readFileSync, writeFileSync } from 'node:fs'

export const SCHEMA = 1
export const UNITS = new Set(['ms', 'bytes/cycle'])
export const BETTER = new Set(['lower'])

/** First dotted segment of an id, e.g. "core" from "core.lclz2.decompress.x". */
export function familyOf(id) {
  const i = id.indexOf('.')
  return i === -1 ? id : id.slice(0, i)
}

/** Throws a descriptive Error on the first thing wrong with `doc`. Callers
 *  that need a non-throwing form use validateSafe below. */
export function validate(doc) {
  if (doc === null || typeof doc !== 'object') throw new Error('result document must be an object')
  if (doc.schema !== SCHEMA) throw new Error(`unsupported schema: ${JSON.stringify(doc.schema)}`)
  if (typeof doc.sha !== 'string' || doc.sha.length === 0)
    throw new Error('sha must be a non-empty string')
  if (typeof doc.suite !== 'string' || doc.suite.length === 0)
    throw new Error('suite must be a non-empty string')
  if (!Array.isArray(doc.results) || doc.results.length === 0) {
    throw new Error('results must be a non-empty array; a suite that measured nothing must fail')
  }
  const ids = new Set()
  for (const r of doc.results) {
    if (r === null || typeof r !== 'object') throw new Error('each result must be an object')
    if (typeof r.id !== 'string' || r.id.length === 0)
      throw new Error('result id must be a non-empty string')
    if (ids.has(r.id)) throw new Error(`duplicate result id: ${r.id}`)
    ids.add(r.id)
    if (!UNITS.has(r.unit))
      throw new Error(`result ${r.id}: unsupported unit ${JSON.stringify(r.unit)}`)
    if (!BETTER.has(r.better))
      throw new Error(`result ${r.id}: unsupported better ${JSON.stringify(r.better)}`)
    if (!Array.isArray(r.samples) || r.samples.length === 0) {
      throw new Error(`result ${r.id}: samples must be a non-empty array`)
    }
    for (const s of r.samples) {
      if (typeof s !== 'number' || !Number.isFinite(s)) {
        throw new Error(`result ${r.id}: sample is not a finite number: ${JSON.stringify(s)}`)
      }
    }
  }
  return doc
}

/** Non-throwing form: {ok:true, doc} or {ok:false, error}. */
export function validateSafe(doc) {
  try {
    return { ok: true, doc: validate(doc) }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export function parse(text) {
  let doc
  try {
    doc = JSON.parse(text)
  } catch (err) {
    throw new Error(`malformed JSON: ${err instanceof Error ? err.message : String(err)}`, {
      cause: err,
    })
  }
  return validate(doc)
}

export function readResultFile(path) {
  return parse(readFileSync(path, 'utf8'))
}

export function writeResultText(doc) {
  validate(doc)
  return JSON.stringify(doc, null, 2) + '\n'
}

export function writeResultFile(path, doc) {
  writeFileSync(path, writeResultText(doc))
}
