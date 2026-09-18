export class ImmutableDataTypeError extends TypeError {}

function typeError(path, reason) {
  return new ImmutableDataTypeError(`${path} ${reason}`);
}

function copyValue(value, path, ancestors) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw typeError(path, 'must be a finite number');
    return value;
  }
  if (typeof value !== 'object') throw typeError(path, 'contains an unsupported value');
  if (ancestors.has(value)) throw typeError(path, 'must not contain cycles');

  const isArray = Array.isArray(value);
  if (!isArray && Object.getPrototypeOf(value) !== Object.prototype) {
    throw typeError(path, 'must contain only arrays and plain objects');
  }

  ancestors.add(value);
  try {
    if (isArray) {
      const keys = Reflect.ownKeys(value);
      for (const key of keys) {
        if (key === 'length') continue;
        if (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key)
            || Number(key) >= value.length) {
          throw typeError(path, 'array contains an unsupported property');
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
          throw typeError(`${path}[${key}]`, 'must be a data property');
        }
      }
      const copy = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) throw typeError(`${path}[${index}]`, 'must not be sparse');
        copy.push(copyValue(value[index], `${path}[${index}]`, ancestors));
      }
      return Object.freeze(copy);
    }

    const copy = {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') throw typeError(path, 'contains a symbol property');
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
        throw typeError(`${path}.${key}`, 'must be an enumerable data property');
      }
      Object.defineProperty(copy, key, {
        value: copyValue(descriptor.value, `${path}.${key}`, ancestors),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return Object.freeze(copy);
  } finally {
    ancestors.delete(value);
  }
}

export function copyImmutableData(value, name = 'value') {
  return copyValue(value, name, new WeakSet());
}
