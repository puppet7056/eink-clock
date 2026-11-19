import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import esbuild from 'esbuild';
import fs from 'fs';
import path from 'path';
import {defineConfig, type Plugin} from 'vite';

/**
 * Unwraps CSS `@layer name { ... }` blocks and strips bare `@layer ...;`
 * declarations so older Android System WebViews (e.g. Android 8.1/11 E-Ink
 * readers running Chromium 66-83, which ignore `@layer` before Chrome 99)
 * still apply all Tailwind CSS v4 styles cleanly in exact cascade order.
 */
function unwrapCssLayers(css: string): string {
  let out = '';
  let i = 0;
  const len = css.length;

  while (i < len) {
    if (css.startsWith('@layer', i) && (i === 0 || /[\s};]/.test(css[i - 1]))) {
      const nextChar = css[i + 6];
      if (nextChar && /[\s{;]/.test(nextChar)) {
        let j = i + 6;
        while (j < len && css[j] !== '{' && css[j] !== ';') {
          j++;
        }
        if (j < len && css[j] === ';') {
          i = j + 1;
          continue;
        }
        if (j < len && css[j] === '{') {
          // Extract balanced inner block
          let depth = 1;
          let k = j + 1;
          while (k < len && depth > 0) {
            if (css[k] === '{') depth++;
            else if (css[k] === '}') depth--;
            k++;
          }
          const inner = css.slice(j + 1, k - 1);
          out += unwrapCssLayers(inner);
          i = k;
          continue;
        }
      }
    }
    out += css[i];
    i++;
  }

  return out;
}

/**
 * Makes Tailwind CSS v4 output compatible with legacy Android E-Ink WebViews
 * (Chromium 64-98, e.g. HanLinYue Read6 Android 8.1/11 stock WebView).
 */
function transformCssForLegacyWebView(rawCss: string): string {
  let css = unwrapCssLayers(rawCss);

  // Rewrite Tailwind v4 `.dark\:*:where(.dark, .dark *, .dark-mode, .dark-mode *)`
  // (including escaped modifiers like `.dark\:hover\:bg-\[\#1f1f21\]`)
  // into standard descendant selectors supported since Chrome 4
  css = css.replace(
    /(\.dark\\:(?:\\.|[^\s{,:])+):where\(\.dark,\s*\.dark \*,\s*\.dark-mode,\s*\.dark-mode \*\)(:[a-zA-Z-]+)?/g,
    (_m, cls: string, pseudo = '') => `.dark ${cls}${pseudo}, .dark-mode ${cls}${pseudo}`
  );

  // Unwrap `:where(.divide-... > :not(:last-child))` (including escaped parens like `var(--border-subtle)`)
  css = css.replace(/:where\((\.divide-(?:\\.|[^)])+\s*>\s*:not\(:last-child\))\)/g, '$1');

  // Simplify Tailwind v4 base `:where(...)` selectors for Chrome < 88
  css = css.replace(/abbr:where\(\[title\]\)/g, 'abbr[title]');
  css = css.replace(/\[hidden\]:where\(:not\(\[hidden="until-found"\]\)\)/g, '[hidden]');
  css = css.replace(
    /button,\s*input:where\(\[type="button"\],\s*\[type="reset"\],\s*\[type="submit"\]\)/g,
    'button, input[type="button"], input[type="reset"], input[type="submit"]'
  );

  // Expand `inset: 0` shorthand for Chrome < 87 (with or without trailing semicolon)
  css = css.replace(/\binset\s*:\s*0(\s*[;}])/g, 'top:0;right:0;bottom:0;left:0$1');

  // Provide fallback font-size before `font-size: min(..., calc(clamp(MINpx, ...)))` for Chrome < 79
  css = css.replace(
    /font-size\s*:\s*min\([^;{}]*clamp\((\d+(?:\.\d+)?)px[^;{}]*\)\s*\*\s*var\(--fs-clock\)\)\s*\)\s*;?/g,
    (full, minPx: string) => `font-size:calc(${minPx}px * var(--fs-clock));${full}`
  );

  // Unconditionally initialize Tailwind v4 `@property` defaults for Chromium 64-84
  // (which neither supports `@property` nor matches Tailwind's Safari/Firefox `@supports` fallback)
  const legacyTwDefaults =
    '*,:before,:after{--tw-divide-y-reverse:0;--tw-border-style:solid;--tw-outline-style:solid;}\n';

  return legacyTwDefaults + css;
}

