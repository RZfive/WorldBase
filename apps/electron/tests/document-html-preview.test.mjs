/**
 * Unit tests for the generated Excel / PowerPoint HTML previews.
 *
 * Covers both authoring styles the preview must handle:
 *  - files written by this app's own generators (ExcelJS writer / officegen)
 *  - hand-built OOXML shaped like real PowerPoint decks: placeholders without
 *    slide-level geometry (inherited from layout/master), theme colours with
 *    lumMod transforms, grouped shapes with child coordinate systems, inlined
 *    images, tables with spans, and chart graphicFrames that must degrade to
 *    labelled placeholder boxes.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, statSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import ExcelJS from 'exceljs'

const ROOT = new URL('..', import.meta.url).pathname
const { writeExcelFile, writePptxFile } = await import(`${ROOT}src/main/ai-engine/agent/tools/office-utils.ts`)
const { buildExcelHtmlPreview } = await import(`${ROOT}src/main/document-preview/excel-html-preview.ts`)
const { buildPptxHtmlPreview } = await import(`${ROOT}src/main/document-preview/pptx-html-preview.ts`)
const { buildDocumentRenderPreview } = await import(`${ROOT}src/main/document-preview/document-render-service.ts`)

function makeTempDir () {
  return mkdtempSync(path.join(tmpdir(), 'wb-doc-preview-'))
}

// ---------------------------------------------------------------------------
// Excel: app-generated workbook
// ---------------------------------------------------------------------------

test('excel preview renders sheets, header styles, and the CSS-only tab switcher', async () => {
  const dir = makeTempDir()
  const filePath = path.join(dir, 'sales.xlsx')
  await writeExcelFile(filePath, [
    { name: 'Sales Data', headers: ['Region', 'Q1', 'Q2'], rows: [['North', 100, 200], ['South', 300, 400]] },
    { name: 'Summary', headers: ['Key', 'Value'], rows: [['total', 1000]] }
  ])

  const outputPath = await buildExcelHtmlPreview(filePath)
  assert.ok(existsSync(outputPath), 'cache file is written')
  const html = readFileSync(outputPath, 'utf8')

  assert.ok(html.includes('Sales Data'), 'sheet name appears as tab label')
  assert.ok(html.includes('Summary'), 'second sheet tab present')
  assert.ok(/#4472C4/i.test(html), 'header fill colour 4472C4 is applied')
  assert.ok(html.includes('North'), 'data cell text is rendered')
  assert.ok(html.includes('wb-xlsx-radio'), 'CSS-only sheet switcher is present')
  assert.ok(html.includes('data-preview-kind="workbook"'), 'workbook marker for the wide layout')
  assert.ok(!/<script/i.test(html), 'no scripts in preview output')

  const outputPath2 = await buildExcelHtmlPreview(filePath)
  assert.equal(outputPath2, outputPath, 'second build hits the cache')
  assert.equal(statSync(outputPath).mtimeMs, statSync(outputPath2).mtimeMs)
})

test('excel preview renders merges, borders, and rich text from arbitrary producers', async () => {
  const dir = makeTempDir()
  const filePath = path.join(dir, 'merged.xlsx')

  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('Merged')
  sheet.mergeCells('A1:B2')
  sheet.getCell('A1').value = 'MergedAnchor'
  sheet.getCell('A1').font = { bold: true, color: { argb: 'FFFF0000' } }
  sheet.getCell('A1').border = {
    top: { style: 'thin', color: { argb: 'FF000000' } },
    left: { style: 'medium', color: { argb: 'FF111111' } }
  }
  sheet.getCell('C1').value = { richText: [{ text: 'Rich', font: { bold: true } }, { text: 'Text' }] }
  sheet.getColumn(1).width = 20
  await workbook.xlsx.writeFile(filePath)

  const html = readFileSync(await buildExcelHtmlPreview(filePath), 'utf8')
  assert.ok(html.includes('rowspan="2"'), 'merged range produces rowspan')
  assert.ok(html.includes('colspan="2"'), 'merged range produces colspan')
  assert.ok(html.includes('MergedAnchor'), 'merged anchor text rendered')
  assert.ok(/border-top:1px solid/i.test(html), 'thin border rendered')
  assert.ok(/border-left:2px solid/i.test(html), 'medium border rendered')
  assert.ok(html.includes('font-weight:700'), 'bold rich text run styled')
  assert.ok(html.includes('#FF0000'), 'explicit font colour applied')
})

// ---------------------------------------------------------------------------
// PowerPoint: app-generated deck (officegen)
// ---------------------------------------------------------------------------

test('pptx preview renders officegen decks as scaled slides', async () => {
  const dir = makeTempDir()
  const filePath = path.join(dir, 'deck.pptx')
  await writePptxFile(filePath, [
    { title: 'First Slide', content: ['bullet one', 'bullet two'] },
    { title: 'Second Slide', content: ['more text'] }
  ])

  const outputPath = await buildPptxHtmlPreview(filePath)
  assert.ok(existsSync(outputPath), 'cache file is written')
  const html = readFileSync(outputPath, 'utf8')

  assert.equal((html.match(/class="wb-pptx-slide"/g) || []).length, 2, 'one section per slide')
  assert.ok(html.includes('First Slide'), 'slide title text rendered')
  assert.ok(html.includes('bullet one'), 'slide body text rendered')
  assert.ok(html.includes('1 / 2'), 'page numbering present')
  assert.ok(html.includes('cqw'), 'container-query scaling in use')
  assert.ok(html.includes('data-preview-kind="slides"'), 'slides marker for the wide layout')
  assert.ok(!/<script/i.test(html), 'no scripts in preview output')

  const outputPath2 = await buildPptxHtmlPreview(filePath)
  assert.equal(outputPath2, outputPath, 'second build hits the cache')
})

// ---------------------------------------------------------------------------
// PowerPoint: hand-built OOXML that mimics real PowerPoint authoring
// ---------------------------------------------------------------------------

const RED_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

function xmlDeclaration (body) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${body}`
}

/** A deck with placeholder inheritance, theme colours, a group, an image, a table, and a chart. */
async function buildRealisticPptx () {
  const { default: JSZip } = await import('jszip')
  const zip = new JSZip()

  zip.file(
    '[Content_Types].xml',
    xmlDeclaration(`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Default Extension="png" ContentType="image/png"/>
<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>
<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>
<Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
<Override PartName="/ppt/charts/chart1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>
<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>
</Types>`)
  )

  zip.file(
    '_rels/.rels',
    xmlDeclaration(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
</Relationships>`)
  )

  zip.file(
    'ppt/presentation.xml',
    xmlDeclaration(`<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId2"/></p:sldMasterIdLst>
<p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst>
<p:sldSz cx="12192000" cy="6858000"/>
</p:presentation>`)
  )

  zip.file(
    'ppt/_rels/presentation.xml.rels',
    xmlDeclaration(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>
</Relationships>`)
  )

  zip.file(
    'ppt/theme/theme1.xml',
    xmlDeclaration(`<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Test Theme">
<a:themeElements>
<a:clrScheme name="Test Scheme">
<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>
<a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>
<a:dk2><a:srgbClr val="44546A"/></a:dk2>
<a:lt2><a:srgbClr val="E7E6E6"/></a:lt2>
<a:accent1><a:srgbClr val="4472C4"/></a:accent1>
<a:accent2><a:srgbClr val="ED7D31"/></a:accent2>
<a:accent3><a:srgbClr val="A5A5A5"/></a:accent3>
<a:accent4><a:srgbClr val="FFC000"/></a:accent4>
<a:accent5><a:srgbClr val="5B9BD5"/></a:accent5>
<a:accent6><a:srgbClr val="70AD47"/></a:accent6>
<a:hlink><a:srgbClr val="0563C1"/></a:hlink>
<a:folHlink><a:srgbClr val="954F72"/></a:folHlink>
</a:clrScheme>
</a:themeElements>
</a:theme>`)
  )

  // The master carries body-placeholder geometry and title/body text defaults.
  zip.file(
    'ppt/slideMasters/slideMaster1.xml',
    xmlDeclaration(`<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
<p:cSld>
<p:spTree>
<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
<p:grpSpPr/>
<p:sp>
<p:nvSpPr><p:cNvPr id="2" name="Body Placeholder"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr>
<p:spPr><a:xfrm><a:off x="500000" y="2000000"/><a:ext cx="10000000" cy="4000000"/></a:xfrm></p:spPr>
<p:txBody><a:bodyPr/><a:lstStyle/><a:p/></p:txBody>
</p:sp>
</p:spTree>
</p:cSld>
<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>
<p:txStyles>
<p:titleStyle><a:lvl1pPr><a:defRPr sz="4000" b="1"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill></a:defRPr></a:lvl1pPr></p:titleStyle>
<p:bodyStyle><a:lvl1pPr><a:defRPr sz="1800"/></a:lvl1pPr></p:bodyStyle>
<p:otherStyle><a:lvl1pPr><a:defRPr sz="1800"/></a:lvl1pPr></p:otherStyle>
</p:txStyles>
</p:sldMaster>`)
  )

  zip.file(
    'ppt/slideMasters/_rels/slideMaster1.xml.rels',
    xmlDeclaration(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>
</Relationships>`)
  )

  // The layout carries the title-placeholder geometry; the slide omits it.
  zip.file(
    'ppt/slideLayouts/slideLayout1.xml',
    xmlDeclaration(`<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="Title Only">
<p:cSld>
<p:spTree>
<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
<p:grpSpPr/>
<p:sp>
<p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr/><p:nvPr><p:ph type="ctrTitle"/></p:nvPr></p:nvSpPr>
<p:spPr><a:xfrm><a:off x="1000000" y="200000"/><a:ext cx="9000000" cy="1500000"/></a:xfrm></p:spPr>
<p:txBody><a:bodyPr/><a:lstStyle/><a:p/></p:txBody>
</p:sp>
</p:spTree>
</p:cSld>
</p:sldLayout>`)
  )

  zip.file('ppt/media/image1.png', Buffer.from(RED_PNG_BASE64, 'base64'))

  zip.file(
    'ppt/charts/chart1.xml',
    xmlDeclaration(`<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
<c:chart><c:title><c:tx><c:rich><a:bodyPr/><a:p><a:r><a:t>Sales</a:t></a:r></a:p></c:rich></c:tx></c:title><c:plotArea/></c:chart>
</c:chartSpace>`)
  )

  zip.file(
    'ppt/slides/_rels/slide1.xml.rels',
    xmlDeclaration(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rIdLayout" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
<Relationship Id="rIdImg" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/>
<Relationship Id="rIdChart" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart1.xml"/>
</Relationships>`)
  )

  zip.file(
    'ppt/slides/slide1.xml',
    xmlDeclaration(`<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart">
<p:cSld>
<p:spTree>
<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
<p:grpSpPr/>

<p:sp>
<p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr/><p:nvPr><p:ph type="ctrTitle"/></p:nvPr></p:nvSpPr>
<p:spPr/>
<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:pPr algn="ctr"/><a:r><a:rPr lang="zh-CN" b="1"><a:solidFill><a:schemeClr val="accent1"><a:lumMod val="50000"/></a:schemeClr></a:solidFill></a:rPr><a:t>真实标题</a:t></a:r></a:p></p:txBody>
</p:sp>

<p:sp>
<p:nvSpPr><p:cNvPr id="3" name="Content"/><p:cNvSpPr/><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr>
<p:spPr/>
<p:txBody><a:bodyPr/><a:lstStyle/>
<a:p><a:pPr marL="228600" indent="-228600"><a:buChar char="•"/></a:pPr><a:r><a:rPr lang="zh-CN"/><a:t>第一条要点</a:t></a:r></a:p>
<a:p><a:pPr marL="228600" indent="-228600"><a:buChar char="•"/></a:pPr><a:r><a:rPr lang="zh-CN"/><a:t>第二条要点</a:t></a:r></a:p>
</p:txBody>
</p:sp>

<p:grpSp>
<p:nvGrpSpPr><p:cNvPr id="4" name="Group"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
<p:grpSpPr><a:xfrm><a:off x="2000000" y="4500000"/><a:ext cx="4000000" cy="2000000"/><a:chOff x="0" y="0"/><a:chExt cx="2000000" cy="1000000"/></a:xfrm></p:grpSpPr>
<p:sp>
<p:nvSpPr><p:cNvPr id="5" name="Grouped Box"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
<p:spPr><a:xfrm><a:off x="1000000" y="0"/><a:ext cx="500000" cy="500000"/></a:xfrm><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></p:spPr>
<p:txBody><a:bodyPr/><a:lstStyle/><a:p/></p:txBody>
</p:sp>
</p:grpSp>

<p:pic>
<p:nvPicPr><p:cNvPr id="6" name="Picture"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>
<p:blipFill><a:blip r:embed="rIdImg"/></p:blipFill>
<p:spPr><a:xfrm><a:off x="7000000" y="4500000"/><a:ext cx="1000000" cy="1000000"/></a:xfrm></p:spPr>
</p:pic>

<p:graphicFrame>
<p:nvGraphicFramePr><p:cNvPr id="7" name="Table"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>
<p:xfrm><a:off x="500000" y="5200000"/><a:ext cx="4000000" cy="800000"/></p:xfrm>
<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">
<a:tbl><a:tblGrid><a:gridCol w="1500000"/><a:gridCol w="1500000"/><a:gridCol w="1000000"/></a:tblGrid>
<a:tr h="400000"><a:tc gridSpan="2"><a:txBody><a:bodyPr/><a:p><a:r><a:t>合并表头</a:t></a:r></a:p></a:txBody><a:tcPr><a:solidFill><a:srgbClr val="D9E2F3"/></a:solidFill></a:tcPr></a:tc><a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:t>C</a:t></a:r></a:p></a:txBody><a:tcPr/></a:tc></a:tr>
</a:tbl>
</a:graphicData></a:graphic>
</p:graphicFrame>

<p:graphicFrame>
<p:nvGraphicFramePr><p:cNvPr id="8" name="Chart"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>
<p:xfrm><a:off x="5200000" y="5200000"/><a:ext cx="3000000" cy="1500000"/></p:xfrm>
<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart">
<c:chart r:id="rIdChart"/>
</a:graphicData></a:graphic>
</p:graphicFrame>

</p:spTree>
</p:cSld>
</p:sld>`)
  )

  return zip.generateAsync({ type: 'nodebuffer' })
}

