# 第三方声明 / Third-Party Notices

WorldBase（the-world 仓库）本体采用 [Apache-2.0](LICENSE) 许可证。本文件汇总随源码与发布产物分发的第三方依赖及其许可证声明。

- 生成日期：2026-10-01。数据来源：`pnpm licenses list --prod`（npm 生产依赖含传递依赖，403 个）、`harness-rs/Cargo.lock`（300 个外部 crate）+ crates.io API、`apps/mobile/pubspec.lock`（122 个 pub.dev 包）。**更新依赖后请重新生成本文件。**
- Rust 依赖全部为宽松（permissive）或 OR 双授权协议，与 Apache-2.0 兼容，无 copyleft 传染。
- `sharp` 及 `@img/*` 平台包捆绑 libvips 预编译二进制（**LGPL-3.0-or-later**，动态链接）。本项目整体以源码开放，LGPL 对应义务随源码分发满足；单独分发二进制产物时须保留本声明并按 LGPL 要求提供 libvips 对应源码指引（https://github.com/libvips/libvips）。
- `katex`（MIT）内含 KaTeX 字体文件采用 SIL OFL 1.1。
- 移动端捆绑的 `mermaid.min.js`（MIT）声明见 [apps/mobile/assets/THIRD_PARTY_NOTICES.md](apps/mobile/assets/THIRD_PARTY_NOTICES.md)。
- Flutter/Dart 包的许可证元数据不经 pub.dev API 暴露，下表为分发清单；各包许可证见其 LICENSE 文件（https://pub.dev/packages/<名称>/license），Flutter 构建亦会在发布产物中生成聚合 NOTICES。
- 标注 NOT DECLARED 的包在 registry 元数据中未声明许可证，以包内 LICENSE 文件为准。

## npm（apps/electron，生产依赖 + 传递依赖）

### MIT (319)

