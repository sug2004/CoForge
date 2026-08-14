// Removes // line comments and /* */ block comments that appear OUTSIDE string
// literals. Models (esp. NVIDIA NIM) sometimes decorate their JSON with
// human-facing comments, which JSON.parse rejects; stripping them before
// parsing saves a full slow planner/coder retry. The scanner tracks string
// state so URLs like "https://example.com" are never corrupted.
function stripJsonComments(s: string): string {
  let out = '';
  let inString = false;
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    const next = s[i + 1];
    if (inString) {
      out += c;
      if (c === '\\' && next !== undefined) {
        out += next;
        i += 2;
        continue;
      }
      if (c === '"') inString = false;
      i += 1;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      i += 1;
      continue;
    }
    if (c === '/' && next === '/') {
      while (i < s.length && s[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

export function extractJson(text: string, label = 'output'): any {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  let raw = (fenced ? fenced[1] : text).trim();

  const start = raw.indexOf('{');
  if (start === -1) {
    throw new Error(`no JSON object in ${label}:\n${raw.slice(0, 500)}`);
  }
  const end = raw.lastIndexOf('}');
  if (end < start) {
    throw new Error(`${label} has no closing brace:\n${raw.slice(0, 500)}`);
  }

  let candidate = raw.slice(start, end + 1);

  // Models (esp. NVIDIA NIM) sometimes emit typographic/curly quotes instead
  // of straight ASCII quotes, which JSON.parse rejects. Normalize them (plus
  // BOM and zero-width characters) before attempting to parse.
  candidate = candidate
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F\u00AB\u00BB]/g, '"')
    .replace(/[\u200B-\u200D\uFEFF]/g, '');

  // Strip // and /* */ comments (outside strings) so a stray comment doesn't
  // force a full slow retry. Applied after quote normalization so a
  // curly-quoted string can't mask a real comment.
  candidate = stripJsonComments(candidate);

  const attempts = [
    candidate,
    candidate.replace(/,\s*([}\]])/g, '$1'),
    candidate.replace(/,(\s*[}\]])/g, '$1').replace(/,(\s*[}\]])/g, '$1'),
  ];

  for (const a of attempts) {
    try {
      return JSON.parse(a);
    } catch {
      // try next repair
    }
  }

  // Truncation repair: walk back through `}` boundaries and keep the longest
  // prefix that parses as a complete object (survives mid-JSON cut-offs).
  let idx = candidate.length;
  while (idx > 0) {
    idx = candidate.lastIndexOf('}', idx - 1);
    if (idx < 0) break;
    try {
      const parsed = JSON.parse(candidate.slice(0, idx + 1));
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      // keep walking
    }
  }

  throw new Error(`could not parse ${label} JSON:\n${raw.slice(0, 500)}`);
}
