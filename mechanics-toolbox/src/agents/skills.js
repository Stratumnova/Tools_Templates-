import { copyImmutableData } from '../core/immutable-data.js';
import { requireStableIdentifier } from '../core/identifiers.js';

export function validateSkillProfile(profile) {
  const copy = copyImmutableData(profile, 'profile');
  if (copy === null || Array.isArray(copy) || Object.getPrototypeOf(copy) !== Object.prototype) {
    throw new TypeError('profile must be a plain object');
  }
  for (const [skillId, value] of Object.entries(copy)) {
    requireStableIdentifier(skillId, 'profile skill ID');
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError(`profile.${skillId} must be a nonnegative safe integer`);
    }
  }
  return copy;
}

export function validateRoleSet(roles) {
  const copy = copyImmutableData(roles, 'roles');
  if (!Array.isArray(copy)) throw new TypeError('roles must be an array');
  const seen = new Set();
  for (let index = 0; index < copy.length; index += 1) {
    const roleId = requireStableIdentifier(copy[index], `roles[${index}]`);
    if (seen.has(roleId)) throw new TypeError(`roles contains duplicate role ID ${roleId}`);
    seen.add(roleId);
  }
  return copy;
}