| 包 / Package | 版本 | 许可证 / License |
| --- | --- | --- |
| @antfu/install-pkg | 1.1.0 | MIT |
| @babel/helper-string-parser | 7.27.1 | MIT |
| @babel/helper-validator-identifier | 7.28.5 | MIT |
| @babel/parser | 7.29.2 | MIT |
| @babel/types | 7.29.0 | MIT |
| @braintree/sanitize-url | 7.1.2 | MIT |
| @cfworker/json-schema | 4.1.1 | MIT |
| @fast-csv/format | 4.3.5 | MIT |
| @fast-csv/parse | 4.3.6 | MIT |
| @iconify/types | 2.0.0 | MIT |
| @iconify/utils | 3.1.0 | MIT |
| @img/colour | 1.1.0 | MIT |
| @intlify/core-base | 9.14.5 | MIT |
| @intlify/message-compiler | 9.14.5 | MIT |
| @intlify/shared | 9.14.5 | MIT |
| @jridgewell/sourcemap-codec | 1.5.5 | MIT |
| @mermaid-js/parser | 1.1.0 | MIT |
| @modelcontextprotocol/client | 2.0.0-alpha.2 | MIT |
| @napi-rs/canvas | 0.1.80 | MIT |
| @napi-rs/canvas | 0.1.97 | MIT |
| @napi-rs/canvas-darwin-arm64 | 0.1.80 | MIT |
| @napi-rs/canvas-darwin-arm64 | 0.1.97 | MIT |
| @pdf-lib/fontkit | 1.1.1 | MIT |
| @pdf-lib/standard-fonts | 1.0.0 | MIT |
| @pdf-lib/upng | 1.0.1 | MIT |
| @types/body-parser | 1.19.6 | MIT |
| @types/connect | 3.4.38 | MIT |
| @types/d3 | 7.4.3 | MIT |
| @types/d3-array | 3.2.2 | MIT |
| @types/d3-axis | 3.0.6 | MIT |
| @types/d3-brush | 3.0.6 | MIT |
| @types/d3-chord | 3.0.6 | MIT |
| @types/d3-color | 3.1.3 | MIT |
| @types/d3-contour | 3.0.6 | MIT |
| @types/d3-delaunay | 6.0.4 | MIT |
| @types/d3-dispatch | 3.0.7 | MIT |
| @types/d3-drag | 3.0.7 | MIT |
| @types/d3-dsv | 3.0.7 | MIT |
| @types/d3-ease | 3.0.2 | MIT |
| @types/d3-fetch | 3.0.7 | MIT |
| @types/d3-force | 3.0.10 | MIT |
| @types/d3-format | 3.0.4 | MIT |
| @types/d3-geo | 3.1.0 | MIT |
| @types/d3-hierarchy | 3.1.7 | MIT |
| @types/d3-interpolate | 3.0.4 | MIT |
| @types/d3-path | 3.1.1 | MIT |
| @types/d3-polygon | 3.0.2 | MIT |
| @types/d3-quadtree | 3.0.6 | MIT |
| @types/d3-random | 3.0.3 | MIT |
| @types/d3-scale | 4.0.9 | MIT |
| @types/d3-scale-chromatic | 3.1.0 | MIT |
| @types/d3-selection | 3.0.11 | MIT |
| @types/d3-shape | 3.1.8 | MIT |
| @types/d3-time | 3.0.4 | MIT |
| @types/d3-time-format | 4.0.3 | MIT |
| @types/d3-timer | 3.0.2 | MIT |
| @types/d3-transition | 3.0.9 | MIT |
| @types/d3-zoom | 3.0.8 | MIT |
| @types/express | 5.0.6 | MIT |
| @types/express-serve-static-core | 5.1.1 | MIT |
| @types/geojson | 7946.0.16 | MIT |
| @types/http-errors | 2.0.5 | MIT |
| @types/http-proxy | 1.17.17 | MIT |
| @types/node | 14.18.63 | MIT |
| @types/node | 25.5.0 | MIT |
| @types/qs | 6.15.0 | MIT |
| @types/range-parser | 1.2.7 | MIT |
| @types/send | 1.2.1 | MIT |
| @types/serve-static | 2.2.0 | MIT |
| @types/trusted-types | 2.0.7 | MIT |
| @types/yauzl | 2.10.3 | MIT |
| @upsetjs/venn.js | 2.0.0 | MIT |
| @vue/compiler-core | 3.5.31 | MIT |
| @vue/compiler-dom | 3.5.31 | MIT |
| @vue/compiler-sfc | 3.5.31 | MIT |
| @vue/compiler-ssr | 3.5.31 | MIT |
| @vue/devtools-api | 6.6.4 | MIT |
| @vue/reactivity | 3.5.31 | MIT |
| @vue/runtime-core | 3.5.31 | MIT |
| @vue/runtime-dom | 3.5.31 | MIT |
| @vue/server-renderer | 3.5.31 | MIT |
| @vue/shared | 3.5.31 | MIT |
| @xmldom/xmldom | 0.8.12 | MIT |
| @xmldom/xmldom | 0.9.10 | MIT |
| accepts | 1.3.8 | MIT |
| acorn | 8.16.0 | MIT |
| ansi-regex | 5.0.1 | MIT |
| ansi-styles | 4.3.0 | MIT |
| archiver | 5.2.0 | MIT |
| archiver | 5.3.2 | MIT |
| archiver-utils | 2.1.0 | MIT |
| archiver-utils | 3.0.4 | MIT |
| argparse | 1.0.10 | MIT |
| array-flatten | 1.1.1 | MIT |
| async | 3.2.6 | MIT |
| balanced-match | 1.0.2 | MIT |
| base64-js | 1.5.1 | MIT |
| binary | 0.3.0 | MIT |
| bl | 4.1.0 | MIT |
| bluebird | 3.4.7 | MIT |
| body-parser | 1.20.4 | MIT |
| brace-expansion | 1.1.13 | MIT |
| brace-expansion | 2.0.3 | MIT |
| braces | 3.0.3 | MIT |
| buffer | 5.7.1 | MIT |
| buffer-crc32 | 0.2.13 | MIT |
| buffer-indexof-polyfill | 1.0.2 | MIT |
| bytenode | 1.5.7 | MIT |
| bytes | 3.1.2 | MIT |
| call-bind-apply-helpers | 1.0.2 | MIT |
| call-bound | 1.0.4 | MIT |
| camelcase | 5.3.1 | MIT |
| chevrotain-allstar | 0.4.1 | MIT |
| color-convert | 2.0.1 | MIT |
| color-name | 1.1.4 | MIT |
| commander | 7.2.0 | MIT |
| commander | 8.3.0 | MIT |
| compress-commons | 4.1.2 | MIT |
| concat-map | 0.0.1 | MIT |
| confbox | 0.1.8 | MIT |
| content-disposition | 0.5.4 | MIT |
| content-type | 1.0.5 | MIT |
| cookie | 0.7.2 | MIT |
| cookie-signature | 1.0.7 | MIT |
| core-util-is | 1.0.3 | MIT |
| cose-base | 1.0.3 | MIT |
| cose-base | 2.2.0 | MIT |
| crc32-stream | 4.0.3 | MIT |
| cross-spawn | 7.0.6 | MIT |
| csstype | 3.2.3 | MIT |
| cytoscape | 3.33.2 | MIT |
| cytoscape-cose-bilkent | 4.1.0 | MIT |
| cytoscape-fcose | 2.2.0 | MIT |
| dagre-d3-es | 7.0.14 | MIT |
| dayjs | 1.11.20 | MIT |
| debug | 2.6.9 | MIT |
| debug | 4.4.3 | MIT |
| decamelize | 1.2.0 | MIT |
| depd | 2.0.0 | MIT |
| destroy | 1.2.0 | MIT |
| dijkstrajs | 1.0.3 | MIT |
| dunder-proto | 1.0.1 | MIT |
| ee-first | 1.1.1 | MIT |
| emoji-regex | 8.0.0 | MIT |
| encodeurl | 2.0.0 | MIT |
| end-of-stream | 1.4.5 | MIT |
| es-define-property | 1.0.1 | MIT |
| es-errors | 1.3.0 | MIT |
| es-object-atoms | 1.1.1 | MIT |
| escape-html | 1.0.3 | MIT |
| estree-walker | 2.0.2 | MIT |
| etag | 1.8.1 | MIT |
| eventemitter3 | 4.0.7 | MIT |
| eventsource | 3.0.7 | MIT |
| eventsource-parser | 3.0.8 | MIT |
| exceljs | 4.4.0 | MIT |
| express | 4.22.1 | MIT |
| fast-csv | 4.3.6 | MIT |
| fast-image-size | 0.1.3 | MIT |
| fd-slicer | 1.1.0 | MIT |
| fill-range | 7.1.1 | MIT |
| finalhandler | 1.3.2 | MIT |
| find-up | 4.1.0 | MIT |
| follow-redirects | 1.15.11 | MIT |
| forwarded | 0.2.0 | MIT |
| fresh | 0.5.2 | MIT |
| fs-constants | 1.0.0 | MIT |
| function-bind | 1.1.2 | MIT |
| get-intrinsic | 1.3.0 | MIT |
| get-proto | 1.0.1 | MIT |
| get-stream | 5.2.0 | MIT |
| gopd | 1.2.0 | MIT |
| hachure-fill | 0.5.2 | MIT |
| has-symbols | 1.1.0 | MIT |
| hasown | 2.0.2 | MIT |
| html-to-image | 1.11.13 | MIT |
| http-errors | 2.0.1 | MIT |
| http-proxy | 1.18.1 | MIT |
| http-proxy-middleware | 2.0.9 | MIT |
| iconv-lite | 0.4.24 | MIT |
| iconv-lite | 0.6.3 | MIT |
| immediate | 3.0.6 | MIT |
| ipaddr.js | 1.9.1 | MIT |
| is-extglob | 2.1.1 | MIT |
| is-fullwidth-code-point | 3.0.0 | MIT |
| is-glob | 4.0.3 | MIT |
| is-number | 7.0.0 | MIT |
| is-plain-obj | 3.0.0 | MIT |
| isarray | 1.0.0 | MIT |
| jose | 6.2.2 | MIT |
| katex | 0.16.45 | MIT |
| langium | 4.2.2 | MIT |
| layout-base | 1.0.2 | MIT |
| layout-base | 2.0.1 | MIT |
| lazystream | 1.0.1 | MIT |
| lie | 3.3.0 | MIT |
| locate-path | 5.0.0 | MIT |
| lodash | 4.17.23 | MIT |
| lodash-es | 4.18.1 | MIT |
| lodash.defaults | 4.2.0 | MIT |
| lodash.difference | 4.5.0 | MIT |
| lodash.escaperegexp | 4.1.2 | MIT |
| lodash.flatten | 4.4.0 | MIT |
| lodash.groupby | 4.6.0 | MIT |
| lodash.isboolean | 3.0.3 | MIT |
| lodash.isequal | 4.5.0 | MIT |
| lodash.isfunction | 3.0.9 | MIT |
| lodash.isnil | 4.0.0 | MIT |
| lodash.isplainobject | 4.0.6 | MIT |
| lodash.isundefined | 3.0.1 | MIT |
| lodash.union | 4.6.0 | MIT |
| lodash.uniq | 4.5.0 | MIT |
| magic-string | 0.30.21 | MIT |
| marked | 16.4.2 | MIT |
| marked | 17.0.5 | MIT |
| math-intrinsics | 1.1.0 | MIT |
| media-typer | 0.3.0 | MIT |
| merge-descriptors | 1.0.3 | MIT |
| mermaid | 11.14.0 | MIT |
| methods | 1.1.2 | MIT |
| micromatch | 4.0.8 | MIT |
| mime | 1.6.0 | MIT |
| mime-db | 1.52.0 | MIT |
| mime-types | 2.1.35 | MIT |
| minimist | 1.2.8 | MIT |
| mkdirp | 0.5.6 | MIT |
| mlly | 1.8.2 | MIT |
| ms | 2.0.0 | MIT |
| ms | 2.1.3 | MIT |
| nanoid | 3.3.11 | MIT |
| negotiator | 0.6.3 | MIT |
| node-readable-to-web-readable-stream | 0.4.2 | MIT |
| normalize-path | 3.0.0 | MIT |
| object-inspect | 1.13.4 | MIT |
| officegen | 0.6.5 | MIT |
| on-finished | 2.4.1 | MIT |
| p-limit | 2.3.0 | MIT |
| p-locate | 4.1.0 | MIT |
| p-try | 2.2.0 | MIT |
| package-manager-detector | 1.6.0 | MIT |
| parseurl | 1.3.3 | MIT |
| path-data-parser | 0.1.0 | MIT |
| path-exists | 4.0.0 | MIT |
| path-is-absolute | 1.0.1 | MIT |
| path-key | 3.1.1 | MIT |
| path-to-regexp | 0.1.13 | MIT |
| pathe | 2.0.3 | MIT |
| pdf-lib | 1.17.1 | MIT |
| pend | 1.2.0 | MIT |
| picomatch | 2.3.2 | MIT |
| pkce-challenge | 5.0.1 | MIT |
| pkg-types | 1.3.1 | MIT |
| pngjs | 5.0.0 | MIT |
| pnpm | 10.33.0 | MIT |
| points-on-curve | 0.2.0 | MIT |
| points-on-path | 0.2.1 | MIT |
| postcss | 8.5.8 | MIT |
| process-nextick-args | 2.0.1 | MIT |
| proxy-addr | 2.0.7 | MIT |
| pump | 3.0.4 | MIT |
| qrcode | 1.5.4 | MIT |
| range-parser | 1.2.1 | MIT |
| raw-body | 2.5.3 | MIT |
| readable-stream | 2.3.8 | MIT |
| readable-stream | 3.6.2 | MIT |
| require-directory | 2.1.1 | MIT |
| requires-port | 1.0.0 | MIT |
| roughjs | 4.6.6 | MIT |
| safe-buffer | 5.1.2 | MIT |
| safe-buffer | 5.2.1 | MIT |
| safer-buffer | 2.1.2 | MIT |
| send | 0.19.2 | MIT |
| serve-static | 1.16.3 | MIT |
| setimmediate | 1.0.5 | MIT |
| shebang-command | 2.0.0 | MIT |
| shebang-regex | 3.0.0 | MIT |
| side-channel | 1.1.0 | MIT |
| side-channel-list | 1.0.0 | MIT |
| side-channel-map | 1.0.1 | MIT |
| side-channel-weakmap | 1.0.2 | MIT |
| statuses | 2.0.2 | MIT |
| string_decoder | 1.1.1 | MIT |
| string_decoder | 1.3.0 | MIT |
| string-width | 4.2.3 | MIT |
| strip-ansi | 6.0.1 | MIT |
| stylis | 4.3.6 | MIT |
| tar-stream | 2.2.0 | MIT |
| tinyexec | 1.1.1 | MIT |
| tmp | 0.2.5 | MIT |
| to-regex-range | 5.0.1 | MIT |
| toidentifier | 1.0.1 | MIT |
| ts-dedent | 2.2.0 | MIT |
| type-is | 1.6.18 | MIT |
| ufo | 1.6.3 | MIT |
| underscore | 1.13.8 | MIT |
| undici-types | 7.18.2 | MIT |
| unpipe | 1.0.0 | MIT |
| unzipper | 0.10.14 | MIT |
| util-deprecate | 1.0.2 | MIT |
| utils-merge | 1.0.1 | MIT |
| uuid | 8.3.2 | MIT |
| uuid | 11.1.0 | MIT |
| vary | 1.1.2 | MIT |
| vscode-jsonrpc | 8.2.0 | MIT |
| vscode-languageserver | 9.0.1 | MIT |
| vscode-languageserver-protocol | 3.17.5 | MIT |
| vscode-languageserver-textdocument | 1.0.12 | MIT |
| vscode-languageserver-types | 3.17.5 | MIT |
| vscode-uri | 3.1.0 | MIT |
| vue | 3.5.31 | MIT |
| vue-i18n | 9.14.5 | MIT |
| wrap-ansi | 6.2.0 | MIT |
| xmlbuilder | 10.1.1 | MIT |
| xmlbuilder | 15.1.1 | MIT |
| xmlchars | 2.2.0 | MIT |
| yargs | 15.4.1 | MIT |
| yauzl | 2.10.0 | MIT |
| zip-stream | 4.1.1 | MIT |
| zod | 4.3.6 | MIT |

