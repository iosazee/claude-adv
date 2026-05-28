// Generated from scripts/lib/args.mjs by scripts/release/sync-codex-bundle.mjs. Do not edit.
export function parseArgs(argv, config = {}) {
  const valueOptions = new Set(config.valueOptions ?? []);
  const booleanOptions = new Set(config.booleanOptions ?? []);
  const aliasMap = config.aliasMap ?? {};
  const options = {};
  const positionals = [];
  let passthrough = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (passthrough) {
      positionals.push(token);
      continue;
    }

    if (token === "--") {
      passthrough = true;
      continue;
    }

    if (!token.startsWith("-") || token === "-") {
      positionals.push(token);
      continue;
    }

    if (token.startsWith("--")) {
      const [rawKey, inlineValue] = token.slice(2).split("=", 2);
      const key = aliasMap[rawKey] ?? rawKey;

      if (booleanOptions.has(key)) {
        // Inline form (`--flag=true|false`) is the authoritative signal.
        // Otherwise, if the next argv element is the literal "true" or
        // "false", consume it so `--background false` means off (matching
        // common shell intuition). Bare `--flag` keeps meaning on.
        if (inlineValue !== undefined) {
          options[key] = inlineValue !== "false";
        } else {
          const next = argv[index + 1];
          if (next === "true" || next === "false") {
            options[key] = next === "true";
            index += 1;
          } else {
            options[key] = true;
          }
        }
        continue;
      }

      if (valueOptions.has(key)) {
        const nextValue = inlineValue ?? argv[index + 1];
        if (nextValue === undefined) {
          throw new Error(`Missing value for --${rawKey}`);
        }
        options[key] = nextValue;
        if (inlineValue === undefined) {
          index += 1;
        }
        continue;
      }

      positionals.push(token);
      continue;
    }

    const shortKey = token.slice(1);
    const key = aliasMap[shortKey] ?? shortKey;

    if (booleanOptions.has(key)) {
      // Mirror long-form: a following literal "true"/"false" is consumed.
      const next = argv[index + 1];
      if (next === "true" || next === "false") {
        options[key] = next === "true";
        index += 1;
      } else {
        options[key] = true;
      }
      continue;
    }

    if (valueOptions.has(key)) {
      const nextValue = argv[index + 1];
      if (nextValue === undefined) {
        throw new Error(`Missing value for -${shortKey}`);
      }
      options[key] = nextValue;
      index += 1;
      continue;
    }

    positionals.push(token);
  }

  return { options, positionals };
}

export function splitRawArgumentString(raw) {
  const tokens = [];
  let current = "";
  let quote = null;
  let escaping = false;

  for (const character of raw) {
    if (escaping) {
      current += character;
      escaping = false;
      continue;
    }

    if (character === "\\") {
      escaping = true;
      continue;
    }

    if (quote) {
      if (character === quote) {
        quote = null;
      } else {
        current += character;
      }
      continue;
    }

    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }

    if (/\s/.test(character)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += character;
  }

  if (escaping) {
    current += "\\";
  }

  if (current) {
    tokens.push(current);
  }

  return tokens;
}

// Claude Code slash-command files invoke us with `"$ARGUMENTS"` quoted as a
// single shell word, so multi-token flag forwarding ("--base main --wait")
// arrives as one argv element. setup.md additionally passes a fixed `--json`
// flag alongside `"$ARGUMENTS"`, so the packed token is the *second* argv
// element, not the only one. Split any FLAG-LEADING element that contains
// whitespace (preserving shell-quoted segments via splitRawArgumentString)
// and flatten the result. Multi-arg invocations whose tokens are already
// clean (tests, direct CLI calls) pass through unchanged.
//
// Positional content (a rescue prompt passed as one shell-quoted argv arg)
// is NEVER re-tokenized — even if it contains whitespace and even if it
// embeds flag-shaped substrings like "--background" as English text. The
// reliable signal is that slash-command-packed args always begin with `-`
// (the slash-command files put their fixed flags first), so a non-`-`-leading
// token with internal whitespace is always positional content.
//
// Pure-whitespace tokens (an empty $ARGUMENTS substitution that came through
// as "   ") are dropped — those are the slash-command shape, not a real
// positional argument.
export function normalizeArgv(rest) {
  const out = [];
  for (const token of rest) {
    if (typeof token !== "string") {
      out.push(token);
      continue;
    }
    if (!/\s/.test(token)) {
      out.push(token);
      continue;
    }
    const trimmed = token.trimStart();
    if (trimmed.length === 0) {
      // Pure-whitespace token: slash-command empty-args shape; drop it.
      continue;
    }
    if (trimmed.startsWith("-")) {
      // Flag-leading packed token: re-tokenize via the shell-style splitter.
      const split = splitRawArgumentString(token);
      if (split.length > 0) out.push(...split);
      continue;
    }
    // Positional content with whitespace — preserve verbatim. Splitting here
    // would let an embedded "--background" or "--base" substring impersonate
    // a flag downstream.
    out.push(token);
  }
  return out;
}

export function argvEnablesBackground(argv) {
  const normalized = normalizeArgv(argv);
  const { options } = parseArgs(normalized, {
    booleanOptions: ["background"],
  });
  return options.background === true;
}

export const JOB_REFERENCE_ARG_CONFIG = Object.freeze({
  valueOptions: ["cwd"],
  booleanOptions: ["json"],
});

export function parseJobReferenceArgs(argv) {
  return parseArgs(argv, JOB_REFERENCE_ARG_CONFIG);
}