/**
 * In Cordova APK builds (`VITE_CORDOVA_BUILD=1`), Google sign-in uses the native
 * Android PKCE OAuth plugin rather than the Firebase Web SDK. Stubbing firebase/app
 * and firebase/auth removes ~800 KB of unused JS so older 6-inch E-Ink readers boot fast.
 */
function cordovaStripFirebaseWebPlugin(isCordovaBuild: boolean): Plugin {
  const virtualId = '\0cordova-firebase-stub';
  return {
    name: 'cordova-strip-firebase-web',
    enforce: 'pre',
    apply: 'build',
    resolveId(source) {
      if (isCordovaBuild && (source === 'firebase/app' || source === 'firebase/auth')) {
        return virtualId;
      }
      return null;
    },
    load(id) {
      if (id === virtualId) {
        return [
          'export function getApps() { return []; }',
          'export function initializeApp() { return {}; }',
          'export function getAuth() { return {}; }',
          'export class GoogleAuthProvider { addScope() {} setCustomParameters() {} static credentialFromResult() { return null; } }',
          'export async function signInWithPopup() { throw new Error("Use native Android OAuth"); }',
          'export async function signOut() {}',
        ].join('\n');
      }
      return null;
    },
  };
}

function legacyEinkWebViewPlugin(): Plugin {
  return {
    name: 'legacy-eink-webview-compat',
    enforce: 'post',
    apply: 'build',
    generateBundle(_options, bundle) {
      for (const item of Object.values(bundle)) {
        if (item.type === 'chunk' && item.fileName.endsWith('.js')) {
          const transformed = esbuild.transformSync(item.code, {
            target: 'chrome64',
            format: 'iife',
            minify: true,
            legalComments: 'none',
            define: {
              'import.meta.url': 'document.baseURI',
              'import.meta.resolve': 'undefined',
            },
          });
          item.code = transformed.code;
        } else if (item.type === 'asset' && item.fileName.endsWith('.css')) {
          const cssStr =
            typeof item.source === 'string'
              ? item.source
              : Buffer.from(item.source).toString('utf8');
          item.source = transformCssForLegacyWebView(cssStr);
        }
      }
    },
    transformIndexHtml(html) {
      // Convert ES module script tag to classic `<script defer>` and strip `crossorigin`
      // so Cordova's `file:///android_asset/www/index.html` never hits file:// CORS module blocks
      // on older Android System WebViews (e.g. HanLinYue Read6 Android 8.1/11).
      return html
        .replace(
          /<script\s+type="module"\s+(?:crossorigin\s+)?src="([^"]+)"\s*><\/script>/g,
          '<script defer src="$1"></script>'
        )
        .replace(
          /<link\s+rel="stylesheet"\s+crossorigin\s+href="([^"]+)"\s*\/?>/g,
          '<link rel="stylesheet" href="$1" />'
        );
    },
  };
}

export default defineConfig(() => {
  const isCordovaBuild = process.env.VITE_CORDOVA_BUILD === '1';

  return {
    base: './',
    build: {
      target: 'chrome64',
      cssTarget: 'chrome64',
      cssCodeSplit: false,
      rollupOptions: {
        output: {
          inlineDynamicImports: true,
        },
      },
    },
    plugins: [
      react(),
      tailwindcss(),
      cordovaStripFirebaseWebPlugin(isCordovaBuild),
      legacyEinkWebViewPlugin(),
      // Copies src/assets into dist/ so root-relative URLs like
      // "/src/assets/images/..." (e.g. generate_image output) still resolve
      // in production builds. Do not remove.
      {
        name: 'copy-unbundled-src-assets',
        apply: 'build',
        closeBundle(error?: Error): void {
          if (error) {
            return;
          }
          const distDir = path.resolve(__dirname, 'dist');
          const srcAssets = path.resolve(__dirname, 'src/assets');
          const distAssets = path.resolve(distDir, 'src/assets');
          if (fs.existsSync(distDir) && fs.existsSync(srcAssets)) {
            fs.cpSync(srcAssets, distAssets, {recursive: true, force: true});
          }
        },
      },
    ],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
