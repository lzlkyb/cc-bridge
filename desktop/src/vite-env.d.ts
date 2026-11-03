/// <reference types="vite/client" />

/* 前端 tsconfig 没有装 @types/node（故意的：src 跑在 WebView 里，不该随手用
   process / Buffer 这些只有 Node 才有的全局）。但样式源文本的契约测试
   （src/lib/appearanceBadgeFabric.test.ts）必须读文件——vitest 的 CSS 处理会把
   `import "*.css?raw"` 也替换成空模块（实测 length 为 0），绕不过去。
   所以只补测试真正用到的那两个函数，且只接受 URL 入参。 */
declare module "node:fs" {
  export function readFileSync(path: URL, encoding: "utf8"): string;
  export function existsSync(path: URL): boolean;
}
