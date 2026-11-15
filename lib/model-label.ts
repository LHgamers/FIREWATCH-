const FIREWATCH_MODEL = "FIREWATCH AI";

export function displayModelName(name: string | null | undefined): string | null | undefined {
  if (!name) return name;

  const normalized = name.trim().toLowerCase().replace(/\s+/g, "-");
  const unversioned = normalized.replace(/(?::latest|-latest)$/i, "");
  const baseName = unversioned.slice(unversioned.lastIndexOf("/") + 1);
  return /^phi-?4-mini(?:-instruct)?$/i.test(baseName) ? FIREWATCH_MODEL : name;
}
