// Verdict for the required "Build & Test" check, from job results in env.
// Fails closed: `code` must be exactly "true" or "false"; unless it is
// "false", static, unit and spike must be "success" (a skip is a failure
// then). changes and content must always be "success".
const e = process.env
const bad = []
if (e.CHANGES !== 'success') bad.push('changes=' + e.CHANGES)
if (e.CONTENT !== 'success') bad.push('content=' + e.CONTENT)
if (e.CODE !== 'true' && e.CODE !== 'false') bad.push('code=' + JSON.stringify(e.CODE))
for (const k of ['STATIC', 'UNIT', 'SPIKE']) {
  const ok = e[k] === 'success' || (e.CODE === 'false' && e[k] === 'skipped')
  if (!ok) bad.push(k.toLowerCase() + '=' + e[k])
}
console.log(bad.length ? 'FAIL ' + bad.join(' ') : 'ok')
process.exit(bad.length ? 1 : 0)
