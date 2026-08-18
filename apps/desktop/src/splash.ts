/**
 * Desktop launch splash: the animated page shown while the harness host
 * boots, plus the plugin splash extension point. Electron-free on purpose so
 * it stays unit-testable and renderable under plain Node.
 *
 * Splash plugin protocol: an installed web-profile bundle may declare
 * `dsh.desktop.splash` in its package.json pointing at a self-contained HTML
 * file (relative to the package root). The shell scans installed plugins at
 * boot and uses the first valid declaration instead of the built-in page;
 * unreadable, path-escaping, or absent declarations fall back silently. The
 * HTML should implement `window.__dshSplashExit()` (Promise) so the shell can
 * play a smooth exit before navigating to the real UI; pages without it get a
 * fixed 450ms fade.
 *
 * The built-in page plays: whale swims in from the left (0.8s) → breathing +
 * brand-blue ripple loop → on `__dshSplashExit` the whale swims out right
 * while the whole page fades to the dark background, then the shell loads the
 * real UI over the same dark base. All motion uses transform/opacity (GPU
 * composited) and respects `prefers-reduced-motion`.
 * @module @deepseek-ai/dsh-desktop/splash
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'

/** The favicon whale (apps/web/public/favicon.svg), white-filled for the dark splash. */
const WHALE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 50 50" fill="none" aria-hidden="true"><path d="M48.8354 10.0479C48.3232 9.79199 48.1025 10.2798 47.8032 10.5278C47.7007 10.6079 47.6143 10.7119 47.5273 10.8076C46.7793 11.624 45.9048 12.1597 44.7622 12.0957C43.0923 12 41.666 12.5356 40.4058 13.8398C40.1377 12.2319 39.2476 11.272 37.8926 10.6558C37.1836 10.3359 36.4668 10.0156 35.9702 9.31982C35.6235 8.82373 35.5293 8.27197 35.356 7.72754C35.2456 7.3999 35.1353 7.06396 34.7651 7.00781C34.3633 6.94385 34.2056 7.2876 34.0479 7.57568C33.418 8.75195 33.1733 10.0479 33.1973 11.3599C33.2524 14.312 34.4736 16.6641 36.8999 18.3359C37.1758 18.5278 37.2466 18.7197 37.1597 19C36.9946 19.5757 36.7974 20.1357 36.624 20.7119C36.5137 21.0801 36.3486 21.1597 35.9624 21C34.6309 20.4321 33.481 19.5918 32.4644 18.5757C30.7393 16.8721 29.1792 14.9917 27.2334 13.52C26.7764 13.1758 26.3193 12.856 25.8467 12.5518C23.8618 10.584 26.1069 8.96777 26.627 8.77588C27.1704 8.57568 26.8159 7.8877 25.0591 7.896C23.3022 7.90381 21.6953 8.50391 19.647 9.30371C19.3477 9.42383 19.0322 9.51172 18.7095 9.58398C16.8501 9.22363 14.9199 9.14355 12.9033 9.37598C9.10596 9.80762 6.07275 11.6396 3.84326 14.7681C1.16455 18.5278 0.53418 22.7998 1.30664 27.2559C2.11768 31.9521 4.46582 35.8398 8.07373 38.8799C11.8159 42.0322 16.1255 43.5762 21.041 43.2803C24.0269 43.104 27.3516 42.6963 31.1016 39.4561C32.0469 39.936 33.0396 40.1279 34.686 40.272C35.9546 40.3921 37.1758 40.208 38.1211 40.0078C39.6021 39.688 39.4995 38.2881 38.9639 38.0322C34.623 35.9678 35.5762 36.8081 34.71 36.1279C36.9155 33.4639 40.2402 30.6958 41.54 21.728C41.6426 21.0161 41.5557 20.5679 41.54 19.9917C41.5322 19.6396 41.6108 19.5039 42.0049 19.4639C43.0923 19.3359 44.1479 19.0317 45.1167 18.4878C47.9292 16.9199 49.064 14.3438 49.3315 11.2559C49.3711 10.7837 49.3237 10.2959 48.8354 10.0479ZM24.3262 37.8398C20.1196 34.4639 18.0791 33.3521 17.2358 33.3999C16.4482 33.4482 16.5898 34.3682 16.7632 34.9678C16.9443 35.5601 17.1812 35.9683 17.5117 36.4878C17.7402 36.832 17.8979 37.3442 17.2832 37.728C15.9282 38.584 13.5728 37.4399 13.4624 37.3838C10.7207 35.7358 8.42822 33.5601 6.81348 30.584C5.25342 27.7197 4.34766 24.6479 4.19775 21.3677C4.1582 20.5757 4.38672 20.2959 5.15869 20.1519C6.17529 19.96 7.22314 19.9199 8.23926 20.0718C12.5327 20.7119 16.1885 22.6719 19.2529 25.7759C21.002 27.5439 22.3252 29.6558 23.6885 31.7202C25.1377 33.9121 26.6978 36 28.6831 37.7119C29.3843 38.312 29.9434 38.7681 30.479 39.104C28.8643 39.2881 26.1699 39.3281 24.3262 37.8398ZM26.3433 24.6001C26.3433 24.248 26.6191 23.9678 26.9658 23.9678C27.0444 23.9678 27.1152 23.9839 27.1782 24.0078C27.2651 24.04 27.3438 24.0879 27.4067 24.1602C27.5171 24.272 27.5801 24.4321 27.5801 24.6001C27.5801 24.9521 27.3042 25.2319 26.9575 25.2319C26.6108 25.2319 26.3433 24.9521 26.3433 24.6001ZM32.6064 27.8799C32.2046 28.0479 31.8027 28.1919 31.4165 28.208C30.8179 28.2397 30.1641 27.9922 29.8096 27.688C29.2583 27.2158 28.8643 26.9521 28.6987 26.1279C28.6279 25.7759 28.6675 25.2319 28.7305 24.9199C28.8721 24.248 28.7144 23.8159 28.2495 23.4238C27.8716 23.104 27.3911 23.0161 26.8633 23.0161C26.666 23.0161 26.4849 22.9277 26.3511 22.856C26.1304 22.7441 25.9492 22.4639 26.1226 22.1201C26.1777 22.0078 26.4458 21.7358 26.5088 21.688C27.2256 21.272 28.0527 21.4077 28.8169 21.7197C29.5259 22.0161 30.0615 22.5601 30.834 23.3281C31.6216 24.2559 31.7632 24.5117 32.2124 25.208C32.5669 25.752 32.8901 26.312 33.1104 26.9521C33.2446 27.3521 33.0713 27.6802 32.6064 27.8799Z" fill="#fff" fill-rule="nonzero"/></svg>'

