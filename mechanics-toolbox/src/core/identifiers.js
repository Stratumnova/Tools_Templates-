const STABLE_IDENTIFIER = /^[A-Za-z0-9]+(?:[._:-][A-Za-z0-9]+)*$/;

export function isStableIdentifier(value) {
  return typeof value === 'string' && STABLE_IDENTIFIER.test(value);
}

export function requireStableIdentifier(value, name = 'value') {
  if (!isStableIdentifier(value)) throw new TypeError(`${name} must be a stable identifier`);
  return value;
}
