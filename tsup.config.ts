import { defineConfig } from 'tsup';

// 库打包:单入口 src/index.ts → 同时产出 CommonJS(.js)、ESM(.mjs)与类型声明(.d.ts)。
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'node18',
  platform: 'node',
  // 注入 __dirname / import.meta 垫片,使 ESM 产物也能用 __dirname 定位自带二进制
  shims: true,
  // js-yaml 作为运行时依赖,不打进 bundle
  external: ['js-yaml'],
});
