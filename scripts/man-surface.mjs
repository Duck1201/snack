/**
 * The published command surface, read from the help text.
 *
 * `contracts.test.js` and the generated `snack.1` both describe the same thing, and reading it
 * twice is how they come to disagree. They read it here. The source is the help text rather than
 * Commander's object graph, for the reason `contracts.test.js` has always given: the help is the
 * surface a user is actually promised, and a check that read the object graph would still pass
 * with a flag the help had stopped mentioning.
 */

/**
 * @typedef {object} Flag
 * @property {string} flag the long form, `--source`
 * @property {string | null} argument the placeholder it takes, `<alias>`, or null for a switch
 * @property {string} description the whole description, rejoined across Commander's wrapping
 */

/**
 * @typedef {object} Help
 * @property {string} usage the `Usage:` line, without the label
 * @property {string} description the summary beneath it, rejoined across wrapping
 * @property {Flag[]} flags
 * @property {string[]} commands subcommand names, `help` excluded
 */

/**
 * Read one `--help` document.
 *
 * Commander wraps to the terminal width, so both a description and a flag's description can arrive
 * as a first line plus indented continuations. Reading only the first line truncates silently, and
 * a byte-comparison gate downstream would then hold the truncation in place as expected output.
 *
 * @param {string} text
 * @returns {Help}
 */
export function parseHelp(text) {
  const lines = text.split("\n");
  const usage =
    lines
      .find((line) => line.startsWith("Usage:"))
      ?.slice("Usage:".length)
      .trim() ?? "";

  return {
    usage,
    description: sectionDescription(lines),
    flags: parseFlags(section(text, "Options:")),
    commands: parseCommands(section(text, "Commands:")),
  };
}

/**
 * The block under a heading, up to the next heading or the end.
 *
 * @param {string} text
 * @param {string} heading
 */
function section(text, heading) {
  const after = text.split(new RegExp(`^${heading}$`, "mu"))[1];
  if (after === undefined) return [];
  return after.split(/^\S.*$/mu)[0]?.split("\n") ?? [];
}

/**
 * The summary paragraph: everything between the `Usage:` line and the first heading.
 *
 * @param {string[]} lines
 */
function sectionDescription(lines) {
  const start = lines.findIndex((line) => line.startsWith("Usage:"));
  if (start === -1) return "";
  /** @type {string[]} */
  const collected = [];
  for (const line of lines.slice(start + 1)) {
    // Stop at the next heading -- `Options:`, `Commands:`, `Arguments:` -- and not merely at the
    // next unindented line, because the summary itself is unindented and is what is being read.
    if (/^[A-Z][A-Za-z ]*:$/u.test(line)) break;
    if (line.trim() !== "") collected.push(line.trim());
  }
  return collected.join(" ");
}

/**
 * @param {string[]} lines
 * @returns {Flag[]}
 */
function parseFlags(lines) {
  /** @type {Flag[]} */
  const flags = [];
  for (const line of lines) {
    // `  -V, --version`, `  --source <alias>`, `  --prompt-file <path>`. The short form is dropped:
    // the long form is the name the contract is written in, and `-h`/`-V` are Commander's own.
    const declared = /^ {2}(?:-\w, )?(--[a-z][a-z-]*)(?: (<[^>]+>|\[[^\]]+\]))?\s{2,}(.*)$/u.exec(
      line,
    );
    if (declared) {
      flags.push({
        flag: String(declared[1]),
        argument: declared[2] ?? null,
        description: String(declared[3]).trim(),
      });
      continue;
    }
    const continuation = /^ {4,}(\S.*)$/u.exec(line);
    const previous = flags.at(-1);
    if (continuation && previous) {
      previous.description = `${previous.description} ${String(continuation[1]).trim()}`.trim();
    }
  }
  return flags;
}

/**
 * @typedef {object} Command
 * @property {string} name `snack`, `status`, `config get` -- the words after `snack`, or `snack`
 * @property {string} usage
 * @property {string} description
 * @property {Flag[]} flags
 */

/**
 * Walk every command the help reaches, depth first, groups replaced by their children.
 *
 * `help` is supplied by the caller rather than built here, because the two callers reach `run()`
 * differently: the test suite already has a fixture with sinks and a temporary environment, and the
 * generator has neither and needs no more than a string back.
 *
 * @param {(argv: string[]) => Promise<string>} help
 * @returns {Promise<Command[]>}
 */
