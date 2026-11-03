// SVG lens filter used by `backdrop-filter: url(#valence-liquid)` on small fixed elements in the
// "full" tier: edges of the glass refract what is behind them (R/G channels = x/y displacement).

function map(axis: 'x' | 'y'): string {
  const [x2, y2] = axis === 'x' ? ['1', '0'] : ['0', '1']
  const ch = (v: number) => (axis === 'x' ? `rgb(${v},0,0)` : `rgb(0,${v},0)`)
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" preserveAspectRatio="none">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="${x2}" y2="${y2}">` +
    `<stop offset="0" stop-color="${ch(255)}"/><stop offset="0.16" stop-color="${ch(128)}"/>` +
    `<stop offset="0.84" stop-color="${ch(128)}"/><stop offset="1" stop-color="${ch(0)}"/>` +
    `</linearGradient></defs><rect width="100" height="100" fill="url(#g)"/></svg>`
  return `data:image/svg+xml;base64,${btoa(svg)}`
}

export function LiquidFilter() {
  return (
    <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden>
      <filter id="valence-liquid" x="0" y="0" width="1" height="1" filterUnits="objectBoundingBox" primitiveUnits="objectBoundingBox" colorInterpolationFilters="sRGB">
        <feImage href={map('x')} x="0" y="0" width="1" height="1" preserveAspectRatio="none" result="mx" />
        <feImage href={map('y')} x="0" y="0" width="1" height="1" preserveAspectRatio="none" result="my" />
        <feComposite in="mx" in2="my" operator="arithmetic" k1="0" k2="1" k3="1" k4="0" result="map" />
        <feDisplacementMap in="SourceGraphic" in2="map" scale="0.035" xChannelSelector="R" yChannelSelector="G" />
      </filter>
    </svg>
  )
}
