// Terminal capability detection + ANSI helpers. Zero dependencies.
// Colors degrade to plain text automatically when the terminal can't show
// them (piped output, NO_COLOR, non-TTY) — never assume color support.
'use strict';

function supportsColor() {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR) return true;
  if (!process.stdout || !process.stdout.isTTY) return false;
  if (process.platform === 'win32') return true; // ConHost/Windows Terminal VT since Win10
  return !!process.env.TERM && process.env.TERM !== 'dumb';
}

const on = supportsColor();
const wrap = (code) => (s) => (on ? `\x1b[${code}m${s}\x1b[0m` : String(s));

module.exports = {
  supportsColor: on,
  bold: wrap('1'),
  dim: wrap('2'),
  green: wrap('32'),
  red: wrap('31'),
  yellow: wrap('33'),
  cyan: wrap('36'),
  blue: wrap('34'),
  magenta: wrap('35'),
  gray: wrap('90'),
};
