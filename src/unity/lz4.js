/** LZ4 块解压（Unity 的 LZ4 / LZ4HC 数据块均为标准 LZ4 block 格式）。 */
export function lz4Decompress(src, outSize) {
  const out = new Uint8Array(outSize)
  let ip = 0
  let op = 0
  const n = src.length
  while (ip < n) {
    const token = src[ip++]
    let litLen = token >> 4
    if (litLen === 15) {
      let b
      do {
        b = src[ip++]
        litLen += b
      } while (b === 255)
    }
    if (op + litLen > outSize) throw new Error('LZ4: 字面量越界')
    for (let i = 0; i < litLen; i++) out[op++] = src[ip++]
    if (ip >= n) break
    const offset = src[ip] | (src[ip + 1] << 8)
    ip += 2
    if (offset === 0 || offset > op) throw new Error('LZ4: 非法回溯偏移')
    let matchLen = token & 15
    if (matchLen === 15) {
      let b
      do {
        b = src[ip++]
        matchLen += b
      } while (b === 255)
    }
    matchLen += 4
    if (op + matchLen > outSize) throw new Error('LZ4: 匹配越界')
    let mp = op - offset
    for (let i = 0; i < matchLen; i++) out[op++] = out[mp++]
  }
  if (op !== outSize) throw new Error(`LZ4: 解压大小不符 ${op} != ${outSize}`)
  return out
}