/** Exit animation durations; the page fades these exact amounts so the shell waits long enough. */
const EXIT_MS = 450
/** Buffer past the CSS exit so the final frame is painted before navigation. */
const EXIT_BUFFER_MS = 80

/**
 * Built-in animated splash: whale swims in from the left, settles into a
 * breathing + ripple loop, and exits right while the page fades to the dark
 * background. Exposes `window.__dshSplashExit()` for the shell to await.
 */
export const DEFAULT_SPLASH_HTML = [
  '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>',
  'html,body{height:100%;margin:0;background:#0d1117;color:#eef0f3;font-family:system-ui,"Segoe UI","Microsoft YaHei",sans-serif;display:flex;align-items:center;justify-content:center;overflow:hidden;}',
  '.stars{position:fixed;inset:0;pointer-events:none;opacity:0;animation:starsIn .6s ease-out .25s forwards;',
  'background-image:radial-gradient(1px 1px at 18% 28%,rgb(238 240 243 / .16) 50%,transparent 50%),',
  'radial-gradient(1px 1px at 72% 18%,rgb(86 134 254 / .22) 50%,transparent 50%),',
  'radial-gradient(1.5px 1.5px at 42% 72%,rgb(238 240 243 / .12) 50%,transparent 50%),',
  'radial-gradient(1px 1px at 86% 58%,rgb(86 134 254 / .16) 50%,transparent 50%),',
  'radial-gradient(1px 1px at 8% 82%,rgb(238 240 243 / .1) 50%,transparent 50%);}',
  '@keyframes starsIn{to{opacity:1;}}',
  '.wrap{text-align:center;}',
  '.stage{position:relative;width:112px;height:112px;margin:0 auto 26px;}',
  '.rings{position:absolute;inset:0;}',
  '.ring{position:absolute;inset:0;border:1.5px solid rgb(86 134 254 / .5);border-radius:50%;opacity:0;animation:ripple 2.6s ease-out infinite;}',
  '.ring:nth-child(2){animation-delay:1.3s;}',
  '@keyframes ripple{0%{transform:scale(.6);opacity:.75;}100%{transform:scale(1.8);opacity:0;}}',
  '.enter{position:absolute;inset:0;transform:translateX(-42vw);animation:whaleIn .8s cubic-bezier(.22,.9,.28,1) forwards;}',
  '@keyframes whaleIn{from{transform:translateX(-42vw);}to{transform:translateX(0);}}',
  '.logo{position:absolute;inset:0;display:grid;place-items:center;animation:whaleFloat 2.8s ease-in-out 1.05s infinite;}',
  '.logo svg{width:96px;height:96px;display:block;filter:drop-shadow(0 8px 20px rgb(0 0 0 / .45));}',
  '@keyframes whaleFloat{0%,100%{transform:translateY(0) scale(1);}50%{transform:translateY(-7px) scale(1.04);}}',
  '.name{font-size:20px;font-weight:600;letter-spacing:.08em;}',
  '.hint{font-size:12px;color:rgb(238 240 243 / .55);margin-top:10px;}',
  '.hint::after{content:"";animation:dots 1.4s steps(4,end) infinite;}',
  '@keyframes dots{0%{content:"";}25%{content:".";}50%{content:"..";}75%{content:"...";}}',
  '.exiting .enter{animation:whaleOut .45s cubic-bezier(.55,0,.85,.36) forwards;}',
  '@keyframes whaleOut{from{transform:translateX(0);}to{transform:translateX(46vw);}}',
  '.exiting{animation:fadeOut .45s ease-in forwards;}',
  '@keyframes fadeOut{to{opacity:0;}}',
  '@media (prefers-reduced-motion: reduce){',
  '.stars{animation:none !important;opacity:1;}',
  '.enter{animation:none !important;transform:none;}',
  '.logo{animation:none !important;}',
  '.ring{animation:none !important;opacity:.3;}',
  '.hint::after{animation:none !important;}',
  '.exiting{animation:fadeOut .12s linear forwards;}',
  '.exiting .enter{animation:none !important;transform:none;}',
  '}',
  '</style></head><body>',
  '<div class="stars"></div>',
  '<div class="wrap">',
  '<div class="stage">',
  '<div class="rings"><div class="ring"></div><div class="ring"></div></div>',
  '<div class="enter"><div class="logo">' + WHALE_SVG + '</div></div>',
  '</div>',
  '<div class="name">DeepSeek Harness</div>',
  '<div class="hint">正在启动</div>',
  '</div>',
  '<script>',
  'window.__dshSplashExit = () => new Promise((resolve) => {',
  'document.documentElement.classList.add("exiting");',
  'setTimeout(resolve, ' + (EXIT_MS + EXIT_BUFFER_MS) + ');',
  '});',
  '</script>',
  '</body></html>',
].join('')

