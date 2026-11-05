import { defineConfig } from 'tsup'

export default defineConfig([
  {
    // ES module build: `@boxd-sh/sdk` stays an import, so an app that also uses the SDK
    // shares one copy of it (its error classes and its types) with this package.
    entry: ['src/index.ts'],
    format: ['esm'],
    splitting: false,
    sourcemap: true,
    clean: false,
  },
  {
    // CommonJS build: the official boxd SDK is ESM-only, so it is bundled into this one.
    // Its own dependencies (@grpc/grpc-js, @bufbuild/protobuf) are listed in package.json
    // and stay external.
    entry: ['src/index.ts'],
    format: ['cjs'],
    dts: true,
    splitting: false,
    sourcemap: true,
    clean: false,
    noExternal: ['@boxd-sh/sdk'],
  },
])