### ISC (58)

| 包 / Package | 版本 | 许可证 / License |
| --- | --- | --- |
| cliui | 6.0.0 | ISC |
| d3 | 7.9.0 | ISC |
| d3-array | 3.2.4 | ISC |
| d3-axis | 3.0.0 | ISC |
| d3-brush | 3.0.0 | ISC |
| d3-chord | 3.0.1 | ISC |
| d3-color | 3.1.0 | ISC |
| d3-contour | 4.0.2 | ISC |
| d3-delaunay | 6.0.4 | ISC |
| d3-dispatch | 3.0.1 | ISC |
| d3-drag | 3.0.0 | ISC |
| d3-dsv | 3.0.1 | ISC |
| d3-fetch | 3.0.1 | ISC |
| d3-force | 3.0.0 | ISC |
| d3-format | 3.1.2 | ISC |
| d3-geo | 3.1.1 | ISC |
| d3-hierarchy | 3.1.2 | ISC |
| d3-interpolate | 3.0.1 | ISC |
| d3-path | 3.1.0 | ISC |
| d3-polygon | 3.0.1 | ISC |
| d3-quadtree | 3.0.1 | ISC |
| d3-random | 3.0.1 | ISC |
| d3-scale | 4.0.2 | ISC |
| d3-scale-chromatic | 3.1.0 | ISC |
| d3-selection | 3.0.0 | ISC |
| d3-shape | 3.2.0 | ISC |
| d3-time | 3.1.0 | ISC |
| d3-time-format | 4.1.0 | ISC |
| d3-timer | 3.0.1 | ISC |
| d3-transition | 3.0.1 | ISC |
| d3-zoom | 3.0.0 | ISC |
| delaunator | 5.1.0 | ISC |
| fs.realpath | 1.0.0 | ISC |
| fstream | 1.0.12 | ISC |
| get-caller-file | 2.0.5 | ISC |
| glob | 7.2.3 | ISC |
| graceful-fs | 4.2.11 | ISC |
| inflight | 1.0.6 | ISC |
| inherits | 2.0.4 | ISC |
| internmap | 1.0.1 | ISC |
| internmap | 2.0.3 | ISC |
| isexe | 2.0.0 | ISC |
| listenercount | 1.0.1 | ISC |
| minimatch | 3.1.5 | ISC |
| minimatch | 5.1.9 | ISC |
| once | 1.4.0 | ISC |
| picocolors | 1.1.1 | ISC |
| require-main-filename | 2.0.0 | ISC |
| rimraf | 2.7.1 | ISC |
| saxes | 5.0.1 | ISC |
| semver | 7.7.4 | ISC |
| set-blocking | 2.0.0 | ISC |
| setprototypeof | 1.2.0 | ISC |
| which | 2.0.2 | ISC |
| which-module | 2.0.1 | ISC |
| wrappy | 1.0.2 | ISC |
| y18n | 4.0.3 | ISC |
| yargs-parser | 18.1.3 | ISC |

### Apache-2.0 (16)

| 包 / Package | 版本 | 许可证 / License |
| --- | --- | --- |
| @chevrotain/cst-dts-gen | 12.0.0 | Apache-2.0 |
| @chevrotain/gast | 12.0.0 | Apache-2.0 |
| @chevrotain/regexp-to-ast | 12.0.0 | Apache-2.0 |
| @chevrotain/types | 12.0.0 | Apache-2.0 |
| @chevrotain/utils | 12.0.0 | Apache-2.0 |
| @img/sharp-darwin-arm64 | 0.34.5 | Apache-2.0 |
| chevrotain | 12.0.0 | Apache-2.0 |
| crc-32 | 1.2.2 | Apache-2.0 |
| detect-libc | 2.1.2 | Apache-2.0 |
| emoji-picker-element | 1.29.1 | Apache-2.0 |
| pdf-parse | 2.4.5 | Apache-2.0 |
| pdfjs-dist | 5.4.296 | Apache-2.0 |
| pdfjs-dist | 5.6.205 | Apache-2.0 |
| readdir-glob | 1.1.3 | Apache-2.0 |
| sharp | 0.34.5 | Apache-2.0 |
| typescript | 6.0.2 | Apache-2.0 |

### BSD-3-Clause (12)

| 包 / Package | 版本 | 许可证 / License |
| --- | --- | --- |
| d3-array | 2.12.1 | BSD-3-Clause |
| d3-ease | 3.0.1 | BSD-3-Clause |
| d3-path | 1.0.9 | BSD-3-Clause |
| d3-sankey | 0.12.3 | BSD-3-Clause |
| d3-shape | 1.3.7 | BSD-3-Clause |
| duplexer2 | 0.1.4 | BSD-3-Clause |
| highlight.js | 11.11.1 | BSD-3-Clause |
| ieee754 | 1.2.1 | BSD-3-Clause |
| qs | 6.14.2 | BSD-3-Clause |
| rw | 1.3.3 | BSD-3-Clause |
| source-map-js | 1.2.1 | BSD-3-Clause |
| sprintf-js | 1.0.3 | BSD-3-Clause |

