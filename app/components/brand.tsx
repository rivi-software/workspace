import type * as React from "react";

/**
 * The mark: a rounded tile holding five level bars, the middle one lit like an on-air meter. Everything is geometry,
 * so no font or image loads for the logo. The tile and bars follow the theme through `--rivi-mark-tile` and
 * `--rivi-mark-bars` (ink tile on light grounds, paper tile on dark ones), and the lit bar through `--rivi-mark-peak`;
 * without them it draws the light-ground colours. Decorative unless given a `title`. Swap this component to brand a
 * workspace of your own; `public/favicon.svg` and `public/icons/` are the same drawing.
 */

interface Bar {
  x: number;
  y: number;
  width: number;
  height: number;
  rx: number;
}

const MARK_VIEWBOX = "0 0 40 40";
const MARK_TILE = { width: 40, height: 40, rx: 9 } as const;

const MARK_BARS: readonly Bar[] = [
  { x: 8, y: 16, width: 3, height: 8, rx: 1.5 },
  { x: 13.25, y: 11, width: 3, height: 18, rx: 1.5 },
  { x: 18.5, y: 7, width: 3, height: 26, rx: 1.5 },
  { x: 23.75, y: 12, width: 3, height: 16, rx: 1.5 },
  { x: 29, y: 16, width: 3, height: 8, rx: 1.5 },
];

/** The index of the lit bar in `MARK_BARS`. */
const MARK_PEAK = 2;

/** The identity colours: ink, paper and the signal green of the lit bar. */
const colors = {
  ink: "#15171a",
  paper: "#f5f6f7",
  signal: "#3be08a",
} as const;

type SvgProps = Omit<React.SVGProps<SVGSVGElement>, "viewBox" | "children">;

export const RiviMark = ({
  title,
  ...props
}: SvgProps & { title?: string }) => (
  <svg
    viewBox={MARK_VIEWBOX}
    width="1em"
    height="1em"
    role={title ? "img" : undefined}
    aria-label={title}
    aria-hidden={title ? undefined : true}
    {...props}
  >
    <rect {...MARK_TILE} fill={`var(--rivi-mark-tile, ${colors.ink})`} />
    <g fill={`var(--rivi-mark-bars, ${colors.paper})`}>
      {MARK_BARS.map((bar, index) => (
        <rect
          key={bar.x}
          {...bar}
          fill={
            index === MARK_PEAK
              ? `var(--rivi-mark-peak, ${colors.signal})`
              : undefined
          }
        />
      ))}
    </g>
  </svg>
);
