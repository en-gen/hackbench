# no-native

Replacements for three native Node addons that Theia's backend depends on and
HackBench does not need.

## Why these exist

Each is a C++ addon reached through node-gyp. None of them ships a prebuilt
binary that works here, and none of them will compile on Windows against
current Node headers: the build fails with

    LINK : fatal error LNK1117: syntax error in option 'opt:lldltojobs=2'

which is an LLVM/lld linker flag that MSVC's `link.exe` rejects. Installing the
C++ toolchain does not fix it, which was verified by installing it.

Rather than require every contributor to own that problem, the three are
replaced through npm `overrides`. The replacements are declared, committed and
visible, unlike editing `node_modules`.

## What is given up

| package | real behaviour | replaced with | cost |
|---|---|---|---|
| `drivelist` | enumerates physical disks | empty list | no drive letters in file dialogs |
| `native-keymap` | reads OS keyboard layout | US layout | keybinding LABELS may be wrong on non-US layouts |
| `@vscode/windows-ca-certs` | reads the Windows cert store | no certificates | no corporate MITM proxy TLS |

HackBench opens projects and ROMs by path, so none of the three is load
bearing. Each replacement is a few lines and says so in its own source.

## Before shipping

A release build should use the real modules, built on a machine or CI runner
where they compile. These exist so development is not gated on that. Treated
as a permanent substitution they would be a bug, so the release packaging issue
needs to say which of the three, if any, still matters at that point.
