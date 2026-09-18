export function createPermissionPolicy(grants) {
  if (grants === null || typeof grants !== 'object' || Array.isArray(grants)) {
    throw new TypeError('grants must be an object');
  }

  const actorGrants = new Map();
  for (const [actorId, capabilities] of Object.entries(grants)) {
    if (!Array.isArray(capabilities) || capabilities.some(value => typeof value !== 'string' || value.trim() === '')) {
      throw new TypeError('actor grants must be arrays of nonblank strings');
    }
    actorGrants.set(actorId, new Set(capabilities));
  }

  return Object.freeze({
    allows(actorId, capability) {
      const capabilities = actorGrants.get(actorId);
      return capabilities !== undefined && (capabilities.has('*') || capabilities.has(capability));
    },
  });
}