test('pptx preview resolves placeholder inheritance, theme colours, groups, images, tables, and chart fallbacks', async () => {
  const dir = makeTempDir()
  const filePath = path.join(dir, 'realistic.pptx')
  writeFileSync(filePath, await buildRealisticPptx())

  const html = readFileSync(await buildPptxHtmlPreview(filePath), 'utf8')

  // Slide canvas ratio from presentation.xml.
  assert.ok(html.includes('aspect-ratio:12192000/6858000'), 'slide size honoured')

  // Title placeholder has no slide xfrm → geometry comes from the layout.
  assert.ok(html.includes('left:8.202%'), 'title xfrm inherited from layout')
  assert.ok(html.includes('top:2.916%'), 'title top inherited from layout')

  // Body placeholder → geometry from the master.
  assert.ok(html.includes('left:4.101%'), 'body xfrm inherited from master')

  // Title run has no sz → falls back to master titleStyle (40pt) and bold.
  assert.ok(html.includes('font-size:4.167cqw'), 'master titleStyle default size applied')
  assert.ok(/font-weight:700/.test(html), 'master titleStyle bold applied')

  // schemeClr accent1 (#4472C4) with lumMod must resolve to a concrete hex.
  assert.ok(/color:#[0-9A-F]{6}/.test(html), 'theme colour resolved to concrete hex')

  assert.ok(html.includes('真实标题'), 'title text rendered')
  assert.ok(html.includes('第一条要点'), 'body text rendered')
  assert.ok(html.includes('•'), 'bullet char rendered')

  // Group transform: child at (1000000,0) size (500000,500000) inside a
  // 2x scaled group at (2000000,4500000) → x=4000000 (32.808%), w=1000000 (8.202%).
  assert.ok(html.includes('left:32.808%'), 'group child x transformed')
  assert.ok(html.includes('width:8.202%'), 'group child width scaled')
  assert.ok(html.includes('background:#FF0000'), 'grouped shape fill rendered')

  // Image inlined as data URL.
  assert.ok(html.includes('data:image/png;base64,'), 'image inlined as data URL')

  // Table with gridSpan → colspan, cell fill.
  assert.ok(html.includes('colspan="2"'), 'table gridSpan becomes colspan')
  assert.ok(html.includes('合并表头'), 'table text rendered')
  assert.ok(html.includes('#D9E2F3'), 'table cell fill rendered')

  // Chart degrades to a labelled placeholder with its title.
  assert.ok(html.includes('图表'), 'chart placeholder label')
  assert.ok(html.includes('Sales'), 'chart title surfaced in placeholder')

  assert.ok(!/<script/i.test(html), 'no scripts in preview output')
})

// ---------------------------------------------------------------------------
// render service wiring
// ---------------------------------------------------------------------------

test('markdown documents parse to nodes and preview through the original file asset', async () => {
  const dir = makeTempDir()
  const mdPath = path.join(dir, 'notes.md')
  writeFileSync(mdPath, [
    '# 项目计划',
    '',
    '支持 **加粗**、`代码` 与公式 $E=mc^2$。',
    '',
    '| 模块 | 状态 |',
    '| --- | --- |',
    '| 解析 | 完成 |',
    '| 预览 | 完成 |',
    '',
    '- 第一项',
    '- 第二项',
    '',
    '```ts',
    'const x = 1',
    '```',
    ''
  ].join('\n'))

  const { parseDocument } = await import(`${ROOT}src/main/ai-engine/agent/tools/document-parser.ts`)
  const artifact = await parseDocument(mdPath)
  assert.equal(artifact.fileType, 'md')
  const types = artifact.nodes.map(node => node.type)
  assert.ok(types.includes('heading'), 'heading node parsed')
  assert.ok(types.includes('table'), 'table node parsed')
  assert.ok(types.includes('list_item'), 'list item parsed')
  const table = artifact.nodes.find(node => node.type === 'table')
  assert.ok(table?.children?.some(row => ((row.meta?.cells) || []).includes('解析')), 'table cells captured')

  const render = await buildDocumentRenderPreview(mdPath, 'md')
  assert.equal(render.kind, 'markdown')
  assert.equal(render.status, 'ready')
  assert.equal(render.assetPath, mdPath, 'original file is the preview asset')

  const { readDocumentRenderAsset } = await import(`${ROOT}src/main/document-preview/document-render-service.ts`)
  const asset = await readDocumentRenderAsset(render)
  assert.ok(asset, 'render asset readable')
  assert.equal(asset.mimeType, 'text/markdown; charset=utf-8')
  assert.ok(new TextDecoder().decode(asset.bytes).includes('项目计划'), 'asset carries the raw markdown')
})

test('buildDocumentRenderPreview returns html assets for xlsx and pptx, falls back on missing files', async () => {
  const dir = makeTempDir()

  const xlsxPath = path.join(dir, 'wired.xlsx')
  await writeExcelFile(xlsxPath, [{ name: 'Sheet1', headers: ['A'], rows: [['1']] }])
  const xlsxRender = await buildDocumentRenderPreview(xlsxPath, 'xlsx')
  assert.equal(xlsxRender.kind, 'html')
  assert.equal(xlsxRender.status, 'ready')
  assert.equal(xlsxRender.mimeType, 'text/html; charset=utf-8')
  assert.ok(xlsxRender.assetPath && existsSync(xlsxRender.assetPath))

  const pptxPath = path.join(dir, 'wired.pptx')
  await writePptxFile(pptxPath, [{ title: 'T', content: ['c'] }])
  const pptxRender = await buildDocumentRenderPreview(pptxPath, 'pptx')
  assert.equal(pptxRender.kind, 'html')
  assert.equal(pptxRender.status, 'ready')
  assert.ok(pptxRender.assetPath && existsSync(pptxRender.assetPath))

  const missing = await buildDocumentRenderPreview(path.join(dir, 'nope.xlsx'), 'xlsx')
  assert.equal(missing.kind, 'structured')
  assert.equal(missing.status, 'unavailable')
  assert.ok(missing.error && missing.error.length > 0, 'fallback carries an error message')
})
