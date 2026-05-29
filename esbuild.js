// Bundles the extension into a single dist/extension.js.
//
// ssh2 (via ssh2-sftp-client) optionally loads native addons — `cpu-features`
// and its own `*.node` crypto binding — inside try/catch, falling back to a
// pure-JS implementation. We mark those external so esbuild doesn't try to
// pull binaries into the bundle; at runtime the requires fail gracefully and
// ssh2 uses pure JS. `vscode` is always provided by the host, never bundled.
const esbuild = require('esbuild');

const nativeExternal = {
  name: 'native-node-external',
  setup(build) {
    build.onResolve({ filter: /\.node$/ }, (args) => ({ path: args.path, external: true }));
  },
};

esbuild
  .build({
    entryPoints: ['extension.js'],
    bundle: true,
    platform: 'node',
    target: 'node16',
    format: 'cjs',
    outfile: 'dist/extension.js',
    external: ['vscode', 'cpu-features'],
    minify: true,
    sourcemap: false,
    legalComments: 'none',
    plugins: [nativeExternal],
    logLevel: 'info',
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
