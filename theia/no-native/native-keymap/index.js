/**
 * Replacement for `native-keymap`, which reads the OS keyboard layout through
 * a C++ addon so keybindings can be LABELLED correctly on non-US layouts.
 *
 * Only the Electron paths in @theia/core use it. Reporting a US layout means a
 * keybinding may be displayed with the wrong glyph on, say, a German keyboard.
 * It does not change which keys actually trigger a command.
 *
 * Worth revisiting if non-US users report confusing shortcut labels.
 */
function getKeyMap() {
  return {}
}

function getCurrentKeyboardLayout() {
  return { name: 'US', id: '00000409', text: 'US', isISOKeyboard: false }
}

function onDidChangeKeyboardLayout() {
  // A fixed layout never changes, so nothing ever calls back.
}

function isISOKeyboard() {
  return false
}

module.exports = { getKeyMap, getCurrentKeyboardLayout, onDidChangeKeyboardLayout, isISOKeyboard }
