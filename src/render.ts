/**
 * Transcript rendering for the sgrep tools.
 *
 * Pi renders every tool call inline in the TUI and in HTML exports. Search
 * output is long, so the collapsed view shows the query line only and the
 * expanded view shows everything with a cap; both reuse the same truncation
 * helpers pi-tui uses for the rest of the UI.
 */

import { type Component, sliceByColumn, Text, visibleWidth } from "@earendil-works/pi-tui";

/**
 * Minimal theme surface used here. Declared structurally instead of importing
 * pi's internal `Theme` type, which is not part of the package's public API.
 */
export interface ThemeLike {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

/** Single-line result view that collapses to `preview` plus a marker. */
class CollapsedText implements Component {
  constructor(
    private readonly preview: string,
    private readonly suffix: string,
    private readonly marker: string,
  ) {}

  render(width: number): string[] {
    const available = Math.max(1, width);

    if (!this.suffix) {
      if (visibleWidth(this.preview) <= available) return [this.preview];
      const markerWidth = visibleWidth(this.marker);
      if (markerWidth >= available) return [sliceByColumn(this.marker, 0, available, true)];
      return [
        `${sliceByColumn(this.preview, 0, available - markerWidth, true)}${this.marker}`,
      ];
    }

    const suffixWidth = visibleWidth(this.suffix);
    if (suffixWidth >= available) return [sliceByColumn(this.suffix, 0, available, true)];

    const previewWidth = available - suffixWidth - 1;
    if (visibleWidth(this.preview) <= previewWidth) return [`${this.preview} ${this.suffix}`];

    const markerWidth = visibleWidth(this.marker);
    return [
      `${sliceByColumn(this.preview, 0, Math.max(0, previewWidth - markerWidth), true)}${this.marker} ${this.suffix}`,
    ];
  }

  invalidate(): void {}
}

export function renderSearchCall(
  args: { query?: string; path?: string; limit?: number } | undefined,
  theme: ThemeLike,
  toolName: string,
): Component {
  const query = args?.query ?? "";
  const where = args?.path ?? ".";
  let content =
    theme.fg("toolTitle", theme.bold(toolName)) +
    " " +
    theme.fg("accent", clip(query, 120)) +
    theme.fg("toolOutput", ` in ${where}`);

  const options: string[] = [];
  if (args?.limit !== undefined) options.push(`limit ${args.limit}`);
  if (options.length > 0) content += theme.fg("toolOutput", ` (${options.join(", ")})`);

  return new CollapsedText(content, "", theme.fg("muted", "..."));
}

export function renderRankCall(
  args: { query?: string; pattern?: string; path?: string; context?: number; limit?: number } | undefined,
  theme: ThemeLike,
  toolName: string,
): Component {
  const pattern = args?.pattern ?? "";
  const where = args?.path ?? ".";
  let content =
    theme.fg("toolTitle", theme.bold(toolName)) +
    " " +
    theme.fg("accent", `/${clip(pattern, 80)}/`) +
    theme.fg("toolOutput", ` in ${where}`);

  if (args?.query) content += theme.fg("toolOutput", ` ranked by "${clip(args.query, 80)}"`);

  const options: string[] = [];
  if (args?.context !== undefined) options.push(`context ${args.context}`);
  if (args?.limit !== undefined) options.push(`limit ${args.limit}`);
  if (options.length > 0) content += theme.fg("muted", ` (${options.join(", ")})`);

  return new CollapsedText(content, "", theme.fg("muted", "..."));
}

/**
 * Render a tool result: one summary line when collapsed, the full text when
 * expanded. Results are already line-numbered source, so `Text` is the right
 * component.
 */
export function renderSearchResult(
  result: { content?: { type: string; text?: string }[]; isError?: boolean },
  options: { expanded?: boolean },
  theme: ThemeLike,
  maxCollapsedLines = 12,
): Component {
  const text = firstText(result);
  if (text === "") return new Text(theme.fg("muted", "No output"), 0, 0);

  const lines = text.replace(/\n$/, "").split("\n");
  const color = result.isError === true ? "error" : "toolOutput";

  if (options.expanded) return new Text(lines.map((line) => theme.fg(color, line)).join("\n"), 0, 0);

  const preview = lines.slice(0, maxCollapsedLines).join("\n");
  const hidden = lines.length - maxCollapsedLines;
  const suffix = hidden > 0 ? theme.fg("muted", `... (${hidden} more lines)`) : "";

  return new CollapsedText(theme.fg(color, preview), suffix, theme.fg("muted", "..."));
}

function firstText(result: { content?: { type: string; text?: string }[] }): string {
  const block = result.content?.find((entry) => entry.type === "text");
  return block?.text?.trim() ?? "";
}

function clip(value: string, max: number): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max)}...`;
}