### BSD-2-Clause (6)

| 包 / Package | 版本 | 许可证 / License |
| --- | --- | --- |
| dingbat-to-unicode | 1.0.1 | BSD-2-Clause |
| entities | 7.0.1 | BSD-2-Clause |
| extract-zip | 2.0.1 | BSD-2-Clause |
| lop | 0.4.2 | BSD-2-Clause |
| mammoth | 1.12.0 | BSD-2-Clause |
| option | 0.2.4 | BSD-2-Clause |

### Unlicense (2)

| 包 / Package | 版本 | 许可证 / License |
| --- | --- | --- |
| big-integer | 1.6.52 | Unlicense |
| robust-predicates | 3.0.3 | Unlicense |

### NOT DECLARED — 以包内 LICENSE 文件为准 / see package LICENSE (2)

| 包 / Package | 版本 | 许可证 / License |
| --- | --- | --- |
| buffers | 0.1.1 | Unknown |
| khroma | 2.1.0 | Unknown |

### MIT/X11 (2)

| 包 / Package | 版本 | 许可证 / License |
| --- | --- | --- |
| chainsaw | 0.1.0 | MIT/X11 |
| traverse | 0.3.9 | MIT/X11 |

### MIT OR Apache (2)

| 包 / Package | 版本 | 许可证 / License |
| --- | --- | --- |
| sqlite-vec | 0.1.9 | MIT OR Apache |
| sqlite-vec-darwin-arm64 | 0.1.9 | MIT OR Apache |

### LGPL-3.0-or-later (1)

| 包 / Package | 版本 | 许可证 / License |
| --- | --- | --- |
| @img/sharp-libvips-darwin-arm64 | 1.2.4 | LGPL-3.0-or-later |

### (MPL-2.0 OR Apache-2.0) (1)

| 包 / Package | 版本 | 许可证 / License |
| --- | --- | --- |
| dompurify | 3.3.3 | (MPL-2.0 OR Apache-2.0) |

### BSD (1)

| 包 / Package | 版本 | 许可证 / License |
| --- | --- | --- |
| duck | 0.1.12 | BSD |

### (MIT OR GPL-3.0-or-later) (1)

| 包 / Package | 版本 | 许可证 / License |
| --- | --- | --- |
| jszip | 3.10.1 | (MIT OR GPL-3.0-or-later) |

### (MIT AND Zlib) (1)

| 包 / Package | 版本 | 许可证 / License |
| --- | --- | --- |
| pako | 1.0.11 | (MIT AND Zlib) |

### 0BSD (1)

| 包 / Package | 版本 | 许可证 / License |
| --- | --- | --- |
| tslib | 1.14.1 | 0BSD |

## Rust crates（harness-rs/Cargo.lock）

### MIT OR Apache-2.0 (175)

