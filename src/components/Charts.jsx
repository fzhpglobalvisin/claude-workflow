// Dependency-free SVG charts with hover tooltips, legends and a table fallback.
// Colours come from CSS custom properties --series-1..8 (validated categorical palette,
// stepped separately for light and dark themes) — assigned in fixed order, never cycled.
import { useEffect, useRef, useState } from 'react';

export const SERIES = (i) => `var(--series-${(i % 8) + 1})`;

function useWidth(ref, fallback = 600) {
  const [w, setW] = useState(fallback);
  useEffect(() => {
    if (!ref.current) return undefined;
    const ro = new ResizeObserver(([e]) => setW(Math.max(200, Math.floor(e.contentRect.width))));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, [ref]);
  return w;
}
const nice = (max) => {
  if (max <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(max));
  const n = max / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
};
const fmt = (v) => (typeof v === 'number' ? (Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(1)}k` : Number.isInteger(v) ? String(v) : v.toFixed(1)) : v);

function Legend({ keys }) {
  if (keys.length < 2) return null;
  return <div className="chart-legend">{keys.map((k, i) => <span key={k.key}><i style={{ background: k.color || SERIES(i) }} />{k.label}</span>)}</div>;
}
function Tip({ tip }) {
  if (!tip) return null;
  return (
    <div className="chart-tip" style={{ left: tip.x, top: tip.y }}>
      <strong>{tip.title}</strong>
      {tip.rows.map((r) => <div key={r.label}><i style={{ background: r.color }} />{r.label}<b>{fmt(r.value)}</b></div>)}
    </div>
  );
}

/** Vertical grouped/stacked bars, or horizontal bars. */
export function BarChart({ data = [], keys, labelKey = 'label', height = 240, horizontal = false, stacked = false, empty = 'No data yet' }) {
  const ref = useRef(null);
  const width = useWidth(ref);
  const [tip, setTip] = useState(null);
  const ks = keys.map((k, i) => ({ ...k, color: k.color || SERIES(i) }));
  if (!data.length) return <div ref={ref} className="chart-empty" style={{ height }}>{empty}</div>;
  const totals = data.map((d) => (stacked ? ks.reduce((s, k) => s + (Number(d[k.key]) || 0), 0) : Math.max(...ks.map((k) => Number(d[k.key]) || 0))));
  const max = nice(Math.max(1, ...totals));
  const tipFor = (d, e) => {
    const box = ref.current.getBoundingClientRect();
    setTip({ x: e.clientX - box.left + 12, y: e.clientY - box.top - 10, title: d[labelKey], rows: ks.map((k) => ({ label: k.label, value: Number(d[k.key]) || 0, color: k.color })) });
  };

  if (horizontal) {
    const labelW = Math.min(160, width * 0.34);
    const row = 30; const h = data.length * row + 24;
    const plotW = width - labelW - 44;
    return (
      <div ref={ref} className="chart" onMouseLeave={() => setTip(null)}>
        <svg width={width} height={h} role="img" aria-label="Bar chart">
          {[0, 0.5, 1].map((f) => <line key={f} x1={labelW + f * plotW} x2={labelW + f * plotW} y1={0} y2={h - 20} className="grid" />)}
          {[0, 0.5, 1].map((f) => <text key={f} x={labelW + f * plotW} y={h - 6} className="axis" textAnchor="middle">{fmt(max * f)}</text>)}
          {data.map((d, i) => {
            let x = labelW;
            const y = i * row + 6;
            return (
              <g key={i} onMouseMove={(e) => tipFor(d, e)}>
                <rect x={0} y={y - 4} width={width} height={row} fill="transparent" />
                <text x={labelW - 8} y={y + 13} className="axis-label" textAnchor="end">{String(d[labelKey]).slice(0, 22)}</text>
                {ks.map((k, ki) => {
                  const v = Number(d[k.key]) || 0;
                  const w = (v / max) * plotW;
                  const bh = stacked ? 18 : Math.max(6, 18 / ks.length);
                  const by = stacked ? y : y + ki * bh;
                  const node = <rect key={k.key} x={x} y={by} width={Math.max(0, w - (stacked ? 2 : 0))} height={bh - (stacked ? 0 : 2)} rx={4} fill={k.color} />;
                  if (stacked) x += w;
                  return node;
                })}
                <text x={labelW + (stacked ? totals[i] : totals[i]) / max * plotW + 6} y={y + 13} className="value-label">{fmt(totals[i])}</text>
              </g>
            );
          })}
        </svg>
        <Legend keys={ks} />
        <Tip tip={tip} />
      </div>
    );
  }

  const padL = 34; const padB = 42; const padT = 10;
  const plotW = width - padL - 8; const plotH = height - padB - padT;
  const band = plotW / data.length;
  const barW = Math.min(44, band * 0.7);
  const every = Math.ceil(data.length / Math.max(1, Math.floor(plotW / 58)));
  return (
    <div ref={ref} className="chart" onMouseLeave={() => setTip(null)}>
      <svg width={width} height={height} role="img" aria-label="Bar chart">
        {[0, 0.25, 0.5, 0.75, 1].map((f) => (
          <g key={f}><line x1={padL} x2={width - 8} y1={padT + plotH * (1 - f)} y2={padT + plotH * (1 - f)} className="grid" />
            <text x={padL - 6} y={padT + plotH * (1 - f) + 4} className="axis" textAnchor="end">{fmt(max * f)}</text></g>
        ))}
        {data.map((d, i) => {
          const cx = padL + band * i + band / 2;
          let yCursor = padT + plotH;
          const sub = stacked ? barW : barW / ks.length;
          return (
            <g key={i} onMouseMove={(e) => tipFor(d, e)}>
              <rect x={padL + band * i} y={padT} width={band} height={plotH} fill="transparent" />
              {ks.map((k, ki) => {
                const v = Number(d[k.key]) || 0;
                const h = (v / max) * plotH;
                if (stacked) {
                  yCursor -= h;
                  return <rect key={k.key} x={cx - barW / 2} y={yCursor} width={barW} height={Math.max(0, h - 2)} rx={ki === ks.length - 1 ? 4 : 0} fill={k.color} />;
                }
                return <rect key={k.key} x={cx - barW / 2 + ki * sub + 1} y={padT + plotH - h} width={Math.max(2, sub - 2)} height={h} rx={Math.min(4, sub / 2)} fill={k.color} />;
              })}
              {i % every === 0 && <text x={cx} y={height - padB + 16} className="axis" textAnchor="middle">{String(d[labelKey]).slice(0, 12)}</text>}
            </g>
          );
        })}
      </svg>
      <Legend keys={ks} />
      <Tip tip={tip} />
    </div>
  );
}

/** Multi-series line chart with crosshair tooltip. */
export function LineChart({ data = [], keys, labelKey = 'label', height = 240, area = false }) {
  const ref = useRef(null);
  const width = useWidth(ref);
  const [hover, setHover] = useState(null);
  const ks = keys.map((k, i) => ({ ...k, color: k.color || SERIES(i) }));
  if (!data.length) return <div ref={ref} className="chart-empty" style={{ height }}>No data yet</div>;
  const padL = 34; const padB = 30; const padT = 10;
  const plotW = width - padL - 12; const plotH = height - padB - padT;
  const max = nice(Math.max(1, ...data.flatMap((d) => ks.map((k) => Number(d[k.key]) || 0))));
  const x = (i) => padL + (data.length === 1 ? plotW / 2 : (i / (data.length - 1)) * plotW);
  const y = (v) => padT + plotH - (v / max) * plotH;
  const every = Math.ceil(data.length / Math.max(1, Math.floor(plotW / 60)));
  const onMove = (e) => {
    const box = ref.current.getBoundingClientRect();
    const px = e.clientX - box.left;
    const i = Math.max(0, Math.min(data.length - 1, Math.round(((px - padL) / plotW) * (data.length - 1))));
    setHover({ i, x: e.clientX - box.left + 12, y: e.clientY - box.top - 10 });
  };
  const d0 = hover ? data[hover.i] : null;
  return (
    <div ref={ref} className="chart" onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
      <svg width={width} height={height} role="img" aria-label="Line chart">
        {[0, 0.5, 1].map((f) => (
          <g key={f}><line x1={padL} x2={width - 12} y1={y(max * f)} y2={y(max * f)} className="grid" />
            <text x={padL - 6} y={y(max * f) + 4} className="axis" textAnchor="end">{fmt(max * f)}</text></g>
        ))}
        {data.map((d, i) => (i % every === 0 ? <text key={i} x={x(i)} y={height - 8} className="axis" textAnchor="middle">{d[labelKey]}</text> : null))}
        {ks.map((k) => {
          const pts = data.map((d, i) => `${x(i)},${y(Number(d[k.key]) || 0)}`).join(' ');
          return (
            <g key={k.key}>
              {area && <polygon points={`${x(0)},${y(0)} ${pts} ${x(data.length - 1)},${y(0)}`} fill={k.color} opacity={0.12} />}
              <polyline points={pts} fill="none" stroke={k.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            </g>
          );
        })}
        {hover && (
          <g>
            <line x1={x(hover.i)} x2={x(hover.i)} y1={padT} y2={padT + plotH} className="crosshair" />
            {ks.map((k) => <circle key={k.key} cx={x(hover.i)} cy={y(Number(d0[k.key]) || 0)} r={4.5} fill={k.color} stroke="var(--surface)" strokeWidth={2} />)}
          </g>
        )}
      </svg>
      <Legend keys={ks} />
      <Tip tip={hover && { x: hover.x, y: hover.y, title: d0[labelKey], rows: ks.map((k) => ({ label: k.label, value: Number(d0[k.key]) || 0, color: k.color })) }} />
    </div>
  );
}

/** Donut with centre total and legend (identity never colour-alone: labels + values listed). */
export function DonutChart({ data = [], size = 180, colors, centerLabel = 'total' }) {
  const [hi, setHi] = useState(null);
  const total = data.reduce((s, d) => s + (Number(d.value) || 0), 0);
  if (!total) return <div className="chart-empty" style={{ height: size }}>No data yet</div>;
  const r = size / 2 - 6; const inner = r * 0.62; const c = size / 2;
  let a0 = -Math.PI / 2;
  const arcs = data.map((d, i) => {
    const frac = (Number(d.value) || 0) / total;
    const a1 = a0 + frac * Math.PI * 2;
    const gap = data.length > 1 ? 0.012 : 0;
    const s = a0 + gap; const e = Math.max(s, a1 - gap);
    const large = e - s > Math.PI ? 1 : 0;
    const p = (ang, rad) => `${c + rad * Math.cos(ang)},${c + rad * Math.sin(ang)}`;
    const path = frac >= 0.9999
      ? `M ${c - r} ${c} A ${r} ${r} 0 1 1 ${c + r} ${c} A ${r} ${r} 0 1 1 ${c - r} ${c} M ${c - inner} ${c} A ${inner} ${inner} 0 1 0 ${c + inner} ${c} A ${inner} ${inner} 0 1 0 ${c - inner} ${c}`
      : `M ${p(s, r)} A ${r} ${r} 0 ${large} 1 ${p(e, r)} L ${p(e, inner)} A ${inner} ${inner} 0 ${large} 0 ${p(s, inner)} Z`;
    a0 = a1;
    return { ...d, path, color: d.color || colors?.[i] || SERIES(i), frac };
  });
  const cur = hi != null ? arcs[hi] : null;
  return (
    <div className="donut">
      <svg width={size} height={size} role="img" aria-label="Donut chart">
        {arcs.map((a, i) => <path key={a.label} d={a.path} fill={a.color} fillRule="evenodd" opacity={hi == null || hi === i ? 1 : 0.35} onMouseEnter={() => setHi(i)} onMouseLeave={() => setHi(null)} />)}
        <text x={c} y={c - 2} textAnchor="middle" className="donut-total">{fmt(cur ? cur.value : total)}</text>
        <text x={c} y={c + 16} textAnchor="middle" className="axis">{cur ? cur.label : centerLabel}</text>
      </svg>
      <ul className="donut-legend">
        {arcs.map((a, i) => <li key={a.label} onMouseEnter={() => setHi(i)} onMouseLeave={() => setHi(null)}><i style={{ background: a.color }} /><span>{a.label}</span><b>{fmt(a.value)}</b><em>{Math.round(a.frac * 100)}%</em></li>)}
      </ul>
    </div>
  );
}

export function Sparkline({ values = [], color = 'var(--series-1)', height = 36, max: fixedMax }) {
  const ref = useRef(null);
  const width = useWidth(ref, 160);
  if (values.length < 2) return <div ref={ref} style={{ height }} />;
  const max = fixedMax ?? Math.max(1, ...values);
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * (width - 4) + 2},${height - 3 - (v / max) * (height - 6)}`).join(' ');
  return <div ref={ref} className="spark"><svg width={width} height={height}><polyline points={pts} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" /></svg></div>;
}

export function DataTable({ columns, rows }) {
  return (
    <div className="table-wrap">
      <table className="table">
        <thead><tr>{columns.map((c) => <th key={c.key} className={c.key !== 'label' ? 'num' : ''}>{c.label}</th>)}</tr></thead>
        <tbody>{rows.map((r, i) => <tr key={i}>{columns.map((c) => <td key={c.key} className={c.key !== 'label' ? 'num' : ''}>{fmt(r[c.key])}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}
