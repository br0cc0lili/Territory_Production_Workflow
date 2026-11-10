// Builds Adobe Swatch Exchange bytes (same builder as the plugin's textcolor.test.js).
type AseEntry = { group: string } | { end: true } | { name: string; model: string; values: number[] }

export function ase(entries: AseEntry[]): Buffer {
  const u16 = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b }
  const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b }
  const name = (s: string) => Buffer.concat([u16(s.length + 1), Buffer.from((s + '\0').split('').flatMap((c) => [0, c.charCodeAt(0)]))])
  const parts = entries.map((e) => {
    let body: Buffer
    let type: number
    if ('group' in e) { body = name(e.group); type = 0xc001 }
    else if ('end' in e) { body = Buffer.alloc(0); type = 0xc002 }
    else {
      body = Buffer.concat([name(e.name), Buffer.from(e.model), Buffer.concat(e.values.map((v) => { const b = Buffer.alloc(4); b.writeFloatBE(v); return b })), u16(2)])
      type = 0x0001
    }
    return Buffer.concat([u16(type), u32(body.length), body])
  })
  return Buffer.concat([Buffer.from('ASEF'), u16(1), u16(0), u32(entries.length), ...parts])
}

// The plugin test's palette: group "Brand" with RGB white, CMYK black, LAB red, Gray, then a loose RGB blue.
export const BRAND_ASE = () => ase([
  { group: 'Brand' },
  { name: 'White', model: 'RGB ', values: [1, 1, 1] },
  { name: 'Black', model: 'CMYK', values: [0, 0, 0, 1] },
  { name: 'Red', model: 'LAB ', values: [0.5, 75, 50] },
  { name: 'Grey', model: 'Gray', values: [0.5] },
  { end: true },
  { name: 'Loose', model: 'RGB ', values: [0, 0, 1] },
])
