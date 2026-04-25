export function slugify(input: string): string {
  const base = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return base.length > 0 ? base : "untitled";
}

export function uniqueSlug(base: string, exists: (slug: string) => boolean): string {
  if (!exists(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}-${i}`;
    if (!exists(candidate)) return candidate;
  }
  throw new Error(`could not allocate unique slug for "${base}"`);
}
