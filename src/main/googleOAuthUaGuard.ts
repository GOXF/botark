import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { release as osRelease, tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import type { Session, WebContents } from 'electron'

export const GOOGLE_OAUTH_URL_PATTERNS = [
  '*://*.google.com/*',
  '*://google.com/*',
  '*://*.youtube.com/*',
  '*://youtube.com/*',
  '*://*.gstatic.com/*',
  '*://*.googleapis.com/*',
  '*://*.googleusercontent.com/*'
] as const

export const GOOGLE_OAUTH_PRELOAD_ID = 'botark-google-oauth-ua-guard-v1'
const PRELOAD_FILENAME = 'google-oauth-ua-preload-v1.cjs'
const DEFAULT_CHROME_VERSION = '136.0.0.0'

const guardedSessions = new WeakSet<object>()
const firefoxCompatSessions = new WeakSet<object>()
const guardedWebContents = new WeakSet<object>()

export interface GooglePlatformHint {
  header: '"Windows"' | '"macOS"' | '"Linux"'
  uaDataPlatform: 'Windows' | 'macOS' | 'Linux'
  uaOsSegment: string
  platformVersion: string
  architecture: 'x86' | 'arm'
  bitness: '32' | '64'
  oscpu: string
}

function resolvePlatformVersion(platform: NodeJS.Platform, releaseStr?: string): string {
  const effectiveRelease = releaseStr ?? (platform === process.platform ? osRelease() : '')
  if (platform === 'win32') {
    const match = /^10\.0\.(\d+)/.exec(effectiveRelease)
    if (match) {
      const build = Number(match[1])
      return build >= 22000 ? '15.0.0' : '10.0.0'
    }
    return '15.0.0'
  }
  if (platform === 'darwin') {
    const major = Number(effectiveRelease.split('.')[0])
    if (Number.isFinite(major) && major >= 20) {
      const macMajor = Math.max(14, major - 9)
      return `${macMajor}.0.0`
    }
    return '15.0.0'
  }
  return '6.8.0'
}

export function resolvePlatformHint(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  releaseStr?: string
): GooglePlatformHint {
  const architecture: 'x86' | 'arm' = arch === 'arm64' ? 'arm' : 'x86'
  const bitness: '32' | '64' = arch === 'ia32' || arch === 'arm' ? '32' : '64'
  const platformVersion = resolvePlatformVersion(platform, releaseStr)
  if (platform === 'win32') {
    return {
      header: '"Windows"',
      uaDataPlatform: 'Windows',
      uaOsSegment: 'Windows NT 10.0; Win64; x64',
      platformVersion,
      architecture,
      bitness,
      oscpu: 'Windows NT 10.0; Win64; x64'
    }
  }
  if (platform === 'darwin') {
    return {
      header: '"macOS"',
      uaDataPlatform: 'macOS',
      uaOsSegment: 'Macintosh; Intel Mac OS X 10_15_7',
      platformVersion,
      architecture,
      bitness,
      oscpu: 'Intel Mac OS X 10.15'
    }
  }
  return {
    header: '"Linux"',
    uaDataPlatform: 'Linux',
    uaOsSegment: 'X11; Linux x86_64',
    platformVersion,
    architecture,
    bitness,
    oscpu: 'Linux x86_64'
  }
}

export function buildGoogleFirefoxCompatUa(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') {
    return 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0'
  }
  if (platform === 'darwin') {
    return 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:140.0) Gecko/20100101 Firefox/140.0'
  }
  return 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0'
}

export const GOOGLE_FIREFOX_COMPAT_UA = buildGoogleFirefoxCompatUa()

const GOOGLE_SIGN_IN_HOST = /^(?:[\w-]+\.)*(?:accounts\.(?:google|youtube)\.com|(?:myaccount|gds|consent)\.google\.com|oauth2\.googleapis\.com)$/i
const GOOGLE_SIGN_IN_PATH = /^\/(?:o\/oauth2|v3\/signin|signin|ServiceLogin|AccountChooser)(?:\/|$)/i

export function isGoogleAuthHostUrl(url: string): boolean {
  if (!url) return false
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
    const host = parsed.hostname.toLowerCase()
    return GOOGLE_SIGN_IN_HOST.test(host) || (
      (host === 'google.com' || host === 'www.google.com') &&
      GOOGLE_SIGN_IN_PATH.test(parsed.pathname)
    )
  } catch {
    return false
  }
}

export function setGoogleFirefoxCompatMode(
  ses: Session | undefined | null,
  enabled: boolean
): void {
  if (!ses || typeof ses !== 'object') return
  if (enabled) {
    firefoxCompatSessions.add(ses)
  } else {
    firefoxCompatSessions.delete(ses)
  }
}

export function isGoogleFirefoxCompatMode(ses: Session | undefined | null): boolean {
  return Boolean(ses && typeof ses === 'object' && firefoxCompatSessions.has(ses))
}

export function inferPlatformFromUa(
  ua: string,
  fallbackPlatform: NodeJS.Platform = process.platform
): NodeJS.Platform {
  if (/Windows NT/i.test(ua)) return 'win32'
  if (/Macintosh|Mac OS X/i.test(ua)) return 'darwin'
  if (/Linux|X11/i.test(ua)) return 'linux'
  return fallbackPlatform
}

function normalizeChromeVersion(chromeVersion = process.versions?.chrome): string {
  return chromeVersion && /^\d+(\.\d+)*$/.test(chromeVersion) ? chromeVersion : DEFAULT_CHROME_VERSION
}