/**
 * The pre-animation splash (static spinner + wordmark), kept as a fallback:
 * set `DSH_DESKTOP_LEGACY_SPLASH=1` to use it instead of the animated page
 * and plugin splash sources.
 */
export const LEGACY_SPLASH_HTML = [
  '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>',
  'html,body{height:100%;margin:0;background:#0d1117;color:#eef0f3;font-family:system-ui,"Segoe UI","Microsoft YaHei",sans-serif;display:flex;align-items:center;justify-content:center;}',
  '.wrap{text-align:center;}',
  '.spinner{width:24px;height:24px;border:3px solid rgb(238 240 243 / .25);border-top-color:#eef0f3;border-radius:50%;margin:0 auto 18px;animation:spin 1s linear infinite;}',
  '@keyframes spin{to{transform:rotate(360deg);}}',
  '.name{font-size:18px;font-weight:600;letter-spacing:.02em;}',
  '.hint{font-size:12px;color:rgb(238 240 243 / .55);margin-top:8px;}',
  '</style></head><body><div class="wrap"><div class="spinner"></div><div class="name">DeepSeek Harness</div><div class="hint">正在启动…</div></div></body></html>',
].join('')

/** package.json field a splash plugin declares: a relative self-contained HTML file. */
export const SPLASH_PROTOCOL_KEY = 'dsh.desktop.splash'

