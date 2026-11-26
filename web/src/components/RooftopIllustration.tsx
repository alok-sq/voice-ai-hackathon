/**
 * Flat, two-tone isometric rooftop with solar panels and a rising sun,
 * per the design system's illustration rules (blue + sun, geometric, no 3D render).
 */
export function RooftopIllustration() {
  return (
    <svg className="rooftop" viewBox="0 0 240 150" role="img" aria-label="A house with solar panels under the sun">
      {/* sun */}
      <circle cx="186" cy="38" r="20" fill="var(--sun-300)" />
      <circle cx="186" cy="38" r="30" fill="var(--sun-200)" opacity=".35" />
      {/* house body */}
      <path d="M58 92 L120 120 L120 146 L58 118 Z" fill="var(--blue-100)" />
      <path d="M120 120 L182 92 L182 118 L120 146 Z" fill="var(--blue-200)" />
      {/* door */}
      <path d="M140 124 L152 118 L152 134 L140 140 Z" fill="var(--blue-300)" />
      {/* roof */}
      <path d="M50 92 L112 62 L120 120 L58 92 Z" fill="var(--blue-300)" />
      <path d="M112 62 L182 92 L120 120 Z" fill="var(--blue-500)" />
      {/* panels: 3 x 2 grid on the sunny roof face */}
      {[0, 1, 2].map((col) =>
        [0, 1].map((row) => {
          const x = 124 + col * 15 - row * 10;
          const y = 76 + col * 6.5 + row * 13;
          return (
            <path
              key={`${col}-${row}`}
              d={`M${x} ${y} l13 5.6 l-8 11.2 l-13 -5.6 Z`}
              fill="var(--blue-800)"
              stroke="var(--sun-200)"
              strokeWidth=".8"
            />
          );
        }),
      )}
      {/* ground */}
      <ellipse cx="120" cy="146" rx="92" ry="4" fill="var(--ink-100)" />
    </svg>
  );
}
