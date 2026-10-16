/** Draws the line as elements in the band above the prompt. */

import type { RenderElement, RenderSurface } from 'claude-code'

import type { RGB } from './color.ts'
import { MUTED_RED, type Line, type Span, type Tone } from './render.ts'

/** The element constructors the band needs from `$.ui.resolve(e)`. */
export type BandElements = {
  Box: (props: Record<string, unknown>) => RenderElement
  Text: (props: Record<string, unknown>) => RenderElement
}

const hex = (c: RGB) => '#' + c.map(v => v.toString(16).padStart(2, '0')).join('')

// The terminal draws named tones in its own palette, as the Go paceline's
// ANSI codes do. Other surfaces get fixed colors that read on light and dark.
const SURFACE_TONES: Record<string, string> = { green: '#2e9e44', yellow: '#c99a1a', cyan: '#2f9fbf' }

// In the band, `dimColor` and the theme's `inactive` key both draw as plain
// text (seen on Claude Code 2.1.296), far brighter than the ANSI dim the Go
// line uses. A fixed mid gray, Windows Terminal's "bright black", matches that
// look and stays readable on light backgrounds too.
const DIM = { color: '#767676' }

function textProps(tone: Tone, surface: RenderSurface): Record<string, unknown> {
  if (tone === 'plain') return {}
  if (tone === 'dim') return DIM
  if (tone === 'red') return { color: hex(MUTED_RED) }
  if (typeof tone !== 'string') return { color: hex(tone) }
  return { color: surface === 'terminal' ? tone : SURFACE_TONES[tone] }
}

/**
 * Builds the band's tree: one row that wraps between segments, never inside
 * one, so a narrow window moves whole segments to the next row.
 */
export function bandTree(line: Line, el: BandElements, surface: RenderSurface): RenderElement {
  const text = (s: Span) =>
    el.Text({ ...textProps(s.tone, surface), ...(s.bold ? { bold: true } : {}), children: [s.text] })
  return el.Box({
    flexDirection: 'row',
    flexWrap: 'wrap',
    children: line.map((segment, i) =>
      el.Box({
        flexDirection: 'row',
        flexShrink: 0,
        children: [
          ...(i === 0 ? [] : [el.Text({ ...DIM, children: [' \u00b7 '] })]),
          ...segment.map(text),
        ],
      }),
    ),
  })
}
