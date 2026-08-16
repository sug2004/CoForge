// Removes // line comments and /* */ block comments that appear OUTSIDE string
// literals. Models (esp. NVIDIA NIM) sometimes decorate their JSON with
// human-facing comments, which JSON.parse rejects; stripping them before
// parsing saves a full slow planner/coder retry. The scanner tracks string
// state so URLs like "https://example.com" are never corrupted.
function stripJsonComments(s: string): string {
  let out = "";
  let inString = false;
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    const next = s[i + 1];
    if (inString) {
      out += c;
      if (c === "\\" && next !== undefined) {
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
    if (c === "/" && next === "/") {
      while (i < s.length && s[i] !== "\n") i += 1;
      continue;
    }
    if (c === "/" && next === "*") {
      i += 2;
      while (i < s.length && !(s[i] === "*" && s[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

// Splits text into all complete top-level JSON objects. Models frequently emit
// several concatenated objects in one reply (e.g. two tool calls back-to-back);
// the old single-object extractor silently kept only the first and dropped the
// rest, so the coder loop stalled and re-issued identical calls. A balanced
// brace scan (string-aware) finds each object; each is normalized and parsed
// with the same repairs extractJson applies.
export function extractJsonObjects(text: string): any[] {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = (fenced ? fenced[1] : text).trim();

  const objects: any[] = [];
  let i = 0;
  while (i < raw.length) {
    const start = raw.indexOf("{", i);
    if (start === -1) break;
    let depth = 0;
    let inString = false;
    let escaped = false;
    let j = start;
    for (; j < raw.length; j++) {
      const c = raw[j];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (c === "\\") {
          escaped = true;
        } else if (c === '"') {
          inString = false;
        }
        continue;
      }
      if (c === '"') {
        inString = true;
      } else if (c === "{") {
        depth++;
      } else if (c === "}") {
        depth--;
        if (depth === 0) {
          j++;
          break;
        }
      }
    }
    if (depth !== 0) {
      // unbalanced tail — stop scanning; let the caller fall back to repairs
      break;
    }
    const candidate = raw.slice(start, j);
    const repaired = repairJsonObject(candidate);
    if (repaired !== undefined) {
      objects.push(repaired);
      i = j;
    } else {
      // unparseable object — skip past it and keep scanning for valid ones
      i = j;
    }
  }
  return objects;
}

// Normalizes and parses a single JSON object with the same tolerance as
// extractJson (trailing-comma stripping, truncation repair). Returns undefined
// when the candidate cannot be parsed as a complete object.
function repairJsonObject(candidate: string): any {
  candidate = candidate
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F\u00AB\u00BB]/g, '"')
    .replace(/[\u200B-\u200D\uFEFF]/g, "");

  candidate = stripJsonComments(candidate);

  const attempts = [
    candidate,
    candidate.replace(/,\s*([}\]])/g, "$1"),
    candidate.replace(/,(\s*[}\]])/g, "$1").replace(/,(\s*[}\]])/g, "$1"),
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
    idx = candidate.lastIndexOf("}", idx - 1);
    if (idx < 0) break;
    try {
      const parsed = JSON.parse(candidate.slice(0, idx + 1));
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      // keep walking
    }
  }
  return undefined;
}

export function extractJson(text: string, label = "output"): any {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = (fenced ? fenced[1] : text).trim();

  const start = raw.indexOf("{");
  if (start === -1) {
    throw new Error(`no JSON object in ${label}:\n${raw.slice(0, 500)}`);
  }
  const end = raw.lastIndexOf("}");
  if (end < start) {
    throw new Error(`${label} has no closing brace:\n${raw.slice(0, 500)}`);
  }

  const repaired = repairJsonObject(raw.slice(start, end + 1));
  if (repaired !== undefined) return repaired;

  throw new Error(`could not parse ${label} JSON:\n${raw.slice(0, 500)}`);
}