export async function commandSurface(help) {
  const root = parseHelp(await help([]));
  /** @type {Command[]} */
  const surface = [
    { name: "snack", usage: root.usage, description: root.description, flags: root.flags },
  ];

  for (const command of root.commands) {
    const parsed = parseHelp(await help([command]));
    if (parsed.commands.length === 0) {
      surface.push({
        name: command,
        usage: parsed.usage,
        description: parsed.description,
        flags: parsed.flags,
      });
      continue;
    }
    // A group carries no action of its own, so it is replaced by its children rather than listed
    // beside them: documenting `snack config` would name something nobody can run.
    for (const child of parsed.commands) {
      const leaf = parseHelp(await help([command, child]));
      surface.push({
        name: `${command} ${child}`,
        usage: leaf.usage,
        description: leaf.description,
        flags: leaf.flags,
      });
    }
  }
  return surface;
}

/**
 * The surface as `contracts.test.js` asserts it: command name to long-flag names, sorted.
 *
 * @param {Command[]} surface
 * @returns {Record<string, string[]>}
 */
export function flagMap(surface) {
  return Object.fromEntries(
    surface
      .map(
        (command) =>
          /** @type {[string, string[]]} */ ([
            command.name,
            command.flags.map((flag) => flag.flag),
          ]),
      )
      .sort(([left], [right]) => (left < right ? -1 : 1)),
  );
}

/**
 * @typedef {object} Prose
 * @property {string[]} synopsis the lines of the section's fenced usage block, if it has one
 * @property {string[]} paragraphs the section's prose, one entry per paragraph
 */

/**
 * The command-reference prose, read out of `docs/specification/cli.md` by heading.
 *
 * The man page holds no prose of its own. A second copy of these paragraphs would be maintained by
 * whoever last remembered it existed, and the specification is the document the project already
 * treats as the contract.
 *
 * Sections are keyed by the command their heading names -- `### 12.3 \`snack status\`` keys
 * `snack status`. A section whose heading names no command, such as `12.11 Exit Codes`, is not
 * prose for a command and is dropped: attaching it to whichever command happened to precede it
 * would state the whole CLI's exit codes as though they were that one command's.
 *
 * @param {string} markdown
 * @returns {Record<string, Prose>}
 */
export function extractProse(markdown) {
  /** @type {Record<string, Prose>} */
  const prose = {};
  const sections = markdown.split(/^### /mu).slice(1);

  for (const section of sections) {
    const lines = section.split("\n");
    const heading = String(lines[0] ?? "");
    // `### 12.3 \`snack status\`` keys `snack status`; `### 12.1 Global Behavior` keys
    // `Global Behavior`. Only the first kind is prose *for a command* -- the second documents the
    // whole CLI, and the generator places it by name rather than beside whichever command happened
    // to precede it.
    const titled = /^[\d.]+\s+(?:`([^`]+)`|(.+?))\s*$/u.exec(heading);
    if (!titled) continue;
    const key = titled[1] ?? titled[2];
    if (key === undefined) continue;

    /** @type {string[]} */
    const synopsis = [];
    /** @type {string[]} */
    const paragraphs = [];
    /** @type {string[]} */
    let paragraph = [];
    let inFence = false;

    for (const line of lines.slice(1)) {
      if (line.startsWith("```")) {
        inFence = !inFence;
        continue;
      }
      if (inFence) {
        if (line.trim() !== "") synopsis.push(line.trim());
        continue;
      }
      if (line.trim() === "") {
        if (paragraph.length > 0) paragraphs.push(paragraph.join(" "));
        paragraph = [];
        continue;
      }
      // A bullet ends whatever preceded it and becomes an entry of its own. Folded into the
      // surrounding paragraph, a list reads as "- discover sources; - select profiles;" on one
      // run-on line, which carries the words and loses the list.
      if (/^-\s/u.test(line.trim())) {
        if (paragraph.length > 0) paragraphs.push(paragraph.join(" "));
        paragraph = [line.trim()];
        continue;
      }
      paragraph.push(line.trim());
    }
    if (paragraph.length > 0) paragraphs.push(paragraph.join(" "));

    prose[String(key)] = { synopsis, paragraphs };
  }
  return prose;
}

/**
 * @param {string[]} lines
 * @returns {string[]}
 */
function parseCommands(lines) {
  return lines
    .flatMap((line) => {
      const declared = /^ {2}(\w[\w-]*)/u.exec(line);
      return declared ? [String(declared[1])] : [];
    })
    .filter((name) => name !== "help");
}
