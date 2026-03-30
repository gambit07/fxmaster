export const easeFunctions = {
  Linear: easeLinear,
  InSine: easeInSine,
  OutSine: easeOutSine,
  InOutSine: easeInOutSine,
  InBack: easeInBack,
  OutBack: easeOutBack,
  InOutBack: easeInOutBack,
  InQuad: easeInQuad,
  InCubic: easeInCubic,
  OutCubic: easeOutCubic,
  InOutCubic: easeInOutCubic,
  InCirc: easeInCirc,
  OutCirc: easeOutCirc,
  InOutCirc: easeInOutCirc,
};

export function easeLinear(x) {
  return x;
}

export function easeInSine(x) {
  return 1 - Math.cos((x * Math.PI) / 2);
}

export function easeOutSine(x) {
  return Math.sin((x * Math.PI) / 2);
}

export function easeInOutSine(x) {
  return -(Math.cos(Math.PI * x) - 1) / 2;
}

export function easeInBack(x) {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return c3 * x * x * x - c1 * x * x;
}

export function easeOutBack(x) {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
}

export function easeInOutBack(x) {
  const c1 = 1.70158;
  const c2 = c1 * 1.525;
  return x < 0.5
    ? (Math.pow(2 * x, 2) * ((c2 + 1) * 2 * x - c2)) / 2
    : (Math.pow(2 * x - 2, 2) * ((c2 + 1) * (x * 2 - 2) + c2) + 2) / 2;
}

export function easeInCubic(x) {
  return x * x * x;
}

export function easeOutCubic(x) {
  return 1 - Math.pow(1 - x, 3);
}

export function easeInOutCubic(x) {
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

export function easeInCirc(x) {
  return 1 - Math.sqrt(1 - Math.pow(x, 2));
}

export function easeOutCirc(x) {
  return Math.sqrt(1 - Math.pow(x - 1, 2));
}

export function easeInOutCirc(x) {
  return x < 0.5 ? (1 - Math.sqrt(1 - Math.pow(2 * x, 2))) / 2 : (Math.sqrt(1 - Math.pow(-2 * x + 2, 2)) + 1) / 2;
}

export function easeInQuad(x) {
  return x * x;
}
