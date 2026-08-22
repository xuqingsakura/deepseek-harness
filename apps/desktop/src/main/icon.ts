/**
 * 桌面端图标生成（Phase 0.1 拆分）。
 *
 * 从 main.ts 提取：把 favicon.svg 栅格化为标准 Windows 图标尺寸并写出 PNG 与 ICO。
 * 借助一个隐藏渲染器完成 SVG 栅格化（需要 DOM canvas）。`--gen-icon <dir>` 的
 * 编排仍在主进程入口，此处只提供纯函数。
 * @module @deepseek-ai/dsh-desktop/main/icon
 */

import { BrowserWindow } from 'electron'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { FAVICON } from './config.ts'

/**
 * 由 PNG 压缩条目组装 ICO 容器（Vista+ 格式）。
 * @param entries - 带尺寸标签的 PNG 缓冲；size 的字节 0 表示 256px。
 * @returns 组装好的 ICO 文件字节。
 */
function buildIco(entries: Array<{ size: number; png: Buffer }>): Buffer {
  const sorted = [...entries].sort((a, b) => a.size - b.size)
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(sorted.length, 4)
  const directory = Buffer.alloc(16 * sorted.length)
  let offset = 6 + 16 * sorted.length
  sorted.forEach((entry, index) => {
    const base = index * 16
    const encoded = entry.size >= 256 ? 0 : entry.size
    directory.writeUInt8(encoded, base)
    directory.writeUInt8(encoded, base + 1)
    directory.writeUInt8(0, base + 2)
    directory.writeUInt8(0, base + 3)
    directory.writeUInt16LE(1, base + 4)
    directory.writeUInt16LE(32, base + 6)
    directory.writeUInt32LE(entry.png.length, base + 8)
    directory.writeUInt32LE(offset, base + 12)
    offset += entry.png.length
  })
  return Buffer.concat([header, directory, ...sorted.map(entry => entry.png)])
}

/**
 * 渲染 favicon.svg 到标准 Windows 图标尺寸，并把 PNG + ICO 写入输出目录。
 * 在隐藏渲染器中运行（SVG 栅格化需要 DOM canvas）。
 * @param outDir - 绝对输出目录（不存在时创建）。
 */
async function generateIconAssets(outDir: string): Promise<void> {
  console.log('[dsh-icon] reading favicon')
  const svg = await readFile(FAVICON, 'utf8')
  const svgDataUrl = `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`
  console.log('[dsh-icon] creating hidden renderer')
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true } })
  await window.loadURL('data:text/html,<meta charset="utf-8"><title>dsh icon generator</title><body></body>')
  console.log('[dsh-icon] renderer loaded')
  const code = `(async () => {
    const sizes = [16, 24, 32, 48, 64, 128, 256]
    const out = []
    for (const size of sizes) {
      const img = await new Promise((resolve, reject) => {
        const image = new Image()
        image.onload = () => resolve(image)
        image.onerror = () => reject(new Error('favicon svg decode failed'))
        image.src = ${JSON.stringify(svgDataUrl)}
      })
      const canvas = document.createElement('canvas')
      canvas.width = size
      canvas.height = size
      const ctx = canvas.getContext('2d')
      if (ctx === null) throw new Error('2d canvas context unavailable')
      ctx.drawImage(img, 0, 0, size, size)
      out.push({ size, dataUrl: canvas.toDataURL('image/png') })
    }
    return out
  })()`
  console.log('[dsh-icon] running rasterizer')
  const results = await window.webContents.executeJavaScript(code) as Array<{ size: number; dataUrl: string }>
  console.log(`[dsh-icon] rasterized ${String(results.length)} sizes`)
  // 保留隐藏窗口存活：销毁它会触发 window-all-closed 默认处理而提前退出应用，
  // 等在下面写入完成后再由 app.exit(0)（generateIconAssets 返回后）整体回收。
  await mkdir(outDir, { recursive: true })
  const entries: Array<{ size: number; png: Buffer }> = []
  for (const { size, dataUrl } of results) {
    // canvas 已产生合法 PNG，直接解码，而不是经 nativeImage 往返（Windows 上会解出空图）。
    const png = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64')
    entries.push({ size, png })
    await writeFile(join(outDir, `icon-${size}.png`), png)
    console.log(`[dsh-icon] wrote icon-${size}.png (${String(png.length)} bytes)`)
  }
  const icon256 = entries.find(entry => entry.size === 256)
  if (icon256 !== undefined) await writeFile(join(outDir, 'icon.png'), icon256.png)
  await writeFile(join(outDir, 'icon.ico'), buildIco(entries))
  console.log(`DESKTOP_ICON_OK ${join(outDir, 'icon.ico')} (${String(entries.length)} sizes)`)
}

export { buildIco, generateIconAssets }
