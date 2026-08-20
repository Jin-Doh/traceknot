function codePointAt(value: string, index: number): string | undefined {
  const codePoint = value.codePointAt(index);
  return codePoint === undefined ? undefined : String.fromCodePoint(codePoint);
}

function codePointBefore(value: string, index: number): string | undefined {
  if (index <= 0) return undefined;
  const trailing = value.charCodeAt(index - 1);
  const leading = index >= 2 ? value.charCodeAt(index - 2) : -1;
  const paired = trailing >= 0xdc00 && trailing <= 0xdfff && leading >= 0xd800 && leading <= 0xdbff;
  return codePointAt(value, index - (paired ? 2 : 1));
}

function isIdentityBoundary(character: string | undefined): boolean {
  return character === undefined || !/[\p{L}\p{N}._-]/u.test(character);
}

export function containsBoundaryIdentity(value: string, identity: string): boolean {
  if (identity.length === 0) return false;
  let index = value.indexOf(identity);
  while (index >= 0) {
    const before = codePointBefore(value, index);
    const afterIndex = index + identity.length;
    const after = afterIndex === value.length ? undefined : codePointAt(value, afterIndex);
    if (isIdentityBoundary(before) && isIdentityBoundary(after)) return true;
    index = value.indexOf(identity, index + 1);
  }
  return false;
}
