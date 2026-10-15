// Cross-platform data/config/cache directory resolution for the Core.
//
// Windows: unchanged from what already shipped and was tested in the
// portable-app phase — %LOCALAPPDATA%\BotConnector AI\ for everything
// (this product doesn't functionally separate "config" from "data" today,
// so config()/cache() alias data() there rather than inventing a split
// Windows convention doesn't use).
//
// Linux: XDG Base Directory Specification, honoring
// XDG_DATA_HOME/XDG_CONFIG_HOME/XDG_CACHE_HOME when set, falling back to
// the spec's own defaults (~/.local/share, ~/.config, ~/.cache) otherwise.
//
// This module makes no filesystem changes on its own (no mkdir) — callers
// create directories on demand, same as before.
'use strict';
const os = require('node:os');
const path = require('node:path');

const XDG_APP_NAME = 'botconnector';
const WINDOWS_APP_DIR = 'BotConnector AI';

function isWindows() { return process.platform === 'win32'; }

function windowsLocalAppData() {
  return process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
}

function dataDir() {
  if (isWindows()) return path.join(windowsLocalAppData(), WINDOWS_APP_DIR);
  if (process.env.XDG_DATA_HOME) return path.join(process.env.XDG_DATA_HOME, XDG_APP_NAME);
  return path.join(os.homedir(), '.local', 'share', XDG_APP_NAME);
}

function configDir() {
  if (isWindows()) return dataDir();
  if (process.env.XDG_CONFIG_HOME) return path.join(process.env.XDG_CONFIG_HOME, XDG_APP_NAME);
  return path.join(os.homedir(), '.config', XDG_APP_NAME);
}

function cacheDir() {
  if (isWindows()) return dataDir();
  if (process.env.XDG_CACHE_HOME) return path.join(process.env.XDG_CACHE_HOME, XDG_APP_NAME);
  return path.join(os.homedir(), '.cache', XDG_APP_NAME);
}

function logsDir() { return path.join(dataDir(), 'logs'); }
function runtimesDir() { return path.join(dataDir(), 'runtimes'); }

// Deliberately the SAME on every OS, and deliberately NOT under dataDir():
// this is large, user-visible storage (downloaded GGUF models) the user
// actively browses/manages directly, matching how this product has always
// surfaced it — not something to bury in a hidden XDG directory. Already
// OS-agnostic (plain path.join), unchanged in value by this module; kept
// here only so callers have one place to look up every storage location.
function modelsDir() { return path.join(os.homedir(), 'BotConnector AI', 'models'); }

module.exports = { dataDir, configDir, cacheDir, logsDir, runtimesDir, modelsDir, isWindows };