| 包 / Package | 版本 | 许可证 / License |
| --- | --- | --- |
| aes | 0.8.4 | MIT OR Apache-2.0 |
| ahash | 0.8.12 | MIT OR Apache-2.0 |
| android_system_properties | 0.1.6 | MIT OR Apache-2.0 |
| anstream | 1.0.0 | MIT OR Apache-2.0 |
| anstyle | 1.0.14 | MIT OR Apache-2.0 |
| anstyle-parse | 1.0.0 | MIT OR Apache-2.0 |
| anstyle-query | 1.1.5 | MIT OR Apache-2.0 |
| anstyle-wincon | 3.0.11 | MIT OR Apache-2.0 |
| anyhow | 1.0.104 | MIT OR Apache-2.0 |
| arbitrary | 1.4.2 | MIT OR Apache-2.0 |
| async-trait | 0.1.92 | MIT OR Apache-2.0 |
| base64 | 0.22.1 | MIT OR Apache-2.0 |
| bitflags | 2.13.1 | MIT OR Apache-2.0 |
| block-buffer | 0.10.4 | MIT OR Apache-2.0 |
| block-padding | 0.3.3 | MIT OR Apache-2.0 |
| bstr | 1.13.1 | MIT OR Apache-2.0 |
| bumpalo | 3.20.3 | MIT OR Apache-2.0 |
| cbc | 0.1.2 | MIT OR Apache-2.0 |
| cc | 1.4.4 | MIT OR Apache-2.0 |
| cfg-if | 1.0.4 | MIT OR Apache-2.0 |
| chacha20 | 0.10.2 | MIT OR Apache-2.0 |
| chrono | 0.4.45 | MIT OR Apache-2.0 |
| cipher | 0.4.4 | MIT OR Apache-2.0 |
| clap | 4.6.6 | MIT OR Apache-2.0 |
| clap_builder | 4.6.6 | MIT OR Apache-2.0 |
| clap_derive | 4.6.4 | MIT OR Apache-2.0 |
| clap_lex | 1.1.0 | MIT OR Apache-2.0 |
| colorchoice | 1.0.5 | MIT OR Apache-2.0 |
| core-foundation-sys | 0.8.7 | MIT OR Apache-2.0 |
| cpufeatures | 0.2.17 | MIT OR Apache-2.0 |
| cpufeatures | 0.3.1 | MIT OR Apache-2.0 |
| crc32fast | 1.5.1 | MIT OR Apache-2.0 |
| cron | 0.12.1 | MIT OR Apache-2.0 |
| crossbeam-deque | 0.8.7 | MIT OR Apache-2.0 |
| crossbeam-epoch | 0.9.20 | MIT OR Apache-2.0 |
| crossbeam-utils | 0.8.22 | MIT OR Apache-2.0 |
| crypto-common | 0.1.7 | MIT OR Apache-2.0 |
| deranged | 0.5.8 | MIT OR Apache-2.0 |
| derive_arbitrary | 1.4.2 | MIT OR Apache-2.0 |
| digest | 0.10.7 | MIT OR Apache-2.0 |
| displaydoc | 0.2.7 | MIT OR Apache-2.0 |
| either | 1.18.0 | MIT OR Apache-2.0 |
| errno | 0.3.14 | MIT OR Apache-2.0 |
| fdeflate | 0.3.7 | MIT OR Apache-2.0 |
| find-msvc-tools | 0.1.11 | MIT OR Apache-2.0 |
| flate2 | 1.1.10 | MIT OR Apache-2.0 |
| form_urlencoded | 1.2.2 | MIT OR Apache-2.0 |
| futures | 0.3.34 | MIT OR Apache-2.0 |
| futures-channel | 0.3.34 | MIT OR Apache-2.0 |
| futures-core | 0.3.34 | MIT OR Apache-2.0 |
| futures-executor | 0.3.34 | MIT OR Apache-2.0 |
| futures-io | 0.3.34 | MIT OR Apache-2.0 |
| futures-macro | 0.3.34 | MIT OR Apache-2.0 |
| futures-sink | 0.3.34 | MIT OR Apache-2.0 |
| futures-task | 0.3.34 | MIT OR Apache-2.0 |
| futures-util | 0.3.34 | MIT OR Apache-2.0 |
| getrandom | 0.2.17 | MIT OR Apache-2.0 |
| getrandom | 0.3.4 | MIT OR Apache-2.0 |
| getrandom | 0.4.3 | MIT OR Apache-2.0 |
| gif | 0.13.3 | MIT OR Apache-2.0 |
| hashbrown | 0.14.5 | MIT OR Apache-2.0 |
| hashbrown | 0.17.1 | MIT OR Apache-2.0 |
| hashlink | 0.9.1 | MIT OR Apache-2.0 |
| heck | 0.5.0 | MIT OR Apache-2.0 |
| hmac | 0.12.1 | MIT OR Apache-2.0 |
| http | 1.5.0 | MIT OR Apache-2.0 |
| httparse | 1.10.1 | MIT OR Apache-2.0 |
| httpdate | 1.0.3 | MIT OR Apache-2.0 |
| iana-time-zone | 0.1.65 | MIT OR Apache-2.0 |
| iana-time-zone-haiku | 0.1.2 | MIT OR Apache-2.0 |
| idna | 1.1.0 | MIT OR Apache-2.0 |
| image | 0.24.9 | MIT OR Apache-2.0 |
| inout | 0.1.4 | MIT OR Apache-2.0 |
| ipnet | 2.12.1 | MIT OR Apache-2.0 |
| is_terminal_polyfill | 1.70.2 | MIT OR Apache-2.0 |
| itoa | 1.0.18 | MIT OR Apache-2.0 |
| jpeg-decoder | 0.3.2 | MIT OR Apache-2.0 |
| js-sys | 0.3.104 | MIT OR Apache-2.0 |
| lazy_static | 1.5.0 | MIT OR Apache-2.0 |
| libc | 0.2.189 | MIT OR Apache-2.0 |
| lock_api | 0.4.14 | MIT OR Apache-2.0 |
| log | 0.4.34 | MIT OR Apache-2.0 |
| md-5 | 0.10.6 | MIT OR Apache-2.0 |
| mime | 0.3.17 | MIT OR Apache-2.0 |
| num-conv | 0.2.2 | MIT OR Apache-2.0 |
| num-traits | 0.2.19 | MIT OR Apache-2.0 |
| once_cell | 1.21.4 | MIT OR Apache-2.0 |
| once_cell_polyfill | 1.70.2 | MIT OR Apache-2.0 |
| parking_lot | 0.12.5 | MIT OR Apache-2.0 |
| parking_lot_core | 0.9.12 | MIT OR Apache-2.0 |
| percent-encoding | 2.3.2 | MIT OR Apache-2.0 |
| pkg-config | 0.3.34 | MIT OR Apache-2.0 |
| png | 0.17.16 | MIT OR Apache-2.0 |
| powerfmt | 0.2.0 | MIT OR Apache-2.0 |
| ppv-lite86 | 0.2.21 | MIT OR Apache-2.0 |
| proc-macro2 | 1.0.107 | MIT OR Apache-2.0 |
| quinn | 0.11.11 | MIT OR Apache-2.0 |
| quinn-proto | 0.11.17 | MIT OR Apache-2.0 |
| quinn-udp | 0.5.15 | MIT OR Apache-2.0 |
| quote | 1.0.47 | MIT OR Apache-2.0 |
| rand | 0.8.8 | MIT OR Apache-2.0 |
| rand | 0.9.5 | MIT OR Apache-2.0 |
| rand | 0.10.2 | MIT OR Apache-2.0 |
| rand_chacha | 0.3.1 | MIT OR Apache-2.0 |
| rand_chacha | 0.9.0 | MIT OR Apache-2.0 |
| rand_core | 0.6.4 | MIT OR Apache-2.0 |
| rand_core | 0.9.5 | MIT OR Apache-2.0 |
| rand_core | 0.10.1 | MIT OR Apache-2.0 |
| rand_pcg | 0.10.2 | MIT OR Apache-2.0 |
| rayon | 1.12.0 | MIT OR Apache-2.0 |
| rayon-core | 1.13.0 | MIT OR Apache-2.0 |
| regex | 1.13.1 | MIT OR Apache-2.0 |
| regex-automata | 0.4.18 | MIT OR Apache-2.0 |
| regex-syntax | 0.8.11 | MIT OR Apache-2.0 |
| reqwest | 0.12.28 | MIT OR Apache-2.0 |
| roxmltree | 0.20.0 | MIT OR Apache-2.0 |
| rustls-pki-types | 1.15.1 | MIT OR Apache-2.0 |
| rustversion | 1.0.23 | MIT OR Apache-2.0 |
| scopeguard | 1.2.0 | MIT OR Apache-2.0 |
| serde | 1.0.229 | MIT OR Apache-2.0 |
| serde_core | 1.0.229 | MIT OR Apache-2.0 |
| serde_derive | 1.0.229 | MIT OR Apache-2.0 |
| serde_json | 1.0.151 | MIT OR Apache-2.0 |
| serde_path_to_error | 0.1.20 | MIT OR Apache-2.0 |
| serde_yaml | 0.9.34+deprecated | MIT OR Apache-2.0 |
| sha1 | 0.10.7 | MIT OR Apache-2.0 |
| sha2 | 0.10.9 | MIT OR Apache-2.0 |
| shlex | 2.0.1 | MIT OR Apache-2.0 |
| signal-hook-registry | 1.4.8 | MIT OR Apache-2.0 |
| smallvec | 1.15.2 | MIT OR Apache-2.0 |
| socket2 | 0.6.5 | MIT OR Apache-2.0 |
| stable_deref_trait | 1.2.1 | MIT OR Apache-2.0 |
| syn | 2.0.119 | MIT OR Apache-2.0 |
| syn | 3.0.4 | MIT OR Apache-2.0 |
| tempfile | 3.27.0 | MIT OR Apache-2.0 |
| thiserror | 1.0.69 | MIT OR Apache-2.0 |
| thiserror | 2.0.20 | MIT OR Apache-2.0 |
| thiserror-impl | 1.0.69 | MIT OR Apache-2.0 |
| thiserror-impl | 2.0.20 | MIT OR Apache-2.0 |
| thread_local | 1.1.10 | MIT OR Apache-2.0 |
| time | 0.3.55 | MIT OR Apache-2.0 |
| time-core | 0.1.9 | MIT OR Apache-2.0 |
| time-macros | 0.2.32 | MIT OR Apache-2.0 |
| tokio-rustls | 0.26.4 | MIT OR Apache-2.0 |
| tungstenite | 0.29.0 | MIT OR Apache-2.0 |
| typenum | 1.20.1 | MIT OR Apache-2.0 |
| unicase | 2.9.0 | MIT OR Apache-2.0 |
| unicode-normalization | 0.1.25 | MIT OR Apache-2.0 |
| url | 2.5.8 | MIT OR Apache-2.0 |
| wasm-bindgen | 0.2.127 | MIT OR Apache-2.0 |
| wasm-bindgen-futures | 0.4.77 | MIT OR Apache-2.0 |
| wasm-bindgen-macro | 0.2.127 | MIT OR Apache-2.0 |
| wasm-bindgen-macro-support | 0.2.127 | MIT OR Apache-2.0 |
| wasm-bindgen-shared | 0.2.127 | MIT OR Apache-2.0 |
| wasm-streams | 0.4.2 | MIT OR Apache-2.0 |
| web-sys | 0.3.104 | MIT OR Apache-2.0 |
| web-time | 1.1.0 | MIT OR Apache-2.0 |
| weezl | 0.1.12 | MIT OR Apache-2.0 |
| windows_aarch64_gnullvm | 0.52.6 | MIT OR Apache-2.0 |
| windows_aarch64_msvc | 0.52.6 | MIT OR Apache-2.0 |
| windows_i686_gnu | 0.52.6 | MIT OR Apache-2.0 |
| windows_i686_gnullvm | 0.52.6 | MIT OR Apache-2.0 |
| windows_i686_msvc | 0.52.6 | MIT OR Apache-2.0 |
| windows_x86_64_gnu | 0.52.6 | MIT OR Apache-2.0 |
| windows_x86_64_gnullvm | 0.52.6 | MIT OR Apache-2.0 |
| windows_x86_64_msvc | 0.52.6 | MIT OR Apache-2.0 |
| windows-core | 0.62.2 | MIT OR Apache-2.0 |
| windows-implement | 0.60.2 | MIT OR Apache-2.0 |
| windows-interface | 0.59.3 | MIT OR Apache-2.0 |
| windows-link | 0.2.1 | MIT OR Apache-2.0 |
| windows-result | 0.4.1 | MIT OR Apache-2.0 |
| windows-strings | 0.5.1 | MIT OR Apache-2.0 |
| windows-sys | 0.52.0 | MIT OR Apache-2.0 |
| windows-sys | 0.61.2 | MIT OR Apache-2.0 |
| windows-targets | 0.52.6 | MIT OR Apache-2.0 |

