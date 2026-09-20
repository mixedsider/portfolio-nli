const PARTICLE = /(?:에서|부터|까지|으로|로|의|은|는|을|를)$/u;
const UNIT = /^(?:[%٪‰‱]|[a-zμ]+(?:\/[a-zμ]+)?|\/[a-zμ]+|[가-힣]+)?$/u;
const SLASH = /[/⁄∕]/u;
const STOP = /[\s;!?。()[\]{}:"']/u;

// Extraction deliberately owns more than the grammar accepts. A rejected atom
// must not be retried at its denominator or at a numeric suffix in its unit.
export function readFractionAtom(text, start) {
  const head = /^(?:[+\p{Pd}−/⁄∕]\s*)*\.*\p{N}[\p{N}.,]*(?:\s*[/⁄∕](?=\s*[+\p{Pd}−\p{N}.,/⁄∕]|\s*$)\s*(?:[+\p{Pd}−/⁄∕]\s*)*[\p{N}.,]*)*/u.exec(text.slice(start));
  if (!head || !SLASH.test(head[0])) return null;
  let end = start + head[0].length;
  // Keep a delimiter outside the atom only when it really ends the quantity.
  if (/[.,]$/u.test(head[0]) && /^(?:\s|$)/u.test(text.slice(end)) &&
    !/^[\s.,]*[/⁄∕]/u.test(text.slice(end))) end--;
  const numericEnd = end;
  while (end < text.length) {
    const rest = text.slice(end);
    const continuation = /^[\s.,]*[/⁄∕]/u.exec(rest);
    if (continuation) {
      // Delimiters cannot launder a slash continuation into a separate atom.
      end += continuation[0].length;
      continue;
    }
    if (/^[.,](?:\s|$)/u.test(rest)) break;
    if (/^\s/u.test(rest)) {
      const space = /^\s+/u.exec(rest)[0].length;
      const next = text[end + space] || "";
      // Only the first unit and explicit slash continuations cross whitespace.
      if (SLASH.test(next) || SLASH.test(text[end - 1]) ||
        (end === numericEnd && /[a-zμ%٪‰‱가-힣]/u.test(next))) {
        end += space;
        continue;
      }
      break;
    }
    if (STOP.test(text[end])) break;
    // Existing Korean particle boundaries allow an independent ASCII quantity,
    // not Unicode numerals or attached letters/percent/slash continuations.
    if (/[0-9]/u.test(text[end])) {
      const prefix = text.slice(start, end).replace(/\s+/gu, "");
      if (PARTICLE.test(prefix) && validateFraction(prefix).valid) break;
    }
    end++;
  }
  return { end, ...validateFraction(text.slice(start, end).replace(/\s+/gu, "")) };
}

function validateFraction(atom) {
  const match = /^([+−-]?\d+\/(\d+))(.*)$/u.exec(atom);
  if (!match) return { valid: false, number: atom, unit: "" };
  const number = match[1];
  const unit = match[3].replace(PARTICLE, "");
  return { valid: /[1-9]/u.test(match[2]) && UNIT.test(unit), number, unit };
}