/** The web profile's installed-plugin root under a harness home. */
function pluginModulesDir(home: string): string {
  return join(home, 'profiles', 'web', 'node_modules')
}

/** Read one package's declared splash path; malformed or absent yields undefined. */
function declaredSplashPath(pkgDir: string): string | undefined {
  try {
    const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as {
      dsh?: { desktop?: { splash?: unknown } }
    }
    const splash = pkg.dsh?.desktop?.splash
    return typeof splash === 'string' && splash !== '' ? splash : undefined
  } catch {
    return undefined
  }
}

/**
 * Resolve the first usable plugin splash: scan top-level packages (and
 * `@scope/name` pairs) under the web profile, read each `dsh.desktop.splash`
 * HTML in directory order, and return the first non-empty file whose resolved
 * path stays inside its package directory. Any failure skips that plugin, so a
 * broken declaration never blocks startup.
 * @param home - harness home.
 * @returns the plugin splash HTML, or undefined when none is usable.
 */
export function readPluginSplashHtml(home: string): string | undefined {
  const modulesDir = pluginModulesDir(home)
  const packages: string[] = []
  try {
    for (const entry of readdirSync(modulesDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      if (entry.name.startsWith('@')) {
        const scopeDir = join(modulesDir, entry.name)
        for (const scoped of readdirSync(scopeDir, { withFileTypes: true })) {
          if (scoped.isDirectory()) packages.push(join(scopeDir, scoped.name))
        }
      } else {
        packages.push(join(modulesDir, entry.name))
      }
    }
  } catch {
    return undefined
  }
  for (const pkgDir of packages) {
    const declared = declaredSplashPath(pkgDir)
    if (declared === undefined) continue
    const target = resolve(pkgDir, declared)
    if (!target.startsWith(pkgDir + sep)) continue
    try {
      const html = readFileSync(target, 'utf8')
      if (html.trim() !== '') return html
    } catch {
      // 单个插件 splash 不可读：跳过，继续下一个。
    }
  }
  return undefined
}

/** Build the launch splash data URL: plugin splash when usable, else built-in. */
export function splashDataUrl(home: string): string {
  const html = process.env.DSH_DESKTOP_LEGACY_SPLASH === '1'
    ? LEGACY_SPLASH_HTML
    : readPluginSplashHtml(home) ?? DEFAULT_SPLASH_HTML
  return dataUrl(html)
}

/** Escape text for embedding in the splash HTML. */
function escapeHtml(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
}

/**
 * Splash variant reporting a host boot failure; always the built-in page so
 * the error stays visible regardless of which splash source was active.
 * @param error - the boot failure to surface.
 * @returns the error splash data URL.
 */
export function errorSplashDataUrl(error: unknown): string {
  const detail = String(error instanceof Error ? error.message : error).slice(0, 800)
  const html = DEFAULT_SPLASH_HTML
    .replace('<div class="hint">正在启动</div>', '<div class="hint">启动失败：<br>' + escapeHtml(detail) + '</div>')
  return dataUrl(html)
}

function dataUrl(html: string): string {
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html)
}