### MIT (47)

| 包 / Package | 版本 | 许可证 / License |
| --- | --- | --- |
| axum | 0.8.9 | MIT |
| axum-core | 0.5.6 | MIT |
| bytes | 1.12.1 | MIT |
| calamine | 0.26.1 | MIT |
| cfg_aliases | 0.2.2 | MIT |
| color_quant | 1.1.0 | MIT |
| data-encoding | 2.11.1 | MIT |
| generic-array | 0.14.7 | MIT |
| http-body | 1.1.0 | MIT |
| http-body-util | 0.1.5 | MIT |
| hyper | 1.11.1 | MIT |
| hyper-util | 0.1.20 | MIT |
| libsqlite3-sys | 0.30.1 | MIT |
| lopdf | 0.34.0 | MIT |
| matchers | 0.2.0 | MIT |
| mime_guess | 2.0.5 | MIT |
| mio | 1.2.2 | MIT |
| nom | 7.1.3 | MIT |
| nu-ansi-term | 0.50.3 | MIT |
| quick-xml | 0.31.0 | MIT |
| redox_syscall | 0.5.18 | MIT |
| rusqlite | 0.32.1 | MIT |
| sharded-slab | 0.1.7 | MIT |
| simd-adler32 | 0.3.10 | MIT |
| slab | 0.4.12 | MIT |
| strsim | 0.11.1 | MIT |
| synstructure | 0.13.2 | MIT |
| tokio | 1.53.1 | MIT |
| tokio-macros | 2.7.2 | MIT |
| tokio-stream | 0.1.19 | MIT |
| tokio-tungstenite | 0.29.0 | MIT |
| tokio-util | 0.7.19 | MIT |
| tower | 0.5.3 | MIT |
| tower-http | 0.6.11 | MIT |
| tower-layer | 0.3.3 | MIT |
| tower-service | 0.3.3 | MIT |
| tracing | 0.1.44 | MIT |
| tracing-attributes | 0.1.31 | MIT |
| tracing-core | 0.1.36 | MIT |
| tracing-log | 0.2.0 | MIT |
| tracing-subscriber | 0.3.23 | MIT |
| try-lock | 0.2.5 | MIT |
| unsafe-libyaml | 0.2.11 | MIT |
| valuable | 0.1.1 | MIT |
| want | 0.3.1 | MIT |
| zip | 2.4.2 | MIT |
| zmij | 1.0.23 | MIT |

### Unicode-3.0 (18)

| 包 / Package | 版本 | 许可证 / License |
| --- | --- | --- |
| icu_collections | 2.3.0 | Unicode-3.0 |
| icu_locale_core | 2.3.0 | Unicode-3.0 |
| icu_normalizer | 2.3.0 | Unicode-3.0 |
| icu_normalizer_data | 2.3.0 | Unicode-3.0 |
| icu_properties | 2.3.0 | Unicode-3.0 |
| icu_properties_data | 2.3.0 | Unicode-3.0 |
| icu_provider | 2.3.1 | Unicode-3.0 |
| litemap | 0.8.3 | Unicode-3.0 |
| potential_utf | 0.1.6 | Unicode-3.0 |
| tinystr | 0.8.4 | Unicode-3.0 |
| writeable | 0.6.4 | Unicode-3.0 |
| yoke | 0.8.3 | Unicode-3.0 |
| yoke-derive | 0.8.2 | Unicode-3.0 |
| zerofrom | 0.1.8 | Unicode-3.0 |
| zerofrom-derive | 0.1.7 | Unicode-3.0 |
| zerotrie | 0.2.5 | Unicode-3.0 |
| zerovec | 0.11.8 | Unicode-3.0 |
| zerovec-derive | 0.11.6 | Unicode-3.0 |

### Apache-2.0 OR MIT (13)

| 包 / Package | 版本 | 许可证 / License |
| --- | --- | --- |
| atomic-waker | 1.1.2 | Apache-2.0 OR MIT |
| autocfg | 1.5.1 | Apache-2.0 OR MIT |
| codepage | 0.1.2 | Apache-2.0 OR MIT |
| equivalent | 1.0.2 | Apache-2.0 OR MIT |
| fastrand | 2.5.0 | Apache-2.0 OR MIT |
| idna_adapter | 1.2.2 | Apache-2.0 OR MIT |
| indexmap | 2.14.1 | Apache-2.0 OR MIT |
| pin-project-lite | 0.2.17 | Apache-2.0 OR MIT |
| rustc-hash | 2.1.3 | Apache-2.0 OR MIT |
| utf8_iter | 1.0.4 | Apache-2.0 OR MIT |
| utf8parse | 0.2.2 | Apache-2.0 OR MIT |
| uuid | 1.26.0 | Apache-2.0 OR MIT |
| zeroize | 1.9.0 | Apache-2.0 OR MIT |

### MIT/Apache-2.0 (9)

| 包 / Package | 版本 | 许可证 / License |
| --- | --- | --- |
| bitflags | 1.3.2 | MIT/Apache-2.0 |
| fallible-iterator | 0.3.0 | MIT/Apache-2.0 |
| fallible-streaming-iterator | 0.1.9 | MIT/Apache-2.0 |
| minimal-lexical | 0.2.1 | MIT/Apache-2.0 |
| rangemap | 1.8.0 | MIT/Apache-2.0 |
| serde_urlencoded | 0.7.1 | MIT/Apache-2.0 |
| sqlite-vec | 0.1.9 | MIT/Apache-2.0 |
| vcpkg | 0.2.15 | MIT/Apache-2.0 |
| version_check | 0.9.5 | MIT/Apache-2.0 |

### Unlicense OR MIT (6)

| 包 / Package | 版本 | 许可证 / License |
| --- | --- | --- |
| aho-corasick | 1.1.5 | Unlicense OR MIT |
| byteorder | 1.5.0 | Unlicense OR MIT |
| globset | 0.4.20 | Unlicense OR MIT |
| ignore | 0.4.33 | Unlicense OR MIT |
| memchr | 2.8.3 | Unlicense OR MIT |
| winapi-util | 0.1.11 | Unlicense OR MIT |

### Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT (5)

| 包 / Package | 版本 | 许可证 / License |
| --- | --- | --- |
| linux-raw-sys | 0.12.1 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT |
| rustix | 1.1.4 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT |
| wasi | 0.11.1+wasi-snapshot-preview1 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT |
| wasip2 | 1.0.4+wasi-0.2.12 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT |
| wit-bindgen | 0.57.1 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT |

### Zlib OR Apache-2.0 OR MIT (2)

| 包 / Package | 版本 | 许可证 / License |
| --- | --- | --- |
| bytemuck | 1.25.2 | Zlib OR Apache-2.0 OR MIT |
| tinyvec | 1.12.0 | Zlib OR Apache-2.0 OR MIT |

### Apache-2.0 OR ISC OR MIT (2)

| 包 / Package | 版本 | 许可证 / License |
| --- | --- | --- |
| hyper-rustls | 0.27.9 | Apache-2.0 OR ISC OR MIT |
| rustls | 0.23.43 | Apache-2.0 OR ISC OR MIT |

