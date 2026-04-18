# Security Policy

## Supported versions

HackBench is pre-1.0. Only the latest `0.x.y` release on the `develop`
branch receives security fixes.

| Version | Supported |
|---------|-----------|
| `0.1.x` | ✅        |
| `< 0.1` | ❌        |

## Reporting a vulnerability

**Please do not open public issues for security reports.**

Use GitHub's private vulnerability reporting:

👉 **https://github.com/en-gen/hackbench/security/advisories/new**

Include:

- A description of the issue and its impact
- Steps to reproduce (minimal repro preferred)
- Affected version / commit SHA
- Any suggested mitigation

You can expect an initial acknowledgement within **7 days**. Because
HackBench is a hobbyist project, timelines on fixes depend on severity
and maintainer availability — but you will be kept informed.

Once a fix is released, the reporter will be credited in the release
notes unless they prefer to remain anonymous.

## Scope

In scope:

- Vulnerabilities in HackBench source code
- Vulnerabilities in HackBench's webview message handling that could
  lead to arbitrary code execution, filesystem access outside the
  opened ROM, or data exfiltration
- Malicious-ROM inputs that cause the extension or the VS Code host to
  execute unintended code (parser vulnerabilities)

Out of scope:

- Vulnerabilities in VS Code itself — report those to Microsoft
- Vulnerabilities in bundled third-party libraries — report those
  upstream (e.g., `@smwcentral/spc-player`). A courtesy heads-up here
  is welcome but not required.
- Social-engineering, physical-access, or DoS scenarios that require
  an already-compromised machine

## Legal / ROM data

HackBench does not ship ROM data. Do **not** include ROM files,
decompressed ROM dumps, or copyrighted Nintendo assets in vulnerability
reports. A description of the ROM region/version (e.g., "US 1.0") and
the byte offsets involved is sufficient.
