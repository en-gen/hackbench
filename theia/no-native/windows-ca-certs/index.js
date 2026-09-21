/**
 * Replacement for `@vscode/windows-ca-certs`, which reads the Windows
 * certificate store through a C++ addon so HTTPS works behind a corporate
 * MITM proxy.
 *
 * @vscode/proxy-agent calls it from readWindowsCaCertificates(). Yielding no
 * certificates leaves Node's default CA bundle in effect, which is correct
 * everywhere except behind such a proxy.
 *
 * `next()` returning undefined immediately is what ends the caller's read
 * loop, so the shape matters as much as the emptiness.
 */
class Crypt32 {
  next() {
    return undefined
  }

  done() {
    return undefined
  }
}

module.exports = { Crypt32 }