### MIT OR Apache-2.0 OR Zlib (2)

| 包 / Package | 版本 | 许可证 / License |
| --- | --- | --- |
| lru-slab | 0.1.2 | MIT OR Apache-2.0 OR Zlib |
| tinyvec_macros | 0.1.1 | MIT OR Apache-2.0 OR Zlib |

### MIT OR Zlib OR Apache-2.0 (2)

| 包 / Package | 版本 | 许可证 / License |
| --- | --- | --- |
| miniz_oxide | 0.8.9 | MIT OR Zlib OR Apache-2.0 |
| miniz_oxide | 0.9.1 | MIT OR Zlib OR Apache-2.0 |

### MIT OR Apache-2.0 OR LGPL-2.1-or-later (2)

| 包 / Package | 版本 | 许可证 / License |
| --- | --- | --- |
| r-efi | 5.3.0 | MIT OR Apache-2.0 OR LGPL-2.1-or-later |
| r-efi | 6.0.0 | MIT OR Apache-2.0 OR LGPL-2.1-or-later |

### ISC (2)

| 包 / Package | 版本 | 许可证 / License |
| --- | --- | --- |
| rustls-webpki | 0.103.15 | ISC |
| untrusted | 0.9.0 | ISC |

### Unlicense/MIT (2)

| 包 / Package | 版本 | 许可证 / License |
| --- | --- | --- |
| same-file | 1.0.6 | Unlicense/MIT |
| walkdir | 2.5.0 | Unlicense/MIT |

### Apache-2.0 (2)

| 包 / Package | 版本 | 许可证 / License |
| --- | --- | --- |
| sync_wrapper | 1.0.2 | Apache-2.0 |
| zopfli | 0.8.3 | Apache-2.0 |

### BSD-2-Clause OR Apache-2.0 OR MIT (2)

| 包 / Package | 版本 | 许可证 / License |
| --- | --- | --- |
| zerocopy | 0.8.56 | BSD-2-Clause OR Apache-2.0 OR MIT |
| zerocopy-derive | 0.8.56 | BSD-2-Clause OR Apache-2.0 OR MIT |

### 0BSD OR MIT OR Apache-2.0 (1)

| 包 / Package | 版本 | 许可证 / License |
| --- | --- | --- |
| adler2 | 2.0.1 | 0BSD OR MIT OR Apache-2.0 |

### (Apache-2.0 OR MIT) AND BSD-3-Clause (1)

| 包 / Package | 版本 | 许可证 / License |
| --- | --- | --- |
| encoding_rs | 0.8.35 | (Apache-2.0 OR MIT) AND BSD-3-Clause |

### MIT AND BSD-3-Clause (1)

| 包 / Package | 版本 | 许可证 / License |
| --- | --- | --- |
| matchit | 0.8.4 | MIT AND BSD-3-Clause |

### Apache-2.0 AND ISC (1)

| 包 / Package | 版本 | 许可证 / License |
| --- | --- | --- |
| ring | 0.17.14 | Apache-2.0 AND ISC |

### Apache-2.0 OR BSL-1.0 (1)

| 包 / Package | 版本 | 许可证 / License |
| --- | --- | --- |
| ryu | 1.0.23 | Apache-2.0 OR BSL-1.0 |

### BSD-3-Clause (1)

| 包 / Package | 版本 | 许可证 / License |
| --- | --- | --- |
| subtle | 2.6.1 | BSD-3-Clause |

### (MIT OR Apache-2.0) AND Unicode-3.0 (1)

| 包 / Package | 版本 | 许可证 / License |
| --- | --- | --- |
| unicode-ident | 1.0.24 | (MIT OR Apache-2.0) AND Unicode-3.0 |

### CDLA-Permissive-2.0 (1)

| 包 / Package | 版本 | 许可证 / License |
| --- | --- | --- |
| webpki-roots | 1.0.9 | CDLA-Permissive-2.0 |

### Zlib (1)

| 包 / Package | 版本 | 许可证 / License |
| --- | --- | --- |
| zlib-rs | 0.6.7 | Zlib |

## Flutter / Dart（apps/mobile/pubspec.lock）

### pub.dev 包（122）