export function cleanChromeUserAgentForGoogle(
  rawUa: string,
  chromeVersion = process.versions?.chrome,
  platform: NodeJS.Platform = process.platform
): string {
  const cleaned = rawUa
    .replace(/(?:^|\s+)Electron\/[^\s]+/gi, '')
    .replace(/(?:^|\s+)(?:BotArk|BotHub)\/[^\s]+/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
  if (/Chrome\/[\d.]+/i.test(cleaned)) return cleaned
  const ver = normalizeChromeVersion(chromeVersion)
  const { uaOsSegment } = resolvePlatformHint(platform)
  return `Mozilla/5.0 (${uaOsSegment}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${ver} Safari/537.36`
}

export interface ChromeClientHints {
  major: string
  full: string
  secChUa: string
  secChUaFullVersion: string
  secChUaFullVersionList: string
  secChUaPlatform: '"Windows"' | '"macOS"' | '"Linux"'
  secChUaPlatformVersion: string
  secChUaArch: '"x86"' | '"arm"'
  secChUaBitness: '"32"' | '"64"'
  secChUaModel: '""'
  secChUaWow64: '?0'
  secChUaFormFactors: '"Desktop"'
  uaDataPlatform: 'Windows' | 'macOS' | 'Linux'
  platformVersion: string
  architecture: 'x86' | 'arm'
  bitness: '32' | '64'
  oscpu: string
  brands: Array<{ brand: string; version: string }>
  fullVersionList: Array<{ brand: string; version: string }>
}

export function buildChromeClientHints(
  chromeVersion = process.versions?.chrome,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): ChromeClientHints {
  const full = normalizeChromeVersion(chromeVersion)
  const major = full.split('.')[0] || '136'
  const { header, uaDataPlatform, platformVersion, architecture, bitness, oscpu } =
    resolvePlatformHint(platform, arch)
  return {
    major,
    full,
    secChUa: `"Chromium";v="${major}", "Google Chrome";v="${major}", "Not-A.Brand";v="99"`,
    secChUaFullVersion: `"${full}"`,
    secChUaFullVersionList: `"Chromium";v="${full}", "Google Chrome";v="${full}", "Not-A.Brand";v="99.0.0.0"`,
    secChUaPlatform: header,
    secChUaPlatformVersion: `"${platformVersion}"`,
    secChUaArch: `"${architecture}"`,
    secChUaBitness: `"${bitness}"`,
    secChUaModel: '""',
    secChUaWow64: '?0',
    secChUaFormFactors: '"Desktop"',
    uaDataPlatform,
    platformVersion,
    architecture,
    bitness,
    oscpu,
    brands: [
      { brand: 'Chromium', version: major },
      { brand: 'Google Chrome', version: major },
      { brand: 'Not-A.Brand', version: '99' }
    ],
    fullVersionList: [
      { brand: 'Chromium', version: full },
      { brand: 'Google Chrome', version: full },
      { brand: 'Not-A.Brand', version: '99.0.0.0' }
    ]
  }
}

export function sanitizeGoogleRequestHeaders(
  requestHeaders: Record<string, string>,
  chromeVersion = process.versions?.chrome,
  platform: NodeJS.Platform = process.platform,
  opts?: { firefoxCompat?: boolean; arch?: string }
): Record<string, string> {
  const next = { ...requestHeaders }

  if (opts?.firefoxCompat) {
    let sawUaKey = false
    for (const key of Object.keys(next)) {
      const lower = key.toLowerCase()
      if (lower === 'user-agent') {
        next[key] = buildGoogleFirefoxCompatUa(platform)
        sawUaKey = true
      } else if (lower.startsWith('sec-ch-ua')) {
        delete next[key]
      }
    }
    if (!sawUaKey) {
      next['User-Agent'] = buildGoogleFirefoxCompatUa(platform)
    }
    return next
  }

  let existingUaKey: string | undefined
  for (const key of Object.keys(next)) {
    if (key.toLowerCase() === 'user-agent') {
      existingUaKey = key
      break
    }
  }
  const cleanedUa = cleanChromeUserAgentForGoogle(
    existingUaKey ? (next[existingUaKey] ?? '') : '',
    chromeVersion,
    platform
  )
  const effectivePlatform = inferPlatformFromUa(cleanedUa, platform)
  const hints = buildChromeClientHints(chromeVersion, effectivePlatform, opts?.arch)

  let sawUaKey = false
  let sawSecChUa = false
  let sawMobile = false
  let sawPlatform = false
  for (const key of Object.keys(next)) {
    const lower = key.toLowerCase()
    if (lower === 'user-agent') {
      next[key] = cleanedUa
      sawUaKey = true
    } else if (lower === 'sec-ch-ua') {
      next[key] = hints.secChUa
      sawSecChUa = true
    } else if (lower === 'sec-ch-ua-full-version') {
      next[key] = hints.secChUaFullVersion
    } else if (lower === 'sec-ch-ua-full-version-list') {
      next[key] = hints.secChUaFullVersionList
    } else if (lower === 'sec-ch-ua-platform') {
      next[key] = hints.secChUaPlatform
      sawPlatform = true
    } else if (lower === 'sec-ch-ua-platform-version') {
      next[key] = hints.secChUaPlatformVersion
    } else if (lower === 'sec-ch-ua-mobile') {
      next[key] = '?0'
      sawMobile = true
    } else if (lower === 'sec-ch-ua-arch') {
      next[key] = hints.secChUaArch
    } else if (lower === 'sec-ch-ua-bitness') {
      next[key] = hints.secChUaBitness
    } else if (lower === 'sec-ch-ua-model') {
      next[key] = hints.secChUaModel
    } else if (lower === 'sec-ch-ua-wow64') {
      next[key] = hints.secChUaWow64
    } else if (lower === 'sec-ch-ua-form-factors') {
      next[key] = hints.secChUaFormFactors
    }
  }
  if (!sawUaKey) {
    next['User-Agent'] = cleanedUa
  }
  if (!sawSecChUa) {
    next['Sec-CH-UA'] = hints.secChUa
  }
  if (!sawMobile) {
    next['Sec-CH-UA-Mobile'] = '?0'
  }
  if (!sawPlatform) {
    next['Sec-CH-UA-Platform'] = hints.secChUaPlatform
  }
  return next
}

/**
 * Build the pure main-world JavaScript snippet that normalizes desktop browser fingerprints
 * (`navigator.userAgent`, `navigator.appVersion`, `navigator.userAgentData`, `navigator.webdriver`,
 * `navigator.plugins`/`mimeTypes`/`pdfViewerEnabled`, `navigator.permissions`, `window.chrome`,
 * `Function.prototype.toString`, and synchronous `iframe.contentWindow`/`contentDocument` realms)
 * strictly on Google OAuth origins (never on non-Google / Cloudflare Turnstile pages).
 */
export function buildGoogleOAuthMainWorldPatchScript(
  chromeVersion = process.versions?.chrome,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): string {
  const hints = buildChromeClientHints(chromeVersion, platform, arch)
  const fallbackUa = cleanChromeUserAgentForGoogle('', chromeVersion, platform)

  return `(() => {
  try {
    var FALLBACK_UA = ${JSON.stringify(fallbackUa)};
    var BRANDS = ${JSON.stringify(hints.brands)};
    var FULL_LIST = ${JSON.stringify(hints.fullVersionList)};
    var UA_PLATFORM = ${JSON.stringify(hints.uaDataPlatform)};
    var UA_PLATFORM_VER = ${JSON.stringify(hints.platformVersion)};
    var UA_ARCH = ${JSON.stringify(hints.architecture)};
    var UA_BITNESS = ${JSON.stringify(hints.bitness)};
    var UA_FULL = ${JSON.stringify(hints.full)};
    var FF_OSCPU = ${JSON.stringify(hints.oscpu)};
    var MARK = Symbol.for('botark.googleOAuthUaPatched');

    var isGoogleRealm = function(win) {
      try {
        var loc = win && win.location ? win.location : (typeof location !== 'undefined' ? location : null);
        var host = (loc && typeof loc.hostname === 'string' ? loc.hostname : '').toLowerCase();
        var proto = (loc && typeof loc.protocol === 'string' ? loc.protocol : '').toLowerCase();
        var isGoogleHost = /(?:^|\\.)(?:google\\.com|youtube\\.com|gstatic\\.com|googleapis\\.com|googleusercontent\\.com)$/i.test(host);
        var isNonGoogleOpener = false;
        try {
          var doc = win && win.document ? win.document : (typeof document !== 'undefined' ? document : null);
          var ref = (doc && typeof doc.referrer === 'string' ? doc.referrer : '');
          if (ref && !/^https?:\\/\\/([^/]+\\.)?(?:google|youtube|gstatic|googleapis|googleusercontent)\\.com(?:[:/]|$)/i.test(ref)) {
            isNonGoogleOpener = true;
          }
        } catch (_) {}
        var isOpaqueChild = !host && !isNonGoogleOpener && (proto === 'about:' || proto === 'blob:' || proto === 'data:');
        var isAuthPage = (proto === 'https:' || proto === 'http:') && (
          ${GOOGLE_SIGN_IN_HOST}.test(host) ||
          (host === 'google.com' || host === 'www.google.com') && ${GOOGLE_SIGN_IN_PATH}.test(loc.pathname || '')
        );
        return {
          allowed: isGoogleHost || isOpaqueChild,
          isOpaqueChild: isOpaqueChild,
          isAuthPage: isAuthPage
        };
      } catch (_) {
        return { allowed: false, isOpaqueChild: false, isAuthPage: false };
      }
    };

    var patchRealm = function(win, forcedParentMeta) {
      try {
        if (!win) return;
        var nav = win.navigator;
        if (!nav) return;
        if (nav[MARK]) return;

        var meta = isGoogleRealm(win);
        if (!meta.allowed && !forcedParentMeta) return;
        var effectiveAuthPage = meta.isAuthPage || (meta.isOpaqueChild && forcedParentMeta && forcedParentMeta.isAuthPage);
        var effectiveOpaque = meta.isOpaqueChild;

        try {
          Object.defineProperty(nav, MARK, { value: true, configurable: false, enumerable: false });
        } catch (_) {}

        var FnCtor = win.Function || Function;
        var nativeStrings = typeof WeakMap !== 'undefined' ? new WeakMap() : null;
        if (nativeStrings && FnCtor && FnCtor.prototype && typeof FnCtor.prototype.toString === 'function') {
          var origToString = FnCtor.prototype.toString;
          var wrappedToString = function toString() {
            if (nativeStrings.has(this)) return nativeStrings.get(this);
            return origToString.call(this);
          };
          nativeStrings.set(wrappedToString, 'function toString() { [native code] }');
          try {
            Object.defineProperty(FnCtor.prototype, 'toString', {
              value: wrappedToString,
              writable: true,
              enumerable: false,
              configurable: true
            });
          } catch (_) {}
        }

        var asNative = function(fn, label) {
          if (nativeStrings && typeof fn === 'function') {
            nativeStrings.set(fn, 'function ' + label + '() { [native code] }');
          }
          return fn;
        };

        var defineVal = function(target, prop, getterOrVal, isGetter, nativeLabel) {
          try {
            if (isGetter && nativeLabel) asNative(getterOrVal, 'get ' + nativeLabel);
            else if (!isGetter && nativeLabel) asNative(getterOrVal, nativeLabel);
            Object.defineProperty(
              target,
              prop,
              isGetter
                ? { get: getterOrVal, enumerable: true, configurable: true }
                : { value: getterOrVal, enumerable: true, configurable: true }
            );
            return true;
          } catch (_) {
            return false;
          }
        };

        var navProto = win.Navigator && win.Navigator.prototype ? win.Navigator.prototype : null;
        var defineOnNav = function(prop, getter) {
          asNative(getter, 'get ' + prop);
          if (!navProto || !defineVal(navProto, prop, getter, true)) {
            defineVal(nav, prop, getter, true);
          }
        };

        var installIframeGuard = function(parentMeta) {
          try {
            var IframeProto = win.HTMLIFrameElement && win.HTMLIFrameElement.prototype;
            if (!IframeProto) return;
            var cwDesc = Object.getOwnPropertyDescriptor(IframeProto, 'contentWindow');
            if (cwDesc && typeof cwDesc.get === 'function') {
              var origCwGet = cwDesc.get;
              var wrappedCwGet = asNative(function contentWindow() {
                var childWin = origCwGet.call(this);
                if (childWin) {
                  try { patchRealm(childWin, parentMeta); } catch (_) {}
                }
                return childWin;
              }, 'get contentWindow');
              Object.defineProperty(IframeProto, 'contentWindow', {
                get: wrappedCwGet,
                enumerable: cwDesc.enumerable !== false,
                configurable: true
              });
            }
            var cdDesc = Object.getOwnPropertyDescriptor(IframeProto, 'contentDocument');
            if (cdDesc && typeof cdDesc.get === 'function') {
              var origCdGet = cdDesc.get;
              var wrappedCdGet = asNative(function contentDocument() {
                var doc = origCdGet.call(this);
                try {
                  var childWin = doc && doc.defaultView;
                  if (childWin) patchRealm(childWin, parentMeta);
                } catch (_) {}
                return doc;
              }, 'get contentDocument');
              Object.defineProperty(IframeProto, 'contentDocument', {
                get: wrappedCdGet,
                enumerable: cdDesc.enumerable !== false,
                configurable: true
              });
            }
          } catch (_) {}
        };

        if (nav.webdriver !== false) {
          defineOnNav('webdriver', function webdriver() { return false; });
        }

        var rawUa = typeof nav.userAgent === 'string' ? nav.userAgent : '';
        var isFirefoxCompat = /\\bFirefox\\/[\\d.]+/i.test(rawUa) || Boolean(forcedParentMeta && forcedParentMeta.isFirefoxCompat);
        var nextParentMeta = { isAuthPage: effectiveAuthPage, isFirefoxCompat: isFirefoxCompat };

        if (isFirefoxCompat && (effectiveAuthPage || effectiveOpaque)) {
          defineOnNav('userAgentData', function userAgentData() { return undefined; });
          defineOnNav('vendor', function vendor() { return ''; });
          defineOnNav('productSub', function productSub() { return '20100101'; });
          defineOnNav('buildID', function buildID() { return '20181001000000'; });
          defineOnNav('oscpu', function oscpu() { return FF_OSCPU; });
          try {
            if ('chrome' in win) {
              Object.defineProperty(win, 'chrome', {
                get: asNative(function chrome() { return undefined; }, 'get chrome'),
                enumerable: false,
                configurable: true
              });
            }
          } catch (_) {}
          installIframeGuard(nextParentMeta);
          return;
        }

        var stripped = rawUa
          .replace(/\\s+Electron\\/[^\\s]+/gi, '')
          .replace(/\\s+(?:BotArk|BotHub)\\/[^\\s]+/gi, '')
          .replace(/\\s{2,}/g, ' ')
          .trim();
        var cleanUa = /Chrome\\/[\\d.]+/i.test(stripped) ? stripped : FALLBACK_UA;
        var cleanAppVersion = cleanUa.replace(/^Mozilla\\//, '');

        if (rawUa !== cleanUa) {
          defineOnNav('userAgent', function userAgent() { return cleanUa; });
        }
        var rawAppVersion = typeof nav.appVersion === 'string' ? nav.appVersion : '';
        if (rawAppVersion !== cleanAppVersion) {
          defineOnNav('appVersion', function appVersion() { return cleanAppVersion; });
        }
        if (typeof nav.vendor === 'string' && nav.vendor !== 'Google Inc.') {
          defineOnNav('vendor', function vendor() { return 'Google Inc.'; });
        }

        // Authentic desktop Chrome window.chrome surface (replaces empty { runtime: {} } stub)
        if (typeof win === 'object' && (!win.chrome || !win.chrome.app)) {
          try {
            var perf = win.performance;
            var navStartMs = perf && typeof perf.timeOrigin === 'number'
              ? Math.round(perf.timeOrigin)
              : Date.now();
            var startSec = navStartMs / 1000;
            var chromeObj = win.chrome && typeof win.chrome === 'object' ? win.chrome : {};
            if (!chromeObj.app) {
              chromeObj.app = {
                isInstalled: false,
                InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
                RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
                getDetails: asNative(function getDetails() { return null; }, 'getDetails'),
                getIsInstalled: asNative(function getIsInstalled() { return false; }, 'getIsInstalled'),
                runningState: asNative(function runningState() { return 'cannot_run'; }, 'runningState')
              };
            }
            if (typeof chromeObj.csi !== 'function') {
              chromeObj.csi = asNative(function csi() {
                var elapsed = perf && typeof perf.now === 'function' ? perf.now() : 120;
                return {
                  startE: navStartMs,
                  onloadT: navStartMs + Math.round(elapsed),
                  pageT: Math.round(elapsed * 1000) / 1000,
                  tran: 15
                };
              }, 'csi');
            }
            if (typeof chromeObj.loadTimes !== 'function') {
              chromeObj.loadTimes = asNative(function loadTimes() {
                return {
                  requestTime: startSec,
                  startLoadTime: startSec,
                  commitLoadTime: startSec + 0.04,
                  finishDocumentLoadTime: startSec + 0.12,
                  finishLoadTime: startSec + 0.18,
                  firstPaintTime: startSec + 0.09,
                  firstPaintAfterLoadTime: 0,
                  navigationType: 'Other',
                  wasFetchedViaSpdy: true,
                  wasNpnNegotiated: true,
                  npnNegotiatedProtocol: 'h2',
                  wasAlternateProtocolAvailable: false,
                  connectionInfo: 'h2'
                };
              }, 'loadTimes');
            }
            if (!chromeObj.runtime) {
              chromeObj.runtime = {
                OnInstalledReason: {
                  CHROME_UPDATE: 'chrome_update',
                  INSTALL: 'install',
                  SHARED_MODULE_UPDATE: 'shared_module_update',
                  UPDATE: 'update'
                },
                OnRestartRequiredReason: {
                  APP_UPDATE: 'app_update',
                  OS_UPDATE: 'os_update',
                  PERIODIC: 'periodic'
                },
                PlatformArch: {
                  ARM: 'arm',
                  ARM64: 'arm64',
                  MIPS: 'mips',
                  MIPS64: 'mips64',
                  X86_32: 'x86-32',
                  X86_64: 'x86-64'
                },
                PlatformNaclArch: {
                  ARM: 'arm',
                  MIPS: 'mips',
                  MIPS64: 'mips64',
                  X86_32: 'x86-32',
                  X86_64: 'x86-64'
                },
                PlatformOs: {
                  ANDROID: 'android',
                  CROS: 'cros',
                  FUCHSIA: 'fuchsia',
                  LINUX: 'linux',
                  MAC: 'mac',
                  OPENBSD: 'openbsd',
                  WIN: 'win'
                },
                RequestUpdateCheckStatus: {
                  NO_UPDATE: 'no_update',
                  THROTTLED: 'throttled',
                  UPDATE_AVAILABLE: 'update_available'
                },
                id: undefined
              };
            }
            Object.defineProperty(win, 'chrome', {
              value: chromeObj,
              writable: true,
              enumerable: true,
              configurable: true
            });
          } catch (_) {}
        }

        // Standard desktop Chrome built-in PDF plugins when Electron reports an empty PluginArray
        try {
          if (nav.plugins && nav.plugins.length === 0) {
            var PluginProto = win.Plugin && win.Plugin.prototype ? win.Plugin.prototype : Object.prototype;
            var MimeTypeProto = win.MimeType && win.MimeType.prototype ? win.MimeType.prototype : Object.prototype;
            var PluginArrayProto = win.PluginArray && win.PluginArray.prototype ? win.PluginArray.prototype : Object.prototype;
            var MimeTypeArrayProto = win.MimeTypeArray && win.MimeTypeArray.prototype ? win.MimeTypeArray.prototype : Object.prototype;

            var pluginNames = [
              'PDF Viewer',
              'Chrome PDF Viewer',
              'Chromium PDF Viewer',
              'Microsoft Edge PDF Viewer',
              'WebKit built-in PDF'
            ];
            var mimeSpecs = [
              { type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format' },
              { type: 'text/pdf', suffixes: 'pdf', description: 'Portable Document Format' }
            ];

            var pluginsObj = Object.create(PluginArrayProto);
            var mimeTypesObj = Object.create(MimeTypeArrayProto);
            var pluginList = [];
            var mimeList = [];

            for (var p = 0; p < pluginNames.length; p++) {
              var pluginObj = Object.create(PluginProto);
              var pMimes = [];
              for (var m = 0; m < mimeSpecs.length; m++) {
                var spec = mimeSpecs[m];
                var mt = Object.create(MimeTypeProto);
                defineVal(mt, 'type', spec.type, false);
                defineVal(mt, 'suffixes', spec.suffixes, false);
                defineVal(mt, 'description', spec.description, false);
                defineVal(mt, 'enabledPlugin', pluginObj, false);
                pMimes.push(mt);
                defineVal(pluginObj, m, mt, false);
                defineVal(pluginObj, spec.type, mt, false);
                if (p === 0) {
                  mimeList.push(mt);
                  defineVal(mimeTypesObj, m, mt, false);
                  defineVal(mimeTypesObj, spec.type, mt, false);
                }
              }
              defineVal(pluginObj, 'name', pluginNames[p], false);
              defineVal(pluginObj, 'filename', 'internal-pdf-viewer', false);
              defineVal(pluginObj, 'description', 'Portable Document Format', false);
              defineVal(pluginObj, 'length', pMimes.length, false);
              defineVal(pluginObj, 'item', (function(arr) { return function item(i) { return arr[i] || null; }; })(pMimes), false, 'item');
              defineVal(pluginObj, 'namedItem', (function(arr) { return function namedItem(k) { for (var j = 0; j < arr.length; j++) if (arr[j].type === k) return arr[j]; return null; }; })(pMimes), false, 'namedItem');
              pluginList.push(pluginObj);
              defineVal(pluginsObj, p, pluginObj, false);
              defineVal(pluginsObj, pluginNames[p], pluginObj, false);
            }

            defineVal(pluginsObj, 'length', pluginList.length, false);
            defineVal(pluginsObj, 'item', function item(i) { return pluginList[i] || null; }, false, 'item');
            defineVal(pluginsObj, 'namedItem', function namedItem(k) { for (var j = 0; j < pluginList.length; j++) if (pluginList[j].name === k) return pluginList[j]; return null; }, false, 'namedItem');
            defineVal(pluginsObj, 'refresh', function refresh() {}, false, 'refresh');
            if (typeof Symbol !== 'undefined' && Symbol.iterator) {
              Object.defineProperty(pluginsObj, Symbol.iterator, {
                value: asNative(function values() { return pluginList[Symbol.iterator](); }, 'values'),
                enumerable: false,
                configurable: true
              });
            }

            defineVal(mimeTypesObj, 'length', mimeList.length, false);
            defineVal(mimeTypesObj, 'item', function item(i) { return mimeList[i] || null; }, false, 'item');
            defineVal(mimeTypesObj, 'namedItem', function namedItem(k) { for (var j = 0; j < mimeList.length; j++) if (mimeList[j].type === k) return mimeList[j]; return null; }, false, 'namedItem');
            if (typeof Symbol !== 'undefined' && Symbol.iterator) {
              Object.defineProperty(mimeTypesObj, Symbol.iterator, {
                value: asNative(function values() { return mimeList[Symbol.iterator](); }, 'values'),
                enumerable: false,
                configurable: true
              });
            }

            defineOnNav('plugins', function plugins() { return pluginsObj; });
            defineOnNav('mimeTypes', function mimeTypes() { return mimeTypesObj; });
            defineOnNav('pdfViewerEnabled', function pdfViewerEnabled() { return true; });
          } else if (nav.pdfViewerEnabled === false) {
            defineOnNav('pdfViewerEnabled', function pdfViewerEnabled() { return true; });
          }
        } catch (_) {}

        // Consistent notification permission state
        try {
          if (nav.permissions && typeof nav.permissions.query === 'function' && win.Notification) {
            var origPermQuery = nav.permissions.query.bind(nav.permissions);
            var wrappedPermQuery = asNative(function query(params) {
              if (params && params.name === 'notifications') {
                return origPermQuery(params).then(function(status) {
                  if (status && status.state === 'denied' && win.Notification.permission === 'default') {
                    return Object.create(Object.getPrototypeOf(status), {
                      state: { get: asNative(function state() { return 'prompt'; }, 'get state'), enumerable: true }
                    });
                  }
                  return status;
                });
              }
              return origPermQuery(params);
            }, 'query');
            Object.defineProperty(nav.permissions, 'query', {
              value: wrappedPermQuery,
              writable: true,
              enumerable: true,
              configurable: true
            });
          }
        } catch (_) {}

        // Non-zero desktop outer dimensions
        try {
          if (win.outerWidth === 0 && typeof win.innerWidth === 'number' && win.innerWidth > 0) {
            Object.defineProperty(win, 'outerWidth', {
              get: asNative(function outerWidth() { return win.innerWidth; }, 'get outerWidth'),
              enumerable: true,
              configurable: true
            });
          }
          if (win.outerHeight === 0 && typeof win.innerHeight === 'number' && win.innerHeight > 0) {
            Object.defineProperty(win, 'outerHeight', {
              get: asNative(function outerHeight() { return win.innerHeight + 85; }, 'get outerHeight'),
              enumerable: true,
              configurable: true
            });
          }
        } catch (_) {}

        var origUaData = nav.userAgentData;
        var patchedUaData;
        try {
          var protoObj = origUaData && typeof origUaData === 'object' ? Object.getPrototypeOf(origUaData) : Object.prototype;
          patchedUaData = Object.create(protoObj || Object.prototype);
        } catch (_) {
          patchedUaData = {};
        }

        defineVal(patchedUaData, 'brands', function brands() { return BRANDS.map(function(b) { return { brand: b.brand, version: b.version }; }); }, true, 'brands');
        defineVal(patchedUaData, 'mobile', function mobile() { return false; }, true, 'mobile');
        defineVal(patchedUaData, 'platform', function platform() { return UA_PLATFORM; }, true, 'platform');
        defineVal(patchedUaData, 'toJSON', function toJSON() {
          return {
            brands: BRANDS.map(function(b) { return { brand: b.brand, version: b.version }; }),
            mobile: false,
            platform: UA_PLATFORM
          };
        }, false, 'toJSON');
        defineVal(patchedUaData, 'getHighEntropyValues', function getHighEntropyValues(requestedHints) {
          var list = Array.isArray(requestedHints) ? requestedHints : [];
          var basePromise;
          try {
            if (origUaData && typeof origUaData.getHighEntropyValues === 'function') {
              basePromise = Promise.resolve(origUaData.getHighEntropyValues(list)).catch(function() { return {}; });
            } else {
              basePromise = Promise.resolve({});
            }
          } catch (_) {
            basePromise = Promise.resolve({});
          }
          return basePromise.then(function(base) {
            var out = Object.assign({}, base || {}, {
              brands: BRANDS.map(function(b) { return { brand: b.brand, version: b.version }; }),
              mobile: false,
              platform: UA_PLATFORM
            });
            if (list.indexOf('architecture') >= 0) out.architecture = UA_ARCH;
            if (list.indexOf('bitness') >= 0) out.bitness = UA_BITNESS;
            if (list.indexOf('model') >= 0) out.model = '';
            if (list.indexOf('platformVersion') >= 0) out.platformVersion = UA_PLATFORM_VER;
            if (list.indexOf('wow64') >= 0) out.wow64 = false;
            if (list.indexOf('formFactors') >= 0) out.formFactors = ['Desktop'];
            if (list.indexOf('fullVersionList') >= 0) {
              out.fullVersionList = FULL_LIST.map(function(b) { return { brand: b.brand, version: b.version }; });
            }
            if (list.indexOf('uaFullVersion') >= 0) {
              out.uaFullVersion = UA_FULL;
            }
            return out;
          });
        }, false, 'getHighEntropyValues');

        defineOnNav('userAgentData', function userAgentData() { return patchedUaData; });
        installIframeGuard(nextParentMeta);
      } catch (_) {}
    };

    var rootWin = typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null);
    patchRealm(rootWin, null);
  } catch (_) {}
})();`
}

export function buildGoogleOAuthPreloadScriptSource(
  chromeVersion = process.versions?.chrome,
  platform: NodeJS.Platform = process.platform
): string {
  const mainWorldScript = buildGoogleOAuthMainWorldPatchScript(chromeVersion, platform)
  return `'use strict';
try {
  var electronMod = require('electron');
  var webFrame = electronMod && electronMod.webFrame;
  if (webFrame && typeof webFrame.executeJavaScript === 'function') {
    Promise.resolve(webFrame.executeJavaScript(${JSON.stringify(mainWorldScript)})).catch(function() {});
  }
} catch (_) {}
`
}

function resolvePreloadDir(ses: Session, explicitDir?: string): string {
  if (explicitDir && explicitDir.trim()) return explicitDir
  try {
    const maybeStorage = (ses as Session & { getStoragePath?: () => string | null }).getStoragePath?.()
    if (typeof maybeStorage === 'string' && maybeStorage.trim()) {
      const parentDir = dirname(maybeStorage)
      if (basename(parentDir).toLowerCase() === 'partitions') {
        return dirname(parentDir)
      }
      return maybeStorage
    }
  } catch {
    /* fallback to tmpdir */
  }
  return join(tmpdir(), 'botark-google-oauth-guard')
}

function materializePreloadScript(dir: string, source: string): string {
  mkdirSync(dir, { recursive: true })
  const filePath = join(dir, PRELOAD_FILENAME)
  let existing = ''
  try {
    existing = readFileSync(filePath, 'utf8')
  } catch {
    /* file does not exist yet */
  }
  if (existing !== source) {
    const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`
    writeFileSync(tmpPath, source, { encoding: 'utf8', mode: 0o600 })
    renameSync(tmpPath, filePath)
  }
  return filePath
}

export function isGoogleBlockedOrPasskeyText(bodyText: unknown, url?: string): boolean {
  if (url !== undefined) {
    try {
      const parsed = new URL(url)
      const host = parsed.hostname.toLowerCase()
      if (!/^accounts\.(?:google\.com|youtube\.com)$/i.test(host)) {
        return false
      }
      if (/\/signin\/rejected\b/i.test(parsed.pathname) || /disallowed_useragent/i.test(parsed.search)) {
        return true
      }
    } catch {
      return false
    }
  }
  if (typeof bodyText === 'boolean') return bodyText
  if (typeof bodyText !== 'string' || !bodyText) return false
  return (
    bodyText.includes('此浏览器或应用可能不安全') ||
    bodyText.includes('This browser or app may not be secure') ||
    bodyText.includes('disallowed_useragent') ||
    bodyText.includes("Couldn't sign you in") ||
    bodyText.includes('Couldn’t sign you in') ||
    bodyText.includes('无法登录') ||
    /\bpasskey\b|通行密钥|security key|安全密钥/i.test(bodyText)
  )
}

export const GOOGLE_BLOCK_CHECK_SCRIPT = `(() => (document.body && (document.body.innerText || document.body.textContent)) || '')()`

export function buildGoogleFallbackBannerScript(opts: {
  id?: string
  title: string
  detail: string
  buttonLabel?: string
  actionUrl?: string
  secondaryActions?: Array<{ label: string; actionUrl: string }>
}): string {
  const bannerId = opts.id ?? 'botark-google-fallback-banner'
  const secondaryJson = JSON.stringify(opts.secondaryActions ?? [])
  return `(() => {
  try {
    if (!document.body) return;
    var existing = document.getElementById(${JSON.stringify(bannerId)});
    if (existing) return;
    var bar = document.createElement('div');
    bar.id = ${JSON.stringify(bannerId)};
    bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483647;background:#1f2937;color:#f9fafb;padding:10px 16px;display:flex;align-items:center;justify-content:space-between;gap:12px;font:13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;box-shadow:0 4px 12px rgba(0,0,0,0.22);';
    var info = document.createElement('div');
    info.style.cssText = 'display:flex;flex-direction:column;gap:2px;min-width:0;';
    var titleEl = document.createElement('strong');
    titleEl.textContent = ${JSON.stringify(opts.title)};
    titleEl.style.cssText = 'font-size:13px;font-weight:600;color:#fff;';
    var detailEl = document.createElement('span');
    detailEl.textContent = ${JSON.stringify(opts.detail)};
    detailEl.style.cssText = 'font-size:12px;color:#d1d5db;';
    info.appendChild(titleEl);
    info.appendChild(detailEl);
    bar.appendChild(info);
    var actions = document.createElement('div');
    actions.style.cssText = 'display:flex;align-items:center;gap:8px;flex-shrink:0;flex-wrap:wrap;';
    var extra = ${secondaryJson};
    for (var i = 0; i < extra.length; i++) {
      var item = extra[i];
      if (!item || !item.label || !item.actionUrl) continue;
      var sbtn = document.createElement('a');
      sbtn.href = item.actionUrl;
      sbtn.textContent = item.label;
      sbtn.style.cssText = 'background:#374151;color:#f9fafb;border:1px solid #4b5563;text-decoration:none;padding:5px 10px;border-radius:6px;font-size:12px;font-weight:500;cursor:pointer;white-space:nowrap;';
      actions.appendChild(sbtn);
    }
    ${
      opts.buttonLabel
        ? `var btn = document.createElement('a');
    btn.href = ${JSON.stringify(opts.actionUrl ?? 'botark-external://open')};
    btn.textContent = ${JSON.stringify(opts.buttonLabel)};
    btn.style.cssText = 'background:#3b82f6;color:#fff;text-decoration:none;padding:6px 12px;border-radius:6px;font-size:12px;font-weight:500;cursor:pointer;white-space:nowrap;';
    actions.appendChild(btn);`
        : ''
    }
    var closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.textContent = '×';
    closeBtn.style.cssText = 'background:transparent;border:none;color:#9ca3af;font-size:16px;cursor:pointer;padding:2px 6px;';
    closeBtn.onclick = function() { bar.remove(); };
    actions.appendChild(closeBtn);
    bar.appendChild(actions);
    document.body.appendChild(bar);
  } catch (_) {}
})();`
}

/**
 * Synchronously switch `WebContents.setUserAgent` BEFORE navigating to Google OAuth origins so
 * Chromium's C++ renderer exposes a clean Chrome (or Firefox compat) `navigator.userAgent` to
 * early inline Google scripts, and automatically restore the native UA when returning to
 * non-Google origins (such as Cloudflare Turnstile). Does NOT mutate `Session.setUserAgent`.
 */
export function attachGoogleOAuthWebContentsGuard(
  wc: WebContents | undefined | null,
  ses: Session | undefined | null,
  opts?: { allowGlobalCleanUa?: boolean }
): void {
  if (!wc || typeof wc !== 'object' || guardedWebContents.has(wc)) return
  guardedWebContents.add(wc)

  let nativeUa = ''
  try {
    nativeUa = (ses && typeof ses.getUserAgent === 'function' ? ses.getUserAgent() : '') ||
      (typeof wc.getUserAgent === 'function' ? wc.getUserAgent() : '')
  } catch {
    nativeUa = ''
  }

  /**
   * IMPORTANT: `webContents.setUserAgent()` on a WebContents that already has a committed
   * page makes Chromium reload that page, which CANCELS the in-flight navigation. Calling it
   * from `will-navigate` / `will-redirect` therefore (a) bounces `cue.im/login` back to itself
   * right after the Google button is clicked (Turnstile then re-runs under a mismatched UA and
   * fails with 600010) and (b) aborts the OAuth callback redirect off `accounts.google.com`.
   * Only swap the UA while nothing has been committed yet; for committed pages the HTTP
   * `User-Agent` / Client Hints are rewritten per request by `installGoogleOAuthHeaderGuard`
   * and `navigator.*` is patched by the Google-only frame preload.
   */
  const hasCommittedPage = (): boolean => {
    try {
      const current = typeof wc.getURL === 'function' ? wc.getURL() : ''
      return Boolean(current) && current !== 'about:blank'
    } catch {
      return true
    }
  }

  const syncUaForUrl = (targetUrl: string): void => {
    try {
      if (typeof wc.isDestroyed === 'function' && wc.isDestroyed()) return
      if (typeof wc.setUserAgent !== 'function') return
      if (hasCommittedPage()) return
      if (isGoogleAuthHostUrl(targetUrl)) {
        const nextUa = isGoogleFirefoxCompatMode(ses)
          ? buildGoogleFirefoxCompatUa()
          : cleanChromeUserAgentForGoogle(nativeUa)
        if (wc.getUserAgent() !== nextUa) wc.setUserAgent(nextUa)
        return
      }
      if (!opts?.allowGlobalCleanUa && nativeUa && targetUrl && targetUrl !== 'about:blank') {
        if (wc.getUserAgent() !== nativeUa) wc.setUserAgent(nativeUa)
      }
    } catch {
      /* ignore mock or destroyed webContents */
    }
  }

  if (typeof wc.on === 'function') {
    // Only the very first navigation of a fresh WebContents (e.g. an OAuth popup opened
    // straight onto accounts.google.com) may swap the UA without cancelling anything.
    wc.on('will-navigate', (_event, url) => syncUaForUrl(url))
    wc.on('will-redirect', (_event, url) => syncUaForUrl(url))
  }
}

/**
 * Strip `Electron/...` and `"Electron"` Client Hints + main-world `navigator` fingerprints
 * strictly on Google OAuth origins (`*.google.com`, `*.youtube.com`, `*.gstatic.com`,
 * `*.googleapis.com`, `*.googleusercontent.com`), leaving non-Google origins (such as
 * Cloudflare Turnstile pages) completely untouched.
 *
 * NOTE:
 * - In Electron 45.x, `ses.registerPreloadScript` is registered WITHOUT `matches` /
 *   `matchOriginAsFallback` because URL match patterns trigger an upstream Electron 45 bug
 *   causing `ERR_FAILED (-2)` on `accounts.google.com`. The injected script strictly self-gates
 *   on `isGoogleHost` at runtime so non-Google pages are 100% unaffected.
 * - Electron's `Session.webRequest.onBeforeSendHeaders` only retains one active listener
 *   per `Session` (calling it again replaces any prior listener). No other module should
 *   attach its own `onBeforeSendHeaders` handler directly to account sessions.
 */
export function installGoogleOAuthHeaderGuard(
  ses: Session | undefined | null,
  opts?: { preloadDir?: string; chromeVersion?: string; platform?: NodeJS.Platform }
): void {
  if (!ses || typeof ses !== 'object') return

  if (!guardedSessions.has(ses)) {
    const webRequest = (ses as Session & { webRequest?: Session['webRequest'] }).webRequest
    if (webRequest && typeof webRequest.onBeforeSendHeaders === 'function') {
      guardedSessions.add(ses)
      webRequest.onBeforeSendHeaders(
        {
          urls: [...GOOGLE_OAUTH_URL_PATTERNS]
        },
        (details, callback) => {
          callback({
            requestHeaders: sanitizeGoogleRequestHeaders(
              details.requestHeaders,
              opts?.chromeVersion,
              opts?.platform,
              { firefoxCompat: isGoogleFirefoxCompatMode(ses) && isGoogleAuthHostUrl(details.url) }
            )
          })
        }
      )
    }
  }

  const extSes = ses as Session & {
    registerPreloadScript?: (script: {
      id?: string
      type: 'frame' | 'service-worker'
      filePath: string
    }) => string
    getPreloadScripts?: () => Array<{ id?: string }>
  }
  if (typeof extSes.registerPreloadScript === 'function') {
    try {
      const existingScripts = extSes.getPreloadScripts?.() ?? []
      if (!existingScripts.some((s) => s.id === GOOGLE_OAUTH_PRELOAD_ID)) {
        const dir = resolvePreloadDir(ses, opts?.preloadDir)
        const source = buildGoogleOAuthPreloadScriptSource(opts?.chromeVersion, opts?.platform)
        const filePath = materializePreloadScript(dir, source)
        extSes.registerPreloadScript({
          id: GOOGLE_OAUTH_PRELOAD_ID,
          type: 'frame',
          filePath
        })
      }
    } catch {
      /* ignore mock sessions or transient registration failures */
    }
  }
}
