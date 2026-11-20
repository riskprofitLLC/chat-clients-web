// Чистые хелперы палитры для токен-тестов: разбор цветов и контраст WCAG.
// В рантайме UI не нужны — только тесты и аудит токенов.

export interface Rgb {
  r: number
  g: number
  b: number
}

// поддерживаем #rgb и #rrggbb — всё остальное в токенах не встречается
export function parseColor(value: string): Rgb | null {
  const hex = value.trim()
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(hex)
  if (short) {
    return { r: parseInt(short[1] + short[1], 16), g: parseInt(short[2] + short[2], 16), b: parseInt(short[3] + short[3], 16) }
  }
  const long = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex)
  if (long) {
    return { r: parseInt(long[1], 16), g: parseInt(long[2], 16), b: parseInt(long[3], 16) }
  }
  return null
}

function channel(value: number): number {
  const c = value / 255
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}

// относительная яркость по WCAG 2.x (взвешенная сумма каналов)
export function relativeLuminance(color: Rgb): number {
  return channel(color.r) * 0.2126 + channel(color.g) * 0.7152 + channel(color.b) * 0.0722
}

// контраст двух цветов по WCAG (1..21); оба обязаны быть hex
export function contrastRatio(a: string, b: string): number {
  const ca = parseColor(a)
  const cb = parseColor(b)
  if (!ca || !cb) throw new Error('не разобрать цвет пары ' + a + ' ' + b)
  const la = relativeLuminance(ca)
  const lb = relativeLuminance(cb)
  const light = Math.max(la, lb)
  const dark = Math.min(la, lb)
  return (light + 0.05) / (dark + 0.05)
}