| 包 / Package | 版本 | 许可证 / License | 依赖类型 / Type |
| --- | --- | --- | --- |
| _fe_analyzer_shared | 93.0.0 | 见 pub.dev / see LICENSE | transitive |
| analyzer | 10.0.1 | 见 pub.dev / see LICENSE | transitive |
| args | 2.7.0 | 见 pub.dev / see LICENSE | transitive |
| async | 2.13.1 | 见 pub.dev / see LICENSE | transitive |
| boolean_selector | 2.1.2 | 见 pub.dev / see LICENSE | transitive |
| characters | 1.4.1 | 见 pub.dev / see LICENSE | transitive |
| cli_config | 0.2.0 | 见 pub.dev / see LICENSE | transitive |
| clock | 1.1.2 | 见 pub.dev / see LICENSE | transitive |
| code_assets | 1.2.1 | 见 pub.dev / see LICENSE | transitive |
| collection | 1.19.1 | 见 pub.dev / see LICENSE | transitive |
| convert | 3.1.2 | 见 pub.dev / see LICENSE | transitive |
| coverage | 1.15.1 | 见 pub.dev / see LICENSE | transitive |
| cross_file | 0.3.5+5 | 见 pub.dev / see LICENSE | transitive |
| crypto | 3.0.7 | 见 pub.dev / see LICENSE | transitive |
| cupertino_icons | 1.0.9 | 见 pub.dev / see LICENSE | direct main |
| dbus | 0.7.15 | 见 pub.dev / see LICENSE | transitive |
| fake_async | 1.3.3 | 见 pub.dev / see LICENSE | transitive |
| ffi | 2.2.0 | 见 pub.dev / see LICENSE | direct main |
| file | 7.0.1 | 见 pub.dev / see LICENSE | transitive |
| file_picker | 10.3.10 | 见 pub.dev / see LICENSE | direct main |
| fixnum | 1.1.1 | 见 pub.dev / see LICENSE | transitive |
| flutter_highlight | 0.7.0 | 见 pub.dev / see LICENSE | direct main |
| flutter_markdown_plus | 1.0.12 | 见 pub.dev / see LICENSE | direct main |
| flutter_math_fork | 0.7.4 | 见 pub.dev / see LICENSE | direct main |
| flutter_plugin_android_lifecycle | 2.0.35 | 见 pub.dev / see LICENSE | transitive |
| flutter_riverpod | 3.3.2 | 见 pub.dev / see LICENSE | direct main |
| flutter_svg | 2.3.0 | 见 pub.dev / see LICENSE | transitive |
| frontend_server_client | 4.0.0 | 见 pub.dev / see LICENSE | transitive |
| glob | 2.2.0 | 见 pub.dev / see LICENSE | transitive |
| highlight | 0.7.0 | 见 pub.dev / see LICENSE | direct main |
| hooks | 2.0.2 | 见 pub.dev / see LICENSE | transitive |
| http | 1.6.0 | 见 pub.dev / see LICENSE | transitive |
| http_multi_server | 3.2.2 | 见 pub.dev / see LICENSE | transitive |
| http_parser | 4.1.2 | 见 pub.dev / see LICENSE | transitive |
| io | 1.1.0 | 见 pub.dev / see LICENSE | transitive |
| jni | 1.0.3 | 见 pub.dev / see LICENSE | transitive |
| jni_flutter | 1.0.2 | 见 pub.dev / see LICENSE | transitive |
| jni_util | 1.0.0 | 见 pub.dev / see LICENSE | transitive |
| leak_tracker | 11.0.2 | 见 pub.dev / see LICENSE | transitive |
| leak_tracker_flutter_testing | 3.0.10 | 见 pub.dev / see LICENSE | transitive |
| leak_tracker_testing | 3.0.2 | 见 pub.dev / see LICENSE | transitive |
| lints | 6.1.0 | 见 pub.dev / see LICENSE | transitive |
| logging | 1.3.0 | 见 pub.dev / see LICENSE | transitive |
| markdown | 7.3.1 | 见 pub.dev / see LICENSE | direct main |
| matcher | 0.12.18 | 见 pub.dev / see LICENSE | transitive |
| material_color_utilities | 0.13.0 | 见 pub.dev / see LICENSE | transitive |
| meta | 1.17.0 | 见 pub.dev / see LICENSE | transitive |
| mime | 2.1.0 | 见 pub.dev / see LICENSE | transitive |
| nested | 1.0.0 | 见 pub.dev / see LICENSE | transitive |
| node_preamble | 2.0.2 | 见 pub.dev / see LICENSE | transitive |
| objective_c | 9.5.0 | 见 pub.dev / see LICENSE | transitive |
| package_config | 2.2.0 | 见 pub.dev / see LICENSE | transitive |
| path | 1.9.1 | 见 pub.dev / see LICENSE | transitive |
| path_parsing | 1.1.0 | 见 pub.dev / see LICENSE | transitive |
| path_provider | 2.1.6 | 见 pub.dev / see LICENSE | direct main |
| path_provider_android | 2.3.1 | 见 pub.dev / see LICENSE | transitive |
| path_provider_foundation | 2.6.0 | 见 pub.dev / see LICENSE | transitive |
| path_provider_linux | 2.2.2 | 见 pub.dev / see LICENSE | transitive |
| path_provider_platform_interface | 2.1.3 | 见 pub.dev / see LICENSE | transitive |
| path_provider_windows | 2.3.0 | 见 pub.dev / see LICENSE | transitive |
| petitparser | 7.0.2 | 见 pub.dev / see LICENSE | transitive |
| platform | 3.1.6 | 见 pub.dev / see LICENSE | transitive |
| plugin_platform_interface | 2.1.8 | 见 pub.dev / see LICENSE | transitive |
| pool | 1.5.3 | 见 pub.dev / see LICENSE | transitive |
| process | 5.0.6 | 见 pub.dev / see LICENSE | transitive |
| provider | 6.1.5+1 | 见 pub.dev / see LICENSE | transitive |
| pub_semver | 2.2.1 | 见 pub.dev / see LICENSE | transitive |
| record_use | 0.6.0 | 见 pub.dev / see LICENSE | transitive |
| riverpod | 3.3.2 | 见 pub.dev / see LICENSE | transitive |
| shared_preferences | 2.5.5 | 见 pub.dev / see LICENSE | direct main |
| shared_preferences_android | 2.4.23 | 见 pub.dev / see LICENSE | transitive |
| shared_preferences_foundation | 2.5.7 | 见 pub.dev / see LICENSE | transitive |
| shared_preferences_linux | 2.4.1 | 见 pub.dev / see LICENSE | transitive |
| shared_preferences_platform_interface | 2.4.2 | 见 pub.dev / see LICENSE | transitive |
| shared_preferences_web | 2.4.3 | 见 pub.dev / see LICENSE | transitive |
| shared_preferences_windows | 2.4.1 | 见 pub.dev / see LICENSE | transitive |
| shelf | 1.4.2 | 见 pub.dev / see LICENSE | transitive |
| shelf_packages_handler | 3.0.2 | 见 pub.dev / see LICENSE | transitive |
| shelf_static | 1.1.3 | 见 pub.dev / see LICENSE | transitive |
| shelf_web_socket | 3.0.0 | 见 pub.dev / see LICENSE | transitive |
| source_map_stack_trace | 2.1.2 | 见 pub.dev / see LICENSE | transitive |
| source_maps | 0.10.14 | 见 pub.dev / see LICENSE | transitive |
| source_span | 1.10.2 | 见 pub.dev / see LICENSE | transitive |
| stack_trace | 1.12.1 | 见 pub.dev / see LICENSE | transitive |
| state_notifier | 1.0.0 | 见 pub.dev / see LICENSE | transitive |
| stream_channel | 2.1.4 | 见 pub.dev / see LICENSE | transitive |
| string_scanner | 1.4.1 | 见 pub.dev / see LICENSE | transitive |
| sync_http | 0.3.1 | 见 pub.dev / see LICENSE | transitive |
| term_glyph | 1.2.2 | 见 pub.dev / see LICENSE | transitive |
| test | 1.29.0 | 见 pub.dev / see LICENSE | transitive |
| test_api | 0.7.9 | 见 pub.dev / see LICENSE | transitive |
| test_core | 0.6.15 | 见 pub.dev / see LICENSE | transitive |
| tuple | 2.0.2 | 见 pub.dev / see LICENSE | transitive |
| typed_data | 1.4.0 | 见 pub.dev / see LICENSE | transitive |
| url_launcher | 6.3.2 | 见 pub.dev / see LICENSE | direct main |
| url_launcher_android | 6.3.30 | 见 pub.dev / see LICENSE | transitive |
| url_launcher_ios | 6.4.2 | 见 pub.dev / see LICENSE | transitive |
| url_launcher_linux | 3.2.3 | 见 pub.dev / see LICENSE | transitive |
| url_launcher_macos | 3.2.6 | 见 pub.dev / see LICENSE | transitive |
| url_launcher_platform_interface | 2.3.2 | 见 pub.dev / see LICENSE | transitive |
| url_launcher_web | 2.4.3 | 见 pub.dev / see LICENSE | transitive |
| url_launcher_windows | 3.1.6 | 见 pub.dev / see LICENSE | transitive |
| uuid | 4.6.0 | 见 pub.dev / see LICENSE | transitive |
| vector_graphics | 1.2.3 | 见 pub.dev / see LICENSE | transitive |
| vector_graphics_codec | 1.1.13 | 见 pub.dev / see LICENSE | transitive |
| vector_graphics_compiler | 1.3.0 | 见 pub.dev / see LICENSE | transitive |
| vector_math | 2.2.0 | 见 pub.dev / see LICENSE | transitive |
| vm_service | 15.3.0 | 见 pub.dev / see LICENSE | transitive |
| watcher | 1.2.1 | 见 pub.dev / see LICENSE | transitive |
| web | 1.1.1 | 见 pub.dev / see LICENSE | transitive |
| web_socket | 1.0.1 | 见 pub.dev / see LICENSE | transitive |
| web_socket_channel | 3.0.3 | 见 pub.dev / see LICENSE | direct main |
| webdriver | 3.1.0 | 见 pub.dev / see LICENSE | transitive |
| webkit_inspection_protocol | 1.2.1 | 见 pub.dev / see LICENSE | transitive |
| webview_flutter | 4.14.1 | 见 pub.dev / see LICENSE | direct main |
| webview_flutter_android | 4.12.0 | 见 pub.dev / see LICENSE | transitive |
| webview_flutter_platform_interface | 2.15.1 | 见 pub.dev / see LICENSE | transitive |
| webview_flutter_wkwebview | 3.25.1 | 见 pub.dev / see LICENSE | transitive |
| win32 | 5.15.0 | 见 pub.dev / see LICENSE | transitive |
| xdg_directories | 1.1.0 | 见 pub.dev / see LICENSE | transitive |
| xml | 7.0.1 | 见 pub.dev / see LICENSE | transitive |
| yaml | 3.1.4 | 见 pub.dev / see LICENSE | transitive |

### Flutter SDK（BSD-3-Clause）

flutter, flutter_driver, flutter_test, flutter_web_plugins, fuchsia_remote_debug_protocol, integration_test, sky_engine（随 Flutter SDK 分发）
