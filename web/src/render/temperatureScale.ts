/**
 * The temperature color scale: two hues moving away from a neutral midpoint, so cold and warm
 * read as opposites and no false boundaries appear, as they would in a rainbow.
 * Colors brighten away from the midpoint, to stand out on the dark map.
 */
export const SCALE_MIN_C = -40;
export const SCALE_MAX_C = 50;

export const SCALE_STOPS: { celsius: number; rgb: [number, number, number] }[] = [
  { celsius: -40, rgb: [0.78, 0.88, 1.0] },
  { celsius: -20, rgb: [0.42, 0.66, 0.98] },
  { celsius: 0, rgb: [0.2, 0.42, 0.72] },
  { celsius: 10, rgb: [0.24, 0.26, 0.29] },
  { celsius: 20, rgb: [0.62, 0.42, 0.2] },
  { celsius: 30, rgb: [0.92, 0.47, 0.13] },
  { celsius: 40, rgb: [0.95, 0.24, 0.13] },
  { celsius: 50, rgb: [1.0, 0.72, 0.68] },
];

/** The scale's color for a temperature, clamped at both ends. */
export function scaleColor(celsius: number): [number, number, number] {
  const stops = SCALE_STOPS;
  if (celsius <= stops[0].celsius) return stops[0].rgb;
  for (let i = 1; i < stops.length; i++) {
    if (celsius <= stops[i].celsius) {
      const f = (celsius - stops[i - 1].celsius) / (stops[i].celsius - stops[i - 1].celsius);
      const a = stops[i - 1].rgb;
      const b = stops[i].rgb;
      return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
    }
  }
  return stops[stops.length - 1].rgb;
}

/** The same scale as GLSL, generated so the map and its legend can't disagree. */
export function scaleGlsl(): string {
  const number = (value: number) => value.toFixed(3);
  const lines = SCALE_STOPS.slice(1).map((stop, i) => {
    const previous = SCALE_STOPS[i];
    const low = `vec3(${previous.rgb.map(number).join(", ")})`;
    const high = `vec3(${stop.rgb.map(number).join(", ")})`;
    const f = `(celsius - ${number(previous.celsius)}) / ${number(stop.celsius - previous.celsius)}`;
    return `  if (celsius <= ${number(stop.celsius)}) return mix(${low}, ${high}, ${f});`;
  });
  const first = SCALE_STOPS[0];
  const last = SCALE_STOPS[SCALE_STOPS.length - 1];
  return [
    "vec3 scale(float celsius) {",
    `  if (celsius <= ${number(first.celsius)}) return vec3(${first.rgb.map(number).join(", ")});`,
    ...lines,
    `  return vec3(${last.rgb.map(number).join(", ")});`,
    "}",
  ].join("\n");
}

/** A CSS gradient matching the scale, for the legend. */
export function scaleCss(): string {
  const span = SCALE_MAX_C - SCALE_MIN_C;
  const parts = SCALE_STOPS.map(({ celsius, rgb }) => {
    const [r, g, b] = rgb.map((channel) => Math.round(channel * 255));
    return `rgb(${r} ${g} ${b}) ${(((celsius - SCALE_MIN_C) / span) * 100).toFixed(1)}%`;
  });
  return `linear-gradient(to right, ${parts.join(", ")})`;
}

export type TemperatureUnit = "C" | "F";

export function toUnit(celsius: number, unit: TemperatureUnit): number {
  return unit === "F" ? (celsius * 9) / 5 + 32 : celsius;
}

export function formatTemperature(celsius: number, unit: TemperatureUnit): string {
  return `${Math.round(toUnit(celsius, unit))}°${unit}`;
}

/** Fahrenheit for the places that use it, Celsius everywhere else. */
export function defaultUnit(locale: string): TemperatureUnit {
  return /-(US|BS|BZ|KY|LR|PW|FM|MH)\b/i.test(locale) ? "F" : "C";
}
