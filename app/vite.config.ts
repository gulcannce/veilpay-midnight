import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, normalize, posix, relative, resolve, sep } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import wasm from 'vite-plugin-wasm';

const PROJECT_ROOT = resolve(import.meta.dirname, '..');

/** Where `compact compile` writes the ZK artifacts for the spending policy. */
const ZK_ASSETS_DIR = join(PROJECT_ROOT, 'contracts/managed/spending_policy');

/** URL prefix `FetchZkConfigProvider` is pointed at. Mirrored in `src/midnight/providers.ts`. */
const ZK_ASSETS_ROUTE = 'zk';

/**
 * Subdirectories of the compiler output that may be published.
 *
 * `FetchZkConfigProvider` reads exactly these two. The compiler also writes
 * `compiler/` and `contract/` next to them; those are build inputs with no
 * business being fetchable, so the allowlist keeps them off the wire in both
 * dev and production rather than relying on nobody guessing the path.
 */
const PUBLISHED_SUBDIRS = ['keys', 'zkir'] as const;

/** Every publishable artifact, as paths relative to {@link ZK_ASSETS_DIR}. */
const publishedArtifacts = (): string[] =>
  PUBLISHED_SUBDIRS.flatMap((subdir) => {
    const dir = join(ZK_ASSETS_DIR, subdir);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((name) => statSync(join(dir, name)).isFile())
      .map((name) => posix.join(subdir, name));
  });

/**
 * Publishes the compiled ZK artifacts at `/zk`.
 *
 * Dev goes through a middleware and the build emits the same files as bundle
 * assets, so both environments serve the compiler's current output. Copying
 * into `public/` instead would leave a stale duplicate behind after a
 * recompile, and a stale prover key produces proofs the deployed verifier key
 * rejects.
 */
const zkAssets = (): Plugin => ({
  name: 'veilpay-zk-assets',

  configureServer(server) {
    const allowed = new Set(publishedArtifacts());
    server.middlewares.use(`/${ZK_ASSETS_ROUTE}`, (req, res, next) => {
      const requested = normalize(decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/'))
        .replace(/^[/\\]+/, '')
        .split(sep)
        .join(posix.sep);
      if (!allowed.has(requested)) {
        next();
        return;
      }
      // Artifacts are opaque binaries; an explicit type keeps the dev server
      // from guessing text/html, which the provider rejects outright.
      res.setHeader('Content-Type', 'application/octet-stream');
      createReadStream(join(ZK_ASSETS_DIR, requested)).pipe(res);
    });
  },

  generateBundle() {
    const artifacts = publishedArtifacts();
    if (artifacts.length === 0) {
      this.error(
        `No ZK artifacts under ${relative(PROJECT_ROOT, ZK_ASSETS_DIR)}. ` +
          'Run `npm run compile` in the project root before building.',
      );
    }
    for (const artifact of artifacts) {
      this.emitFile({
        type: 'asset',
        fileName: posix.join(ZK_ASSETS_ROUTE, artifact),
        source: readFileSync(join(ZK_ASSETS_DIR, artifact)),
      });
    }
  },
});

export default defineConfig({
  // `wasm` handles the wasm-bindgen bundler-target imports in `@midnight-ntwrk/ledger-v8`
  // (`import * as wasm from './midnight_ledger_wasm_bg.wasm'`). No top-level-await
  // plugin: the esnext target below lets the browser and Rolldown handle it natively.
  plugins: [react(), wasm(), zkAssets()],
  server: {
    port: 5173,
    fs: {
      // The compiled contract and its witnesses live outside `app/`, in the
      // repo that also holds the Compact sources.
      allow: [PROJECT_ROOT],
    },
  },
  // `app/node_modules` and the repo root each carry their own copy of the
  // Midnight packages. The compiled contract lives outside `app/` and so
  // resolves `@midnight-ntwrk/compact-runtime` against the root copy, while
  // everything under `app/src` resolves against the local one. For the
  // wasm-bindgen packages that means two WASM instances, and `new QueryContext`
  // then rejects a `ChargedState` produced by the other copy: wasm-bindgen's
  // `_assertClass` is an `instanceof` check against the class its own module
  // defines. Deduping collapses every shared package onto the copy under the
  // Vite root, leaving one instance of each.
  resolve: {
    dedupe: [
      '@midnight-ntwrk/compact-js',
      '@midnight-ntwrk/compact-runtime',
      '@midnight-ntwrk/dapp-connector-api',
      '@midnight-ntwrk/ledger-v8',
      '@midnight-ntwrk/midnight-js-contracts',
      '@midnight-ntwrk/midnight-js-indexer-public-data-provider',
      '@midnight-ntwrk/midnight-js-level-private-state-provider',
      '@midnight-ntwrk/midnight-js-network-id',
      '@midnight-ntwrk/midnight-js-protocol',
      '@midnight-ntwrk/midnight-js-types',
      '@midnight-ntwrk/midnight-js-utils',
      '@midnight-ntwrk/onchain-runtime-v3',
      '@midnight-ntwrk/platform-js',
      '@midnight-ntwrk/wallet-sdk-address-format',
    ],
  },
  build: { target: 'esnext' },
});
